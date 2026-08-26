// Injects a trash-can button into the Sources panel label row, right of
// NotebookLM's own "Sort sources" button (the `sort` mat-icon), that deletes
// all checked sources in one batch call to the private RPC tGMBJ
// (notebook.ts).
//
// The button itself is a `cloneNode(true)` of the sort button, so it inherits
// Material's classes and hover/focus highlight for free — those classes are
// copied wholesale, never matched as selectors.
//
// Selectors match by id prefix / aria-label / icon text, NEVER by CSS
// classes (DECISIONS.md #5) — NotebookLM is an Angular app and its generated
// classes change between releases without notice.
//
// Deletion is RPC-only, deliberately with no DOM fallback: see DECISIONS.md,
// "Decisions that must not be silently reverted" — simulating N overflow-menu
// clicks to delete sources is the worst combination (fragile selectors +
// an irreversible operation). If the RPC breaks, the button simply stops
// working, which is the right failure mode here.

import { extractNotebookId, waitFor, showJobToast } from './uploader';
import { deleteSources } from './notebook';

const MORE_BUTTON_ID_PREFIX = 'source-item-more-button-';
const SORT_BUTTON_RE = /sort sources|сортиров/i;

type CheckedSource = { id: string; title: string };

// Walks up from each checked checkbox to the row that contains exactly one
// "More" button — this is also what rejects the page's "Select all sources"
// checkbox, which lives outside any source row: from it, the walk reaches a
// container with all the rows' "More" buttons, so the count is > 1.
function collectCheckedSources(): CheckedSource[] {
  const sources: CheckedSource[] = [];
  const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type=checkbox]');

  for (const input of checkboxes) {
    if (!input.checked) continue;

    // The row is 5 levels up today (input -> mdc span -> label -> mat-checkbox
    // -> checkbox container -> row), so the limit has slack for one or two
    // extra Angular wrappers without reaching the whole source list.
    let el: HTMLElement | null = input;
    for (let depth = 0; depth < 10 && el; depth += 1) {
      const buttons = el.querySelectorAll(`[id^="${MORE_BUTTON_ID_PREFIX}"]`);
      if (buttons.length === 1) {
        const id = buttons[0].id.slice(MORE_BUTTON_ID_PREFIX.length);
        if (id) sources.push({ id, title: input.getAttribute('aria-label') ?? id });
        break;
      }
      el = el.parentElement;
    }
  }

  return sources;
}

// The source row that owns this "More" button: walk up while the parent
// still contains exactly one more-button — one level higher it would already
// hold the neighbouring rows' buttons. The depth cap is what stops the walk
// from reaching <body> in a notebook that has a single source (where no
// ancestor ever holds a second more-button); same slack as the walk in
// collectCheckedSources above.
export function sourceRow(moreButton: HTMLElement): HTMLElement {
  let row = moreButton;
  for (let depth = 0; depth < 10; depth += 1) {
    const parent = row.parentElement;
    if (!parent || parent.querySelectorAll(`[id^="${MORE_BUTTON_ID_PREFIX}"]`).length !== 1) break;
    row = parent;
  }
  return row;
}

export function findSortButton(): HTMLElement | null {
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const aria = btn.getAttribute('aria-label') || btn.getAttribute('mattooltip') || '';
    if (SORT_BUTTON_RE.test(aria)) return btn;

    const icon = btn.querySelector('mat-icon');
    if (icon && icon.textContent?.trim() === 'sort') return btn;
  }
  return null;
}

let deleteBtn: HTMLButtonElement | null = null;

// Lazily-created, shared tooltip pill — Angular's MatTooltip directive does
// not survive cloneNode, so the label under each of our header buttons is
// drawn by hand here, matching uploader.ts:showJobToast's palette (no
// separate theme). One pill serves every button (sources-ui.ts reuses it via
// attachTooltip): only one can be hovered at a time.
let tooltipEl: HTMLDivElement | null = null;

function getTooltip(): HTMLDivElement {
  if (tooltipEl) return tooltipEl;
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'padding:4px 8px',
    'border-radius:4px',
    'background:#202124',
    'color:#e8eaed',
    'font:12px/16px Roboto,system-ui,sans-serif',
    'pointer-events:none',
    'display:none',
  ].join(';');
  document.body.appendChild(el);
  tooltipEl = el;
  return el;
}

