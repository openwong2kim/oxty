import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

// The spike line where "안녕하세요" looked spread apart and "입니다" stuck together (PRD §9)
const LINE = '한글: 안녕하세요, 터미널 엔진 oxtty입니다.';
// Two-cell runs of 안 녕 하 세 요 and 입 니 다
const RUNS = [[6, 8], [8, 10], [10, 12], [12, 14], [14, 16], [35, 37], [37, 39], [39, 41]];
const OPTIONS = [
  { fontFamily: 'Menlo, monospace', fontSize: 14 },
  { fontFamily: 'monospace', fontSize: 15 },
  { fontFamily: 'Menlo, "Apple SD Gothic Neo", monospace', fontSize: 14, lineHeight: 1.2, letterSpacing: 1 }
];

for (const deviceScaleFactor of [1, 2]) {
  test(`Hangul draws exactly as xterm.js with the WebGL addon (DPR ${deviceScaleFactor})`, async () => {
    const results = await withPage('test/pages/renderer-hangul.ts', async page => {
      await page.waitForFunction(() => window.ready);
      return page.evaluate(async ([line, runs, options]) => {
        const out = [];
        for (const o of options) out.push(await window.compare(line, o, runs));
        return out;
      }, [LINE, RUNS, OPTIONS]);
    }, { deviceScaleFactor });
    for (const [k, r] of results.entries()) {
      const what = JSON.stringify(OPTIONS[k]);
      assert.deepEqual(r.oxtty, r.xterm, `cell metrics, ${what}`);
      assert.equal(r.diff, 0, `pixels, ${what}`);
      assert.deepEqual(r.oxttyInk, r.xtermInk, `glyph ink, ${what}`);
      // The fallback font's Hangul is narrower than two cells, so every syllable leaves a gap on its right in both
      const slot = 2 * r.oxtty.cell.width;
      assert.ok(r.oxttyInk.every(([left, right]) => left >= 0 && right < slot - 2), `${what}: ${JSON.stringify(r.oxttyInk)} in ${slot}`);
    }
  });
}
