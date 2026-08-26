// "Notebook" domain RPC logic: listing notebooks, creating a notebook,
// adding a YouTube source with version detection (izAoDd -> ozz5Z), and the
// runner for the ADD_YOUTUBE background job that the popup puts into
// chrome.storage.local — the queue lives in the content script on the
// NotebookLM page, not in a service worker (DECISIONS.md #3: an MV3 SW is
// unloaded after ~30s of idle and would not survive a pause between tabs).
//
// storage.local, not storage.session: session storage defaults to
// TRUSTED_CONTEXTS_ONLY and a content script cannot read it at all without
// a trusted context calling setAccessLevel() — i.e. exactly the service
// worker this extension deliberately does not have. See DECISIONS.md #3.
//
// The protocol was reverse-engineered in the third-party project
// notebooklm-mcp-cli (core/sources.py, core/notebooks.py, core/base.py) —
// only the logic needed for YouTube sources is ported here.

import { callRpc, RpcError } from './rpc';

export type NotebookSummary = { id: string; title: string; emoji?: string };
export type YoutubeVideoJob = { videoId: string; title: string; url: string };
// ADD_YOUTUBE: despite the name this job type now also carries plain URL
// sources and an optional captured-page file (added source-lm) — the type
// string and storage key stay unchanged (popup.ts and youtube-ui.ts both
// write it, renaming buys nothing).
export type YoutubeJob = {
  type: 'ADD_YOUTUBE';
  videos: YoutubeVideoJob[];
  createdAt: number;
  targetNotebookId?: string;
  createTitle?: string;
  file?: { filename: string; markdown: string };
  // "Fix a broken source" hand-off (DECISIONS.md #16): the id of the source
  // `file` replaces. Deleted only after the upload succeeded, never before.
  replaceSourceId?: string;
};

// One entry of the `fixQueue` array in chrome.storage.local: the notebook tab
// writes it when the user opens a broken source's page (sources-ui.ts), the
// popup picks it up on that page and turns "Add page as .md" into a
// replacement (DECISIONS.md #16). Type only — the key ('fixQueue') and the
// 5-minute TTL are literals on both sides, so the popup keeps importing this
// module for types alone and no RPC code lands in its bundle.
export type FixEntry = {
  notebookId: string;
  sourceId: string;
  url: string;
  title: string;
  createdAt: number;
};

export type JobProgressMessage =
  | { type: 'UPLOAD_PROGRESS'; done: number; total: number; current?: string }
  | { type: 'UPLOAD_ERROR'; message: string; filename?: string }
  | { type: 'UPLOAD_DONE'; uploaded: number; failed: number; skipped?: number; error?: string };

const RPC_LIST_NOTEBOOKS = 'wXbhsf';
const RPC_CREATE_NOTEBOOK = 'CCqFvf';
const RPC_ADD_SOURCE_V1 = 'izAoDd';
const RPC_ADD_SOURCE_V2 = 'ozz5Z';
const RPC_GET_NOTEBOOK = 'rLM1Ne';
const RPC_DELETE_SOURCE = 'tGMBJ';

const SOURCE_RPC_VERSION_KEY = 'sourceRpcVersion';
const YOUTUBE_JOB_KEY = 'youtubeJob';

// ---- response parsing (pure functions, no chrome API/DOM) ---------------

// wXbhsf returns a list of notebooks shaped like [[title, sources, id,
// emoji, null, metadata], ...], sometimes wrapped in an extra outer array.
export function parseNotebookList(result: unknown): NotebookSummary[] {
  const list = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(list)) return [];

  const notebooks: NotebookSummary[] = [];
  for (const nb of list) {
    if (!Array.isArray(nb) || nb.length < 3) continue;
    const title = typeof nb[0] === 'string' ? nb[0] : 'Untitled';
    const id = nb[2];
    const emoji = typeof nb[3] === 'string' ? nb[3] : undefined;
    if (typeof id === 'string') notebooks.push(emoji ? { id, title, emoji } : { id, title });
  }
  return notebooks;
}

