// Page for terminal-frame.test.mjs: the Terminal facade with a fake renderer that records what it is asked to
// draw. Runs one scenario (open, frames, options, fit, crash, dispose) and leaves the facts in `window.result`.
import * as engine from '../../../src/index.js';
import { FitAddon, init, Terminal } from '../../src/index';
import { setRendererFactory } from '../../src/Terminal';
import type { Viewport } from '../../src/engine-view';
import type { Dimensions, Renderer, RendererOptions, SelectionRange } from '../../src/renderer/types';

class FakeRenderer implements Renderer {
  public readonly canvas = document.createElement('canvas');
  public dimensions!: Dimensions;
  public readonly renders: { changed: number[]; dirty: number[] | 'all'; rows: string[] }[] = [];
  public readonly options: Partial<RendererOptions>[] = [];
  public readonly selections: (SelectionRange | undefined)[] = [];
  public readonly focus: boolean[] = [];
  public disposed = false;
  private _cellWidth: number;
  private _cellHeight: number;
  private readonly _dimensionListeners = new Set<() => void>();
  private readonly _redrawListeners = new Set<(rows: number[] | 'all') => void>();

  constructor(container: HTMLElement, private _cols: number, private _rows: number, options: Partial<RendererOptions>) {
    container.appendChild(this.canvas);
    this.options.push(options);
    [this._cellWidth, this._cellHeight] = cellSize(options.fontSize ?? 15);
    this._measure();
  }

  public setOptions(options: Partial<RendererOptions>): void {
    this.options.push(options);
    if (options.fontSize) [this._cellWidth, this._cellHeight] = cellSize(options.fontSize);
    this._measure();
  }

  public resize(cols: number, rows: number): void {
    [this._cols, this._rows] = [cols, rows];
    this._measure();
  }

  public render(viewport: Viewport, changed: readonly number[], hostDirty?: Iterable<number> | 'all'): void {
    const text = (y: number): string => String.fromCodePoint(...Array.from({ length: viewport.cols }, (_, x) => viewport.row(y)[x * 4] || 32)).trimEnd();
    this.renders.push({
      changed: [...changed],
      dirty: hostDirty === 'all' ? 'all' : [...(hostDirty ?? [])],
      rows: Array.from({ length: viewport.rows }, (_, y) => text(y)),
    });
  }

  public setSelection(selection: SelectionRange | undefined): void {
    this.selections.push(selection);
  }

  public setFocused(focused: boolean): void {
    this.focus.push(focused);
  }

  public onDimensionsChange(listener: () => void): () => void {
    this._dimensionListeners.add(listener);
    return () => this._dimensionListeners.delete(listener);
  }

  public onRedrawRequest(listener: (rows: number[] | 'all') => void): () => void {
    this._redrawListeners.add(listener);
    return () => this._redrawListeners.delete(listener);
  }

  public dispose(): void {
    this.disposed = true;
    this.canvas.remove();
  }

  /** A web font finished loading: the cell got narrower without a call from the host. */
  public fontLoaded(cellWidth: number): void {
    this._cellWidth = cellWidth;
    this._measure();
    for (const listener of this._dimensionListeners) listener();
  }

  public requestRedraw(rows: number[] | 'all'): void {
    for (const listener of this._redrawListeners) listener(rows);
  }

  private _measure(): void {
    const cell = { width: this._cellWidth, height: this._cellHeight };
    const canvas = { width: this._cols * cell.width, height: this._rows * cell.height };
    this.dimensions = { css: { cell, canvas }, device: { cell, canvas } };
    this.canvas.style.width = `${canvas.width}px`;
    this.canvas.style.height = `${canvas.height}px`;
  }
}

const cellSize = (fontSize: number): [number, number] => [Math.round(fontSize * 0.6), Math.round(fontSize * 1.2)];
const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));
const written = (t: Terminal, data: string): Promise<void> => new Promise(resolve => t.write(data, resolve));

async function main(): Promise<Record<string, unknown>> {
  await init();
  let renderer!: FakeRenderer;
  setRendererFactory((container, cols, rows, options) => (renderer = new FakeRenderer(container, cols, rows, options)));
  const parent = document.getElementById('terminal')!;
  parent.style.cssText = 'width: 300px; height: 200px';
  const facts: Record<string, unknown> = {};

  const t = new Terminal({ cols: 20, rows: 4, fontSize: 15, theme: { background: '#101010' } });
  const rendered: { start: number; end: number }[] = [];
  t.onRender(e => rendered.push(e));
  t.open(parent);
  await frame();
  const screen = t.element!.querySelector<HTMLElement>('.xterm-screen')!;
  facts.open = {
    classes: Array.from(t.element!.classList),
    inParent: t.element!.parentElement === parent,
    screen: [screen.contains(renderer.canvas), !!screen.querySelector('.xterm-helpers'), screen.style.width, screen.style.height],
    styleInjected: !!document.getElementById('oxtty-xterm-style'),
    rendererOptions: renderer.options[0],
    firstRender: renderer.renders.map(r => r.dirty),
    rendered: rendered.splice(0),
  };

  // Focus anywhere inside the element (the hidden textarea from step 2) reaches the renderer.
  const input = document.createElement('input');
  screen.querySelector('.xterm-helpers')!.appendChild(input);
  input.focus();
  input.blur();
  input.remove();
  facts.focus = renderer.focus;

  // Two writes parsed in one task are one dirty period: one frame.
  t.write('hello');
  await written(t, '\r\nworld');
  await frame();
  await frame();
  facts.write = { renders: renderer.renders.length, last: renderer.renders.at(-1), rendered: rendered.splice(0) };

  renderer.requestRedraw([2]);
  await frame();
  facts.redraw = renderer.renders.at(-1)!.dirty;

  const dimensionChanges: number[] = [];
  t.onDimensionsChange(d => dimensionChanges.push(d.css.cell.width));
  t.options.fontSize = 20;
  t.options.theme = { background: '#202020' };
  facts.options = { sent: renderer.options.slice(1), dimensionChanges: [...dimensionChanges], screen: [screen.style.width, screen.style.height] };

  const fit = new FitAddon();
  t.loadAddon(fit);
  const proposed = fit.proposeDimensions();
  fit.fit();
  const fitted = [t.cols, t.rows];
  renderer.fontLoaded(10);
  facts.fit = { proposed, fitted, refitted: [t.cols, t.rows], dimensionChanges };

  const crashEngine = (t as unknown as { _engine: { write(data: string | Uint8Array): void } })._engine;
  const feed = crashEngine.write.bind(crashEngine);
  crashEngine.write = data => {
    if (String(data) === 'boom') (engine as unknown as { __trapForTest(): void }).__trapForTest();
    feed(data);
  };
  await written(t, 'boom');
  await written(t, 'ok');
  await frame();
  facts.crash = { last: renderer.renders.at(-1), selections: renderer.selections, line: t.buffer.active.getLine(0)!.translateToString(true) };

  const before = renderer.renders.length;
  t.write('late');
  t.dispose();
  await frame();
  await new Promise(resolve => setTimeout(resolve, 20));
  facts.dispose = { removed: !parent.contains(screen), disposed: renderer.disposed, renders: renderer.renders.length - before };
  return facts;
}

const w = window as unknown as { result?: unknown };
main().then(facts => { w.result = facts; }, err => { w.result = { error: String(err?.stack ?? err) }; });
