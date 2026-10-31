// Run after scripts/build-node.sh:  node --test crates/oxty-node/test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Terminal } = require(path.join(__dirname, 'oxty.node'));

test('native binding mirrors the wasm API', () => {
  const t = new Terminal(80, 24, 100);
  t.write('안녕 \x1b[31mred\x1b[0m\r\n');
  t.write(Buffer.from('\x1b[3;7H\x1b[6n\x1b]0;native\x07'));
  assert.equal(t.rowText(0), '안녕 red');
  assert.equal(t.cols, 80);
  assert.equal(t.rows, 24);
  assert.deepEqual(t.cursor(), { line: 2, col: 6, visible: true });
  assert.equal(t.takeReplies().toString(), '\x1b[3;7R');
  assert.equal(t.takeTitle(), 'native');
  const cells = t.rowCells(0);
  assert.ok(cells instanceof Uint32Array);
  assert.equal(cells.length, 80 * 4);
  assert.equal(String.fromCodePoint(cells[0]), '안');
  assert.equal(t.rowCells(99), null);
  assert.equal(t.takeDamage().full, true);
  t.write('x');
  const d = t.takeDamage();
  assert.equal(d.full, false);
  assert.ok(d.lines.includes(2));
});

test('native sync flush and scrollback', () => {
  const t = new Terminal(20, 5);
  t.write('\x1b[?2026hHELD');
  assert.equal(t.syncPending(), true);
  assert.equal(t.rowText(0), '');
  t.flushSync();
  assert.equal(t.rowText(0), 'HELD');
  for (let i = 0; i < 10; i++) t.write(`\r\nline ${i}`);
  assert.ok(t.historyLength > 0);
  assert.equal(t.rowText(-t.historyLength), 'HELD');
});
