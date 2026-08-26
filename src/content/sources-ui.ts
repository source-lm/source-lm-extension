// Three extras for NotebookLM's Sources panel header, next to the panel's own
// "Sort sources" button: a filter box that hides non-matching source rows, a
// "Select duplicate sources" button that ticks the checkboxes of repeated
// sources so the existing delete button can remove them, and a "Broken
// sources" button that lists the sources NotebookLM failed to fetch and hands
// each one off to the popup for a re-capture (DECISIONS.md #16).
//
// None of them deletes anything. "Select duplicates" only changes which
// checkboxes are ticked — deletion still goes through delete-ui.ts and its
// confirm() dialog (DECISIONS.md #14).
//
// Same conventions as delete-ui.ts: buttons are cloneNode(true) copies of the
// sort button (Material classes come along for free, they are never matched
// as selectors), rows are found by the `source-item-more-button-<uuid>` id
// prefix, and nothing is selected by CSS class (DECISIONS.md #5).

import { extractNotebookId, showJobToast, waitFor } from './uploader';
import { findSortButton, sourceRow, attachTooltip } from './delete-ui';
import { findDuplicateIds, listSources } from './notebook';
import type { FixEntry, SourceInfo } from './notebook';

const MORE_BUTTON_ID_PREFIX = 'source-item-more-button-';

// Status/type slots as parsed by parseSources. Only an errored *web page*
// (status 3, type 5) is treated as broken: status 3 is transient for audio
// and unclassified sources, which recover on their own (notebooklm-mcp-cli,
// wait_for_source_ready). An errored YouTube source (type 9) is listed but
// not offered a fix — there is no page for the popup to capture.
const STATUS_ERROR = 3;
const TYPE_WEB = 5;
const TYPE_YOUTUBE = 9;

const FIX_QUEUE_KEY = 'fixQueue';
// Same reasoning as readAndClearJob's TTL (DECISIONS.md #3): storage.local
// survives a browser restart, so an abandoned hand-off must expire.
const FIX_TTL_MS = 5 * 60 * 1000;

let filterInput: HTMLInputElement | null = null;
let dupBtn: HTMLButtonElement | null = null;
let brokenBtn: HTMLButtonElement | null = null;
let brokenPanel: HTMLDivElement | null = null;

function moreButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[id^="${MORE_BUTTON_ID_PREFIX}"]`));
}

// Hidden rows stay checked on purpose — the delete button's confirm() lists
// every title it is about to delete, so a filtered-out row is still visible
// to the user before anything happens.
function applyFilter(): void {
  const query = filterInput?.value.trim().toLowerCase() ?? '';
  for (const btn of moreButtons()) {
    const row = sourceRow(btn);
    row.style.display = !query || (row.textContent ?? '').toLowerCase().includes(query) ? '' : 'none';
  }
}

function ensureFilterInput(sortBtn: HTMLElement): void {
  if (filterInput && filterInput.isConnected) return;

  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Filter sources';
  input.setAttribute('aria-label', 'Filter sources');
  // Material-style pill: no border, a faint tint of the header's own text
  // color as the surface — works in light and dark themes without hardcoding
  // either. Chrome's focus ring follows the radius, so it reads as M3 focus.
  input.style.cssText = [
    'font:inherit',
    'font-size:13px',
    'width:88px',
    'height:28px',
    'box-sizing:border-box',
    'margin-right:4px',
    'padding:0 10px',
    'border:none',
    'border-radius:14px',
    'background:color-mix(in srgb, currentColor 8%, transparent)',
    'color:inherit',
  ].join(';');
  input.addEventListener('input', applyFilter);

  // In-header placement. If a locale ever makes the header too narrow for
  // 88px, give the input its own row above the header instead:
  // sortBtn.closest('div')?.insertAdjacentElement('beforebegin', input).
  sortBtn.insertAdjacentElement('beforebegin', input);
  filterInput = input;
}

function buildIconButton(
  sortBtn: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = sortBtn.cloneNode(true) as HTMLButtonElement;
  // The sort button is a menu trigger and carries Google's own click logging;
  // ours is neither, so drop those semantics rather than announce a menu that
  // never opens.
  for (const attr of [
    'id',
    'mattooltip',
    'ng-reflect-message',
    'aria-describedby',
    'aria-haspopup',
    'aria-expanded',
    'jslog',
  ]) {
    btn.removeAttribute(attr);
  }
  btn.classList.remove('mat-mdc-menu-trigger', 'source-sort-button');
  btn.type = 'button';
  btn.style.cssText = 'margin-left:4px';
  btn.setAttribute('aria-label', label);
  // Same hand-drawn pill as the Delete button (Angular's MatTooltip does
  // not survive cloneNode).
  attachTooltip(btn, label);

  const iconEl = btn.querySelector('mat-icon');
  if (iconEl) {
    iconEl.textContent = icon;
  } else {
    const fallbackIcon = document.createElement('mat-icon');
    fallbackIcon.className = 'mat-icon notranslate material-symbols-outlined google-symbols mat-icon-no-color';
    fallbackIcon.setAttribute('aria-hidden', 'true');
    fallbackIcon.setAttribute('data-mat-icon-type', 'font');
    fallbackIcon.textContent = icon;
    btn.appendChild(fallbackIcon);
  }

  btn.addEventListener('click', onClick);
  return btn;
}

async function onSelectDuplicates(): Promise<void> {
  const notebookId = extractNotebookId(location.pathname);
  if (!notebookId) {
    showJobToast('Open a notebook first', true);
    return;
  }

  const btn = dupBtn;
  if (btn) btn.disabled = true;
  try {
    const duplicates = new Set(findDuplicateIds(await listSources(notebookId)));

    // NotebookLM ticks every source by default, so this has to clear the
    // whole panel first — otherwise "select duplicates" would leave the
    // originals checked too and the delete button would wipe the notebook.
    let selected = 0;
    for (const more of moreButtons()) {
      const box = sourceRow(more).querySelector<HTMLInputElement>('input[type=checkbox]');
      if (!box) continue;
      const wanted = duplicates.has(more.id.slice(MORE_BUTTON_ID_PREFIX.length));
      if (box.checked !== wanted) box.click();
      if (wanted) selected += 1;
    }

    showJobToast(
      selected
        ? `${selected} duplicates selected — review and press Delete`
        : 'No duplicate sources found',
      true,
    );
  } catch (err) {
    showJobToast(`Could not read sources: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// The hand-off itself: this tab can't refetch the page (CORS) nor script
