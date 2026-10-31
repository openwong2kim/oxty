# Third-party notices

## alacritty_terminal 0.26.0

`vendor/alacritty_terminal` is the published `alacritty_terminal` 0.26.0 crate
by Christian Duerr, Joe Wilm and the Alacritty contributors, licensed under
the Apache License 2.0 (`vendor/alacritty_terminal/LICENSE-APACHE`).

It is modified. The changes, carried over from wmux, are listed in
`vendor/alacritty_terminal/WMUX-PATCH.md`: an xterm Unicode 11 width table,
cursor-paragraph resize behaviour, SGR blink, and gating of the PTY/event-loop
modules and their dependencies so the crate builds for `wasm32-unknown-unknown`.

## xterm.js Unicode 11 width table

`vendor/alacritty_terminal/src/wmux_unicode11.rs` is generated from the
xterm.js Unicode 11 provider, Copyright (c) 2017–2019 The xterm.js authors,
MIT license (`vendor/alacritty_terminal/LICENSE-XTERM`).

## wmux

The engine integration started in
[openwong2kim/wmux](https://github.com/openwong2kim/wmux) (MIT).
