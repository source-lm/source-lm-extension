import type { Settings, PreviewResult } from '../lib/types.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, patternPrefix, patternFromPrefix } from '../lib/settings.js';
import { parseJson } from '../lib/parser.js';
import { detectFields } from '../lib/schema-detector.js';
import { buildFiles, uploadedState } from '../lib/chunker.js';
import { recordsAfter } from '../lib/cursor.js';
import { slugify } from '../lib/markdown-generator.js';
import { parseUrlList } from '../lib/url-list.js';
import { pageToMarkdown, captureFilename } from '../lib/capture.js';
import {
  PRICE_LABEL,
  CHECKOUT_URL,
  FREE_QUOTA,
  loadLicense,
  activateLicense,
  deactivateLicense,
  isPro,
  trialRemaining,
  noteTrialUse,
} from '../lib/license.js';
// Job shape (incl. the optional captured-page `file`) is owned by the job
// runner in notebook.ts — imported as a type only (erased at compile time,
// no runtime dependency on that content-script module) so this file can't
// silently drift from what runYoutubeJob actually consumes.
import type { YoutubeJob as NotebookJob, FixEntry } from '../content/notebook.js';

const NOTEBOOKLM_ORIGINS = ['https://notebooklm.google.com/', 'https://notebook.google.com/'];
const NOTEBOOKLM_URL_PATTERNS = NOTEBOOKLM_ORIGINS.map((origin) => `${origin}*`);

// Upload batch size is no longer user-configurable — this is its only use site.
const UPLOAD_BATCH_SIZE = 10;

// Notebook id from the tab's pathname (`/notebook/<id>`), or null if the tab
// is not on the NotebookLM/Gemini Notebook domain or is not a specific
// notebook's page (e.g. the notebook list). Shared helper for Upload
// validation and filtering by source names in Preview — the regex/domain
// check is not duplicated.
function extractNotebookId(url: string): string | null {
  if (!NOTEBOOKLM_ORIGINS.some((origin) => url.startsWith(origin))) return null;
  const match = new URL(url).pathname.match(/\/notebook\/([^/?#]+)/);
  return match ? match[1] : null;
}

// ---- element lookups -------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Element #${id} not found`);
  return node as T;
}

const tabStatus = el<HTMLDivElement>('tab-status');
const tabStatusText = el<HTMLSpanElement>('tab-status-text');

const jsonFile = el<HTMLInputElement>('json-file');
const inputError = el<HTMLDivElement>('input-error');
const btnPreview = el<HTMLButtonElement>('btn-preview');
const btnUpload = el<HTMLButtonElement>('btn-upload');

const maxWordsInput = el<HTMLInputElement>('max_words_per_file');
const maxWordsValue = el<HTMLOutputElement>('max_words_value');
const filenamePatternInput = el<HTMLInputElement>('filename_pattern');
const contentFieldsInput = el<HTMLInputElement>('content_fields');
const metadataCheckbox = el<HTMLInputElement>('metadata');
const incrementalCheckbox = el<HTMLInputElement>('incremental');
const btnReset = el<HTMLButtonElement>('btn-reset');

const previewSummary = el<HTMLDivElement>('preview-summary');
const previewFiles = el<HTMLUListElement>('preview-files');
const previewWarnings = el<HTMLDivElement>('preview-warnings');

const uploadProgressWrap = el<HTMLDivElement>('upload-progress-wrap');
const uploadProgress = el<HTMLProgressElement>('upload-progress');
const uploadProgressText = el<HTMLDivElement>('upload-progress-text');
const uploadConfirmWrap = el<HTMLDivElement>('upload-confirm-wrap');
const uploadConfirmMessage = el<HTMLParagraphElement>('upload-confirm-message');
const btnContinue = el<HTMLButtonElement>('btn-continue');
const uploadResult = el<HTMLDivElement>('upload-result');

// ---- tab navigation --------------------------------------------------------

const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('nav.tabs button'));
const tabPanels = Array.from(document.querySelectorAll<HTMLElement>('.tabpanel'));
const btnSettings = el<HTMLButtonElement>('btn-settings');
const panelSettings = el<HTMLElement>('panel-settings');
let lastPanel = 'panel-json';

function selectTab(panelId: string): void {
  for (const button of tabButtons) {
    button.setAttribute('aria-selected', String(button.dataset.tab === panelId));
  }
  for (const panel of tabPanels) {
    panel.hidden = panel.id !== panelId;
  }
  btnSettings.classList.toggle('active', panelId === 'panel-settings');
  if (panelId !== 'panel-settings') lastPanel = panelId;
}

for (const button of tabButtons) {
  button.addEventListener('click', () => {
    if (button.dataset.tab) selectTab(button.dataset.tab);
  });
}

btnSettings.addEventListener('click', () => {
  selectTab(panelSettings.hidden ? 'panel-settings' : lastPanel);
});

const tabUrl = el<HTMLButtonElement>('tab-url');

// ---- state -------------------------------------------------------------

let settings: Settings = DEFAULT_SETTINGS;
let lastPreview: PreviewResult | null = null;
let currentTabId: number | null = null;

// ---- settings <-> form ---------------------------------------------------

function formatWords(n: number): string {
  return `${n.toLocaleString('en-US')} words`;
}

function applySettingsToForm(s: Settings): void {
  maxWordsInput.value = String(s.max_words_per_file);
  maxWordsValue.textContent = formatWords(s.max_words_per_file);
  filenamePatternInput.value = patternPrefix(s.filename_pattern);
  contentFieldsInput.value = Array.isArray(s.content_fields) ? s.content_fields.join(', ') : s.content_fields;
  metadataCheckbox.checked = s.metadata;
  incrementalCheckbox.checked = s.incremental;
}

function readSettingsFromForm(): Settings {
  const rawContentFields = contentFieldsInput.value.trim();
  const content_fields =
    rawContentFields === '' || rawContentFields.toLowerCase() === 'auto'
      ? 'auto'
      : rawContentFields.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

  return {
    max_words_per_file: Number(maxWordsInput.value) || DEFAULT_SETTINGS.max_words_per_file,
    content_fields,
    metadata: metadataCheckbox.checked,
    incremental: incrementalCheckbox.checked,
    filename_pattern: patternFromPrefix(filenamePatternInput.value.trim()),
    // No UI field anymore — always auto-detected from the JSON at Preview
    // time (see the `source_name: sourceName` override below). Kept empty so
    // a manual override saved by an older version doesn't linger in storage.
    source_name: '',
  };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  maxWordsValue.textContent = formatWords(Number(maxWordsInput.value) || DEFAULT_SETTINGS.max_words_per_file);
  settings = readSettingsFromForm();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveSettings(settings);
  }, 300);
}

