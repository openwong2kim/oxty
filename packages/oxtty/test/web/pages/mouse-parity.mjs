// Page for mouse.test.mjs: an oxtty/xterm Terminal next to the real xterm.js 6.1 (WebGL addon, so both have the
// same cell size). The test writes the same output to both, dispatches the same CDP mouse events at the same cells
// of each and compares the bytes and view positions.
import { init, Terminal } from 'oxtty/xterm';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

const COLS = 240;
const ROWS = 100;
const OPTIONS = { cols: COLS, rows: ROWS, fontFamily: 'Menlo, monospace', fontSize: 6, scrollback: 1000 };

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function setup() {
  await init();
  document.body.style.cssText = 'margin: 0; display: flex; gap: 20px; padding: 10px';
  const [a, b] = [document.createElement('div'), document.createElement('div')];
  document.body.append(a, b);

  const oxttyLog = [];
  const oxtty = new Terminal(OPTIONS);
  oxtty.open(a);
  oxtty.onData((data) => oxttyLog.push(['data', data]));
  oxtty.onBinary((data) => oxttyLog.push(['binary', data]));

  const xtermLog = [];
  const xterm = new XtermTerminal({ ...OPTIONS, allowProposedApi: true });
  xterm.open(b);
  xterm.loadAddon(new WebglAddon());
  xterm.onData((data) => xtermLog.push(['data', data]));
  xterm.onBinary((data) => xtermLog.push(['binary', data]));

  const screens = [oxtty.element.querySelector('.xterm-screen'), xterm.element.querySelector('.xterm-screen')];

  /** Client coordinates of the centre of cell (col, row) of each terminal. */
  const points = (col, row) => screens.map((screen) => {
    const rect = screen.getBoundingClientRect();
    return [rect.left + (col + 0.5) * rect.width / COLS, rect.top + (row + 0.5) * rect.height / ROWS];
  });

  // CDP returns before Chrome hands a wheel to the page and may merge queued wheels: the test waits for each one.
  let wheels = 0;
  const waiting = [];
  window.addEventListener('wheel', () => {
    wheels++;
    // After the listeners of this wheel have run
    setTimeout(() => waiting.splice(0).forEach(([count, resolve]) => (count <= wheels ? resolve() : waiting.push([count, resolve]))));
  }, { capture: true, passive: true });

  Object.assign(window, {
    untilWheels: (count) => new Promise((resolve) => (count <= wheels ? setTimeout(resolve) : waiting.push([count, resolve]))),
    /** Writes to both, waits for both to parse and for oxtty's frame (which syncs its mouse modes). */
    write: async (data) => {
      await Promise.all([new Promise((resolve) => oxtty.write(data, resolve)), new Promise((resolve) => xterm.write(data, resolve))]);
      await frame();
      await frame();
    },
    points,
    take: () => ({ oxtty: oxttyLog.splice(0), xterm: xtermLog.splice(0) }),
    viewportY: () => [oxtty.buffer.active.viewportY, xterm.buffer.active.viewportY],
    cells: () => [oxtty.dimensions.css.cell, screens[1].getBoundingClientRect().width / COLS],
    setOption: (key, value) => {
      oxtty.options[key] = value;
      xterm.options[key] = value;
    },
    /** A wheel event built by script (CDP sends pixel deltas only), dispatched at a cell of each. */
    syntheticWheel: (col, row, init) => {
      points(col, row).forEach(([clientX, clientY], k) => screens[k].dispatchEvent(new WheelEvent('wheel', { ...init, clientX, clientY, bubbles: true, cancelable: true })));
    },
    /** Both refuse wheels with Ctrl held. */
    refuseCtrlWheel: () => {
      const handler = (event) => !event.ctrlKey;
      oxtty.attachCustomWheelEventHandler(handler);
      xterm.attachCustomWheelEventHandler(handler);
    },
  });
}

setup().then(() => { window.ready = true; }, (err) => { window.setupError = String(err?.stack ?? err); });
