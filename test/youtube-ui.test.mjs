import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './helpers.mjs';

const {
  currentWatchVideo,
  notebookTabUrl,
  isChannelPage,
  harvestDone,
  isVideosTabLabel,
  firstRendered,
  commentsToMarkdown,
  collapsedToggle,
  pendingReplyBlocks,
  collectCommentThreads,
  dedupeReplyNodes,
} = await bundle('content/youtube-ui');

test('youtube-ui: firstRendered skips the hidden copies YouTube leaves behind after SPA navigation', () => {
  const stale = { getClientRects: () => ({ length: 0 }) };
  const live = { getClientRects: () => ({ length: 1 }) };
  assert.equal(firstRendered([stale, live]), live);
  assert.equal(firstRendered([stale, stale]), null);
  assert.equal(firstRendered([]), null);
});

test('youtube-ui: currentWatchVideo extracts id+title, notebookTabUrl builds /notebook/<id> vs bare origin', () => {
  const video = currentWatchVideo(
    'https://www.youtube.com/watch?v=vid00000001&list=PL123&t=42s',
    'Sample Video - YouTube',
  );
  assert.deepEqual(video, {
    videoId: 'vid00000001',
    title: 'Sample Video',
    url: 'https://www.youtube.com/watch?v=vid00000001',
  });
  assert.equal(currentWatchVideo('https://www.youtube.com/results?search_query=cats', 'x'), null);

  assert.equal(notebookTabUrl('https://notebooklm.google.com', 'nb-1'), 'https://notebooklm.google.com/notebook/nb-1');
  assert.equal(notebookTabUrl('https://notebooklm.google.com/'), 'https://notebooklm.google.com/');
});

test('youtube-ui: isChannelPage matches all channel URL forms, harvestDone stops at the limit/on stall and keeps going while growing', () => {
  assert.equal(isChannelPage('/@samplechannel'), true);
  assert.equal(isChannelPage('/@samplechannel/videos'), true);
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
