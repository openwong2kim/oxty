// One engine + Viewport + WebglRenderer on the page, driven the way the Terminal facade drives them, for the renderer tests.
import { init, Terminal } from '../../../src/index.js';
import { LocalEngineView, Viewport } from '../../src/engine-view';
import { WebglRenderer } from '../../src/renderer/WebglRenderer';
import type { RendererOptions } from '../../src/renderer/types';

export const ready = init(new URL('./oxtty.wasm', location.href));

export class Pane {
  public readonly engine: Terminal;
  public readonly view: LocalEngineView;
  public readonly viewport = new Viewport();
  public readonly renderer: WebglRenderer;
  public readonly container = document.createElement('div');
  /** Everything the renderer asked to redraw, in order. */
  public readonly redrawRequests: (number[] | 'all')[] = [];

  constructor(cols: number, rows: number, options: Partial<RendererOptions> = {}, scrollback = 1000) {
    document.body.appendChild(this.container);
    this.engine = new Terminal({ cols, rows, scrollback });
    this.view = new LocalEngineView(this.engine);
    this.renderer = new WebglRenderer(this.container, cols, rows, { fontFamily: 'Menlo, monospace', fontSize: 14, ...options });
    this.renderer.onRedrawRequest(rows => this.redrawRequests.push(rows));
  }

  public write(data: string | Uint8Array): this {
    this.engine.write(data);
    return this;
  }

  public resize(cols: number, rows: number): this {
    this.engine.resize(cols, rows);
    this.renderer.resize(cols, rows);
    return this;
  }

  /** Takes a frame from the engine and renders it. */
  public frame(hostDirty?: Iterable<number> | 'all'): this {
    const changed = this.viewport.apply(this.view.takeFrame());
    this.renderer.render(this.viewport, changed, hostDirty);
    return this;
  }

  /** Renders (nothing new from the engine) and reads the canvas in the same task, before the drawing buffer is cleared. */
  public pixels(): Uint8ClampedArray {
    this.frame();
    const c = this.renderer.canvas;
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  }

  /** `[r, g, b]` at the device pixel in the middle of cell (col, row), after rendering. */
  public cellColor(col: number, row: number, dx = 0.5, dy = 0.5): number[] {
    const d = this.renderer.dimensions.device;
    const x = Math.floor((col + dx) * d.cell.width);
    const y = Math.floor((row + dy) * d.cell.height);
    const data = this.pixels();
    const i = (y * this.renderer.canvas.width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  }

  public dispose(): void {
    this.renderer.dispose();
    this.engine.dispose();
    this.container.remove();
  }
}

/** Number of differing bytes. */
export function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
