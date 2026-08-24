export interface LicenseState {
  key: string;
  instanceId: string;
  valid: boolean;
  checkedAt: number;
}

// @types/node isn't installed (tsconfig only covers src) — declare the shape
// esbuild's `define` (build.mjs) actually substitutes at build time.
declare const process: { env: Record<string, string | undefined> };

// Overridable from a git-ignored .env, inlined by esbuild `define` in
// build.mjs; the literals below are the fallback when no .env exists, so a
// fresh clone still builds and tests still pass. Trap: `process.env.X` must
// appear literally at each use — esbuild's `define` matches the exact member
// expression, so aliasing it (`const env = process.env`) would NOT be
// substituted and would leave a live `process` read in the bundle.
export const PRICE_LABEL = process.env.SOURCE_LM_PRICE_LABEL || '$29';
// Placeholder — replace with the Checkout Link copied from the Polar
// dashboard (its host differs between sandbox and production).
export const CHECKOUT_URL =
  process.env.SOURCE_LM_CHECKOUT_URL || 'https://polar.sh/REPLACE-ME';
// Polar requires the organization id in every license call: without it a key
// issued by any other Polar seller would validate here.
export const POLAR_ORG_ID = process.env.SOURCE_LM_POLAR_ORG_ID || '';

export const REVALIDATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

// sandbox-api.polar.sh during testing; a sandbox key is invalid in production
// and vice versa, so this and POLAR_ORG_ID must always be switched together.
// The sandbox host is deliberately absent from manifest.json host_permissions
// (a domain the shipped build never calls is a CWS review question), so testing
// against it means re-adding it there for the duration.
const POLAR_API = (process.env.SOURCE_LM_POLAR_API || 'https://api.polar.sh') + '/v1/customer-portal/license-keys';

function getChromeStorage(): any {
  return (globalThis as any).chrome?.storage;
}

// Deliberately no module-level cache here: the popup and every content
// script are separate JS contexts (a YouTube content script outlives the
// popup for the whole tab lifetime), and there is no
// chrome.storage.onChanged listener to invalidate one. A cache meant one
// context could not see a license activated, or a trial unit spent, in
// another — stale reads and lost writes. storage.sync.get is cheap and
// runs a handful of times per user action, so re-read every time instead.
export async function loadLicense(): Promise<LicenseState | null> {
  const storage = getChromeStorage();
  if (!storage) return null;
  const stored = await storage.sync.get('license');
  return stored.license ?? null;
}

export async function saveLicense(s: LicenseState): Promise<void> {
  const storage = getChromeStorage();
  if (!storage) return;
  await storage.sync.set({ license: s });
}

export async function clearLicense(): Promise<void> {
  const storage = getChromeStorage();
  if (!storage) return;
  await storage.sync.remove('license');
}

function instanceName(): string {
  const ua = (globalThis as any).navigator?.userAgent ?? '';
  const os = /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return `Source LM — Chrome on ${os}`;
}

