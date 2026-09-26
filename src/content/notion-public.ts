// Public `*.notion.site` pages, read through Notion's own page API.
//
// The export endpoint (`enqueueTask`, notion-ui.ts) answers 401 for a page the
// visitor is not a member of, so the published-site path asks for the block
// JSON instead — the same calls the site itself makes to paint the page — and
// converts it with lib/notion-blocks.ts. DECISIONS.md #18.
//
// Network half only: every pure line lives in notion-blocks.ts, which is what
// the test covers. Nothing here touches the DOM or chrome, at import time or
// after.

import {
  blockValue,
  mergeRecordMaps,
  missingBlockIds,
  pageToMarkdown,
  entriesSection,
  type DatabaseRef,
  type RecordMap,
} from '../lib/notion-blocks';
import type { NotionPage } from '../lib/notion-export';

export type Progress = (msg: string) => void;

// 300 sources is the NotebookLM Pro ceiling (DECISIONS.md, "NotebookLM
// limits") — past it the upload would fail anyway.
export const MAX_FILES = 300;
const PAUSE_MS = 150;
const MAX_CHUNKS = 20; // 50 blocks each — a cap on blocks fetched, not on depth
const SYNC_ROUNDS = 3;
const SYNC_BATCH = 100;
const TRUNCATED = '\n\n_Truncated: this page is longer than 1,000 blocks._';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Same-origin, session cookie rides along, no server of ours in the middle
// (DECISIONS.md #10). Public pages need no session at all; a signed-in visitor
// simply gets their own view. notion-ui.ts posts its export calls through this
// too — `name` is the /api/v3 method.
export async function post(name: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/v3/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Notion answered ${res.status} for ${name}`), { status: res.status });
  }
  return (await res.json()) as Record<string, unknown>;
}

// One page's blocks: paginate loadCachedPageChunk while the cursor stack is
// non-empty, then fill the ids the chunks referenced but did not carry.
// Three rounds max: a block we are not allowed to read never arrives, and
// missingBlockIds would keep asking for it.
async function loadPage(id: string): Promise<{ map: RecordMap; truncated: boolean }> {
  const map: RecordMap = {};
  let cursor: unknown = { stack: [] };
  let truncated = false;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const res = (await post('loadCachedPageChunk', {
      page: { id },
      limit: 50,
      cursor,
      chunkNumber: chunk,
      verticalColumns: false,
    })) as { cursor?: { stack?: unknown[] }; recordMap?: RecordMap };
    mergeRecordMaps(map, res.recordMap ?? {});
    if (!res.cursor?.stack?.length) break;
    cursor = res.cursor;
    // Still more to read on the last allowed chunk: the page is cut short and
    // its source says so, rather than ending mid-sentence in silence.
    if (chunk === MAX_CHUNKS - 1) truncated = true;
    await sleep(PAUSE_MS);
  }

  for (let round = 0; round < SYNC_ROUNDS; round++) {
    const missing = missingBlockIds(map, id);
    if (!missing.length) break;
    for (let i = 0; i < missing.length; i += SYNC_BATCH) {
      const res = (await post('syncRecordValuesMain', {
        requests: missing.slice(i, i + SYNC_BATCH).map((bid) => ({ pointer: { table: 'block', id: bid }, version: -1 })),
      })) as { recordMap?: RecordMap };
      mergeRecordMaps(map, res.recordMap ?? {});
    }
  }
  return { map, truncated };
}

// Database rows are not in the block's content[] — they only exist as the
// result of a view query. First view (`view_ids[0]`) is what the visitor sees.
async function queryRows(db: DatabaseRef): Promise<{ ids: string[]; map: RecordMap }> {
  const res = (await post('queryCollection', {
    collection: { id: db.collectionId, spaceId: db.spaceId },
    collectionView: { id: db.viewId, spaceId: db.spaceId },
    loader: {
      type: 'reducer',
      reducers: { collection_group_results: { type: 'results', limit: MAX_FILES } },
      searchQuery: '',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  })) as {
    result?: { reducerResults?: { collection_group_results?: { blockIds?: string[] } } };
    recordMap?: RecordMap;
  };
  return {
    ids: res.result?.reducerResults?.collection_group_results?.blockIds ?? [],
    map: res.recordMap ?? {},
  };
}

export async function fetchPublicPages(
  pageId: string,
  recursive: boolean,
  host: string,
  onProgress: Progress,
): Promise<NotionPage[]> {
  onProgress('Reading this page…');
  let rootMap: RecordMap;
  let rootTruncated: boolean;
  try {
    ({ map: rootMap, truncated: rootTruncated } = await loadPage(pageId));
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) throw new Error('This page is not public');
    throw err;
  }

  const root = pageToMarkdown(rootMap, pageId, host);
  let markdown = root.markdown + (rootTruncated ? TRUNCATED : '');

  // A database page carries no prose of its own; pageToMarkdown pushes its own
  // collection first, so databases[0] is the page itself and the rest are
  // inline databases inside it.
  const rootIsDb = blockValue(rootMap, pageId)?.type === 'collection_view_page';
  const inline = root.databases.slice(rootIsDb ? 1 : 0);

  // A mention or a link can name a page outside this workspace — the
  // visitor's own private space, when they are signed in — and that must
  // never ride along into the notebook just because the public page named it.
  const rootSpaceId = blockValue(rootMap, pageId)?.space_id;

  const targets: string[] = [];
  const seen = new Set([pageId]);
  // The root file counts against the cap, so 299 targets is the ceiling; past
  // it nothing more is collected and nothing more is fetched.
  let capped = false;
  const push = (id: string) => {
    if (targets.length + 1 >= MAX_FILES) {
      capped = true;
      return;
    }
    if (!seen.has(id)) {
      seen.add(id);
      targets.push(id);
    }
  };

  if (rootIsDb && root.databases[0]) {
    const rows = await queryRows(root.databases[0]);
    if (recursive) for (const id of rows.ids) push(id);
    // A database page has no prose of its own, so without the row list the
    // root source would be a bare title — true whether or not the rows also
    // come in as sources of their own.
    markdown += entriesSection(mergeRecordMaps(rootMap, rows.map), rows.ids, host);
  }
  if (recursive) {
    for (const child of root.childPages) push(child.id);
    for (const db of inline) {
      if (capped) break;
      const rows = await queryRows(db);
      for (const id of rows.ids) push(id);
      await sleep(PAUSE_MS);
    }
  }

  const pages: NotionPage[] = [{ title: root.title, filename: root.filename, markdown }];
  const total = targets.length + 1;
  const capNote = capped ? ` (${MAX_FILES}-file cap reached, the rest are skipped)` : '';
  for (const [i, id] of targets.entries()) {
    onProgress(`Fetching page ${i + 2} of ${total}${capNote}…`);
    await sleep(PAUSE_MS);
    let page;
    try {
      const loaded = await loadPage(id);
      if (blockValue(loaded.map, id)?.space_id !== rootSpaceId) continue;
      page = pageToMarkdown(loaded.map, id, host);
      if (loaded.truncated) page.markdown += TRUNCATED;
    } catch {
      continue; // one unreadable child must not throw away the pages already converted
    }
    // Nothing but the title: a page whose whole body is databases or child
    // pages one level deeper. Those arrive as sources of their own, so the
    // title-only file would be an empty source. The root page always stays.
    if (!page.markdown.replace(/^#[^\n]*/, '').trim()) continue;
    pages.push({ title: page.title, filename: page.filename, markdown: page.markdown });
  }
  return pages;
}
