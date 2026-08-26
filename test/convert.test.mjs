import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(__dirname, '../src/lib');
const contentDir = path.join(__dirname, '../src/content');

const result = esbuild.buildSync({
  stdin: {
    contents: `
      export { parseJson } from './parser';
      export { parseTelegramHtml } from './telegram-html';
      export { detectFields } from './schema-detector';
      export { recordToMarkdown, recordTitle, slugify } from './markdown-generator';
      export { buildFiles, uploadedState, groupByBytes } from './chunker';
      export { DEFAULT_SETTINGS, patternPrefix, patternFromPrefix } from './settings';
      export { recordCursor, recordsAfter } from './cursor';
      export { shouldRevalidate, applyValidateResult, licenseVerdict, GRACE_MS, REVALIDATE_AFTER_MS } from './license';
      export { monthKey, trialLeft, spendTrial, FREE_QUOTA, loadTrial } from './license';
      export { parseUrlList } from './url-list';
      export { pageToMarkdown, captureFilename } from './capture';
    `,
    resolveDir: libDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});

const code = result.outputFiles[0].text;
const lib = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const {
  parseJson,
  parseTelegramHtml,
  detectFields,
  recordToMarkdown,
  recordTitle,
  slugify,
  buildFiles,
  uploadedState,
  groupByBytes,
  DEFAULT_SETTINGS,
  patternPrefix,
  patternFromPrefix,
  recordCursor,
  recordsAfter,
  shouldRevalidate,
  applyValidateResult,
  licenseVerdict,
  GRACE_MS,
  REVALIDATE_AFTER_MS,
  monthKey,
  trialLeft,
  spendTrial,
  FREE_QUOTA,
  loadTrial,
  parseUrlList,
  pageToMarkdown,
  captureFilename,
} = lib;

const rpcResult = esbuild.buildSync({
  stdin: {
    contents: `
      export { parseBatchExecute, extractRpcError } from './rpc';
    `,
    resolveDir: contentDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});

const rpcCode = rpcResult.outputFiles[0].text;
const rpc = await import('data:text/javascript;base64,' + Buffer.from(rpcCode).toString('base64'));
const { parseBatchExecute, extractRpcError } = rpc;

const uploaderResult = esbuild.buildSync({
  stdin: {
    contents: `
      export { extractNotebookId, extractSourceId } from './uploader';
    `,
    resolveDir: contentDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});

const uploaderCode = uploaderResult.outputFiles[0].text;
const uploader = await import('data:text/javascript;base64,' + Buffer.from(uploaderCode).toString('base64'));
const { extractNotebookId, extractSourceId } = uploader;

const youtubeResult = esbuild.buildSync({
  stdin: {
    contents: `
      export { extractVideoId, dedupeVideos, findTitle, collectVideos, collectPageVideos, visiblePageRoot } from './youtube';
    `,
    resolveDir: contentDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});

const youtubeCode = youtubeResult.outputFiles[0].text;
const youtube = await import('data:text/javascript;base64,' + Buffer.from(youtubeCode).toString('base64'));
const { extractVideoId, dedupeVideos, findTitle, collectVideos, collectPageVideos, visiblePageRoot } = youtube;

const notebookResult = esbuild.buildSync({
  stdin: {
    contents: `
      export { parseNotebookList, extractCreatedNotebookId, extractSourceUrls, extractSourceNames, youtubeVideoId, deleteSourceParams, handoffJob, sourceDataV1, parseSources, findDuplicateIds } from './notebook';
    `,
    resolveDir: contentDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});

const notebookCode = notebookResult.outputFiles[0].text;
const notebook = await import('data:text/javascript;base64,' + Buffer.from(notebookCode).toString('base64'));
const { parseNotebookList, extractCreatedNotebookId, extractSourceUrls, extractSourceNames, youtubeVideoId, deleteSourceParams, handoffJob, sourceDataV1, parseSources, findDuplicateIds } = notebook;

const youtubeUiResult = esbuild.buildSync({
  stdin: {
    contents: `
      export { currentWatchVideo, notebookTabUrl, isChannelPage, harvestDone, isVideosTabLabel, firstRendered, commentsToMarkdown, collapsedToggle, pendingReplyBlocks, collectCommentThreads, dedupeReplyNodes } from './youtube-ui';
    `,
    resolveDir: contentDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});

const youtubeUiCode = youtubeUiResult.outputFiles[0].text;
const youtubeUi = await import('data:text/javascript;base64,' + Buffer.from(youtubeUiCode).toString('base64'));
const { currentWatchVideo, notebookTabUrl, isChannelPage, harvestDone, isVideosTabLabel, firstRendered, commentsToMarkdown, collapsedToggle, pendingReplyBlocks, collectCommentThreads, dedupeReplyNodes } = youtubeUi;

function settings(overrides) {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

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
  const { parseJson: pj } = lib;
  assert.throws(() => pj('{not json'), /Invalid JSON/);
});

test('parser: finds nested array via priority keys', () => {
  const out = parseJson(JSON.stringify({ meta: {}, data: [{ a: 1 }, { a: 2 }] }));
  assert.equal(out.records.length, 2);
  assert.deepEqual(out.records[0], { a: 1 });
  assert.equal(out.sourceName, '');
});

test('parser: sourceName from root name field drives filename prefix', () => {
  const json = JSON.stringify({
    name: 'Cuenta propia for nomads',
    messages: [
      { id: 1, content: 'first' },
      { id: 2, content: 'second' },
    ],
  });
  const { records, sourceName } = parseJson(json);
  assert.equal(sourceName, 'Cuenta propia for nomads');

  const s = settings({ source_name: sourceName });
  const f = detectFields(records, s);
  const result = buildFiles(records, f, s);
  assert.match(result.files[0].filename, /^cuenta-propia-for-nomads-001-/);

  const sNoOverride = settings({ source_name: '' });
  const fNoOverride = detectFields(records, sNoOverride);
  const resultNoOverride = buildFiles(records, fNoOverride, sNoOverride);
  assert.match(resultNoOverride.files[0].filename, /^001-/);
});

test('telegram-html: parses default/joined/service/media messages and feeds the incremental pipeline unchanged', () => {
  const html = `<!DOCTYPE html>
<html><head><title>Test Chat</title></head>
<body>
<div class="page_header">nav noise</div>
<div class="message service" id="message1">
<div class="body details">
Someone created the group
</div>
</div>
<div class="message default clearfix" id="message2">
<div class="pull_left userpic_wrap"><img class="userpic" src="photos/a.jpg"/></div>
<div class="body">
<div class="pull_right date details" title="9 September 2020, 18:44:51">18:44</div>
<div class="from_name">
Jane Roe
</div>
<div class="reply_to details">In reply to <a href="#go_to_message1">a message</a></div>
<div class="text">
&quot;Hello&quot; &amp; welcome 😀 &laquo;q&raquo; &amp;lt;<br>second line <a href="https://example.com">https://example.com</a>
</div>
</div>
</div>
<div class="message default clearfix joined" id="message3">
<div class="body">
<div class="pull_right date details" title="9 September 2020, 18:45:18">18:45</div>
<div class="forwarded_from details">Forwarded from Example Channel</div>
<div class="text">
Reposted text
</div>
</div>
</div>
<div class="message default clearfix" id="message4">
<div class="pull_left userpic_wrap"><img class="userpic" src="photos/b.jpg"/></div>
<div class="body">
<div class="pull_right date details" title="9 September 2020, 18:46:00">18:46</div>
<div class="from_name">
John Doe
</div>
<div class="media clearfix pull_left media_photo">
<div class="title bold">Photo</div>
</div>
</div>
</div>
</body></html>`;

  const { records, sourceName } = parseTelegramHtml(html);

  assert.equal(sourceName, 'Test Chat');
  assert.equal(records.length, 3, 'the service message must be skipped');

  assert.equal(records[0].date, '2020-09-09T18:44:51');
  // id mirrors the Telegram JSON export's "id" — without it every record
  // renders as "Untitled" (TITLE_CANDS has no match).
  assert.equal(records[0].id, 2);
  assert.equal(records[0].from, 'Jane Roe');
  assert.equal(records[0].text, '"Hello" & welcome \u{1F600} «q» &lt;\nsecond line https://example.com');

  // No from_name on the joined message — author carried from the previous one.
  assert.equal(records[1].from, 'Jane Roe');
  assert.equal(records[1].text, 'Forwarded from Example Channel:\nReposted text');

  assert.equal(records[2].from, 'John Doe');
  assert.equal(records[2].text, '[Photo]');

  // Same {records, sourceName} shape as parseJson output — the incremental
  // path (uploadedState/recordsAfter, DECISIONS.md #13) must dedup these by
  // date exactly as it does for JSON-sourced records.
  const s = settings({});
  const f = detectFields(records, s);
  assert.equal(f.dateField, 'date');

  const cursor = slugify(records[0].date);
  const after = recordsAfter(records, f, cursor);
  assert.equal(after.length, 2, 'records at-or-before the cursor date are dropped');
  assert.deepEqual(after, [records[1], records[2]]);

  const built = buildFiles(records, f, s);
  const names = built.files.map((file) => file.filename);
  const state = uploadedState(names, s.filename_pattern, '', records, f);
  assert.equal(recordsAfter(records, f, state.cursor).length, 0, 'a full prior upload leaves nothing new');

  // Telegram Desktop variant: generic <title>, chat name in the page header,
  // numeric DD.MM.YYYY dates, forwards nested in a `forwarded body` div.
  const desktop = `<html><head><title>Exported Data</title></head><body>
<div class="page_wrap">
<div class="page_header"><div class="content"><div class="text bold">
Test Chat
</div></div></div>
<div class="message default clearfix" id="message7">
<div class="body">
<div class="pull_right date details" title="09.09.2020 18:44:51 UTC+01:00">18:44</div>
<div class="from_name">
Jane Roe
</div>
<div class="forwarded body">
<div class="from_name">
Example Channel<span class="date details" title="08.09.2020 10:00:00 UTC+01:00"> 08.09.2020 10:00:00</span>
</div>
<div class="text">
Reposted text
</div>
</div>
</div>
</div>
</div></body></html>`;
  const dt = parseTelegramHtml(desktop);
  assert.equal(dt.sourceName, 'Test Chat');
  assert.deepEqual(dt.records, [
    { date: '2020-09-09T18:44:51', from: 'Jane Roe', text: 'Forwarded from Example Channel:\nReposted text', id: 7 },
  ]);
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

test('rpc: parseBatchExecute strips anti-XSSI prefix and parses chunks of varying length', () => {
  const chunkA = JSON.stringify(['wrb.fr', 'rpcId1', '["ok"]', null, null, null, 'generic']);
  const chunkB = JSON.stringify(['di', 12]);
  const raw = `)]}'\n${chunkA.length}\n${chunkA}\n${chunkB.length}\n${chunkB}\n`;

  const chunks = parseBatchExecute(raw);

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], ['wrb.fr', 'rpcId1', '["ok"]', null, null, null, 'generic']);
  assert.deepEqual(chunks[1], ['di', 12]);
});

test('rpc: extractRpcError reads error code 3 (INVALID_ARGUMENT) from an HTTP-200 payload', () => {
  // Shape mirrors errors.py: ["wrb.fr", rpcId, result, ..., errorPayload, "generic"]
  // errorPayload = [code, null, [[detailTypeUrl, detailData]]]
  const item = [
    'wrb.fr',
    'someRpcId',
    null,
    null,
    null,
    [3, null, [['type.googleapis.com/some.DeepResearchErrorDetail', [4]]]],
    'generic',
  ];

  const error = extractRpcError(item);

  assert.ok(error);
  assert.equal(error.code, 3);
  assert.match(error.message, /code 3/);
});

test('rpc: extractRpcError returns null when the response has no error payload', () => {
  const item = ['wrb.fr', 'someRpcId', '["result value"]', null, null, null, 'generic'];

  assert.equal(extractRpcError(item), null);
});

test('uploader: extractNotebookId reads the id out of /notebook/<id> paths, ignoring query/hash', () => {
  assert.equal(extractNotebookId('/notebook/abc-123'), 'abc-123');
  assert.equal(extractNotebookId('/notebook/abc-123?tab=sources'), 'abc-123');
  assert.equal(extractNotebookId('/notebook/abc-123#frag'), 'abc-123');
  assert.equal(extractNotebookId('/'), null);
  assert.equal(extractNotebookId('/notebook/'), null);
});

test('uploader: extractSourceId descends nested arrays to the first string', () => {
  assert.equal(extractSourceId([[['source-id-1']], 'title']), 'source-id-1');
  assert.equal(extractSourceId('plain-id'), 'plain-id');
  assert.equal(extractSourceId([[[]], 'title']), null);
  assert.equal(extractSourceId(null), null);
});

test('youtube: extractVideoId reads v= from watch links in various forms', () => {
  assert.equal(extractVideoId('/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('/watch?v=dQw4w9WgXcQ&list=PL123'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('/watch?v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('/watch?list=PL123&v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=abc123&t=10'), 'abc123');
  assert.equal(extractVideoId('/results?search_query=cats'), null);
});

test('youtube: dedupeVideos keeps first occurrence and drops repeats by videoId', () => {
  const videos = [
    { videoId: 'a', title: 'First A', url: 'https://www.youtube.com/watch?v=a' },
    { videoId: 'b', title: 'B', url: 'https://www.youtube.com/watch?v=b' },
    { videoId: 'a', title: 'Second A (thumbnail link)', url: 'https://www.youtube.com/watch?v=a' },
  ];
  const result = dedupeVideos(videos);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((v) => v.videoId), ['a', 'b']);
  assert.equal(result[0].title, 'First A');
});

test('youtube: dedupeVideos backfills an empty title from a later duplicate', () => {
  const videos = [
    { videoId: 'A', title: '', url: 'u1' },
    { videoId: 'A', title: 'Real Title', url: 'u2' },
  ];
  const result = dedupeVideos(videos);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'Real Title');
  assert.equal(result[0].url, 'u1');
});

test('youtube: findTitle walks the layout ladder and never takes thumbnail text as a title', () => {
  // Stub anchor: only the four DOM members findTitle actually touches.
  const anchor = ({ isTitleEl = false, text = '', attrs = {}, headingLabel = null, inHeading = false } = {}) => ({
    textContent: text,
    matches: (sel) => isTitleEl && sel === '#video-title',
    querySelector: () => null,
    getAttribute: (name) => attrs[name] ?? null,
    closest: () => (inHeading || headingLabel !== null ? { getAttribute: () => headingLabel } : null),
  });

  // ytd-video-renderer: the anchor IS <a id="video-title"> — descendant-only lookup missed it.
  assert.equal(findTitle(anchor({ isTitleEl: true, text: 'Renderer Title' })), 'Renderer Title');

  // yt-lockup-view-model: no id, no title/aria-label attrs, no heading aria-label — the title link
  // still lives inside a heading, so its own text is taken.
  assert.equal(findTitle(anchor({ text: 'Lockup Title', inHeading: true })), 'Lockup Title');

  // Thumbnail anchor points at /watch?v= too and has text, but sits outside any heading —
  // its text must not become a title.
  assert.equal(findTitle(anchor({ text: '48:59 48:59 Now playing' })), '');

  // Attributes and the wrapping heading's aria-label still outrank the anchor's own text.
  assert.equal(findTitle(anchor({ text: 'junk', attrs: { title: 'Attr Title' } })), 'Attr Title');
  assert.equal(findTitle(anchor({ text: 'junk', attrs: { 'aria-label': 'Aria Title' } })), 'Aria Title');
  assert.equal(findTitle(anchor({ text: 'junk', headingLabel: 'Heading Title' })), 'Heading Title');
  assert.equal(findTitle(anchor({})), '');
});

test('youtube: collectVideos skips playlist header action buttons ("Play all") that point at the first video', () => {
  // The header "Play all" anchor comes before the real video row in DOM
  // order and shares the first video's id — without the closest() guard it
  // would win the dedupe and rename the real video.
  const headerAnchor = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=abc123' : name === 'aria-label' ? 'Play all' : null),
    matches: () => false,
    querySelector: () => null,
    closest: (sel) => (sel.includes('yt-page-header-renderer') ? {} : null),
  };
  const realAnchor = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=abc123' : null),
    matches: () => false,
    querySelector: () => null,
    closest: (sel) => (sel === 'h3, h4' ? { getAttribute: () => null } : null),
    textContent: 'Real Video Title',
  };
  const root = { querySelectorAll: () => [headerAnchor, realAnchor] };

  const videos = collectVideos(root);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].title, 'Real Video Title');
});

