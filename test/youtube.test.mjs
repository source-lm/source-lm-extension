import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './helpers.mjs';

const { extractVideoId, dedupeVideos, findTitle, collectVideos, collectPageVideos, visiblePageRoot } = await bundle('content/youtube');

test('youtube: extractVideoId reads v= from watch links in various forms', () => {
  assert.equal(extractVideoId('/watch?v=vid00000001'), 'vid00000001');
  assert.equal(extractVideoId('/watch?v=vid00000001&list=PL123'), 'vid00000001');
  assert.equal(extractVideoId('/watch?v=vid00000001&t=42s'), 'vid00000001');
  assert.equal(extractVideoId('/watch?list=PL123&v=vid00000001&t=42s'), 'vid00000001');
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

test('youtube: collectVideos skips ad cards whose CTA anchor ("Watch") would become the title', () => {
  // A promoted video links to a plain /watch?v= URL: title-less thumbnail
  // first, then the CTA button, whose aria-label the dedupe backfills.
  const inAd = (sel) => (sel.includes('ytd-ad-slot-renderer') ? {} : null);
  const adThumb = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=ad1&pp=x' : null),
    matches: () => false,
    querySelector: () => null,
    closest: inAd,
  };
  const adCta = { ...adThumb, getAttribute: (name) => (name === 'href' ? '/watch?v=ad1&pp=x' : name === 'aria-label' ? 'Watch' : null) };
  const realAnchor = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=real1' : null),
    matches: () => false,
    querySelector: () => null,
    closest: (sel) => (sel === 'h3, h4' ? { getAttribute: () => null } : null),
    textContent: 'Real Video Title',
  };
  const root = { querySelectorAll: () => [adThumb, adCta, realAnchor] };

  assert.deepEqual(collectVideos(root).map((v) => v.videoId), ['real1']);
});

test('youtube: collectVideos skips the playlist header hero thumbnail link (yt-page-header-view-model), titled with the playlist name', () => {
  // Current playlist layout uses a view-model header, not the -renderer one
  // covered above — the hero link is a /watch?v= anchor for the first video
  // titled with the playlist name ("Sample Playlist"), which would otherwise rename
  // the real video via the dedupe backfill.
  const heroAnchor = {
    getAttribute: (name) => (name === 'href' ? '/watch?v=abc123' : null),
    matches: () => false,
    querySelector: () => null,
    closest: (sel) => (sel.includes('yt-page-header-view-model') ? {} : null),
    textContent: 'Sample Playlist',
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
