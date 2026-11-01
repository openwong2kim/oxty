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

test('setOptions re-measures font, line height and letter spacing, and redraws with a new theme', async () => {
  const r = await inPage(() => {
    const p = new T.Pane(10, 3, { fontSize: 14 });
    p.write('\x1b[41m \x1b[0m').frame();
    const dims = () => JSON.parse(JSON.stringify(p.renderer.dimensions));
    const base = dims();
    p.renderer.setOptions({ fontSize: 28 });
    const big = { ...dims(), canvas: [p.renderer.canvas.width, p.renderer.canvas.height], requests: p.redrawRequests.slice() };
    p.renderer.setOptions({ fontSize: 14, lineHeight: 1.5 });
    const tall = dims();
    p.renderer.setOptions({ lineHeight: 1, letterSpacing: 2 });
    const spaced = dims();
    p.renderer.setOptions({ letterSpacing: 0, theme: { background: '#203040', red: '#00ff00' } });
    return { base, big, tall, spaced, red: p.cellColor(0, 0), empty: p.cellColor(5, 1) };
  });
  const { base, big, tall, spaced } = r;
  assert.ok(Math.abs(big.device.char.width - 2 * base.device.char.width) <= 1, 'char width follows the font size');
  assert.deepEqual(big.canvas, [big.device.cell.width * 10, big.device.cell.height * 3]);
  assert.deepEqual(big.requests, ['all']);
  assert.equal(tall.device.cell.height, Math.floor(base.device.char.height * 1.5));
  assert.equal(tall.device.char.top, Math.round((tall.device.cell.height - tall.device.char.height) / 2));
  assert.equal(spaced.device.cell.width, base.device.char.width + 2);
  assert.equal(spaced.device.char.left, 1);
  assert.deepEqual(r.red, [0, 0xff, 0]);
  assert.deepEqual(r.empty, [0x20, 0x30, 0x40]);
});

test('renderers with the same options share an atlas; it is disposed once no renderer holds it', async () => {
  const r = await inPage(() => {
    const disposed = atlas => T.disposedAtlases.has(atlas);
    const a = new T.Pane(10, 2).frame(), b = new T.Pane(10, 2).frame();
    const first = a.renderer._atlas;
    const shared = first === b.renderer._atlas;
    a.renderer.setOptions({ fontSize: 20 });
    const second = a.renderer._atlas;
    const keptForB = !disposed(first) && second !== first;
    a.renderer.setOptions({ fontSize: 22 });
    const third = a.renderer._atlas;
    const secondFreed = disposed(second);
    a.dispose();
    const thirdFreed = disposed(third) && !disposed(first);
    b.dispose();
    return { shared, keptForB, secondFreed, thirdFreed, firstFreed: disposed(first) };
  });
  assert.deepEqual(r, { shared: true, keptForB: true, secondFreed: true, thirdFreed: true, firstFreed: true });
});

test('a lost WebGL context that is restored draws the same picture again', async () => {
  const r = await inPage(async () => {
    const p = new T.Pane(20, 4);
    p.write('\x1b[31mhello \x1b[44m한글\x1b[0m 😀 \x1b[4;58;2;255;0;0mline\x1b[0m').frame();
    const before = p.pixels();
    const canvas = p.renderer.canvas;
    const ext = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    ext.loseContext();
    await T.sleep(50);
    p.write('!').frame();
    ext.restoreContext();
    for (let n = 0; n < 100 && !p.redrawRequests.includes('all'); n++) await T.sleep(20);
    p.write('\b \b');
    return { requests: p.redrawRequests, sameCanvas: canvas === p.renderer.canvas, diff: T.diff(before, p.pixels()) };
  });
  assert.deepEqual(r, { requests: ['all'], sameCanvas: true, diff: 0 });
});

test('a lost context that is not restored within 3 s gets a new canvas and context', async () => {
  const r = await inPage(async () => {
    const p = new T.Pane(20, 4);
    p.write('\x1b[32mrecreated\x1b[0m').frame();
    const before = p.pixels();
    const canvas = p.renderer.canvas;
    canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
    const t0 = performance.now();
    while (!p.redrawRequests.includes('all') && performance.now() - t0 < 5000) await T.sleep(50);
    return { after: Math.round(performance.now() - t0), replaced: canvas !== p.renderer.canvas && !canvas.isConnected && p.renderer.canvas.isConnected, diff: T.diff(before, p.pixels()) };
  });
  assert.ok(r.after >= 3000 && r.after < 4000, `recreated after ${r.after} ms`);
  assert.deepEqual([r.replaced, r.diff], [true, 0]);
});

