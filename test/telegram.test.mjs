import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundle } from './helpers.mjs';

const { parseTelegramHtml } = await bundle('lib/telegram-html');
const { detectFields } = await bundle('lib/schema-detector');
const { slugify } = await bundle('lib/markdown-generator');
const { DEFAULT_SETTINGS } = await bundle('lib/settings');
const { buildFiles, uploadedState } = await bundle('lib/chunker');
const { recordsAfter } = await bundle('lib/cursor');

const settings = (overrides) => ({ ...DEFAULT_SETTINGS, ...overrides });

test('telegram-html: parses default/joined/service/media messages and feeds the incremental pipeline unchanged', () => {
  const html = readFileSync(new URL('./fixtures/telegram-export.html', import.meta.url), 'utf8');

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
  const desktop = readFileSync(new URL('./fixtures/telegram-desktop.html', import.meta.url), 'utf8');
  const dt = parseTelegramHtml(desktop);
  assert.equal(dt.sourceName, 'Test Chat');
  assert.deepEqual(dt.records, [
    { date: '2020-09-09T18:44:51', from: 'Jane Roe', text: 'Forwarded from Example Channel:\nReposted text', id: 7 },
  ]);
});
