# Privacy Policy — Source LM

The policy lives on the landing site, and that page is canonical:

**https://source-lm.com/privacy**

The short version, so a reader here is not left empty-handed:

- No backend, no proxy, no third-party server, no telemetry, no analytics, no
  crash reporting, no remote code.
- Sources go to `notebooklm.google.com` / `notebook.google.com` and the Google
  upload host they hand back, in the session you are already signed into.
- A Pro licence check goes to `api.polar.sh`, carrying the licence key and a
  per-device activation id — no notebook content, no source URLs, no Google
  session data, cookies omitted.
- The video list in the popup shows thumbnails as plain `<img>` tags from
  `https://i.ytimg.com/vi/<videoId>/default.jpg` — only the id of a video
  already on the YouTube page you are looking at, none of our cookies, no
  notebook content, no Google session data.
- On `app.notion.com`, "Add to NotebookLM" reads the page only when you click
  it, through Notion's own export endpoint in the session you are already
  signed into; the export zip is then downloaded from the signed
  `file.notion.com` link Notion hands back — a Notion-owned host, your Notion
  cookies, nothing of ours — and the Markdown goes straight to your notebook
  and nowhere else.
- On a public `*.notion.site` page the same button, on the same click, reads
  the page through Notion's own page API instead (the export endpoint is for
  members only) — the same requests the published site itself makes to draw
  the page, same origin, and the Markdown again goes straight to your notebook.
- Those are the only outbound requests besides the notebook upload itself.
- Settings, the `license` state (the licence key and its Polar activation
  id), and the `trial` counter live in `chrome.storage.sync` (which Chrome syncs to your
  own Google account); a
  YouTube/link job and the broken-source hand-off (`fixQueue`) sit briefly in
  `chrome.storage.local` and are deleted on read or after 5 minutes; a cache of
  your notebooks' ids/titles (`notebookCache`) lives there too, for the popup,
  the YouTube dialog, and the right-click submenu.
- Permissions: `activeTab`, `storage`, `scripting`, `contextMenus`, and host
  access limited to `notebooklm.google.com`, `notebook.google.com`,
  `www.youtube.com`, and `api.polar.sh`. On `app.notion.com` and
  `*.notion.site` the button is only a content script declared in the
  manifest — there is no host permission beyond that, and every Notion
  request it makes is one the page could make itself. No `tabs`, no
  `<all_urls>`.
  The only background service worker registers the «Add selection to Notebook»
  menu item and hands the selection to the notebook tab — no queue, no data of
  its own, no network requests.

Terms of service: **https://source-lm.com/terms**

Questions: support@source-lm.com