// All Polar calls happen from the popup only — a content script inherits the
// NotebookLM/YouTube page origin and would be CORS-blocked by api.polar.sh
// even with host_permissions.
//
// Returns the HTTP status alongside the body: unlike Lemon Squeezy, Polar
// answers "no such key" with 404 and an empty-ish error body, so the status is
// the only thing that separates "definitely invalid" from "we could not ask".
async function callLicenseApi(
  endpoint: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${POLAR_API}/${endpoint}`, {
    method: 'POST',
    // Explicit: no cookies of any kind travel to the merchant (decision #10).
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ ...params, organization_id: POLAR_ORG_ID }),
  });
  // 204 on deactivate, and an error body is not guaranteed to be JSON.
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function apiErrorMessage(status: number, body: any): string {
  if (status === 404) return 'License key not found';
  if (status === 403) return 'Activation limit reached — deactivate this key on another device first';
  const detail = body?.detail;
  return (typeof detail === 'string' && detail) || body?.error || `Activation failed (HTTP ${status})`;
}

export async function activateLicense(key: string): Promise<{ ok: boolean; error?: string; state?: LicenseState }> {
  try {
    const { status, body } = await callLicenseApi('activate', { key, label: instanceName() });
    if (status !== 200 || !body?.id) return { ok: false, error: apiErrorMessage(status, body) };
    if (body.license_key?.status !== 'granted') return { ok: false, error: 'This license key is no longer active' };
    // Polar's activation id, not the key id: validate and deactivate both
    // want it back, and it is what the activation limit counts.
    const state: LicenseState = { key, instanceId: body.id, valid: true, checkedAt: Date.now() };
    await saveLicense(state);
    return { ok: true, state };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

export async function deactivateLicense(): Promise<{ ok: boolean; error?: string }> {
  const s = await loadLicense();
  if (!s) return { ok: false, error: 'No license stored' };
  try {
    const { status, body } = await callLicenseApi('deactivate', { key: s.key, activation_id: s.instanceId });
    await clearLicense();
    // 204 No Content on success; 404 means Polar already lost the activation,
    // which is the state the user asked for anyway.
    if (status >= 400 && status !== 404) return { ok: false, error: apiErrorMessage(status, body) };
    return { ok: true };
  } catch (e) {
    // The key is dead to us locally regardless of whether Polar heard us.
    await clearLicense();
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

export function shouldRevalidate(s: LicenseState | null, now: number): boolean {
  return !!s && now - s.checkedAt > REVALIDATE_AFTER_MS;
}

export type Verdict = 'valid' | 'invalid' | 'unknown';

// Pure: turns one Polar answer into a verdict. Only a 404/403 — the key or its
// activation is gone, or it belongs to another organization — is a definitive
// no. A 5xx, a rate limit or an unparseable body is 'unknown' and must not
// revoke anything (see applyValidateResult).
export function licenseVerdict(status: number, body: any, now: number): Verdict {
  if (status === 404 || status === 403) return 'invalid';
  if (status !== 200 || !body) return 'unknown';
  if (body.status !== 'granted') return 'invalid';
  // Expiry is disabled on the product, but a key issued before that (or a
  // future dated product) would otherwise stay Pro forever on our side.
  if (body.expires_at && Date.parse(body.expires_at) <= now) return 'invalid';
  return 'valid';
}

// Pure fail-open rule: an 'unknown' verdict (network/HTTP failure) keeps the
// previous valid/checkedAt until GRACE_MS has elapsed, so a paid feature never
// dies just because the user is offline.
export function applyValidateResult(s: LicenseState, verdict: Verdict, now: number): LicenseState {
  if (verdict !== 'unknown') return { ...s, valid: verdict === 'valid', checkedAt: now };
  if (now - s.checkedAt <= GRACE_MS) return s;
  return { ...s, valid: false, checkedAt: now };
}

async function revalidate(s: LicenseState): Promise<void> {
  const now = Date.now();
  let verdict: Verdict = 'unknown';
  try {
    const { status, body } = await callLicenseApi('validate', { key: s.key, activation_id: s.instanceId });
    verdict = licenseVerdict(status, body, now);
  } catch {
    verdict = 'unknown';
  }
  await saveLicense(applyValidateResult(s, verdict, now));
}

// isPro() is called from both the popup and content scripts (this file has
// no DOM/chrome-API restriction otherwise). Revalidation must stay
// popup-only: from a content script the fetch to api.polar.sh is
// always CORS-blocked (no allowance for page origins), and the failure path
// (applyValidateResult with an 'unknown' verdict) would, after GRACE_MS, flip a
// perfectly valid license to invalid for no reason but running on the wrong
// page. The extension's own pages (popup, options) load over
// chrome-extension:, content scripts inherit the host page's origin.
function canReachLicenseApi(): boolean {
  return (globalThis as any).location?.protocol === 'chrome-extension:';
}

export async function isPro(): Promise<boolean> {
  const s = await loadLicense();
  if (canReachLicenseApi() && shouldRevalidate(s, Date.now())) {
    revalidate(s as LicenseState).catch(() => {});
  }
  return !!s?.valid;
}

// ---- free trial (decision #15 extended: 5 gated actions/month, no server) --

export const FREE_QUOTA = Number(process.env.SOURCE_LM_FREE_QUOTA) || 5;

export interface TrialState {
  month: string;
  used: number;
}

// 'YYYY-MM' in the user's local timezone — the reset the user perceives is
// their own calendar, not UTC.
export function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Uses left this month; a state from a previous month reads as full quota.
export function trialLeft(t: TrialState | null, now: number): number {
  if (!t || t.month !== monthKey(now)) return FREE_QUOTA;
  return Math.max(0, FREE_QUOTA - t.used);
}

// Pure: returns the next state after spending one unit (rolls the month over).
export function spendTrial(t: TrialState | null, now: number): TrialState {
  const month = monthKey(now);
  const used = t && t.month === month ? t.used : 0;
  return { month, used: used + 1 };
}

export async function loadTrial(): Promise<TrialState | null> {
  const storage = getChromeStorage();
  if (!storage) return null;
  const stored = await storage.sync.get('trial');
  return stored.trial ?? null;
}

export async function trialRemaining(): Promise<number> {
  return trialLeft(await loadTrial(), Date.now());
}

// No-op for Pro; otherwise persists spendTrial(...). Called AFTER the work is
// handed off, so a failed dispatch never burns a unit.
// Accepted residual: this is a read-modify-write with no cache, and
// chrome.storage has no atomic increment. Two contexts spending in the same
// instant can race and one unit can be lost — not worth a lock for a
// 3/month counter.
export async function noteTrialUse(): Promise<void> {
  if (await isPro()) return;
  const next = spendTrial(await loadTrial(), Date.now());
  const storage = getChromeStorage();
  if (!storage) return;
  await storage.sync.set({ trial: next });
}
