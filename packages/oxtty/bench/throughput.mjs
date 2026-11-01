// Throughput and memory baseline: feeds the same output to oxtty (wasm), oxtty (native N-API) and @xterm/headless and compares.
//
//   bash scripts/build-wasm.sh && bash scripts/build-node.sh   (repository root)
//   node --expose-gc packages/oxtty/bench/throughput.mjs [out.json]
//
// Output is generated deterministically from vtebench-style scenarios (fixed seed, 8 MiB each).
// Terminal 120×40, 10,000 lines of scrollback, written 64 KiB at a time. Throughput is the median of 5 runs (MiB/s),
// memory is the RSS growth after GC in a fresh process per scenario and engine.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const NATIVE = join(here, '../../../crates/oxtty-node/oxtty.node');
const COLS = 120;
const ROWS = 40;
const SCROLLBACK = 10000;
const SIZE = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;
const RUNS = 5;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const ESC = '\x1b';
const CASES = {
  // Lines like a build log: mostly plain text, occasionally colored.
  'light-cells': (r) => `${r() < 0.2 ? `${ESC}[3${1 + Math.floor(r() * 6)}m` : ''}[${(r() * 1e6).toFixed(0)}] compiling module_${Math.floor(r() * 9999)}.rs ok${ESC}[0m\r\n`,
  // A different truecolor foreground and background per cell.
  'dense-cells': (r) => {
    let line = '';
    for (let i = 0; i < COLS; i++) {
      const c = () => Math.floor(r() * 256);
      line += `${ESC}[38;2;${c()};${c()};${c()};48;2;${c()};${c()};${c()}m${String.fromCharCode(33 + Math.floor(r() * 90))}`;
    }
    return `${line}${ESC}[0m\r\n`;
  },
  // Lines of Hangul, Han characters and emoji.
  unicode: (r) => {
    const pool = ['가', '나', '한', '글', '漢', '字', '😀', '🚀', 'é', 'a', ' '];
    let line = '';
    for (let i = 0; i < 50; i++) line += pool[Math.floor(r() * pool.length)];
    return `${line}\r\n`;
  },
  // TUI redraw: move to random positions and write short text (no scrolling).
  'cursor-motion': (r) => `${ESC}[${1 + Math.floor(r() * ROWS)};${1 + Math.floor(r() * (COLS - 10))}H${ESC}[3${Math.floor(r() * 8)}m${'#'.repeat(1 + Math.floor(r() * 8))}`,
  // Scroll only the lower region (DECSTBM).
  'scrolling-region': (r) => `${ESC}[20;40r${ESC}[40;1Hline ${Math.floor(r() * 1e6)}\n`,
  // Keep streaming short plain lines to fill the scrollback.
  'scroll-flood': (r) => `${Math.floor(r() * 1e9)}\r\n`,
};

function corpus(name) {
  const r = rng(0x5eed);
  const make = CASES[name];
  const parts = [];
  let size = 0;
  while (size < SIZE) {
    const s = make(r);
    parts.push(s);
    size += Buffer.byteLength(s);
  }
  const bytes = Buffer.from(parts.join(''));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK) chunks.push(bytes.subarray(i, i + CHUNK));
  return { bytes: bytes.length, chunks };
}

async function engine(name) {
  if (name === 'oxtty-wasm') {
    const { init, Terminal } = await import('../dist/index.js');
    await init();
    return {
      make: () => new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK }),
      feed: async (t, chunks) => { for (const c of chunks) t.write(c); },
      last: (t) => t.rowText(ROWS - 1),
      dispose: (t) => t.dispose(),
    };
  }
  if (name === 'oxtty-native') {
    const { Terminal } = require(NATIVE);
    return {
      make: () => new Terminal(COLS, ROWS, SCROLLBACK),
      feed: async (t, chunks) => { for (const c of chunks) t.write(c); },
      last: (t) => t.rowText(ROWS - 1),
      dispose: () => {},
    };
  }
  const { Terminal } = require('@xterm/headless');
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  return {
    make: () => {
      const t = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
      t.loadAddon(new Unicode11Addon());
      t.unicode.activeVersion = '11';
      return t;
    },
    feed: (t, chunks) => new Promise((done) => {
      for (let i = 0; i < chunks.length; i++) t.write(chunks[i], i === chunks.length - 1 ? done : undefined);
    }),
    last: (t) => t.buffer.active.getLine(t.buffer.active.baseY + ROWS - 1)?.translateToString(true) ?? '',
    dispose: (t) => t.dispose(),
  };
}

const ENGINES = ['oxtty-wasm', ...(existsSync(NATIVE) ? ['oxtty-native'] : []), 'xterm-headless'];

// Child process: runs one engine on one scenario once and reports the RSS growth after GC.
if (process.argv[2] === '--memory') {
  const [, , , engineName, caseName] = process.argv;
  const e = await engine(engineName);
  const { chunks } = corpus(caseName);
  globalThis.gc();
  const before = process.memoryUsage().rss;
  const t = e.make();
  await e.feed(t, chunks);
  for (let i = 0; i < 4; i++) globalThis.gc();
  process.stdout.write(JSON.stringify({ rss: process.memoryUsage().rss - before, last: e.last(t) }));
  process.exit(0);
}

const results = [];
for (const caseName of Object.keys(CASES)) {
  const { bytes, chunks } = corpus(caseName);
  const lasts = {};
  for (const engineName of ENGINES) {
    const e = await engine(engineName);
    const times = [];
    for (let run = 0; run <= RUNS; run++) {
      const t = e.make();
      const start = performance.now();
      await e.feed(t, chunks);
      const ms = performance.now() - start;
      if (run > 0) times.push(ms); // the first run is warm-up
      lasts[engineName] = e.last(t);
      e.dispose(t);
    }
    times.sort((a, b) => a - b);
    const ms = times[Math.floor(times.length / 2)];
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--memory', engineName, caseName], { encoding: 'utf8' });
    const memory = child.status === 0 ? JSON.parse(child.stdout).rss : null;
    results.push({ case: caseName, engine: engineName, ms: +ms.toFixed(1), mibPerSec: +((bytes / 1048576) / (ms / 1000)).toFixed(1), rssMiB: memory === null ? null : +(memory / 1048576).toFixed(1) });
    console.log(`${caseName.padEnd(17)} ${engineName.padEnd(15)} ${ms.toFixed(0).padStart(6)} ms ${String(results.at(-1).mibPerSec).padStart(7)} MiB/s  rss +${results.at(-1).rssMiB} MiB`);
  }
  // Given the same output, the last line must match (fairness check).
  const distinct = new Set(Object.values(lasts));
  if (distinct.size > 1) console.log(`  ! ${caseName}: last row differs between engines`, lasts);
}

const out = process.argv[2];
if (out) {
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cols: COLS, rows: ROWS, scrollback: SCROLLBACK, bytesPerCase: SIZE, chunk: CHUNK, runs: RUNS, results }, null, 2));
}
