// "Add to NotebookLM" button injected into Notion's own top bar, plus the
// dialog behind it — the Notion counterpart of youtube-ui.ts, deliberately a
// copy of that pattern rather than a generalisation of it (the two pages have
// nothing in common but the shape of the flow).
//
// Content is not scraped from the DOM. On app.notion.com the page is fetched
// through Notion's own export endpoint (`/api/v3/enqueueTask` → `getTasks` →
// the zip), so Notion itself does the Markdown conversion and `recursive`
// brings the child pages along for free. That endpoint answers 401 for a page
// the visitor is not a member of, so public `*.notion.site` pages take the
// second path instead: their block JSON, read by ./notion-public.ts and
// converted by lib/notion-blocks.ts — DECISIONS.md #18 for both, and for what
// to do when Notion changes either protocol.
//
// Anchors are matched by Notion's own semantic `notion-topbar*` class names
// and by `aria-label="Share"`, never by the per-build hashed classes Notion
// actually styles with (`x87ps6o`-style — DECISIONS.md #5), with a short
// fallback ladder so one markup change does not take the button out entirely.
// The app lives on app.notion.com (www.notion.so/<id> 302s there); public
// sites live on *.notion.site and have their own, shorter ladder.
//
// This module must not touch the DOM or chrome APIs at import time (content
// modules are bundled and imported by test/convert.test.mjs under Node) — all
// of that is deferred to installNotionButton() and the functions it calls.

import {
  DEFAULT_ORIGIN,
  buildButton,
  claimSlot,
  notebookTabUrl,
  queryRendered,
  readNotebookCache,
} from './page-ui';
import { notionPageId, exportTaskBody, unzipEntries, pickPages, type NotionPage } from '../lib/notion-export';
import type { YoutubeJob } from './notebook';
import { fetchPublicPages, post, sleep, MAX_FILES } from './notion-public';
import { isPro, trialRemaining, noteTrialUse, FREE_QUOTA, PRICE_LABEL, CHECKOUT_URL } from '../lib/license.js';

const MARKER = '[data-source-lm-notion-btn]';

// A function, not a const: this module is imported under Node by the tests, so
// nothing may read `location` at import time.
const publicSite = (): boolean => location.hostname.endsWith('.notion.site');

// ---- export through Notion's own endpoint ---------------------------------

const POLL_MS = 1500;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

type TaskResult = { state?: string; error?: string; status?: { exportURL?: string } };

