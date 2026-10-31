# oxty

Terminal emulator engine in Rust, compiled to WebAssembly (~175 KB, no
dependencies). Feed it PTY output; it keeps the screen and tells your renderer
which rows changed.

```js
import { init, Terminal, Attr, decodeColor } from 'oxty';

await init();
const term = new Terminal({ cols: 80, rows: 24, scrollback: 5000 });
term.write('안녕 \x1b[1;31mworld\x1b[0m\r\n');

term.rowText(0);       // '안녕 world'
term.rowCells(0);      // Uint32Array: [codepoint, fg, bg, attrs] per cell
term.takeDamage();     // { full: true, lines: [] } → then only changed rows
term.takeReplies();    // bytes to write back to the PTY
```

- Visible rows are `0..rows`; scrollback is `-1` (newest) to `-historyLength`.
- Works in browsers, bundlers (Vite, webpack) and Node ≥ 18.
- Synchronized output (`CSI ? 2026 h`) is held until the program ends it, or
  flushed after `syncTimeoutMs` (default 150) with an `onSyncFlush` callback.

**Status: 0.0.1, experimental.** An xterm.js-compatible front end is the next
milestone. Docs, Rust crate and roadmap: https://github.com/openwong2kim/oxty

License: MIT OR Apache-2.0. Includes `alacritty_terminal` (Apache-2.0) and the
xterm.js Unicode 11 width table (MIT).
