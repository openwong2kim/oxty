import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { init, Terminal } from '../../dist/index.js';
import { importTs } from './harness.mjs';

let LocalEngineView, Viewport;
before(async () => {
  await init();
  ({ LocalEngineView, Viewport } = await importTs('src/engine-view.ts'));
});

const text = (viewport, y) => String.fromCodePoint(...Array.from({ length: viewport.cols }, (_, x) => viewport.row(y)[x * 4] || 32)).trimEnd();

test('frames carry only changed rows after the first, and the viewport keeps the rest', () => {
  const engine = new Terminal({ cols: 10, rows: 3 });
  const view = new LocalEngineView(engine);
  const viewport = new Viewport();
  engine.write('one\r\ntwo');
  const first = view.takeFrame();
  assert.equal(first.full, true);
  assert.deepEqual(viewport.apply(first), [0, 1, 2]);
  engine.write('\x1b[1;1Hzzz');
  const next = view.takeFrame();
  assert.equal(next.full, false);
  assert.ok(next.lines.includes(0) && !next.lines.includes(2));
  viewport.apply(next);
  assert.equal(text(viewport, 0), 'zzz');
  assert.equal(text(viewport, 1), 'two');
  engine.dispose();
});

test('scrolled back, rows and the cursor are in viewport coordinates', () => {
  const engine = new Terminal({ cols: 10, rows: 3, scrollback: 100 });
  const view = new LocalEngineView(engine);
  const viewport = new Viewport();
  engine.write('a\r\nb\r\nc\r\nd\r\ne');
  viewport.apply(view.takeFrame());
  assert.deepEqual([0, 1, 2].map(y => text(viewport, y)), ['c', 'd', 'e']);
  assert.deepEqual([viewport.cursor.line, viewport.cursor.visible], [2, true]);
  engine.scrollDisplay(1);
  const frame = view.takeFrame();
  assert.equal(frame.full, true);
  viewport.apply(frame);
  assert.deepEqual([0, 1, 2].map(y => text(viewport, y)), ['b', 'c', 'd']);
  assert.equal(viewport.displayOffset, 1);
  assert.equal(viewport.cursor.visible, false, 'the cursor line scrolled out of view');
  engine.dispose();
});

test('events collect replies, title, bells and clipboard requests once', () => {
  const engine = new Terminal({ cols: 10, rows: 3 });
  engine.setClipboardAccess({ read: true, write: true });
  const view = new LocalEngineView(engine);
  engine.write('\x1b[2;3H\x1b[6n\x1b]0;hi\x07\x07\x1b]52;c;aGk=\x07\x1b]52;c;?\x07');
  const events = view.takeEvents();
  assert.equal(new TextDecoder().decode(events.replies), '\x1b[2;3R');
  assert.equal(events.title, 'hi');
  assert.equal(events.bells, 1);
  assert.deepEqual(events.clipboardWrites, [{ selection: 'c', text: 'hi' }]);
  assert.deepEqual(events.clipboardReads, ['c']);
  const again = view.takeEvents();
  assert.deepEqual([again.replies.length, again.title, again.bells, again.clipboardWrites.length], [0, null, 0, 0]);
  engine.dispose();
});