// Network half of the Notion export (the pure half — ids, request body, zip,
// path filtering — is src/lib/notion-export.ts, which is what the test covers).
export async function exportPages(pageId: string, recursive: boolean): Promise<NotionPage[]> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const enqueued = (await post('enqueueTask', exportTaskBody(pageId, recursive, timeZone))) as {
    taskId?: string;
  };
  if (!enqueued?.taskId) throw new Error('Notion did not start the export');

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let exportUrl = '';
  while (!exportUrl) {
    await sleep(POLL_MS);
    const polled = (await post('getTasks', { taskIds: [enqueued.taskId] })) as { results?: TaskResult[] };
    const result = polled?.results?.[0];
    if (result?.state === 'failure') throw new Error(result.error || 'Notion failed to export this page');
    if (result?.state === 'success' && result.status?.exportURL) {
      exportUrl = result.status.exportURL;
      break;
    }
    if (Date.now() > deadline) {
      throw new Error('Notion is still exporting after three minutes — try again, or untick child pages');
    }
  }

  // The URL comes from a server response and is fetched with the user's
  // cookies — never follow it off Notion (same rule as uploader.ts).
  const u = new URL(exportUrl);
  if (u.protocol !== 'https:' || !/(^|\.)notion\.(com|so)$/.test(u.hostname)) {
    throw new Error('Notion returned an export link on an unexpected host');
  }

  // The zip sits on a signed file.notion.com URL. Read cross-origin from the
  // page context it answered 200 with `content-type: application/zip`
  // (checked 2026-09-19) — no relay, no extra host permission
  // (DECISIONS.md #18). Should Notion ever tighten CORS there, the refusal
  // reaches us as a bare TypeError from fetch, so it is translated into
  // something the user can act on instead of "Failed to fetch".
  let buf: ArrayBuffer;
  try {
    const zip = await fetch(exportUrl, { credentials: 'include', signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (!zip.ok) throw new Error(`Notion answered ${zip.status} for the export file`);
    buf = await zip.arrayBuffer();
  } catch (err) {
    if (err instanceof TypeError) throw new Error('Notion blocked the export download — reload the page and try again');
    throw err;
  }

  const pages = pickPages(await unzipEntries(buf), recursive ? 1 : 0);
  if (pages.length === 0) throw new Error('No pages in export');
  // Same ceiling as the public path: NotebookLM takes 300 sources at most.
  return pages.slice(0, MAX_FILES);
}

// ---- dialog ----------------------------------------------------------------

const DIALOG_KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

let dialogHost: HTMLDivElement | null = null;
let dialogKeyHandler: ((e: KeyboardEvent) => void) | null = null;

function closeDialog(): void {
  dialogHost?.remove();
  dialogHost = null;
  if (dialogKeyHandler) {
    for (const type of DIALOG_KEY_EVENTS) {
      window.removeEventListener(type, dialogKeyHandler, { capture: true });
    }
    dialogKeyHandler = null;
  }
}

// Perceived lightness of an `rgb(...)`/`rgba(...)` string, the only forms
// getComputedStyle hands back. Anything unparseable reads as light, which is
// Notion's default theme.
function darkBackground(color: string): boolean {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number);
  if ([r, g, b].some((n) => !Number.isFinite(n))) return false;
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

export async function openNotionDialog(pageId: string): Promise<void> {
  const cache = await readNotebookCache();
  const origin = cache?.origin ?? DEFAULT_ORIGIN;
  const notebooks = cache?.notebooks ?? [];

  // Only now, so two fast clicks cannot leave the first dialog's backdrop and
  // key listeners behind while the second one is still awaiting the cache.
  closeDialog();

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' });

  // Notion's theme is an in-app setting, and its `--theme--*` custom
  // properties read back empty on <body>, so neither a variable nor
  // prefers-color-scheme can be trusted here: the dialog copies the two colors
  // the app itself is currently painted in, once, at open time.
  const appStyle = getComputedStyle(document.body);
  const bg = appStyle.backgroundColor || '#ffffff';
  const text = appStyle.color || '#37352f';
  const dark = darkBackground(bg);
  const bgSecondary = dark ? 'rgba(255,255,255,.055)' : 'rgba(15,15,15,.03)';
  const textSecondary = dark ? 'rgba(255,255,255,.46)' : 'rgba(15,15,15,.45)';
  const border = dark ? 'rgba(255,255,255,.13)' : 'rgba(15,15,15,.13)';

  const style = document.createElement('style');
  style.textContent = `
    .backdrop { position:fixed; inset:0; background:rgba(15,15,15,.6); display:flex; align-items:center; justify-content:center; font:14px/1.4 ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; }
    .card { background:${bg}; color:${text}; border-radius:8px; padding:20px; width:340px; max-width:90vw; box-shadow:0 8px 24px rgba(15,15,15,.3); }
    h2 { margin:0 0 4px; font-size:16px; }
    p.subtitle { margin:0 0 16px; color:${textSecondary}; font-size:13px; overflow-wrap:anywhere; }
    label { display:block; margin:12px 0 4px; font-size:12px; color:${textSecondary}; }
    [hidden] { display:none; }
    select, input[type=text] { width:100%; box-sizing:border-box; padding:8px; border-radius:4px; border:1px solid ${border}; background:${bgSecondary}; color:${text}; font:inherit; }
    select:disabled { opacity:.5; }
    .hint { font-size:12px; color:${textSecondary}; margin-top:6px; }
    label.check { display:flex; align-items:center; gap:8px; color:${text}; font-size:13px; margin:14px 0 0; }
    label.check input { margin:0; }
    .error { font-size:12px; color:#eb5757; margin-top:6px; }
    .error a { color:#2383e2; }
    .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
    button { font:inherit; border:0; border-radius:4px; padding:8px 16px; cursor:pointer; }
    .cancel { background:transparent; color:${text}; }
    .add { background:#2383e2; color:#ffffff; font-weight:500; }
    /* .busy sits after [hidden] in this sheet and matches with the same
       specificity, so it needs its own hidden guard to stay hideable. */
    .busy[hidden] { display:none; }
    .busy { display:flex; align-items:center; gap:8px; font-size:12px; color:${textSecondary}; margin-top:12px; }
    .busy::before { content:''; width:10px; height:10px; box-sizing:border-box; border:2px solid ${border}; border-top-color:#2383e2; border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
  `;
  shadow.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';

  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h2');
  heading.textContent = 'Add this page to NotebookLM';
  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  // document.title is "<Page> | Notion" in the app and "<Page> | <View>" on a
  // published site, where the view name is worth keeping.
  subtitle.textContent = document.title.replace(/\s*\|\s*Notion\s*$/, '').trim();
  card.append(heading, subtitle);

  const selectLabel = document.createElement('label');
  selectLabel.textContent = 'Notebook';
  const select = document.createElement('select');
  const NEW_VALUE = '__new__';
  for (const nb of notebooks) {
    const opt = document.createElement('option');
    opt.value = nb.id;
    opt.textContent = nb.emoji ? `${nb.emoji} ${nb.title}` : nb.title;
    select.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = NEW_VALUE;
  newOpt.textContent = '＋ New notebook';
  select.appendChild(newOpt);
  if (notebooks.length === 0) {
    select.disabled = true;
    select.value = NEW_VALUE;
  }
  card.append(selectLabel, select);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Open Gemini Notebook once so the extension can see your notebooks';
  hint.hidden = notebooks.length > 0;
  card.appendChild(hint);

  const titleLabel = document.createElement('label');
  titleLabel.textContent = 'New notebook title (optional)';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Named automatically';
  titleLabel.hidden = true;
  titleInput.hidden = true;
  card.append(titleLabel, titleInput);

  function syncNewNotebookFields(): void {
    const isNew = select.value === NEW_VALUE;
    titleLabel.hidden = !isNew;
    titleInput.hidden = !isNew;
  }
  select.addEventListener('change', syncNewNotebookFields);
  syncNewNotebookFields();

  const childrenCheck = document.createElement('input');
  childrenCheck.type = 'checkbox';
  const checkRow = document.createElement('label');
  checkRow.className = 'check';
  checkRow.append(childrenCheck, document.createTextNode('Include child pages (1 level)'));
  const note = document.createElement('div');
  note.className = 'hint';
  note.textContent = 'Child pages come in as extra sources — more than one source per action is metered.';
  card.append(checkRow, note);

  const errorLine = document.createElement('div');
  errorLine.className = 'error';
  errorLine.hidden = true;
  card.appendChild(errorLine);

  const busyLine = document.createElement('div');
  busyLine.className = 'busy';
  busyLine.hidden = true;
  card.appendChild(busyLine);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeDialog);
  const addBtn = document.createElement('button');
  addBtn.className = 'add';
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  actions.append(cancelBtn, addBtn);
  card.appendChild(actions);

  addBtn.addEventListener('click', () => {
    void (async () => {
      const createNew = select.value === NEW_VALUE;
      const createTitle = titleInput.value.trim();
      const recursive = childrenCheck.checked;

      errorLine.hidden = true;
      addBtn.disabled = true;
      const showUpsell = () => {
        errorLine.textContent = '';
        errorLine.append(
          `Free plan: ${FREE_QUOTA} imports per month, all used (resets on the 1st). Pro is a one-time ${PRICE_LABEL} — `,
        );
        const link = document.createElement('a');
        link.href = CHECKOUT_URL;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'get Pro';
        errorLine.append(link, '.');
        errorLine.hidden = false;
        addBtn.disabled = false;
      };
      const outOfQuota = async () => !(await isPro()) && (await trialRemaining()) === 0;
      try {
        // Gate first, before the export runs: ticking the box is the only way
        // this page can *ask* for more than one source, and a minutes-long
        // export must not happen at all for a user who cannot use its result
        // (DECISIONS.md #15 — one source is always free).
        if (recursive && (await outOfQuota())) {
          showUpsell();
          return;
        }

        let pages: NotionPage[];
        busyLine.textContent = 'Exporting from Notion…';
        busyLine.hidden = false;
        try {
          // The export endpoint answers 401 for a page the visitor does not
          // own, which is every public site — those are read block by block
          // instead (DECISIONS.md #18).
          pages = publicSite()
            ? await fetchPublicPages(pageId, recursive, location.hostname, (msg) => {
                busyLine.textContent = msg;
              })
            : await exportPages(pageId, recursive);
        } finally {
          busyLine.hidden = true;
        }
        const files = pages.map(({ filename, markdown }) => ({ filename, markdown }));

        // The real count, not the checkbox: a database page with the box
        // unticked still yields every row at one depth, so the gate runs again
        // on what the export actually produced (DECISIONS.md #15).
        if (files.length > 1 && (await outOfQuota())) {
          showUpsell();
          return;
        }

        // Same contract as popup.ts and youtube-ui.ts: the notebook tab's
        // content script (uploader.ts) auto-runs runYoutubeJob on load and
        // reports progress with its own toast.
        const job: YoutubeJob = {
          type: 'ADD_YOUTUBE',
          videos: [],
          files,
          createdAt: Date.now(),
          ...(createNew ? { createTitle } : { targetNotebookId: select.value }),
        };
        try {
          await chrome.storage.local.set({ youtubeJob: job });
        } catch {
          // storage.local is ~10 MB and the job carries every page's Markdown.
          throw new Error('Too much content for one run — untick child pages or pick a smaller page');
        }
        // A ticked box that turns out to have no child pages is still one
        // source, so it stays free — the spend follows what was actually
        // produced, not what was asked for. window.open does not kill a
        // content-script context, so the honest check-then-commit order works
        // here (DECISIONS.md #15).
        if (files.length > 1) await noteTrialUse();
        window.open(notebookTabUrl(origin, createNew ? undefined : select.value), '_blank');
        closeDialog();
      } catch (err) {
        errorLine.textContent = err instanceof Error ? err.message : String(err);
        errorLine.hidden = false;
        addBtn.disabled = false;
      }
    })();
  });

  backdrop.appendChild(card);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeDialog();
  });
  shadow.appendChild(backdrop);

  // Notion binds single-key hotkeys on the document (and opens its own search
  // on Cmd/Ctrl+K), and shadow DOM retargets events: outside the shadow tree
  // e.target for a key typed in titleInput reads as `dialogHost`, so those
  // listeners fire anyway. window capture runs before them, so stopPropagation
  // here keeps the key from ever reaching Notion. composedPath() (not
  // e.target) is what still exposes the real target for the check.
  dialogKeyHandler = (e) => {
    if (e.composedPath().includes(host)) e.stopPropagation();
    if (e.type === 'keydown' && e.key === 'Escape') closeDialog();
  };
  for (const type of DIALOG_KEY_EVENTS) {
    window.addEventListener(type, dialogKeyHandler, { capture: true });
  }

  document.body.appendChild(host);
  dialogHost = host;
}

