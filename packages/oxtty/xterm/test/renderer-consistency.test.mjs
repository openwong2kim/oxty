import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

test('incremental rendering matches a fresh render pixel for pixel', async () => {
  const results = await withPage('test/pages/renderer-consistency.ts', async page => {
    await page.waitForFunction(() => window.ready);
    return page.evaluate(() => [1, 2, 3].map(seed => window.run(seed, 200)));
  });
  for (const [k, r] of results.entries()) {
    assert.equal(r.checkpoints, 10);
    assert.deepEqual(r.diffs, new Array(10).fill(0), `seed ${k + 1}`);
    assert.ok(r.sentinel > 0, 'a single changed cell shows up');
  }
});
