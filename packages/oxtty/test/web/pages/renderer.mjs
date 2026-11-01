// Page for the renderer tests: the kit as `window.T` for page.evaluate.
import { init, Terminal, FitAddon } from 'oxtty/xterm';
import { Pane, diff, read, sleep } from './kit.mjs';

await init();
window.T = { Pane, Terminal, FitAddon, diff, read, sleep };
window.ready = true;