for (const input of [
  maxWordsInput,
  filenamePatternInput,
  contentFieldsInput,
  metadataCheckbox,
  incrementalCheckbox,
]) {
  input.addEventListener('input', scheduleSave);
  input.addEventListener('change', scheduleSave);
}

btnReset.addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS };
  applySettingsToForm(settings);
  void saveSettings(settings);
});

// ---- dropzone label --------------------------------------------------------

const dropzoneLabel = document.querySelector<HTMLLabelElement>('.dropzone');
const fileNameLabel = el<HTMLSpanElement>('file-name');
const fileMetaLabel = el<HTMLSpanElement>('file-meta');

jsonFile.addEventListener('change', () => {
  const file = jsonFile.files?.[0];
  if (file) {
    fileNameLabel.textContent = file.name;
    fileMetaLabel.textContent = formatSize(file.size);
    dropzoneLabel?.classList.add('has-file');
  } else {
    fileNameLabel.textContent = 'Choose a .json file';
    fileMetaLabel.textContent = '';
    dropzoneLabel?.classList.remove('has-file');
  }
});

// The popup would otherwise navigate away to the dropped file.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

dropzoneLabel?.addEventListener('dragover', () => dropzoneLabel.classList.add('dragover'));
dropzoneLabel?.addEventListener('dragleave', () => dropzoneLabel.classList.remove('dragover'));
dropzoneLabel?.addEventListener('drop', (e) => {
  dropzoneLabel.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  jsonFile.files = dt.files;
  jsonFile.dispatchEvent(new Event('change'));
});

// ---- error display -------------------------------------------------------

function showError(message: string): void {
  inputError.textContent = message;
  inputError.hidden = false;
}

function clearError(): void {
  inputError.textContent = '';
  inputError.hidden = true;
}

// ---- preview -------------------------------------------------------------

function formatSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  const kb = chars / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function renderPreview(result: PreviewResult): void {
  previewSummary.textContent = `Files: ${result.files.length}. Total size: ${formatSize(result.totalChars)}.`;

  previewFiles.replaceChildren();
  for (const file of result.files) {
    const li = document.createElement('li');

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = `${file.filename} (${formatSize(file.chars)}, ${formatWords(file.words)}, records: ${file.records})`;
    li.appendChild(name);

    const pre = document.createElement('pre');
    pre.className = 'file-snippet';
    const lines = file.markdown.split('\n').slice(0, 3).map((line) => (line.length > 120 ? `${line.slice(0, 120)}…` : line));
    pre.textContent = lines.join('\n');
    li.appendChild(pre);

    previewFiles.appendChild(li);
  }

  previewWarnings.replaceChildren();
  if (result.warnings.length > 0) {
    const list = document.createElement('ul');
    for (const warning of result.warnings) {
      const li = document.createElement('li');
      li.textContent = warning;
      list.appendChild(li);
    }
    previewWarnings.appendChild(list);
    previewWarnings.hidden = false;
  } else {
    previewWarnings.hidden = true;
  }
}

btnPreview.addEventListener('click', async () => {
  clearError();
  lastPreview = null;
  btnUpload.disabled = true;

  const file = jsonFile.files?.[0];
  if (!file) {
    showError('Select a JSON file.');
    return;
  }

  let parsed, sourceName;
  try {
    ({ records: parsed, sourceName } = parseJson(await file.text()));
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }

  const s = { ...settings, source_name: sourceName };
  const fields = detectFields(parsed, s);

  // Incremental filtering is by record, not by filename: the filename
  // depends on batch splitting (index/cursor/title_slug), and splitting
  // changes with chunking settings. The source of truth is the notebook's
  // source names, from which we recover the highest used {index} and the
  // cursor of the last uploaded record (uploadedState is the inverse of
  // makeFilename), not a local watermark (that goes out of sync from
  // manually deleting sources, YouTube sources in the same notebook, two
  // JSONs in one notebook, reinstalling — see the "No new records" bug with
  // an empty notebook).
  let toPack = parsed;
  let indexOffset = 0;
  const notes: string[] = [];

  if (settings.incremental) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const notebookId = tab?.url ? extractNotebookId(tab.url) : null;
    if (!notebookId) {
      notes.push('No notebook open in the active tab — showing all files');
    } else {
      try {
        const res = await chrome.tabs.sendMessage(tab.id!, { type: 'GET_SOURCE_NAMES' });
        if (res?.error || !Array.isArray(res?.names)) throw new Error(res?.error ?? 'no response');
        const names: string[] = res.names;
        const sourceSlug = s.source_name ? slugify(s.source_name) : '';
        const { maxIndex, cursor } = uploadedState(names, s.filename_pattern, sourceSlug, parsed, fields);
        indexOffset = maxIndex;
        if (cursor) {
          toPack = recordsAfter(parsed, fields, cursor);
          const skipped = parsed.length - toPack.length;
          if (skipped > 0) notes.push(`Skipped ${skipped} records — already in notebook (up to ${cursor})`);
          if (toPack.length === 0) notes.push('No new records');
        } else if (names.length > 0) {
          notes.push('No matches with already uploaded files — everything will be uploaded');
        }
      } catch (err) {
        notes.push(
          `Failed to get the notebook's source list (${err instanceof Error ? err.message : String(err)}) — showing all files`,
        );
      }
    }
  }

  const result = buildFiles(toPack, fields, s, indexOffset);
  result.warnings = [...notes, ...result.warnings];

  lastPreview = result;
  renderPreview(result);
  btnUpload.disabled = result.files.length === 0;
});

