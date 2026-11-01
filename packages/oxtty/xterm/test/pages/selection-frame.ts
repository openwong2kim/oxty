// Page for selection-frame.test.mjs: the Terminal with a fake renderer that records the selections it is handed and
// asks to redraw the rows a selection leaves and enters, like the WebGL renderer. Leaves the facts in `window.result`.
import { init, Terminal } from '../../src/index';
import { setRendererFactory } from '../../src/Terminal';
import type { Viewport } from '../../src/engine-view';
import type { Dimensions, Renderer, SelectionRange } from '../../src/renderer/types';

const CELL = { width: 10, height: 20 };

class FakeRenderer implements Renderer {
  public readonly canvas = document.createElement('canvas');
  public dimensions!: Dimensions;
  public readonly renders: { changed: number[]; dirty: number[] | 'all' }[] = [];
  public readonly selections: (SelectionRange | undefined)[] = [];
  private _selected: number[] = [];
  private readonly _redrawListeners = new Set<(rows: number[] | 'all') => void>();

  constructor(container: HTMLElement, private _cols: number, private _rows: number) {
    container.appendChild(this.canvas);
    this._measure();
  }

  public setOptions(): void {}

  public resize(cols: number, rows: number): void {
    [this._cols, this._rows] = [cols, rows];
    this._measure();
  }

  public render(_viewport: Viewport, changed: readonly number[], hostDirty?: Iterable<number> | 'all'): void {
    this.renders.push({ changed: [...changed], dirty: hostDirty === 'all' ? 'all' : [...(hostDirty ?? [])] });
  }

  /** Like WebglRenderer.setSelection: the rows the selection covered and covers now are redrawn. */
  public setSelection(selection: SelectionRange | undefined): void {
    this.selections.push(selection);
    const rows = selection ? Array.from({ length: selection.end[1] - selection.start[1] + 1 }, (_, i) => selection.start[1] + i).filter(y => y >= 0 && y < this._rows) : [];
    const redraw = [...new Set([...this._selected, ...rows])].sort((a, b) => a - b);
    this._selected = rows;
    if (redraw.length) for (const listener of this._redrawListeners) listener(redraw);
  }

  public setFocused(): void {}

  public onDimensionsChange(): () => void {
    return () => {};
  }

  public onRedrawRequest(listener: (rows: number[] | 'all') => void): () => void {
    this._redrawListeners.add(listener);
    return () => this._redrawListeners.delete(listener);
  }

  public dispose(): void {
    this.canvas.remove();
  }

  private _measure(): void {
    const canvas = { width: this._cols * CELL.width, height: this._rows * CELL.height };
    this.dimensions = { css: { cell: CELL, canvas }, device: { cell: CELL, canvas } };
    this.canvas.style.width = `${canvas.width}px`;
    this.canvas.style.height = `${canvas.height}px`;
  }
}

const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await frame();
};

async function main(): Promise<Record<string, unknown>> {
  await init();
  let renderer!: FakeRenderer;
  setRendererFactory((container, cols, rows) => (renderer = new FakeRenderer(container, cols, rows)));
  const parent = document.getElementById('terminal')!;
  const t = new Terminal({ cols: 20, rows: 6, scrollback: 50 });
  t.open(parent);
  await new Promise<void>(resolve => t.write(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'), resolve));
  await frames(3);
  const facts: Record<string, unknown> = {};
  const baseY = t.buffer.active.baseY;

  // A selection on screen rows 1-2: handed over once, its rows redrawn in the frame that hands it over
  let renders = renderer.renders.length;
  t.select(3, baseY + 1, 25);
  await frames(4);
  facts.select = { selections: renderer.selections.slice(), renders: renderer.renders.slice(renders) };

  // A frame for something else does not hand the same selection over again
  renders = renderer.renders.length;
  t.refresh(5, 5);
  await frames(3);
  facts.idle = { selections: renderer.selections.length, renders: renderer.renders.slice(renders) };

  // Scrolling the view back 2 rows moves it down 2 viewport rows
  t.scrollLines(-2);
  await frames(3);
  facts.scrolled = renderer.selections.at(-1);
  // Scrolled out of view: still handed over, the renderer clips it
  t.scrollLines(-10);
  await frames(3);
  facts.offscreen = renderer.selections.at(-1);
  t.scrollToBottom();
  await frames(3);

  // An Alt drag (column select) from cell (2, 0) to (6, 3), made of script events
  const screen = t.element!.querySelector<HTMLElement>('.xterm-screen')!;
  const rect = screen.getBoundingClientRect();
  const at = (col: number, row: number) => ({ clientX: rect.left + (col + 0.5) * CELL.width, clientY: rect.top + (row + 0.5) * CELL.height });
  screen.dispatchEvent(new MouseEvent('mousedown', { ...at(2, 0), button: 0, buttons: 1, detail: 1, altKey: true, bubbles: true, cancelable: true }));
  document.dispatchEvent(new MouseEvent('mousemove', { ...at(6, 3), button: 0, buttons: 1, altKey: true, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { ...at(6, 3), button: 0, buttons: 0, altKey: true, bubbles: true }));
  await frames(4);
  facts.column = { selection: renderer.selections.at(-1), text: t.getSelection() };

  // Clearing hands over nothing and redraws the rows it covered
  renders = renderer.renders.length;
  t.clearSelection();
  await frames(4);
  facts.cleared = { selection: renderer.selections.at(-1), count: renderer.selections.length, renders: renderer.renders.slice(renders) };
  t.dispose();
  return facts;
}

const w = window as unknown as { result?: unknown };
main().then(facts => { w.result = facts; }, err => { w.result = { error: String(err?.stack ?? err) }; });