function showTooltip(btn: HTMLElement, label: string): void {
  const el = getTooltip();
  const rect = btn.getBoundingClientRect();
  el.textContent = label;
  el.style.display = 'block';
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - el.offsetWidth / 2, 0),
    window.innerWidth - el.offsetWidth,
  );
  el.style.left = `${left}px`;
  el.style.top = `${rect.bottom + 6}px`;
}

function hideTooltip(): void {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

export function attachTooltip(btn: HTMLElement, label: string): void {
  btn.addEventListener('mouseenter', () => showTooltip(btn, label));
  btn.addEventListener('focus', () => showTooltip(btn, label));
  btn.addEventListener('mouseleave', hideTooltip);
  btn.addEventListener('blur', hideTooltip);
  btn.addEventListener('click', hideTooltip);
}

function buildButton(sortBtn: HTMLElement): HTMLButtonElement {
  const btn = sortBtn.cloneNode(true) as HTMLButtonElement;
  btn.removeAttribute('id');
  btn.removeAttribute('mattooltip');
  btn.removeAttribute('ng-reflect-message');
  btn.removeAttribute('title');
  btn.removeAttribute('aria-describedby');
  // Sort button is a menu trigger; ours isn't — drop the menu semantics so
  // screen readers don't announce a menu this button doesn't open, and don't
  // forward Google's own click-logging attribute.
  btn.removeAttribute('aria-haspopup');
  btn.removeAttribute('aria-expanded');
  btn.removeAttribute('jslog');
  btn.classList.remove('mat-mdc-menu-trigger', 'source-sort-button');
  btn.type = 'button';
  btn.style.cssText = 'margin-left:4px';
  btn.setAttribute('aria-label', 'Delete checked sources');

  const icon = btn.querySelector('mat-icon');
  if (icon) {
    icon.textContent = 'delete';
  } else {
    const fallbackIcon = document.createElement('mat-icon');
    fallbackIcon.className = 'mat-icon notranslate material-symbols-outlined google-symbols mat-icon-no-color';
    fallbackIcon.setAttribute('aria-hidden', 'true');
    fallbackIcon.setAttribute('data-mat-icon-type', 'font');
    fallbackIcon.textContent = 'delete';
    btn.appendChild(fallbackIcon);
  }

  btn.addEventListener('click', onDeleteClick);
  attachTooltip(btn, 'Delete');
  return btn;
}

function ensureButton(): void {
  const sortBtn = findSortButton();
  if (!sortBtn) return;

  if (!deleteBtn || !deleteBtn.isConnected) {
    deleteBtn = buildButton(sortBtn);
    sortBtn.insertAdjacentElement('afterend', deleteBtn);
  }
}

async function onDeleteClick(): Promise<void> {
  const notebookId = extractNotebookId(location.pathname);
  if (!notebookId) {
    showJobToast('Open a notebook first', true);
    return;
  }

  const sources = collectCheckedSources();
  if (sources.length === 0) {
    showJobToast('No sources are checked', true);
    return;
  }

  const preview = sources
    .slice(0, 10)
    .map((s) => `- ${s.title}`)
    .join('\n');
  const more = sources.length > 10 ? `\n… and ${sources.length - 10} more` : '';
  const confirmed = confirm(
    `Delete ${sources.length} source(s)?\n${preview}${more}\n\nThis permanently deletes them and cannot be undone.`,
  );
  if (!confirmed) return;

  const btn = deleteBtn;
  if (btn) btn.disabled = true;
  try {
    await deleteSources(
      notebookId,
      sources.map((s) => s.id),
    );
    location.reload();
  } catch (err) {
    showJobToast(`Could not delete sources: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 2s polling instead of a routed MutationObserver — cheap and
// enough for one header button; revisit only if it visibly flickers.
export function installDeleteButton(): void {
  void waitFor(() => (findSortButton() ? true : null), 30000).then(() => ensureButton());
  setInterval(ensureButton, 2000);
}
