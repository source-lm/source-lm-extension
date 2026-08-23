# Privacy Policy — Source LM

The policy lives on the landing site, and that page is canonical:

**https://source-lm.com/privacy**

The short version, so a reader here is not left empty-handed:

- No backend, no proxy, no third-party server, no telemetry, no analytics, no
  crash reporting, no remote code.
- Sources go to `notebooklm.google.com` / `notebook.google.com` and the Google
  upload host they hand back, in the session you are already signed into.
- A Pro licence check goes to `api.lemonsqueezy.com`, carrying the licence key
  and a per-device instance — no notebook content, no source URLs, no Google
  session data, cookies omitted.
- The video list in the popup shows thumbnails as plain `<img>` tags from
  `https://i.ytimg.com/vi/<videoId>/default.jpg` — only the id of a video
  already on the YouTube page you are looking at, none of our cookies, no
  notebook content, no Google session data.
- Those two are the only outbound requests besides the notebook upload itself.
- Settings, the `license` state (the licence key, its Lemon Squeezy
  instance id, and the purchase email Lemon Squeezy returns), and the
  `trial` counter live in `chrome.storage.sync` (which Chrome syncs to your
  own Google account); a
  YouTube/link job and the broken-source hand-off (`fixQueue`) sit briefly in
  `chrome.storage.local` and are deleted on read or after 5 minutes; a cache of
  your notebooks' ids/titles (`notebookCache`) lives there too, for the popup,
  the YouTube dialog, and the right-click submenu.
- Permissions: `activeTab`, `storage`, `scripting`, `contextMenus`, and host
  access limited to `notebooklm.google.com`, `notebook.google.com`,
  `www.youtube.com`, and `api.lemonsqueezy.com`. No `tabs`, no `<all_urls>`.
  The only background service worker registers the «Add selection to Notebook»
  menu item and hands the selection to the notebook tab — no queue, no data of
  its own, no network requests.

Terms of service: **https://source-lm.com/terms**

Questions: support@source-lm.com
