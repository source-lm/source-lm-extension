import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './helpers.mjs';

const { parseJson } = await bundle('lib/parser');
const { detectFields } = await bundle('lib/schema-detector');
const { recordToMarkdown, recordTitle, slugify } = await bundle('lib/markdown-generator');
const { buildFiles, uploadedState, groupByBytes } = await bundle('lib/chunker');
const { DEFAULT_SETTINGS, patternPrefix, patternFromPrefix } = await bundle('lib/settings');
const { recordCursor, recordsAfter } = await bundle('lib/cursor');

const settings = (overrides) => ({ ...DEFAULT_SETTINGS, ...overrides });

test('chunker: no record lost or duplicated (by_size, many small files)', () => {
  const records = Array.from({ length: 25 }, (_, i) => ({
    title: `Record ${i}`,
    content: 'x'.repeat(500),
  }));
  const s = settings({ max_words_per_file: 30 });
  const f = detectFields(records, s);
  const result = buildFiles(records, f, s);

  const totalRecords = result.files.reduce((a, file) => a + file.records, 0);
  assert.equal(totalRecords, records.length);
  assert.ok(result.files.length > 1, 'expected packing to produce multiple files');
});

test('chunker: oversized record gets its own file, whole, not truncated', () => {
  // Long single-token content (no whitespace) barely registers in word count,
  // so the "huge" record needs many whitespace-separated words to actually
  // exceed a word budget.
  const hugeContent = Array.from({ length: 2000 }, () => 'word').join(' ');
  const records = [
    { title: 'small', content: 'short text' },
    { title: 'huge', content: hugeContent },
    { title: 'small2', content: 'short text 2' },
  ];
  const s = settings({ max_words_per_file: 50 });
  const f = detectFields(records, s);
  const result = buildFiles(records, f, s);

  const totalRecords = result.files.reduce((a, file) => a + file.records, 0);
  assert.equal(totalRecords, records.length);

  const hugeFile = result.files.find((file) => file.markdown.includes(hugeContent));
  assert.ok(hugeFile, 'huge record must appear whole in some file');
  assert.equal(hugeFile.records, 1);
  assert.ok(
    result.warnings.some((w) => w.includes('longer than max_words_per_file')),
    'expected an oversized-record warning'
  );
});

test('chunker: budget is measured on the rendered file, not raw content', () => {
  const records = Array.from({ length: 10 }, (_, i) => ({
    title: `Item ${i}`,
    content: 'z'.repeat(300),
    author: 'someone',
    status: 'active',
  }));
  const s = settings({ max_words_per_file: 25 });
  const f = detectFields(records, s);
  const result = buildFiles(records, f, s);

  for (const file of result.files) {
    assert.equal(file.chars, file.markdown.length);
    if (file.records > 1 || !result.warnings.some((w) => w.includes(file.filename))) {
      assert.ok(
        file.words <= s.max_words_per_file,
        `${file.filename} is ${file.words} words, budget is ${s.max_words_per_file}`
      );
    }
  }
});

test('chunker: groupByBytes bounds group size, isolates oversized files, preserves order', () => {
  const files = [
    { filename: 'a.md', markdown: 'x'.repeat(40) },
    { filename: 'b.md', markdown: 'x'.repeat(40) },
    { filename: 'c.md', markdown: 'x'.repeat(90) }, // bigger than maxBytes alone
    { filename: 'd.md', markdown: 'x'.repeat(30) },
    { filename: 'e.md', markdown: 'x'.repeat(30) },
  ];
  const maxBytes = 70;
  const groups = groupByBytes(files, maxBytes);

  for (const group of groups) {
    const total = group.reduce((a, f) => a + f.markdown.length, 0);
    if (group.length > 1) assert.ok(total <= maxBytes, `group of ${group.length} exceeds maxBytes`);
  }

  const oversizedGroup = groups.find((g) => g.some((f) => f.filename === 'c.md'));
  assert.equal(oversizedGroup.length, 1, 'oversized file must be alone in its group');

  const flattened = groups.flat();
  assert.deepEqual(flattened.map((f) => f.filename), files.map((f) => f.filename));

  assert.deepEqual(groupByBytes([], maxBytes), []);
});

test('slugify: cyrillic and pure-punctuation input', () => {
  assert.equal(slugify('Привет, мир!'), 'привет-мир');
  assert.equal(slugify('!!!@@@###'), 'record');
});

