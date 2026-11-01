// The built-in FitAddon and loadAddon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

async function inPage(fn, arg) {
  return withPage('renderer.mjs', async (page) => {
    await page.waitForFunction(() => window.ready);
    return page.evaluate(fn, arg);
  });
}

test('FitAddon proposes and applies the size that fills the parent, like @xterm/addon-fit', async () => {
  const r = await inPage(async () => {
    const parent = document.createElement('div');
    parent.style.cssText = 'width: 400px; height: 200px';
    document.body.appendChild(parent);
    const term = new T.Terminal({ fontFamily: 'Menlo, monospace', fontSize: 14 });
    const fit = new T.FitAddon();
    term.loadAddon(fit);
    const beforeOpen = fit.proposeDimensions();
    term.open(parent);
    const cell = term.dimensions.css.cell;
    const proposed = fit.proposeDimensions();
    fit.fit();
    const fitted = [term.cols, term.rows];
    const noScrollback = new T.Terminal({ fontFamily: 'Menlo, monospace', fontSize: 14, scrollback: 0 });
    const fit2 = new T.FitAddon();
    noScrollback.loadAddon(fit2);
    const parent2 = document.createElement('div');
    parent2.style.cssText = 'width: 400px; height: 200px';
    document.body.appendChild(parent2);
    noScrollback.open(parent2);
    const wide = fit2.proposeDimensions();
    fit.dispose();
    const disposed = fit.proposeDimensions();
    term.dispose();
    noScrollback.dispose();
    return { beforeOpen, cell, proposed, fitted, wide, disposed };
  });
  assert.equal(r.beforeOpen, undefined);
  const expected = { cols: Math.floor((400 - 14) / r.cell.width), rows: Math.floor(200 / r.cell.height) };
  assert.deepEqual(r.proposed, expected);
  assert.deepEqual(r.fitted, [expected.cols, expected.rows]);
  assert.deepEqual(r.wide, { cols: Math.floor(400 / r.cell.width), rows: expected.rows });
  assert.equal(r.disposed, undefined);
});

test('a loaded FitAddon refits by itself when fonts finish loading', async () => {
  const r = await inPage(async () => {
    const parent = document.createElement('div');
    parent.style.cssText = 'width: 600px; height: 100px';
    document.body.appendChild(parent);
    const term = new T.Terminal({ fontFamily: 'OxttyFitFont, monospace', fontSize: 14 });
    const fit = new T.FitAddon();
    term.loadAddon(fit);
    term.open(parent);
    fit.fit();
    const before = term.cols;
    const resizes = [];
    term.onResize((size) => resizes.push(size.cols));
    const face = new FontFace('OxttyFitFont', 'local("Arial"), local("Helvetica"), local("DejaVu Sans"), local("Liberation Sans")');
    document.fonts.add(face);
    await face.load();
    for (let n = 0; n < 50 && !resizes.length; n++) await T.sleep(20);
    const out = { before, after: term.cols, resizes, proposed: fit.proposeDimensions().cols };
    term.dispose();
    return out;
  });
  assert.ok(r.after < r.before, `${r.before} → ${r.after}`);
  assert.deepEqual(r.resizes, [r.after]);
  assert.equal(r.proposed, r.after);
});

test('loadAddon absorbs @xterm/addon-unicode11 and @xterm/addon-webgl and throws for any other addon', async () => {
  const r = await inPage(async () => {
    const { Unicode11Addon } = await import('/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs');
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const term = new T.Terminal();
    const error = (addon) => {
      try {
        term.loadAddon(addon);
        return null;
      } catch (e) {
        return String(e.message);
      }
    };
    class SearchAddon {
      activate(t) {
        this.t = t;
      }
      dispose() {}
    }
    const out = { unicode11: error(new Unicode11Addon()), search: error(new SearchAddon()), webgl: error(new WebglAddon()), plain: error({}) };
    term.dispose();
    return out;
  });
  assert.equal(r.unicode11, null);
  assert.match(r.search, /unsupported addon SearchAddon; only the built-in FitAddon and SearchAddon, @xterm\/addon-webgl and @xterm\/addon-unicode11/);
  assert.equal(r.webgl, null);
  assert.match(r.plain, /unsupported addon/);
});
