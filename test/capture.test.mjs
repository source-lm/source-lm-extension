import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import esbuild from 'esbuild';
import { bundle } from './helpers.mjs';

const { pageToMarkdown, captureFilename } = await bundle('lib/capture');

// extractPage lives in popup.ts and runs inside the page through
// executeScript, i.e. serialized and re-executed — so the test does the same:
// cut the function out of the source, strip types, run it against a stub DOM.
const extractPageSrc = fs.readFileSync(new URL('../src/popup/popup.ts', import.meta.url), 'utf8').match(/\nfunction extractPage\(\)[\s\S]*?\n}\n/)[0];
const extractPageJs = esbuild.transformSync(extractPageSrc, { loader: 'ts' }).code;
const runExtractPage = (hostname, elements, mainText = 'GENERIC') => {
  const matchesOf = (sel) => (el) => sel.split(',').some((s) => el.selectors.includes(s.trim()));
  const nodes = elements.map((e) => ({ innerText: e.text, selectors: e.selectors, parentElement: null }));
  elements.forEach((e, i) => {
    if (e.parent !== undefined) nodes[i].parentElement = { closest: (sel) => (matchesOf(sel)(nodes[e.parent]) ? nodes[e.parent] : null) };
  });
  for (const n of nodes) n.matches = (sel) => matchesOf(sel)(n);
  const document = {
    title: 'Chat title',
    body: { innerText: 'BODY' },
    querySelectorAll: (sel) => nodes.filter(matchesOf(sel)),
    querySelector: (sel) => (sel === 'main' ? { innerText: mainText } : null),
  };
  return new Function('document', 'location', extractPageJs + '\nreturn extractPage();')(document, { hostname, href: 'https://' + hostname + '/c/1' });
};

test('capture: extractPage labels chat turns per host, merges paragraphs, skips nested/empty, falls back on a half match', () => {
  const user = '[data-message-author-role="user"]';
  const bot = '[data-message-author-role="assistant"]';
  const chat = runExtractPage('chatgpt.com', [
    { text: 'hi', selectors: [user] },
    { text: '', selectors: [bot] }, // image-only reply: no blank turn
    { text: ' hello ', selectors: [bot] },
    { text: 'tool output', selectors: ['[data-message-author-role="tool"]'] }, // not a speaker
  ]);
  assert.equal(chat.text, '**You:**\nhi\n\n**ChatGPT:**\nhello');
  assert.equal(chat.title, 'Chat title');

  // Gemini: a two-paragraph query is two .query-text-line elements — one turn.
  const gemini = runExtractPage('gemini.google.com', [
    { text: 'p1', selectors: ['.query-text-line'] },
    { text: 'p2', selectors: ['.query-text-line'] },
    { text: 'answer', selectors: ['message-content'] },
  ]);
  assert.equal(gemini.text, '**You:**\np1\np2\n\n**Gemini:**\nanswer');

  // Perplexity: a .prose nested inside the user bubble is the same text again.
  const pplx = runExtractPage('www.perplexity.ai', [
    { text: 'q', selectors: ['.group\\/user-bubble'] },
    { text: 'q', selectors: ['.prose'], parent: 0 },
    { text: 'a', selectors: ['.prose'] },
  ]);
  assert.equal(pplx.text, '**You:**\nq\n\n**Perplexity:**\na');

  // Only the user selector survived a redesign: generic capture, not a
  // transcript with every answer missing.
  const half = runExtractPage('claude.ai', [{ text: 'q', selectors: ['[data-testid="user-message"]'] }]);
  assert.equal(half.text, 'GENERIC');
  // Unknown host: generic path untouched.
  assert.equal(runExtractPage('example.com', []).text, 'GENERIC');
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
