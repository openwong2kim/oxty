# Third-party notices

## alacritty_terminal 0.26.0

`crates/oxtty/src/vt` is the published `alacritty_terminal` 0.26.0 crate
by Christian Duerr, Joe Wilm and the Alacritty contributors, licensed under
the Apache License 2.0 (`crates/oxtty/LICENSE-APACHE`), built into the `oxtty`
crate as the `oxtty::vt` module.

It is modified. The changes, partly carried over from wmux, are listed in
`crates/oxtty/src/vt/PATCHES.md`: an xterm Unicode 11 width table, an option for
xterm.js cursor-paragraph resize behaviour, SGR blink, and removal of the
PTY/event-loop modules and their dependencies so the code builds for
`wasm32-unknown-unknown`.

## vte 0.15.0

`crates/oxtty/src/vt/vte/ansi.rs` is the `ansi` module of the published `vte`
0.15.0 crate by Joe Wilm, Christian Duerr and the Alacritty contributors,
licensed under the Apache License 2.0 or the MIT license (used under the Apache
License 2.0, `crates/oxtty/LICENSE-APACHE`). It is modified so parsing can stop
at sequences the host hooked; the changes are listed in
`crates/oxtty/src/vt/PATCHES.md`.

## xterm.js Unicode 11 width table

`crates/oxtty/src/vt/wmux_unicode11.rs` is generated from the
xterm.js Unicode 11 provider, Copyright (c) 2017–2019 The xterm.js authors,
MIT license (`crates/oxtty/LICENSE-XTERM`).

## xterm.js input encoding

`crates/oxtty/src/input` (`keyboard.rs`, `kitty.rs`, `mouse.rs` and the paste
and focus encoders in `mod.rs`) is a Rust port of xterm.js 6.1.0-beta.336
(commit 08829c7eb6279dda2a9e86df901353a1a89858ca): `src/common/input/Keyboard.ts`,
`src/common/input/KittyKeyboard.ts`, `src/common/services/MouseStateService.ts`
and parts of `src/browser/services/MouseService.ts`, `src/browser/Clipboard.ts`
and `src/browser/CoreBrowserTerminal.ts`, Copyright (c) 2012-2013 Christopher
Jeffrey and (c) 2014-2025 The xterm.js authors, MIT license
(`crates/oxtty/LICENSE-XTERM`). Each file names its source lines. The parity
fixtures in `crates/oxtty/tests/fixtures/input-*.json` are recorded from
xterm.js by `packages/oxtty/test/web/gen-input-fixtures.mjs`.

`crates/oxtty-web/src/input` (the browser front end's textarea, IME and mouse
handling around those encoders) is a Rust port of parts of the same xterm.js
6.1.0-beta.336: `src/browser/CoreBrowserTerminal.ts`,
`src/browser/input/CompositionHelper.ts`, `src/browser/input/MoveToCell.ts`,
`src/browser/input/Mouse.ts`, `src/browser/Clipboard.ts`,
`src/browser/services/KeyboardService.ts`, `src/browser/services/MouseService.ts`,
`src/browser/services/MouseCoordsService.ts` and
`src/browser/services/SelectionService.ts`, Copyright (c) 2014-2026 The
xterm.js authors, MIT license (`crates/oxtty/LICENSE-XTERM`). Each file names
its source lines.

## wmux

The engine integration started in
[openwong2kim/wmux](https://github.com/openwong2kim/wmux) (MIT).
`crates/oxtty/src/snapshot.rs` (ANSI snapshot) is ported from its
`native_serialize.rs` and snapshot host code by the same author, relicensed
Apache-2.0.