// ---- upload -------------------------------------------------------------

function resetUploadUi(): void {
  uploadProgressWrap.hidden = true;
  uploadProgress.value = 0;
  uploadProgressText.textContent = '';
  uploadConfirmWrap.hidden = true;
  uploadResult.textContent = '';
}

btnUpload.addEventListener('click', async () => {
  if (!lastPreview) return;
  clearError();
  resetUploadUi();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showError('Could not determine the active tab');
    return;
  }
  if (!tab.url) {
    showError('No access to the tab. Check that the extension has permission for this site');
    return;
  }
  if (!NOTEBOOKLM_ORIGINS.some((origin) => tab.url!.startsWith(origin))) {
    showError('Open a notebook in the active tab');
    return;
  }
  if (!extractNotebookId(tab.url)) {
    showError('Open a specific notebook, not the notebook list');
    return;
  }
  currentTabId = tab.id;

  if (!(await requireProOrTrial('Uploading a JSON dataset', inputError))) {
    return;
  }

  uploadProgressWrap.hidden = false;
  uploadProgressText.textContent = `0 of ${lastPreview.files.length}`;

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'UPLOAD',
      files: lastPreview.files.map((f) => ({ filename: f.filename, markdown: f.markdown })),
      batchSize: UPLOAD_BATCH_SIZE,
    });
    await noteTrialUse();
    await refreshPlanBadge();
  } catch {
    // Content script not responding — usually the NotebookLM tab was open
    // before the extension was installed/updated, so the script never injected.
    uploadProgressWrap.hidden = true;
    showError('Could not reach the Notebook tab. Reload it (F5) and try again.');
  }
});

btnContinue.addEventListener('click', () => {
  if (currentTabId === null) return;
  uploadConfirmWrap.hidden = true;
  chrome.tabs.sendMessage(currentTabId, { type: 'UPLOAD_CONTINUE' }).catch(() => {
    showError('Could not reach the Notebook tab. Reload it (F5) and try again.');
  });
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  const msg = message as { type: string; [key: string]: unknown };

  switch (msg.type) {
    case 'UPLOAD_PROGRESS': {
      const done = Number(msg.done) || 0;
      const total = Number(msg.total) || 0;
      uploadProgressWrap.hidden = false;
      uploadProgress.max = total || 1;
      uploadProgress.value = done;
      const current = typeof msg.current === 'string' ? ` (${msg.current})` : '';
      uploadProgressText.textContent = `${done} of ${total}${current}`;
      break;
    }
    case 'UPLOAD_ERROR': {
      const filename = typeof msg.filename === 'string' ? `${msg.filename}: ` : '';
      const message = typeof msg.message === 'string' ? msg.message : 'Unknown upload error';
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = `${filename}${message}`;
      uploadResult.appendChild(p);
      break;
    }
    case 'UPLOAD_DONE': {
      uploadProgressWrap.hidden = true;
      const uploaded = Number(msg.uploaded) || 0;
      const failed = Number(msg.failed) || 0;
      const unconfirmed = Number(msg.unconfirmed) || 0;
      const skipped = Number(msg.skipped) || 0;
      const p = document.createElement('p');
      p.className = 'done';
      p.textContent = `Done: uploaded ${uploaded}, failed ${failed}${
        unconfirmed > 0 ? `, unconfirmed ${unconfirmed}` : ''
      }${skipped > 0 ? `, skipped already existing: ${skipped}` : ''}.`;
      uploadResult.appendChild(p);
      if (unconfirmed > 0) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent =
          "Some files could not be confirmed in time — check the notebook's source list manually.";
        uploadResult.appendChild(hint);
      }
      break;
    }
    case 'UPLOAD_NEEDS_CONFIRM': {
      uploadConfirmMessage.textContent =
        typeof msg.message === 'string' ? msg.message : 'Could not confirm batch upload.';
      uploadConfirmWrap.hidden = false;
      break;
    }
    default:
      break;
  }
});

// ---- YouTube sources -------------------------------------------------------
//
// The content script on youtube.com (src/content/youtube.ts) only collects
// data on request — all the video/target-notebook selection UI lives here,
// in the popup (see DECISIONS.md / phase-3 architectural requirement: no
// overlays drawn over YouTube cards). The job is handed to the notebook tab
// via chrome.storage.local, not chrome.runtime.sendMessage directly — the
// tab may not exist yet (see initYoutubeSection below). Not storage.session:
// it is TRUSTED_CONTEXTS_ONLY by default and a content script cannot read it
// without a service worker calling setAccessLevel (we have none, DECISIONS.md #3).

