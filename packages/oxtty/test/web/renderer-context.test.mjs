// WebGL context loss and the context hand-over between terminals (ported from the TypeScript front end's
// renderer.test.mjs and terminal-webgl.test.mjs at 0510a7d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

async function inPage(fn, arg) {
  return withPage('renderer.mjs', async (page) => {
    await page.waitForFunction(() => window.ready);
    return page.evaluate(fn, arg);
  });
}

test('a lost WebGL context that is restored draws the same picture again', async () => {
  const r = await inPage(async () => {
    const p = new T.Pane(20, 4);
    await p.write('\x1b[31mhello \x1b[44m한글\x1b[0m 😀 \x1b[4;58;2;255;0;0mline\x1b[0m');
    const before = await p.pixels();
    const canvas = p.canvas;
    const ext = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    p.takeRequests();
    ext.loseContext();
    await T.sleep(50);
    const lost = p.debug.state;
    await p.write('!');
    await p.pixels();
    ext.restoreContext();
    const requests = [];
    for (let n = 0; n < 100 && !requests.includes('all'); n++) {
      await T.sleep(20);
      requests.push(...p.takeRequests());
    }
    await p.write('\b \b');
    const out = { lost, requests, state: p.debug.state, sameCanvas: canvas === p.canvas, diff: T.diff(before, await p.pixels()) };
    p.dispose();
    return out;
  });
  assert.deepEqual(r, { lost: 'lost', requests: ['all'], state: 'live', sameCanvas: true, diff: 0 });
});

test('a lost context that is not restored within 3 s gets a new canvas and context', async () => {
  const r = await inPage(async () => {
    const p = new T.Pane(20, 4);
    await p.write('\x1b[32mrecreated\x1b[0m');
    const before = await p.pixels();
    const canvas = p.canvas;
    p.takeRequests();
    canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
    const t0 = performance.now();
    const requests = [];
    while (!requests.includes('all') && performance.now() - t0 < 5000) {
      await T.sleep(50);
      requests.push(...p.takeRequests());
    }
    const after = Math.round(performance.now() - t0);
    const replaced = canvas !== p.canvas && !canvas.isConnected && p.canvas.isConnected;
    const out = { after, replaced, diff: T.diff(before, await p.pixels()) };
    p.dispose();
    return out;
  });
  assert.ok(r.after >= 3000 && r.after < 4000, `recreated after ${r.after} ms`);
  assert.deepEqual([r.replaced, r.diff], [true, 0]);
});

test("17 terminals on a page: the evicted one waits, takes a hidden pane's context, and gets one back when a pane goes away", async () => {
  const r = await inPage(async () => {
    const panes = [];
    // Whether a pane's canvas shows its text (not just a cleared or empty canvas)
    const draws = async (p) => {
      if (p.debug.state !== 'live') return false;
      const px = await p.pixels();
      return px.some((v, i) => i % 4 !== 3 && v > 0x80);
    };
    const states = () => panes.map((p) => p.debug.state[0]).join('');
    const drawing = async () => {
      let s = '';
      for (const p of panes) s += (await draws(p)) ? 1 : 0;
      return s;
    };
    for (let i = 0; i < 17; i++) {
      const p = new T.Pane(12, 1);
      await p.write(`pane ${i}`);
      await p.pixels();
      panes.push(p);
    }
    await T.sleep(300);
    panes[0].takeRequests();
    const created = { states: states(), drawing: await drawing() };
    // A hidden pane gives its context to the visible pane that has none
    panes[5].container.style.display = 'none';
    await T.sleep(300);
    const hidden = { states: states(), drawing: await drawing() };
    // Shown again, it takes the least recently used context (Chrome's pick), pane 0's since drawing() drew it
    // first, and pane 0 waits: nothing is hidden to take from
    panes[5].container.style.display = '';
    await T.sleep(300);
    const shown = { states: states(), drawing: await drawing() };
    // A disposed pane frees a context for the waiting one
    panes[3].dispose();
    panes.splice(3, 1);
    await T.sleep(300);
    const disposed = { states: states(), drawing: await drawing() };
    const redraws = panes[0].takeRequests().filter((x) => x === 'all').length;
    for (const p of panes) p.dispose();
    return { created, hidden, shown, disposed, redraws };
  });
  assert.deepEqual(r.created, { states: 'p' + 'l'.repeat(16), drawing: '0' + '1'.repeat(16) });
  assert.deepEqual(r.hidden, { states: 'lllllp' + 'l'.repeat(11), drawing: '111110' + '1'.repeat(11) });
  assert.deepEqual(r.shown, { states: 'p' + 'l'.repeat(16), drawing: '0' + '1'.repeat(16) });
  assert.deepEqual(r.disposed, { states: 'l'.repeat(16), drawing: '1'.repeat(16) });
  // Pane 0 asked for a full redraw each time it got a context
  assert.equal(r.redraws, 2);
});

test('a real terminal draws coloured Hangul in the frame onRender reports, and answers a cursor position request', async () => {
  const r = await inPage(async () => {
    const p = new T.Pane(20, 3, { theme: { background: '#000000' } });
    const data = [];
    p.term.onData((d) => data.push(d));
    const drawn = new Promise((resolve) => {
      p.term.onRender(() => {
        const pixels = T.read(p.canvas);
        let lit = 0;
        let red = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] || pixels[i + 1] || pixels[i + 2]) lit++;
          if (pixels[i] > 150 && pixels[i + 1] < 100 && pixels[i + 2] < 100) red++;
        }
        if (red) resolve({ lit, red });
      });
    });
    await p.write('\x1b[31m한글\x1b[0m ok\x1b[6n');
    const out = { data, ...(await drawn) };
    p.dispose();
    return out;
  });
  assert.deepEqual(r.data, ['\x1b[1;8R']);
  assert.ok(r.red > 20, `red glyph pixels: ${r.red}`);
  assert.ok(r.lit > r.red, `lit pixels: ${r.lit}`);
});
