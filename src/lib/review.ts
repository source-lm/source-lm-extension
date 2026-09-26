// Ask for a store review after a few successful uploads — never at install,
// never gated behind "are you happy?" (DECISIONS.md #19). State lives in
// storage.local (per-device, not synced): a second machine re-asks after its
// own 3 successful runs, which is acceptable for something this low-stakes.

export interface ReviewState {
  runs: number;
  next: number | null;
}

const DEFAULT_REVIEW_STATE: ReviewState = { runs: 0, next: 3 };

function getChromeStorage(): any {
  return (globalThis as any).chrome?.storage;
}

export async function loadReview(): Promise<ReviewState> {
  const storage = getChromeStorage();
  if (!storage) return DEFAULT_REVIEW_STATE;
  const stored = await storage.local.get('review');
  return stored.review ?? DEFAULT_REVIEW_STATE;
}

async function saveReview(s: ReviewState): Promise<void> {
  const storage = getChromeStorage();
  if (!storage) return;
  await storage.local.set({ review: s });
}

// Pure: true once `runs` has reached the next ask threshold. `next: null`
// means "don't ask again" (stop()) and always reads false.
export function shouldAsk(s: ReviewState): boolean {
  return s.next !== null && s.runs >= s.next;
}

export async function noteSuccessfulRun(): Promise<void> {
  const s = await loadReview();
  await saveReview({ ...s, runs: s.runs + 1 });
}

// "Later": ask again after 10 more successful runs.
export async function snooze(): Promise<void> {
  const s = await loadReview();
  await saveReview({ ...s, next: s.runs + 10 });
}

// "Don't ask again": stop asking for good.
export async function stop(): Promise<void> {
  const s = await loadReview();
  await saveReview({ ...s, next: null });
}

// The store listing to send the user to — Edge Add-ons in Edge (its UA
// includes both `Edg/` and `Chrome/`, so this check has to run first), the
// Chrome Web Store reviews tab everywhere else.
export function storeUrl(): string {
  const ua = (globalThis as any).navigator?.userAgent ?? '';
  return ua.includes('Edg/')
    ? 'https://microsoftedge.microsoft.com/addons/detail/source-lm/inigmpceananlbjobihfcpadmbcbkafi'
    : 'https://chromewebstore.google.com/detail/source-lm/egebmhbkdageoafdbpacoaohogcobcbg/reviews';
}
