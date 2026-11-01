// Page for selection.test.mjs: an oxtty Terminal next to the real xterm.js 6.1 (WebGL and Unicode 11 addons, so
// both have the same cells and character widths). The test writes the same output to both, dispatches the same CDP
// mouse events at the same cells of each, makes the same API calls and compares the selections.
import { Terminal as XtermTerminal } from '@xterm/xterm/lib/xterm.mjs';
import { WebglAddon } from '@xterm/addon-webgl/lib/addon-webgl.mjs';
import { Unicode11Addon } from '@xterm/addon-unicode11/lib/addon-unicode11.mjs';
import { init, Terminal } from '../../src/index';

type Position = { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;

/** What the page uses of either terminal (xterm.js beyond the renderer-xterm.d.ts declaration). */
interface Selectable {
  readonly element: HTMLElement | undefined;
  readonly buffer: { readonly active: { readonly viewportY: number; readonly baseY: number } };
  options: Record<string, unknown>;
  onSelectionChange(listener: () => void): unknown;
  onData(listener: (data: string) => void): unknown;
  write(data: string, callback: () => void): void;
  resize(cols: number, rows: number): void;
  scrollLines(amount: number): void;
  getSelection(): string;
  hasSelection(): boolean;
  getSelectionPosition(): Position;
  clearSelection(): void;
  select(column: number, row: number, length: number): void;
  selectAll(): void;
  selectLines(start: number, end: number): void;
  focus(): void;
}

const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

async function setup({ cols: COLS, rows: ROWS, scrollback }: { cols: number; rows: number; scrollback: number }) {
  const OPTIONS = { cols: COLS, rows: ROWS, fontFamily: 'Menlo, monospace', fontSize: 14, scrollback };
  await init();
  document.body.style.cssText = 'margin: 0; display: flex; gap: 40px; padding: 60px 10px';
  const [a, b] = [document.createElement('div'), document.createElement('div')];
  document.body.append(a, b);

  const oxtty = new Terminal(OPTIONS) as unknown as Selectable & { open(parent: HTMLElement): void };
  oxtty.open(a);
  const xterm = new XtermTerminal({ ...OPTIONS, allowProposedApi: true }) as unknown as Selectable & {
    open(parent: HTMLElement): void;
    loadAddon(addon: object): void;
    unicode: { activeVersion: string };
  };
  xterm.open(b);
  xterm.loadAddon(new Unicode11Addon());
  xterm.unicode.activeVersion = '11';
  xterm.loadAddon(new WebglAddon());
  const both = [oxtty, xterm];

  const changes = [0, 0];
  both.forEach((t, k) => t.onSelectionChange(() => changes[k]++));
  const data: string[][] = [[], []];
  both.forEach((t, k) => t.onData(d => data[k].push(d)));

  const screens = both.map(t => t.element!.querySelector<HTMLElement>('.xterm-screen')!);

  /** Client coordinates of cell (col, row) of each terminal; `dx` moves within the cell (0 left edge, 1 right edge). */
  const points = (col: number, row: number, dx = 0.5): [number, number][] => screens.map(screen => {
    const rect = screen.getBoundingClientRect();
    return [rect.left + (col + dx) * rect.width / COLS, rect.top + (row + 0.5) * rect.height / ROWS];
  });

  Object.assign(window, {
    /** Writes to both, waits for both to parse and for oxtty's frame (which syncs its mouse modes). */
    write: async (text: string) => {
      await Promise.all(both.map(t => new Promise<void>(resolve => t.write(text, resolve))));
      await frame();
      await frame();
    },
    points,
    /** Each terminal's selection; `changes` counts onSelectionChange since the last call. */
    state: () => {
      const result = both.map((t, k) => ({ text: t.getSelection(), has: t.hasSelection(), position: t.getSelectionPosition() ?? null, changes: changes[k] }));
      changes.fill(0);
      return { oxtty: result[0], xterm: result[1] };
    },
    call: (name: keyof Selectable, args: unknown[]) => both.forEach(t => (t[name] as (...a: unknown[]) => void)(...args)),
    setOption: (key: string, value: unknown) => both.forEach(t => { t.options[key] = value; }),
    focusTerminal: (k: number) => both[k].focus(),
    viewportY: () => both.map(t => t.buffer.active.viewportY),
    takeData: () => data.map(d => d.splice(0)),
    cells: () => screens.map(screen => screen.getBoundingClientRect().width / COLS),
    /**
     * Mouse events built by script at cells of each terminal in turn, like wmux replays them (plainDragSelect.ts):
     * mousedown on the screen, the rest on the document.
     */
    synthetic: (events: [type: string, col: number, row: number, init: MouseEventInit][]) => {
      for (const k of [0, 1]) {
        for (const [type, col, row, init] of events) {
          const [clientX, clientY] = points(col, row)[k];
          const target = type === 'mousedown' ? screens[k] : document;
          target.dispatchEvent(new MouseEvent(type, { ...init, clientX, clientY, bubbles: true, cancelable: true, composed: true }));
        }
      }
    },
  });
}

/** Builds both terminals with these sizes; resolves with an error message, or undefined. */
Object.assign(window, {
  start: (size: { cols: number; rows: number; scrollback: number }) => setup(size).then(() => undefined, err => String(err?.stack ?? err)),
});