test('youtube: collectVideos skips the playlist header hero thumbnail link (yt-page-header-view-model), titled with the playlist name', () => {
  // Current playlist layout uses a view-model header, not the -renderer one
  // covered above — the hero link is a /watch?v= anchor for the first video
  // titled with the playlist name ("Decaf"), which would otherwise rename
  // the real video via the dedupe backfill.
  const heroAnchor = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=abc123' : null),
    matches: () => false,
    querySelector: () => null,
    closest: (sel) => (sel.includes('yt-page-header-view-model') ? {} : null),
    textContent: 'Decaf',
  };
  const realAnchor = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=abc123' : null),
    matches: () => false,
    querySelector: () => null,
    closest: (sel) => (sel === 'h3, h4' ? { getAttribute: () => null } : null),
    textContent: 'Real Video Title',
  };
  const root = { querySelectorAll: () => [heroAnchor, realAnchor] };

  const videos = collectVideos(root);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].title, 'Real Video Title');
});

test('youtube: collectVideos drops title-less duplicates (thumbnail-only anchors)', () => {
  // (a) has both a thumbnail anchor (junk text, no heading) and a title
  // link (real title, inside a heading) — dedupe backfills the real title.
  // (b) only ever gets a thumbnail anchor — after dedupe it stays title-less
  // and must be dropped instead of falling back to "Video b".
  const thumbA = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=a' : null),
    matches: () => false,
    querySelector: () => null,
    closest: () => null,
    textContent: '3:14 3:14 Now playing',
  };
  const titleA = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=a' : null),
    matches: () => false,
    querySelector: () => null,
    closest: (sel) => (sel === 'h3, h4' ? { getAttribute: () => null } : null),
    textContent: 'Real A Title',
  };
  const thumbB = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=b' : null),
    matches: () => false,
    querySelector: () => null,
    closest: () => null,
    textContent: '1:23 1:23 Now playing',
  };
  const root = { querySelectorAll: () => [thumbA, titleA, thumbB] };

  const videos = collectVideos(root);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].videoId, 'a');
  assert.equal(videos[0].title, 'Real A Title');
});

