# Architecture and decisions

Chrome extension (Manifest V3, TypeScript, zero runtime dependencies):
JSON → a batch of Markdown files, or selected YouTube videos → adds
sources to an open NotebookLM/Gemini Notebook notebook, without
downloading to disk. Upload goes primarily through a private Google RPC
(`batchexecute`, `src/content/rpc.ts`), with automatic fallback to DOM
injection on first failure (`src/content/uploader.ts`) — see README "If
upload doesn't work". Source of truth is the code, not this file, where
they diverge.

The numbered decisions below are referenced from code comments as
`DECISIONS.md #N` — a comment that cites one is pointing at the reason
the code looks the way it does, not at a style preference.

## Architecture

- `src/lib/` — pure functions, no DOM/chrome API except `settings.ts`:
  `parser.ts` (JSON → array of records) → `schema-detector.ts` (title/
  content/date/tags/metadata fields) → `markdown-generator.ts` (record →
  `.md`) → `chunker.ts` (packing records into files by word budget) +
  `settings.ts` (`chrome.storage.sync`, defaults) + `license.ts` (Polar
  license API calls and the `chrome.storage.sync` `license` state —
  see decision #15).
- `src/popup/popup.ts` — vanilla TS, no framework. Reads/writes the
  settings form, calls `lib/*` for Preview, sends
  `chrome.tabs.sendMessage` to the content script for Upload and for the
  YouTube job (`chrome.storage.local`).
- `src/content/rpc.ts` — transport layer to the private Google RPC
  `batchexecute` (request assembly, chunked-response parsing, retries,
  auth token invalidation). Knows nothing about domain logic (sources,
  notebooks) — only `callRpc`.
- `src/content/notebook.ts` — domain RPC calls on top of `rpc.ts`:
  listing/creating notebooks, adding a YouTube source (with rpc-id
  versioning), the runner for the background `ADD_YOUTUBE` job from
  `chrome.storage.local`.
- `src/content/uploader.ts` — the entire upload queue on the
  NotebookLM/Gemini Notebook page: first tries the RPC path (`rpc.ts`),
  on failure switches permanently to DOM injection (fallback) for the
  rest of the current upload session.
- `src/content/sources-ui.ts` — the three extras in the Sources panel
  header next to NotebookLM's sort button: a filter box (hides
  non-matching rows, never unchecks them), «Select duplicate
  sources» (`notebook.ts:listSources` + `findDuplicateIds`, ticks the
  repeats only), and «Broken sources» (lists the sources that failed to
  fetch and parks each one in the `fixQueue` hand-off for the popup —
  decision #16). Reuses `findSortButton`/`sourceRow` from
  `delete-ui.ts`; installed from `uploader.ts` next to
  `installDeleteButton()`.
- `src/content/youtube.ts` — content script on youtube.com: answers
  `COLLECT_VIDEOS` (the videos visible on the page) and
  `HARVEST_COMMENTS` (a ready `{filename, markdown}` built by
  `youtube-ui.ts:harvestCommentsFile` — the top-N comment threads with
  their replies), and installs the in-page «Add to notebook» buttons
  from `youtube-ui.ts`.
- `src/content/notion.ts` — content script on `app.notion.com` and on public
  `*.notion.site` pages: three lines that install the in-page button from
  `notion-ui.ts`, no message listener (the popup has no Notion tab — the flow
  starts from the button).
- `src/content/notion-ui.ts` — the «Add to NotebookLM» pill in Notion's top
  bar and the dialog behind it, plus the network half of the export
  (`enqueueTask` → `getTasks` → download the zip). A deliberate copy of the
  `youtube-ui.ts` pattern rather than a generalisation of it; only the
  host-agnostic helpers are shared, from `page-ui.ts`, instead of being
  duplicated. Picks the second path (`notion-public.ts`) by hostname, and has
  its own anchor ladder for the published-site top bar. See decision #18.
- `src/content/notion-public.ts` — the network half of the public
  `*.notion.site` path: `loadCachedPageChunk` (paginated by its cursor) +
  `syncRecordValuesMain` for the blocks the chunks only referenced, and
  `queryCollection` for database rows. Hands each page's record map to
  `lib/notion-blocks.ts` and returns the same `{title, filename, markdown}[]`
  the export path returns. 300 files max. Decision #18.
- `src/content/page-ui.ts` — the in-page helpers both hosts need and neither
  owns: the injection guards (`claimSlot`, `firstRendered`, `queryRendered`),
  the pill button (`buildButton`), and the notebook-cache readers
  (`readNotebookCache`, `notebookTabUrl`, `DEFAULT_ORIGIN`). Host-agnostic on
  purpose — it is what keeps `dist/notion.js` free of YouTube's code, and
  `youtube-ui.ts` re-exports two of them for the test bundle.
- `src/lib/notion-export.ts` — the pure half: page id out of a URL, the
  `enqueueTask` request body, a dependency-free zip reader (stored and
  `deflate-raw`), and the depth filter that turns zip paths into sources.
  Tested in `test/convert.test.mjs`.
- `src/lib/notion-blocks.ts` — the other pure half, for the public path:
  Notion's block JSON → Markdown (`pageToMarkdown`, plus `blockValue`,
  `richText`, `mergeRecordMaps`, `missingBlockIds`, `entriesSection`). No
  fetch, no DOM, no chrome, so the whole conversion is testable under plain
  node — `test/convert.test.mjs` walks one record map with every block type
  through it.
