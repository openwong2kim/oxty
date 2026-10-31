// 렌더러 벤치: 같은 바이트를 xterm.js(+WebGL 애드온) 또는 oxty(+차용 WebGL 렌더러) 패널 N개에 rAF마다 나눠 넣는다.
// 끝나면 총 시간, 프레임 간격, 긴 작업, 화면 해시를 window.__bench에 남긴다. 메모리는 run.mjs가 잰다.
import { init, Terminal as Oxty } from '../../../packages/oxty/dist/index.js';
import { OxtyWebglRenderer } from '../src/OxtyWebglRenderer';
import { WriteQueue } from '../src/WriteQueue';
import { Terminal as XTerm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';

const q = new URLSearchParams(location.search);
const backend = q.get('backend')!, workload = q.get('workload')!;
const ALIGN = q.get('align') === '1';
const PANES = Number(q.get('panes') ?? 8), MIB = Number(q.get('mib') ?? 2), CHUNK = Number(q.get('chunk') ?? 32) * 1024;
const COLS = 120, ROWS = 40, SCROLLBACK = 10000;
const enc = new TextEncoder();

// log: wmux 데몬 벤치 producer와 같은 줄. tui: 동기화 출력으로 화면 전체를 다시 그리는 에이전트형 TUI.
function makeStream(): Uint8Array {
  const target = MIB * 1048576, parts: string[] = [];
  let size = 0, n = 0;
  while (size < target) {
    let s: string;
    if (workload === 'log') s = `\x1b[32mPASS\x1b[0m build src/example${n}.ts 한글 😀 1234567890\r\n`;
    else {
      const rows: string[] = [];
      for (let y = 1; y <= ROWS; y++) rows.push(`\x1b[${y};1H\x1b[2K\x1b[3${y % 8}m● step ${n}:${y}\x1b[0m 작업 진행 중 ${'█'.repeat((n + y) % 40)}`);
      s = `\x1b[?2026h${rows.join('')}\x1b[?2026l`;
    }
    parts.push(s); size += enc.encode(s).length; n++;
  }
  return enc.encode(parts.join(''));
}

const ESU = enc.encode('\x1b[?2026l');
function lastEsu(b: Uint8Array, from: number, to: number): number {
  for (let i = to - ESU.length; i >= from; i--) {
    let k = 0;
    while (k < ESU.length && b[i + k] === ESU[k]) k++;
    if (k === ESU.length) return i + ESU.length;
  }
  return -1;
}

interface Pane { write(d: Uint8Array): Promise<void>; draw(): void; text(): string }

function xtermPane(el: HTMLElement): Pane {
  const t = new XTerm({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true, logLevel: 'off', fontSize: 12 } as any);
  t.loadAddon(new Unicode11Addon()); t.unicode.activeVersion = '11';
  t.open(el); t.loadAddon(new WebglAddon());
  return {
    write: d => new Promise<void>(r => t.write(d, r)),
    draw: () => {},                       // xterm.js는 자체 rAF에서 그린다
    text: () => { const b = t.buffer.active; return Array.from({ length: ROWS }, (_, y) => b.getLine(b.baseY + y)!.translateToString(true)).join('\n'); },
  };
}
function oxtyPane(el: HTMLElement): Pane {
  const o = new Oxty({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
  const r = new OxtyWebglRenderer(o as any, el);
  let dirty = false;
  // xterm.js와 같이 쓰기를 12ms씩 나눠 넣는다
  const q = new WriteQueue(o as any, () => { dirty = true; });
  return {
    write: d => q.write(d),
    draw: () => { if (dirty) { r.render(); dirty = false; } },
    text: () => Array.from({ length: ROWS }, (_, y) => (o.rowText(y) ?? '').trimEnd()).join('\n'),
  };
}

async function main() {
  if (backend === 'oxty') await init(new URL('./oxty.wasm', location.href));
  const stream = makeStream();
  const root = document.getElementById('panes')!;
  const panes: Pane[] = [];
  for (let i = 0; i < PANES; i++) {
    const el = document.createElement('div'); el.className = 'pane'; root.appendChild(el);
    panes.push(backend === 'xterm' ? xtermPane(el) : oxtyPane(el));
  }
  const gl = document.createElement('canvas').getContext('webgl2')!;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';

  let longTasks = 0, longTaskMs = 0;
  new PerformanceObserver(l => { for (const e of l.getEntries()) { longTasks++; longTaskMs += e.duration; } }).observe({ type: 'longtask', buffered: false });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const frames: number[] = [];
  const pending: Promise<void>[] = [];
  let offset = 0, last = performance.now();
  const start = last;
  await new Promise<void>(done => {
    const tick = (now: number) => {
      frames.push(now - last); last = now;
      if (offset < stream.length) {
        // align=1: TUI 프로그램처럼 프레임(?2026 블록) 단위로만 끊는다
        let end = Math.min(offset + CHUNK, stream.length);
        if (ALIGN && end < stream.length) { const at = lastEsu(stream, offset, end); if (at > offset) end = at; }
        const chunk = stream.subarray(offset, end); offset = end;
        for (const p of panes) pending.push(p.write(chunk));
      }
      for (const p of panes) p.draw();
      if (offset < stream.length) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  await Promise.all(pending);
  // 마지막 바이트까지 그려지도록 두 프레임 더 기다린다
  await new Promise<void>(r => requestAnimationFrame(() => { for (const p of panes) p.draw(); requestAnimationFrame(() => r()); }));
  const elapsedMs = performance.now() - start;

  const sorted = frames.slice(1).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const screen = panes[0].text().split('\n').map(l => l.trimEnd()).join('\n');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(screen)))).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  (window as any).__bench = { backend, workload, align: ALIGN, panes: PANES, mib: MIB, chunkKiB: CHUNK / 1024, bytes: stream.length, elapsedMs, frames: frames.length,
    frameP50: pct(0.5), frameP95: pct(0.95), frameMax: sorted[sorted.length - 1], longTasks, longTaskMs, gpu, hash };
}
main().catch(e => { console.error(e); (window as any).__bench = { error: String(e) }; });
