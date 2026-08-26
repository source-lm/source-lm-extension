// "Add to notebook" buttons injected into YouTube's own action rows (watch
// page, watch-page playlist panel, playlist page) — see DECISIONS.md and the
// plan this implements for the constraint that shapes the whole file: a
// content script on youtube.com cannot reach the NotebookLM tab (no
// chrome.tabs, no service worker to relay through, DECISIONS.md #3) and cannot
// call the batchexecute RPC itself (page CORS + cookies belong to the
// notebook origin). So the notebook list is cached by the NotebookLM content
// script (uploader.ts init block) into chrome.storage.local, and read here.
//
// Anchors are matched by id / aria-label / element tag, NEVER by CSS class
// (DECISIONS.md #5) — YouTube's classes are generated and change without
// notice, same as NotebookLM's. Each anchor is a short fallback ladder so a
// single markup change doesn't take the button out entirely.
//
// This module must not touch the DOM or chrome APIs at import time (it is
// bundled and imported by test/convert.test.mjs under Node) — all of that is
// deferred to installYoutubeButtons() and the functions it calls.

import { collectVideos, dedupeVideos, visiblePageRoot, type VideoItem } from './youtube';
import { isPro, trialRemaining, noteTrialUse, FREE_QUOTA, PRICE_LABEL, CHECKOUT_URL } from '../lib/license.js';
import { frontmatter, slugify } from '../lib/markdown-generator.js';

type NotebookSummary = { id: string; title: string; emoji?: string };
type NotebookCache = { notebooks: NotebookSummary[]; origin: string; at: number };

const DEFAULT_ORIGIN = 'https://notebooklm.google.com';

// ---- pure helpers (exported for the test, no DOM/chrome) -----------------