- `src/background.ts` — the only service worker, and deliberately the
  smallest possible one (decision #3): registers the «Add selection to
  Notebook» context menu with a submenu of notebooks (read from the
  `notebookCache` that `uploader.ts` writes, rebuilt on
  `storage.onChanged`), and on a click writes the same `youtubeJob` to
  `chrome.storage.local` and opens the notebook tab — the content script
  runs it. It also answers `OPEN_NOTEBOOK {url}` from the popup and the
  in-page dialogs (`openNotebookTab`): a tab already showing that notebook
  on either origin is focused and sent `RUN_YOUTUBE_JOB` (reloaded if it
  has no live content script), otherwise a new tab opens.
  Imports `src/lib/capture.ts` and nothing else.
- `src/lib/capture.ts` — page text → Markdown source
  (`pageToMarkdown`, `captureFilename`), shared by «Add page as .md» in
  the popup and the context menu. Pure, DOM-free: the service worker
  imports it.
- `build.mjs` — esbuild, five entry points (`popup.ts`, `uploader.ts` →
  `dist/content.js`, `youtube.ts`, `notion.ts`, `background.ts`), skips ones
  that don't exist.
  Minification is disabled (identifiers stay readable) — important for
  Chrome Web Store review ("full functionality must be discernible from
  submitted code"), don't enable without a reason.
- `manifest.json` — **no service worker for the upload queue or the job
  hand-off**; the only `background` entry is the stateless
  `src/background.ts` for the context menu (decision #3);
  `permissions: ["activeTab", "storage", "scripting", "contextMenus"]`,
  `host_permissions` — both NotebookLM/Gemini Notebook domains
  (`notebooklm.google.com`, `notebook.google.com`), `youtube.com` and
  `api.polar.sh` (license API calls from the popup, see decision
  #15). `app.notion.com` and `*.notion.site` are in `content_scripts`
  only, with no host permission behind them (decision #18).
  `scripting` is requested only for reading page text:
  the current-page capture button on the popup's third tab and the
  «Add selection to Notebook» context menu
  (`chrome.scripting.executeScript` from `popup.ts` / `background.ts`,
  tab access is granted by `activeTab` — the popup being open, or the
  context-menu click — no new `host_permissions` were added for either).
  The NotebookLM/YouTube content scripts are still declared statically
  via `content_scripts`, not through `chrome.scripting.executeScript`.

## Decisions that must not be silently reverted

1. **File size budget is measured on the final rendered string, in
   words**, not on the sum of `content` characters. `chunker.ts:
   packBySize` measures `wordCount(renderBatch(...))` against
   `s.max_words_per_file`, i.e. frontmatter + headings + `## Metadata`
   are already inside the count. In an earlier project of ours,
   undercounting the render overhead pushed exports 35% over
   NotebookLM's 500k-word limit — sources were rejected on upload. The
   trap during packing: `packBySize` measures a trial pack with
   **maximally wide placeholders** `part='999/999'`,
   `range='99999-99999'` — so the final render with the real (never
   longer) numbers is guaranteed not to exceed the already-checked
   limit. If you change the index-padding scheme — verify the
   placeholders still cover the maximum.
2. **A record is never split across files**: a record longer than
   `max_words_per_file` gets its own file whole, plus a warning
   (`chunker.ts`, test in `test/convert.test.mjs` — "oversized record
   gets its own file, whole, not truncated").
3. **The upload queue lives in the content script (`uploader.ts`), not
   in a service worker.** The service worker is intentionally absent
   from the project — an MV3 SW is unloaded after ~30s of idleness and
   would not survive a pause between batches; the NotebookLM page lives
   for the whole session. `send()` in uploader swallows the absence of a
   listener (closed popup) via `.catch()`. Do not bring back an SW for
   this. **The one narrow exception is `src/background.ts`**, for the
   two things only a worker can do: `chrome.contextMenus.onClicked`
   needs a listener alive with the popup closed, and `OPEN_NOTEBOOK`
   focuses the notebook's existing tab (or opens one) for every submit
   path, which needs `chrome.tabs` — out of a content script's reach.
   That worker is stateless — it registers the menu and, on a click,
   writes the same `youtubeJob` to `chrome.storage.local` and opens the
   notebook tab, exactly like the popup and the in-page YouTube dialog;
   the job itself always travels through `storage.local` and the content
   script's `runYoutubeJob` still does all the work, so a worker killed
   mid-flight loses nothing. Never put a queue, a retry loop or `alarms`
   in it. The same argument is why the YouTube job is passed from the popup to the
   notebook tab via storage (`notebook.ts:readAndClearJob`), not through
   an SW intermediary: the SW would have to stay alive between the click
   in the popup and the tab opening/becoming ready, while storage
   survives this without any problem and without an SW at all.
   **Specifically — `chrome.storage.local`, not
   `chrome.storage.session`.** The session storage's access level
   defaults to `TRUSTED_CONTEXTS_ONLY`, and the content script is
   untrusted: the popup wrote the job, and reading it in the content
   script failed with "Access to storage is not allowed from this
   context" — and both calls sat under a bare `void` without `.catch()`,
   so the failure was completely silent. The only way to open access is
   `storage.session.setAccessLevel(...)` from a trusted context, i.e.
   from that very service worker whose absence is the whole point of
   this item — the circle closes, session storage is not applicable
   here, there is nothing to "bring back" (`background.ts` above changes
   nothing about this: it writes `storage.local` like everyone else, and
   must not be turned into the trusted context that would "unlock"
   session storage). The cost of `local`: it
   survives a browser restart (session storage used to die with it), so
   the job carries a `createdAt` and a 5-minute TTL in
   `readAndClearJob` — a job abandoned by a crash must not fire a day
   later. The "no service worker for the queue" rule stays unchanged
   regardless.
4. **`File` does not survive `chrome.tabs.sendMessage`** (JSON
   serialization): `popup.ts` passes `{filename, markdown}` as strings,
   `new File(...)` is built inside `uploader.ts` itself.
5. **NotebookLM selectors match on `textContent`/`aria-label`, never on
   CSS classes** (`ADD_SOURCE_RE`, `DROP_ZONE_RE` in `uploader.ts`) —
   Angular obfuscates classes and changes them between releases.
6. **`host_permissions` for both Google domains are required
   simultaneously:** `https://notebooklm.google.com/*` and
   `https://notebook.google.com/*` (Google renamed NotebookLM to Gemini
   Notebook and keeps both domains alive at the same time, as of July
   2026) — removing either one breaks part of the user base without
   warning. `scripting` is now requested — but only for reading page
   text: the current-page capture button on the Link tab and the
   «Add selection to Notebook» context menu
   (`chrome.scripting.executeScript` in `popup.ts` / `background.ts`, tab
   access is granted by `activeTab` — the popup being open, or the
   context-menu click — no new `host_permissions` required for either);
   the NotebookLM/YouTube content scripts are still declared statically
   in the manifest, not through `chrome.scripting.executeScript`. Don't
   broaden this further without
   a reason that genuinely breaks functionality without it — see
   "narrowest permissions" in the Chrome Web Store requirements; Plan B
   from the README (injection into the MAIN world) will no longer
   require a new permission, only a different `executeScript` call.
7. **Zero runtime dependencies**, dev-only deps are `esbuild`,
   `typescript`, `@types/chrome`, `oxlint` + `oxlint-tsgolint` (the
   only type-aware linter that runs on TS 7; typescript-eslint refuses it). React is deliberately not used — the
   popup is one form.
8. `popup.html` loads `../../dist/popup.js` because `default_popup`
   points at `src/popup/popup.html`, while `dist/` sits at the root.
9. **The RPC path is primary, the DOM path is a fallback — neither may
   be removed.** `uploader.ts:runUpload` first tries
   `uploadFileViaRpc` (private `batchexecute`, `rpc.ts`); on the first
   failure it switches permanently to `runDomBatches` for the rest of
   the queue in this upload session. The two paths break from
   different, independent causes — RPC from Google changing the private
   protocol (rpcid, parameter format), DOM from a redesign of
   NotebookLM's Angular markup — so removing one "because the other
   exists" would leave the extension with no fallback at the very next
   breakage. Detailed repair guide — `README.md` → "If upload doesn't
   work".
10. **No backend/proxy, ever.** All RPC requests (`rpc.ts`,
    `notebook.ts`) go directly with `credentials: 'include'` from the
    content script to the notebook page's `location.origin` — Google
    session cookies never leave the user's browser. Do not add an
    intermediary server even "for logging" or "for retries" — sending
    session cookies to a third-party server means leaking access to the
    user's Google account and near-certain delisting from the Chrome
    Web Store.
11. **Add-source RPC versioning.** Google has already changed the rpcid
    for adding a YouTube source (`izAoDd` → `ozz5Z`) without
    announcement. `notebook.ts:addYoutubeSource` detects the working
    version once and caches the result in `chrome.storage.local`
    (`SOURCE_RPC_VERSION_KEY`) — don't rewrite it to "always try v1
    first" without the cache, that costs an extra RPC call per video.
    For the same reason (Google moves slots without announcement),
    `notebook.ts:extractSourceUrls` does not index a fixed slot in the
    source metadata from the `rLM1Ne` response: a YouTube source's URL
    lives at `metadata[5]` (`[url, videoId, channel]`), a web source's
    at `metadata[7]`. The function instead recursively scans the whole
    result for `http(s)://…`-shaped strings (the same trick
    `extractSourceNames` already uses for `.md` filenames) — do not
    "simplify" it back to indexing by a fixed slot, the next slot shift
    would silently reset dedup.
12. **Known authentication ceiling, not to be fixed right now.**
    `rpc.ts:invalidateTokens()` forces the next call to re-read the
    CSRF/session tokens from `document.documentElement.innerHTML` — but
    NotebookLM/Gemini Notebook is an SPA: if the session expired after
    the page's first load, the DOM won't refresh itself, and re-reading
    it returns the same stale token. In practice the auth retry boils
    down to the `AUTH_EXPIRED_MESSAGE` — "reload the page". A real fix
    would require either a full tab reload from code (`location.
    reload()`, debatable — cuts off the user's context without asking),
    or a separate way to refresh the token without a reload — neither is
    done; the decision is deferred, not forgotten.
13. **Upload dedup is by record, not by filename; there is still no
    local state.** Previously, files whose names already matched
    notebook sources were subtracted (`chunker.ts:newFiles`) — but the
    name encodes the batch's position in the current run (`{index}`)
    and the cursor of its last record (`{cursor}`), and both depend on
    packing: a change to the chunking budget/mode (in `2ebb6f7`, back
    when it was still called `max_chars_per_file`/`mode`, the default
    was raised from 120000 to 1800000 characters and
    `max_records_per_file` was removed; modes have since disappeared
    entirely) changes all the names at once — no matches are found, and
    the whole dataset gets re-uploaded. Now two facts are reconstructed
    from the notebook's source names: the highest `{index}` already in
    use (a new run is numbered starting at `maxIndex + 1` via
    `chunker.ts:buildFiles(..., indexOffset)`) and the cursor of the
    most recently uploaded record — records strictly after it are
    considered new (`cursor.ts:recordsAfter`, compared via slugified
    cursors through `cursorKey`, not raw values). `chunker.ts:
    uploadedState(names, pattern, sourceSlug, records, f)` — the
    inverse of `makeFilename`: the cursor is not parsed out of the
    filename (a date slug already contains dashes, the boundaries are
    ambiguous); instead, for each record the expected filename is
    built and a match is looked up among the source names. `newFiles`
    was removed. The inline dedup by name in `uploader.ts:runUpload`
    remains as a safety net. There is still no local state (a watermark
    in `chrome.storage.local`), and none should be added — the single
    source of truth is the notebook's own source names: it drifted from
    reality with manual source deletion, YouTube sources (which
    inflated the counter), two JSONs in one notebook, and reinstall,
    and in the worst case it permanently jammed Preview ("No new
    records" with zero sources). For the same reason `listSourceNames`
    does not swallow an RPC error into `[]`: "no sources" and "RPC did
    not respond" must be distinguishable, otherwise a network failure
    reads as an empty notebook. On a reconciliation failure we show
    everything and print a warning — `runUpload` will strip duplicates.
14. **Source deletion goes only through RPC `tGMBJ`, there is
    deliberately no DOM fallback.** `delete-ui.ts` injects a trash-can
    icon into the Sources panel's `label-row` row, to the right of the
    sort button (the `sort` icon); a click takes the checkbox-selected
    rows, batch-deletes them in one `notebook.ts:deleteSources` call,
    and does a `location.reload()` (the SPA won't re-render itself).
    Simulating the overflow menu × N clicks as a reserve path, the way
    it's done for upload (decision #9), was deliberately skipped here:
    this is an irreversible operation on top of fragile selectors — if
    the RPC breaks, the button simply stops working, and that's the
    correct behavior, not a reason to risk hitting the wrong menu item
    by accident. The source id is read from
    `id="source-item-more-button-<UUID>"` in the source row, not by
    matching on title — titles in a notebook can be duplicated. Do not
    remove the `confirm()` before deletion: NotebookLM selects all
    sources by default, so without the dialog the button would wipe out
    the entire notebook with one click. «Select duplicate sources» in
    `sources-ui.ts` deletes nothing at all — it only unchecks every row
    and re-checks the duplicates, so deletion still goes through this
    button and its `confirm()`.
15. **Licensing calls Polar's public license API directly from the
    popup — no backend, no merchant API key in the bundle.**
    `src/lib/license.ts` hits `activate`/`validate`/`deactivate` under
    `api.polar.sh/v1/customer-portal/license-keys` with
    `credentials: 'omit'`; those three endpoints are unauthenticated by
    design (the license key itself is the credential), so there is
    nothing for a server to guard and nothing consistent with decision
    #10 to add. Every call carries `organization_id` — Polar scopes keys
    per organization, and without it a key bought from any other Polar
    seller would validate here. A merchant whose validation needs a
    secret API key is disqualified by decision #10, not by price. The
    check is **fail-open with a 30-day grace window** — a network
    hiccup or Polar being down must
    never revoke a paid feature; only a definitive rejection does that.
    With Polar the distinction is an HTTP status, not a field in the
    body: an unknown key answers `404`, so `licenseVerdict()` maps
    404/403 to `invalid`, a `granted` status (unexpired) to `valid`, and
    everything else — 5xx, rate limits, an unparseable body, a thrown
    fetch — to `unknown`, which is what the grace window protects.
    Cutting Pro off on a flaky connection is worse than a month of
    accidental free use. The gate is
    check-then-commit, and the rule is one sentence no matter which
    surface triggers it: more than one source added in a single action is
    metered/Pro, a single source is always free. That rule is checked at
    three call sites — `requireProOrTrial()` in `popup.ts` for bulk JSON
    upload and for selecting more than one YouTube video, and the
    equivalent inline check in `src/content/youtube-ui.ts`'s `openDialog`
    Add-button handler (the one funnel all four in-page YouTube entry
    points — watch page, watch-page playlist panel, playlist page, channel
    harvest — go through, and the first point where the channel harvest's
    real video count is known) — Pro passes unmetered, free spends from a
    shared quota; `noteTrialUse()` commits the spend, called only after the
    work is actually dispatched, so a failed handoff never burns a unit —
    except on the YouTube path, where dispatch (`submitJob`) itself ends
    in opening/focusing the notebook tab via `OPEN_NOTEBOOK`, which
    closes the popup and kills every statement after it; there
    `noteTrialUse()` runs immediately after the gate passes, right before
    `submitJob`, not after it. The in-page
    dialog does not have this problem — opening the tab doesn't kill the
    content-script context — so there `noteTrialUse()` runs after the job
    is written to `chrome.storage.local`, right before `OPEN_NOTEBOOK`, the
    same honest order as the JSON upload path.
    Still never sprinkled `if (isPro)` through the codebase. Free users
    get `FREE_QUOTA = 5` gated actions per calendar month, shared
    between the two actions, tracked in a `trial` key
    (`{ month, used }`) in `chrome.storage.sync` — resets on the 1st.
    The "no backend to defend a removable check" reasoning above extends
    to the quota as-is: a `storage.sync` counter is exactly as removable
    from public source as the license check, so a server to guard it
    would be the same overhead for the same non-gain. And license
    fetches must never move into a content script: `api.polar.sh`
    has no CORS allowance for the notebook's/YouTube's origin, so
    `activate`/`validate`/`deactivate` only work from the popup.
    `isPro()`/`trialRemaining()`/`noteTrialUse()` themselves are fine to
    call from a content script — they only touch `chrome.storage.sync`
    (readable/writable from content scripts, decision #3) — but `isPro()`
    must not try to revalidate there: `canReachLicenseApi()` in
    `license.ts` gates `revalidate()` on `location.protocol ===
    'chrome-extension:'`, so a content script reads the last cached
    valid/invalid state from storage and never fires the doomed-to-CORS-
    fail fetch, which would otherwise, after `GRACE_MS`, flip a valid
    license to invalid just because it happened to run on the wrong page.
    `FREE_QUOTA` and the LS storefront values
    (`PRICE_LABEL`, `CHECKOUT_URL`, `LS_VARIANT_ID`) are build-time
    defaults hardcoded in `license.ts`; they're overridable from a
    git-ignored `.env` (see `.env.example`), inlined by `build.mjs` via
    esbuild `define`. No `.env` is required to build — the in-code
    fallbacks keep a fresh clone working. Trap: `define` only matches
    the literal `process.env.SOURCE_LM_*` member expression at each use
    site, not an aliased reference. `REVALIDATE_AFTER_MS`/`GRACE_MS` are
    not part of this — they stay hardcoded on purpose.
16. **Fixing a broken source is a notebook→popup hand-off, not a fetch.**
    The notebook tab's content script can neither fetch the failed page
    (CORS) nor `chrome.scripting.executeScript` into another tab — only
    the popup can, and only on the active tab via `activeTab`. So
    `sources-ui.ts` opens the page and parks
    `{notebookId, sourceId, url, title, createdAt}` in a `fixQueue`
    array in `chrome.storage.local` (5-minute TTL, same reasoning as
    `readAndClearJob`, decision #3); the popup matches it against the
    active tab URL and turns «Add page as .md» into a replacement. The
    alternative — `<all_urls>` host permissions so something could fetch
    the page itself — is exactly the permission broadening decision #6
    forbids. `runYoutubeJob` deletes `replaceSourceId` **only after the
    replacement upload succeeded**: the broken source is the user's only
    copy of that page in the notebook, so a failed upload must leave it
    alone, and a failed delete is reported without being counted as a
    failed upload. Only `status === 3 && type === 5` (errored web page)
    is offered a fix — status 3 is transient for audio/unclassified
    sources; errored YouTube sources are listed as unfixable.

17. **`_locales` exists for the Chrome Web Store listing only, not for
    the UI.** `manifest.json` carries `default_locale: "en"` and
    `__MSG_extName__`/`__MSG_extDesc__`, and `_locales/{en,es,ja,zh_TW}/
    messages.json` hold just those two keys — the store shows a
    localized name and short description (and only then offers a
    per-locale listing tab in the dashboard). The popup UI, errors and
    status text stay English and `chrome.i18n` must not appear in the
    code: translating ~150 UI strings is a maintenance cost the measured
    demand (Japan only) does not pay for. `_locales` has to be listed
    explicitly in the two packaging commands (`package.json` `package`
    and `.github/workflows/release.yml`), or the store rejects the zip
    for a missing default locale.

18. **A Notion page is fetched through Notion's own export endpoint — not by
    scraping the DOM, and not through `loadPageChunk`.** `notion-ui.ts` posts
    an `exportBlock` task to `/api/v3/enqueueTask`, polls `/api/v3/getTasks`
    every 1.5s until `results[0].state === 'success'` hands back
    `status.exportURL`, downloads that zip and unpacks it in
    `lib/notion-export.ts` (stored entries and
    `DecompressionStream('deflate-raw')` — no dependency, decision #7). The
    zip itself is fetched from the signed `file.notion.com` URL the task hands
    back, and that URL is host-checked against `*.notion.com` / `*.notion.so`
    before it is followed with the user's cookies (same rule as the upload URL
    in `uploader.ts`). A zip inside a zip is unwrapped at most two levels deep
    and the whole export may unpack to at most 64 MiB (`MAX_UNZIPPED`), so a
    hostile or broken archive cannot grow until the tab dies.
    The point of this route is that Notion itself does the Markdown
    conversion — headings, tables, code, callouts, database rows — and
    `recursive: true` brings the child pages along for free. Scraping the
    rendered page, which is what every competing extension does, loses all of
    that and cannot reach a child page at all; `loadPageChunk`, the other
    private API, broke in 2021, 2024 and again in August 2026, while the
    export request body has not changed since 2019 (notion-py →
    notion-exporter → Notion-Backup). Same risk profile as Google's
    `batchexecute` (#9/#11): a private API called same-origin from the content
    script with the user's own session cookie, and no server of ours anywhere
    in the middle (#10).
    **Depth 1 is a filter on zip paths, not a second request.**
    `flattenExportFiletree: false` lays the export out as `Parent <id>.md`,
    `Parent <id>/Child <id>.md`, `Parent <id>/Child <id>/Grand.md`, so
    `pickPages` keeps the `.md` entries at most one level below the shallowest
    `.md` (depth is relative to the root page's own directory, so the
    `Export-<uuid>/` wrapper does not eat a level) and database rows
    (`Parent/DB <id>/Row.md`) drop out by themselves. Ceiling:
    over a huge subtree `recursive: true` over-exports and can take minutes —
    the upgrade path, if it ever hurts, is listing the children and exporting
    each one non-recursively. The checkbox that sets `recursive` is the only
    way this surface can produce more than one source, so it is also the gate
    point (#15) — and a ticked box that yields nothing but the root page is
    still one source, so `noteTrialUse()` runs on the real file count, not on
    the checkbox.
    **Two hosts, two paths: `app.notion.com` and `*.notion.site`.** The app
    moved to `app.notion.com` and `www.notion.so/<id>` 302s to
    `app.notion.com/p/<slug-id>` (checked 2026-09-19); both hosts sit in
    `content_scripts` only — **not** in `host_permissions`, because every
    Notion call is same-origin from the content script, and an MV3 content
    script gets no cross-origin fetch privilege from a host permission anyway,
    so the grant would be wider than the code uses and wider than the store
    review needs to see. One `dist/notion.js` serves both. On a published site the export endpoint answers **401** — it
    is for members of the workspace, and a public reader is not one (verified
    live 2026-09-19) — so `notion-public.ts` reads the page's own block JSON
    instead, with the same calls the site itself makes, same-origin, no auth:
    `loadCachedPageChunk` (`{page:{id}, limit:50, cursor, chunkNumber,
    verticalColumns:false}`, paginated while `cursor.stack` is non-empty),
    then `syncRecordValuesMain` for the ids the chunks referenced but did not
    carry (`missingBlockIds`, batches of 100, at most three rounds — a block
    we may not read never arrives), and `lib/notion-blocks.ts` turns the
    merged record map into Markdown. This is the `loadPageChunk` family the
    paragraph above calls brittle, and that is accepted **only here**, because
    on a public page there is no export to prefer: the alternative is scraping
    the DOM, which loses tables, child pages and database rows.
    **Database rows come from `queryCollection`, not from `content[]`.** A
    database page is a `collection_view_page` block whose rows exist only as
    the result of a view query, so the row ids are fetched with
    `queryCollection` against `view_ids[0]` (the first view is what the
    visitor sees) with a `collection_group_results` reducer, and each row id is
    then a page of its own. With the checkbox off, a database page would be a
    bare title, so the root file gets an `## Entries` list of the row titles
    (`entriesSection`) instead; with it on, every row becomes its own source,
    as do the child pages and the rows of any inline database — depth 1 in all
    three cases.
    **Cap: 300 files** on both paths, NotebookLM's Pro ceiling; past it the
    upload would fail anyway, so the public run stops collecting there and
    says so in the progress line, and the export path slices its result to the
    same number. Requests are sequential, with a 150 ms pause between chunks
    of one page and between pages (the `syncRecordValuesMain` batches that
    fill in the missing ids run back to back) — a public site is someone
    else's bandwidth, and nothing here is worth a rate limit.
    **When the public path breaks:** open the published page with DevTools on
    Network, watch what the site's own XHR posts to `/api/v3/*`, and mirror
    it — same rule as for the export body and the notebook RPC.
    **Verified by hand on 2026-09-19:** the
    two API calls work same-origin with exactly the body `exportTaskBody`
    builds (the server echoes it back with `block.spaceId` filled in — we do
    not have to send it), and `fetch(exportURL, {credentials:'include'})`
    against the signed `file.notion.com` URL answers 200 `application/zip`
    cross-origin. So there is **no relay and no extra host permission**. If
    Notion ever tightens CORS there, the fix is a ~5-line relay through
    `background.ts` plus `https://file.notion.com/*` in `host_permissions`
    (an extension-origin fetch ignores CORS) — the narrowest possible
    widening of #3's stateless worker; `exportPages` already turns the bare
    TypeError such a refusal produces into "Notion blocked the export
    download — reload the page and try again" so it reaches the user instead
    of the console.
    **When it breaks:** open Notion's own ••• → Export dialog with DevTools on
    Network and diff its `enqueueTask` body against `exportTaskBody` — that
    request is the only reliable specification of this protocol, exactly the
    same rule as for the notebook RPC.

19. **The review ask is one neutral prompt, not a gate.** `lib/review.ts`
    counts successful uploads (`UPLOAD_DONE` with `uploaded > 0 && failed ===
    0`, in both `uploader.ts` and `notebook.ts`) and shows a popup bar after
    the 3rd — never at install, before the user has gotten any value. No
    incentive (no trial/Pro extension for reviewing) and no review gating
    ("happy? → store, not happy? → email") — the latter is exactly the
    rating-manipulation pattern the CWS Developer Program Policy prohibits.
    State lives in `storage.local` (per-device): a second machine re-asks
    after its own 3 successful runs, which is acceptable for something this
    low-stakes.

## NotebookLM limits (warning logic in Preview)

- 50 sources/notebook on the free plan, 300 on Pro —
  `chunker.ts:MAX_FREE_SOURCES`.
- 500,000 words OR 200 MB per source, whichever comes first — on any
  plan (the plan tier gates the number of sources, not the size of one).
  For markdown we always hit the word limit first, 200 MB of text is
  practically unreachable. `chunker.ts:WORD_LIMIT` (same 500k) — a soft
  warning, not enforcement.
## Working style

Minimal diff, standard library and platform before dependencies, no
abstractions "for the future". Non-trivial logic gets one test in
`test/convert.test.mjs` (same file also has the trick: `esbuild.
buildSync` inlines `src/lib/*` into a single module and imports it as a
`data:` URI, so TS runs directly through `node --test` without a
separate compile step).

**Everything in this repository is English, including this file.**
Comments, names, string literals (including the popup UI and error/
status text), test names, `README.md`, `PRIVACY.md`, and
`DECISIONS.md` itself are all in English; the extension is published on the
Chrome Web Store and review reads English. Russian survives only in
conversation with the user, and in the Russian-locale UI selector
literals matching the Russian locale of NotebookLM's own UI
(`ADD_SOURCE_RE`, `DROP_ZONE_RE` in `uploader.ts`) and of YouTube's
(`SHUFFLE_RE`, `PLAY_ALL_RE`, `SUBSCRIBE_RE`, `VIDEOS_TAB_RE` in
`youtube-ui.ts`, `SORT_BUTTON_RE` in `delete-ui.ts`), plus the
corresponding test fixtures in `test/convert.test.mjs` — those Russian
variants are selectors, not prose, and must never be translated or
removed.