test('17 renderers on a page: the evicted one waits, takes a hidden pane\'s context, and gets one back when a pane goes away', async () => {
  const r = await inPage(async () => {
    const panes = [];
    // Whether a pane's canvas shows its text (not just a cleared or empty canvas)
    const draws = p => {
      if (p.renderer._state !== 'live') return false;
      const px = p.pixels();
      return px.some((v, i) => i % 4 !== 3 && v > 0x80);
    };
    const states = () => panes.map(p => p.renderer._state[0]).join('');
    const drawing = () => panes.map(p => (draws(p) ? 1 : 0)).join('');
    for (let i = 0; i < 17; i++) panes.push(new T.Pane(12, 1).write(`pane ${i}`).frame());
    await T.sleep(300);
    const created = { states: states(), drawing: drawing() };
    // A hidden pane gives its context to the visible pane that has none
    panes[5].container.style.display = 'none';
    await T.sleep(300);
    const hidden = { states: states(), drawing: drawing() };
    // Shown again, it takes the least recently used context (Chrome's pick), pane 0's since drawing() drew it first, and
    // pane 0 waits: nothing is hidden to take from
    panes[5].container.style.display = '';
    await T.sleep(300);
    const shown = { states: states(), drawing: drawing() };
    // A disposed pane frees a context for the waiting one
    panes[3].dispose();
    panes.splice(3, 1);
    await T.sleep(300);
    return { created, hidden, shown, disposed: { states: states(), drawing: drawing() }, requests: panes[0].redrawRequests };
  });
  assert.deepEqual(r.created, { states: 'p' + 'l'.repeat(16), drawing: '0' + '1'.repeat(16) });
  assert.deepEqual(r.hidden, { states: 'lllllp' + 'l'.repeat(11), drawing: '111110' + '1'.repeat(11) });
  assert.deepEqual(r.shown, { states: 'p' + 'l'.repeat(16), drawing: '0' + '1'.repeat(16) });
  assert.deepEqual(r.disposed, { states: 'l'.repeat(16), drawing: '1'.repeat(16) });
  // Pane 0 asked for a full redraw each time it got a context
  assert.deepEqual(r.requests, ['all', 'all']);
});

const CURSOR_THEME = { theme: { background: '#000000', cursor: '#ff0000', cursorAccent: '#000000' } };

test('cursor: DECSCUSR shape over the cursorStyle default, cursorInactiveStyle when unfocused', async () => {
  const r = await inPage(theme => {
    const red = c => c[0] === 0xff && c[1] === 0 && c[2] === 0;
    // Where red shows in the cursor cell: centre, left edge, bottom edge, top edge
    const probe = p => [p.cellColor(2, 0), p.cellColor(2, 0, 0.02, 0.5), p.cellColor(2, 0, 0.5, 0.97), p.cellColor(2, 0, 0.5, 0.02)].map(c => (red(c) ? 1 : 0)).join('');
    const p = new T.Pane(10, 2, theme);
    p.renderer.setFocused(true);
    p.write('ab').frame();
    const out = { block: probe(p) };
    out.bar = probe(p.write('\x1b[6 q').frame());
    out.underline = probe(p.write('\x1b[4 q').frame());
    p.write('\x1b[2 q').frame();
    p.renderer.setOptions({ cursorStyle: 'bar' });
    out.optionBar = probe(p);
    p.renderer.setFocused(false);
    out.outline = probe(p);
    p.renderer.setOptions({ cursorInactiveStyle: 'none' });
    out.none = probe(p);
    p.write('\x1b[?25l');
    p.renderer.setFocused(true);
    out.hidden = probe(p);
    return out;
  }, CURSOR_THEME);
  assert.deepEqual(r, { block: '1111', bar: '0100', underline: '0010', optionBar: '0100', outline: '0111', none: '0000', hidden: '0000' });
});

test('cursor blink is timed by the renderer and asks for the cursor row', async () => {
  const r = await inPage(async theme => {
    const p = new T.Pane(10, 3, { ...theme, cursorBlink: true });
    p.write('\r\nab').frame();
    p.renderer.setFocused(true);
    const shown = () => p.cellColor(2, 1)[0] === 0xff;
    const seen = [shown()];
    p.redrawRequests.length = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 1400) {
      await T.sleep(50);
      if (shown() !== seen[seen.length - 1]) seen.push(shown());
    }
    const requests = p.redrawRequests.filter(r => r !== 'all');
    // Unfocused, the cursor stops blinking and stays shown
    p.renderer.setFocused(false);
    p.redrawRequests.length = 0;
    await T.sleep(700);
    return { seen, requests, unfocused: p.redrawRequests.filter(r => r !== 'all').length };
  }, CURSOR_THEME);
  assert.deepEqual(r.seen, [true, false, true]);
  assert.ok(r.requests.length >= 2 && r.requests.every(rows => rows.length === 1 && rows[0] === 1), JSON.stringify(r.requests));
  assert.equal(r.unfocused, 0);
});

