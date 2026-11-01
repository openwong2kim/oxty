// The Terminal facade without a page: writes, engine events, buffer, options, addons, crash and dispose.
// No `open`, so no frames are ever drawn: replies must still flow (a hidden page answers programs too).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import xtermHeadless from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { importTs } from './harness.mjs';

const ENTRY = 'test/pages/terminal-node.ts';
const wasm = new URL('../../dist/oxtty.wasm', import.meta.url);
let m;
before(async () => {
  m = await importTs(ENTRY);
  await m.init(await readFile(wasm));
});

const write = (t, data) => new Promise(resolve => t.write(data, resolve));
const collect = event => {
  const seen = [];
  event(e => seen.push(e));
  return seen;
};
const headlessReply = async data => {
  const x = new xtermHeadless.Terminal({ allowProposedApi: true });
  const seen = collect(x.onData);
  await new Promise(resolve => x.write(data, resolve));
  x.dispose();
  return seen.join('');
};

test('constructing before init throws a clear error', async () => {
  const fresh = await importTs(ENTRY);
  assert.throws(() => new fresh.Terminal(), /await init\(\)/);
});

test('status reports reach onData before the write callback, without any frame', async () => {
  const t = new m.Terminal({ cols: 10, rows: 3 });
  const data = collect(t.onData);
  await new Promise(resolve => t.write('\x1b[2;3H\x1b[6n', () => {
    assert.deepEqual(data, ['\x1b[2;3R']);
    resolve();
  }));
  t.dispose();
});

test('the DA1 reply is the bytes xterm.js sends', { todo: 'the engine answers CSI ? 6 c; reported for crates/' }, async () => {
  const t = new m.Terminal();
  const data = collect(t.onData);
  await write(t, '\x1b[c');
  assert.equal(data.join(''), await headlessReply('\x1b[c'));
  assert.equal(data.join(''), '\x1b[?1;2c');
  t.dispose();
});

test('titles and bells become events', async () => {
  const t = new m.Terminal();
  const titles = collect(t.onTitleChange);
  const bells = collect(t.onBell);
  await write(t, '\x1b]0;hi\x07\x07');
  await write(t, '\x1b]2;there\x1b\\');
  assert.deepEqual(titles, ['hi', 'there']);
  assert.equal(bells.length, 1);
  t.dispose();
});