type VideoItem = { videoId: string; title: string; url: string };
type NotebookSummary = { id: string; title: string; emoji?: string };
// Alias, not a redeclaration — see the NotebookJob import above.
type YoutubeJob = NotebookJob;

const sectionYoutube = el<HTMLElement>('section-youtube');
const youtubeUnavailable = el<HTMLDivElement>('youtube-unavailable');
const btnCollectVideos = el<HTMLButtonElement>('btn-collect-videos');
const youtubeVideoList = el<HTMLUListElement>('youtube-video-list');
const youtubeListActions = el<HTMLDivElement>('youtube-list-actions');
const youtubeSelectAll = el<HTMLInputElement>('youtube-select-all');
const youtubeNotebookSelect = el<HTMLSelectElement>('youtube-notebook-select');
const youtubeNotebooksHint = el<HTMLDivElement>('youtube-notebooks-hint');
const youtubeNewNotebookRow = el<HTMLLabelElement>('youtube-new-notebook-row');
const youtubeNewNotebookTitle = el<HTMLInputElement>('youtube-new-notebook-title');
const NEW_NOTEBOOK_VALUE = '__new__';
const btnAddYoutube = el<HTMLButtonElement>('btn-add-youtube');
const youtubeCommentsRow = el<HTMLDivElement>('youtube-comments-row');
const youtubeCommentsLimit = el<HTMLInputElement>('youtube-comments-limit');
const btnAddComments = el<HTMLButtonElement>('btn-add-comments');
const youtubeError = el<HTMLDivElement>('youtube-error');
const youtubeStatus = el<HTMLDivElement>('youtube-status');

// ---- Link tab (arbitrary URL / current-page capture) ----------------------

const sectionUrl = el<HTMLElement>('section-url');
const urlUnavailable = el<HTMLDivElement>('url-unavailable');
const urlInput = el<HTMLTextAreaElement>('url-input');
const urlNotebookSelect = el<HTMLSelectElement>('url-notebook');
const urlNotebooksHint = el<HTMLDivElement>('url-notebooks-hint');
const urlNewNotebookRow = el<HTMLLabelElement>('url-new-notebook-row');
const urlNewNotebookTitle = el<HTMLInputElement>('url-new-title');
const btnAddUrl = el<HTMLButtonElement>('btn-add-url');
const btnAddPage = el<HTMLButtonElement>('btn-add-page');
const urlFixBanner = el<HTMLDivElement>('url-fix-banner');
const urlError = el<HTMLDivElement>('url-error');
const urlStatus = el<HTMLDivElement>('url-status');

let collectedVideos: VideoItem[] = [];
let youtubeTabId: number | null = null;

function showYoutubeError(message: string): void {
  youtubeError.textContent = message;
  youtubeError.hidden = false;
}

function clearYoutubeError(): void {
  youtubeError.textContent = '';
  youtubeError.hidden = true;
}

function renderVideoList(videos: VideoItem[]): void {
  youtubeVideoList.replaceChildren();
  for (const video of videos) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.videoId = video.videoId;
    label.appendChild(checkbox);
    const thumb = document.createElement('img');
    thumb.className = 'yt-thumb';
    thumb.src = `https://i.ytimg.com/vi/${video.videoId}/default.jpg`;
    thumb.alt = '';
    thumb.loading = 'lazy';
    // Private/deleted videos have no thumbnail: drop the element rather
    // than leave a broken-image box in the row.
    thumb.onerror = () => thumb.remove();
    label.appendChild(thumb);
    const span = document.createElement('span');
    span.className = 'yt-title';
    span.textContent = video.title;
    span.title = video.title;
    label.appendChild(span);
    li.appendChild(label);
    youtubeVideoList.appendChild(li);
  }
  youtubeListActions.hidden = videos.length === 0;
  syncSelectAll();
}

function setAllVideosChecked(checked: boolean): void {
  for (const cb of youtubeVideoList.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
    cb.checked = checked;
  }
}

// Reflects the rows' state on the master checkbox: checked when all rows
// are checked, indeterminate when some are, unchecked when none. Selection
// state lives only in the row checkboxes' DOM — no mirrored JS Set.
function syncSelectAll(): void {
  const boxes = youtubeVideoList.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
  const checkedCount = youtubeVideoList.querySelectorAll<HTMLInputElement>(
    'input[type=checkbox]:checked',
  ).length;
  youtubeSelectAll.checked = boxes.length > 0 && checkedCount === boxes.length;
  youtubeSelectAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
}

youtubeSelectAll.addEventListener('change', () => {
  setAllVideosChecked(youtubeSelectAll.checked);
});

// Delegated listener, not per-row: rows are re-created on every collect.
youtubeVideoList.addEventListener('change', (e) => {
  if ((e.target as HTMLElement)?.matches('input[type=checkbox]')) {
    syncSelectAll();
  }
});

btnCollectVideos.addEventListener('click', async () => {
  clearYoutubeError();
  if (youtubeTabId === null) {
    showYoutubeError('Could not determine the YouTube tab');
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(youtubeTabId, { type: 'COLLECT_VIDEOS' });
    collectedVideos = Array.isArray(response?.videos) ? response.videos : [];
    renderVideoList(collectedVideos);
  } catch {
    showYoutubeError('Could not reach the YouTube page. Reload it (F5) and try again.');
  }
});

