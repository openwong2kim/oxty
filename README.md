<div align="center">

# oxtty — a Rust terminal engine for wasm, Node and native apps

**Diffed cell by cell against xterm.js. Scrollback at about 100 bytes a line.**

Feed it PTY bytes. It keeps the screen and tells your renderer which rows changed.

[![ci](https://github.com/openwong2kim/oxtty/actions/workflows/ci.yml/badge.svg)](https://github.com/openwong2kim/oxtty/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE-APACHE)
![rust](https://img.shields.io/badge/rust-1.85%2B-orange)
![wasm](https://img.shields.io/badge/wasm-230%20KB%20%C2%B7%2081%20KB%20gzip-654ff0)
![status](https://img.shields.io/badge/status-0.0.1%20experimental-lightgrey)

[Measurements](#measurements) · [Quick start](#quick-start) · [The model](#the-model) · [xterm.js parity](#xtermjs-parity) · [Roadmap](#roadmap)

</div>

---

oxtty (**ox**ide + **tty**) parses the bytes a program writes to its PTY and
holds everything a terminal knows: characters, colours, cursor, modes and
scrollback. It does not draw anything. Your renderer asks which rows changed
and redraws only those.

The parser and screen model are Alacritty's (`alacritty_terminal` 0.26, built
in and patched to behave like xterm.js). The same engine runs in a native
daemon, in the browser and in an Electron renderer, so the daemon's snapshot
and the screen in your browser cannot disagree about what a byte stream means.

```mermaid
flowchart LR
  pty["PTY output"] --> engine
  subgraph engine["oxtty engine"]
    direction TB
    parser["VT parser"] --> screen["screen + scrollback"]
  end
  engine -- "changed rows" --> r1["WebGL / DOM renderer"]
  engine -- "ANSI snapshot" --> r2["another terminal"]
  engine -- "replies, title, bell" --> host["host app"]
```

## Highlights

- **One engine, three hosts.** Rust crate, WebAssembly npm package with no
  dependencies, and an N-API binding with the same API.
- **Damage, not frames.** `takeDamage()` returns the rows that changed. When
  output scrolls, it says how far to move the drawn picture first, so only the
  new rows are read.
- **Snapshots that resume.** `ansiSnapshot()` returns bytes that rebuild the
  screen, scrollback, cursor, pen and modes in another terminal, including an
  unfinished escape sequence, so live output can continue right after it.
- **Compressed scrollback.** History older than the newest 16 lines is stored
  as UTF-8 text plus runs of equal attributes: a 120-column log line takes
  about 100 bytes instead of 1440 in xterm.js. Rows decode on read.
- **Built for TUIs.** Synchronized output (`CSI ? 2026 h`), used heavily by
  coding agents, is held until the program ends the update.
- **Checked against xterm.js.** Every fixture is fed to oxtty and to
  `@xterm/headless`, and the test fails on any difference that is not listed
  with a reason.

| Where | Package | Notes |
| --- | --- | --- |
| Rust | crate [`oxtty`](crates/oxtty) | the engine |
| Browser, Electron renderer, Node | npm [`oxtty`](packages/oxtty) | WebAssembly, no dependencies |
| Node / Electron main, daemons | [`crates/oxtty-node`](crates/oxtty-node) | N-API binding, same API |

## Measurements

Compared with xterm.js 6.1 betas. Lower is better.

**Buffer memory** — Node, 8 terminals of 120×40 with 10,000 lines of
scrollback, oxtty (wasm) against `@xterm/headless`.

| Output | oxtty | xterm.js |
| --- | ---: | ---: |
| Log lines | 24 MiB | 143 MiB |
| Hangul lines | 32 MiB | 143 MiB |
| A different colour in every cell | 24 MiB | 24 MiB |

**Parser throughput** — MiB/s, higher is better. Node 22 on an Apple M4,
120×40 with 10,000 lines of scrollback, 8 MiB of generated output per row fed
in 64 KiB chunks, median of 5 runs. All three end on the same screen.
`node --expose-gc packages/oxtty/bench/throughput.mjs` reproduces it after
building the wasm and N-API modules.

| Output | oxtty native | oxtty wasm | xterm.js headless |
| --- | ---: | ---: | ---: |
| Log lines, some colour | 116 | 72 | 98 |
| Truecolor fg and bg in every cell | 252 | 142 | 143 |
| Hangul, CJK and emoji | 102 | 73 | 100 |
| Cursor jumps (TUI redraw) | 194 | 128 | 113 |
| Scrolling region (DECSTBM) | 164 | 112 | 41 |
| Short lines into scrollback | 103 | 59 | 60 |

**Compressed history outside the engine** — with
[`TermHistory`](#compressed-history-for-your-own-term), replaying an 8 MB
output ring into 100,000 lines of scrollback peaked at 11 MiB, against 143 MiB
for xterm.js headless (wmux daemon experiment, local).

**The cost.** Compressing history makes wasm parsing slower than xterm.js on
some output: 120 ms against 104 ms for log lines, 89 ms against 67 ms for
Hangul lines.

## Quick start

### JavaScript

```js
import { init, Terminal, Attr, decodeColor } from 'oxtty';

await init();                                   // loads oxtty.wasm once
const term = new Terminal({ cols: 80, rows: 24, scrollback: 5000, onSyncFlush: draw });

pty.onData((data) => {                          // string or Uint8Array
  term.write(data);
  const replies = term.takeReplies();           // e.g. cursor position reports
  if (replies.length) pty.write(replies);
  draw();
});

function draw() {
  const { full, scroll, lines } = term.takeDamage();
  if (scroll) moveDrawnRowsUp(scroll);          // output scrolled; only new rows follow
  for (const y of full ? [...Array(term.rows).keys()] : lines) {
    const cells = term.rowCells(y);             // [codepoint, fg, bg, attrs] per cell
    for (let x = 0; x < term.cols; x++) {
      const [cp, fg, bg, attrs] = cells.subarray(x * 4, x * 4 + 4);
      if (attrs & Attr.WIDE_SPACER) continue;   // right half of a wide char
      paint(x, y, String.fromCodePoint(cp), decodeColor(fg), decodeColor(bg), attrs);
    }
  }
}
```

### Rust

```rust
let mut term = oxtty::Engine::new(80, 24, 5000);
term.feed("안녕 \x1b[1;31mworld\x1b[0m\r\n".as_bytes());
assert_eq!(term.row_text(0).as_deref(), Some("안녕 world"));

match term.take_damage() {
    oxtty::Damage::Full => { /* redraw all rows */ }
    oxtty::Damage::Lines { scroll, lines } => { /* move up `scroll` rows, redraw `lines` */ }
}
```

### Compressed history for your own `Term`

If you drive the built-in Alacritty `Term` yourself instead of `oxtty::Engine`,
`TermHistory` gives it the same compressed scrollback:

```rust
use oxtty::TermHistory;
use oxtty::vt::event::VoidListener;
use oxtty::vt::term::{test::TermSize, Config, Term};
use oxtty::vt::vte::ansi::{Processor, StdSyncHandler};

let config = Config { scrolling_history: TermHistory::RECENT, ..Config::default() };
let mut term = Term::new(config, &TermSize::new(120, 40), VoidListener);
let history = TermHistory::attach(&mut term, 100_000); // 100,000 lines in all

Processor::<StdSyncHandler>::new().advance(&mut term, &output);
let oldest = history.row(0);                        // rows 0..history.len(), oldest first
history.resize(&mut term, TermSize::new(100, 30)); // reflows the compressed rows too
```

The grid keeps the newest `TermHistory::RECENT` (16) history rows; older ones
live in `history`, above the grid's own history.

### Installing

oxtty is not on crates.io or npm yet. Until then, depend on it from git:

```toml
oxtty = { git = "https://github.com/openwong2kim/oxtty", rev = "<commit>" }
```

## The model

<details open>
<summary><b>Rows and scrollback</b></summary>

Visible rows are `0..rows`. Scrollback is addressed with negative numbers: `-1`
is the newest history line, `-historyLength` the oldest. A renderer can keep
only what is on screen and fetch history on demand. `scrollDisplay(delta)` /
`scrollToBottom()` move the view; viewport row `y` then shows line
`y - displayOffset`. History rows are kept compressed and decoded when read, so
read only the rows you draw.

</details>

<details open>
<summary><b>Cells</b></summary>

Four `u32` words: Unicode scalar, foreground, background, attributes. Colours
carry their kind in the top byte (named, 256-palette, RGB) so themes stay in
the renderer. Wide characters occupy a `WIDE` cell and a `WIDE_SPACER` cell.
Cells flagged `COMBINING`, `UNDERLINE_COLOR` (SGR 58) or `HYPERLINK` (OSC 8)
have the rest in `rowExtras(y)`, one call per row.

</details>

<details open>
<summary><b>Cursor and damage</b></summary>

`cursor()` gives position, visibility and the DECSCUSR shape (`block`,
`underline`, `bar`) with blinking.

`takeDamage()` returns the viewport rows changed since the last call. When
output scrolled the whole screen, `scroll` says how many rows to move the drawn
picture up first. It is `full` after a resize, a view scroll, a scroll region
change or a screen switch.

</details>

<details>
<summary><b>Things for the host to act on</b></summary>

`takeReplies()` (bytes to send back to the program; `takeReplyList()` gives
them one reply at a time, as xterm.js fires `onData`), `takeTitle()`,
`takeBells()`, `modes()` (cursor visibility, bracketed paste, mouse reporting,
alternate screen, …).

Clipboard and colour queries are the host's call and off until it opts in.
`setClipboardAccess({ read, write })` lets OSC 52 through:
`takeClipboardWrite()` hands over text to copy, `takeClipboardRead()` a
clipboard to read, answered with `replyClipboard(selection, text)`.
`setColors(colors)` (`COLOR_SLOTS` = 259 values: palette, foreground,
background, cursor) answers OSC 4/10/11/12 queries. Replies are byte for byte
what xterm.js and its clipboard addon send.

</details>

<details>
<summary><b>Synchronized output</b></summary>

`CSI ? 2026 h` is honoured: output is held until the program ends the update.
The engine has no clock — vte's default timer calls `Instant::now()`, which
traps on `wasm32-unknown-unknown` — so the host flushes stalled updates. The
npm wrapper does this for you after 150 ms and calls `onSyncFlush`; Rust and
N-API hosts call `flush_sync()` themselves.

</details>

<details>
<summary><b>Snapshots</b></summary>

`ansiSnapshot()` returns `{ ok: true, payload }`: bytes that rebuild the
screen, scrollback, cursor, pen and modes in another terminal, including any
unfinished escape or UTF-8 tail. It returns `{ ok: false, reason }`
(`unsupported-wide-edge`, `margins`, `partial-tail-overflow`) when ANSI cannot
express the state; replay the raw bytes instead.

During a synchronized update the payload is the screen from before it,
followed by `CSI ? 2026 h` and the held output raw, so the receiver is inside
the same update. Taking a snapshot never changes the engine, so it is safe on
the terminal a renderer is drawing.

Not carried over yet: charset designation and shift, the DECSC saved cursor,
custom tab stops, cursor shape and OSC 8 links.

</details>

## xterm.js parity

```sh
cd packages/oxtty && npm ci && npm test
```

This feeds [wmux](https://github.com/openwong2kim/wmux)'s 91 fixtures to oxtty
and to `@xterm/headless`, compares the screens cell by cell, and also restores
each oxtty snapshot into xterm.js and compares again. It fails on any
difference not listed, with a reason, in
[`known-differences.json`](packages/oxtty/test/xterm/known-differences.json).
`OXTTY_SWAP_GATE=1` also fails while an entry is marked `blocksSwap`; none
is today.

## Building

```sh
cargo test -p oxtty                     # engine tests
bash scripts/build-wasm.sh             # → packages/oxtty/dist/oxtty.wasm
(cd packages/oxtty && npm test)         # wasm package tests
bash scripts/build-node.sh             # → crates/oxtty-node/oxtty.node
node --test crates/oxtty-node/test.cjs  # N-API tests
```

Requires Rust ≥ 1.85 and Node ≥ 18. Format with
`cargo fmt -p oxtty -p oxtty-wasm -p oxtty-node`. The built-in Alacritty fork
(`crates/oxtty/src/vt`) is `#[rustfmt::skip]` so it stays close to upstream.

## Roadmap

- [x] **Engine core** — rows, cells, cursor, damage with scroll, replies,
      synchronized output, ANSI snapshots, wasm and N-API bindings.
- [x] **Differential tests against xterm.js** — 91 fixtures, two proofs.
- [ ] **Publish to crates.io and npm.** The patched Alacritty fork is built
      into the `oxtty` crate as `oxtty::vt`, so `oxtty` publishes as a single crate.
- [ ] **xterm.js-compatible facade** — `new Terminal(options)`, `open(element)`,
      `onData`, `write`, `buffer` over the oxtty engine, keeping xterm.js's
      WebGL/DOM renderers and addons.
- [ ] **Input in Rust** — keyboard (including the kitty protocol), mouse and
      paste encoding shared by every host.
- [ ] **Selection, search and link detection in Rust.**
- [x] **Host policy hooks** — OSC 52 clipboard and OSC 4/10/11/12 colour
      queries, off until the host opts in.
- [ ] **Prebuilt N-API binaries** for Windows, macOS and Linux.
- [ ] **Fuzzing.**

## Credits

The parser and screen model are
[`alacritty_terminal`](https://github.com/alacritty/alacritty) 0.26, built in
as `oxtty::vt` with small compatibility patches (xterm Unicode 11 widths, resize
behaviour, blink, and no PTY/event loop so it builds for wasm32) described in
[`crates/oxtty/src/vt/PATCHES.md`](crates/oxtty/src/vt/PATCHES.md).
oxtty grew out of the terminal engine in [wmux](https://github.com/openwong2kim/wmux).
See [NOTICE.md](NOTICE.md).

## License

Licensed under the [Apache License 2.0](LICENSE-APACHE). Third-party code it
includes keeps its own license; see [NOTICE.md](NOTICE.md).
