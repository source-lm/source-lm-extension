// Notion's internal block JSON (`loadCachedPageChunk`, `syncRecordValuesMain`,
// `queryCollection`) turned into Markdown. Public `*.notion.site` pages answer
// 401 from the export endpoint, so this is the fallback for the path in
// ./notion-export. Pure on purpose — no fetch, no DOM, no chrome: the network
// half lives in the content script, this half stays testable under plain node.

import { captureFilename } from './capture';

export type RichText = Array<[string] | [string, unknown[][]]>;
export type NotionBlock = {
  id: string;
  type: string;
  properties?: Record<string, RichText>;
  content?: string[];
  parent_id?: string;
  parent_table?: string;
  format?: Record<string, unknown>;
  collection_id?: string;
  view_ids?: string[];
  space_id?: string;
};
export type RecordMap = {
  block?: Record<string, unknown>;
  collection?: Record<string, unknown>;
  collection_view?: Record<string, unknown>;
};

const MAX_DEPTH = 32;
const TABLES = ['block', 'collection', 'collection_view'] as const;

// Current responses wrap twice (`{ spaceId, value: { value, role } }`), older
// ones once (`{ role, value }`). A Block never has its own `value` field, so
// the double unwrap is unambiguous.
function unwrap(rec: unknown): unknown {
  const r = rec as { value?: { value?: unknown } } | undefined;
  return r?.value?.value ?? r?.value;
}

export function blockValue(map: RecordMap, id: string): NotionBlock | undefined {
  return unwrap(map.block?.[id]) as NotionBlock | undefined;
}

function collectionName(map: RecordMap, collectionId: string): string {
  const c = unwrap(map.collection?.[collectionId]) as { name?: RichText } | undefined;
  return richText(c?.name);
}

export function mergeRecordMaps(into: RecordMap, from: RecordMap): RecordMap {
  for (const t of TABLES) if (from[t]) into[t] = Object.assign(into[t] ?? {}, from[t]);
  return into;
}

// Ids referenced by a loaded block but not loaded themselves — the caller feeds
// them back to syncRecordValuesMain. Child pages are loaded as pages of their
// own, so their subtrees are none of our business.
export function missingBlockIds(map: RecordMap, rootId: string): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  const walkIds = (id: string, depth: number) => {
    if (depth > MAX_DEPTH || seen.has(id)) return;
    seen.add(id);
    const b = blockValue(map, id);
    if (!b) return void missing.push(id);
    if (id !== rootId && b.type === 'page') return;
    for (const c of b.content ?? []) walkIds(c, depth + 1);
  };
  walkIds(rootId, 0);
  return missing;
}

export function richText(rt: RichText | undefined, map?: RecordMap, host?: string): string {
  if (!Array.isArray(rt)) return '';
  return rt
    .map((seg) => decorate(String(seg?.[0] ?? ''), (seg?.[1] as unknown[][]) ?? [], map, host))
    .join('');
}

// Decorations nest outward in array order: [['b'],['a',url]] is a bold link.
// Mentions ('lm', 'p', 'e', 'd', 'u') replace the placeholder glyph Notion
// stores as the visible text ("‣"); '_' (underline), 'h' (color) and 'm'
// (comment anchor) have no Markdown and drop out.
function decorate(text: string, decos: unknown[][], map?: RecordMap, host?: string): string {
  let out = text;
  for (const d of decos) {
    const kind = String((d as unknown[])[0] ?? '');
    const arg = (d as unknown[])[1];
    const obj = (arg && typeof arg === 'object' ? arg : {}) as {
      title?: string;
      href?: string;
      start_date?: string;
      end_date?: string;
    };
    if (kind === 'b') out = `**${out}**`;
    else if (kind === 'i') out = `*${out}*`;
    else if (kind === 's') out = `~~${out}~~`;
    else if (kind === 'c') out = '`' + out + '`';
    else if (kind === 'a') out = webLink(out, String(arg ?? ''), host);
    else if (kind === 'e') out = `$${String(arg ?? out)}$`;
    else if (kind === 'u') out = '@user';
    else if (kind === 'd' && obj.start_date)
      out = `${obj.start_date}${obj.end_date ? ` → ${obj.end_date}` : ''}`;
    else if (kind === 'lm') out = `[${obj.title || obj.href || out}](${obj.href ?? ''})`;
    else if (kind === 'p') out = pageLink(map, String(arg ?? ''), 'page', host);
  }
  // A mention kind nobody handled leaves Notion's bare placeholder glyph
  // behind; an empty fragment reads better in the source than a stray "‣".
  return out === '‣' ? '' : out;
}

