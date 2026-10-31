import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { init, Terminal, Attr, Mode, decodeColor } from '../dist/index.js';

before(async () => {
  await init();
  await init(); // idempotent
});

const make = (o) => new Terminal({ cols: 80, rows: 24, ...o });

test('korean and ascii in one row, wide cells flagged', () => {
  const t = make();
  t.write('안녕 hello\r\n');
  assert.equal(t.rowText(0), '안녕 hello');
  const cells = t.rowCells(0);
  assert.equal(String.fromCodePoint(cells[0]), '안');
  assert.ok(cells[3] & Attr.WIDE);
  assert.ok(cells[4 + 3] & Attr.WIDE_SPACER);
  assert.deepEqual(t.cursor(), { line: 1, col: 0, visible: true, shape: 'block', blink: false });
  t.dispose();
});

test('bytes split anywhere still decode', () => {
  const t = make();
  const bytes = new TextEncoder().encode('한\x1b[31mX');
  for (const b of bytes) t.write(Uint8Array.of(b));
  assert.equal(t.rowText(0), '한X');
  assert.deepEqual(decodeColor(t.rowCells(0)[2 * 4 + 1]), { kind: 'named', value: 1 });
});

test('256 and truecolor', () => {
  const t = make();
  t.write('\x1b[38;5;208mO\x1b[48;2;10;20;30mT');
  const c = t.rowCells(0);
  assert.deepEqual(decodeColor(c[1]), { kind: 'indexed', value: 208 });
  assert.deepEqual(decodeColor(c[4 + 2]), { kind: 'rgb', value: 0x0a141e });
});

test('alternate screen and modes', () => {
  const t = make();
  t.write('main\x1b[?1049h\x1b[H\x1b[2Jalt\x1b[?2004h');
  assert.ok(t.modes() & Mode.ALT_SCREEN);
  assert.ok(t.modes() & Mode.BRACKETED_PASTE);
  assert.equal(t.rowText(0), 'alt');
  t.write('\x1b[?1049l');
  assert.equal(t.rowText(0), 'main');
});

test('scrollback with negative lines', () => {
  const t = new Terminal({ cols: 20, rows: 5, scrollback: 100 });
  for (let i = 0; i < 12; i++) t.write(`line ${i}\r\n`);
  assert.equal(t.historyLength, 8);
  assert.equal(t.rowText(-8), 'line 0');
  assert.equal(t.rowText(0), 'line 8');
  assert.equal(t.rowText(-9), null);
});

test('damage lists changed rows', () => {
  const t = make();
  assert.deepEqual(t.takeDamage(), { full: true, scroll: 0, lines: [] });
  t.write('\x1b[3;1Hhello');
  const d = t.takeDamage();
  assert.equal(d.full, false);
  assert.ok(d.lines.includes(2));
  t.resize(100, 30);
  assert.equal(t.takeDamage().full, true);
  assert.equal(t.cols, 100);
});

test('cols and rows follow the engine size after resize', () => {
  const t = make();
  for (const [cols, rows] of [[100, 30], [1, 1], [0, 0]]) {
    t.resize(cols, rows);
    assert.equal(t.rowCells(0).length / 4, t.cols);
    assert.notEqual(t.rowCells(t.rows - 1), null);
    assert.equal(t.rowCells(t.rows), null);
  }
  t.dispose();
  assert.throws(() => t.cols, /disposed/);
});

test('replies, title, bell', () => {
  const t = make();
  t.write('\x1b[3;7H\x1b[6n\x1b]2;build\x07\x07');
  assert.equal(new TextDecoder().decode(t.takeReplies()), '\x1b[3;7R');
  assert.equal(t.takeReplies().length, 0);
  assert.equal(t.takeTitle(), 'build');
  assert.equal(t.takeTitle(), null);
  assert.equal(t.takeBells(), 1);
});

test('synchronized output: program ends it', () => {
  const t = make();
  t.write('\x1b[?2026hSYNC');
  assert.equal(t.syncPending(), true);
  assert.equal(t.rowText(0), '');
  t.write('\x1b[?2026l');
  assert.equal(t.rowText(0), 'SYNC');
  t.dispose();
});

