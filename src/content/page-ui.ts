// Host-agnostic in-page helpers, shared by youtube-ui.ts and notion-ui.ts:
// the cached notebook list, the notebook tab URL, and the injected pill
// button with the rendered-element guards around it. Nothing here knows
// about YouTube or Notion — that is the point: importing it must not drag a
// host's own module into the other host's bundle.
//
// This module must not touch the DOM or chrome APIs at import time (it is
// bundled and imported by test/convert.test.mjs under Node) — all of that is
// deferred to the functions themselves.

type NotebookSummary = { id: string; title: string; emoji?: string };
export type NotebookCache = { notebooks: NotebookSummary[]; origin: string; at: number };

export const DEFAULT_ORIGIN = 'https://notebooklm.google.com';

// ---- notebook cache --------------------------------------------------------

export async function readNotebookCache(): Promise<NotebookCache | null> {
  const stored = await chrome.storage.local.get('notebookCache');
  const cache = stored.notebookCache as NotebookCache | undefined;
  return cache && Array.isArray(cache.notebooks) ? cache : null;
}

// Same URL shape as popup.ts's btnAddYoutube handler: a specific notebook
// opens at /notebook/<id>, a new one opens the bare origin (its own creation
// flow runs inside runYoutubeJob on that tab, not here).
export function notebookTabUrl(origin: string, targetId?: string): string {
  const base = origin.replace(/\/+$/, '');
  return targetId ? `${base}/notebook/${targetId}` : `${base}/`;
}

// ---- button styling (inline only, no stylesheet — same isolation rule as
// uploader.ts:showJobToast: this must not be reachable by YouTube's CSS, and
// vice versa) --------------------------------------------------------------

// Colors are read from YouTube's theme flag, not a --yt-spec-* variable:
// on the watch page --yt-spec-badge-chip-background resolves to something
// transparent, which is exactly why the button used to render as bare text.
// !important on every declaration because YouTube's own rule on the action
// row otherwise flattens the pill back to plain text.
function stylePillButton(btn: HTMLButtonElement, iconOnly: boolean): void {
  const dark = document.documentElement.hasAttribute('dark');
  const background = dark ? '#f1f1f1' : '#0f0f0f';
  const color = dark ? '#0f0f0f' : '#f1f1f1';
  btn.style.cssText = [
    'display:inline-flex !important',
    'align-items:center !important',
    'gap:6px !important',
    'height:36px !important',
    `padding:0 ${iconOnly ? '0' : '16px'} !important`,
    iconOnly ? 'width:36px !important;justify-content:center !important' : '',
    'border:0 !important',
    'border-radius:18px !important',
    `background:${background} !important`,
    `color:${color} !important`,
    'font:500 14px/36px Roboto,Arial,sans-serif !important',
    'cursor:pointer !important',
    'flex-shrink:0 !important',
    iconOnly ? 'margin-left:8px !important' : 'margin-right:8px !important',
    'opacity:1',
  ].join(';');
  // A theme switch mid-page leaves an already-injected button in
  // the old palette (no MutationObserver watching `dark`) — acceptable,
  // next injection pass (SPA navigation) picks up the new theme.
  btn.onpointerenter = () => {
    btn.style.setProperty('opacity', '.9', 'important');
  };
  btn.onpointerleave = () => {
    btn.style.setProperty('opacity', '1', 'important');
  };
}

export function buildButton(label: string, iconOnly: boolean): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.textContent = iconOnly ? '+' : label;
  stylePillButton(btn, iconOnly);
  // Some anchors (e.g. the watch-page playlist panel header) are themselves
  // a collapse toggle: without this, a click on the button bubbles up and
  // collapses the panel. Polymer's on-tap recognizer starts from
  // pointerdown/mousedown, so those need stopping too, not just click. Only
  // stopPropagation — never preventDefault/stopImmediatePropagation, callers
  // add their own click listener on this same node right after.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    btn.addEventListener(type, (e) => e.stopPropagation());
  }
  return btn;
}

// YouTube's SPA hides what it navigates away from instead of removing it
// (youtube.ts:visiblePageRoot) — stale page renderers, stale action rows.
// document.querySelector returns the FIRST match in document order, which can
// be one of those corpses: the button gets injected where nobody can see it
// and the "already injected" guard keeps it there forever, until a reload.
// Everything below therefore only ever matches rendered elements.
export function firstRendered<T extends { getClientRects(): { length: number } }>(
  els: Iterable<T>,
): T | null {
  for (const el of els) if (el.getClientRects().length > 0) return el;
  return null;
}

export function queryRendered<T extends HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return firstRendered(root.querySelectorAll<T>(sel));
}

// True when the caller should inject. A rendered button means "done"; any
// leftover hidden copies are dropped first so re-injection can't pile up.
export function claimSlot(marker: string): boolean {
  const existing = [...document.querySelectorAll(marker)];
  if (firstRendered(existing)) return false;
  for (const el of existing) el.remove();
  return true;
}