// another tab, so it parks the source in storage.local and opens the page —
// the popup, which does have activeTab + scripting, finishes the job there
// (DECISIONS.md #16).
async function queueFix(notebookId: string, source: SourceInfo, url: string): Promise<void> {
  const stored = await chrome.storage.local.get(FIX_QUEUE_KEY);
  const queue: FixEntry[] = Array.isArray(stored[FIX_QUEUE_KEY]) ? stored[FIX_QUEUE_KEY] : [];
  const now = Date.now();
  const kept = queue.filter((e) => e && e.sourceId !== source.id && now - e.createdAt <= FIX_TTL_MS);
  kept.push({ notebookId, sourceId: source.id, url, title: source.title, createdAt: now });
  await chrome.storage.local.set({ [FIX_QUEUE_KEY]: kept });
}

function panelRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:6px';
  return row;
}

// showJobToast is a single line of text; a list with a button per row needs
// its own element. Same inline-only styling rule as the toast: NotebookLM's
// Angular CSS must not reach it, nor ours theirs.
function showBrokenPanel(notebookId: string, broken: SourceInfo[], unfixable: SourceInfo[]): void {
  brokenPanel?.remove();
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483647',
    'max-width:360px',
    'max-height:60vh',
    'overflow:auto',
    'padding:12px 40px 12px 14px',
    'border-radius:10px',
    'background:#202124',
    'color:#e8eaed',
    'font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.35)',
  ].join(';');

  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.style.cssText =
    'position:absolute;top:4px;right:6px;border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer';
  close.addEventListener('click', () => panel.remove());
  panel.appendChild(close);

  const heading = document.createElement('div');
  heading.textContent = `${broken.length + unfixable.length} broken source(s)`;
  heading.style.cssText = 'font-weight:600';
  panel.appendChild(heading);

  for (const source of broken) {
    const url = source.urls[0];
    const row = panelRow();
    const title = document.createElement('span');
    title.textContent = source.title;
    title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    title.title = url;
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Open page';
    open.style.cssText =
      'border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;font:inherit;padding:2px 8px;cursor:pointer';
    open.addEventListener('click', () => {
      // Opened first, queued second: an await here would spend the user
      // gesture and let the popup blocker eat the tab. The write lands in
      // milliseconds, long before a human can open the popup on that page.
      window.open(url, '_blank', 'noopener');
      void queueFix(notebookId, source, url).catch((err) =>
        showJobToast(`Could not queue the fix: ${err instanceof Error ? err.message : String(err)}`, true),
      );
    });
    row.append(title, open);
    panel.appendChild(row);
  }

  for (const source of unfixable) {
    const row = panelRow();
    row.textContent = `${source.title} — YouTube source, can't be fixed automatically`;
    row.style.opacity = '0.7';
    panel.appendChild(row);
  }

  const hint = document.createElement('div');
  hint.textContent =
    'Open the page, then use the extension popup: "Add page as .md" replaces the broken source.';
  hint.style.cssText = 'margin-top:8px;opacity:0.7';
  panel.appendChild(hint);

  document.body.appendChild(panel);
  brokenPanel = panel;
}

async function onShowBroken(): Promise<void> {
  const notebookId = extractNotebookId(location.pathname);
  if (!notebookId) {
    showJobToast('Open a notebook first', true);
    return;
  }

  const btn = brokenBtn;
  if (btn) btn.disabled = true;
  try {
    const sources = await listSources(notebookId);
    const errored = sources.filter((s) => s.status === STATUS_ERROR);
    const broken = errored.filter((s) => s.type === TYPE_WEB && s.urls.length > 0);
    const unfixable = errored.filter((s) => s.type === TYPE_YOUTUBE);
    if (broken.length + unfixable.length === 0) {
      brokenPanel?.remove();
      showJobToast('No broken sources found', true);
      return;
    }
    showBrokenPanel(notebookId, broken, unfixable);
  } catch (err) {
    showJobToast(`Could not read sources: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function ensureUi(): void {
  const sortBtn = findSortButton();
  if (!sortBtn) return;

  ensureFilterInput(sortBtn);

  if (!brokenBtn || !brokenBtn.isConnected) {
    brokenBtn = buildIconButton(sortBtn, 'healing', 'Broken sources', () => {
      void onShowBroken();
    });
    sortBtn.insertAdjacentElement('afterend', brokenBtn);
  }

  if (!dupBtn || !dupBtn.isConnected) {
    dupBtn = buildIconButton(sortBtn, 'difference', 'Select duplicate sources', () => {
      void onSelectDuplicates();
    });
    sortBtn.insertAdjacentElement('afterend', dupBtn);
  }
}

// Same 2s polling as installDeleteButton — the panel re-renders
// rows on its own, so the filter is re-applied on the tick too.
export function installSourcesUi(): void {
  void waitFor(() => (findSortButton() ? true : null), 30000).then(() => ensureUi());
  setInterval(() => {
    ensureUi();
    if (filterInput?.value.trim()) applyFilter();
  }, 2000);
}