test('synchronized output: timeout flushes and notifies', async () => {
  let flushed = 0;
  const t = make({ syncTimeoutMs: 20, onSyncFlush: () => flushed++ });
  t.write('\x1b[?2026hLATE');
  assert.equal(t.rowText(0), '');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(flushed, 1);
  assert.equal(t.rowText(0), 'LATE');
  t.dispose();
});

test('terminals are independent and disposable', () => {
  const a = make();
  const b = make();
  a.write('A');
  b.write('B');
  assert.equal(a.rowText(0), 'A');
  assert.equal(b.rowText(0), 'B');
  a.dispose();
  a.dispose();
  assert.throws(() => a.rowText(0), /disposed/);
  assert.equal(b.rowText(0), 'B');
  const c = make(); // reuses a's slot
  assert.equal(c.rowText(0), '');
});

test('large write grows the input buffer', () => {
  const t = new Terminal({ cols: 80, rows: 24, scrollback: 10000 });
  const chunk = 'x'.repeat(79) + '\r\n';
  t.write(chunk.repeat(5000));
  assert.equal(t.historyLength, 5000 - 23);
  assert.equal(t.rowText(0), 'x'.repeat(79));
});

test('row extras: combining, underline colour, shared hyperlink', () => {
  const t = make();
  t.write('é\x1b[4:3;58;2;255;0;0mX\x1b[0m\x1b]8;id=a;https://oxty.dev\x1b\\LN\x1b]8;;\x1b\\Z');
  const cells = t.rowCells(0);
  assert.ok(cells[1 * 4 + 3] & Attr.UNDERLINE_COLOR);
  assert.ok(cells[2 * 4 + 3] & Attr.HYPERLINK);
  const extras = t.rowExtras(0);
  assert.deepEqual(extras.map((e) => e.col), [0, 1, 2, 3]);
  assert.equal(extras[0].text, 'é');
  assert.deepEqual(decodeColor(extras[1].underlineColor), { kind: 'rgb', value: 0xff0000 });
  assert.deepEqual(extras[2].hyperlink, { id: 'a', uri: 'https://oxty.dev' });
  assert.equal(extras[2].hyperlink, extras[3].hyperlink);
  assert.deepEqual(t.rowExtras(1), []);
  assert.equal(t.rowExtras(99), null);
});

test('cursor shape, view scrolling, scroll damage', () => {
  const t = make({ cols: 20, rows: 5 });
  t.write('\x1b[5 q');
  assert.deepEqual([t.cursor().shape, t.cursor().blink], ['bar', true]);
  t.write('a\r\nb\r\nc\r\nd\r\ne');
  t.takeDamage();
  t.write('\r\nf');
  assert.deepEqual(t.takeDamage(), { full: false, scroll: 1, lines: [3, 4] });
  t.scrollDisplay(1);
  assert.equal(t.displayOffset, 1);
  assert.equal(t.takeDamage().full, true);
  t.scrollToBottom();
  assert.equal(t.displayOffset, 0);
});

test('ansi snapshot: payload rebuilds the screen, refusal names the reason', () => {
  const t = make({ cols: 20, rows: 5 });
  t.write('\x1b[?2026h\x1b[31mred\x1b[3');
  const s = t.ansiSnapshot();
  assert.equal(s.ok, true);
  assert.ok(s.payload instanceof Uint8Array);
  assert.deepEqual(t.ansiSnapshot(), s);
  assert.equal(t.syncPending(), true);
  const copy = make({ cols: 20, rows: 5 });
  copy.write(s.payload);
  copy.write('4mX\x1b[?2026l');
  t.write('4mX\x1b[?2026l');
  assert.equal(copy.rowText(0), 'redX');
  assert.deepEqual(copy.rowCells(0), t.rowCells(0));
  t.write('\x1b[2;3r');
  assert.deepEqual(t.ansiSnapshot(), { ok: false, reason: 'margins' });
});
