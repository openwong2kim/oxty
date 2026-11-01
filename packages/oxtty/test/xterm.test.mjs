// oxtty ⇄ xterm.js 화면 동등성. `npm ci && npm test`(packages/oxtty)에서 돈다.
//   증명 A: 같은 이벤트 → oxtty 레코드 == xterm 레코드 (wmux 렌더러가 엔진 교체 뒤 읽을 바로 그 데이터)
//   증명 B: 같은 이벤트 → oxtty ansiSnapshot() → 새 xterm에 쓴 화면 == xterm 원본 (wmux가 패인을 복원할 때 보는 화면)
// 단계마다 비교한다: initial → continued(case.tail) → returned(xterm이 대체 화면이면 ?1049lX).
// 같음이 아닌 결과는 known-differences.json에 이유와 함께 있어야 하고, 그 항목은 실제로 나타나야 한다.
// 비교기가 실패할 수 있음을 케이스보다 먼저 보인다: 모든 비교 필드에 그 필드를 바꾸는 입력(레버)이 있어야 한다.
// OXTTY_SWAP_GATE=1이면 엔진 교체를 막는 항목(blocksSwap)이 하나라도 있을 때 실패한다(PRD G3).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { init, Terminal } from '../dist/index.js';
import { xterm, play, xtermScreen, oxttyScreen, diffScreens, fieldsOf, oracleMismatch, LEVERS, OXTTY_CONSTANT } from './xterm/screen.mjs';
import { CASES, WMUX_COUNTS, corpus } from './xterm/cases.mjs';

const KNOWN = JSON.parse(readFileSync(new URL('./xterm/known-differences.json', import.meta.url), 'utf8'));
const ORACLE = oracleMismatch();

before(async () => { await init(); });

