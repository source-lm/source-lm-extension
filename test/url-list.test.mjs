import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './helpers.mjs';

const { parseUrlList } = await bundle('lib/url-list');

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