// CCqFvf: the id of the just-created notebook is in result[2].
export function extractCreatedNotebookId(result: unknown): string | null {
  if (Array.isArray(result) && result.length >= 3 && typeof result[2] === 'string') {
    return result[2];
  }
  return null;
}

// rLM1Ne (getNotebook): the source list is in result[0][1], each source's
// metadata is src[2]. The url slot inside metadata isn't fixed: for YouTube
// sources it's metadata[5][0] ([url, videoId, channel]), for web sources
// it's metadata[7][0] — Google shifts these slots without notice (DECISIONS.md
// #11 has the izAoDd/ozz5Z precedent). So instead of indexing a slot, we
// recursively collect every string that looks like an http(s) URL, same
// structure-agnostic trick as extractSourceNames below. The [2] projection
// response carries metadata only, no source content, so this can't
// accidentally pick up a URL quoted inside a document.
// Uploaded files carry two per-source Google-internal links in metadata
// (contribution.usercontent.google.com/download?c=<token>,
// drive.google.com/viewer/upload?ds=<token>) — unique for every source, so
// they are neither the source's identity nor a page anyone can open. Skipped
// here so every consumer (dedup, broken-source fix) sees only real URLs.
const INTERNAL_URL_RE = /^https?:\/\/([^/]*\.)?(usercontent\.google\.com|drive\.google\.com\/viewer)\//;

export function extractSourceUrls(getNotebookResult: unknown): string[] {
  const urls: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/^https?:\/\//.test(value) && !INTERNAL_URL_RE.test(value)) urls.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    }
  };
  walk(getNotebookResult);
  return urls;
}

const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

// Source urls of the notebook's already-added sources. We don't swallow the
// RPC error, same reasoning as listSourceNames below: "no sources" and "RPC
// failed" must stay distinguishable.
export async function listSourceUrls(notebookId: string): Promise<string[]> {
  const result = await callRpc(RPC_GET_NOTEBOOK, [notebookId, null, [2], null, 0], notebookId);
  return extractSourceUrls(result);
}

// Reconciliation after izAoDd's ambiguous error code 3: the notebook's
// source list may already contain our URL (the RPC accepted the request
// asynchronously).
export async function sourceExistsForUrl(notebookId: string, url: string): Promise<boolean> {
  const target = normalizeUrl(url);
  const urls = await listSourceUrls(notebookId);
  return urls.some((u) => normalizeUrl(u) === target);
}

