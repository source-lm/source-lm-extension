// The extension's only service worker, and deliberately the smallest one
// that can exist (DECISIONS.md #3): `chrome.contextMenus.onClicked` needs a
// listener that is alive while the popup is closed, and nothing else here
// needs one. So this worker holds no queue and no state — it registers the
// menu, and on a click it writes the very same `youtubeJob` to
// chrome.storage.local that the popup and the YouTube dialog write, then
// opens the notebook tab. It also answers OPEN_NOTEBOOK, so every submit path
// (popup, in-page dialogs, the menu) reuses a tab already showing that
// notebook instead of stacking a duplicate. The content script there
// (notebook.ts: runYoutubeJob) does all the actual work. An MV3 worker killed
// mid-flight therefore loses nothing: the job is already in storage.
//
// Never put a queue, a retry loop or `alarms` in here.

import { pageToMarkdown, captureFilename } from './lib/capture';
// Type only (erased at compile time — no content-script code lands in this
// bundle), same trick popup.ts uses: the job shape is owned by its runner.
import type { YoutubeJob } from './content/notebook';

const ROOT_ID = 'sel';
const NEW_NOTEBOOK_ID = 'sel:new';
const DEFAULT_ORIGIN = 'https://notebook.google.com';
// Both stay alive at once (DECISIONS.md #6).
const NOTEBOOK_ORIGINS = ['https://notebooklm.google.com', 'https://notebook.google.com'];

type NotebookCache = {
  notebooks?: { id: string; title: string; emoji?: string }[];
  origin?: string;
  at?: number;
};

async function readCache(): Promise<NotebookCache> {
  const stored = (await chrome.storage.local.get('notebookCache')) as { notebookCache?: NotebookCache };
  return stored.notebookCache ?? {};
}

async function rebuildMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: ROOT_ID,
    title: 'Add selection to Notebook',
    contexts: ['selection'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  // Same rule as the in-page YouTube dialog: the notebook list is whatever a
  // Notebook tab last cached (uploader.ts writes it on every page load). No
  // cache yet — only "New notebook" is offered.
  const { notebooks = [] } = await readCache();
  for (const nb of notebooks) {
    chrome.contextMenus.create({
      id: `sel:${nb.id}`,
      parentId: ROOT_ID,
      title: nb.emoji ? `${nb.emoji} ${nb.title}` : nb.title,
      contexts: ['selection'],
    });
  }
  chrome.contextMenus.create({
    id: NEW_NOTEBOOK_ID,
    parentId: ROOT_ID,
    title: '＋ New notebook',
    contexts: ['selection'],
  });
}

// removeAll + create is not atomic, and two rebuilds can overlap (install
// and a storage change landing together) — the second one then throws on a
// duplicate id. Chaining is cheaper than reasoning about the interleaving.
let building: Promise<void> = Promise.resolve();
function buildMenus(): void {
  building = building.then(rebuildMenus).catch(() => {});
}

// Focuses a tab already showing this notebook, on either origin; a new
// notebook, or one not open anywhere, gets a fresh tab.
async function openNotebookTab(url: string): Promise<void> {
  const { origin, pathname } = new URL(url);
  // Trust boundary: never open an arbitrary URL on a message's say-so.
  if (!NOTEBOOK_ORIGINS.includes(origin)) throw new Error(`Not a notebook URL: ${url}`);
  const id = /^\/notebook\/([^/]+)/.exec(pathname)?.[1];
  const [tab] = id ? await chrome.tabs.query({ url: NOTEBOOK_ORIGINS.map((o) => `${o}/notebook/${id}*`) }) : [];
  if (!tab?.id) {
    await chrome.tabs.create({ url });
    return;
  }
  const tabId = tab.id;
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  // The tab's page-load auto-run fired before this job existed, so poke it.
  // Not a reload: that would kill an upload queue or a job already running
  // there (DECISIONS.md #3). No receiver means the tab predates an extension
  // reload — then a reload is the only way to get a live content script.
  await chrome.tabs.sendMessage(tabId, { type: 'RUN_YOUTUBE_JOB' }).catch(() => chrome.tabs.reload(tabId));
}

// All five listeners are registered at the top level: a worker woken up by
// an event must have its handlers attached before the event is dispatched.
chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && 'notebookCache' in changes) buildMenus();
});
chrome.runtime.onMessage.addListener((message: { type?: string; url?: string }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'OPEN_NOTEBOOK') return undefined;
  openNotebookTab(String(message.url))
    .then(() => sendResponse({}))
    .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
  return true;
});

// The click grants activeTab for this tab, so executeScript works with no
// host permissions. It is worth the round trip: `info.selectionText`
// collapses newlines, which would flatten a multi-paragraph selection into
// one blob. Falls back to it when injection is impossible anyway (a page the
// extension may not touch, e.g. the Chrome Web Store).
async function selectionText(tabId: number, fallback: string): Promise<string> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection()?.toString() ?? '',
    });
    return (injection?.result as string) || fallback;
  } catch {
    return fallback;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (!id.startsWith('sel:') || !tab?.id) return;

  void (async () => {
    const text = (await selectionText(tab.id!, info.selectionText ?? '')).trim();
    if (!text) return; // nothing to add — no UI here to complain to

    const pageUrl = info.pageUrl ?? tab.url ?? '';
    const host = new URL(pageUrl).hostname.replace(/^www\./, '');
    const title = tab.title ?? '';
    const { origin = DEFAULT_ORIGIN } = await readCache();

    // A notebook created from the menu gets no title (createTitle
    // ''), i.e. Notebook names it — same as the popup and the in-page dialog
    // when the title field is left empty. Prompting for one would mean a UI,
    // which is exactly what this one-click path avoids.
    const targetId = id === NEW_NOTEBOOK_ID ? undefined : id.slice('sel:'.length);
    const youtubeJob: YoutubeJob = {
      type: 'ADD_YOUTUBE',
      videos: [],
      files: [
        {
          filename: captureFilename(host, title),
          markdown: pageToMarkdown(title, pageUrl, text, 'selection'),
        },
      ],
      createdAt: Date.now(),
      ...(targetId ? { targetNotebookId: targetId } : { createTitle: '' }),
    };
    await chrome.storage.local.set({ youtubeJob });
    await openNotebookTab(
      targetId ? `${origin.replace(/\/+$/, '')}/notebook/${targetId}` : `${origin.replace(/\/+$/, '')}/`,
    );
    // One source per click — always free, no licence gate (DECISIONS.md #15).
  })();
});