/** 20x6 빈 화면에 events를 적용한 두 레코드. */
async function screens(events) {
  const x = xterm(20, 6, 100);
  const o = new Terminal({ cols: 20, rows: 6, scrollback: 100 });
  try {
    await play(events, x, o);
    return { x: xtermScreen(x), o: oxttyScreen(o) };
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

test('each lever moves its field on xterm and on oxtty (except OXTTY_CONSTANT)', async () => {
  const blank = await screens([]);
  for (const [field, events] of Object.entries(LEVERS)) {
    const moved = await screens(events);
    assert.ok(fields(diffScreens(blank.x, moved.x)).has(field), `xterm: lever for ${field} did not move it`);
    const oxttyMoved = fields(diffScreens(blank.o, moved.o)).has(field);
    if (OXTTY_CONSTANT.has(field)) assert.ok(!oxttyMoved, `oxtty: ${field} is listed constant but moved`);
    else assert.ok(oxttyMoved, `oxtty: lever for ${field} did not move it`);
  }
});

test('on every lever input xterm and oxtty agree except OXTTY_CONSTANT', async () => {
  for (const [field, events] of Object.entries(LEVERS)) {
    const { x, o } = await screens(events);
    const left = diffScreens(x, o).filter((d) => !OXTTY_CONSTANT.has(d.field));
    assert.deepEqual(left, [], `lever for ${field}`);
  }
});

test('B lever: one byte added to or dropped from the payload is a difference', async () => {
  const c = CASES.find((k) => k.id === 'ansi/8');
  assert.deepEqual(await proveB(c), { kind: 'compared', diffs: [] });
  const added = await proveB(c, (p) => Uint8Array.of(...p, 0x58));
  assert.ok(added.diffs.some((d) => d.field === 'lines.cells.chars'), 'added byte');
  const dropped = await proveB(c, (p) => p.filter((_, i) => i !== p.indexOf(0x77)));
  assert.ok(dropped.diffs.some((d) => d.field === 'lines.cells.chars'), 'dropped byte');
});

// ── 판정 ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {(import('./xterm/screen.mjs').Diff & { step: string })} StepDiff
 * @typedef {{ kind: 'compared', diffs: StepDiff[] } | { kind: 'refused', reason: string }
 *   | { kind: 'inconclusive', why: string }} Outcome
 */

/** 기록한 레코드를 Outcome으로. 쓴 바이트 수가 케이스와 다르거나 줄이 0개면 비교한 것이 아니다. @returns {Outcome} */
function compare(c, written, records) {
  if (written !== c.bytes) return { kind: 'inconclusive', why: `wrote ${written} bytes, case declares ${c.bytes}` };
  const empty = records.find(([, x, o]) => !Object.keys(x.lines).length || !Object.keys(o.lines).length);
  if (empty) return { kind: 'inconclusive', why: `empty screen record at ${empty[0]}` };
  return { kind: 'compared', diffs: records.flatMap(([step, x, o]) => diffScreens(x, o).map((d) => ({ ...d, step }))) };
}

/** @returns {Promise<Outcome>} */
async function proveA(c) {
  const x = xterm(c.cols, c.rows, c.scrollback);
  const o = new Terminal({ cols: c.cols, rows: c.rows, scrollback: c.scrollback });
  try {
    const written = await play(c.input, x, o);
    const records = [['initial', xtermScreen(x), oxttyScreen(o)]];
    await play([c.tail], x, o);
    records.push(['continued', xtermScreen(x), oxttyScreen(o)]);
    if (x.buffer.active.type === 'alternate') {
      await play(['\x1b[?1049lX'], x, o);
      records.push(['returned', xtermScreen(x), oxttyScreen(o)]);
    }
    return compare(c, written, records);
  } finally {
    o.dispose();
    x.dispose();
  }
}

/**
 * 복원 xterm은 원본의 최종 크기로 만든다. edit는 B 레버가 payload를 바꿀 때만 쓴다.
 * @returns {Promise<Outcome>}
 */
async function proveB(c, edit = (payload) => payload) {
  const x = xterm(c.cols, c.rows, c.scrollback);
  const o = new Terminal({ cols: c.cols, rows: c.rows, scrollback: c.scrollback });
  let restored;
  try {
    const written = await play(c.input, x, o);
    const s = o.ansiSnapshot();
    if (!s.ok) return written === c.bytes ? { kind: 'refused', reason: s.reason } : compare(c, written, []);
    restored = xterm(x.cols, x.rows, c.scrollback);
    await play([edit(s.payload)], restored);
    const records = [['initial', xtermScreen(x), xtermScreen(restored)]];
    await play([c.tail], x, restored);
    records.push(['continued', xtermScreen(x), xtermScreen(restored)]);
    if (x.buffer.active.type === 'alternate') {
      await play(['\x1b[?1049lX'], x, restored);
      records.push(['returned', xtermScreen(x), xtermScreen(restored)]);
    }
    return compare(c, written, records);
  } finally {
    restored?.dispose();
    o.dispose();
    x.dispose();
  }
}

const show = (v) => (JSON.stringify(v) ?? 'undefined').slice(0, 60);

/**
 * 순수 판정. 항목 field와 같거나 그 하위('lines'가 'lines.cells.fg'를 덮음)인 diff는 문서화된 것이다.
 * 이 케이스·증명에 걸린 항목은 각각 하나 이상 맞아야 한다(stale 방지).
 * @returns {{ pass: true } | { pass: false, message: string }}
 */
function judge(caseId, proof, outcome, known) {
  if (outcome.kind === 'inconclusive') return { pass: false, message: `inconclusive: ${outcome.why}` };
  const entries = known.filter((e) => e.proofs.includes(proof) && e.cases.includes(caseId));
  if (outcome.kind === 'refused') {
    return entries.some((e) => e.refusal === outcome.reason)
      ? { pass: true }
      : { pass: false, message: `unexpected refusal: ${outcome.reason}` };
  }
  const covers = (e, d) => e.fields?.some((f) => d.field === f || d.field.startsWith(`${f}.`)) ?? false;
  const left = outcome.diffs.filter((d) => !entries.some((e) => covers(e, d)));
  if (left.length) {
    const listed = left.slice(0, 8).map((d) => `${d.step} ${d.path} xterm=${show(d.xterm)} oxtty=${show(d.subject)}`);
    return { pass: false, message: `${left.length} unexpected differences: ${listed.join('; ')}` };
  }
  const stale = entries.filter((e) => !outcome.diffs.some((d) => covers(e, d)));
  if (stale.length) {
    return { pass: false, message: `stale known difference ${stale.map((e) => `"${e.id}"`).join(', ')}: it did not appear — delete or narrow it` };
  }
  return { pass: true };
}

test('judge: undocumented diff, stale entry, unexpected refusal and inconclusive all fail', () => {
  const d = (field) => ({ path: field, field, xterm: 1, subject: 2, step: 'initial' });
  const known = [
    { id: 'k', proofs: ['A'], cases: ['c'], fields: ['lines'], reason: 'r', blocksSwap: false },
    { id: 'r', proofs: ['B'], cases: ['c'], refusal: 'margins', reason: 'r', blocksSwap: false },
  ];
  assert.equal(judge('c', 'A', { kind: 'compared', diffs: [d('lines.cells.fg')] }, known).pass, true);
  assert.match(judge('c', 'A', { kind: 'compared', diffs: [d('lines.cells.fg'), d('cursor.x')] }, known).message, /unexpected differences.*cursor\.x/);
  assert.match(judge('c', 'A', { kind: 'compared', diffs: [] }, known).message, /stale.*"k"/);
  assert.match(judge('other', 'A', { kind: 'compared', diffs: [d('lines')] }, known).message, /unexpected/);
  assert.equal(judge('c', 'B', { kind: 'refused', reason: 'margins' }, known).pass, true);
  assert.match(judge('c', 'B', { kind: 'compared', diffs: [] }, known).message, /stale.*"r"/);
  assert.match(judge('c', 'A', { kind: 'refused', reason: 'margins' }, known).message, /unexpected refusal/);
  assert.equal(judge('other', 'A', { kind: 'compared', diffs: [] }, known).pass, true);
  assert.match(judge('c', 'A', { kind: 'inconclusive', why: 'x' }, known).message, /inconclusive/);
});

test('inconclusive sources: version mismatch, missing corpus, byte count, empty record', async () => {
  assert.match(oracleMismatch({ '@xterm/headless': '6.1.0-beta.303', '@xterm/addon-unicode11': '0.0.0' }), /addon-unicode11/);
  assert.match(corpus('no-such-recording').missing, /recording\.bin is missing/);
  const c = CASES.find((k) => k.id === 'ansi/8');
  assert.equal((await proveA(c)).kind, 'compared');
  assert.match((await proveA({ ...c, bytes: c.bytes + 1 })).why, /wrote \d+ bytes/);
  const blank = { lines: {} };
  assert.match(compare(c, c.bytes, [['initial', blank, blank]]).why, /empty screen/);
});

test('cases: wmux 91 = text 31 + ANSI 60 map onto 85 distinct inputs, ids unique', () => {
  const groups = {};
  for (const c of CASES) {
    const g = c.id.includes('/') ? c.id.slice(0, c.id.indexOf('/')) : c.id;
    groups[g] = (groups[g] ?? 0) + 1;
  }
  for (const [g, n] of Object.entries(WMUX_COUNTS)) assert.equal(groups[g], n, `group ${g}`);
  const { text, ansi, corpus: shared, seed } = WMUX_COUNTS;
  assert.equal(text + shared, 31);
  assert.equal(ansi + shared + seed + WMUX_COUNTS['partial-utf8'], 60);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
});

test('known-differences: every entry has a reason, blocksSwap, real cases and real fields', () => {
  const ids = new Set(CASES.map((c) => c.id));
  const levers = Object.keys(LEVERS);
  for (const e of KNOWN) {
    assert.ok(typeof e.reason === 'string' && e.reason.length > 0, `${e.id}: reason`);
    assert.equal(typeof e.blocksSwap, 'boolean', `${e.id}: blocksSwap`);
    assert.ok(e.proofs.length && e.proofs.every((p) => p === 'A' || p === 'B'), `${e.id}: proofs`);
    assert.ok(e.cases.length && e.cases.every((c) => ids.has(c)), `${e.id}: cases ${e.cases}`);
    assert.ok(!e.fields !== !e.refusal, `${e.id}: exactly one of fields / refusal`);
    for (const f of e.fields ?? []) assert.ok(levers.some((l) => l === f || l.startsWith(`${f}.`)), `${e.id}: field ${f}`);
  }
  assert.equal(new Set(KNOWN.map((e) => e.id)).size, KNOWN.length);
});

test('wmux ANSI 60 = 59 same + seed/14 refused: no other B entry touches them', () => {
  const ansi60 = CASES.filter((c) => /^(ansi|corpus|seed)\/|^partial-utf8$/.test(c.id)).map((c) => c.id);
  assert.equal(ansi60.length, 60);
  // 케이스마다 B 테스트가 항목 없이 통과하면 같음이다. 그래서 여기서는 B 항목이 seed/14 거부 하나뿐임을 고정한다.
  const touching = KNOWN.filter((e) => e.proofs.includes('B') && e.cases.some((id) => ansi60.includes(id)))
    .map((e) => [e.id, e.refusal, e.cases.filter((id) => ansi60.includes(id))]);
  assert.deepEqual(touching, [['resize-seed-14', 'unsupported-wide-edge', ['seed/14']]]);
});

test('swap gate: OXTTY_SWAP_GATE=1 fails while a known difference blocks the engine swap', () => {
  if (process.env.OXTTY_SWAP_GATE !== '1') return;
  const blockers = KNOWN.filter((e) => e.blocksSwap).map((e) => `${e.id} (${e.cases.join(', ')}): ${e.reason}`);
  assert.deepEqual(blockers, [], `${blockers.length} known differences block the swap:\n  ${blockers.join('\n  ')}`);
});

// ── 케이스 × 증명 ────────────────────────────────────────────────────────────────
for (const c of CASES) {
  test(`A ${c.id}`, async () => {
    const why = ORACLE ?? c.missing;
    const outcome = why ? { kind: 'inconclusive', why } : await proveA(c);
    const verdict = judge(c.id, 'A', outcome, KNOWN);
    assert.ok(verdict.pass, verdict.message);
  });
  test(`B ${c.id}`, async () => {
    const why = ORACLE ?? c.missing;
    const outcome = why ? { kind: 'inconclusive', why } : await proveB(c);
    const verdict = judge(c.id, 'B', outcome, KNOWN);
    assert.ok(verdict.pass, verdict.message);
  });
}