// ---- injection -------------------------------------------------------------

// The top bar's right-hand action area, as a three-rung ladder.
// `.notion-topbar-action-buttons` is Notion's own hand-written, descriptive
// class name — not the per-build hashes it is actually styled with
// (DECISIONS.md #5) — and everything below it is structure, no class names at
// all. Rung 1: in front of the Share button. Rung 2 (Share renamed, or a
// non-English aria-label): the start of the same action row. Rung 3 (the
// container is gone): nothing is injected. Public *.notion.site pages have no
// `.notion-topbar-action-buttons` at all — they get their own ladder, below.
type Anchor = { host: HTMLElement; before: Element | null; sizeRef: Element | null };

// Descends single-child wrappers to the element that actually paints.
function innermost(el: Element | null): Element | null {
  while (el?.children.length === 1) el = el.firstElementChild;
  return el;
}

function findTopbarAnchor(): Anchor | null {
  if (publicSite()) return findPublicTopbarAnchor();
  const container = queryRendered<HTMLElement>('.notion-topbar-action-buttons');
  if (!container) return null;

  // The container wraps the row in single-child divs; descend to the row that
  // actually holds the buttons ("Edited …", Share, link, star, •••).
  let row = container;
  while (row.children.length === 1 && row.firstElementChild instanceof HTMLElement) {
    row = row.firstElementChild;
  }

  const share = container.querySelector('[aria-label="Share"]');
  const shareSlot = share && [...row.children].find((child) => child.contains(share));
  return { host: row, before: shareSlot ?? row.firstElementChild, sizeRef: share };
}