test('youtube: visiblePageRoot picks the non-hidden ytd-page-manager child, falls back to the document when the selector misses', () => {
  const visibleChild = { hidden: false };
  const docWithPages = { querySelector: (sel) => (sel === 'ytd-page-manager > :not([hidden])' ? visibleChild : null) };
  assert.equal(visiblePageRoot(docWithPages), visibleChild);

  // A renamed/missing container must degrade to the document, not an empty root.
  const docWithoutMatch = { querySelector: () => null };
  assert.equal(visiblePageRoot(docWithoutMatch), docWithoutMatch);
});

test('youtube-ui: firstRendered skips the hidden copies YouTube leaves behind after SPA navigation', () => {
  const stale = { getClientRects: () => ({ length: 0 }) };
  const live = { getClientRects: () => ({ length: 1 }) };
  assert.equal(firstRendered([stale, live]), live);
  assert.equal(firstRendered([stale, stale]), null);
  assert.equal(firstRendered([]), null);
});

test('youtube: collectPageVideos on /watch allowlists the current video + playlist panel, ignoring page junk', () => {
  const current = { videoId: 'cur1', title: 'Current Video', url: 'https://www.youtube.com/watch?v=cur1' };

  // A root full of /watch?v= junk (player "Next" control) and no playlist
  // panel — collectVideos(root) is never even called, so the junk anchor
  // can't leak in.
  const junkAnchor = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=next1' : null),
    matches: () => false,
    querySelector: () => null,
    closest: () => null,
    textContent: 'Next (SHIFT+n)',
  };
  const rootNoPanel = {
    querySelectorAll: () => [junkAnchor],
    querySelector: () => null,
  };
  assert.deepEqual(collectPageVideos(rootNoPanel, '/watch', current), [current]);

  // A playlist panel present: its own anchors are scanned via collectVideos,
  // and the result is appended after the current video.
  const panelAnchor = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=panel1' : null),
    matches: () => false,
    querySelector: () => null,
    closest: (sel) => (sel === 'h3, h4' ? { getAttribute: () => null } : null),
    textContent: 'Panel Video',
  };
  const panel = { querySelectorAll: () => [panelAnchor] };
  const rootWithPanel = {
    querySelectorAll: () => [junkAnchor],
    querySelector: () => panel,
  };
  const videos = collectPageVideos(rootWithPanel, '/watch', current);
  assert.deepEqual(videos, [current, { videoId: 'panel1', title: 'Panel Video', url: 'https://www.youtube.com/watch?v=panel1' }]);
});