// Only http(s) becomes a Markdown link: a `javascript:` href (or a
// Notion-relative one, which resolves nowhere outside Notion) goes in as plain
// text. `)` in the target would end the link early, so it is escaped.
// Notion stores links to its own pages as relative hrefs ("/<id>"), so those
// resolve against the page's host; anything not http(s) stays plain text.
function webLink(text: string, href: string, host = 'www.notion.so'): string {
  let u: URL;
  try {
    u = new URL(href, `https://${host}/`);
  } catch {
    return text;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return text;
  const target = href.startsWith('/') ? u.href : href; // keep absolute ones verbatim
  return `[${text}](${target.replace(/\)/g, '%29')})`;
}

function noDashes(id: string): string {
  return id.replace(/-/g, '');
}

// Links stay on the host the page was read from: an id URL resolves on
// `*.notion.site` and on app.notion.com alike, and a published site keeps
// working for a visitor with no Notion account.
function pageLink(map: RecordMap | undefined, id: string, fallback: string, host = 'www.notion.so'): string {
  const b = map && blockValue(map, id);
  const title = (b && richText(b.properties?.title)) || fallback;
  return `[${title}](https://${host}/${noDashes(id)})`;
}

// Rows of a database page listed in the page's own file — what a database page
// gets when its rows are not fetched as sources of their own (`recursive` off).
export function entriesSection(map: RecordMap, rowIds: string[], host?: string): string {
  if (!rowIds.length) return '';
  return ['', '## Entries', '', ...rowIds.map((id) => `- ${pageLink(map, id, 'Untitled', host)}`), ''].join('\n');
}

export type DatabaseRef = {
  blockId: string;
  collectionId: string;
  viewId: string;
  spaceId: string;
  name: string;
};
export type PageMarkdown = {
  title: string;
  markdown: string;
  childPages: { id: string; title: string }[];
  databases: DatabaseRef[];
};

type Ctx = { map: RecordMap; pageId: string; host: string; seen: Set<string> } & Pick<
  PageMarkdown,
  'childPages' | 'databases'
>;

function dbRef(map: RecordMap, b: NotionBlock): DatabaseRef | undefined {
  const ptr = b.format?.collection_pointer as { id?: string; spaceId?: string } | undefined;
  const collectionId = b.collection_id ?? ptr?.id;
  const viewId = b.view_ids?.[0];
  if (!collectionId || !viewId) return undefined;
  return {
    blockId: b.id,
    collectionId,
    viewId,
    spaceId: b.space_id ?? ptr?.spaceId ?? '',
    name: collectionName(map, collectionId),
  };
}

function tableLines(ctx: Ctx, b: NotionBlock, indent: string): string[] {
  const cols = (b.format?.table_block_column_order as string[] | undefined) ?? [];
  if (!cols.length) return [];
  const rows = (b.content ?? [])
    .map((id) => blockValue(ctx.map, id))
    .filter((r): r is NotionBlock => !!r)
    .map((r) => cols.map((c) => richText(r.properties?.[c], ctx.map, ctx.host).replace(/[|\n]/g, ' ').trim()));
  const head = b.format?.table_block_column_header ? (rows.shift() ?? cols.map(() => '')) : cols.map(() => '');
  const line = (cells: string[]) => `${indent}| ${cells.join(' | ')} |`;
  return [line(head), line(cols.map(() => '---')), ...rows.map(line)];
}

function walk(ctx: Ctx, ids: string[], indent: string, depth: number): string[] {
  const out: string[] = [];
  if (depth > MAX_DEPTH) return out;
  const put = (s: string) => out.push(s === '' ? '' : indent + s);
  // One blank line before a block-level construct, never between list items.
  const sep = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };
  let n = 0;
  for (const id of ids) {
    // A content[] that points back at an ancestor would re-expand the whole
    // subtree, exponentially — same guard as missingBlockIds().
    if (ctx.seen.has(id)) continue;
    ctx.seen.add(id);
    const b = blockValue(ctx.map, id);
    if (!b) continue; // not loaded — the caller re-fetches via missingBlockIds()
    const raw = richText(b.properties?.title, ctx.map, ctx.host);
    const text = b.type === 'code' ? raw : raw.trim(); // code keeps its own indentation
    const kids = (pad: string) => out.push(...walk(ctx, b.content ?? [], indent + pad, depth + 1));
    n = b.type === 'numbered_list' ? n + 1 : 0;
    if (b.type === 'header' || b.type === 'sub_header' || b.type === 'sub_sub_header') {
      sep();
      put(`${'#'.repeat(b.type === 'header' ? 2 : b.type === 'sub_header' ? 3 : 4)} ${text}`);
      put('');
    } else if (b.type === 'bulleted_list' || b.type === 'toggle' || b.type === 'to_do') {
      // A toggle is just a list item whose children happen to be folded.
      const mark =
        b.type === 'to_do' ? (richText(b.properties?.checked) === 'Yes' ? '- [x] ' : '- [ ] ') : '- ';
      put(mark + text);
      kids('  ');
    } else if (b.type === 'numbered_list') {
      put(`${n}. ${text}`);
      kids('   ');
    } else if (b.type === 'quote') {
      sep();
      for (const l of text.split('\n')) put(`> ${l}`);
      put('');
    } else if (b.type === 'callout') {
      sep();
      const icon = b.format?.page_icon;
      const emoji = typeof icon === 'string' && !icon.includes('/') ? `${icon} ` : '';
      put(`> ${emoji}${text}`);
      const inner = walk(ctx, b.content ?? [], '', depth + 1);
      while (inner.length && inner[inner.length - 1] === '') inner.pop();
      for (const l of inner) out.push(l === '' ? '>' : `${indent}> ${l}`);
      put('');
    } else if (b.type === 'code') {
      sep();
      put('```' + richText(b.properties?.language).toLowerCase());
      for (const l of text.split('\n')) put(l);
      put('```');
      put('');
    } else if (b.type === 'divider') {
      sep();
      put('---');
      put('');
    } else if (b.type === 'equation') {
      sep();
      put(`$$${text}$$`);
      put('');
    } else if (b.type === 'bookmark') {
      sep();
      const link = richText(b.properties?.link);
      put(`[${text || link}](${link})`);
      const desc = richText(b.properties?.description);
      if (desc) put(desc);
      put('');
    } else if (['image', 'video', 'file', 'pdf', 'embed', 'audio'].includes(b.type)) {
      // No signed URLs: they expire in an hour and we never download the file.
      sep();
      put(`[${b.type}: ${richText(b.properties?.caption, ctx.map, ctx.host) || 'attachment'}]`);
      put('');
    } else if (b.type === 'table') {
      sep();
      out.push(...tableLines(ctx, b, indent));
      put('');
    } else if (b.type === 'column_list' || b.type === 'column') {
      kids('');
    } else if (b.type === 'synced_block' || b.type === 'synced_container') {
      const src = (b.format?.transclusion_reference_pointer as { id?: string } | undefined)?.id;
      const from = (src && blockValue(ctx.map, src)) || b;
      out.push(...walk(ctx, from.content ?? [], indent, depth + 1));
    } else if (b.type === 'page') {
      const title = text || 'Untitled';
      put(`- [${title}](https://${ctx.host}/${noDashes(b.id ?? id)})`);
      if (b.parent_id === ctx.pageId) ctx.childPages.push({ id: b.id ?? id, title });
    } else if (b.type === 'alias') {
      const target = (b.format?.alias_pointer as { id?: string } | undefined)?.id;
      if (target) put(`- ${pageLink(ctx.map, target, 'Untitled', ctx.host)}`);
    } else if (b.type === 'collection_view' || b.type === 'collection_view_page') {
      const ref = dbRef(ctx.map, b);
      if (ref) {
        ctx.databases.push(ref);
        sep();
        put(`**Database: ${ref.name}**`);
        put('');
      }
    } else if (b.type === 'text') {
      sep();
      if (text) put(text);
      put('');
      kids('');
    } else if (text && b.type !== 'table_of_contents' && b.type !== 'breadcrumb') {
      sep(); // unknown type, but it carries prose — keep the prose
      put(text);
      put('');
    }
  }
  return out;
}

export function pageToMarkdown(
  map: RecordMap,
  pageId: string,
  host: string,
): PageMarkdown & { filename: string } {
  const root = blockValue(map, pageId);
  const title = richText(root?.properties?.title, map, host) || 'Untitled';
  const ctx: Ctx = { map, pageId, host, seen: new Set([pageId]), childPages: [], databases: [] };
  const lines = [`# ${title}`, ''];
  // A database page holds its rows in the collection, not in content[]. The
  // ref goes first so callers can take databases[0] as the page itself; no
  // `**Database: …**` line for it, the `# title` already names it.
  if (root?.type === 'collection_view_page') {
    const ref = dbRef(map, root);
    if (ref) ctx.databases.push(ref);
  }
  lines.push(...walk(ctx, root?.content ?? [], '', 0));
  const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  return { title, markdown, childPages: ctx.childPages, databases: ctx.databases, filename: captureFilename(host, title) };
}
