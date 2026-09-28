import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundle } from './helpers.mjs';

const {
  blockValue,
  richText,
  mergeRecordMaps,
  missingBlockIds,
  entriesSection,
  pageToMarkdown: notionPageToMarkdown,
} = await bundle('lib/notion-blocks');

test('notion blocks: record map shapes, rich text and the block walk', () => {
  // Both wrappers live in one response: the current double one and the older
  // single one (the header below).
  const map = { block: {}, collection: {} };
  const put = (b, plain) => {
    map.block[b.id] = plain ? { role: 'reader', value: b } : { spaceId: 's', value: { value: b, role: 'reader' } };
  };
  const t = (s) => [[s]];
  const nodash = (id) => id.replace(/-/g, '');
  // Real Notion ids are 32-hex-dashed UUIDs; addLinked() gates on that shape,
  // so every id that must end up in childPages needs to look like one here.
  const ROOT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const CHILD_ID = '44444444-4444-4444-4444-444444444444';
  const LINKED_ID = '55555555-5555-5555-5555-555555555555';
  const COLCHILD_ID = '66666666-6666-6666-6666-666666666666';
  const MENTION_ID = '33333333-3333-3333-3333-333333333333';
  const RELLINK_ID = '11111111-1111-1111-1111-111111111111';
  const EXTLINK_ID = '22222222-2222-2222-2222-222222222222';
  const PEEK_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const NOTIONSO_ID = '88888888-8888-8888-8888-888888888888';
  const LM_ID = '99999999-9999-9999-9999-999999999999';
  const CAPTION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  put({
    id: ROOT_ID,
    type: 'page',
    properties: {
      title: [
        ['Hello '],
        ['bold', [['b']]],
        [' '],
        ['link', [['a', 'https://x.dev']]],
        [' '],
        ['‣', [['lm', { href: 'https://site.com/', title: 'Site title' }]]],
        [' '],
        ['‣', [['p', CHILD_ID]]],
      ],
    },
    content: ['h1', 'b1', 'td1', 'td2', 'tg1', 'q1', 'co1', 'cd1', 'dv1', 'tb1', 'bm1', 'im1', 'cl1', 'mn1', CHILD_ID, LINKED_ID, 'al1', 'db1', 'ghost'],
  });
  put({ id: 'h1', type: 'header', properties: { title: t('  Section') } }, true); // leading space, trimmed
  put({ id: 'b1', type: 'bulleted_list', properties: { title: t('Bullet') }, content: ['n1', 'n2'] });
  put({ id: 'n1', type: 'numbered_list', properties: { title: t('First') } });
  put({ id: 'n2', type: 'numbered_list', properties: { title: t('Second') } });
  put({ id: 'td1', type: 'to_do', properties: { title: t('Done'), checked: t('Yes') } });
  put({ id: 'td2', type: 'to_do', properties: { title: t('Open') } });
  put({ id: 'tg1', type: 'toggle', properties: { title: t('Toggle') }, content: ['tgk'] });
  put({ id: 'tgk', type: 'text', properties: { title: t('Folded') } });
  put({ id: 'q1', type: 'quote', properties: { title: t('Wise words') } });
  put({ id: 'co1', type: 'callout', format: { page_icon: '\u{1F4A1}' }, properties: { title: t('Heads up') }, content: ['co1a'] });
  put({ id: 'co1a', type: 'text', properties: { title: t('Inside') } });
  put({ id: 'cd1', type: 'code', properties: { title: t('const a = 1;'), language: t('TypeScript') } });
  put({ id: 'dv1', type: 'divider' });
  put({
    id: 'tb1',
    type: 'table',
    format: { table_block_column_order: ['cA', 'cB'], table_block_column_header: true },
    content: ['tr1', 'tr2'],
  });
  put({ id: 'tr1', type: 'table_row', properties: { cA: t('Name'), cB: t('Value') } });
  put({ id: 'tr2', type: 'table_row', properties: { cA: t('Alpha'), cB: t('1') } });
  put({ id: 'bm1', type: 'bookmark', properties: { title: t('Bookmarked'), link: t('https://ex.com/a'), description: t('A description') } });
  // A 'p' mention inside a caption is scanned same as the visible title.
  put({
    id: 'im1',
    type: 'image',
    properties: { caption: [['A caption '], ['‣', [['p', CAPTION_ID]]]], source: t('https://signed.example/x?token=1') },
  });
  put({ id: 'cl1', type: 'column_list', content: ['cm1'] });
  put({ id: 'cm1', type: 'column', content: ['cmt', COLCHILD_ID] });
  put({ id: 'cmt', type: 'text', properties: { title: t('In a column') } });
  // A page block reached inside a column is still a subpage — walk() never
  // descends into another page's own content, so any page block it does
  // reach belongs to this one, regardless of parent_id or nesting.
  put({ id: COLCHILD_ID, type: 'page', parent_id: 'cm1', properties: { title: t('Column Child') } });
  put({
    id: 'mn1',
    type: 'text',
    properties: {
      title: [
        ['‣', [['p', MENTION_ID]]],
        [' rel '],
        ['link', [['a', `/${nodash(RELLINK_ID)}`]]],
        [' ext '],
        ['link', [['a', `https://example.com/${nodash(EXTLINK_ID)}`]]],
        [' self '],
        ['link', [['a', `/${nodash(ROOT_ID)}`]]], // links back at the page itself: never listed
        [' peek '],
        // Absolute, same host, "?p=" overlay wins over the pathname id.
        ['link', [['a', `https://example.notion.site/Parent-${'7'.repeat(32)}?p=${nodash(PEEK_ID)}&pm=s`]]],
        [' so '],
        ['link', [['a', `https://www.notion.so/${nodash(NOTIONSO_ID)}`]]], // absolute Notion host, not ctx.host
        [' lm '],
        ['‣', [['lm', { href: `/${nodash(LM_ID)}`, title: 'LM Title' }]]],
        [' bad '],
        ['‣', [['p', 'x']]], // not a 32-hex id: never listed
      ],
    },
  });
  put({ id: MENTION_ID, type: 'page', properties: { title: t('Mentioned Page') } });
  put({ id: RELLINK_ID, type: 'page', properties: { title: t('Relative Link Target') } });
  put({ id: EXTLINK_ID, type: 'page', properties: { title: t('External Target') } });
  put({ id: PEEK_ID, type: 'page', properties: { title: t('Peek Target') } });
  put({ id: NOTIONSO_ID, type: 'page', properties: { title: t('Notion So Target') } });
  put({ id: LM_ID, type: 'page', properties: { title: t('LM Target') } });
  put({ id: CAPTION_ID, type: 'page', properties: { title: t('Caption Mention Target') } });
  put({ id: CHILD_ID, type: 'page', parent_id: ROOT_ID, properties: { title: t('Child Page') }, content: ['ghostkid'] });
  put({ id: LINKED_ID, type: 'page', parent_id: 'elsewhere', properties: { title: t('Linked Page') } });
  put({ id: 'al1', type: 'alias', format: { alias_pointer: { id: LINKED_ID } } });
  put({ id: 'db1', type: 'collection_view', format: { collection_pointer: { id: 'col1', spaceId: 'space-9' } }, view_ids: ['view-1'] });
  map.collection.col1 = { spaceId: 's', value: { value: { id: 'col1', name: t('Tasks') } } };

  assert.equal(blockValue(map, ROOT_ID).type, 'page'); // double wrapper
  assert.equal(blockValue(map, 'h1').type, 'header'); // single wrapper
  assert.equal(richText([['x', [['c'], ['i']]]]), '*`x`*');
  // Only http(s) becomes a link; ")" would close the target early.
  assert.equal(richText([['click me', [['a', 'javascript:alert(1)']]]]), 'click me');
  assert.equal(richText([['ok', [['a', 'https://x.dev/a(b)']]]]), '[ok](https://x.dev/a(b%29)');

  const page = notionPageToMarkdown(map, ROOT_ID, 'example.notion.site');
  assert.equal(page.markdown, readFileSync(new URL('./fixtures/notion-blocks.expected.md', import.meta.url), 'utf8'));
  // Signed file URLs expire in an hour; they never reach the source.
  assert.ok(!page.markdown.includes('signed.example'));
  // The 60-char slug cap (markdown-generator.ts) truncates right after
  // "child", coincidentally matching what a short id would have produced too.
  assert.equal(
    page.filename,
    '[example.notion.site]-hello-bold-link-https-x-dev-site-title-https-site-com-child.md',
  );
  // Any page block walk() reaches counts, regardless of parent_id (column
  // child). A 'p' mention or a same-host link (relative, "?p=" peek overlay,
  // or absolute on notion.so/notion.com) adds its target too; a self-link, an
  // external host, and a non-32-hex id are all skipped.
  assert.deepEqual(page.childPages, [
    { id: CAPTION_ID, title: 'Caption Mention Target' },
    { id: COLCHILD_ID, title: 'Column Child' },
    { id: MENTION_ID, title: 'Mentioned Page' },
    { id: RELLINK_ID, title: 'Relative Link Target' },
    { id: PEEK_ID, title: 'Peek Target' },
    { id: NOTIONSO_ID, title: 'Notion So Target' },
    { id: LM_ID, title: 'LM Target' },
    { id: CHILD_ID, title: 'Child Page' },
    { id: LINKED_ID, title: 'Linked Page' },
  ]);
  assert.deepEqual(page.databases, [
    { blockId: 'db1', collectionId: 'col1', viewId: 'view-1', spaceId: 'space-9', name: 'Tasks' },
  ]);
  // A content id with no block is skipped in the markdown and reported instead;
  // the child page's own children belong to its own fetch, not to this one.
  assert.deepEqual(missingBlockIds(map, ROOT_ID), ['ghost']);

  const into = { block: { a: 1 } };
  assert.equal(mergeRecordMaps(into, { block: { b: 2 }, collection: { c: 3 } }), into);
  assert.deepEqual(into, { block: { a: 1, b: 2 }, collection: { c: 3 } });

  // Database rows listed in the page's own file (notion-public.ts, recursive
  // off): a row with no loaded block still gets a line, never a hole.
  assert.equal(entriesSection(map, []), '');
  assert.equal(
    entriesSection(map, [CHILD_ID, 'ghost'], 'example.notion.site'),
    `\n## Entries\n\n- [Child Page](https://example.notion.site/${nodash(CHILD_ID)})\n- [Untitled](https://example.notion.site/ghost)\n`,
  );

  // A database page is its own first database ref (notion-public.ts takes
  // databases[0]), but it never announces itself in its own body.
  put({
    id: 'droot',
    type: 'collection_view_page',
    format: { collection_pointer: { id: 'col1', spaceId: 'space-9' } },
    view_ids: ['view-1'],
    properties: { title: t('Tasks') },
  });
  const dbPage = notionPageToMarkdown(map, 'droot', 'example.notion.site');
  assert.equal(dbPage.markdown, '# Tasks\n');

  // A content[] pointing back at an ancestor terminates, and the block it
  // points through is rendered once, not once per turn of the loop.
  const cyc = { block: {} };
  cyc.block.croot = { spaceId: 's', value: { value: { id: 'croot', type: 'page', properties: { title: t('Loop') }, content: ['c1'] } } };
  cyc.block.c1 = { spaceId: 's', value: { value: { id: 'c1', type: 'text', properties: { title: t('Body') }, content: ['croot'] } } };
  assert.equal(notionPageToMarkdown(cyc, 'croot', 'example.notion.site').markdown, '# Loop\n\nBody\n');
  assert.deepEqual(dbPage.databases, [
    { blockId: 'droot', collectionId: 'col1', viewId: 'view-1', spaceId: 'space-9', name: 'Tasks' },
  ]);
});
