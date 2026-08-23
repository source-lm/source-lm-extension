import type { Settings, DetectedFields } from './types';

const SAMPLE_SIZE = 50;
const LONG_CONTENT_LEN = 200;

export const TITLE_CANDS = ['title', 'name', 'subject', 'heading', 'id'];
const CONTENT_CANDS = ['content', 'text', 'body', 'description', 'message'];
const DATE_CANDS = ['date', 'created_at', 'created', 'timestamp', 'datetime', 'published_at'];
const TAGS_CANDS = ['tags', 'categories', 'labels', 'keywords'];

export function isNonEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function pickField(sample: Record<string, unknown>[], candidates: string[]): string | null {
  if (sample.length === 0) return null;
  for (const cand of candidates) {
    const nonEmpty = sample.filter((r) => isNonEmptyValue(r[cand])).length;
    if (nonEmpty / sample.length >= 0.5) return cand;
  }
  return null;
}

export function detectFields(records: Record<string, unknown>[], s: Settings): DetectedFields {
  const sample = records.slice(0, SAMPLE_SIZE);

  const allKeys = new Set<string>();
  for (const r of sample) for (const k of Object.keys(r)) allKeys.add(k);

  const titleField = pickField(sample, TITLE_CANDS);
  const dateField = pickField(sample, DATE_CANDS);
  const tagsField = pickField(sample, TAGS_CANDS);

  let contentFields: string[];
  if (Array.isArray(s.content_fields)) {
    contentFields = s.content_fields;
  } else {
    const longStringKeys = [...allKeys].filter(
      (k) =>
        k !== titleField &&
        k !== dateField &&
        k !== tagsField &&
        sample.some((r) => typeof r[k] === 'string' && (r[k] as string).length > LONG_CONTENT_LEN)
    );
    if (longStringKeys.length > 0) {
      contentFields = longStringKeys;
    } else {
      // Heterogeneous records (one has `content`, another has `text`)
      // individually don't reach the 50% threshold pickField requires, even
      // though every record has main text somewhere. A single pickField call
      // would silently dump all that text into Metadata. So we take any field
      // from CONTENT_CANDS that shows up at all, without requiring a majority.
      contentFields = CONTENT_CANDS.filter(
        (k) => k !== titleField && k !== dateField && k !== tagsField && sample.some((r) => isNonEmptyValue(r[k]))
      );
    }
  }

  const used = new Set(
    [titleField, dateField, tagsField, ...contentFields].filter((k): k is string => !!k)
  );
  const metadataFields = s.metadata ? [...allKeys].filter((k) => !used.has(k)) : [];

  return { titleField, contentFields, dateField, tagsField, metadataFields };
}
