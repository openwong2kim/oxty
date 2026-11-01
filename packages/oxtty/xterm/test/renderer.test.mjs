import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

// Runs `fn` in the renderer page once oxtty.wasm is loaded; `fn` sees the helpers as `window.T`.
async function inPage(fn, arg, options) {
  return withPage('test/pages/renderer-basic.ts', async page => {
    await page.waitForFunction(() => window.ready);
    return page.evaluate(fn, arg);
  }, options);
}

test('draws cell backgrounds, text and the theme background', async () => {
  const r = await inPage(() => {
    const p = new T.Pane(10, 3, { theme: { background: '#102030' } });
    p.write('\x1b[41m  \x1b[0m\x1b[42mAB\x1b[0m').frame();
    return { red: p.cellColor(0, 0), green: p.cellColor(2, 0, 0.05, 0.05), empty: p.cellColor(5, 1), canvas: [p.renderer.canvas.width, p.renderer.canvas.height], cell: p.renderer.dimensions.device.cell };
  });
  assert.deepEqual(r.red, [0xcc, 0, 0]);
  assert.deepEqual(r.green, [0x4e, 0x9a, 0x06]);
  assert.deepEqual(r.empty, [0x10, 0x20, 0x30]);
  assert.deepEqual(r.canvas, [r.cell.width * 10, r.cell.height * 3]);
});
