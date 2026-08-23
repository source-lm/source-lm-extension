// Content script on the youtube.com page. Answers the popup's two requests —
// COLLECT_VIDEOS (the videos visible on the page) and HARVEST_COMMENTS (the
// watch page's comment threads as one .md source, harvested by scrolling and
// expanding replies, so it can take a couple of minutes) — and installs
// "Add to notebook" buttons into YouTube's own action rows (youtube-ui.ts).
// Overlays/checkboxes drawn on top of YouTube's video
// *cards* are still out — that DOM would break just as often as
// NotebookLM's (see DECISIONS.md) — but buttons anchored inside YouTube's own
// action rows are in, with a short id/aria-label/tag fallback ladder per
// anchor as the mitigation (see youtube-ui.ts).

import { installYoutubeButtons, harvestCommentsFile, currentPageVideo } from './youtube-ui';

export type VideoItem = { videoId: string; title: string; url: string };

// Covers the whole page header, not just the action buttons: playlist/
// channel header action buttons ("Play all", "Shuffle") AND the hero
// thumbnail link (which points at the first video and is titled with the
// playlist/channel name) are /watch?v= anchors too. Either one points at
// the *first* video and comes before the list in DOM order, so it does not
// merely add a bogus row — it wins the dedupe for that id and renames the
// real video. They only ever live in the page header, never in a video row.
// yt-page-header-view-model is the current playlist layout; the -renderer
// entries are kept for older layouts still seen in the wild.
const ACTION_ROW_SEL =
  'yt-page-header-renderer, yt-page-header-view-model, yt-flexible-actions-view-model, ytd-playlist-header-renderer';

// videoId is in the v= query parameter — match it regardless of what comes
// before/after (&list=, &t=42s, etc.), stopping at the next delimiter.
const VIDEO_ID_RE = /[?&]v=([^&#]+)/;

export function extractVideoId(href: string): string | null {
  const match = href.match(VIDEO_ID_RE);
  return match ? match[1] : null;
}

// Dedup by videoId, first occurrence wins for ordering/url — the same video
// often appears on the page multiple times (thumbnail anchor first, text
// link after). The thumbnail anchor has no title, so if the stored item's
// title is still empty, backfill it from a later duplicate that has one.
export function dedupeVideos(videos: VideoItem[]): VideoItem[] {
  const byId = new Map<string, VideoItem>();
  for (const v of videos) {
    const existing = byId.get(v.videoId);
    if (!existing) {
      byId.set(v.videoId, v);
    } else if (!existing.title && v.title) {
      existing.title = v.title;
    }
  }
  return [...byId.values()];
}

// YouTube renders video links in several different layouts and each one
// hides the title somewhere else, so this is a ladder — first non-empty
// value wins:
//
//   1. #video-title — in ytd-video-renderer the anchor IS that element, in
//      other renderers it is a descendant, so both have to be checked.
//   2. title / aria-label attributes on the anchor.
//   3. aria-label on the wrapping heading (yt-lockup-view-model puts it
//      there rather than on the link).
//   4. the anchor's own text — the yt-lockup title link has no id, no
//      title attribute and often no aria-label, the text is all there is.
//
// Rung 4 is guarded positively rather than negatively: only take the
// anchor's own text when it sits inside a heading. In every live layout the
// title link lives in a heading (yt-lockup-view-model, ytd-rich-grid-media,
// ytd-video-renderer), while thumbnail anchors (whose text is junk like
// "16:32 Now playing") never do — this survives renames of the thumbnail's
// internals, unlike checking for its child elements. Rung 3 already uses the
// same closest('h3, h4'), so this introduces no new selector.
export function findTitle(anchor: Element): string {
  const titleEl = anchor.matches('#video-title') ? anchor : anchor.querySelector('#video-title');
  const fromTitleEl = titleEl?.textContent?.trim();
  if (fromTitleEl) return fromTitleEl;

  const fromAttr = anchor.getAttribute('title')?.trim();
  if (fromAttr) return fromAttr;

  const fromAria = anchor.getAttribute('aria-label')?.trim();
  if (fromAria) return fromAria;

  const heading = anchor.closest('h3, h4');
  const fromHeading = heading?.getAttribute('aria-label')?.trim();
  if (fromHeading) return fromHeading;

  if (heading) {
    const fromText = anchor.textContent?.trim();
    if (fromText) return fromText;
  }

  return '';
}

// YouTube is an SPA: ytd-page-manager keeps every page renderer it ever
// created (ytd-browse, ytd-watch-flexy, ytd-search) in the DOM, marking
// inactive ones with the `hidden` attribute — their /watch?v= anchors still
// match a document-wide query, so a plain "Collect videos" after navigating
// around returns videos from pages the user already left. `?? doc` is
// load-bearing: if YouTube renames the container, the worst case is today's
// (buggy) behaviour, never an empty list.
export function visiblePageRoot(doc: Document = document): ParentNode {
  return doc.querySelector('ytd-page-manager > :not([hidden])') ?? doc;
}

// Page-wide scan of every /watch?v= anchor under `root`, minus the header
// action-row false positives (ACTION_ROW_SEL). This is the right tool for a
// video grid/list (playlist panel, playlist page, channel grid) — a caller
// that passes an explicit root already scoped to one of those. It is the
// wrong tool for the watch page itself: see collectPageVideos below, which
// is what the popup actually calls there.
export function collectVideos(root: ParentNode = visiblePageRoot()): VideoItem[] {
  const anchors = root.querySelectorAll('a[href*="/watch?v="]');
  const videos: VideoItem[] = [];

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    const videoId = extractVideoId(href);
    if (!videoId) continue;
    if (anchor.closest(ACTION_ROW_SEL)) continue;

    videos.push({
      videoId,
      title: findTitle(anchor),
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  // A title-less entry after dedupe means only a thumbnail for it exists on
  // the page (ad slot, half-rendered lazy card) — drop it instead of
  // inventing a placeholder title.
  return dedupeVideos(videos).filter((v) => v.title);
}

// Popup's "Collect videos on page". On /watch the page is full of
// /watch?v= anchors that are not video cards — player controls
// ("Next (SHIFT+n)"), end-screen stills, chapter markers ("0 seconds"),
// description/comment timestamps, recommendations — so instead of
// blacklisting each one the watch page is an allowlist: the video playing
// plus the playlist panel, if any. Other pages keep the page-wide scan.
export function collectPageVideos(root: ParentNode, pathname: string, current: VideoItem | null): VideoItem[] {
  if (pathname !== '/watch') return collectVideos(root);
  const panel = root.querySelector('ytd-playlist-panel-renderer');
  return dedupeVideos([...(current ? [current] : []), ...(panel ? collectVideos(panel) : [])]);
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: { type?: string; limit?: number }, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'COLLECT_VIDEOS') {
      sendResponse({ videos: collectPageVideos(visiblePageRoot(), location.pathname, currentPageVideo()) });
    }
    if (message?.type === 'HARVEST_COMMENTS') {
      harvestCommentsFile(Math.max(1, Number(message.limit) || 100)).then(
        (file) => sendResponse({ file }),
        (err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }),
      );
      return true; // async response — keep the channel open, the harvest runs up to ~2 min
    }
  });

  installYoutubeButtons();
}
