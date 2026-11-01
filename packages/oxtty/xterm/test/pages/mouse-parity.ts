// Page for mouse.test.mjs: an oxtty Terminal with a MouseController attached the way the Terminal will wire it, next
// to the real xterm.js 6.1 (WebGL addon, so both have the same cell size). The test writes the same output to both,
// dispatches the same CDP mouse events at the same cells of each and compares the bytes and view positions.
import { Terminal as XtermTerminal } from '@xterm/xterm/lib/xterm.mjs';
import { WebglAddon } from '@xterm/addon-webgl/lib/addon-webgl.mjs';
import { init, Terminal } from '../../src/index';
import type { Viewport } from '../../src/engine-view';
import { MouseController } from '../../src/mouse/MouseController';

// What the page uses of xterm.js beyond the renderer-xterm.d.ts declaration.
interface Xterm {
  readonly element: HTMLElement;
  readonly buffer: { readonly active: { readonly viewportY: number } };
  options: Record<string, unknown>;
  onData(listener: (data: string) => void): void;
  onBinary(listener: (data: string) => void): void;
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void;
  open(parent: HTMLElement): void;
  loadAddon(addon: object): void;
  write(data: string, callback: () => void): void;
}

type Log = [kind: 'data' | 'binary', bytes: string][];

const COLS = 240;
const ROWS = 100;
const OPTIONS = { cols: COLS, rows: ROWS, fontFamily: 'Menlo, monospace', fontSize: 6, scrollback: 1000 };

const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

async function setup() {
  await init();
  document.body.style.cssText = 'margin: 0; display: flex; gap: 20px; padding: 10px';
  const [a, b] = [document.createElement('div'), document.createElement('div')];
  document.body.append(a, b);

  const oxttyLog: Log = [];
  const oxtty = new Terminal(OPTIONS);
  oxtty.open(a);
  const element = oxtty.element!;
  const mouse = new MouseController({
    element,
    screenElement: element.querySelector<HTMLElement>('.xterm-screen')!,
    viewport: (oxtty as unknown as { _viewport: Viewport })._viewport,
    get dimensions() { return oxtty.dimensions; },
    buffer: oxtty.buffer.active,
    options: (oxtty as unknown as { _options: Record<string, unknown> })._options,
    sendData: data => oxttyLog.push(['data', data]),
    sendBinary: data => oxttyLog.push(['binary', data]),
    scrollLines: amount => oxtty.scrollLines(amount),
    focus: () => {},
  });

  const xtermLog: Log = [];
  const xterm = new XtermTerminal({ ...OPTIONS, allowProposedApi: true }) as unknown as Xterm;
  xterm.open(b);
  xterm.loadAddon(new WebglAddon());
  xterm.onData(data => xtermLog.push(['data', data]));
  xterm.onBinary(data => xtermLog.push(['binary', data]));

  const screens = [element.querySelector<HTMLElement>('.xterm-screen')!, xterm.element.querySelector<HTMLElement>('.xterm-screen')!];

  /** Client coordinates of the centre of cell (col, row) of each terminal. */
  const points = (col: number, row: number): [number, number][] => screens.map(screen => {
    const rect = screen.getBoundingClientRect();
    return [rect.left + (col + 0.5) * rect.width / COLS, rect.top + (row + 0.5) * rect.height / ROWS];
  });

  // CDP returns before Chrome hands a wheel to the page and may merge queued wheels: the test waits for each one.
  let wheels = 0;
  const waiting: [count: number, resolve: () => void][] = [];
  window.addEventListener('wheel', () => {
    wheels++;
    // After the listeners of this wheel have run
    setTimeout(() => waiting.splice(0).forEach(([count, resolve]) => count <= wheels ? resolve() : waiting.push([count, resolve])));
  }, { capture: true, passive: true });

  Object.assign(window, {
    untilWheels: (count: number) => new Promise<void>(resolve => count <= wheels ? setTimeout(resolve) : waiting.push([count, resolve])),
    /** Writes to both, waits for both to parse and for oxtty's frame, then syncs the mouse modes like the Terminal will. */
    write: async (data: string) => {
      await Promise.all([new Promise<void>(resolve => oxtty.write(data, resolve)), new Promise<void>(resolve => xterm.write(data, resolve))]);
      await frame();
      await frame();
      mouse.syncModes();
    },
    points,
    take: () => ({ oxtty: oxttyLog.splice(0), xterm: xtermLog.splice(0) }),
    viewportY: () => [oxtty.buffer.active.viewportY, xterm.buffer.active.viewportY],
    cells: () => [oxtty.dimensions!.css.cell, screens[1].getBoundingClientRect().width / COLS],
    setOption: (key: string, value: unknown) => {
      (oxtty.options as Record<string, unknown>)[key] = value;
      mouse.handleOptionChange(key);
      xterm.options[key] = value;
    },
    /** A wheel event built by script (CDP sends pixel deltas only), dispatched at a cell of each. */
    syntheticWheel: (col: number, row: number, init: WheelEventInit) => {
      points(col, row).forEach(([clientX, clientY], k) => screens[k].dispatchEvent(new WheelEvent('wheel', { ...init, clientX, clientY, bubbles: true, cancelable: true })));
    },
    /** Both refuse wheels with Ctrl held. */
    refuseCtrlWheel: () => {
      const handler = (event: WheelEvent): boolean => !event.ctrlKey;
      mouse.attachCustomWheelEventHandler(handler);
      xterm.attachCustomWheelEventHandler(handler);
    },
  });
}

const w = window as unknown as { ready?: boolean; setupError?: string };
setup().then(() => { w.ready = true; }, err => { w.setupError = String(err?.stack ?? err); });
