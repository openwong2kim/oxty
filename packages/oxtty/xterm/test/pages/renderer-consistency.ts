// Page for renderer-consistency.test.mjs (ported from spike/d3-webgl/bench/check.ts): a pane is driven by seeded random
// output, resizes, view scrolls, selection, focus and cursor changes, rendering incrementally after every step. At each
// checkpoint a fresh renderer draws the same viewport from scratch and the two canvases must match pixel for pixel.
import { Viewport } from '../../src/engine-view';
import { WebglRenderer } from '../../src/renderer/WebglRenderer';
import type { SelectionRange } from '../../src/renderer/types';
import { Pane, diff, ready } from './renderer-pane';

// mulberry32
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Distinct focused and unfocused selection colours, so focus changes must redraw the selection
const OPTIONS = { fontFamily: 'Menlo, monospace', fontSize: 14, theme: { selectionBackground: '#806030', selectionInactiveBackground: '#305080' } };
const WORDS = ['build', 'PASS', '한글', '터미널', '😀', '👍🏽', 'é', 'ñ', '│', '█▓░', '⠿', 'abc', 'x', '  ', '\t'];
const SGR = ['0', '1', '2', '3', '4', '4:3', '7', '9', '31', '42', '38;5;208', '48;5;24', '38;2;10;200;90', '48;2;60;0;90', '58;2;255;0;0', '1;34', '22;39;49'];

function step(pane: Pane, rnd: () => number, selection: { value: SelectionRange | undefined }, focused: { value: boolean }): void {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const { cols, rows } = pane.engine;
  const r = rnd();
  if (r < 0.55) {
    let s = '';
    for (let n = 1 + Math.floor(rnd() * 12); n > 0; n--) s += (rnd() < 0.3 ? `\x1b[${pick(SGR)}m` : '') + pick(WORDS) + (rnd() < 0.2 ? '\r\n' : ' ');
    pane.write(s);
  } else if (r < 0.65) {
    pane.write(`\x1b[${1 + Math.floor(rnd() * rows)};${1 + Math.floor(rnd() * cols)}H`);
  } else if (r < 0.7) {
    pane.write(`\x1b[${pick([2, 4, 6, 0])} q`);
  } else if (r < 0.74) {
    pane.write(pick(['\x1b[?25l', '\x1b[?25h', '\x1b[2J', '\x1b[K', '\x1b[3S', '\x1b[2T', '\x1b[?1049h', '\x1b[?1049l']));
  } else if (r < 0.8) {
    pane.write('\r\n'.repeat(1 + Math.floor(rnd() * rows)));
  } else if (r < 0.85) {
    pane.engine.scrollDisplay(Math.floor(rnd() * 9) - 3);
  } else if (r < 0.9) {
    pane.resize(10 + Math.floor(rnd() * 50), 3 + Math.floor(rnd() * 15));
  } else if (r < 0.96) {
    const a: [number, number] = [Math.floor(rnd() * cols), Math.floor(rnd() * rows)];
    const b: [number, number] = [Math.floor(rnd() * cols), Math.floor(rnd() * rows)];
    const [start, end] = a[1] < b[1] || (a[1] === b[1] && a[0] <= b[0]) ? [a, b] : [b, a];
    selection.value = rnd() < 0.2 ? undefined : { start, end, columnSelect: rnd() < 0.3 };
    pane.renderer.setSelection(selection.value);
  } else {
    focused.value = !focused.value;
    pane.renderer.setFocused(focused.value);
  }
}

/** A fresh renderer's picture of `viewport`. */
function freshPixels(pane: Pane, viewport: Viewport, selection: SelectionRange | undefined, focused: boolean): Uint8ClampedArray {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const fresh = new WebglRenderer(container, viewport.cols, viewport.rows, OPTIONS);
  fresh.setSelection(selection);
  fresh.setFocused(focused);
  fresh.render(viewport, [], 'all');
  const copy = document.createElement('canvas');
  copy.width = fresh.canvas.width;
  copy.height = fresh.canvas.height;
  const ctx = copy.getContext('2d')!;
  ctx.drawImage(fresh.canvas, 0, 0);
  const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
  fresh.dispose();
  container.remove();
  return data;
}

function run(seed: number, steps: number): { checkpoints: number; diffs: number[]; sentinel: number } {
  const rnd = random(seed);
  const pane = new Pane(40, 12, OPTIONS, 200);
  const selection = { value: undefined as SelectionRange | undefined };
  const focused = { value: false };
  const diffs: number[] = [];
  for (let n = 1; n <= steps; n++) {
    step(pane, rnd, selection, focused);
    pane.frame();
    if (n % 20 === 0 || n === steps) diffs.push(diff(pane.pixels(), freshPixels(pane, pane.viewport, selection.value, focused.value)));
  }
  // Sensitivity: one changed cell must show up
  const changed = new Viewport();
  Object.assign(changed, pane.viewport, { cells: pane.viewport.cells.slice() });
  changed.cells.set([changed.cells[0] === 0x58 ? 0x59 : 0x58, (1 << 24) | 256, (1 << 24) | 257, 0]);
  const sentinel = diff(pane.pixels(), freshPixels(pane, changed, selection.value, focused.value));
  pane.dispose();
  return { checkpoints: diffs.length, diffs, sentinel };
}

Object.assign(window, { run });
ready.then(() => Object.assign(window, { ready: true }));
