import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  // Same unit as NotebookLM's hard limit of 500k words per source
  // (WORD_LIMIT in chunker.ts) — 400k leaves a 20% margin for word-count
  // estimation error. An underestimate of markdown overhead once pushed
  // an export 35% over the limit — every source bounced on upload.
  max_words_per_file: 400_000,
  content_fields: 'auto',
  metadata: true,
  filename_pattern: '{source}-{index}-{cursor}-{title_slug}.md',
  incremental: true,
  source_name: '',
};

function getChromeStorage(): any {
  return (globalThis as any).chrome?.storage;
}

// {index} and {cursor} are mandatory for incremental reconciliation
// (chunker.ts:uploadedState), so the popup only lets the user edit the
// prefix. Also repairs patterns stored by older versions, which could lack
// them.
export const FILENAME_SUFFIX = '-{index}-{cursor}-{title_slug}.md';

export function patternPrefix(pattern: string): string {
  return pattern
    .replace(/\{index\}|\{cursor\}|\{title_slug\}/g, '')
    .replace(/\.md$/, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function patternFromPrefix(prefix: string): string {
  return patternPrefix(prefix) + FILENAME_SUFFIX;
}

export async function loadSettings(): Promise<Settings> {
  const storage = getChromeStorage();
  if (!storage) return { ...DEFAULT_SETTINGS };
  const stored = await storage.sync.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...(stored.settings ?? {}),
    filename_pattern: patternFromPrefix(stored.settings?.filename_pattern ?? DEFAULT_SETTINGS.filename_pattern),
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  const storage = getChromeStorage();
  if (!storage) return;
  await storage.sync.set({ settings: s });
}