// Finds an already open notebook tab (any one, not necessarily a specific
// notebook) — used both for the notebook dropdown and for routing the job.
async function findNotebookTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: NOTEBOOKLM_URL_PATTERNS });
  return tabs[0];
}

// Two independent pickers share the same notebook list — the YouTube tab's
// and the Link tab's. Both are kept in lockstep rather than each running its
// own fetch/cache/error dance.
const notebookPickers: { select: HTMLSelectElement; hint: HTMLDivElement }[] = [
  { select: youtubeNotebookSelect, hint: youtubeNotebooksHint },
  { select: urlNotebookSelect, hint: urlNotebooksHint },
];

function renderNotebooks(notebooks: NotebookSummary[]): void {
  for (const { select, hint } of notebookPickers) {
    select.replaceChildren();
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '— select a notebook —';
    select.appendChild(emptyOption);
    for (const nb of notebooks) {
      const option = document.createElement('option');
      option.value = nb.id;
      option.textContent = nb.emoji ? `${nb.emoji} ${nb.title}` : nb.title;
      select.appendChild(option);
    }
    const newOption = document.createElement('option');
    newOption.value = NEW_NOTEBOOK_VALUE;
    newOption.textContent = '＋ New notebook';
    select.appendChild(newOption);
    hint.hidden = true;
    select.disabled = false;
  }
}

// The dropdown has two independent sources: a cache the notebook tab wrote
// on its last page load (src/content/uploader.ts, notebookCache in
// storage.local — same shape src/content/youtube-ui.ts:readNotebookCache
// reads), and a live round-trip to an open notebook tab. The cache renders
// first so the dropdown is usable even if there's no open tab or the
// content script isn't injected yet; the live path then refreshes it. The
// popup never writes the cache itself — the notebook tab owns it.
async function loadNotebookList(): Promise<void> {
  const { notebookCache } = (await chrome.storage.local.get('notebookCache')) as {
    notebookCache?: { notebooks: NotebookSummary[]; origin: string; at: number };
  };
  const cachedNotebooks = notebookCache?.notebooks;
  const hasCache = Array.isArray(cachedNotebooks) && cachedNotebooks.length > 0;
  if (hasCache) renderNotebooks(cachedNotebooks!);

  try {
    const tab = await findNotebookTab();
    if (!tab?.id) throw new Error('no notebook tab open');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_NOTEBOOKS' });
    const notebooks: NotebookSummary[] = Array.isArray(response?.notebooks) ? response.notebooks : [];
    renderNotebooks(notebooks);
  } catch (err) {
    if (hasCache) return;
    // No cache to fall back on — surface why the live path failed (no tab
    // vs. content script not injected vs. RPC error) instead of one bare
    // "open a tab" hint for every case (DECISIONS.md #13: don't collapse
    // distinct failure reasons into the same silent state).
    const reasonText = err instanceof Error ? err.message : String(err);
    for (const { hint } of notebookPickers) {
      hint.hidden = false;
      hint.querySelector('.hint-reason')?.remove();
      const reason = document.createElement('p');
      reason.className = 'hint hint-reason';
      reason.textContent = reasonText;
      hint.appendChild(reason);
    }
  }
}

for (const { select } of notebookPickers) {
  const row = select === youtubeNotebookSelect ? youtubeNewNotebookRow : urlNewNotebookRow;
  const sync = () => {
    row.hidden = select.value !== NEW_NOTEBOOK_VALUE;
  };
  select.addEventListener('change', sync);
  sync();
}

// Reads the picker's selection into the two job fields runYoutubeJob expects
// (notebook.ts:303 — targetNotebookId for an existing notebook, createTitle
// for a new one). null means "nothing usable selected yet".
function resolveNotebookTarget(
  select: HTMLSelectElement,
  newTitleInput: HTMLInputElement,
): Pick<YoutubeJob, 'targetNotebookId' | 'createTitle'> | null {
  if (select.value === NEW_NOTEBOOK_VALUE) return { createTitle: newTitleInput.value.trim() };
  if (!select.value) return null;
  return { targetNotebookId: select.value };
}

// Shared tail of every job submission (YouTube videos, a plain link, or a
// captured page): stash the job, open a fresh notebook tab at the right
// place, done — the tab's own content script runs it (runYoutubeJob in
// src/content/notebook.ts). storage.local, not storage.session: see the
// comment above this section.
async function submitJob(job: YoutubeJob, notebookSelect: HTMLSelectElement, statusEl: HTMLDivElement): Promise<void> {
  await chrome.storage.local.set({ youtubeJob: job });

  const existingTab = await findNotebookTab();
  const { notebookCache } = (await chrome.storage.local.get('notebookCache')) as {
    notebookCache?: { origin: string };
  };
  const origin =
    existingTab?.url ? new URL(existingTab.url).origin : notebookCache?.origin ?? 'https://notebook.google.com';
  const createNew = notebookSelect.value === NEW_NOTEBOOK_VALUE;
  const url = createNew ? `${origin}/` : `${origin}/notebook/${job.targetNotebookId}`;
  await chrome.tabs.create({ url });

  statusEl.textContent = 'Job sent — progress will show in the notebook tab.';
}

