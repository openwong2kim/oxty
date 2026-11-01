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

## xterm.js Unicode 11 width table

`crates/oxtty/src/vt/wmux_unicode11.rs` is generated from the
xterm.js Unicode 11 provider, Copyright (c) 2017–2019 The xterm.js authors,
MIT license (`crates/oxtty/LICENSE-XTERM`).

## wmux

The engine integration started in
[openwong2kim/wmux](https://github.com/openwong2kim/wmux) (MIT).
`crates/oxtty/src/snapshot.rs` (ANSI snapshot) is ported from its
`native_serialize.rs` and snapshot host code by the same author, relicensed
Apache-2.0.

## xterm.js

`packages/oxtty/xterm/vendor-xterm` is copied from xterm.js 6.0.0 (commit
f447274f430fd22513f6adbf9862d19524471c04) and its WebGL addon; each file
says whether it is verbatim or changed. `packages/oxtty/xterm` follows the
xterm.js API, and its fit follows `@xterm/addon-fit`. MIT license:

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
