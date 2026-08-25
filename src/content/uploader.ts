// Content script that lives on the notebooklm.google.com page and owns the
// entire upload queue (see README "If upload doesn't work" / architecture
// notes in spec.md §8 — the queue lives here, not in a service worker,
// because an SW dies after ~30s of idle while this page lives for the whole
// session).
//
// The selectors below match by textContent/aria-label, NEVER by CSS classes:
// NotebookLM is an Angular app, its generated classes (like
// `.mat-mdc-button-abc123`) change between releases without notice, while
// the text a user sees on a button is a far more stable contract.
//
// If NotebookLM switches to the File System Access API (`showOpenFilePicker`)
// instead of `<input type=file>` — the entire ladder below (DataTransfer +
// drag&drop) will stop working entirely: `showOpenFilePicker` requires a
// user gesture inside the call and opens a native OS dialog that a script
// cannot fill in. The only fix is Plan C from the README (Google's private
// batchexecute RPC, bypassing the DOM entirely).

import { callRpc, RpcError } from './rpc';
import { listNotebooks, listSourceNames, runYoutubeJob, type JobProgressMessage } from './notebook';
import { installDeleteButton } from './delete-ui';
import { installSourcesUi } from './sources-ui';

type UploadFile = { filename: string; markdown: string };

type IncomingMessage =
  | { type: 'UPLOAD'; batchSize: number }
  | { type: 'UPLOAD_CHUNK'; files: UploadFile[] }
  | { type: 'UPLOAD_CONTINUE' }
  | { type: 'GET_NOTEBOOKS' }
  | { type: 'GET_SOURCE_NAMES' };

type OutgoingMessage =
  | { type: 'UPLOAD_PROGRESS'; done: number; total: number; current?: string }
  | { type: 'UPLOAD_ERROR'; message: string; filename?: string }
  | { type: 'UPLOAD_DONE'; uploaded: number; failed: number; unconfirmed?: number; skipped?: number }
  | { type: 'UPLOAD_NEEDS_CONFIRM'; message: string };

const ADD_SOURCE_RE = /add source|добавить источник|new source|создать источник|\+\s*(source|источник)/i;
const DROP_ZONE_RE = /drag.{0,10}drop|drop.{0,10}file|перетащ/i;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function send(message: OutgoingMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // the popup may have closed — not an upload error, just nobody listening
  });
}

// On-page progress for the YouTube job: that path always loses its popup
// (adding to a notebook switches the active tab, which closes it), so
// send() alone reaches nobody. Styling is set inline on the element only —
// no <style> tag, no stylesheet: NotebookLM's Angular CSS must not be able
// to reach this element, nor ours theirs.
let toastEl: HTMLDivElement | null = null;
let toastHideId = 0;

export function showJobToast(message: string, final = false): void {
  if (!document.body) return;

  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'max-width:360px',
      'padding:12px 40px 12px 14px',
      'border-radius:10px',
      'background:#202124',
      'color:#e8eaed',
      'font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)',
      'white-space:pre-wrap',
      'pointer-events:auto',
    ].join(';');

    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.style.cssText = [
      'position:absolute',
      'top:4px',
      'right:6px',
      'border:0',
      'background:transparent',
      'color:inherit',
      'font-size:18px',
      'line-height:1',
      'cursor:pointer',
    ].join(';');
    close.addEventListener('click', () => toastEl?.remove());

    const text = document.createElement('span');
    toastEl.append(text, close);
    document.body.appendChild(toastEl);
  }

  if (!toastEl.isConnected) document.body.appendChild(toastEl);
  // Every non-final toast is in-progress work that dies with the tab.
  (toastEl.firstChild as HTMLElement).textContent = final
    ? message
    : `${message}\nKeep this tab open until it finishes, or it will be interrupted.`;

  clearTimeout(toastHideId);
  if (final) {
    toastHideId = window.setTimeout(() => toastEl?.remove(), 8000);
  }
}

// Step 0: recursively walk the DOM + shadow DOM (Angular Material often
// renders there) looking for input[type=file].
function findFileInput(root: ParentNode): HTMLInputElement | null {
  const direct = root.querySelector('input[type=file]');
  if (direct) return direct as HTMLInputElement;

  const all = root.querySelectorAll('*');
  for (const el of all) {
    if (el.shadowRoot) {
      const found = findFileInput(el.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

// MutationObserver + a 200ms polling safety net — in case the target element
// appears outside the observed subtree or the observer doesn't fire
// synchronously.
export function waitFor<T>(fn: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const immediate = fn();
    if (immediate) {
      resolve(immediate);
      return;
    }

    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(pollId);
      clearTimeout(timeoutId);
      resolve(value);
    };

    const check = () => {
      const result = fn();
      if (result) finish(result);
    };

    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });

    const pollId = setInterval(check, 200);
    const timeoutId = setTimeout(() => finish(null), timeoutMs);
  });
}

