// Content script entry point for app.notion.com and public *.notion.site
// pages — everything it does lives in notion-ui.ts; this file only turns it on
// in the browser.
//
// Same shape as youtube.ts's bottom block: nothing at import time unless we
// are really running as an extension content script, so the module can be
// bundled and imported by the tests under Node.
//
// Unlike youtube.ts there is no chrome.runtime.onMessage listener: the popup
// has no Notion tab, the whole flow starts from the in-page button.

import { installNotionButton } from './notion-ui';

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  installNotionButton();
}
