import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './helpers.mjs';

const { extractNotebookId, extractSourceId, findAddSourceButton } = await bundle('content/uploader');

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

test('uploader: findAddSourceButton falls back to the mat-icon ligature inside the sources panel', () => {
  const button = (text, aria, icon) => ({
    textContent: text,
    getAttribute: (name) => (name === 'aria-label' ? aria : null),
    querySelector: (sel) => (sel === 'mat-icon' && icon ? { textContent: icon } : null),
  });
  // A page is a document stub: querySelectorAll returns the buttons, and
  // querySelector('source-picker') the panel (itself a querySelectorAll stub).
  const page = (buttons, panelButtons) => ({
    querySelectorAll: () => buttons,
    querySelector: (sel) =>
      sel === 'source-picker' && panelButtons ? { querySelectorAll: () => panelButtons } : null,
  });

  // Japanese UI: no text the regex knows, so the icon pass inside the panel wins.
  const jaAdd = button('addソースを追加', 'ソースを追加', 'add');
  const createNotebook = button('add新しいノートブック', '新しいノートブック', 'add');
  assert.equal(findAddSourceButton(page([createNotebook, jaAdd], [jaAdd])), jaAdd);

  // Nothing matches by text and no add-ish icon in the panel — no click at all
  // is better than clicking the wrong button.
  const sort = button('sort', '並べ替え', 'sort');
  assert.equal(findAddSourceButton(page([sort], [sort])), null);

  // The Russian locale still matches on the first pass, panel or no panel.
  const ruAdd = button('Добавить источник', null, null);
  assert.equal(findAddSourceButton(page([ruAdd], null)), ruAdd);
});
