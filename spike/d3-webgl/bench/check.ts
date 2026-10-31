// 증분 렌더(청크마다 render) 결과와 같은 바이트를 한 번에 넣고 처음 그린 결과의 픽셀을 비교한다.
import { init, Terminal as Oxty } from '../../../packages/oxty/dist/index.js';
import { OxtyWebglRenderer } from '../src/OxtyWebglRenderer';
const enc = new TextEncoder();
function stream(): Uint8Array {
  const parts: string[] = [];
  for (let n = 0; n < 3000; n++) parts.push(`\x1b[3${n % 8}mPASS\x1b[0m build src/example${n}.ts 한글 😀 ${n % 3 ? '' : 'e\u0301 \x1b[4:3;58:2::255:0:0mwavy\x1b[0m '}${'x'.repeat(n % 50)}\r\n`);
  for (let n = 0; n < 200; n++) { const rows: string[] = []; for (let y = 1; y <= 40; y++) rows.push(`\x1b[${y};1H\x1b[2K\x1b[4${(n + y) % 8}m● step ${n}:${y}\x1b[0m 작업 ${'█'.repeat((n * 7 + y) % 60)}`); parts.push(`\x1b[?2026h${rows.join('')}\x1b[?2026l`); }
  parts.push('\x1b[?1049l\x1b[2J\x1b[H');
  for (let n = 0; n < 500; n++) parts.push(`line ${n} ${'abc '.repeat(n % 25)}\r\n`);
  for (let n = 0; n < 30; n++) parts.push(`\x1b[1m${n}\x1b[0m short\r\n`);
  return enc.encode(parts.join(''));
}
function pixels(c: HTMLCanvasElement): Uint8ClampedArray {
  const x = document.createElement('canvas'); x.width = c.width; x.height = c.height;
  const g = x.getContext('2d')!; g.drawImage(c, 0, 0); return g.getImageData(0, 0, c.width, c.height).data;
}
async function main() {
  await init(new URL('./oxty.wasm', location.href));
  const s = stream();
  const results: Record<string, number> = {};
  for (const chunk of [7, 333, 4096, 32768]) {
    const a = new Oxty({ cols: 120, rows: 40, scrollback: 1000 });
    const ra = new OxtyWebglRenderer(a as any, document.body, true);
    for (let o = 0; o < s.length; o += chunk) { a.write(s.subarray(o, o + chunk)); ra.render(); }
    const b = new Oxty({ cols: 120, rows: 40, scrollback: 1000 });
    const rb = new OxtyWebglRenderer(b as any, document.body, true);
    b.write(s); rb.render();
    const pa = pixels(ra.canvas), pb = pixels(rb.canvas);
    let diff = 0; for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) diff++;
    results[`chunk${chunk}`] = diff;
  }
  // 감도 확인: 한 글자만 달라도 차이가 잡혀야 한다
  const c = new Oxty({ cols: 120, rows: 40, scrollback: 1000 }), rc = new OxtyWebglRenderer(c as any, document.body, true);
  const d = new Oxty({ cols: 120, rows: 40, scrollback: 1000 }), rd = new OxtyWebglRenderer(d as any, document.body, true);
  c.write(s); rc.render(); d.write(s); d.write('X'); rd.render();
  const pc = pixels(rc.canvas), pd = pixels(rd.canvas);
  let diff = 0; for (let i = 0; i < pc.length; i++) if (pc[i] !== pd[i]) diff++;
  results.sentinelOneChar = diff;
  (window as any).__check = results;
}
main().catch(e => { (window as any).__check = { error: String(e) }; });
