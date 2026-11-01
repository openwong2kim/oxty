// The buffer API, modes, reset, scrolling and events of the oxtty/xterm Terminal beyond the parity cases in
// terminal.test.mjs: next to @xterm/headless where xterm.js has an answer, and odd arguments that must neither
// throw nor stop the page (the front end aborts on a panic).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import xtermHeadless from '@xterm/headless';
import * as m from '../../dist/xterm.js';

before(async () => {
  await m.init(undefined, await readFile(new URL('../../dist/xterm_web_bg.wasm', import.meta.url)));
});

const write = (t, data) => new Promise((resolve) => t.write(data, resolve));

test('combining marks, styles and a wide character pushed to the next row read like xterm.js', async () => {
  const input = '\x1b[1;2mab\x1b[0m é\r\nabcd한x';
  const t = new m.Terminal({ cols: 5, rows: 3 });
  const x = new xtermHeadless.Terminal({ cols: 5, rows: 3, allowProposedApi: true });
  await write(t, input);
  await new Promise((resolve) => x.write(input, resolve));
  const [a, b] = [t.buffer.active, x.buffer.active];
  for (let y = 0; y < 3; y++) {
    const [la, lb] = [a.getLine(y), b.getLine(y)];
    assert.equal(la.isWrapped, lb.isWrapped, `line ${y} isWrapped`);
    for (const args of [[true], [false], [false, 2], [true, 1, 3]]) assert.equal(la.translateToString(...args), lb.translateToString(...args), `line ${y} ${args}`);
    for (let col = 0; col < 5; col++) {
      const [ca, cb] = [la.getCell(col), lb.getCell(col)];
      // Erased cells read ' ' here and '' in xterm.js (the engine does not tell them from typed spaces).
      assert.deepEqual(
        [ca.getChars() || ' ', ca.getWidth(), !!ca.isBold(), !!ca.isDim(), !!ca.isItalic()],
        [cb.getChars() || ' ', cb.getWidth(), !!cb.isBold(), !!cb.isDim(), !!cb.isItalic()],
        `line ${y} cell ${col}`,
      );
    }
  }
  assert.equal(a.getLine(0).getCell(3).getCode(), b.getLine(0).getCell(3).getCode());
  x.dispose();
  t.dispose();
});

test('the inactive buffer reads empty and buffers keep their type across a screen switch', async () => {
  const t = new m.Terminal({ cols: 10, rows: 2 });
  await write(t, 'normal');
  const normal = t.buffer.active;
  assert.deepEqual([normal.type, t.buffer.alternate.length, t.buffer.alternate.getLine(0)], ['normal', 0, undefined]);
  await write(t, '\x1b[?1049h\x1b[Halt');
  assert.deepEqual([normal.type, t.buffer.active.type, t.buffer.normal.getLine(0)], ['normal', 'alternate', undefined]);
  assert.equal(t.buffer.alternate.getLine(0).translateToString(true), 'alt');
  await write(t, '\x1b[?1049l');
  assert.equal(normal.getLine(0).translateToString(true), 'normal');
  t.dispose();
});

test('odd arguments return undefined, clamp or read empty instead of throwing', async () => {
  const t = new m.Terminal({ cols: 4, rows: 2 });
  await write(t, 'abcd');
  const buffer = t.buffer.active;
  for (const y of [-1, 0.5, NaN, Infinity, 2, 1e300]) assert.equal(buffer.getLine(y), undefined, `getLine(${y})`);
  const line = buffer.getLine(0);
  for (const x of [-1, 0.5, NaN, 4]) assert.equal(line.getCell(x), undefined, `getCell(${x})`);
  assert.equal(line.getCell(0, buffer.getNullCell()).getChars(), 'a');
  assert.deepEqual(
    [[false, -5, 2], [false, 2, 1e9], [true, NaN], [false, 3, 1], [undefined, undefined, 2]].map((args) => line.translateToString(...args)),
    ['ab', 'cd', '', '', 'ab'],
  );
  assert.deepEqual([buffer.getNullCell().getChars(), buffer.getNullCell().getWidth(), buffer.getNullCell().getCode()], ['', 1, 0]);
  t.scrollToLine(-1e9);
  t.scrollToLine(1e9);
  t.scrollPages(1e9);
  t.dispose();
  assert.deepEqual([buffer.length, buffer.getLine(0), t.buffer.active.cursorX, t.modes.wraparoundMode], [0, undefined, 0, true]);
  t.reset();
  t.scrollToTop();
  assert.throws(() => t.ansiSnapshot(), /disposed/);
});

test('events read unbound deliver, their disposables unsubscribe, and nothing subscribes after dispose', async () => {
  const t = new m.Terminal({ cols: 10, rows: 2 });
  const { onData, onWriteParsed } = t;
  const data = [];
  let parsed = 0;
  onData((d) => data.push(d));
  const sub = onWriteParsed(() => parsed++);
  await write(t, '\x1b[6n');
  sub.dispose();
  await write(t, '\x1b[6n');
  assert.deepEqual([data, parsed], [['\x1b[1;1R', '\x1b[1;1R'], 1]);
  assert.equal(typeof onData(42).dispose, 'function');
  t.dispose();
  const late = [];
  onData((d) => late.push(d)).dispose();
  assert.deepEqual(late, []);
});

test('reset applies at once, also while a synchronized update holds output', async () => {
  const t = new m.Terminal({ cols: 10, rows: 2 });
  await write(t, '\x1b[?2026hheld\x1b[?2004h');
  assert.equal(t.modes.synchronizedOutputMode, true);
  t.reset();
  assert.deepEqual(
    [t.buffer.active.getLine(0).translateToString(true), t.modes.synchronizedOutputMode, t.modes.bracketedPasteMode],
    ['', false, false],
  );
  await write(t, 'after');
  assert.equal(t.buffer.active.getLine(0).translateToString(true), 'after');
  t.dispose();
});

test('scrollPages scrolls by screens less one row and ansiSnapshot rebuilds the screen in xterm.js', async () => {
  const t = new m.Terminal({ cols: 10, rows: 3, scrollback: 50 });
  await write(t, Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\r\n'));
  const scrolls = [];
  t.onScroll((y) => scrolls.push(y));
  t.scrollPages(-2);
  t.scrollPages(1);
  assert.deepEqual(scrolls, [5, 7]);
  const snapshot = t.ansiSnapshot();
  assert.equal(snapshot.ok, true);
  const x = new xtermHeadless.Terminal({ cols: 10, rows: 3, scrollback: 50, allowProposedApi: true });
  await new Promise((resolve) => x.write(snapshot.payload, resolve));
  assert.equal(x.buffer.active.getLine(11).translateToString(true).trimEnd(), 'line 11');
  x.dispose();
  t.dispose();
});
