// Page for search.test.mjs: an oxtty/xterm Terminal with its built-in SearchAddon next to the real xterm.js 6.1 with
// @xterm/addon-search (and the Unicode 11 addon, so both have the same character widths). The test writes the same
// output to both, runs the same findNext/findPrevious calls and compares what each returns, selects and scrolls to.
import { init, Terminal, SearchAddon } from 'oxtty/xterm';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SearchAddon as XtermSearchAddon } from '/node_modules/@xterm/addon-search/lib/addon-search.mjs';

let both = [];
let addons = [];
let results = [[], []];

Object.assign(window, {
  start: async ({ cols, rows, scrollback }) => {
    await init();
    for (const t of both) t.dispose();
    document.body.replaceChildren();
    const options = { cols, rows, scrollback, fontFamily: 'monospace', fontSize: 14 };
    const [a, b] = [document.createElement('div'), document.createElement('div')];
    document.body.append(a, b);
    const oxtty = new Terminal(options);
    oxtty.open(a);
    const xterm = new XtermTerminal({ ...options, allowProposedApi: true });
    xterm.open(b);
    xterm.loadAddon(new Unicode11Addon());
    xterm.unicode.activeVersion = '11';
    both = [oxtty, xterm];
    addons = [new SearchAddon(), new XtermSearchAddon()];
    // `loadAddon` takes the built-in addon once the renderer branch's loadAddon is merged; `activate` is what it calls.
    addons[0].activate(oxtty);
    xterm.loadAddon(addons[1]);
    results = [[], []];
    addons.forEach((addon, k) => addon.onDidChangeResults((e) => results[k].push(e)));
  },
  write: (text) => Promise.all(both.map((t) => new Promise((resolve) => t.write(text, resolve)))),
  /**
   * Runs each step on both terminals: `[method, ...args]` of the addon, or `['scrollLines', n]` of the terminal.
   * Returns per terminal, per step: the value, the selection and the viewport top.
   */
  run: (steps) => both.map((t, k) => steps.map(([method, ...args]) => {
    let value;
    try {
      value = method === 'scrollLines' ? t.scrollLines(...args) : addons[k][method](...args);
    } catch (e) {
      value = `throws ${e.name}`;
    }
    const position = k === 0 ? addons[0].__selectionPosition : t.getSelectionPosition();
    return { method, args: JSON.stringify(args), value: value ?? null, position: position ?? null, viewportY: t.buffer.active.viewportY };
  })),
  /** `onDidChangeResults` events since the last call. */
  results: () => {
    const seen = results;
    results = [[], []];
    return seen;
  },
});