test('youtube: collectPageVideos falls through to the page-wide scan off /watch', () => {
  const realAnchor = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=real1' : null),
    matches: () => false,
    querySelector: () => null,
    closest: (sel) => (sel === 'h3, h4' ? { getAttribute: () => null } : null),
    textContent: 'Real Video Title',
  };
  const root = { querySelectorAll: () => [realAnchor] };

  const videos = collectPageVideos(root, '/playlist', null);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].videoId, 'real1');
});

test('notebook: parseNotebookList reads id/title/emoji from wXbhsf response, ignoring malformed entries', () => {
  const result = [
    [
      ['Notebook One', [], 'nb-1', '☕', null, [1]],
      ['Notebook Two', [], 'nb-2', null, null, [1]],
      ['broken'],
    ],
  ];
  const notebooks = parseNotebookList(result);
  assert.deepEqual(notebooks, [
    { id: 'nb-1', title: 'Notebook One', emoji: '☕' },
    { id: 'nb-2', title: 'Notebook Two' },
  ]);
});

test('notebook: extractCreatedNotebookId reads CCqFvf result[2]', () => {
  assert.equal(extractCreatedNotebookId(['Title', null, 'new-nb-id']), 'new-nb-id');
  assert.equal(extractCreatedNotebookId(['Title', null]), null);
  assert.equal(extractCreatedNotebookId(null), null);
});

test('notebook: handoffJob re-arms a create-new job as a plain add-to-notebook job', () => {
  const job = {
    type: 'ADD_YOUTUBE',
    videos: [{ videoId: 'abc', title: 'Video', url: 'https://www.youtube.com/watch?v=abc' }],
    createdAt: 12345,
    createTitle: 'My new notebook',
  };
  const result = handoffJob(job, 'new-nb-id');
  assert.equal(result.targetNotebookId, 'new-nb-id');
  assert.equal('createTitle' in result, false);
  assert.deepEqual(result.videos, job.videos);
  assert.equal(result.createdAt, job.createdAt);
});

