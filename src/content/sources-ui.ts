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

// Hidden rows stay checked on purpose — checked is NotebookLM's chat context,
// which a filter must not change. The delete button skips hidden rows
// (delete-ui.ts:collectCheckedSources), so only visible checked rows go.
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

// After NotebookLM's redesign the page's icon font only carries its own
// glyphs (sort, delete, ...), so ligature text for our icons renders as
// clipped letters. Draw them as inline SVGs instead (Material Symbols
// Rounded, weight 300 to match NotebookLM's own glyphs; viewBox 0 -960 960 960).
const ICON_PATHS = {
  difference:
    'M510-610v50q0 12.75 8.63 21.37 8.63 8.63 21.38 8.63 12.76 0 21.37-8.63Q570-547.25 570-560v-50h50q12.75 0 21.37-8.63 8.63-8.63 8.63-21.38 0-12.76-8.63-21.37Q632.75-670 620-670h-50v-50q0-12.75-8.63-21.37-8.63-8.63-21.38-8.63-12.76 0-21.37 8.63Q510-732.75 510-720v50h-50q-12.75 0-21.37 8.63-8.63 8.63-8.63 21.38 0 12.76 8.63 21.37Q447.25-610 460-610h50Zm-50 240h160q12.75 0 21.37-8.63 8.63-8.63 8.63-21.38 0-12.76-8.63-21.37Q632.75-430 620-430H460q-12.75 0-21.37 8.63-8.63 8.63-8.63 21.38 0 12.76 8.63 21.37Q447.25-370 460-370ZM332.31-220Q302-220 281-241q-21-21-21-51.31v-535.38Q260-858 281-879q21-21 51.31-21h247.77q14.63 0 27.89 5.62 13.26 5.61 23.11 15.46l167.84 167.84q9.85 9.85 15.46 23.11 5.62 13.26 5.62 27.89v367.77Q820-262 799-241q-21 21-51.31 21H332.31Zm0-60h415.38q4.62 0 8.46-3.85 3.85-3.84 3.85-8.46V-660L580-840H332.31q-4.62 0-8.46 3.85-3.85 3.84-3.85 8.46v535.38q0 4.62 3.85 8.46 3.84 3.85 8.46 3.85Zm-160 220Q142-60 121-81q-21-21-21-51.31V-630q0-12.75 8.63-21.37 8.63-8.63 21.38-8.63 12.76 0 21.37 8.63Q160-642.75 160-630v497.69q0 4.62 3.85 8.46 3.84 3.85 8.46 3.85H550q12.75 0 21.37 8.63 8.63 8.63 8.63 21.38 0 12.76-8.63 21.37Q562.75-60 550-60H172.31ZM320-280v-560V-280Z',
  link_off:
    'M616.92-456.31 563.23-510h36q12.77 0 21.38 8.62 8.62 8.61 8.62 21.38 0 7.69-3.23 13.77-3.23 6.08-9.08 9.92Zm210 365.39q-8.69 8.69-21.07 8.69-12.39 0-21.08-8.69L90.92-784.77q-8.3-8.31-8.5-20.88-.19-12.58 8.5-21.27 8.7-8.7 21.08-8.7 12.38 0 21.08 8.7l693.84 693.84q8.31 8.31 8.5 20.89.2 12.57-8.5 21.27ZM281.54-298.46q-75.31 0-128.42-53.12Q100-404.69 100-480q0-66.69 42.96-117.04 42.96-50.34 107.81-60.8H260l56.31 56.3h-34.77q-50.39 0-85.96 35.58Q160-530.38 160-480q0 50.38 35.58 85.96 35.57 35.58 85.96 35.58h121.54q12.77 0 21.38 8.61 8.62 8.62 8.62 21.39 0 12.77-8.62 21.38-8.61 8.62-21.38 8.62H281.54ZM360.77-450q-12.77 0-21.38-8.62-8.62-8.61-8.62-21.38t8.62-21.38Q348-510 360.77-510h47.69l59 60H360.77Zm372.69 114.31q-6.69-10.54-4.38-22.69 2.3-12.16 13.23-18.47 26.46-16.23 42.07-43.34Q800-447.31 800-480q0-50.38-35.38-85.96-35.39-35.58-85.39-35.58H556.92q-12.77 0-21.38-8.61-8.62-8.62-8.62-21.39 0-12.77 8.62-21.38 8.61-8.62 21.38-8.62h122.31q74.92 0 127.85 53.12Q860-555.31 860-480q0 47.46-23.08 87.65-23.08 40.2-62.31 65.12-10.53 6.69-22.5 4.38-11.96-2.3-18.65-12.84Z',
} as const;

function buildIconSvg(icon: keyof typeof ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '1em');
  svg.setAttribute('height', '1em');
  svg.setAttribute('viewBox', '0 -960 960 960');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'block';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[icon]);
  svg.appendChild(path);
  return svg;
}

function buildIconButton(
  sortBtn: HTMLElement,
  icon: keyof typeof ICON_PATHS,
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
    iconEl.replaceChildren(buildIconSvg(icon));
  } else {
    const fallbackIcon = document.createElement('mat-icon');
    fallbackIcon.className = 'mat-icon notranslate material-symbols-outlined google-symbols mat-icon-no-color';
    fallbackIcon.setAttribute('aria-hidden', 'true');
    fallbackIcon.appendChild(buildIconSvg(icon));
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
    brokenBtn = buildIconButton(sortBtn, 'link_off', 'Broken sources', () => {
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