// Published sites have a `.notion-topbar` but none of the app's action
// containers (live DOM, 2026-09-19): `.notion-topbar > div` holds [title,
// spacer, right block], and the right block's last child is the row
// [search, div, socials, ••• , "Get Notion free"]. Rung 1: walk up from one of
// the two aria-labels to the row's own child that contains it, and sit in
// front of it. Rung 2 (labels renamed or localised): the end of that chain by
// structure alone, prepended. Rung 3: nothing.
function findPublicTopbarAnchor(): Anchor | null {
  const bar = queryRendered<HTMLElement>('.notion-topbar');
  if (!bar) return null;

  let slot: Element | null =
    bar.querySelector('[aria-label="More actions"]') ?? bar.querySelector('[aria-label="Share site to socials"]');
  while (slot?.parentElement && slot.parentElement !== bar && slot.parentElement.children.length < 3) {
    slot = slot.parentElement;
  }
  const row = slot?.parentElement;
  if (row instanceof HTMLElement && row.children.length >= 3) {
    return { host: row, before: slot, sizeRef: innermost(row.lastElementChild) };
  }

  const fallback = bar.firstElementChild?.lastElementChild?.lastElementChild;
  return fallback instanceof HTMLElement
    ? { host: fallback, before: fallback.firstElementChild, sizeRef: null }
    : null;
}

