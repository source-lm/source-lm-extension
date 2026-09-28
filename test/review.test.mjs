import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './helpers.mjs';

const { shouldAsk, loadReview, noteSuccessfulRun, snooze, stop: reviewStop } = await bundle('lib/review');

test('review: shouldAsk fires at the run threshold, snooze delays it by 10 more runs, stop disables it for good', async () => {
  // Same stub-and-restore as the loadTrial test in license.test.mjs.
  let stored = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: stored[key] }),
        set: async (obj) => {
          stored = { ...stored, ...obj };
        },
      },
    },
  };
  try {
    assert.equal(shouldAsk(await loadReview()), false, 'no runs yet — default next is 3');
    await noteSuccessfulRun();
    await noteSuccessfulRun();
    assert.equal(shouldAsk(await loadReview()), false, '2 runs — still below the default threshold of 3');
    await noteSuccessfulRun();
    assert.equal(shouldAsk(await loadReview()), true, '3rd run reaches the threshold');

    await snooze();
    assert.equal(shouldAsk(await loadReview()), false, 'snooze pushes the threshold 10 runs out');
    for (let i = 0; i < 9; i++) await noteSuccessfulRun();
    assert.equal(shouldAsk(await loadReview()), false, '9 of the 10 snoozed runs — not there yet');
    await noteSuccessfulRun();
    assert.equal(shouldAsk(await loadReview()), true, '10th run since snooze reaches the new threshold');

    await reviewStop();
    assert.equal(shouldAsk(await loadReview()), false, 'stop must disable asking immediately');
    await noteSuccessfulRun();
    assert.equal(shouldAsk(await loadReview()), false, 'stop must disable asking for good, not just once');
  } finally {
    delete globalThis.chrome;
  }
});
