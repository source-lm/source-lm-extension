// Notion's own "Export → Markdown & CSV" endpoint, reduced to pure functions:
// the page id in a notion.so URL, the enqueueTask body, the zip reader for the
// result and the depth filter over its paths. DOM-free and chrome-free — the
// network calls (enqueueTask / getTasks / download) live in the content script,
// so this module stays testable under plain node.

import { captureFilename } from './capture';

// Notion puts the 32-hex id at the very end of the slug ("My-Page-<id>"), so an
// end-anchored match is the id even when the title itself ends in hex letters.
// A peek overlay ("?p=<id>") shows a different page than the pathname does —
// that one wins.
export function notionPageId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const peek = (u.searchParams.get('p') ?? '').replace(/-/g, '');
  const raw = /^[0-9a-f]{32}$/i.test(peek)
    ? peek
    : (/[0-9a-f]{32}$/i.exec(u.pathname.replace(/\/+$/, ''))?.[0] ?? null);
  if (!raw) return null;
  const h = raw.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Mirror of what the Export dialog itself posts; re-check it in DevTools if
// exports start failing (Notion may add fields such as block.spaceId).
// Ceiling: recursive:true over-exports a huge subtree (minutes of waiting for
// pages we then drop). Upgrade path is loadCachedPageChunk for the child list
// plus one non-recursive export per child.
export function exportTaskBody(pageId: string, recursive: boolean, timeZone: string): unknown {
  return {
    task: {
      eventName: 'exportBlock',
      request: {
        block: { id: pageId },
        recursive,
        shouldExportComments: false,
        exportOptions: {
          exportType: 'markdown',
          timeZone,
          locale: 'en',
          collectionViewExportType: 'currentView',
          includeContents: 'no_files',
          flattenExportFiletree: false,
        },
      },
    },
  };
}

export type ZipEntry = { path: string; data: Uint8Array };

// Ceiling on what one export may unpack to, so a hostile or broken zip cannot
// grow until the tab dies — 64 MiB of Markdown is far past any usable notebook.
const MAX_UNZIPPED = 64 * 1024 * 1024;

// Minimal reader: EOCD → central directory → local headers. Sizes and offsets
// come from the central directory because local headers may carry zeros plus a
// data descriptor (general purpose flag bit 3). Methods 0 (stored) and 8
// (deflate). No CRC check, no ZIP64 — a Notion export is neither.
export async function unzipEntries(
  buf: ArrayBuffer,
  depth = 0,
  budget = { total: 0 },
): Promise<ZipEntry[]> {
  if (depth > 2) throw new Error('zip nested too deep');
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder();
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0 && i >= buf.byteLength - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip (no end of central directory)');

  const entries: ZipEntry[] = [];
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localAt = view.getUint32(p + 42, true);
    const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) continue;
    // The local header's own name/extra lengths, not the central ones.
    const dataAt =
      localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const raw = bytes.subarray(dataAt, dataAt + compSize);
    const data = method === 8 ? await inflateRaw(raw) : raw;
    budget.total += data.byteLength;
    if (budget.total > MAX_UNZIPPED) throw new Error('export is too large to unpack in the browser');
    // Notion sometimes wraps the export in a second zip.
    if (path.toLowerCase().endsWith('.zip')) {
      for (const e of await unzipEntries(new Uint8Array(data).buffer, depth + 1, budget)) entries.push(e);
    } else {
      entries.push({ path, data });
    }
  }
  return entries;
}

async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // Start reading before writing: the stream buffers only so much, so awaiting
  // write() with nobody draining ds.readable would deadlock.
  const done = new Response(ds.readable).arrayBuffer();
  await writer.write(data);
  await writer.close();
  return new Uint8Array(await done);
}

export type NotionPage = { title: string; filename: string; markdown: string };

// Depth is relative to the root page's own directory, so a wrapper folder
// ("Export-<uuid>/", "Private & Shared/") doesn't eat a level: the root page is
// depth 0, "Root <id>/Child <id>.md" is 1, "Root <id>/Child <id>/Grand.md" is 2.
// Database rows sit one folder deeper than their page, so they fall out with
// the grandchildren; their CSVs aren't .md and never enter.
export function pickPages(entries: ZipEntry[], maxDepth = 1): NotionPage[] {
  const md = entries.filter((e) => e.path.toLowerCase().endsWith('.md'));
  if (!md.length) return [];
  const depthOf = (e: ZipEntry) => e.path.split('/').length;
  const root = md.reduce((a, b) => (depthOf(b) < depthOf(a) ? b : a));
  const base = depthOf(root);
  const decoder = new TextDecoder();
  return md
    .filter((e) => depthOf(e) - base <= maxDepth)
    .sort((a, b) => (a === root ? -1 : b === root ? 1 : a.path < b.path ? -1 : 1))
    .map((e) => {
      const title = (e.path.split('/').pop() ?? '')
        .replace(/\.md$/i, '')
        .replace(/ [0-9a-f]{32}$/i, '');
      return {
        title,
        filename: captureFilename('notion.so', title),
        markdown: decoder.decode(e.data),
      };
    });
}
