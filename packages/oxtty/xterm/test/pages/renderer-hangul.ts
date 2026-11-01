// Page for renderer-hangul.test.mjs: real xterm.js (WebGL addon) and the oxtty renderer side by side with the same font
// options and text (PRD §9 Hangul fallback width risk), compared by cell metrics, pixels and where each glyph's ink lies.
import { Terminal as XtermTerminal } from '@xterm/xterm/lib/xterm.mjs';
import { WebglAddon } from '@xterm/addon-webgl/lib/addon-webgl.mjs';
import { Unicode11Addon } from '@xterm/addon-unicode11/lib/addon-unicode11.mjs';
import type { RendererOptions } from '../../src/renderer/types';
import { Pane, diff, ready } from './renderer-pane';

// Headless Chrome with an emulated deviceScaleFactor reports the device-pixel-content-box in CSS pixels, so both
// renderers' DevicePixelObserver would shrink their canvas to half resolution at DPR 2. Without callbacks they keep the
// computed device size.
window.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };

function read(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, copy.width, copy.height).data;
}

/** Leftmost and rightmost columns of device pixels with ink (brighter than the background) in each run of `cells` cells on row 0. */
function inkExtents(data: Uint8ClampedArray, width: number, cellWidth: number, cellHeight: number, cells: number[][]): number[][] {
  return cells.map(([from, to]) => {
    let left = -1, right = -1;
    for (let x = from * cellWidth; x < to * cellWidth; x++) {
      for (let y = 0; y < cellHeight; y++) {
        const i = (y * width + x) * 4;
        if (data[i] + data[i + 1] + data[i + 2] > 3 * 0x60) {
          if (left < 0) left = x;
          right = x;
          break;
        }
      }
    }
    return [left - from * cellWidth, right - from * cellWidth];
  });
}

async function compare(text: string, options: Partial<RendererOptions>, cellRuns: number[][]) {
  const cols = 60, rows = 2;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const xterm = new XtermTerminal({ cols, rows, allowProposedApi: true, ...options });
  xterm.open(host);
  xterm.loadAddon(new Unicode11Addon());
  xterm.unicode.activeVersion = '11';
  xterm.loadAddon(new WebglAddon({ preserveDrawingBuffer: true }));
  await new Promise<void>(resolve => xterm.write(`\x1b[?25l${text}`, resolve));
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const xdims = (xterm as any)._core._renderService.dimensions;
  // The WebGL canvas, not the link layer's
  const xcanvas = host.querySelector<HTMLCanvasElement>('.xterm-screen canvas:not(.xterm-link-layer)')!;

  const pane = new Pane(cols, rows, options);
  pane.write(`\x1b[?25l${text}`).frame();
  const odata = pane.pixels();
  const odims = pane.renderer.dimensions;
  const xdata = read(xcanvas);
  const result = {
    xterm: { cell: xdims.device.cell, char: xdims.device.char, canvas: [xcanvas.width, xcanvas.height] },
    oxtty: { cell: odims.device.cell, char: odims.device.char, canvas: [pane.renderer.canvas.width, pane.renderer.canvas.height] },
    diff: diff(xdata, odata),
    xtermInk: inkExtents(xdata, xcanvas.width, xdims.device.cell.width, xdims.device.cell.height, cellRuns),
    oxttyInk: inkExtents(odata, pane.renderer.canvas.width, odims.device.cell.width, odims.device.cell.height, cellRuns)
  };
  xterm.dispose();
  host.remove();
  pane.dispose();
  return result;
}

Object.assign(window, { compare });
ready.then(() => Object.assign(window, { ready: true }));