// Current watch-page video from location.search (the `v=` param) and a
// title source — caller passes `ytd-watch-metadata h1`'s text if found,
// else document.title (which YouTube suffixes with " - YouTube").
export function currentWatchVideo(href: string, title: string): VideoItem | null {
  const match = href.match(/[?&]v=([^&#]+)/);
  if (!match) return null;
  const videoId = match[1];
  const cleanTitle = title.replace(/\s*-\s*YouTube\s*$/, '').trim();
  return {
    videoId,
    title: cleanTitle || `Video ${videoId}`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

// The current watch page's video, DOM/location included — same h1-or-
// document.title ladder harvestCommentsFile and ensureWatchButton both used
// to duplicate inline.
export function currentPageVideo(): VideoItem | null {
  const h1 = document.querySelector('ytd-watch-metadata h1');
  return currentWatchVideo(location.href, (h1?.textContent || document.title).trim());
}

// Same URL shape as popup.ts's btnAddYoutube handler: a specific notebook
// opens at /notebook/<id>, a new one opens the bare origin (its own creation
// flow runs inside runYoutubeJob on that tab, not here).
export function notebookTabUrl(origin: string, targetId?: string): string {
  const base = origin.replace(/\/+$/, '');
  return targetId ? `${base}/notebook/${targetId}` : `${base}/`;
}

// Channel URLs: the handle form (/@name), and three legacy forms YouTube
// still serves (/channel/UC…, /c/name, /user/name).
export function isChannelPage(pathname: string): boolean {
  return /^\/(@|channel\/|c\/|user\/)/.test(pathname);
}

// Stop condition for the channel Videos-tab scroll loop: done once enough
// videos are collected, or growth has stalled for two rounds in a row
// (YouTube has no more to lazy-load). `prev`/`current` are this round's
// count before/after a scroll+collect pass; `stalls` is the caller's
// running count of consecutive non-growing rounds, this one included.
export function harvestDone(prev: number, current: number, stalls: number, limit: number): boolean {
  if (current >= limit) return true;
  return current <= prev && stalls >= 2;
}

// One nesting level only — YouTube itself is flat under a thread: a reply to
// a reply renders as a sibling reply with an @mention, not as a deeper level.
export type YoutubeComment = { author: string; text: string; likes?: string; replies?: YoutubeComment[] };

function commentHead(c: YoutubeComment): string {
  return c.likes ? `**${c.author}** · ${c.likes} likes` : `**${c.author}**`;
}

// One .md source out of the harvested comment threads. Same frontmatter shape
// as popup.ts:pageToMarkdown, plus `count`/`replies` so the notebook shows how
// much made it in (the harvest stops at a limit and a wall clock). Threads are
// separated by `---`, replies sit under their parent as a blockquote so the
// nesting survives into whatever reads the source.
export function commentsToMarkdown(videoTitle: string, url: string, comments: YoutubeComment[]): string {
  const fm = frontmatter([
    ['title', `Comments — ${videoTitle}`],
    ['url', url],
    ['captured', new Date().toISOString()],
    ['count', comments.length],
    ['replies', comments.reduce((n, c) => n + (c.replies?.length ?? 0), 0)],
  ]);
  const threads = comments.map((c) =>
    [
      `${commentHead(c)}\n\n${c.text.trim()}`,
      ...(c.replies ?? []).map((r) =>
        [commentHead(r), '', ...r.text.trim().split('\n')].map((line) => `> ${line}`.trimEnd()).join('\n'),
      ),
    ].join('\n\n'),
  );
  return [fm, `# Comments — ${videoTitle}`, threads.join('\n\n---\n\n')].filter(Boolean).join('\n\n');
}

// ---- notebook cache --------------------------------------------------------

async function readNotebookCache(): Promise<NotebookCache | null> {
  const stored = await chrome.storage.local.get('notebookCache');
  const cache = stored.notebookCache as NotebookCache | undefined;
  return cache && Array.isArray(cache.notebooks) ? cache : null;
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

function buildButton(label: string, iconOnly: boolean): HTMLButtonElement {
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

function queryRendered<T extends HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return firstRendered(root.querySelectorAll<T>(sel));
}

// True when the caller should inject. A rendered button means "done"; any
// leftover hidden copies are dropped first so re-injection can't pile up.
function claimSlot(marker: string): boolean {
  const existing = [...document.querySelectorAll(marker)];
  if (firstRendered(existing)) return false;
  for (const el of existing) el.remove();
  return true;
}

// ---- dialog ----------------------------------------------------------------

// `limitDefault`/`resolve` are for flows where the video list isn't known
// yet at dialog-open time (the channel harvest): the dialog shows a "latest
// N" field instead of a fixed count, and `resolve(limit)` runs on Add to
// produce the actual video list (it may throw — surfaced as an error line).
// `comments` is watch-page only: an optional extra .md source built from the
// page's comment threads, resolved on Add (the harvest scrolls for up to a
// minute, so it must not run just because the dialog opened).
type DialogSubject = {
  videos: VideoItem[];
  countLabel: string;
  limitDefault?: number;
  resolve?: (limit: number) => Promise<VideoItem[]>;
  comments?: { limitDefault: number; resolve: (limit: number) => Promise<{ filename: string; markdown: string }> };
};

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

async function openDialog(subject: DialogSubject): Promise<void> {
  closeDialog();
  if (subject.videos.length === 0 && subject.limitDefault === undefined) return;

  const cache = await readNotebookCache();
  const origin = cache?.origin ?? DEFAULT_ORIGIN;
  const notebooks = cache?.notebooks ?? [];

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    /* YouTube's own CSS custom properties inherit through the shadow
       boundary, so the dialog follows the page's light/dark theme; the
       literals are only the fallback if YouTube renames a variable. */
    .backdrop { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; font:14px/1.4 Roboto,Arial,sans-serif; }
    .card { background:var(--yt-spec-menu-background,#212121); color:var(--yt-spec-text-primary,#f1f1f1); border-radius:12px; padding:20px; width:320px; max-width:90vw; box-shadow:0 8px 24px rgba(0,0,0,.4); }
    h2 { margin:0 0 4px; font-size:16px; }
    p.subtitle { margin:0 0 16px; color:var(--yt-spec-text-secondary,#aaa); font-size:13px; }
    label { display:block; margin:12px 0 4px; font-size:12px; color:var(--yt-spec-text-secondary,#aaa); }
    [hidden] { display:none; }
    select, input[type=text], input[type=number] { width:100%; box-sizing:border-box; padding:8px; border-radius:6px; border:1px solid var(--yt-spec-10-percent-layer,#444); background:var(--yt-spec-general-background-a,#121212); color:var(--yt-spec-text-primary,#f1f1f1); font:inherit; }
    select:disabled { opacity:.5; }
    .hint { font-size:12px; color:var(--yt-spec-text-secondary,#aaa); margin-top:6px; }
    label.check { display:flex; align-items:center; gap:8px; color:var(--yt-spec-text-primary,#f1f1f1); font-size:13px; margin:14px 0 0; }
    label.check input { margin:0; }
    .error { font-size:12px; color:#f28b82; margin-top:6px; }
    .error a { color:var(--yt-spec-call-to-action,#3ea6ff); }
    .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
    button { font:inherit; border:0; border-radius:18px; padding:8px 16px; cursor:pointer; }
    .cancel { background:transparent; color:var(--yt-spec-text-primary,#f1f1f1); }
    .add { background:var(--yt-spec-call-to-action,#3ea6ff); color:var(--yt-spec-text-primary-inverse,#0f0f0f); font-weight:500; }
    /* .busy sits after [hidden] in this sheet and matches with the same
       specificity, so it needs its own hidden guard to stay hideable. */
    .busy[hidden] { display:none; }
    .busy { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--yt-spec-text-secondary,#aaa); margin-top:12px; }
    .busy::before { content:''; width:10px; height:10px; box-sizing:border-box; border:2px solid var(--yt-spec-10-percent-layer,#444); border-top-color:var(--yt-spec-call-to-action,#3ea6ff); border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
  `;
  shadow.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';

  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h2');
  heading.textContent =
    subject.limitDefault !== undefined
      ? 'Add channel videos'
      : subject.videos.length === 1
        ? 'Add this video'
        : `Add ${subject.videos.length} videos`;
  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  subtitle.textContent = subject.countLabel;
  // Surface the remaining quota up front for the flows that are actually
  // bulk (or might turn out to be, once resolve() runs) — a single-video
  // dialog is always free and unmetered, so it stays silent.
  // A watch-page dialog is silent about the quota until the comments box is
  // actually ticked (the metering note under the checkbox carries that rule) —
  // unticked it is one source, always free.
  const isBulkDialog = subject.videos.length > 1 || subject.limitDefault !== undefined;
  if (isBulkDialog && !(await isPro())) {
    const left = await trialRemaining();
    subtitle.textContent += ` (Free — ${left} of ${FREE_QUOTA} imports left this month)`;
  }
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

  // Only the channel harvest sets limitDefault; the count is not known yet
  // at dialog-open time (it's resolved on Add), so this replaces the fixed
  // "N videos" heading with an editable field instead.
  const limitLabel = document.createElement('label');
  const limitInput = document.createElement('input');
  if (subject.limitDefault !== undefined) {
    limitLabel.textContent = 'Add latest N videos';
    limitInput.type = 'number';
    limitInput.min = '1';
    limitInput.value = String(subject.limitDefault);
    card.append(limitLabel, limitInput);
  }

  // Watch page only: the comments of this video as one extra .md source.
  const commentsCheck = document.createElement('input');
  commentsCheck.type = 'checkbox';
  const commentsLimit = document.createElement('input');
  commentsLimit.type = 'number';
  commentsLimit.min = '1';
  if (subject.comments) {
    const checkRow = document.createElement('label');
    checkRow.className = 'check';
    checkRow.append(commentsCheck, document.createTextNode('Also add comments as a text source'));
    const commentsLimitLabel = document.createElement('label');
    commentsLimitLabel.textContent = 'Top N comments';
    commentsLimit.value = String(subject.comments.limitDefault);
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'Comments come in as a second source — more than one source per action is metered.';
    card.append(checkRow, commentsLimitLabel, commentsLimit, note);
    const syncCommentsFields = (): void => {
      commentsLimitLabel.hidden = !commentsCheck.checked;
      commentsLimit.hidden = !commentsCheck.checked;
    };
    commentsCheck.addEventListener('change', syncCommentsFields);
    syncCommentsFields();
  }

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

      errorLine.hidden = true;
      addBtn.disabled = true;
      try {
        const limit = subject.limitDefault !== undefined ? Math.max(1, Number(limitInput.value) || subject.limitDefault) : 0;
        // resolve() (channel harvest) can take a while and may throw (e.g.
        // no Videos tab found) — caught below and shown inline instead of
        // silently dropping the dialog.
        const videos = subject.resolve ? await subject.resolve(limit) : subject.videos;

        // Single funnel for the gate: this is the first point on every path
        // (watch page, watch-page playlist panel, playlist page, channel
        // harvest) that knows the real source count — the channel harvest in
        // particular only learns it here, after resolve() runs. One source
        // stays free and unmetered, matching the popup's rule; the comments
        // file counts as a source like any video does.
        const wantComments = !!subject.comments && commentsCheck.checked;
        const count = videos.length + (wantComments ? 1 : 0);
        if (count > 1 && !(await isPro()) && (await trialRemaining()) === 0) {
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
          return;
        }

        if (count === 0) {
          addBtn.disabled = false;
          return;
        }

        // Harvested after the gate, before anything is written: the scroll
        // loop can take a minute and can throw (comments off), and neither a
        // slow nor a failed harvest may spend a quota unit.
        let file: { filename: string; markdown: string } | undefined;
        if (wantComments && subject.comments) {
          const label = addBtn.textContent;
          addBtn.textContent = 'Comments…';
          busyLine.textContent = 'Collecting comments… (up to two minutes)';
          busyLine.hidden = false;
          try {
            const limitValue = Math.max(1, Number(commentsLimit.value) || subject.comments.limitDefault);
            file = await subject.comments.resolve(limitValue);
          } finally {
            busyLine.hidden = true;
            addBtn.textContent = label;
          }
        }

        // Same contract as popup.ts:btnAddYoutube — the notebook tab's content
        // script (uploader.ts) auto-runs runYoutubeJob on load and reports
        // progress with its own toast; duplicates are skipped there.
        await chrome.storage.local.set({
          youtubeJob: {
            type: 'ADD_YOUTUBE',
            videos,
            createdAt: Date.now(),
            ...(file ? { file } : {}),
            ...(createNew ? { createTitle } : { targetNotebookId: select.value }),
          },
        });
        // Unlike the popup's YouTube path (chrome.tabs.create kills the popup
        // context, DECISIONS.md #15), a content script survives window.open, so
        // the honest check-then-commit order works here: spend only after
        // the job is actually written to storage.
        if (count > 1) await noteTrialUse();
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

  // Shadow DOM retargets events: outside the shadow tree, e.target for a key
  // typed in titleInput reads as `dialogHost`, not the input, so YouTube's
  // own hotkey listeners (f/k/space/j/l on document/ytd-app) never see the
  // real target either — they just see "some element" and fire anyway.
  // window capture runs before those listeners in the DOM tree, so
  // stopPropagation() here reliably keeps the key from ever reaching them.
  // composedPath() (not e.target) is what actually still exposes the input
  // for the `includes(host)` check.
  // Escape closes regardless of where the key landed: nothing inside the
  // dialog is focused until the user clicks a field, and Escape used to work
  // from the page before this handler existed.
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

// Text nodes joined by a separator, not root.textContent: textContent
// concatenates adjacent text nodes with nothing between them, so a header
// counter like "1 / 5" immediately followed by the first list item's index
// "1" fuses into "1 / 51" and the regex below reads a bogus total of 51.
function textLines(root: ParentNode): string {
  const el = root instanceof Element ? root : document.body;
  if (!el) return '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? '');
  return parts.join('\n');
}

// Playlist total, when readable from the page — the watch-page panel shows
// it as "2 / 9", the playlist page header as "9 videos". Best effort only:
// if it can't be read, the dialog just shows the loaded count. The caller
// passes the smallest element that contains the counter, never the whole
// page: any "n / m" or "n videos" elsewhere on the page would be read as a
// total and produce a bogus "scroll to load the rest" warning.
function playlistTotalHint(loaded: number, root: ParentNode): string {
  const text = textLines(root);
  const match = text.match(/\d+\s*\/\s*([\d,]+)/) ?? text.match(/([\d,]+)\s+videos?/i);
  const total = match ? Number(match[1].replace(/,/g, '')) : null;
  if (total && total > loaded) {
    return `${loaded} of ${total} loaded — scroll the page to load the rest`;
  }
  return loaded === 1 ? '1 video' : `${loaded} videos`;
}

// ---- comment harvest (watch page) ------------------------------------------

// Replies are expanded (expandReplies below), but only as far as
// REPLIES_WALL_CLOCK_MS allows — a thread with hundreds of replies behind
// repeated "Show more replies" clicks stops mid-way. Partial is deliberate:
// a truncated thread beats a harvest that never returns.
function readComment(el: Element): YoutubeComment | null {
  const author = el.querySelector('#author-text')?.textContent?.trim();
  const text = el.querySelector('#content-text')?.textContent?.trim();
  if (!author || !text) return null;
  return { author, text, likes: el.querySelector('#vote-count-middle')?.textContent?.trim() || undefined };
}

// YouTube re-appends an already-delivered page when an exhausted continuation
// is clicked again, so a reply's identity is its content, not its node.
function replyKey(el: Element): string | null {
  const c = readComment(el);
  return c && `${c.author}|${c.text}`;
}

// Top-level threads only. In the current markup every expanded reply is
// itself a nested `ytd-comment-thread-renderer is-sub-thread` inside the
// parent's #replies, so a flat querySelectorAll would list each reply twice:
// once under its parent and once as a bogus top-level thread. Nesting is
// tested structurally, not by the attribute, so a rename can't undo it.
function topLevelThreads(box: ParentNode): Element[] {
  return [...box.querySelectorAll('ytd-comment-thread-renderer')].filter(
    (t) => !t.parentElement?.closest('ytd-comment-thread-renderer'),
  );
}

export function collectCommentThreads(box: ParentNode): YoutubeComment[] {
  const out: YoutubeComment[] = [];
  for (const thread of topLevelThreads(box)) {
    // querySelector = the thread's own comment: the top comment precedes
    // #replies in DOM order, so the first match is never a reply.
    const top = readComment(thread);
    if (!top) continue;
    // A reused, exhausted pagination button re-appends its already-delivered
    // page (see replyKey above), so dedupe by content, keeping first-seen
    // order — this is what keeps the generated .md free of repeats
    // regardless of how many duplicate nodes the DOM ends up holding.
    const seen = new Set<string>();
    const replies: YoutubeComment[] = [];
    for (const node of thread.querySelectorAll(REPLY_SEL)) {
      const key = replyKey(node);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const c = readComment(node);
      if (c) replies.push(c);
    }
    out.push(replies.length > 0 ? { ...top, replies } : top);
  }
  return out;
}

// Reply nodes, scoped so the thread's own comment can never match. #replies is
// the current markup; the renderer tag is the fallback for the older one.
const REPLY_SEL =
  '#replies ytd-comment-view-model, #replies ytd-comment-renderer, ' +
  'ytd-comment-replies-renderer ytd-comment-view-model, ytd-comment-replies-renderer ytd-comment-renderer';
// "N replies" toggle: #more-replies-sub-thread is the Dec-2025 markup, and the
// old #more-replies is still in the DOM next to it under a hidden #expander —
// both are wired to the same toggle, so clicking both expands and collapses
// again (collapsedToggle takes the one rendered button per block). Collapsed
// vs expanded is decided by rendering, not by aria-expanded: on the live
// markup the sub-thread button carries aria-expanded="true" while still
// collapsed and flips to "false" once open (inverted), and a click hides the
// button itself (#collapsed-threads gets `hidden`) — so "a rendered toggle" is
// exactly "a block still to open". Each block is clicked at most once per
// harvest anyway (`clicked` in expandReplies): a second click would fold a
// block that merely hasn't finished loading.
const MORE_REPLIES_SEL = '#more-replies, #more-replies-sub-thread';
// "Show more replies" inside an already-open reply block. The renderer also
// sits there as an invisible spinner placeholder (display:none, no button), so
// match the actual button, not the renderer.
const MORE_REPLIES_PAGE_SEL = 'ytd-comment-replies-renderer ytd-continuation-item-renderer #button:not([hidden]) button';
const REPLY_NODE_SEL = 'ytd-comment-view-model, ytd-comment-renderer';
// The click on "N replies" only *requests* them: YouTube swaps the button for
// this continuation, which fetches on viewport intersection. Scrolling it into
// view is what actually loads the replies — measured ~200 ms after the scroll.
const REPLIES_CONTINUATION_SEL = 'ytd-continuation-item-renderer';

function clickAll(els: Iterable<Element>): void {
  for (const el of els) {
    if (el.closest('[hidden]')) continue;
    (el.querySelector<HTMLElement>('button, tp-yt-paper-button, yt-button-shape') ?? (el as HTMLElement)).click();
  }
}

export function collapsedToggle(renderer: ParentNode): Element | null {
  return firstRendered(renderer.querySelectorAll(MORE_REPLIES_SEL));
}

// A reply block ("ytd-comment-replies-renderer" with no comment loaded yet)
// that has never been asked for its replies, and every block that has but
// hasn't loaded them. `empty` in the old code required a still-rendered
// toggle to count as pending, which is exactly wrong: the toggle disappears
// the moment it's clicked, well before the replies arrive, so a clicked block
// with a spinner still in it used to fall out of every future round and the
// 60 s budget was abandoned with the work undone.
export function pendingReplyBlocks(threads: Element[]): Element[] {
  return threads
    .flatMap((t) => [...t.querySelectorAll('ytd-comment-replies-renderer')])
    .filter((r) => !r.querySelector(REPLY_NODE_SEL));
}

// Clicking an exhausted continuation re-appends its already-delivered page
// (see replyKey), and those nodes stay on the page after the harvest — the
// user sees the same reply three times and reasonably reads it as damage we
// did. Drop the repeats, keeping the first occurrence.
export function dedupeReplyNodes(threads: Element[]): number {
  let removed = 0;
  for (const thread of threads) {
    const seen = new Set<string>();
    for (const node of thread.querySelectorAll(REPLY_SEL)) {
      const key = replyKey(node);
      if (!key) continue;
      if (!seen.has(key)) {
        seen.add(key);
        continue;
      }
      // Every expanded reply is wrapped in its own sub-thread renderer;
      // dropping only the view-model would leave an empty box behind.
      const sub = node.closest('ytd-comment-thread-renderer');
      (sub && sub !== thread ? sub : node).remove();
      removed++;
    }
  }
  return removed;
}

// Opens every collapsed reply block in `threads` (nested reply-to-reply blocks
// included) and keeps clicking "Show more replies" until nothing grows, the
// continuations run out, or `deadline` hits.
//
// A reply block only fetches once it is on screen (the continuation renderer
// inside it watches for intersection), and the click itself is instant — so
// each round is two passes, not one: first click every still-collapsed
// toggle (no waiting), then walk the pending blocks scrolling each one's
// continuation into view and giving it a moment to fill in. Clicking a block
// and immediately scrolling to the next one, in the same pass, was the bug:
// it pushed the just-opened continuation off screen before it could fire, and
// 16 of 18 clicked blocks were left stuck on a spinner.
async function expandReplies(threads: Element[], deadline: number): Promise<void> {
  // Node count keeps growing every round even after the real replies run out
  // (a reused, exhausted pagination button re-appends its last page — see
  // replyKey), so progress has to be measured by unique content, not nodes.
  const countReplies = (): number =>
    new Set(threads.flatMap((t) => [...t.querySelectorAll(REPLY_SEL)]).map(replyKey).filter(Boolean)).size;
  const until = async (ok: () => boolean, ms: number): Promise<void> => {
    const end = Math.min(Date.now() + ms, deadline);
    while (Date.now() < end && !ok()) await sleep(150);
  };

  let count = countReplies();
  let stalls = 0;
  const clicked = new WeakSet<Element>();
  while (Date.now() < deadline && stalls < 2) {
    const pending = pendingReplyBlocks(threads);
    const pages = threads.flatMap((t) => [...t.querySelectorAll(MORE_REPLIES_PAGE_SEL)]);
    if (pending.length === 0 && pages.length === 0) break;

    // Request phase: fire every unclicked toggle first. This only swaps the
    // button for a continuation — nothing loads yet, so no waiting here.
    for (const r of pending) {
      const toggle = collapsedToggle(r);
      if (toggle && !clicked.has(r)) {
        clicked.add(r);
        clickAll([toggle]);
      }
    }

    for (const page of pages) page.scrollIntoView({ block: 'center' });
    clickAll(pages);

    // Load phase: scroll each pending block's continuation into view so its
    // intersection observer actually fires, then give it a moment to fill in.
    for (const r of pending) {
      if (Date.now() >= deadline) break;
      (r.querySelector(REPLIES_CONTINUATION_SEL) ?? collapsedToggle(r) ?? r).scrollIntoView({ block: 'center' });
      await until(() => !!r.querySelector(REPLY_NODE_SEL), 1500);
    }
    if (pages.length > 0) await until(() => countReplies() > count, 3000);

    const grown = countReplies();
    stalls = grown > count ? 0 : stalls + 1;
    count = grown;
  }
}

const COMMENTS_WALL_CLOCK_MS = 60_000;
// On top of COMMENTS_WALL_CLOCK_MS, not inside it: scrolling for threads and
// expanding their replies are two independent stalls, and one eating the
// other's budget would silently drop half the harvest.
const REPLIES_WALL_CLOCK_MS = 60_000;

// Same scroll-until-stall loop as harvestChannelVideos, on the comments
// section instead of the video grid.
async function harvestComments(limit: number): Promise<YoutubeComment[]> {
  const box = queryRendered<HTMLElement>('ytd-comments#comments') ?? queryRendered<HTMLElement>('ytd-comments');
  if (!box) throw new Error('No comments section on this page');
  // Comments are rendered lazily: nothing exists in the DOM until the section
  // comes near the viewport, so the first scroll is what creates the threads.
  box.scrollIntoView({ block: 'center' });

  let comments: YoutubeComment[] = [];
  let stalls = 0;
  const deadline = Date.now() + COMMENTS_WALL_CLOCK_MS;

  while (Date.now() < deadline) {
    const prev = comments.length;
    // The thread-list sentinel, not a "Show more replies" continuation inside
    // an already-open reply block (the user may have opened one by hand).
    const sentinel = [...box.querySelectorAll('ytd-continuation-item-renderer')].find(
      (el) => !el.closest('ytd-comment-replies-renderer'),
    );
    (sentinel ?? box).scrollIntoView({ block: 'center' });
    const before = topLevelThreads(box).length;
    const pollDeadline = Date.now() + 3000;
    while (Date.now() < pollDeadline && topLevelThreads(box).length <= before) {
      await sleep(250);
    }
    // Threads are not recycled out of the DOM the way grid rows are, so a
    // straight re-read is enough here (no cross-round accumulation needed).
    comments = collectCommentThreads(box);
    const current = comments.length;
    stalls = current > prev ? 0 : stalls + 1;
    if (harvestDone(prev, current, stalls, limit)) break;
  }

  if (comments.length === 0) throw new Error('No comments found (they may be turned off)');

  // Only the threads that will actually be kept — expanding the tail below the
  // limit would spend the reply budget on text nobody gets.
  const kept = topLevelThreads(box).slice(0, limit);
  await expandReplies(kept, Date.now() + REPLIES_WALL_CLOCK_MS);
  dedupeReplyNodes(kept);
  return collectCommentThreads(box).slice(0, limit);
}

// The whole comments source, filename included — same title source as
// ensureWatchButton, so the popup can ask for it without knowing the page.
export async function harvestCommentsFile(limit: number): Promise<{ filename: string; markdown: string }> {
  const video = currentPageVideo();
  if (!video) throw new Error('Not a YouTube watch page');
  try {
    return {
      filename: `[youtube]-comments-${slugify(video.title)}.md`,
      markdown: commentsToMarkdown(video.title, video.url, await harvestComments(limit)),
    };
  } finally {
    // The harvest leaves the page a thousand comments down; on a watch page
    // the player is at the top, and coming back to it is what makes the run
    // look finished rather than lost.
    (document.scrollingElement ?? document.documentElement).scrollTop = 0;
  }
}

// ---- injection: watch page actions row ------------------------------------

function findWatchAnchor(): HTMLElement | null {
  return (
    queryRendered<HTMLElement>('#top-level-buttons-computed') ??
    queryRendered<HTMLElement>('like-button-view-model, segmented-like-dislike-button-view-model')?.parentElement ??
    queryRendered<HTMLElement>('ytd-watch-metadata #actions')
  );
}

function ensureWatchButton(): void {
  if (!location.pathname.startsWith('/watch')) return;
  const anchor = findWatchAnchor();
  if (!anchor) return;
  if (!claimSlot('[data-source-lm-watch-btn]')) return;

  const btn = buildButton('Add to notebook', false);
  btn.dataset.sourceLmWatchBtn = '1';
  btn.addEventListener('click', () => {
    const video = currentPageVideo();
    if (!video) return;
    void openDialog({
      videos: [video],
      countLabel: '1 video',
      comments: { limitDefault: 100, resolve: harvestCommentsFile },
    });
  });

  if (anchor.id === 'top-level-buttons-computed') {
    anchor.insertBefore(btn, anchor.firstChild);
  } else {
    anchor.appendChild(btn);
  }
}

// ---- injection: watch-page playlist panel ---------------------------------

const SHUFFLE_RE = /shuffle|перемешать/i;

// Loop and shuffle live *inside* #playlist-action-menu together with the
// overflow "⋮", so inserting before that element puts the button left of the
// whole group. Anchor on shuffle itself to land between shuffle and "⋮".
function findPanelShuffleButton(panel: HTMLElement): HTMLElement | null {
  for (const b of panel.querySelectorAll<HTMLElement>('button, yt-icon-button')) {
    if (SHUFFLE_RE.test(b.getAttribute('aria-label') || b.title || '')) return b;
  }
  return null;
}

function ensurePlaylistPanelButton(): void {
  const panel = queryRendered<HTMLElement>('ytd-playlist-panel-renderer');
  if (!panel) return;
  if (!claimSlot('[data-source-lm-panel-btn]')) return;

  const shuffleAnchor = findPanelShuffleButton(panel);
  const menuAnchor = panel.querySelector<HTMLElement>('#playlist-action-menu');
  const headerButtons = panel.querySelectorAll('button');
  const lastHeaderButton = headerButtons.length > 0 ? (headerButtons[headerButtons.length - 1] as HTMLElement) : null;
  if (!shuffleAnchor && !menuAnchor && !lastHeaderButton) return;

  const btn = buildButton('Add to Notebook', false);
  btn.style.setProperty('margin-left', '8px', 'important');
  btn.dataset.sourceLmPanelBtn = '1';
  btn.addEventListener('click', () => {
    const videos = collectVideos(panel);
    void openDialog({ videos, countLabel: playlistTotalHint(videos.length, panel) });
  });

  if (shuffleAnchor) {
    shuffleAnchor.insertAdjacentElement('afterend', btn);
  } else if (menuAnchor) {
    menuAnchor.insertAdjacentElement('beforebegin', btn);
  } else if (lastHeaderButton) {
    lastHeaderButton.insertAdjacentElement('afterend', btn);
  }
}

// YouTube wraps each of its own items in `yt-flexible-actions-view-model` in
// a per-cell div (generated class `ytFlexibleActionsViewModelAction`); a
// bare-child append misses that box and sits off-baseline from Subscribe
// (row 40px, our pill 36px). Cloning a sibling's className is layout
// mimicry, not a selector (DECISIONS.md #5 forbids *selecting* by generated
// class) — degrades to a plain append if the row has no children yet.
// Returns the element the button actually landed in (wrapper cell, or the
// button itself), so callers can place margin on the right box.
function appendToActionsRow(row: HTMLElement, btn: HTMLButtonElement): HTMLElement {
  // stylePillButton's margin-right is for rows where the button is a bare
  // sibling; inside a cell the row's own gap already spaces it.
  btn.style.setProperty('margin-right', '0', 'important');
  const template = row.firstElementChild;
  if (template) {
    const cell = document.createElement('div');
    cell.className = template.className;
    // align-self belongs on the flex item of the row — that is the cell, not
    // the button inside it. The cell is also forced to center its own child,
    // since YouTube's action cells are as tall as the tallest action (40px)
    // and our pill is 36px.
    cell.style.cssText = 'align-self:center !important;display:flex !important;align-items:center !important';
    cell.appendChild(btn);
    row.appendChild(cell);
    return cell;
  }
  btn.style.setProperty('align-self', 'center', 'important');
  row.appendChild(btn);
  return btn;
}

// ---- injection: playlist page header actions row ---------------------------

const PLAY_ALL_RE = /play all|воспроизвести все/i;

function findPlaylistPageAnchor(): HTMLElement | null {
  const row = queryRendered<HTMLElement>('yt-flexible-actions-view-model');
  if (row) return row;

  const buttons = document.querySelectorAll<HTMLElement>('button, a');
  for (const b of buttons) {
    if (b.getClientRects().length === 0) continue;
    const aria = b.getAttribute('aria-label') || b.textContent || '';
    if (PLAY_ALL_RE.test(aria)) return b.parentElement;
  }
  return null;
}

function ensurePlaylistPageButton(): void {
  if (!location.pathname.startsWith('/playlist')) return;
  const anchor = findPlaylistPageAnchor();
  if (!anchor) return;
  if (!claimSlot('[data-source-lm-playlist-btn]')) return;

  const btn = buildButton('Add to notebook', false);
  btn.dataset.sourceLmPlaylistBtn = '1';
  btn.addEventListener('click', () => {
    // document.querySelector alone would pick up ytd-search's own
    // ytd-item-section-renderer if a search page is still in the DOM
    // (querySelector returns the first in creation order) — scope to the
    // page that's actually visible first.
    const page = visiblePageRoot();
    const videos = collectVideos(page.querySelector('ytd-item-section-renderer') ?? page);
    const header = document.querySelector('yt-page-header-renderer') ?? anchor;
    void openDialog({ videos, countLabel: playlistTotalHint(videos.length, header) });
  });

  appendToActionsRow(anchor, btn);
}

// ---- injection: channel page (Videos tab harvest) --------------------------

const SUBSCRIBE_RE = /subscribe|подписаться/i;

function findSubscribeButton(): HTMLElement | null {
  return (
    queryRendered<HTMLElement>('subscribe-button-view-model') ??
    queryRendered<HTMLElement>('ytd-subscribe-button-renderer') ??
    firstRendered([...document.querySelectorAll<HTMLElement>('button')].filter((b) => SUBSCRIBE_RE.test(b.getAttribute('aria-label') || '')))
  );
}

// Never insert *inside* `yt-subscribe-button-view-model` (the parent of
// `subscribe-button-view-model`): it flex-sizes its own children within a cell
// as wide as Subscribe, so a `flex-shrink:0` sibling makes Subscribe absorb
// all the shrink and collapse to a bare circle with no label.
function findChannelAnchor(): { host: HTMLElement; append: boolean } | null {
  // Same header actions row `findPlaylistPageAnchor()` targets — the channel
  // header uses that component too.
  const row = queryRendered<HTMLElement>('yt-flexible-actions-view-model');
  if (row) return { host: row, append: true };

  // Fallback: Subscribe's own action cell (nearest ancestor div, tag-based —
  // DECISIONS.md #5), so we land as its sibling, not as its child.
  const cell = findSubscribeButton()?.closest('div');
  return cell ? { host: cell, append: false } : null;
}

const VIDEOS_TAB_RE = /^(videos|видео)$/i;

// True when a tab strip label is exactly "Videos" (English or Russian
// locale), not merely containing that word (e.g. "Popular videos").
export function isVideosTabLabel(text: string): boolean {
  return VIDEOS_TAB_RE.test(text.trim());
}

// The Videos tab anchor has no stable id/aria-label across YouTube's header
// layouts; href is the one thing that doesn't change with a redesign. But
// the newer channel tab strip (yt-tab-group-shape / yt-tab-shape) renders
// tabs with no href at all, so fall back to matching the tab's own text —
// same rule as other Google UI selectors here (DECISIONS.md #5): match by
// textContent/aria, never CSS classes. The Russian label is a locale
// selector, not a translation — keep it.
function findVideosTabAnchor(): HTMLElement | null {
  const byHref = queryRendered<HTMLElement>('a[href$="/videos"]');
  if (byHref) return byHref;
  const tabs = document.querySelectorAll<HTMLElement>('yt-tab-shape, [role="tab"]');
  for (const tab of tabs) {
    if (tab.getClientRects().length === 0) continue;
    if (isVideosTabLabel(tab.textContent ?? '')) return tab;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForVideosGrid(): Promise<HTMLElement | null> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const grid = queryRendered<HTMLElement>('ytd-rich-grid-renderer');
    if (grid) return grid;
    await sleep(250);
  }
  return null;
}

const HARVEST_WALL_CLOCK_MS = 90_000;

async function harvestChannelVideos(limit: number, btn: HTMLButtonElement): Promise<VideoItem[]> {
  if (!location.pathname.endsWith('/videos')) {
    const tab = findVideosTabAnchor();
    if (!tab) throw new Error("Open the channel's Videos tab first");
    // SPA navigation, not location.href — a full reload would kill this
    // in-flight harvest along with the content script's pending promise.
    tab.click();
    // Wait for the SPA to actually land on the Videos tab before looking
    // for the grid: the channel Home page also renders a rich grid (the
    // "For You" shelf), so grabbing the grid right after the click can
    // harvest that stale Home content instead.
    const navDeadline = Date.now() + 5000;
    while (Date.now() < navDeadline && !location.pathname.endsWith('/videos')) {
      await sleep(250);
    }
    if (!location.pathname.endsWith('/videos')) {
      throw new Error("Open the channel's Videos tab first");
    }
  }

  const grid = await waitForVideosGrid();
  if (!grid) throw new Error("Open the channel's Videos tab first");

  const originalLabel = btn.textContent;
  btn.disabled = true;
  try {
    let collected: VideoItem[] = [];
    let stalls = 0;
    const deadline = Date.now() + HARVEST_WALL_CLOCK_MS;

    while (Date.now() < deadline) {
      const prev = collected.length;
      // Scroll the continuation sentinel into view, not the page bottom: it
      // is the exact element whose visibility triggers YouTube's next lazy
      // batch, and this works regardless of which ancestor actually scrolls.
      const sentinel = grid.querySelector('ytd-continuation-item-renderer');
      if (sentinel) {
        sentinel.scrollIntoView({ block: 'center' });
      } else {
        (document.scrollingElement ?? document.documentElement).scrollTop = 1e7;
      }
      // Poll for new anchors instead of a flat delay: returns as soon as the
      // new batch actually renders, caps at ~3s if nothing more loads.
      const anchorsBefore = grid.querySelectorAll('a[href*="/watch?v="]').length;
      const pollDeadline = Date.now() + 3000;
      while (Date.now() < pollDeadline && grid.querySelectorAll('a[href*="/watch?v="]').length <= anchorsBefore) {
        await sleep(250);
      }
      // Accumulate across rounds instead of one final collectVideos: survives
      // YouTube recycling grid rows out of the DOM as the page scrolls.
      collected = dedupeVideos([...collected, ...collectVideos(grid)]);
      const current = collected.length;
      stalls = current > prev ? 0 : stalls + 1;
      btn.textContent = `Collecting ${current}…`;
      if (harvestDone(prev, current, stalls, limit)) break;
    }

    return collected.slice(0, limit);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function ensureChannelButton(): void {
  if (!isChannelPage(location.pathname)) return;
  const anchor = findChannelAnchor();
  if (!anchor) return;
  // Document-wide, not per-parent: the anchor's host can differ between SPA
  // renders (flexible-actions row vs. Subscribe's action cell), so a
  // per-parent check would miss an already-injected button under the other
  // host and inject a second one.
  if (!claimSlot('[data-source-lm-channel-btn]')) return;

  const btn = buildButton('Add to notebook', false);
  btn.dataset.sourceLmChannelBtn = '1';
  // Our pill must shrink before YouTube's own controls do (see
  // findChannelAnchor's comment); stylePillButton gives non-icon buttons a
  // margin-right, but this one sits to the right of Subscribe, so the gap
  // belongs on the left.
  btn.style.setProperty('flex-shrink', '1', 'important');
  // Pill height is not one number across YouTube: the channel header runs 40px
  // while the watch page runs the 36 stylePillButton hardcodes. Copy the
  // neighbour instead of guessing, and fall back to 36 when Subscribe isn't
  // measurable (hidden header, own channel — no Subscribe button at all).
  const neighbourHeight = findSubscribeButton()?.offsetHeight ?? 0;
  if (neighbourHeight > 0) {
    btn.style.setProperty('height', `${neighbourHeight}px`, 'important');
    btn.style.setProperty('line-height', `${neighbourHeight}px`, 'important');
    btn.style.setProperty('border-radius', `${neighbourHeight / 2}px`, 'important');
  }
  btn.addEventListener('click', () => {
    void openDialog({
      videos: [],
      countLabel: 'from the Videos tab',
      limitDefault: 50,
      resolve: (limit) => harvestChannelVideos(limit, btn),
    });
  });

  if (anchor.append) {
    // Margin goes on the wrapper cell appendToActionsRow creates, not the
    // button: the row already has its own gap, so a margin on the button
    // itself would double up on it.
    appendToActionsRow(anchor.host, btn).style.setProperty('margin-left', '8px', 'important');
  } else {
    btn.style.setProperty('margin-left', '8px', 'important');
    anchor.host.insertAdjacentElement('afterend', btn);
  }
}

// ---- entry point -----------------------------------------------------------

function ensureButtons(): void {
  ensureWatchButton();
  ensurePlaylistPanelButton();
  ensurePlaylistPageButton();
  ensureChannelButton();
}

// 2s polling instead of a routed MutationObserver — same trade-off
// as delete-ui.ts:installDeleteButton; it also covers YouTube's SPA
// navigation (watch -> playlist -> watch) for free, since ensureButtons() is
// idempotent (each injector checks for its own marker attribute first).
export function installYoutubeButtons(): void {
  ensureButtons();
  setInterval(ensureButtons, 2000);
}
