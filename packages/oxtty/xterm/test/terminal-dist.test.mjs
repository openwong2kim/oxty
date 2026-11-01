// The built package entry (npm run build:xterm): dist/xterm.js shares dist/index.js, so its init loads the
// wasm next to it; the types and the xterm.js licence notice ship with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { init, FitAddon, Terminal } from '../../dist/xterm.js';

test('dist/xterm.js works with only `await init()`, and ships its types and notices', async () => {
  await init();
  const t = new Terminal({ cols: 10, rows: 2 });
  const data = [];
  t.onData(d => data.push(d));
  await new Promise(resolve => t.write('hi\x1b[6n', resolve));
  assert.equal(t.buffer.active.getLine(0).translateToString(true), 'hi');
  assert.deepEqual(data, ['\x1b[1;3R']);
  t.loadAddon(new FitAddon());
  t.dispose();
  const bundle = await readFile(new URL('../../dist/xterm.js', import.meta.url), 'utf8');
  assert.match(bundle, /from "\.\/index\.js"/, 'the engine stays external');
  assert.match(await readFile(new URL('../../dist/xterm.js.LEGAL.txt', import.meta.url), 'utf8'), /The xterm\.js authors/);
  assert.equal(await readFile(new URL('../../dist/xterm.d.ts', import.meta.url), 'utf8'), await readFile(new URL('../xterm.d.ts', import.meta.url), 'utf8'));
});
