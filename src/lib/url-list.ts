// Parsing the Link tab's textarea: a pasted list of URLs, one per line (or
// comma-separated). Pure, no DOM — so it is testable and reusable.

export function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Splits on whitespace and commas, keeps only http(s) URLs (junk lines — a
// stray title, a bullet, a bare domain — are silently dropped rather than
// failing the whole paste), and dedupes keeping the first occurrence.
// Trailing slashes are preserved as typed: normalization for dedup against
// the notebook's existing sources is runYoutubeJob's job, not this one's.
export function parseUrlList(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const token of text.split(/[\s,]+/)) {
    if (!token || !isHttpUrl(token) || seen.has(token)) continue;
    seen.add(token);
    urls.push(token);
  }
  return urls;
}