// Pure URL -> videoId extraction, covering the forms a user might paste or
// that a YouTube source URL is stored as: ?v=/&v=, youtu.be/<id>,
// /shorts/<id>, /embed/<id>. Deliberately not imported from youtube.ts —
// that module has a top-level chrome.runtime.onMessage.addListener side
// effect that would end up in dist/content.js, and its regex only knows v=.
export function youtubeVideoId(url: string): string | null {
  const queryMatch = url.match(/[?&]v=([^&#]+)/);
  if (queryMatch) return queryMatch[1];

  const pathMatch = url.match(/(?:youtu\.be\/|\/shorts\/|\/embed\/)([^?&#/]+)/);
  if (pathMatch) return pathMatch[1];

  return null;
}

// The file source name slot in the rLM1Ne response is undocumented, and
// Google has already shifted the response structure without notice (see
// decision #11 in DECISIONS.md). So instead of parsing a schema, we recursively
// collect every string that looks like a .md filename.
export function extractSourceNames(result: unknown): string[] {
  const names: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.endsWith('.md')) names.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    }
  };
  walk(result);
  return names;
}

// Names of the notebook's already-added sources — source of truth for
// incremental upload. We don't swallow the RPC error: "no sources" and
// "RPC failed" must stay distinguishable, otherwise a network failure looks
// like an empty notebook.
export async function listSourceNames(notebookId: string): Promise<string[]> {
  const result = await callRpc(RPC_GET_NOTEBOOK, [notebookId, null, [2], null, 0], notebookId);
  return extractSourceNames(result);
}

export type SourceInfo = {
  id: string;
  title: string;
  // Both are `undefined` when the slot is missing or isn't an int — Google
  // moves slots without notice (decision #11), so every consumer must treat
  // "unknown" as a real answer instead of assuming a default.
  type?: number; // 5 web, 9 youtube, 1/2 drive, 3 pdf, 4 pasted, 11 uploaded
  status?: number; // 1 processing, 2 ready, 3 error, 5 preparing
  urls: string[];
};

// One rLM1Ne source entry is [[id], title, metadata, [null, status]].
// id/title/type/status are read by index because there is nothing else to
// match them on; the URL is NOT — it lives at metadata[5] for YouTube and
// metadata[7] for web sources and has moved before, so it goes through
// extractSourceUrls scoped to this single entry (decision #11).
export function parseSources(result: unknown): SourceInfo[] {
  const container = Array.isArray(result) ? result[0] : null;
  const list = Array.isArray(container) ? container[1] : null;
  if (!Array.isArray(list)) return [];

  const sources: SourceInfo[] = [];
  for (const src of list) {
    if (!Array.isArray(src)) continue;
    const id = Array.isArray(src[0]) && typeof src[0][0] === 'string' ? src[0][0] : '';
    if (!id) continue;

    const metadata = Array.isArray(src[2]) ? src[2] : [];
    const state = Array.isArray(src[3]) ? src[3] : [];
    sources.push({
      id,
      title: typeof src[1] === 'string' ? src[1] : id,
      type: typeof metadata[4] === 'number' ? metadata[4] : undefined,
      status: typeof state[1] === 'number' ? state[1] : undefined,
      urls: extractSourceUrls(src),
    });
  }
  return sources;
}

// Same non-swallowing contract as listSourceNames/listSourceUrls above.
export async function listSources(notebookId: string): Promise<SourceInfo[]> {
  const result = await callRpc(RPC_GET_NOTEBOOK, [notebookId, null, [2], null, 0], notebookId);
  return parseSources(result);
}

// Duplicate = same first URL (trailing slash ignored), or — for sources that
// carry no URL at all, e.g. uploaded .md files — the same title. The first
// source of each group is kept; every id after it is reported.
export function findDuplicateIds(sources: SourceInfo[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const source of sources) {
    const key = source.urls.length ? `url:${normalizeUrl(source.urls[0])}` : `title:${source.title}`;
    if (seen.has(key)) duplicates.push(source.id);
    else seen.add(key);
  }
  return duplicates;
}

// Re-arms a create-new job against the notebook just created, so the reloaded
// content script finishes it as a plain "add to this notebook" job.
// createdAt is preserved on purpose so the 5-minute TTL in readAndClearJob
// still bounds a job stranded by a failed navigation.
export function handoffJob(job: YoutubeJob, notebookId: string): YoutubeJob {
  const { createTitle: _createTitle, ...rest } = job;
  return { ...rest, targetNotebookId: notebookId };
}

// ---- list / create notebooks -----------------------------------------------

export async function listNotebooks(): Promise<NotebookSummary[]> {
  const result = await callRpc(RPC_LIST_NOTEBOOKS, [null, 1, null, [2]]);
  return parseNotebookList(result);
}

export async function createNotebook(title: string): Promise<string> {
  const params = [
    title,
    null,
    null,
    [2],
    [1, null, null, null, null, null, null, null, null, null, [1]],
  ];
  const result = await callRpc(RPC_CREATE_NOTEBOOK, params);
  const id = extractCreatedNotebookId(result);
  if (!id) throw new RpcError('Could not get the new notebook ID from the server response.');
  return id;
}

// ---- delete sources ---------------------------------------------------

// Pure param builder for tGMBJ, split out so it's testable without a DOM or
// a network mock — the one part of this irreversible operation that can be
// checked automatically.
export function deleteSourceParams(ids: string[]): unknown[] {
  return [ids.map((id) => [id]), [2]];
}

// Deletes all given source ids in a single batch RPC call, not one call per id.
export async function deleteSources(notebookId: string, ids: string[]): Promise<void> {
  await callRpc(RPC_DELETE_SOURCE, deleteSourceParams(ids), notebookId);
}

// ---- add YouTube source, with RPC version detection -----------------------

// The URL is always wrapped in its own array ([url]) in source_data — the
// slot index is the whole YouTube-vs-web difference: 7 (0-based) for
// YouTube, 2 for regular web sources. See sources.py:_add_url_source_v1.
export function sourceDataV1(url: string, slot: 2 | 7): unknown[] {
  const sourceData: unknown[] = [null, null, null, null, null, null, null, null, null, null, 1];
  sourceData[slot] = [url];
  return sourceData;
}

async function addSourceV1(notebookId: string, url: string, slot: 2 | 7): Promise<void> {
  const params = [
    [sourceDataV1(url, slot)],
    notebookId,
    [2],
    [1, null, null, null, null, null, null, null, null, null, [1]],
  ];
  await callRpc(RPC_ADD_SOURCE_V1, params, notebookId);
}

async function addSourceV2(notebookId: string, url: string): Promise<void> {
  // notebookId is not included here — it's passed only via source-path
  // (see callRpc(..., notebookId) below, which puts it in the query).
  const sourceData = [
    [null, url, 627],
    [null, null, null, null, null, null, null, null, null, [null, null, 1]],
    1,
  ];
  await callRpc(RPC_ADD_SOURCE_V2, [[sourceData]], notebookId);
}

async function getCachedSourceRpcVersion(): Promise<'v1' | 'v2' | null> {
  const stored = await chrome.storage.local.get(SOURCE_RPC_VERSION_KEY);
  const version = stored[SOURCE_RPC_VERSION_KEY];
  return version === 'v1' || version === 'v2' ? version : null;
}

function cacheSourceRpcVersion(version: 'v1' | 'v2'): void {
  void chrome.storage.local.set({ [SOURCE_RPC_VERSION_KEY]: version });
}

async function addSourceVersion(notebookId: string, url: string, slot: 2 | 7, version: 'v1' | 'v2'): Promise<void> {
  if (version === 'v2') await addSourceV2(notebookId, url);
  else await addSourceV1(notebookId, url, slot);
}

// Shared reconciliation ladder for an ambiguous error code 3, run both the
// first time a version is detected and when a previously-cached version
// (proven by, say, a YouTube add) turns out to be wrong for this call — the
// cache is shared by both v1 shapes (slot 2 vs slot 7), so it can go stale
// in one direction without the other. `failedVersion` is the one that just
// threw; the source may still have been accepted asynchronously, so we
// check the notebook's source list before falling back to the other version.
async function reconcileOrFallback(
  notebookId: string,
  url: string,
  slot: 2 | 7,
  failedVersion: 'v1' | 'v2',
): Promise<void> {
  const exists = await sourceExistsForUrl(notebookId, url);
  if (exists) {
    cacheSourceRpcVersion(failedVersion);
    return;
  }
  const otherVersion = failedVersion === 'v1' ? 'v2' : 'v1';
  await addSourceVersion(notebookId, url, slot, otherVersion);
  cacheSourceRpcVersion(otherVersion);
}

// Adds a single URL as a source to the notebook. Version detection ported
// from add_url_source (sources.py): try legacy izAoDd first; error code 3
// is ambiguous — it means both "accepted asynchronously" and "rejected" —
// so we reconcile against the notebook's source list via rLM1Ne; if the
// source isn't there, try the new ozz5Z. The winning variant is cached in
// chrome.storage.local so we don't pay for detection on every subsequent
// source — but the cache isn't terminal: if the cached version later fails
// with the same ambiguous code 3 (e.g. it was proven by a YouTube add and
// this is a web add), we re-run the same reconcile-then-other-version
// ladder instead of surfacing a permanent failure. `slot` only affects the
// v1 shape (see sourceDataV1) — v2 is shape-identical for YouTube and web
// sources.
async function addSourceWithVersion(notebookId: string, url: string, slot: 2 | 7): Promise<void> {
  const cached = await getCachedSourceRpcVersion();

  if (cached) {
    try {
      await addSourceVersion(notebookId, url, slot, cached);
      return;
    } catch (err) {
      if (err instanceof RpcError && err.code === 3) {
        await reconcileOrFallback(notebookId, url, slot, cached);
        return;
      }
      throw err;
    }
  }

  try {
    await addSourceV1(notebookId, url, slot);
    cacheSourceRpcVersion('v1');
  } catch (err) {
    if (err instanceof RpcError && err.code === 3) {
      await reconcileOrFallback(notebookId, url, slot, 'v1');
      return;
    }
    throw err;
  }
}

export async function addYoutubeSource(notebookId: string, url: string): Promise<void> {
  await addSourceWithVersion(notebookId, url, 7);
}

export async function addUrlSource(notebookId: string, url: string): Promise<void> {
  await addSourceWithVersion(notebookId, url, 2);
}

// ---- ADD_YOUTUBE background job from chrome.storage.local -----------------

const JOB_TTL_MS = 5 * 60 * 1000;

async function readAndClearJob(): Promise<YoutubeJob | null> {
  const stored = await chrome.storage.local.get(YOUTUBE_JOB_KEY);
  const job = stored[YOUTUBE_JOB_KEY] as YoutubeJob | undefined;
  if (!job || job.type !== 'ADD_YOUTUBE') return null;
  await chrome.storage.local.remove(YOUTUBE_JOB_KEY);
  // storage.session died with the browser, storage.local does not: a job
  // stranded by a crash or a restart must not fire days later.
  if (!(Date.now() - job.createdAt <= JOB_TTL_MS)) return null;
  return job;
}

let jobRunning = false;

// Runs both on content script load (the job was already in storage.local
// — the notebook tab was just created by the popup) and on the explicit
// RUN_YOUTUBE_JOB message (the tab was opened earlier, and its page-load
// auto-run didn't catch the job in time).
export async function runYoutubeJob(
  send: (msg: JobProgressMessage) => void,
  uploadFile?: (notebookId: string, file: { filename: string; markdown: string }) => Promise<void>,
): Promise<void> {
  if (jobRunning) return;
  jobRunning = true;

  // Set only once a job is actually in hand: "no job to run" is the normal
  // quiet path and must stay silent, while a storage failure must be
  // reported instead of vanishing (hence the read is inside the try).
  let job: YoutubeJob | null = null;
  let handedOff = false;
  const counters = { uploaded: 0, failed: 0, skipped: 0 };
  // Carried through to UPLOAD_DONE/lastYoutubeRun so the final toast can show
  // *why* it failed instead of just a count — see reportJob in uploader.ts.
  let lastError: string | undefined;

  try {
    try {
      job = await readAndClearJob();
    } catch (err) {
      send({
        type: 'UPLOAD_ERROR',
        message: `Could not read the job from storage: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (!job) return;

    const total = job.videos.length + (job.file ? 1 : 0);
    const wasCreated = !job.targetNotebookId;
    let notebookId = job.targetNotebookId ?? null;
    if (!notebookId && job.createTitle !== undefined) {
      try {
        notebookId = await createNotebook(job.createTitle);
        // The tab was opened at the notebook list (or on some other
        // notebook via the popup path); the user asked for a NEW notebook,
        // so land them in it and let the page-load auto-run in uploader.ts
        // (`void runYoutubeJob(reportJob)`) finish the job there.
        try {
          await chrome.storage.local.set({ [YOUTUBE_JOB_KEY]: handoffJob(job, notebookId) });
          handedOff = true;
          location.href = `/notebook/${notebookId}`;
          return;
        } catch {
          // storage.local.set failed — fall through and run the job in
          // place exactly as today, no navigation, no lost videos.
        }
      } catch (err) {
        send({
          type: 'UPLOAD_ERROR',
          message: `Failed to create notebook: ${err instanceof Error ? err.message : String(err)}`,
        });
        counters.failed = total;
        return;
      }
    }
    if (!notebookId) {
      send({ type: 'UPLOAD_ERROR', message: 'No notebook selected.' });
      counters.failed = total;
      return;
    }

    // A freshly created notebook has no sources yet — reconciliation would
    // just be an empty RPC round-trip.
    let existing = new Set<string>();
    if (!wasCreated) {
      try {
        const urls = await listSourceUrls(notebookId);
        for (const u of urls) {
          const id = youtubeVideoId(u);
          if (id) existing.add(id);
          existing.add(normalizeUrl(u));
        }
      } catch (err) {
        send({
          type: 'UPLOAD_ERROR',
          message: `Could not check existing sources, adding all videos: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    for (const video of job.videos) {
      const id = video.videoId || youtubeVideoId(video.url);
      if ((id && existing.has(id)) || existing.has(normalizeUrl(video.url))) {
        counters.skipped += 1;
        send({
          type: 'UPLOAD_PROGRESS',
          done: counters.uploaded + counters.failed + counters.skipped,
          total,
          current: video.title,
        });
        continue;
      }

      try {
        await (youtubeVideoId(video.url) ? addYoutubeSource : addUrlSource)(notebookId, video.url);
        counters.uploaded += 1;
      } catch (err) {
        counters.failed += 1;
        lastError = err instanceof Error ? err.message : String(err);
        send({
          type: 'UPLOAD_ERROR',
          message: lastError,
          filename: video.title,
        });
      }
      send({
        type: 'UPLOAD_PROGRESS',
        done: counters.uploaded + counters.failed + counters.skipped,
        total,
        current: video.title,
      });
    }

    // Captured-page upload has no DOM fallback (DECISIONS.md #9's
    // dual RPC/DOM path covers only the JSON queue, not this file) — if the
    // RPC file path breaks, this reports an error instead of retrying via
    // DOM injection. Upgrade path: route job.file through runUpload instead
    // of calling uploadFile directly.
    if (job.file && uploadFile) {
      try {
        await uploadFile(notebookId, job.file);
        counters.uploaded += 1;
        // Only now, and only on success: the broken source being replaced is
        // the user's only copy of that page in the notebook, so a failed
        // upload must leave it alone (DECISIONS.md #16). A failed delete is not
        // a failed upload either — report it, don't count it.
        if (job.replaceSourceId) {
          try {
            await deleteSources(notebookId, [job.replaceSourceId]);
          } catch (err) {
            send({
              type: 'UPLOAD_ERROR',
              message: `Replacement added, but the broken source could not be deleted: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      } catch (err) {
        counters.failed += 1;
        lastError = err instanceof Error ? err.message : String(err);
        send({
          type: 'UPLOAD_ERROR',
          message: lastError,
          filename: job.file.filename,
        });
      }
      send({
        type: 'UPLOAD_PROGRESS',
        done: counters.uploaded + counters.failed + counters.skipped,
        total,
        current: job.file.filename,
      });
    }
  } finally {
    if (job && !handedOff) {
      send({
        type: 'UPLOAD_DONE',
        uploaded: counters.uploaded,
        failed: counters.failed,
        skipped: counters.skipped,
        error: lastError,
      });
      // The popup is gone by now (the tab switch closed it) — leave the
      // outcome behind so it can be shown the next time it opens.
      void chrome.storage.local.set({
        lastYoutubeRun: {
          uploaded: counters.uploaded,
          failed: counters.failed,
          skipped: counters.skipped,
          error: lastError,
          at: Date.now(),
        },
      });
    }
    jobRunning = false;
  }
}