// Step 1: the "Add source" button — matched by visible text, not by classes.
function findAddSourceButton(): HTMLElement | null {
  const candidates = document.querySelectorAll('button, [role=button], a');
  for (const el of candidates) {
    const text = (el.textContent || '').trim();
    const aria = el.getAttribute('aria-label') || '';
    if (ADD_SOURCE_RE.test(text) || ADD_SOURCE_RE.test(aria)) {
      return el as HTMLElement;
    }
  }
  return null;
}

// Step 2: injection via DataTransfer, verifying the assignment actually
// took effect (some browsers/pages silently ignore input.files = ...).
function injectViaDataTransfer(input: HTMLInputElement, files: File[]): boolean {
  try {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length > 0;
  } catch {
    return false;
  }
}

// Step 3: drag&drop fallback — look for a zone with drag&drop text,
// otherwise the input's parent, otherwise the whole body.
function findDropZone(input: HTMLInputElement | null): HTMLElement {
  const candidates = document.querySelectorAll('*');
  for (const el of candidates) {
    const text = el.textContent || '';
    if (text.length < 200 && DROP_ZONE_RE.test(text)) {
      return el as HTMLElement;
    }
  }
  return (input?.parentElement as HTMLElement) || document.body;
}

function dispatchDrop(target: HTMLElement, files: File[]): void {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
  target.dispatchEvent(new DragEvent('dragenter', opts));
  target.dispatchEvent(new DragEvent('dragover', opts));
  target.dispatchEvent(new DragEvent('drop', opts));
}

// The full step 0-3 ladder, the first step that works wins.
async function placeFiles(files: File[]): Promise<void> {
  let input = findFileInput(document);

  if (!input) {
    findAddSourceButton()?.click();
    input = await waitFor(() => findFileInput(document), 5000);
  }

  if (input && injectViaDataTransfer(input, files)) {
    return;
  }

  // nothing above worked — last resort, drag&drop
  dispatchDrop(findDropZone(input), files);
}

// Batch confirmation can only come from the DOM, and we can't fake it: just
// look for the uploaded filenames in the page text.
function waitForNamesInBody(names: string[], timeoutMs: number): Promise<boolean> {
  return waitFor(() => {
    const text = document.body.innerText;
    return names.every((name) => text.includes(name)) ? true : null;
  }, timeoutMs).then((result) => result === true);
}

let continueResolve: (() => void) | null = null;

// If the popup was closed without clicking "Continue" (or it never opens
// again), this promise must not hang forever — otherwise `uploading` would
// stay true forever and the queue would die silently. On timeout, just move on.
const CONTINUE_TIMEOUT_MS = 10 * 60 * 1000;

function waitForContinue(): Promise<void> {
  return new Promise((resolve) => {
    continueResolve = resolve;
    setTimeout(() => {
      if (continueResolve === resolve) {
        continueResolve = null;
        resolve();
      }
    }, CONTINUE_TIMEOUT_MS);
  });
}

// --- RPC path (Plan C from the README): registration + resumable upload on
// the private batchexecute protocol, bypassing the DOM entirely. Tried
// first in runUpload(); on the first failure the upload session permanently
// switches to the DOM ladder above — see runUpload().

const RPC_ADD_SOURCE_FILE = 'o4cbdc';

