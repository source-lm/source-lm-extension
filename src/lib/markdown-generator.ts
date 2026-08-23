import type { Settings, DetectedFields } from './types';
import { isNonEmptyValue, TITLE_CANDS } from './schema-detector';

function escScalar(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

// Tag-like values are not always strings: Better BibTeX / Zotero export
// `tags: [{tag: "…"}]` — `String()` on that gives "[object Object]".
function labelOf(x: unknown): string {
  if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return String(o['tag'] ?? o['name'] ?? JSON.stringify(x));
  }
  return String(x);
}

function fmValue(v: unknown): string {
  if (Array.isArray(v)) {
    return '[' + v.map((x) => '"' + escScalar(labelOf(x)) + '"').join(', ') + ']';
  }
  return '"' + escScalar(labelOf(v)) + '"';
}

// Shared helper for serializing frontmatter — used both per-record (here)
// and at the file level in chunker.ts (part/records/range/group).
export function frontmatter(pairs: [string, unknown][]): string {
  const lines = pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${fmValue(v)}`);
  if (lines.length === 0) return '';
  return '---\n' + lines.join('\n') + '\n---';
}

// The title field is detected across the whole dataset, but records can be
// heterogeneous: some objects have `name` instead of `title`. So there's a
// per-record fallback through the same candidate list (spec §4), otherwise
// such records would get "Untitled".
function rawTitle(rec: Record<string, unknown>, f: DetectedFields): string | undefined {
  if (f.titleField && isNonEmptyValue(rec[f.titleField])) return String(rec[f.titleField]);
  for (const k of TITLE_CANDS) {
    if (isNonEmptyValue(rec[k])) return String(rec[k]);
  }
  return undefined;
}

export function recordTitle(rec: Record<string, unknown>, f: DetectedFields): string {
  return rawTitle(rec, f) ?? 'Untitled';
}

export function slugify(input: string): string {
  let out = '';
  let lastDash = false;
  for (const ch of input.toLowerCase()) {
    if (/\p{L}|\p{N}/u.test(ch)) {
      out += ch;
      lastDash = false;
    } else if (!lastDash) {
      out += '-';
      lastDash = true;
    }
  }
  out = out.replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return out || 'record';
}

// An array of scalars stays a compact "a, b, c" string — a tree here would
// only add noise. Everything else object-like goes through renderTree.
function isScalarArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');
}

function metaValueToString(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Content fields are not always plain strings: Telegram Desktop exports a
// formatted message as `text: ["plain ", {type: "bold", text: "…"}, …]` —
// `String()` on that gives "[object Object]". Rich-text runs are joined into
// one string (the `text` of each entity), anything else object-like goes
// through renderTree.
function contentValueToString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) {
    return v
      .map((x) =>
        x !== null && typeof x === 'object' && 'text' in x && typeof (x as { text: unknown }).text === 'string'
          ? (x as { text: string }).text
          : contentValueToString(x),
      )
      .join('');
  }
  if (typeof v === 'object') return renderTree(v, 0, new WeakSet());
  return String(v);
}

const MAX_TREE_DEPTH = 8;

function inlineScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  return String(v);
}

function renderTree(val: unknown, depth: number, seen: WeakSet<object>): string {
  if (depth > MAX_TREE_DEPTH) return `${'  '.repeat(depth)}…`;
  if (val === null || typeof val !== 'object') return inlineScalar(val);

  if (seen.has(val as object)) return `${'  '.repeat(depth)}(circular)`;
  seen.add(val as object);
  const indent = '  '.repeat(depth);

  if (Array.isArray(val)) {
    if (val.length === 0) return `${indent}(empty)`;
    return val
      .map((v) =>
        v !== null && typeof v === 'object'
          ? `${indent}-\n${renderTree(v, depth + 1, seen)}`
          : `${indent}- ${inlineScalar(v)}`
      )
      .join('\n');
  }

  const entries = Object.entries(val as Record<string, unknown>);
  if (entries.length === 0) return `${indent}(empty)`;
  return entries
    .map(([k, v]) =>
      v !== null && typeof v === 'object'
        ? `${indent}- ${k}:\n${renderTree(v, depth + 1, seen)}`
        : `${indent}- ${k}: ${inlineScalar(v)}`
    )
    .join('\n');
}

function recordFrontmatter(rec: Record<string, unknown>, f: DetectedFields): string {
  const id = rec['id'];
  const sourceId = id !== undefined && id !== null && String(id) !== '' ? id : undefined;
  return frontmatter([
    ['source_id', sourceId],
    ['title', rawTitle(rec, f)],
    ['date', f.dateField ? rec[f.dateField] : undefined],
    ['tags', f.tagsField ? rec[f.tagsField] : undefined],
  ]);
}

export function recordToMarkdown(
  rec: Record<string, unknown>,
  f: DetectedFields,
  s: Settings,
  withFrontmatter: boolean
): string {
  const parts: string[] = [];

  if (withFrontmatter) {
    const fm = recordFrontmatter(rec, f);
    if (fm) parts.push(fm);
  }

  const unknownStructure = !f.titleField && f.contentFields.length === 0;
  if (unknownStructure) {
    parts.push(renderTree(rec, 0, new WeakSet()));
  } else {
    parts.push('# ' + recordTitle(rec, f));

    const contentText = f.contentFields
      .map((cf) => contentValueToString(rec[cf]))
      .filter((v) => v.trim() !== '')
      .join('\n\n');
    if (contentText) parts.push(contentText);

    // Without frontmatter (multi-record files) date and tags have nowhere else
    // to go — detectFields keeps them out of metadataFields — so they'd be lost
    // entirely. Put them at the top of Metadata instead.
    const extraKeys = withFrontmatter ? [] : [f.dateField, f.tagsField].filter((k): k is string => !!k);

    if (s.metadata && (extraKeys.length > 0 || f.metadataFields.length > 0)) {
      // Nested objects in Metadata are rendered as a tree, not a JSON string —
      // spec §4 requires readable markdown for unfamiliar structure, and it
      // shows up inside individual fields too, not just at the record level.
      const metaLines = [...extraKeys, ...f.metadataFields]
        .filter((k) => isNonEmptyValue(rec[k]))
        // `id` is already rendered above as `source_id` in frontmatter — no
        // need to repeat it in Metadata too, that only burns character budget.
        .filter((k) => !(withFrontmatter && k === 'id'))
        .map((k) => {
          const v = rec[k];
          if (k === f.tagsField && Array.isArray(v)) return `- ${k}: ${v.map(labelOf).join(', ')}`;
          if (v !== null && typeof v === 'object' && !isScalarArray(v)) {
            return `- ${k}:\n${renderTree(v, 1, new WeakSet())}`;
          }
          return `- ${k}: ${metaValueToString(v)}`;
        });
      if (metaLines.length > 0) parts.push('## Metadata\n\n' + metaLines.join('\n'));
    }
  }

  return parts.join('\n\n');
}
