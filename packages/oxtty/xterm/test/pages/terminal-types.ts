// Compiled by `npm run typecheck:xterm`, never run: the implementation satisfies the public xterm.d.ts.
import type * as Public from '../../xterm';
import { FitAddon, Terminal } from '../../src/index';

declare const terminal: Terminal;
declare const fit: FitAddon;
declare const options: Public.ITerminalOptions & Public.ITerminalInitOnlyOptions;
declare const addon: Public.ITerminalAddon;

export const publicTerminal: Public.Terminal = terminal;
export const publicFit: Public.FitAddon = fit;
export const constructed = new Terminal(options);
export const loaded = (): void => terminal.loadAddon(addon);