// notebookId is found in /notebook/<id> in the NotebookLM page path.
export function extractNotebookId(pathname: string): string | null {
  const match = pathname.match(/\/notebook\/([^/?#]+)/);
  return match ? match[1] : null;
}

// The registration response is arbitrarily nested lists, SOURCE_ID is the
// first string found while descending via data[0] (ported from
// notebooklm-mcp-cli, sources.py:_register_file_source.extract_id).
export function extractSourceId(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Array.isArray(data) && data.length > 0) return extractSourceId(data[0]);
  return null;
}

// Three protocol steps for a single file. Throws RpcError/a fetch error on
// any failure — the caller (runUpload) treats that as a signal to switch to DOM.
async function uploadFileViaRpc(notebookId: string, file: UploadFile): Promise<void> {
  const registerParams = [
    [[file.filename]],
    notebookId,
    [2],
    [1, null, null, null, null, null, null, null, null, null, [1]],
  ];
  const registerResult = await callRpc(RPC_ADD_SOURCE_FILE, registerParams, notebookId);
  const sourceId = extractSourceId(registerResult);
  if (!sourceId) {
    throw new RpcError(`Could not get SOURCE_ID for file "${file.filename}"`);
  }

  const bytes = new TextEncoder().encode(file.markdown);

  const startResponse = await fetch(`${location.origin}/upload/_/?authuser=0`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(bytes.length),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ PROJECT_ID: notebookId, SOURCE_NAME: file.filename, SOURCE_ID: sourceId }),
  });

  if (!startResponse.ok) {
    throw new RpcError(`Could not start a resumable session for "${file.filename}" (HTTP ${startResponse.status})`);
  }

  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new RpcError(`Server did not return an upload URL for file "${file.filename}"`);
  }
  // The URL comes from a response header and is fetched with the user's
  // cookies — never follow it anywhere but Google.
  if (!/\.google\.com$/.test(new URL(uploadUrl, location.origin).hostname)) {
    throw new RpcError(`Refusing to upload "${file.filename}" to a non-Google host`);
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'x-goog-upload-command': 'upload, finalize',
      'x-goog-upload-offset': '0',
    },
    body: bytes,
  });

  if (!uploadResponse.ok) {
    throw new RpcError(`Uploading file "${file.filename}" ended with HTTP ${uploadResponse.status}`);
  }
}

let uploading = false;

// Files arrive from the popup in size-bounded UPLOAD_CHUNK messages (see
// groupByBytes in chunker.ts — a single message with the whole payload can
// exceed chrome.tabs.sendMessage's IPC size ceiling), accumulated here until
// the popup sends UPLOAD to start the run.
let pending: UploadFile[] = [];

// DOM ladder over the range files[startIndex..total), in batches of
// batchSize — the same logic that used to live in runUpload() before the
// RPC path existed, extracted into its own function so it can be started
// from the middle of the queue (after falling back from RPC at file
// startIndex).
async function runDomBatches(
  files: UploadFile[],
  startIndex: number,
  batchSize: number,
  total: number,
  counters: { uploaded: number; failed: number; unconfirmed: number },
): Promise<void> {
  for (let i = startIndex; i < total; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const lastFilename = batch[batch.length - 1]?.filename;

    try {
      const fileObjects = batch.map(
        (f) => new File([f.markdown], f.filename, { type: 'text/markdown' }),
      );

      await placeFiles(fileObjects);

      const confirmed = await waitForNamesInBody(
        batch.map((f) => f.filename),
        30000,
      );

      if (confirmed) {
        counters.uploaded += batch.length;
        send({ type: 'UPLOAD_PROGRESS', done: counters.uploaded, total, current: lastFilename });
      } else {
        send({
          type: 'UPLOAD_NEEDS_CONFIRM',
          message: `Could not confirm upload of a batch of ${batch.length} files within 30s — Notebook may have changed its UI, or the files are still uploading. Check the page manually and click "Continue".`,
        });
        await waitForContinue();
        // No optimistic increment: waitForContinue is a request to check
        // manually, not a confirmation that upload happened, so it isn't
        // counted in uploaded/failed as either a success or an explicit
        // failure — treated as a separate "unconfirmed" bucket so
        // UPLOAD_DONE doesn't silently lose these files (see popup.ts).
        counters.unconfirmed += batch.length;
      }
    } catch (err) {
      counters.failed += batch.length;
      send({
        type: 'UPLOAD_ERROR',
        message: err instanceof Error ? err.message : String(err),
        filename: lastFilename,
      });
    }

    if (i + batchSize < total) {
      await sleep(2000);
    }
  }
}

