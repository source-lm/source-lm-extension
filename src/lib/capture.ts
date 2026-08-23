// Turning text grabbed off a web page into a Markdown source. Shared by the
// two entry points that do it: "Add page as .md" in the popup and "Add
// selection to Notebook" in the context menu (src/background.ts). Pure and
// DOM-free on purpose — the service worker imports this module and nothing
// else, so nothing here may touch `window`/`document`.

import { slugify, frontmatter } from './markdown-generator';

// Same frontmatter shape src/lib/markdown-generator.ts uses for a JSON
// record (title/date fields), reusing its `frontmatter()` helper rather
// than hand-rolling another one here.
export function pageToMarkdown(
  title: string,
  url: string,
  text: string,
  scope: 'page' | 'selection',
): string {
  const fm = frontmatter([
    ['title', title],
    ['url', url],
    ['captured', new Date().toISOString()],
    // Tells the user which of the two got captured — the whole page or just
    // what was selected on it.
    ['scope', scope],
  ]);
  return [fm, `# ${title || url}`, text.trim()].filter(Boolean).join('\n\n');
}

// A page with no <title> would slugify to the literal "record"; fall back to
// the hostname so the source is still identifiable in the notebook.
export function captureFilename(host: string, title: string | undefined): string {
  return `[${host}]-${title ? slugify(title) : slugify(host)}.md`;
}
