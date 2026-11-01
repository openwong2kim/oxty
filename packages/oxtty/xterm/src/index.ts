// oxtty/xterm: an xterm.js-compatible terminal for the browser, drawn by the borrowed xterm.js WebGL renderer
// from the oxtty engine. `await init()` once before creating terminals; the rest follows xterm.js.
export { init } from '../../src/index.js';
export type { AnsiSnapshot } from '../../src/index.js';
export { Terminal } from './Terminal';
export type { ClipboardHandler, FontWeight, Modes, TerminalAddon, TerminalOptions } from './Terminal';
export { FitAddon } from './FitAddon';
