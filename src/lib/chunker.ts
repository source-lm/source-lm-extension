import type { Settings, DetectedFields, OutFile, PreviewResult } from './types';
import { recordToMarkdown, recordTitle, slugify, frontmatter } from './markdown-generator';
import { recordCursor, cursorKey } from './cursor';
const WORD_LIMIT = 500_000;
const MAX_FREE_SOURCES = 50;

type Rec = Record<string, unknown>;

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function fileBody(recs: Rec[], f: DetectedFields, s: Settings): string {
  return recs.map((r) => recordToMarkdown(r, f, s, false)).join('\n\n---\n\n');
}

// part/range use maximally wide placeholders at the packing stage, so the
// final render with real (shorter or equal) numbers cannot exceed the limit
// already checked against the placeholders.
function renderBatch(recs: Rec[], f: DetectedFields, s: Settings, part: string, range: string): string {
  if (recs.length === 1) return recordToMarkdown(recs[0], f, s, true);
  const fm = frontmatter([
    ['part', part],
    ['records', recs.length],
    ['range', range],
  ]);
  return (fm ? fm + '\n\n' : '') + fileBody(recs, f, s);
}

function packBySize(recs: Rec[], f: DetectedFields, s: Settings, warnings: string[]): Rec[][] {
  const batches: Rec[][] = [];
  let current: Rec[] = [];
  // Running word count of fileBody(current) (only meaningful once current.length >= 2 —
  // see trialWords below). Kept incrementally so re-measuring a growing batch is O(1)
  // per record instead of O(batch size): re-rendering the whole batch on every
  // added record made packing O(n^2) whenever a file stays large (generous
  // max_words_per_file), which hung for tens of seconds on
  // 20k records — see test "packBySize stays fast on large inputs with generous limits".
  let bodySum = 0;
  // The separator is its own whitespace-delimited token ('---'), so it's
  // always exactly one word and never merges with the words around it.
  const SEP_WORDS = wordCount('\n\n---\n\n');

  const bodyWordsCache = new WeakMap<Rec, number>();
  const bodyWords = (rec: Rec) => {
    let v = bodyWordsCache.get(rec);
    if (v === undefined) {
      v = wordCount(recordToMarkdown(rec, f, s, false));
      bodyWordsCache.set(rec, v);
    }
    return v;
  };
  const soloWordsCache = new WeakMap<Rec, number>();
  const soloWords = (rec: Rec) => {
    let v = soloWordsCache.get(rec);
    if (v === undefined) {
      v = wordCount(recordToMarkdown(rec, f, s, true));
      soloWordsCache.set(rec, v);
    }
    return v;
  };
  const envelopeWords = (n: number) => {
    const fm = frontmatter([['part', '999/999'], ['records', n], ['range', '99999-99999']]);
    return fm ? wordCount(fm) : 0;
  };

  // Mirrors renderBatch's exact word count for `current` + `rec`, without
  // re-rendering every record already in `current`.
  const trialWords = (rec: Rec) => {
    const n = current.length;
    if (n === 0) return soloWords(rec);
    if (n === 1) return envelopeWords(2) + bodyWords(current[0]) + SEP_WORDS + bodyWords(rec);
    return envelopeWords(n + 1) + bodySum + SEP_WORDS + bodyWords(rec);
  };

  for (const rec of recs) {
    if (trialWords(rec) <= s.max_words_per_file) {
      if (current.length === 1) {
        bodySum = bodyWords(current[0]) + SEP_WORDS + bodyWords(rec);
      } else if (current.length >= 2) {
        bodySum += SEP_WORDS + bodyWords(rec);
      }
      current.push(rec);
      continue;
    }
    if (current.length > 0) batches.push(current);

    const solo = soloWords(rec);
    if (solo > s.max_words_per_file) {
      warnings.push(
        `Record "${recordTitle(rec, f)}" (${solo} words) is longer than max_words_per_file — saved whole in its own file.`
      );
    }
    current = [rec];
    bodySum = 0;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function withFallbackId(rec: Rec, idx: number): Rec {
  const id = rec['id'];
  if (id !== undefined && id !== null && String(id) !== '') return rec;
  return { ...rec, id: idx };
}

function makeFilename(
  pattern: string,
  index: number,
  titleSlug: string,
  used: Set<string>,
  cursorSlug: string,
  sourceSlug: string
): string {
  const base = pattern
    .replace('{index}', String(index).padStart(3, '0'))
    .replace('{title_slug}', titleSlug)
    .replace('{group}', '') // patterns saved by older versions may still contain it
    .replace('{cursor}', cursorSlug)
    .replace('{source}', sourceSlug)
    // an empty {source} shouldn't leave "-011-...": collapse dashes
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '');

  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = base.replace(/\.md$/, '') + '-' + n + '.md';
    n++;
  }
  used.add(name);
  return name;
}