async function runUpload(files: UploadFile[], batchSize: number): Promise<void> {
  if (uploading) return; // already uploading the previous queue, ignore a second UPLOAD
  uploading = true;

  try {
    const notebookId = extractNotebookId(location.pathname);

    // Reconciliation against the notebook's own source names — the single
    // source of truth (there's no local watermark anymore). If the RPC
    // fails, degrade to an empty set — same behavior as when the error used
    // to be swallowed inside listSourceNames, but now explicit and in one place.
    let existing = new Set<string>();
    if (notebookId) {
      try {
        existing = new Set(await listSourceNames(notebookId));
      } catch {
        existing = new Set<string>();
      }
    }
    const queue = files.filter((f) => !existing.has(f.filename));
    const skipped = files.length - queue.length;

    if (queue.length === 0) {
      send({ type: 'UPLOAD_DONE', uploaded: 0, failed: 0, unconfirmed: 0, skipped });
      return;
    }

    const counters = { uploaded: 0, failed: 0, unconfirmed: 0 };
    const total = queue.length;

    let domFallbackIndex = 0;
    let fallbackReason: string | null = notebookId
      ? null
      : 'could not determine notebook ID from the page URL';

    try {
      if (notebookId && !fallbackReason) {
        // RPC mode: no waitForNamesInBody, success is determined by the
        // server's response at each of the three steps, not by searching
        // the page for text.
        for (; domFallbackIndex < total; domFallbackIndex += 1) {
          const file = queue[domFallbackIndex];
          try {
            await uploadFileViaRpc(notebookId, file);
            counters.uploaded += 1;
            send({ type: 'UPLOAD_PROGRESS', done: counters.uploaded, total, current: file.filename });
          } catch (err) {
            fallbackReason = err instanceof Error ? err.message : String(err);
            break;
          }

          if (domFallbackIndex + 1 < total) {
            await sleep(2000);
          }
        }
      }

      if (fallbackReason) {
        send({
          type: 'UPLOAD_ERROR',
          message: `RPC unavailable, switching to upload via the page UI: ${fallbackReason}`,
        });
        await runDomBatches(queue, domFallbackIndex, batchSize, total, counters);
      }
    } finally {
      send({
        type: 'UPLOAD_DONE',
        uploaded: counters.uploaded,
        failed: counters.failed,
        unconfirmed: counters.unconfirmed,
        skipped,
      });
    }
  } finally {
    uploading = false;
  }
}

// A transport-level failure here used to be an unhandled rejection and
// nothing else — the reason this bug was invisible for so long.
const reportJobFailure = (err: unknown): void => {
  showJobToast(`Could not add videos: ${err instanceof Error ? err.message : String(err)}`, true);
};

// Reporter for the YouTube job: same messages as send(), plus the on-page
// toast, because there is no popup left listening on that path.
const reportJob = (msg: JobProgressMessage): void => {
  send(msg);
  if (msg.type === 'UPLOAD_PROGRESS') {
    showJobToast(`Adding ${msg.done}/${msg.total}: ${msg.current ?? ''}`);
  } else if (msg.type === 'UPLOAD_ERROR') {
    showJobToast(msg.filename ? `${msg.filename}: ${msg.message}` : msg.message);
  } else {
    // Sources added over RPC don't repaint in the SPA — say so, or the run
    // looks like it did nothing.
    const skippedPart = msg.skipped ? `, skipped ${msg.skipped}` : '';
    const errorPart = msg.error ? `\n${msg.error}` : '';
    showJobToast(
      `Added ${msg.uploaded}, failed ${msg.failed}${skippedPart} — reload the page to see the new sources${errorPart}`,
      true,
    );
  }
};

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (message: IncomingMessage, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) return;
      if (message?.type === 'UPLOAD_CHUNK') {
        pending.push(...message.files);
        sendResponse({ ok: true });
      } else if (message?.type === 'UPLOAD') {
        const files = pending;
        pending = [];
        void runUpload(files, message.batchSize);
        sendResponse({ ok: true });
      } else if (message?.type === 'UPLOAD_CONTINUE') {
        continueResolve?.();
        continueResolve = null;
      } else if (message?.type === 'GET_NOTEBOOKS') {
        // Notebook list for the popup dropdown — the caller on the domain
        // must wait for the response, so the listener is async.
        listNotebooks()
          .then((notebooks) => sendResponse({ notebooks }))
          .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
        return true;
      } else if (message?.type === 'GET_SOURCE_NAMES') {
        // Names of the sources actually present in the notebook — source of
        // truth for incremental Preview filtering in the popup.
        const id = extractNotebookId(location.pathname);
        (id ? listSourceNames(id) : Promise.resolve([]))
          .then((names) => sendResponse({ names }))
          .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
        return true;
      }
      return undefined;
    },
  );

  // The notebook tab was just created specifically for this job —
  // the job is already in storage.local by the time this script loads.
  void runYoutubeJob(reportJob, uploadFileViaRpc).catch(reportJobFailure);

  installDeleteButton();
  installSourcesUi();

  // Cache the notebook list for the YouTube-side "Add to notebook" dialog
  // (youtube-ui.ts): a content script on youtube.com can't reach this tab
  // directly (no chrome.tabs, no service worker to relay through — DECISIONS.md
  // #3), so this page refreshes the cache on every load instead. origin is
  // stored alongside because both notebooklm.google.com and notebook.google.com
  // are live (DECISIONS.md #6) and the YouTube side must reopen the right one.
  void listNotebooks()
    .then((notebooks) =>
      chrome.storage.local.set({ notebookCache: { notebooks, origin: location.origin, at: Date.now() } }),
    )
    .catch(() => {}); // cache miss is not an error — the YouTube dialog degrades to "new notebook"
}
