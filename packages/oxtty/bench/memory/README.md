# Memory bench: many terminals on one page

Compares the memory of `oxtty/xterm` with xterm.js (`@xterm/xterm` and
`@xterm/addon-webgl`) when many terminals are open at once, the case oxtty is
built for: 17 panes of 120×40, each with 10,000 lines of scrollback filled by
coloured log output.

```sh
bash scripts/build-wasm.sh && bash scripts/build-web.sh   # repository root
cd packages/oxtty && npm ci
npm run bench:memory                # 17 panes, 10,000 lines each
npm run bench:memory -- 8 2000      # [panes] [lines]
```

- It runs **system Chrome** through Playwright (`channel: 'chrome'`), headless
  but on the **real GPU** (`--use-angle=metal`, GPU blocklist ignored), so the
  numbers include the WebGL renderers. The `gpu=` field shows which GPU the
  page got; if it names SwiftShader, the GPU numbers are not meaningful. The
  flags are for macOS; elsewhere, change `--use-angle`.
- Each engine gets a fresh browser. The JS heap is read after a GC; the
  renderer and GPU figures are the resident memory those processes gained over
  the empty page (`ps` RSS per process from CDP `SystemInfo.getProcessInfo`).
- All panes are in view (a 4500×4500 viewport), so both engines draw all of
  them.
- It is not part of `npm test` or `npm run test:web`.

Results on an Apple M4 (macOS, 2026-11-02):

```
17 panes of 120×40, 10000 lines each
oxtty  canvases=18 | JS heap 3 MB  | renderer +123 MB | GPU process +21 MB
xterm  canvases=35 | JS heap 41 MB | renderer +413 MB | GPU process +48 MB
```

RSS moves by a few MB between runs, the GPU process the most.