btnAddYoutube.addEventListener('click', async () => {
  clearYoutubeError();
  youtubeStatus.textContent = '';

  const selectedIds = new Set(
    Array.from(youtubeVideoList.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')).map(
      (input) => input.dataset.videoId,
    ),
  );
  const videos = collectedVideos.filter((v) => selectedIds.has(v.videoId));
  if (videos.length === 0) {
    showYoutubeError('Select at least one video');
    return;
  }

  const target = resolveNotebookTarget(youtubeNotebookSelect, youtubeNewNotebookTitle);
  if (!target) {
    showYoutubeError('Select a notebook');
    return;
  }

  const multi = videos.length > 1;
  if (multi && !(await requireProOrTrial('Adding more than one video at a time', youtubeError))) {
    return;
  }

  const job: YoutubeJob = { type: 'ADD_YOUTUBE', videos, createdAt: Date.now(), ...target };
  // Commit before submitJob: it ends in chrome.tabs.create, which closes the
  // popup and kills everything after this line. The job is written to
  // storage.local as submitJob's first act, so the only gap left is that one
  // write failing — far better than never charging at all.
  if (multi) await noteTrialUse();
  await submitJob(job, youtubeNotebookSelect, youtubeStatus);
});

// No requireProOrTrial/noteTrialUse here: the comments are a single source,
// and one source per action is always free (DECISIONS.md #15).
btnAddComments.addEventListener('click', async () => {
  clearYoutubeError();
  youtubeStatus.textContent = '';

  const target = resolveNotebookTarget(youtubeNotebookSelect, youtubeNewNotebookTitle);
  if (!target) {
    showYoutubeError('Select a notebook');
    return;
  }
  if (youtubeTabId === null) {
    showYoutubeError('Could not determine the YouTube tab');
    return;
  }

  const limit = Math.max(1, Number(youtubeCommentsLimit.value) || 100);
  let response: { file?: { filename: string; markdown: string }; error?: string } | undefined;
  btnAddComments.disabled = true;
  youtubeStatus.classList.add('busy');
  youtubeStatus.textContent = 'Collecting comments… (up to two minutes, keep the popup open)';
  try {
    response = await chrome.tabs.sendMessage(youtubeTabId, { type: 'HARVEST_COMMENTS', limit });
  } catch {
    youtubeStatus.textContent = '';
    showYoutubeError('Could not reach the YouTube page. Reload it (F5) and try again.');
    return;
  } finally {
    btnAddComments.disabled = false;
    youtubeStatus.classList.remove('busy');
  }

  if (response?.error || !response?.file) {
    youtubeStatus.textContent = '';
    showYoutubeError(response?.error ?? 'Could not collect the comments');
    return;
  }

  const job: YoutubeJob = {
    type: 'ADD_YOUTUBE',
    videos: [],
    file: response.file,
    createdAt: Date.now(),
    ...target,
  };
  await submitJob(job, youtubeNotebookSelect, youtubeStatus);
});

// ---- Link tab: add a URL, or capture the current page as Markdown --------

function showUrlError(message: string): void {
  urlError.textContent = message;
  urlError.hidden = false;
}

function clearUrlError(): void {
  urlError.textContent = '';
  urlError.hidden = true;
}

btnAddUrl.addEventListener('click', async () => {
  clearUrlError();
  urlStatus.textContent = '';

  const urls = parseUrlList(urlInput.value);
  if (urls.length === 0) {
    showUrlError('Enter at least one valid http(s) URL');
    return;
  }

  const target = resolveNotebookTarget(urlNotebookSelect, urlNewNotebookTitle);
  if (!target) {
    showUrlError('Select a notebook');
    return;
  }

  const multi = urls.length > 1;
  if (multi && !(await requireProOrTrial('Adding more than one link at a time', urlError))) {
    return;
  }

  // videoId is deliberately empty — these are plain web sources, not YouTube
  // ones. runYoutubeJob (notebook.ts) falls back to youtubeVideoId(video.url)
  // for dedup, which is null for non-YouTube URLs and simply skips the
  // video-id dedup path for them (URL-based dedup happens on its side).
  const job: YoutubeJob = {
    type: 'ADD_YOUTUBE',
    videos: urls.map((url) => ({ url, title: url, videoId: '' })),
    createdAt: Date.now(),
    ...target,
  };
  // Commit before submitJob: it ends in chrome.tabs.create, which closes the
  // popup and kills everything after this line. The job is written to
  // storage.local as submitJob's first act, so the only gap left is that one
  // write failing — far better than never charging at all.
  if (multi) await noteTrialUse();
  await submitJob(job, urlNotebookSelect, urlStatus);
});

// Runs inside the target page via chrome.scripting.executeScript, so it is
// serialized (Function.prototype.toString) and re-executed there — it must
// be fully self-contained: no imports, no closure over anything in this
// module, only DOM/web globals available on any page.
function extractPage(): { title: string; url: string; text: string } {
  // Always the whole page — a selection goes through the context menu
  // instead ("Add selection to Notebook", src/background.ts), so this button
  // stays predictable regardless of what happens to be selected.
  // innerText is read off the LIVE tree on purpose: on a detached clone it
  // degrades to descendant text content per spec — one blob with no line
  // breaks and no visibility filtering — which is exactly the layout
  // information a Markdown source needs. Chrome/footer/nav noise is dropped
  // by narrowing to <article>/<main> when the page has one, instead of
  // stripping nodes out of the user's actual page.
  const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
  return { title: document.title, url: location.href, text: (root as HTMLElement).innerText };
}

// ---- broken-source hand-off from the notebook tab (DECISIONS.md #16) --------

