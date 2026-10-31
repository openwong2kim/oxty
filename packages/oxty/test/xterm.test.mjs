// oxty ⇄ xterm.js 화면 동등성. `npm ci && npm test`(packages/oxty)에서 돈다.
// 비교기가 실패할 수 있음을 케이스보다 먼저 보인다: 모든 비교 필드에 그 필드를 바꾸는 입력(레버)이 있어야 한다.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { init, Terminal } from '../dist/index.js';
import { xterm, play, xtermScreen, oxtyScreen, diffScreens, fieldsOf, oracleMismatch, LEVERS, OXTY_CONSTANT } from './xterm/screen.mjs';

before(async () => { await init(); });

/** 20x6 빈 화면에 events를 적용한 두 레코드. */
async function screens(events) {
  const x = xterm(20, 6, 100);
  const o = new Terminal({ cols: 20, rows: 6, scrollback: 100 });
  try {
    await play(events, x, o);
    return { x: xtermScreen(x), o: oxtyScreen(o) };
  } finally {
    o.dispose();
    x.dispose();
  }
}

const fields = (diffs) => new Set(diffs.map((d) => d.field));

test('reference xterm is the version package.json pins', () => {
  assert.equal(oracleMismatch(), null);
  assert.match(oracleMismatch({ '@xterm/headless': '0.0.0' }), /0\.0\.0/);
});

test('every compared field has a lever', async () => {
  const blank = await screens([]);
  const levers = Object.keys(LEVERS).sort();
  assert.deepEqual([...fieldsOf(blank.x)].sort(), levers);
  assert.deepEqual([...fieldsOf(blank.o)].sort(), levers);
});

test('each lever moves its field on xterm and on oxty (except OXTY_CONSTANT)', async () => {
  const blank = await screens([]);
  for (const [field, events] of Object.entries(LEVERS)) {
    const moved = await screens(events);
    assert.ok(fields(diffScreens(blank.x, moved.x)).has(field), `xterm: lever for ${field} did not move it`);
    const oxtyMoved = fields(diffScreens(blank.o, moved.o)).has(field);
    if (OXTY_CONSTANT.has(field)) assert.ok(!oxtyMoved, `oxty: ${field} is listed constant but moved`);
    else assert.ok(oxtyMoved, `oxty: lever for ${field} did not move it`);
  }
});

test('on every lever input xterm and oxty agree except OXTY_CONSTANT', async () => {
  for (const [field, events] of Object.entries(LEVERS)) {
    const { x, o } = await screens(events);
    const left = diffScreens(x, o).filter((d) => !OXTY_CONSTANT.has(d.field));
    assert.deepEqual(left, [], `lever for ${field}`);
  }
});
