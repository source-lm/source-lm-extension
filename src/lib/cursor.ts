import type { DetectedFields } from './types';
import { slugify } from './markdown-generator';

type Rec = Record<string, unknown>;

function isNonEmpty(v: unknown): boolean {
  return v !== undefined && v !== null && String(v) !== '';
}

// Record cursor: date, otherwise id, otherwise ordinal number (idx is the
// 1-based index in the source array). Used in the filename (via {cursor}).
export function recordCursor(rec: Rec, f: DetectedFields, idx: number): string {
  if (f.dateField && isNonEmpty(rec[f.dateField])) return String(rec[f.dateField]);
  if (isNonEmpty(rec['id'])) return String(rec['id']);
  return String(idx);
}

const NUMERIC_RE = /^\d+$/;

// Cursors are compared in their slugified form (as they sit in filenames):
// a purely numeric one is zero-padded (otherwise '4037' > '11280'), everything
// else is left as-is (an ISO-date slug '2025-04-07t12-56-18' compares
// correctly lexicographically).
export function cursorKey(cursor: string): string {
  return NUMERIC_RE.test(cursor) ? cursor.padStart(20, '0') : cursor;
}

// Records strictly after the watermark cursor (already slugified, as it sits
// in the filename) — the source of truth for incremental re-upload.
export function recordsAfter(records: Rec[], f: DetectedFields, watermarkSlug: string): Rec[] {
  const wm = cursorKey(watermarkSlug);
  return records.filter((rec, i) => cursorKey(slugify(recordCursor(rec, f, i + 1))) > wm);
}
