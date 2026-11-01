// How the Terminal hands the selection to the renderer: in viewport cells, once per change of the selection or the
// view, with the rows it left and entered redrawn in the same frame (fake renderer in headless Chrome).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

test('the selection reaches the renderer in viewport cells when it or the view moves', async () => {
  const facts = await withPage('test/pages/selection-frame.ts', async page => {
    await page.waitForFunction(() => window.result, null, { timeout: 20000 });
    return page.evaluate(() => window.result);
  });
  assert.equal(facts.error, undefined, facts.error);
  const range = (start, end, columnSelect = false) => ({ start, end, columnSelect });

  // select(3, baseY + 1, 25) at 20 columns: viewport row 1 col 3 to row 2 col 8, drawn in one frame with only its rows
  assert.deepEqual(facts.select.selections, [range([3, 1], [8, 2])]);
  assert.equal(facts.select.renders.length, 1, 'no extra frame');
  assert.deepEqual(facts.select.renders[0].dirty, [1, 2]);

  // Nothing new for the renderer when neither the selection nor the view moved
  assert.equal(facts.idle.selections, 1);
  assert.deepEqual(facts.idle.renders.map(r => r.dirty), [[5]]);

  assert.deepEqual(facts.scrolled, range([3, 3], [8, 4]), 'two rows down after scrolling back two');
  assert.deepEqual(facts.offscreen, range([3, 13], [8, 14]), 'below the view: the renderer clips it');

  assert.deepEqual(facts.column.selection, range([2, 0], [6, 3], true), 'Alt drag selects a column');
  assert.equal(facts.column.text, 'ne 2\nne 2\nne 2\nne 2');

  assert.equal(facts.cleared.selection, undefined);
  assert.equal(facts.cleared.count, 6, 'select, two scrolls, back to the bottom, the column, the clear');
  assert.deepEqual(facts.cleared.renders.map(r => r.dirty), [[0, 1, 2, 3]], 'the cleared rows, in one frame');
});
