# Third-party notices for the `oxtty` npm package

`dist/oxtty.wasm` is compiled from oxtty and the third-party code below, and
`dist/xterm.js` bundles code borrowed from xterm.js (last section). oxtty's own
code is licensed under Apache-2.0 (`LICENSE-APACHE`).

---

## alacritty_terminal 0.26.0

Copyright Christian Duerr, Joe Wilm and the Alacritty contributors.
Source: https://github.com/alacritty/alacritty

Licensed under the Apache License, Version 2.0. A copy of the license is
included in this package as `LICENSE-APACHE`.

**Modified.** oxtty compiles a patched copy (`crates/oxtty/src/vt` in
https://github.com/openwong2kim/oxtty). The changes are:

- character widths use the xterm.js Unicode 11 table (below);
- resizing can leave the cursor paragraph without reflow (xterm.js
  `reflowCursorLine: false`), which oxtty enables;
- SGR 5 blink is stored in a cell flag;
- the PTY and event-loop modules and their dependencies are removed.

The full list is in `crates/oxtty/src/vt/PATCHES.md` in the repository.

---

## vte 0.15.0

Copyright the Alacritty contributors. Source: https://github.com/alacritty/vte
Licensed under Apache-2.0 OR MIT; used here under the Apache License 2.0
(`LICENSE-APACHE`).

---

## dlmalloc 0.2.14

Copyright Alex Crichton; a port of Doug Lea's public-domain dlmalloc.
Source: https://github.com/alexcrichton/dlmalloc-rs
Licensed under Apache-2.0 OR MIT; used here under the Apache License 2.0
(`LICENSE-APACHE`).

---

## xterm.js Unicode 11 width table

The character width table compiled into `oxtty.wasm` is generated from the
xterm.js Unicode 11 addon. Source: https://github.com/xtermjs/xterm.js

```
Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

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

---

## xterm.js 6.0.0

`dist/xterm.js` (`oxtty/xterm`) contains code copied from xterm.js 6.0.0
(commit f447274f430fd22513f6adbf9862d19524471c04) and its WebGL addon: the
renderer parts under `packages/oxtty/xterm/vendor-xterm` in the repository,
each file marked verbatim or with its changes. Its API follows the xterm.js
API, and its fit follows `@xterm/addon-fit`. Source:
https://github.com/xtermjs/xterm.js

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