test('selection colours the selected cells and redraws only the affected rows', async () => {
  const r = await inPage(() => {
    const p = new T.Pane(10, 4, { theme: { background: '#000000', selectionBackground: '#ff000080', selectionInactiveBackground: '#0000ff80' } });
    p.renderer.setFocused(true);
    p.write('abcdef\r\nghijkl\r\nmnopqr\x1b[?25l').frame();
    // Cell top-left corners (away from glyphs): 1 when selection-coloured
    const map = () => [0, 1, 2, 3].map(y => [0, 1, 2, 3, 4, 5, 6, 7].map(x => (p.cellColor(x, y, 0.05, 0.05)[0] > 0x30 || p.cellColor(x, y, 0.05, 0.05)[2] > 0x30 ? 1 : 0)).join('')).join('|');
    const out = {};
    p.redrawRequests.length = 0;
    p.renderer.setSelection({ start: [2, 0], end: [3, 1], columnSelect: false });
    out.requests = p.redrawRequests.slice();
    out.linear = map();
    p.renderer.setSelection({ start: [1, 1], end: [4, 3], columnSelect: true });
    out.column = map();
    p.renderer.setFocused(false);
    out.inactiveBlue = p.cellColor(2, 2, 0.05, 0.05)[2] > 0x30;
    p.redrawRequests.length = 0;
    p.renderer.setSelection(undefined);
    out.cleared = map();
    out.clearRequests = p.redrawRequests.slice();
    return out;
  });
  assert.deepEqual(r.requests, [[0, 1]]);
  assert.equal(r.linear, '00111111|11100000|00000000|00000000');
  assert.equal(r.column, '00000000|01110000|01110000|01110000');
  assert.equal(r.inactiveBlue, true);
  assert.equal(r.cleared, '00000000|00000000|00000000|00000000');
  assert.deepEqual(r.clearRequests, [[1, 2, 3]]);
});

test('a devicePixelRatio change re-measures, resizes the canvas and fires onDimensionsChange', async () => {
  const r = await withPage('test/pages/renderer-basic.ts', async page => {
    await page.waitForFunction(() => window.ready);
    await page.evaluate(() => {
      window.p = new T.Pane(10, 2).write('dpr').frame();
      window.changes = 0;
      p.renderer.onDimensionsChange(() => changes++);
      window.before = JSON.parse(JSON.stringify(p.renderer.dimensions));
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 2, mobile: false });
    // Emulation changes devicePixelRatio but sends none of the signals a real zoom does (window resize, a new device
    // pixel size for the canvas), so send the resize a zoom would
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForFunction(() => changes > 0, null, { timeout: 5000 });
    return page.evaluate(() => ({ changes, before, after: p.renderer.dimensions, canvas: [p.renderer.canvas.width, p.renderer.canvas.height], requests: p.redrawRequests }));
  });
  assert.equal(r.changes, 1);
  assert.deepEqual(r.after.css.canvas, r.before.css.canvas);
  assert.ok(Math.abs(r.after.device.char.width - 2 * r.before.device.char.width) <= 1);
  assert.deepEqual(r.canvas, [r.after.device.canvas.width, r.after.device.canvas.height]);
  assert.ok(r.requests.includes('all'));
});

test('fonts that finish loading re-measure, clear fallback glyphs and fire onDimensionsChange', async () => {
  const r = await inPage(async () => {
    const p = new T.Pane(10, 2, { fontFamily: 'OxttyTestFont, monospace' });
    p.write('WWW').frame();
    const before = p.renderer.dimensions.css.cell.width;
    let changes = 0;
    p.renderer.onDimensionsChange(() => changes++);
    // A wide proportional font under a new name, so the cell width visibly changes once it is in
    const face = new FontFace('OxttyTestFont', 'local("Arial"), local("Helvetica")');
    document.fonts.add(face);
    await face.load();
    for (let n = 0; n < 50 && !changes; n++) await T.sleep(20);
    return { before, after: p.renderer.dimensions.css.cell.width, changes, requests: p.redrawRequests };
  });
  assert.ok(r.after > r.before, `${r.before} → ${r.after}`);
  assert.equal(r.changes, 1);
  assert.ok(r.requests.includes('all'));
});

test('dispose releases the atlas, the context, the canvas and the blink timers', async () => {
  const r = await inPage(async () => {
    const p = new T.Pane(10, 2, { cursorBlink: true }).write('x').frame();
    p.renderer.setFocused(true);
    const atlas = p.renderer._atlas;
    const canvas = p.renderer.canvas;
    const gl = canvas.getContext('webgl2');
    await T.sleep(100);
    let frames = 0;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = cb => (frames++, raf(cb));
    p.renderer.dispose();
    await T.sleep(1500);
    window.requestAnimationFrame = raf;
    return { atlasFreed: T.disposedAtlases.has(atlas), lost: gl.isContextLost(), removed: !canvas.isConnected, frames };
  });
  assert.deepEqual(r, { atlasFreed: true, lost: true, removed: true, frames: 0 });
});
