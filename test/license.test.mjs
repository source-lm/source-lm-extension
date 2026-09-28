import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './helpers.mjs';

const {
  shouldRevalidate,
  applyValidateResult,
  licenseVerdict,
  GRACE_MS,
  REVALIDATE_AFTER_MS,
  monthKey,
  trialLeft,
  spendTrial,
  FREE_QUOTA,
  loadTrial,
} = await bundle('lib/license');

test('license: shouldRevalidate triggers once checkedAt is stale', () => {
  const now = Date.now();
  const stale = { key: 'k', instanceId: 'i', valid: true, checkedAt: now - REVALIDATE_AFTER_MS - 1 };
  assert.equal(shouldRevalidate(stale, now), true);
});

test('license: shouldRevalidate stays false while checkedAt is fresh', () => {
  const now = Date.now();
  const fresh = { key: 'k', instanceId: 'i', valid: true, checkedAt: now - 1000 };
  assert.equal(shouldRevalidate(fresh, now), false);
});

test('license: shouldRevalidate re-checks a lapsed (invalid) state too, so it can self-heal', () => {
  const now = Date.now();
  const lapsed = { valid: false, checkedAt: now - REVALIDATE_AFTER_MS - 1 };
  assert.equal(shouldRevalidate(lapsed, now), true);
});

test('license: shouldRevalidate is false for a null state', () => {
  assert.equal(shouldRevalidate(null, Date.now()), false);
});

test('license: licenseVerdict reads a 404 (unknown key or wrong organization) as a definitive no', () => {
  assert.equal(licenseVerdict(404, { error: 'ResourceNotFound' }, Date.now()), 'invalid');
});

test('license: licenseVerdict reads a revoked key as invalid, a granted one as valid', () => {
  const now = Date.now();
  assert.equal(licenseVerdict(200, { status: 'revoked' }, now), 'invalid');
  assert.equal(licenseVerdict(200, { status: 'granted' }, now), 'valid');
});

test('license: licenseVerdict honours expires_at even while the key still reads granted', () => {
  const now = Date.now();
  assert.equal(licenseVerdict(200, { status: 'granted', expires_at: new Date(now - 1000).toISOString() }, now), 'invalid');
  assert.equal(licenseVerdict(200, { status: 'granted', expires_at: new Date(now + 1000).toISOString() }, now), 'valid');
});

test('license: licenseVerdict treats a server error or unparseable body as unknown, not as a revocation', () => {
  const now = Date.now();
  assert.equal(licenseVerdict(500, null, now), 'unknown');
  assert.equal(licenseVerdict(429, { detail: 'slow down' }, now), 'unknown');
  assert.equal(licenseVerdict(200, null, now), 'unknown');
});

test('license: applyValidateResult flips to invalid on an invalid verdict', () => {
  const now = Date.now();
  const s = { key: 'k', instanceId: 'i', valid: true, checkedAt: now - 1000 };
  const next = applyValidateResult(s, 'invalid', now);
  assert.equal(next.valid, false);
  assert.equal(next.checkedAt, now);
});

test('license: applyValidateResult fails open on an unknown verdict within the grace window', () => {
  const now = Date.now();
  const checkedAt = now - GRACE_MS + 1000;
  const s = { key: 'k', instanceId: 'i', valid: true, checkedAt };
  const next = applyValidateResult(s, 'unknown', now);
  assert.equal(next.valid, true);
  assert.equal(next.checkedAt, checkedAt, 'checkedAt must not move while still within grace');
});

test('license: applyValidateResult flips to invalid on an unknown verdict past the grace window', () => {
  const now = Date.now();
  const s = { key: 'k', instanceId: 'i', valid: true, checkedAt: now - GRACE_MS - 1000 };
  const next = applyValidateResult(s, 'unknown', now);
  assert.equal(next.valid, false);
});

test('license: spendTrial exhausts the monthly quota, and a previous-month state reads back as full', () => {
  const now = Date.now();
  let t = null;
  for (let i = 0; i < FREE_QUOTA; i++) {
    assert.equal(trialLeft(t, now) > 0, true, `unit ${i + 1} should still be available`);
    t = spendTrial(t, now);
  }
  assert.equal(trialLeft(t, now), 0, 'a 4th use must be blocked');

  const lastMonth = { month: monthKey(now - 31 * 24 * 60 * 60 * 1000), used: FREE_QUOTA };
  assert.equal(trialLeft(lastMonth, now), FREE_QUOTA, 'a new month resets the quota');
});

test('license: loadTrial re-reads storage on every call, does not cache stale state module-wide', async () => {
  // globalThis.chrome is unused elsewhere in this file — restored below.
  let stored = { used: 1 };
  globalThis.chrome = { storage: { sync: { get: async () => ({ trial: stored }) } } };
  try {
    const first = await loadTrial();
    assert.equal(first.used, 1);

    // Mutate storage behind loadTrial's back — a module-level cache would
    // still return the stale `used: 1` read above.
    stored = { used: 3 };
    const second = await loadTrial();
    assert.equal(second.used, 3, 'loadTrial must re-read storage, not return a cached value');
  } finally {
    delete globalThis.chrome;
  }
});