function ensureButton(): void {
  // No page id means login, onboarding, the home/inbox views — nothing to
  // export, and a button there would only ever error.
  if (!notionPageId(location.href)) {
    for (const el of document.querySelectorAll(MARKER)) el.remove();
    return;
  }
  const anchor = findTopbarAnchor();
  if (!anchor) return;
  // Document-wide, not per-parent: which rung of the ladder matched can change
  // between renders, so a per-parent check would miss a button already sitting
  // under the other host and inject a second one.
  if (!claimSlot(MARKER)) return;

  const btn = buildButton('Add to NotebookLM', false);
  btn.dataset.sourceLmNotionBtn = '1';
  // buildButton is sized for YouTube's 36px action row; Notion's top bar runs
  // 28px, and its own primary button there ("Get Notion free") is black on a
  // light theme, white on a dark one — same inversion as the YouTube pill.
  const dark = darkBackground(getComputedStyle(document.body).backgroundColor);
  // Height is copied from a real neighbour button (Share in the app, the
  // "Get Notion free" CTA on published sites): 28px in one, taller in the
  // other, so a hard-coded value is off on one of them.
  const sibling = Math.round(anchor.sizeRef?.getBoundingClientRect().height ?? 0);
  const height = `${sibling >= 24 && sibling <= 40 ? sibling : 28}px`;
  for (const [prop, value] of [
    ['height', height],
    ['line-height', height],
    ['border-radius', '6px'],
    ['padding', '0 10px'],
    ['font', `500 14px/${height} ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif`],
    ['background', dark ? '#ffffff' : '#191919'],
    ['color', dark ? '#191919' : '#ffffff'],
    ['margin-right', '8px'],
  ]) {
    btn.style.setProperty(prop, value, 'important');
  }
  btn.addEventListener('click', () => {
    const pageId = notionPageId(location.href);
    if (pageId) void openNotionDialog(pageId);
  });

  anchor.host.insertBefore(btn, anchor.before);
}

// 2s polling instead of a routed MutationObserver — same trade-off as
// youtube-ui.ts:installYoutubeButtons and delete-ui.ts:installDeleteButton; it
// also covers Notion's SPA navigation (page -> page -> home) for free, since
// ensureButton() is idempotent (it claims its own marker attribute first).
export function installNotionButton(): void {
  ensureButton();
  setInterval(ensureButton, 2000);
}
