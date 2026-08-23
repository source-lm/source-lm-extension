export interface LicenseState {
  key: string;
  instanceId: string;
  valid: boolean;
  checkedAt: number;
  email?: string;
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
// Placeholder — replace once the Lemon Squeezy product/checkout exists.
export const CHECKOUT_URL =
  process.env.SOURCE_LM_CHECKOUT_URL || 'https://REPLACE-ME.lemonsqueezy.com/checkout/buy/REPLACE-ME';
// Public store/product identifier used to reject a license bought for a
// different product in the same Lemon Squeezy store. '' skips the check.
export const LS_VARIANT_ID = process.env.SOURCE_LM_VARIANT_ID || '';

export const REVALIDATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

const LS_API = 'https://api.lemonsqueezy.com/v1/licenses';

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

// All Lemon Squeezy calls happen from the popup only — a content script
// inherits the NotebookLM/YouTube page origin and would be CORS-blocked by
// api.lemonsqueezy.com even with host_permissions.
async function callLicenseApi(endpoint: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${LS_API}/${endpoint}`, {
    method: 'POST',
    // Explicit: no cookies of any kind travel to the merchant (decision #10).
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params),
  });
  return res.json();
}

export async function activateLicense(key: string): Promise<{ ok: boolean; error?: string; state?: LicenseState }> {
  try {
    const resp = await callLicenseApi('activate', { license_key: key, instance_name: instanceName() });
    if (!resp?.activated || !resp.instance?.id) {
      return { ok: false, error: resp?.error ?? 'Activation failed' };
    }
    if (LS_VARIANT_ID && String(resp.meta?.variant_id) !== LS_VARIANT_ID) {
      return { ok: false, error: 'invalid_product' };
    }
    const state: LicenseState = {
      key,
      instanceId: resp.instance.id,
      valid: true,
      checkedAt: Date.now(),
      email: resp.meta?.customer_email,
    };
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
    const resp = await callLicenseApi('deactivate', { license_key: s.key, instance_id: s.instanceId });
    await clearLicense();
    if (!resp?.deactivated) return { ok: false, error: resp?.error ?? 'Deactivation failed' };
    return { ok: true };
  } catch (e) {
    // The key is dead to us locally regardless of whether LS heard the request.
    await clearLicense();
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

export function shouldRevalidate(s: LicenseState | null, now: number): boolean {
  return !!s && now - s.checkedAt > REVALIDATE_AFTER_MS;
}

// Pure fail-open rule: an unknown result (network/parse/HTTP failure, modeled
// as resp being null or missing `valid`) keeps the previous valid/checkedAt
// until GRACE_MS has elapsed, so a paid feature never dies just because the
// user is offline.
export function applyValidateResult(s: LicenseState, resp: unknown, now: number): LicenseState {
  const r = resp as { valid?: boolean; license_key?: { status?: string } } | null;
  if (r && typeof r.valid === 'boolean') {
    const bad = !r.valid || r.license_key?.status === 'expired' || r.license_key?.status === 'disabled';
    return { ...s, valid: !bad, checkedAt: now };
  }
  if (now - s.checkedAt <= GRACE_MS) return s;
  return { ...s, valid: false, checkedAt: now };
}

async function revalidate(s: LicenseState): Promise<void> {
  let resp: unknown = null;
  try {
    resp = await callLicenseApi('validate', { license_key: s.key, instance_id: s.instanceId });
  } catch {
    resp = null;
  }
  await saveLicense(applyValidateResult(s, resp, Date.now()));
}

// isPro() is called from both the popup and content scripts (this file has
// no DOM/chrome-API restriction otherwise). Revalidation must stay
// popup-only: from a content script the fetch to api.lemonsqueezy.com is
// always CORS-blocked (no allowance for page origins), and the failure path
// (applyValidateResult with a null resp) would, after GRACE_MS, flip a
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