test('colour queries answer with the theme, also after it changes at runtime', async () => {
  const t = new m.Terminal({ theme: { foreground: '#123456' } });
  const data = collect(t.onData);
  await write(t, '\x1b]10;?\x07\x1b]11;?\x07');
  assert.deepEqual(data.splice(0), ['\x1b]10;rgb:1212/3434/5656\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\']);
  t.options.theme = { background: '#abcdef', red: 'rgb(1, 2, 3)' };
  await write(t, '\x1b]11;?\x07\x1b]4;1;?\x07');
  assert.deepEqual(data, ['\x1b]11;rgb:abab/cdcd/efef\x1b\\\x1b]4;1;rgb:0101/0202/0303\x1b\\']);
  t.dispose();
});

test('OSC 52 goes through the clipboard option, and nowhere without it', async () => {
  const copied = [];
  const t = new m.Terminal({ clipboard: { write: (text, selection) => copied.push([selection, text]), read: async () => 'pasted' } });
  const data = collect(t.onData);
  await write(t, '\x1b]52;c;aGk=\x07\x1b]52;c;?\x07');
  assert.deepEqual(copied, [['c', 'hi']]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(data.splice(0), ['\x1b]52;c;cGFzdGVk\x07']);
  t.options.clipboard = undefined;
  await write(t, '\x1b]52;c;aGk=\x07\x1b]52;c;?\x07');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual([copied.length, data.length], [1, 0]);
  t.dispose();
});

test('a string write split inside a surrogate pair keeps the high half for the next write', async () => {
  const t = new m.Terminal({ cols: 10, rows: 2 });
  t.write('a\ud83d');
  await write(t, '\ude00b');
  assert.equal(t.buffer.active.getLine(0).translateToString(true), 'a😀b');
  t.dispose();
});

test('the buffer reads like xterm.js: lines, wrapping, wide cells, cursor and scroll position', async () => {
  const input = 'one\r\n' + 'x'.repeat(12) + '\r\n한글 b\r\nfour\r\nfive';
  const t = new m.Terminal({ cols: 10, rows: 3, scrollback: 50 });
  const x = new xtermHeadless.Terminal({ cols: 10, rows: 3, scrollback: 50, allowProposedApi: true });
  await write(t, input);
  await new Promise(resolve => x.write(input, resolve));
  const [a, b] = [t.buffer.active, x.buffer.active];
  for (const key of ['type', 'length', 'baseY', 'viewportY', 'cursorX', 'cursorY']) assert.equal(a[key], b[key], key);
  for (let y = 0; y < b.length; y++) {
    const [la, lb] = [a.getLine(y), b.getLine(y)];
    assert.equal(la.isWrapped, lb.isWrapped, `line ${y} isWrapped`);
    assert.equal(la.length, lb.length);
    for (const args of [[true], [false], [false, 1, 4]]) assert.equal(la.translateToString(...args), lb.translateToString(...args), `line ${y} ${args}`);
  }
  const wide = a.getLine(3);
  assert.deepEqual([0, 1].map(i => [wide.getCell(i).getChars(), wide.getCell(i).getWidth()]), [['한', 2], ['', 0]]);
  assert.equal(a.getLine(b.length), undefined);
  x.dispose();

  const scrolls = collect(t.onScroll);
  t.scrollToTop();
  t.scrollLines(1);
  t.scrollToLine(2);
  t.scrollToBottom();
  assert.deepEqual(scrolls, [0, 1, 2, 3]);
  t.dispose();
});

test('the alternate screen changes the active buffer type and fires onBufferChange', async () => {
  const t = new m.Terminal({ cols: 10, rows: 3 });
  const types = [];
  t.buffer.onBufferChange(buffer => types.push(buffer.type));
  await write(t, '\x1b[?1049h');
  assert.equal(t.buffer.active.type, 'alternate');
  await write(t, '\x1b[?1049l');
  assert.deepEqual(types, ['alternate', 'normal']);
  t.dispose();
});

test('modes follow the program', async () => {
  const t = new m.Terminal();
  assert.equal(t.modes.mouseTrackingMode, 'none');
  await write(t, '\x1b[?2004h\x1b[?1002h\x1b[?1h');
  const modes = t.modes;
  assert.deepEqual([modes.bracketedPasteMode, modes.mouseTrackingMode, modes.applicationCursorKeysMode, modes.wraparoundMode], [true, 'drag', true, true]);
  t.dispose();
});

test('options: init-only keys throw at runtime, resize updates size and fires onResize', () => {
  const t = new m.Terminal({ cols: 20, rows: 5 });
  assert.equal(t.options.fontSize, 15);
  assert.throws(() => { t.options.scrollback = 10; }, /constructor/);
  assert.throws(() => { t.options.cols = 30; }, /constructor/);
  const resized = collect(t.onResize);
  t.resize(30, 6);
  t.resize(30, 6);
  assert.deepEqual(resized, [{ cols: 30, rows: 6 }]);
  assert.deepEqual([t.cols, t.rows, t.options.cols, t.options.rows], [30, 6, 30, 6]);
  t.dispose();
});

test('loadAddon absorbs unicode11 and webgl addons and rejects the rest', () => {
  const t = new m.Terminal();
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  assert.throws(() => { t.unicode.activeVersion = '6'; }, /Unicode 11/);
  const webgl = new WebglAddon();
  t.loadAddon(webgl);
  webgl.onContextLoss(() => {}).dispose();
  webgl.dispose();
  const fit = new m.FitAddon();
  t.loadAddon(fit);
  assert.equal(fit.proposeDimensions(), undefined, 'not opened');
  assert.throws(() => t.loadAddon({ activate() {}, dispose() {}, findNext() {} }), /addon-search/);
  assert.throws(() => t.loadAddon({ activate() {}, dispose() {}, serialize() {} }), /ansiSnapshot/);
  assert.throws(() => t.loadAddon({ activate(term) { term.registerLinkProvider({}); }, dispose() {} }), /unsupported addon/);
  assert.throws(() => t.loadAddon({ activate() {}, dispose() {} }), /unsupported addon/);
  t.dispose();
});

test('reset clears the screen at once', async () => {
  const t = new m.Terminal({ cols: 10, rows: 2 });
  await write(t, 'text');
  t.reset();
  assert.equal(t.buffer.active.getLine(0).translateToString(true), '');
  t.dispose();
});

test('an engine crash mid-write settles the callbacks and later writes work', async t => {
  t.mock.method(console, 'warn', () => {});
  const term = new m.Terminal({ cols: 10, rows: 2 });
  const engine = term._engine;
  const feed = engine.write.bind(engine);
  let crash = true;
  engine.write = data => {
    if (crash && String(data).includes('boom')) {
      crash = false;
      m.trapEngine();
    }
    feed(data);
  };
  const settled = [];
  term.write('boom', () => settled.push('boom'));
  await write(term, 'after');
  settled.push('after');
  assert.deepEqual(settled, ['boom', 'after']);
  assert.equal(term.buffer.active.getLine(0).translateToString(true), 'after');
  assert.equal(term._view._full, true, 'the next frame redraws everything');
  assert.equal(console.warn.mock.callCount(), 1);
  term.dispose();
});

test('dispose drops a pending drain and later writes', async () => {
  const t = new m.Terminal();
  let parsed = 0;
  t.onWriteParsed(() => parsed++);
  let done = false;
  t.write('x'.repeat(16 * 1024 * 1024), () => { done = true; });
  await new Promise(resolve => { const d = t.onWriteParsed(() => { d.dispose(); resolve(); }); });
  t.dispose();
  t.write('more');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(done, false);
  assert.equal(parsed, 1);
});