// Key and TTL are literals here and in src/content/sources-ui.ts on purpose:
// only the entry *type* is shared, so importing it stays type-only and no
// RPC code from the content script leaks into the popup bundle.
const FIX_QUEUE_KEY = 'fixQueue';
const FIX_TTL_MS = 5 * 60 * 1000;
const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

let pendingFix: FixEntry | null = null;

async function readFixQueue(): Promise<FixEntry[]> {
  const stored = await chrome.storage.local.get(FIX_QUEUE_KEY);
  const queue: FixEntry[] = Array.isArray(stored[FIX_QUEUE_KEY]) ? stored[FIX_QUEUE_KEY] : [];
  const now = Date.now();
  return queue.filter((e) => e && now - e.createdAt <= FIX_TTL_MS);
}

// The notebook tab parked a broken source here and opened its page; if that
// page is the active tab, "Add page as .md" becomes a replacement.
// `listReady` is awaited before preselecting: the notebook's <option> only
// exists once loadNotebookList has rendered.
async function loadPendingFix(tabUrl: string, listReady: Promise<void>): Promise<void> {
  const target = normalizeUrl(tabUrl);
  const entry = (await readFixQueue()).find((e) => normalizeUrl(e.url) === target);
  if (!entry) return;

  pendingFix = entry;
  urlFixBanner.textContent = `“${entry.title}” is a broken source in the notebook — “Add page as .md” will replace it.`;
  urlFixBanner.hidden = false;
  await listReady;
  urlNotebookSelect.value = entry.notebookId;
}

async function dropPendingFix(sourceId: string): Promise<void> {
  const queue = await readFixQueue();
  await chrome.storage.local.set({ [FIX_QUEUE_KEY]: queue.filter((e) => e.sourceId !== sourceId) });
}

