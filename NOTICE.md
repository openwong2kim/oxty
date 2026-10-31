# Third-party notices

## alacritty_terminal 0.26.0

`crates/oxty/src/vt` is the published `alacritty_terminal` 0.26.0 crate
by Christian Duerr, Joe Wilm and the Alacritty contributors, licensed under
the Apache License 2.0 (`crates/oxty/LICENSE-APACHE`), built into the `oxty`
crate as the `oxty::vt` module.

It is modified. The changes, partly carried over from wmux, are listed in
`crates/oxty/src/vt/PATCHES.md`: an xterm Unicode 11 width table, an option for
xterm.js cursor-paragraph resize behaviour, SGR blink, and removal of the
PTY/event-loop modules and their dependencies so the code builds for
`wasm32-unknown-unknown`.

## xterm.js Unicode 11 width table

`crates/oxty/src/vt/wmux_unicode11.rs` is generated from the
xterm.js Unicode 11 provider, Copyright (c) 2017–2019 The xterm.js authors,
MIT license (`crates/oxty/LICENSE-XTERM`).

## wmux

The engine integration started in
[openwong2kim/wmux](https://github.com/openwong2kim/wmux) (MIT).