export function buildFiles(records: Rec[], f: DetectedFields, s: Settings, indexOffset = 0): PreviewResult {
  const warnings: string[] = [];

  const idxOf = new Map<Rec, number>(records.map((r, i) => [r, i + 1]));

  const batches: Rec[][] = packBySize(records, f, s, warnings);

  const usedNames = new Set<string>();
  const total = batches.length;

  const files: OutFile[] = batches.map((recs, i) => {
    const idx = indexOffset + i + 1;
    const globalIndices = recs.map((r) => idxOf.get(r)!);
    const range = `${Math.min(...globalIndices)}-${Math.max(...globalIndices)}`;
    const recsForRender =
      recs.length === 1 ? [withFallbackId(recs[0], idxOf.get(recs[0])!)] : recs;
    const md = renderBatch(recsForRender, f, s, `${idx}/${total}`, range);
    // Take the slug from the first record in the batch whose title contains
    // letters: some records have an empty `title`, and recordTitle() falls
    // through TITLE_CANDS to a numeric `id`, producing meaningless names like
    // 002-4037.md.
    const slugSource = recs.find((r) => /\p{L}/u.test(slugify(recordTitle(r, f)))) ?? recs[0];
    const titleSlug = slugify(recordTitle(slugSource, f));
    const lastRec = recs[recs.length - 1];
    const cursor = recordCursor(lastRec, f, idxOf.get(lastRec)!);
    const filename = makeFilename(
      s.filename_pattern,
      idx,
      titleSlug,
      usedNames,
      slugify(cursor),
      s.source_name ? slugify(s.source_name) : ''
    );

    const words = wordCount(md);
    if (words > WORD_LIMIT) {
      warnings.push(`File ${filename} exceeds 500000 words — NotebookLM's hard per-source limit.`);
    }

    return { filename, markdown: md, chars: md.length, words, records: recs.length, cursor };
  });

  if (files.length > MAX_FREE_SOURCES) {
    warnings.push(
      `${files.length} files will exceed the 50-source limit of NotebookLM's free plan — increase words per file.`
    );
  }

  const totalChars = files.reduce((a, file) => a + file.chars, 0);
  return { files, totalChars, warnings };
}

// Groups files so each group's total markdown stays within maxBytes.
// chrome.tabs.sendMessage has a hard IPC size ceiling — a single message
// carrying tens of MB of markdown never arrives, and the sender's promise
// rejects with a generic "could not reach" error that looks like a dead
// content script. Sending files in size-bounded groups instead avoids it.
// A single file already over maxBytes still gets its own group (per-file
// size is bounded by WORD_LIMIT above, so this is just its own group, never
// split or dropped).
export function groupByBytes<T extends { markdown: string }>(files: T[], maxBytes: number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const bytes = file.markdown.length;
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += bytes;
  }
  if (current.length > 0) groups.push(current);

  return groups;
}

function escRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Inverse of makeFilename: from the notebook's source names, recover the
// maximum already-used {index} and the cursor of the most recently uploaded
// file. We don't parse the cursor out of the name (a date slug itself
// contains dashes — the boundary is ambiguous), instead we go backwards:
// build the expected name for each record and look for a match among the
// notebook's names.
// ponytail: O(records × sources) regexes (1005×50 ≈ 50k, milliseconds);
// if datasets grow an order of magnitude — index names by prefix.
export function uploadedState(
  names: string[],
  pattern: string,
  sourceSlug: string,
  records: Rec[],
  f: DetectedFields
): { maxIndex: number; cursor: string | null } {
  const parts = pattern.split(/(\{index\}|\{cursor\}|\{title_slug\}|\{group\}|\{source\})/);

  // cursorPattern — a ready-made regex fragment for {cursor}: either the
  // escaped slug of a specific record, or `.*?` to match past any cursor.
  const buildRegex = (cursorPattern: string): RegExp => {
    const body = parts
      .map((part) => {
        if (part === '{index}') return '(\\d+)';
        if (part === '{cursor}') return cursorPattern;
        if (part === '{source}') return escRegex(sourceSlug);
        if (part === '{title_slug}' || part === '{group}') return '.*?';
        // Literals collapse repeated dashes (makeFilename does the same when
        // {source}/{group} is empty) — without this, the regex wouldn't match
        // already-uploaded names where the dashes got collapsed.
        return escRegex(part).replace(/-/g, '-*');
      })
      .join('');
    return new RegExp('^-*' + body + '$');
  };

  const anyRe = buildRegex('.*?');
  let maxIndex = 0;
  for (const name of names) {
    const m = name.match(anyRe);
    if (m) maxIndex = Math.max(maxIndex, parseInt(m[1], 10));
  }

  let cursor: string | null = null;
  let bestKey = '';
  // Without {cursor} in the pattern, a name isn't tied to a specific record:
  // the regex would match any of them and skip the whole dataset. In that
  // case we only return maxIndex.
  const hasCursor = parts.includes('{cursor}');
  for (let i = 0; hasCursor && i < records.length; i++) {
    const cSlug = slugify(recordCursor(records[i], f, i + 1));
    const key = cursorKey(cSlug);
    if (key <= bestKey) continue;
    const re = buildRegex(escRegex(cSlug));
    if (names.some((n) => re.test(n))) {
      cursor = cSlug;
      bestKey = key;
    }
  }

  return { maxIndex, cursor };
}
