import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { bundle } from './helpers.mjs';

const { notionPageId, exportTaskBody, unzipEntries, pickPages } = await bundle('lib/notion-export');

// A zip built by hand so the reader is tested against the format, not against
// whatever some fixture file happens to contain. Sizes live only in the central
// directory here — that is where unzipEntries must read them.
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const body = f.method === 8 ? zlib.deflateRawSync(f.data) : f.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.method, 8);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(f.method, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('notion: page id, depth filter and the zip reader', async () => {
  // Synthetic, not a real workspace's id — this repository is public.
  const ID = '0123456789abcdef'.repeat(2);
  const UUID = '01234567-89ab-cdef-0123-456789abcdef';
  assert.equal(notionPageId(`https://www.notion.so/My-Page-${ID}`), UUID);
  // Peek overlay: the pathname holds the parent, "?p=" the page on screen.
  assert.equal(notionPageId(`https://www.notion.so/Parent-${'a'.repeat(32)}?p=${ID}&pm=s`), UUID);
  assert.equal(notionPageId('https://www.notion.so/login'), null);

  const CHILD = 'b'.repeat(32);
  const entry = (path, text) => ({ path, data: Buffer.from(text) });
  const pages = pickPages([
    entry(`Export-xyz/Root ${ID}/Child ${CHILD}.md`, '# Child'),
    entry(`Export-xyz/Root ${ID}/Child ${CHILD}/Grand ${CHILD}.md`, '# Grand'),
    entry(`Export-xyz/Root ${ID}/DB ${CHILD}/Row ${CHILD}.md`, '# Row'),
    entry(`Export-xyz/Root ${ID}/DB ${CHILD}.csv`, 'a,b'),
    entry(`Export-xyz/Root ${ID}.md`, '# Root'),
  ]);
  // Root first even though it came last; grandchild, database row and CSV out.
  assert.deepEqual(
    pages.map((p) => p.title),
    ['Root', 'Child'],
  );
  assert.equal(pages[0].filename, '[notion.so]-root.md');
  assert.equal(pages[1].markdown, '# Child');

  // Box unticked (maxDepth 0): every .md at the shallowest depth, none below.
  assert.deepEqual(
    pickPages(
      [
        entry(`Export-xyz/Root ${ID}.md`, '# Root'),
        entry(`Export-xyz/Sibling ${CHILD}.md`, '# Sibling'),
        entry(`Export-xyz/Root ${ID}/Child ${CHILD}.md`, '# Child'),
      ],
      0,
    ).map((p) => p.title),
    ['Root', 'Sibling'],
  );

  const body = exportTaskBody(UUID, true, 'UTC');
  assert.equal(body.task.request.recursive, true);
  assert.equal(body.task.request.exportOptions.exportType, 'markdown');

  const nested = buildZip([
    { name: `Export-xyz/Root ${ID}/Child ${CHILD}.md`, data: Buffer.from('# Child'), method: 8 },
  ]);
  const zip = buildZip([
    { name: 'Export-xyz/', data: Buffer.alloc(0), method: 0 },
    { name: `Export-xyz/Root ${ID}.md`, data: Buffer.from('# Root'), method: 0 },
    { name: `Export-xyz/Root ${ID}/Notes ${CHILD}.md`, data: Buffer.from('# Notes'.repeat(50)), method: 8 },
    { name: 'nested.zip', data: nested, method: 0 },
  ]);
  const entries = await unzipEntries(new Uint8Array(zip).buffer);
  // Directory entry skipped; the nested zip contributes its inner path.
  assert.deepEqual(entries.map((e) => e.path), [
    `Export-xyz/Root ${ID}.md`,
    `Export-xyz/Root ${ID}/Notes ${CHILD}.md`,
    `Export-xyz/Root ${ID}/Child ${CHILD}.md`,
  ]);
  const text = (i) => Buffer.from(entries[i].data).toString();
  assert.equal(text(0), '# Root');
  assert.equal(text(1), '# Notes'.repeat(50));
  assert.equal(text(2), '# Child');

  // Zips inside zips stop at depth 2 — a wrapper, not a rabbit hole.
  const wrap = (inner) => buildZip([{ name: 'inner.zip', data: inner, method: 0 }]);
  await assert.rejects(
    unzipEntries(new Uint8Array(wrap(wrap(wrap(nested)))).buffer),
    /nested too deep/,
  );
});