test('schema-detector: autodetect title/content/metadata split', () => {
  const records = Array.from({ length: 5 }, (_, i) => ({
    title: `Post ${i}`,
    content: 'A'.repeat(300),
    author: 'Ivan',
  }));
  const s = settings({ content_fields: 'auto' });
  const f = detectFields(records, s);

  assert.equal(f.titleField, 'title');
  assert.ok(f.contentFields.includes('content'));
  assert.ok(f.metadataFields.includes('author'));
  assert.ok(!f.metadataFields.includes('title'));
  assert.ok(!f.metadataFields.includes('content'));

  const md = recordToMarkdown(records[0], f, s, true);
  assert.match(md, /^# Post 0/m);
  assert.match(md, /- author: Ivan/);
  assert.equal(recordTitle(records[0], f), 'Post 0');
});

test('parser: invalid JSON throws readable error', async () => {
  assert.throws(() => parseJson('{not json'), /Invalid JSON/);
});

test('parser: finds nested array via priority keys', () => {
  const out = parseJson(JSON.stringify({ meta: {}, data: [{ a: 1 }, { a: 2 }] }));
  assert.equal(out.records.length, 2);
  assert.deepEqual(out.records[0], { a: 1 });
  assert.equal(out.sourceName, '');
});

test('parser: sourceName from root name field drives filename prefix', () => {
  const json = JSON.stringify({
    name: 'Sample chat',
    messages: [
      { id: 1, content: 'first' },
      { id: 2, content: 'second' },
    ],
  });
  const { records, sourceName } = parseJson(json);
  assert.equal(sourceName, 'Sample chat');

  const s = settings({ source_name: sourceName });
  const f = detectFields(records, s);
  const result = buildFiles(records, f, s);
  assert.match(result.files[0].filename, /^sample-chat-001-/);

  const sNoOverride = settings({ source_name: '' });
  const fNoOverride = detectFields(records, sNoOverride);
  const resultNoOverride = buildFiles(records, fNoOverride, sNoOverride);
  assert.match(resultNoOverride.files[0].filename, /^001-/);
});

test('schema-detector: content_fields auto does not lose text when candidate fields are each <50% of the sample', () => {
  // Heterogeneous records: 'content'/'text'/'body' each appear in <50% of records
  // (so the old single-field pickField() picked none), yet every record HAS one
  // of them, non-empty, and short (<=200 chars, so the longStringKeys path never
  // fires either). The text must stay in the body, not silently move to Metadata.
  const records = [
    { title: 'A', content: 'short content A' },
    { title: 'B', text: 'short text B' },
    { title: 'C', content: 'short content C' },
    { title: 'D', text: 'short text D' },
    { title: 'E', body: 'short body E' },
  ];
  const s = settings({ content_fields: 'auto' });
  const f = detectFields(records, s);
  assert.deepEqual(new Set(f.contentFields), new Set(['content', 'text', 'body']));

  const md = recordToMarkdown(records[0], f, s, false);
  assert.match(md, /short content A/);
  assert.doesNotMatch(md, /## Metadata/);
});

test('markdown-generator: id is not duplicated between frontmatter source_id and Metadata', () => {
  const rec = { id: '123', title: 'Title', content: 'body text', category: 'example' };
  const s = settings({});
  const f = detectFields([rec], s);
  const md = recordToMarkdown(rec, f, s, true);
  assert.match(md, /source_id: "123"/);
  assert.doesNotMatch(md, /- id: 123/);
  // unrelated metadata fields still render
  assert.match(md, /- category: example/);
});

test('markdown-generator: rich-text content array (Telegram export) is flattened, not "[object Object]"', () => {
  const rec = {
    id: 1,
    date: '2026-01-01T10:00:00',
    text: ['see ', { type: 'link', text: 'https://example.com' }, ' and ', { type: 'bold', text: 'this' }],
  };
  const s = settings({ content_fields: ['text'] });
  const f = detectFields([rec], s);
  const md = recordToMarkdown(rec, f, s, true);
  assert.match(md, /see https:\/\/example\.com and this/);
  assert.doesNotMatch(md, /\[object Object\]/);
});

test('markdown-generator: object tags (Zotero export) render as labels, and date/tags survive without frontmatter', () => {
  const rec = { id: 1, title: 'T', content: 'x', date: '2026-01-01', tags: [{ tag: 'a' }, { tag: 'b' }] };
  const s = settings({});
  const f = detectFields([rec], s);

  const withFm = recordToMarkdown(rec, f, s, true);
  assert.match(withFm, /tags: \["a", "b"\]/);
  assert.doesNotMatch(withFm, /\[object Object\]/);

  const withoutFm = recordToMarkdown(rec, f, s, false);
  assert.match(withoutFm, /- tags: a, b/);
  assert.match(withoutFm, /- date: 2026-01-01/);
});

test('chunker: packBySize stays fast on large inputs with generous limits (no O(n^2) re-render)', () => {
  const records = Array.from({ length: 20000 }, (_, i) => ({
    title: `Record ${i}`,
    content: 'lorem ipsum dolor sit amet '.repeat(10),
  }));
  const s = settings({ max_words_per_file: 50_000_000 });
  const f = detectFields(records, s);

  const t0 = Date.now();
  const result = buildFiles(records, f, s);
  const elapsedMs = Date.now() - t0;

  const totalRecords = result.files.reduce((a, file) => a + file.records, 0);
  assert.equal(totalRecords, records.length);
  assert.ok(elapsedMs < 5000, `packBySize took ${elapsedMs}ms on 20k records, expected well under 5s`);
});

test('chunker: filename slug skips a batch-first record with a numeric-only title', () => {
  // The first record in the batch (both records fit in one file under the
  // default word budget) has no title, so recordTitle() falls through
  // TITLE_CANDS to the numeric id — the file slug must not degenerate into
  // that number.
  const records = [
    { id: 4037, content: 'no title here' },
    { title: 'Real Title', content: 'second record' },
  ];
  const s = settings({});
  const f = detectFields(records, s);
  const result = buildFiles(records, f, s);

  assert.equal(result.files.length, 1);
  assert.match(result.files[0].filename, /real-title/);
  assert.doesNotMatch(result.files[0].filename, /^001-4037-/);
});

test('chunker+cursor: incremental run continues numbering and skips already-uploaded records, even after repacking', () => {
  // 30 records with dates (the cursor is the date, not an ordinal number), a
  // tight max_words_per_file — several files per run.
  const records = Array.from({ length: 30 }, (_, i) => ({
    date: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    title: `Record ${i}`,
    content: 'x'.repeat(200),
  }));
  const s = settings({ max_words_per_file: 20 });
  const f = detectFields(records, s);

  const firstRun = buildFiles(records, f, s);
  assert.ok(firstRun.files.length >= 3, 'need at least 3 files for the test to check anything');

  // The notebook already has the first 2 files — we recover state from them.
  const existingNames = firstRun.files.slice(0, 2).map((file) => file.filename);
  const alreadyUploaded = firstRun.files.slice(0, 2).reduce((a, file) => a + file.records, 0);

  const state = uploadedState(existingNames, s.filename_pattern, '', records, f);
  assert.equal(state.maxIndex, 2);
  assert.equal(state.cursor, slugify(firstRun.files[1].cursor));

  const toPack = recordsAfter(records, f, state.cursor);
  assert.equal(toPack.length, records.length - alreadyUploaded);

  const secondRun = buildFiles(toPack, f, s, state.maxIndex);
  assert.match(secondRun.files[0].filename, /^003-/);
  assert.equal(
    secondRun.files.reduce((a, file) => a + file.records, 0),
    toPack.length
  );

  // Changing max_words_per_file between runs must not break dedup: the same
  // dataset with new packing (into one file) produces different names, but
  // uploadedState still recognizes the cursor of the freshest record by its
  // slug, not by the filename.
  const repackedSettings = settings({ max_words_per_file: 100_000 });
  const allNamesFromFirstPacking = firstRun.files.map((file) => file.filename);
  const stateAfterRepack = uploadedState(allNamesFromFirstPacking, repackedSettings.filename_pattern, '', records, f);
  assert.equal(stateAfterRepack.cursor, slugify(firstRun.files[firstRun.files.length - 1].cursor));
  assert.equal(recordsAfter(records, f, stateAfterRepack.cursor).length, 0);
});

test('cursor: object-valued dates/ids (MongoDB Extended JSON) stay distinct and ordered', () => {
  const records = [
    { _id: { $oid: 'a1' }, date: { $date: '2024-01-01T10:00:00Z' }, text: 'one' },
    { _id: { $oid: 'a2' }, date: { $date: '2024-01-02T10:00:00Z' }, text: 'two' },
    { _id: { $oid: 'a3' }, date: { $date: '2024-01-03T10:00:00Z' }, text: 'three' },
  ];
  const f = { ...detectFields(records, settings({})), dateField: 'date' };
  const cursors = records.map((r, i) => slugify(recordCursor(r, f, i + 1)));
  assert.equal(new Set(cursors).size, 3, 'no shared "[object Object]" cursor');
  assert.deepEqual(recordsAfter(records, f, cursors[0]), [records[1], records[2]]);
});

test('settings: a legacy pattern without {cursor} is repaired and reconciles', () => {
  const repaired = patternFromPrefix('{source}-{index}.md');
  assert.match(repaired, /\{cursor\}/);

  const records = Array.from({ length: 10 }, (_, i) => ({
    date: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    title: `Record ${i}`,
    content: 'x'.repeat(50),
  }));
  const s = settings({ max_words_per_file: 10, filename_pattern: repaired });
  const f = detectFields(records, s);
  const built = buildFiles(records, f, s);
  assert.ok(built.files.length > 1, 'need multiple files for the test to check anything');

  const names = built.files.map((file) => file.filename);
  const state = uploadedState(names, s.filename_pattern, '', records, f);
  assert.notEqual(state.cursor, null);
  assert.equal(state.maxIndex, names.length);
});

test('settings: patternFromPrefix(patternPrefix(default)) round-trips to the default pattern', () => {
  assert.equal(patternFromPrefix(patternPrefix(DEFAULT_SETTINGS.filename_pattern)), DEFAULT_SETTINGS.filename_pattern);
});
