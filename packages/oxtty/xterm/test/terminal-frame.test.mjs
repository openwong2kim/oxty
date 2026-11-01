// The Terminal facade in headless Chrome with a fake renderer: DOM, frame loop, options, fit, crash, dispose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

test('open, frames, options, fit, crash recovery and dispose drive the renderer like xterm.js', async () => {
  const facts = await withPage('test/pages/terminal-frame.ts', async page => {
    await page.waitForFunction(() => window.result, null, { timeout: 20000 });
    return page.evaluate(() => window.result);
  });
  assert.equal(facts.error, undefined, facts.error);

  const { open } = facts;
  assert.deepEqual(open.classes, ['terminal', 'xterm']);
  assert.ok(open.inParent && open.styleInjected);
  assert.deepEqual(open.screen, [true, true, '180px', '72px'], 'canvas and helpers in .xterm-screen, sized to the canvas');
  assert.deepEqual([open.rendererOptions.fontSize, open.rendererOptions.theme], [15, { background: '#101010' }]);
  assert.deepEqual(open.firstRender, ['all']);
  assert.deepEqual(open.rendered, [{ start: 0, end: 3 }]);

  assert.deepEqual(facts.focus, [false, true, false]);

  const { write } = facts;
  assert.equal(write.renders, 2, 'one frame for both writes');
  assert.deepEqual(write.last.rows.slice(0, 2), ['hello', 'world']);
  assert.ok(write.last.changed.includes(0) && write.last.changed.includes(1));
  assert.deepEqual(write.rendered, [{ start: 0, end: 1 }]);

  assert.deepEqual(facts.redraw, [2]);

  const { options } = facts;
  assert.deepEqual(options.sent, [{ fontSize: 20 }, { theme: { background: '#202020' } }]);
  assert.deepEqual(options.dimensionChanges, [12]);
  assert.deepEqual(options.screen, ['240px', '96px']);

  // Parent 300×200 minus the 14px scrollbar xterm.js keeps: 286 / 12 = 23 cols, 200 / 24 = 8 rows.
  assert.deepEqual(facts.fit.proposed, { cols: 23, rows: 8 });
  assert.deepEqual(facts.fit.fitted, [23, 8]);
  assert.deepEqual(facts.fit.refitted, [28, 8], 'refit after the renderer reported a narrower cell');
  assert.deepEqual(facts.fit.dimensionChanges, [12, 10]);

  const { crash } = facts;
  // The full frame may come before or with the frame that draws 'ok'
  assert.ok(crash.dirty.includes('all'), 'full redraw after the crash');
  assert.deepEqual(crash.selections, [undefined], 'selection cleared');
  assert.equal(crash.line, 'ok');
  assert.equal(crash.last.rows[0], 'ok');

  assert.deepEqual(facts.dispose, { removed: true, disposed: true, renders: 0 });
});
