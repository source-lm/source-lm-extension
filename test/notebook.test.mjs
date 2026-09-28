import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundle } from './helpers.mjs';

const {
  parseNotebookList,
  extractCreatedNotebookId,
  extractSourceUrls,
  extractSourceNames,
  youtubeVideoId,
  deleteSourceParams,
  handoffJob,
  sourceDataV1,
  parseSources,
  findDuplicateIds,
  runYoutubeJob,
} = await bundle('content/notebook');

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
  // src-1 is a YouTube source: metadata[4] = 9 (type), url at metadata[5][0].
  // src-2 is a web source: url at metadata[7][0]. src-3 has no URL at all.
  const getNotebookResult = JSON.parse(readFileSync(new URL('./fixtures/rlm1ne-notebook.json', import.meta.url), 'utf8'));
  assert.deepEqual(extractSourceUrls(getNotebookResult), [
    'https://www.youtube.com/watch?v=vid00000002',
    'https://example.com/article',
  ]);
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

test('notebook: RUN_YOUTUBE_JOB arriving mid-job reruns once the current job ends, not dropped', async () => {
  // Same stub-and-restore as the loadTrial test in license.test.mjs. No
  // job in storage, so each run is just one storage read — count the reads.
  let reads = 0;
  globalThis.chrome = { storage: { local: { get: async () => (reads++, {}) } } };
  try {
    const first = runYoutubeJob(() => {});
    await runYoutubeJob(() => {}); // lands while the first is still reading
    await first;
    assert.equal(reads, 2, 'the second request must trigger a second read after the first run');
  } finally {
    delete globalThis.chrome;
  }
});

test('notebook: parseSources reads id/title/type/status from rLM1Ne and keeps urls slot-agnostic', () => {
  // w-1: web source, type at metadata[4] = 5, url at metadata[7][0], status 2 (ready).
  // y-1: YouTube source, type 9, url at metadata[5][0] — a different slot,
  // which is exactly why urls are collected recursively, not indexed.
  // m-1: uploaded .md, no url anywhere, and the type/status slots hold
  // something that is not an int — both must read back as undefined.
  // The last two entries are junk and must be skipped, not throw.
  const result = JSON.parse(readFileSync(new URL('./fixtures/rlm1ne-sources.json', import.meta.url), 'utf8'));

  assert.deepEqual(parseSources(result), [
    { id: 'w-1', title: 'Example', type: 5, status: 2, urls: ['https://example.org/'] },
    { id: 'y-1', title: 'Sample Channel video', type: 9, status: 3, urls: ['https://youtu.be/vid00000002'] },
    { id: 'm-1', title: 'export-1.md', type: undefined, status: undefined, urls: [] },
  ]);

  assert.deepEqual(parseSources(null), []);
  assert.deepEqual(parseSources([[]]), []);
});

test('notebook: findDuplicateIds keeps the first of each group, matching on url then title', () => {
  const sources = [
    { id: 'a', title: 'Example', urls: ['https://example.org/'] },
    // Same page, trailing slash only — must still count as a duplicate.
    { id: 'b', title: 'Example (copy)', urls: ['https://example.org'] },
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