btnAddPage.addEventListener('click', async () => {
  clearUrlError();
  urlStatus.textContent = '';

  const target = resolveNotebookTarget(urlNotebookSelect, urlNewNotebookTitle);
  if (!target) {
    showUrlError('Select a notebook');
    return;
  }

  // Only replace when the capture is actually going back into the notebook
  // the broken source lives in — the user is free to re-point the picker,
  // and that must not delete a source from a notebook we're not adding to.
  const replaceSourceId =
    pendingFix && target.targetNotebookId === pendingFix.notebookId ? pendingFix.sourceId : undefined;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showUrlError('Could not determine the active tab');
    return;
  }

  let captured: { title: string; url: string; text: string };
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
    if (!injection?.result || !injection.result.text.trim()) {
      throw new Error('The page has no readable text content');
    }
    captured = injection.result;
  } catch (err) {
    showUrlError(`Could not capture the page: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const host = new URL(captured.url).hostname.replace(/^www\./, '');
  const job: YoutubeJob = {
    type: 'ADD_YOUTUBE',
    videos: [],
    file: {
      filename: captureFilename(host, captured.title),
      markdown: pageToMarkdown(captured.title, captured.url, captured.text, 'page'),
    },
    createdAt: Date.now(),
    ...(replaceSourceId ? { replaceSourceId } : {}),
    ...target,
  };
  // Cleared before submitJob for the same reason the trial counter is:
  // submitJob ends in chrome.tabs.create, which closes the popup and kills
  // every statement after it.
  if (replaceSourceId) await dropPendingFix(replaceSourceId);
  await submitJob(job, urlNotebookSelect, urlStatus);
});

async function initFromActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const onNotebookLm = !!tab?.url && NOTEBOOKLM_ORIGINS.some((origin) => tab.url!.startsWith(origin));
  if (onNotebookLm && extractNotebookId(tab!.url!)) {
    tabStatus.className = 'ok';
    tabStatusText.textContent = 'Notebook open';
  } else if (onNotebookLm) {
    tabStatus.className = 'warn';
    tabStatusText.textContent = 'Open a notebook';
  } else {
    tabStatus.className = 'off';
    tabStatusText.textContent = 'No notebook tab';
  }

  const onYoutube = !!tab?.id && !!tab.url && tab.url.startsWith('https://www.youtube.com/');
  sectionYoutube.hidden = !onYoutube;
  youtubeUnavailable.hidden = onYoutube;
  // Comments belong to one video — offered on a watch page only.
  youtubeCommentsRow.hidden = !(onYoutube && /^https:\/\/www\.youtube\.com\/watch\b/.test(tab!.url!));

  // The Link tab: any regular http(s) page that is neither YouTube (its own
  // tab) nor the notebook itself (nothing to add to itself).
  const onOther = !!tab?.url && !onYoutube && !onNotebookLm && /^https?:/.test(tab.url);
  sectionUrl.hidden = !onOther;
  urlUnavailable.hidden = onOther;
  tabUrl.disabled = !onOther;
  if (onOther) urlInput.value = tab!.url!;

  if (!onYoutube && !onOther) return;

  if (onYoutube) youtubeTabId = tab!.id!;
  selectTab(onYoutube ? 'panel-youtube' : 'panel-url');
  const listReady = loadNotebookList();
  if (onOther) void loadPendingFix(tab!.url!, listReady);

  // The popup is always closed while the job runs, so its progress listener
  // never sees those messages — the notebook tab persists the outcome instead
  // (see runYoutubeJob() in src/content/notebook.ts).
  const { lastYoutubeRun } = (await chrome.storage.local.get('lastYoutubeRun')) as {
    lastYoutubeRun?: { uploaded: number; failed: number; skipped?: number; error?: string; at: number };
  };
  if (lastYoutubeRun) {
    const skippedPart = lastYoutubeRun.skipped ? `, ${lastYoutubeRun.skipped} skipped` : '';
    const errorPart = lastYoutubeRun.error ? ` — ${lastYoutubeRun.error}` : '';
    const statusEl = onYoutube ? youtubeStatus : urlStatus;
    statusEl.textContent = `Last run: ${lastYoutubeRun.uploaded} added, ${lastYoutubeRun.failed} failed${skippedPart}${errorPart}`;
  }
}

// ---- plan / license -------------------------------------------------------

const planStatus = el<HTMLDivElement>('plan-status');
const planFree = el<HTMLDivElement>('plan-free');
const planPro = el<HTMLDivElement>('plan-pro');
const btnGetPro = el<HTMLButtonElement>('btn-get-pro');
const licenseInput = el<HTMLInputElement>('license-input');
const btnActivateLicense = el<HTMLButtonElement>('btn-activate-license');
const licenseMsg = el<HTMLDivElement>('license-msg');
const btnDeactivateLicense = el<HTMLButtonElement>('btn-deactivate-license');
const licenseActivate = el<HTMLDetailsElement>('license-activate');
const planBar = el<HTMLDivElement>('plan-bar');
const planBarText = el<HTMLSpanElement>('plan-bar-text');
const planBarPro = el<HTMLButtonElement>('plan-bar-pro');
const planBarActivate = el<HTMLButtonElement>('plan-bar-activate');

btnGetPro.textContent = `Get Pro — ${PRICE_LABEL} (lifetime)`;

// Gate for the two metered actions (bulk JSON upload, multi-video YouTube
// add). Not `if (isPro)` sprinkled at each call site — one helper, called
// from exactly those two places, so the upsell copy/behavior stays in sync.
// Check-only: it never spends a unit — call `noteTrialUse()` after the work
// is actually handed off, so a failed dispatch never burns a unit.
async function requireProOrTrial(message: string, errEl: HTMLElement): Promise<boolean> {
  if (await isPro()) return true;
  if ((await trialRemaining()) > 0) return true;
  // Don't auto-switch to the Settings panel here — that would hide the
  // error message just written into the current pane. Link straight to
  // checkout instead, same as youtube-ui.ts's in-page dialog.
  errEl.textContent =
    `${message} — Free plan: ${FREE_QUOTA} imports per month, all used (resets on the 1st). ` +
    `Pro is a one-time ${PRICE_LABEL} — `;
  const link = document.createElement('a');
  link.href = CHECKOUT_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'get Pro';
  errEl.append(link, '.');
  errEl.hidden = false;
  return false;
}

async function refreshPlanBadge(): Promise<void> {
  const pro = await isPro();
  if (pro) {
    const state = await loadLicense();
    planStatus.textContent = state?.email ? `Pro — ${state.email}` : 'Pro';
    planFree.hidden = true;
    planPro.hidden = false;
    planBar.hidden = true;
  } else {
    const left = await trialRemaining();
    planStatus.textContent = `Free — ${left} of ${FREE_QUOTA} imports left this month`;
    planFree.hidden = false;
    planPro.hidden = true;
    planBar.hidden = false;
    planBarText.textContent = `Free — ${left} of ${FREE_QUOTA} left`;
  }
}

btnGetPro.addEventListener('click', () => {
  void chrome.tabs.create({ url: CHECKOUT_URL });
});

planBarPro.addEventListener('click', () => {
  btnGetPro.click();
});

planBarActivate.addEventListener('click', () => {
  selectTab('panel-settings');
  licenseActivate.open = true;
});

btnActivateLicense.addEventListener('click', async () => {
  const key = licenseInput.value.trim();
  if (!key) {
    licenseMsg.textContent = '✗ Enter a license key';
    return;
  }
  btnActivateLicense.disabled = true;
  licenseMsg.textContent = 'Activating…';
  const res = await activateLicense(key);
  btnActivateLicense.disabled = false;
  if (res.ok) {
    licenseMsg.textContent = '✓ Activated. Pro unlocked.';
    licenseInput.value = '';
    await refreshPlanBadge();
  } else {
    licenseMsg.textContent = `✗ ${res.error ?? 'Activation failed'}`;
  }
});

btnDeactivateLicense.addEventListener('click', async () => {
  if (!confirm('Deactivate this device? You will need to activate again to use Pro features.')) return;
  const res = await deactivateLicense();
  await refreshPlanBadge();
  // The local state is cleared either way; if Lemon Squeezy never heard the
  // request, the activation slot is still taken and the user has to free it
  // from the purchase email's license page.
  licenseMsg.textContent = res.ok ? '' : `✗ Deactivated here, but Lemon Squeezy reported: ${res.error}`;
});

// ---- init -----------------------------------------------------------------

// Deprecated local upload watermark — the source of truth is now the
// notebook's own source names; the old key may remain from a previous version.
void chrome.storage.local.remove('uploadWatermark');

// A job the notebook tab never picked up (tab closed early, tabs.create
// failed) would otherwise keep captured page text in storage.local until
// overwritten. Same 5-minute TTL as notebook.ts:readAndClearJob.
void chrome.storage.local.get('youtubeJob').then(({ youtubeJob }) => {
  const createdAt = (youtubeJob as { createdAt?: number } | undefined)?.createdAt ?? 0;
  if (Date.now() - createdAt > 5 * 60 * 1000) void chrome.storage.local.remove('youtubeJob');
});

loadSettings().then((loaded) => {
  settings = loaded;
  applySettingsToForm(settings);
});

void initFromActiveTab();
void refreshPlanBadge();
