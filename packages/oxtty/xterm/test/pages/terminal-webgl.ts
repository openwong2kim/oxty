// Page for terminal-webgl.test.mjs: a real Terminal with the WebGL renderer. Writes coloured Hangul plus a cursor
// position request and reads the canvas in the frame that drew it (the drawing buffer is not preserved).
import { init, Terminal } from '../../src/index';

async function main(): Promise<Record<string, unknown>> {
  await init();
  const t = new Terminal({ cols: 20, rows: 3, fontFamily: 'Menlo, monospace', fontSize: 14, theme: { background: '#000000' } });
  const data: string[] = [];
  t.onData(d => data.push(d));
  t.open(document.getElementById('terminal')!);
  const drawn = new Promise<{ lit: number; red: number }>(resolve => {
    t.onRender(() => {
      // The texture atlas keeps a hidden canvas of its own next to the drawn one.
      const canvas = Array.from(t.element!.querySelectorAll('canvas')).find(c => c.style.display !== 'none')!;
      const copy = document.createElement('canvas');
      [copy.width, copy.height] = [canvas.width, canvas.height];
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
      let lit = 0;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] || pixels[i + 1] || pixels[i + 2]) lit++;
        if (pixels[i] > 150 && pixels[i + 1] < 100 && pixels[i + 2] < 100) red++;
      }
      if (red) resolve({ lit, red });
    });
  });
  await new Promise<void>(resolve => t.write('\x1b[31m한글\x1b[0m ok\x1b[6n', resolve));
  const pixels = await drawn;
  const facts = { data, ...pixels, line: t.buffer.active.getLine(0)!.translateToString(true) };
  t.dispose();
  return facts;
}

const w = window as unknown as { result?: unknown };
main().then(facts => { w.result = facts; }, err => { w.result = { error: String(err?.stack ?? err) }; });