test('notebook: extractSourceUrls covers both the YouTube (metadata[5][0]) and web (metadata[7][0]) url slots in rLM1Ne response', () => {
  const getNotebookResult = [
    [
      'Notebook title',
      [
        // YouTube source: metadata[4] = 9 (type), url at metadata[5][0].
        [
          ['src-1'],
          'James Hoffmann video',
          [
            null,
            3770,
            ['ts'],
            ['uuid', ['ts']],
            9,
            ['https://www.youtube.com/watch?v=NxklrAQfupw', 'NxklrAQfupw', 'James Hoffmann'],
            1,
            null,
            4261,
            null,
            null,
            null,
            null,
            null,
            ['ts'],
          ],
          [null, 2],
        ],
        // Web source: url at metadata[7][0].
        [['src-2'], 'Some Article', [null, null, null, null, 4, null, null, ['https://example.com/article']]],
        // No URL at all.
        [['src-3'], 'No URL source', [null, null, null, null, 1]],
      ],
    ],
  ];
  assert.deepEqual(extractSourceUrls(getNotebookResult), [
    'https://www.youtube.com/watch?v=NxklrAQfupw',
    'https://example.com/article',
  ]);
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

test('notebook: youtubeVideoId reads the id from watch/short/embed/youtu.be URL forms', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=abc123&t=10'), 'abc123');
  assert.equal(youtubeVideoId('https://youtu.be/abc123'), 'abc123');
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/abc123'), 'abc123');
  assert.equal(youtubeVideoId('https://www.youtube.com/embed/abc123'), 'abc123');
  assert.equal(youtubeVideoId('https://example.com/not-youtube'), null);
});

test('notebook: extractSourceNames recursively collects only .md filenames from an rLM1Ne-shaped response', () => {
  const result = [
    [
      'Notebook title',
      [
        [['src-1'], '001-first-source.md', [null, null, null, ['irrelevant string']]],
        [['src-2'], 'Not a markdown file', [null, null, null, 'https://example.com/page']],
        [['src-3'], '002-second-source.md', [null]],
      ],
    ],
  ];
  assert.deepEqual(extractSourceNames(result), ['001-first-source.md', '002-second-source.md']);
});

test('notebook: deleteSourceParams wraps each id in its own array for tGMBJ', () => {
  assert.deepEqual(deleteSourceParams(['a', 'b']), [[['a'], ['b']], [2]]);
});

test('notebook: sourceDataV1 wraps the URL in its own array at slot 2 for web sources, slot 7 for YouTube', () => {
  const url = 'https://example.com/article';
  const web = sourceDataV1(url, 2);
  assert.deepEqual(web[2], [url]);
  assert.equal(web[7], null);
  assert.equal(web[10], 1);

  const youtube = sourceDataV1(url, 7);
  assert.deepEqual(youtube[7], [url]);
  assert.equal(youtube[2], null);
  assert.equal(youtube[10], 1);
});

test('youtube-ui: currentWatchVideo extracts id+title, notebookTabUrl builds /notebook/<id> vs bare origin', () => {
  const video = currentWatchVideo(
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42s',
    'Never Gonna Give You Up - YouTube',
  );
  assert.deepEqual(video, {
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  assert.equal(currentWatchVideo('https://www.youtube.com/results?search_query=cats', 'x'), null);

  assert.equal(notebookTabUrl('https://notebooklm.google.com', 'nb-1'), 'https://notebooklm.google.com/notebook/nb-1');
  assert.equal(notebookTabUrl('https://notebooklm.google.com/'), 'https://notebooklm.google.com/');
});

test('youtube-ui: isChannelPage matches all channel URL forms, harvestDone stops at the limit/on stall and keeps going while growing', () => {
  assert.equal(isChannelPage('/@jameshoffmann'), true);
  assert.equal(isChannelPage('/@jameshoffmann/videos'), true);
  assert.equal(isChannelPage('/channel/UCabc123'), true);
  assert.equal(isChannelPage('/c/SomeChannel'), true);
  assert.equal(isChannelPage('/user/SomeUser'), true);
  assert.equal(isChannelPage('/watch'), false);
  assert.equal(isChannelPage('/playlist'), false);

  // Count still growing: keep scrolling regardless of stall counter.
  assert.equal(harvestDone(10, 20, 0, 50), false);
  // Limit reached: stop even mid-growth.
  assert.equal(harvestDone(40, 50, 0, 50), true);
  assert.equal(harvestDone(40, 60, 0, 50), true);
  // Two stalled rounds in a row (count didn't grow): stop short of the limit.
  assert.equal(harvestDone(20, 20, 2, 50), true);
  // Only one stall so far: keep going.
  assert.equal(harvestDone(20, 20, 1, 50), false);
});

test('youtube-ui: isVideosTabLabel matches the Videos tab label only, not tabs that merely mention the word', () => {
  assert.equal(isVideosTabLabel('Videos'), true);
  assert.equal(isVideosTabLabel('videos'), true);
  assert.equal(isVideosTabLabel(' Видео '), true);
  assert.equal(isVideosTabLabel('Home'), false);
  assert.equal(isVideosTabLabel('Shorts'), false);
  assert.equal(isVideosTabLabel('Playlists'), false);
  assert.equal(isVideosTabLabel('Live'), false);
  assert.equal(isVideosTabLabel('Popular videos'), false);
});

test('license: shouldRevalidate triggers once checkedAt is stale', () => {
  const now = Date.now();
  const stale = { key: 'k', instanceId: 'i', valid: true, checkedAt: now - REVALIDATE_AFTER_MS - 1 };
  assert.equal(shouldRevalidate(stale, now), true);
});

test('license: shouldRevalidate stays false while checkedAt is fresh', () => {
  const now = Date.now();
  const fresh = { key: 'k', instanceId: 'i', valid: true, checkedAt: now - 1000 };
  assert.equal(shouldRevalidate(fresh, now), false);
});

test('license: shouldRevalidate re-checks a lapsed (invalid) state too, so it can self-heal', () => {
  const now = Date.now();
  const lapsed = { valid: false, checkedAt: now - REVALIDATE_AFTER_MS - 1 };
  assert.equal(shouldRevalidate(lapsed, now), true);
});

test('license: shouldRevalidate is false for a null state', () => {
  assert.equal(shouldRevalidate(null, Date.now()), false);
});

test('license: licenseVerdict reads a 404 (unknown key or wrong organization) as a definitive no', () => {
  assert.equal(licenseVerdict(404, { error: 'ResourceNotFound' }, Date.now()), 'invalid');
});

test('license: licenseVerdict reads a revoked key as invalid, a granted one as valid', () => {
  const now = Date.now();
  assert.equal(licenseVerdict(200, { status: 'revoked' }, now), 'invalid');
  assert.equal(licenseVerdict(200, { status: 'granted' }, now), 'valid');
});

test('license: licenseVerdict honours expires_at even while the key still reads granted', () => {
  const now = Date.now();
  assert.equal(licenseVerdict(200, { status: 'granted', expires_at: new Date(now - 1000).toISOString() }, now), 'invalid');
  assert.equal(licenseVerdict(200, { status: 'granted', expires_at: new Date(now + 1000).toISOString() }, now), 'valid');
});

test('license: licenseVerdict treats a server error or unparseable body as unknown, not as a revocation', () => {
  const now = Date.now();
  assert.equal(licenseVerdict(500, null, now), 'unknown');
  assert.equal(licenseVerdict(429, { detail: 'slow down' }, now), 'unknown');
  assert.equal(licenseVerdict(200, null, now), 'unknown');
});

test('license: applyValidateResult flips to invalid on an invalid verdict', () => {
  const now = Date.now();
  const s = { key: 'k', instanceId: 'i', valid: true, checkedAt: now - 1000 };
  const next = applyValidateResult(s, 'invalid', now);
  assert.equal(next.valid, false);
  assert.equal(next.checkedAt, now);
});

test('license: applyValidateResult fails open on an unknown verdict within the grace window', () => {
  const now = Date.now();
  const checkedAt = now - GRACE_MS + 1000;
  const s = { key: 'k', instanceId: 'i', valid: true, checkedAt };
  const next = applyValidateResult(s, 'unknown', now);
  assert.equal(next.valid, true);
  assert.equal(next.checkedAt, checkedAt, 'checkedAt must not move while still within grace');
});

test('license: applyValidateResult flips to invalid on an unknown verdict past the grace window', () => {
  const now = Date.now();
  const s = { key: 'k', instanceId: 'i', valid: true, checkedAt: now - GRACE_MS - 1000 };
  const next = applyValidateResult(s, 'unknown', now);
  assert.equal(next.valid, false);
});

test('license: spendTrial exhausts the monthly quota, and a previous-month state reads back as full', () => {
  const now = Date.now();
  let t = null;
  for (let i = 0; i < FREE_QUOTA; i++) {
    assert.equal(trialLeft(t, now) > 0, true, `unit ${i + 1} should still be available`);
    t = spendTrial(t, now);
  }
  assert.equal(trialLeft(t, now), 0, 'a 4th use must be blocked');

  const lastMonth = { month: monthKey(now - 31 * 24 * 60 * 60 * 1000), used: FREE_QUOTA };
  assert.equal(trialLeft(lastMonth, now), FREE_QUOTA, 'a new month resets the quota');
});

test('license: loadTrial re-reads storage on every call, does not cache stale state module-wide', async () => {
  // globalThis.chrome is unused elsewhere in this file — restored below.
  let stored = { used: 1 };
  globalThis.chrome = { storage: { sync: { get: async () => ({ trial: stored }) } } };
  try {
    const first = await loadTrial();
    assert.equal(first.used, 1);

    // Mutate storage behind loadTrial's back — a module-level cache would
    // still return the stale `used: 1` read above.
    stored = { used: 3 };
    const second = await loadTrial();
    assert.equal(second.used, 3, 'loadTrial must re-read storage, not return a cached value');
  } finally {
    delete globalThis.chrome;
  }
});

test('url-list: parseUrlList keeps http(s) URLs from newlines/commas, drops junk, dedupes, preserves trailing slash', () => {
  const input = [
    'https://example.com/a',
    'not a url',
    'http://example.com/b, https://example.com/c',
    '',
    '  https://example.com/a  ',
    'ftp://example.com/skip',
    'https://example.com/d/',
  ].join('\n');

  assert.deepEqual(parseUrlList(input), [
    'https://example.com/a',
    'http://example.com/b',
    'https://example.com/c',
    'https://example.com/d/',
  ]);
  assert.deepEqual(parseUrlList('   \n  '), []);
});

test('notebook: parseSources reads id/title/type/status from rLM1Ne and keeps urls slot-agnostic', () => {
  const result = [
    [
      'Notebook title',
      [
        // Web source: type at metadata[4] = 5, url at metadata[7][0], status 2 (ready).
        [
          ['w-1'],
          'Kortex',
          [null, 1200, ['ts'], ['uuid', ['ts']], 5, null, 1, ['https://kortex.co/'], 3300],
          [null, 2],
        ],
        // YouTube source: type 9, url at metadata[5][0] — a different slot,
        // which is exactly why urls are collected recursively, not indexed.
        [
          ['y-1'],
          'James Hoffmann video',
          [null, 3770, ['ts'], ['uuid', ['ts']], 9, ['https://youtu.be/NxklrAQfupw', 'NxklrAQfupw', 'JH'], 1],
          [null, 3],
        ],
        // Uploaded .md: no url anywhere, and the type/status slots hold
        // something that is not an int — both must read back as undefined.
        [['m-1'], 'export-1.md', [null, 10, ['ts'], ['uuid'], null], [null, null]],
        // Junk entries must be skipped, not throw.
        'not a source',
        [[], 'no id'],
      ],
    ],
  ];

  assert.deepEqual(parseSources(result), [
    { id: 'w-1', title: 'Kortex', type: 5, status: 2, urls: ['https://kortex.co/'] },
    { id: 'y-1', title: 'James Hoffmann video', type: 9, status: 3, urls: ['https://youtu.be/NxklrAQfupw'] },
    { id: 'm-1', title: 'export-1.md', type: undefined, status: undefined, urls: [] },
  ]);

  assert.deepEqual(parseSources(null), []);
  assert.deepEqual(parseSources([[]]), []);
});

test('notebook: findDuplicateIds keeps the first of each group, matching on url then title', () => {
  const sources = [
    { id: 'a', title: 'Kortex', urls: ['https://kortex.co/'] },
    // Same page, trailing slash only — must still count as a duplicate.
    { id: 'b', title: 'Kortex (copy)', urls: ['https://kortex.co'] },
    { id: 'c', title: 'export-1.md', urls: [] },
    // Same title, no url at all — the .md fallback key.
    { id: 'd', title: 'export-1.md', urls: [] },
    { id: 'e', title: 'export-2.md', urls: [] },
    { id: 'f', title: 'Other page', urls: ['https://example.com/a'] },
  ];

  assert.deepEqual(findDuplicateIds(sources), ['b', 'd']);
  assert.deepEqual(findDuplicateIds([]), []);
});

test('notebook: extractSourceUrls drops the per-source Google-internal download links of uploaded files', () => {
  const entry = [
    ['id-1'],
    'export-1.md',
    [null, 169, null, null, 8, null, 1, null, 308, null, null, null, null, null, null, null, null, null, null, 'text/markdown'],
    [null, 2],
    null,
    'https://contribution.usercontent.google.com/download?c=AbC&filename=export-1.md.md&opi=1',
    'https://drive.google.com/viewer/upload?ds=XyZ',
  ];
  // Two uploads of the same file differ only in those tokens — without the
  // filter they would never be detected as duplicates.
  assert.deepEqual(extractSourceUrls(entry), []);
  assert.deepEqual(extractSourceUrls(['https://docs.google.com/document/d/1/edit']), ['https://docs.google.com/document/d/1/edit']);
});

test('youtube-ui: collapsedToggle picks the rendered "N replies" button and ignores aria-expanded', () => {
  // Live markup: the old #more-replies sits under a hidden #expander (no
  // rects), the sub-thread button is rendered while collapsed and carries an
  // inverted aria-expanded="true"; after a click it stops rendering.
  const btn = (id, rects, ariaExpanded) => ({
    id,
    getClientRects: () => ({ length: rects }),
    getAttribute: (name) => (name === 'aria-expanded' ? ariaExpanded : null),
  });
  const block = (...buttons) => ({ querySelectorAll: () => buttons });
  const collapsed = block(btn('more-replies', 0, null), btn('more-replies-sub-thread', 1, 'true'));
  assert.equal(collapsedToggle(collapsed)?.id, 'more-replies-sub-thread');
  const expanded = block(btn('more-replies', 0, null), btn('more-replies-sub-thread', 0, 'false'));
  assert.equal(collapsedToggle(expanded), null);
  assert.equal(collapsedToggle(block()), null);
});

// Clicking "N replies" only requests the replies: YouTube removes the toggle
// button immediately and leaves a lazy <ytd-continuation-item-renderer> that
// fetches once it scrolls into view. The old filter also required a rendered
// toggle, so a block mid-fetch (no toggle, no replies yet) was dropped and
// never retried — this is the regression this test guards against.
test('youtube-ui: pendingReplyBlocks keeps a block whose toggle was already clicked but whose replies have not arrived, and flattens across threads', () => {
  const replyBlock = (hasReplyNode) => ({
    querySelector: () => (hasReplyNode ? { tag: 'ytd-comment-view-model' } : null),
  });
  const pendingContinuation = replyBlock(false); // toggle already clicked, only a lazy continuation-item-renderer left
  const pendingToggle = replyBlock(false); // toggle still rendered, replies not requested yet
  const alreadyHasReplies = replyBlock(true);
  const threadA = { querySelectorAll: () => [pendingContinuation, pendingToggle] };
  const threadB = { querySelectorAll: () => [alreadyHasReplies] };

  const result = pendingReplyBlocks([threadA, threadB]);

  assert.equal(result.length, 2);
  assert.ok(result.includes(pendingContinuation), 'a block mid-fetch with no toggle must stay pending');
  assert.ok(result.includes(pendingToggle), 'a block with a rendered toggle and no replies is still pending');
  assert.ok(!result.includes(alreadyHasReplies), 'a block that already has a comment view-model is done');
});

// YouTube reuses one continuation renderer per reply block: once its
// pagination token is exhausted, clicking "Show more replies" again
// re-appends the same already-delivered replies as fresh duplicate DOM
// nodes, so collectCommentThreads must dedupe by author|text, not by node.
test('youtube-ui: collectCommentThreads dedupes replies by author|text within a thread, first occurrence wins', () => {
  const commentEl = (author, text, likes) => ({
    querySelector: (sel) => {
      if (sel === '#author-text') return { textContent: author };
      if (sel === '#content-text') return { textContent: text };
      if (sel === '#vote-count-middle') return likes ? { textContent: likes } : null;
      return null;
    },
  });

  const top = commentEl('@alice', 'top level comment', '10');
  const repeated1 = commentEl('@bob', 'nice video');
  const repeated2 = commentEl('@bob', 'nice video'); // re-appended by the exhausted continuation
  const repeated3 = commentEl('@bob', 'nice video'); // re-appended again
  const distinct = commentEl('@carol', 'totally different');
  const sameTextA = commentEl('@dave', 'shared wording');
  const sameTextB = commentEl('@erin', 'shared wording'); // same text, different author: not a duplicate

  const thread = {
    ...top,
    querySelectorAll: () => [repeated1, repeated2, repeated3, distinct, sameTextA, sameTextB],
  };
  const box = { querySelectorAll: () => [thread] };

  const result = collectCommentThreads(box);

  assert.equal(result.length, 1);
  assert.equal(result[0].author, '@alice');
  assert.equal(result[0].text, 'top level comment');
  assert.deepEqual(
    result[0].replies.map((r) => `${r.author}|${r.text}`),
    ['@bob|nice video', '@carol|totally different', '@dave|shared wording', '@erin|shared wording'],
  );
});

// Regression: the exhausted continuation re-appends the same replies as fresh DOM
// nodes when "Show more replies" is clicked again. dedupeReplyNodes must remove
// the page's duplicate nodes (not just the harvested output), remove the wrapping
// sub-thread renderer when one exists, and reset its "seen" set per thread.
test('youtube-ui: dedupeReplyNodes removes duplicate reply nodes from the page, per thread', () => {
  const replyNode = (author, text, sub) => {
    const node = {
      removed: false,
      remove() { node.removed = true; },
      closest: () => sub ?? null,
      querySelector: (sel) => {
        if (sel === '#author-text') return { textContent: author };
        if (sel === '#content-text') return { textContent: text };
        if (sel === '#vote-count-middle') return null;
        return null;
      },
    };
    return node;
  };

  // Thread 1: closest() returns the thread itself (no sub-thread wrapper) — the bare
  // duplicate node is removed directly. Plus a same-text/different-author pair, kept.
  const thread1 = { querySelectorAll: () => [first, dup, sameTextA, sameTextB] };
  const first = replyNode('@bob', 'nice video');
  const dup = replyNode('@bob', 'nice video', thread1);
  const sameTextA = replyNode('@dave', 'shared wording');
  const sameTextB = replyNode('@erin', 'shared wording');

  // Thread 2: same author|text as thread 1's first reply, but a different thread — must survive.
  // Its duplicate is wrapped in its own sub-thread renderer, which should be removed instead of the node.
  const wrapper = { removed: false, remove() { wrapper.removed = true; } };
  const first2 = replyNode('@bob', 'nice video');
  const dup2 = replyNode('@bob', 'nice video', wrapper);
  const thread2 = { querySelectorAll: () => [first2, dup2] };

  const removedCount = dedupeReplyNodes([thread1, thread2]);

  assert.equal(removedCount, 2);

  // First occurrences survive.
  assert.equal(first.removed, false);
  assert.equal(sameTextA.removed, false);
  assert.equal(sameTextB.removed, false);
  assert.equal(first2.removed, false);

  // Bare duplicate (closest returns the thread itself, no distinct wrapper): the node is removed.
  assert.equal(dup.removed, true);

  // Wrapped duplicate: the wrapper is removed, not the bare node.
  assert.equal(dup2.removed, false);
  assert.equal(wrapper.removed, true);
});

test('youtube-ui: commentsToMarkdown groups replies under their thread and separates threads with ---', () => {
  const md = commentsToMarkdown('How it works', 'https://www.youtube.com/watch?v=abc', [
    {
      author: '@alice',
      text: '  first thought  ',
      likes: '12',
      replies: [
        { author: '@bob', text: 'line1\nline2', likes: '3' },
        { author: '@carol', text: 'short one' },
      ],
    },
    { author: '@dave', text: 'no likes shown' },
  ]);

  assert.match(md, /^---\ntitle: "Comments — How it works"\nurl: "https:\/\/www\.youtube\.com\/watch\?v=abc"\n/);
  assert.match(md, /\ncount: "2"\n/, 'count is threads, not comments');
  assert.match(md, /\nreplies: "2"\n---\n/, 'replies counts every reply across threads');
  assert.match(md, /\n# Comments — How it works\n/);
  assert.match(md, /\n\*\*@alice\*\* · 12 likes\n\nfirst thought\n/, 'comment text is trimmed');
  assert.ok(
    md.includes('> **@bob** · 3 likes\n>\n> line1\n> line2'),
    'a reply is a blockquote, every line prefixed, blank separator line kept',
  );
  assert.ok(md.includes('\n---\n'), 'threads are separated by ---');
  assert.match(md, /\n\*\*@dave\*\*\n\nno likes shown$/, 'a reply-less thread ends with its own text, no blockquote');

  const empty = commentsToMarkdown('Nothing', 'https://example.com/', []);
  assert.match(empty, /\ncount: "0"\nreplies: "0"\n---\n\n# Comments — Nothing$/);
});

test('capture: pageToMarkdown writes title/url/scope frontmatter, captureFilename falls back to the host', () => {
  const md = pageToMarkdown('How it works', 'https://example.com/post', '  selected paragraph  ', 'selection');

  assert.match(md, /^---\ntitle: "How it works"\nurl: "https:\/\/example\.com\/post"\n/);
  assert.match(md, /\ncaptured: "\d{4}-\d{2}-\d{2}T/);
  assert.match(md, /\nscope: "selection"\n---\n/);
  assert.match(md, /\n# How it works\n\nselected paragraph$/, 'body starts with the title heading, text trimmed');

  // No <title> on the page: the URL stands in for the heading.
  assert.match(pageToMarkdown('', 'https://example.com/post', 'x', 'page'), /\n# https:\/\/example\.com\/post\n/);

  assert.equal(captureFilename('example.com', 'How it works'), '[example.com]-how-it-works.md');
  assert.equal(captureFilename('example.com', ''), '[example.com]-example-com.md');
  assert.equal(captureFilename('example.com', undefined), '[example.com]-example-com.md');
});
