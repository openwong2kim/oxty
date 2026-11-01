// 화면 레코드: "같은 화면"의 정의. xterm 쪽과 oxtty 쪽이 각자 이 모양을 만들고 diffScreens 하나로 비교한다.
//
// 정규화 규칙(여기 한 곳에만 있다)
// - 줄 키는 아래(화면) 기준: 화면 "0".."rows-1", 히스토리 "-1"(최신)…. 히스토리 길이가 달라도 화면 줄끼리 비교된다.
// - wrapped는 xterm 의미("앞줄이 이 줄로 이어졌다"). 가장 오래된 줄은 앞줄이 없으므로 양쪽 모두 false.
// - 문자: 빈칸 ' ', 와이드 문자의 뒷칸 ''. 결합 문자는 문자열 전체로 비교한다.
// - 커서 x는 cols-1로 자른다(xterm은 pending wrap에서 cols). pending wrap은 케이스 tail의 첫 출력 문자로 드러난다.
//   커서 모양·깜빡임은 넣지 않는다: xterm 공개 API에 없다(oxtty는 엔진 테스트 cursor_shape_follows_decscusr가 고정).
// - 색: 'default' 또는 (모드 | 값). xterm CM_P16/P256/RGB 비트 == oxtty NAMED/INDEXED/RGB 비트.
// - 밑줄은 getUnderlineStyle()(isUnderline()은 OSC 8 링크에서 true). 밑줄 색은 밑줄이 있을 때만, SGR 58이 없으면 'default'.
// - oxtty가 모델링하지 않는 필드는 상수다(OXTTY_CONSTANT). 그 필드가 xterm에서 켜지면 차이로 드러난다.
// - oxtty 동기화 출력: 읽기 전에 flushSync()한다. xterm은 ?2026 중에도 버퍼에 바로 반영하기 때문이다.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import xtermHeadless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { Attr, Mode } from '../../dist/index.js';

const { Terminal: XTerminal } = xtermHeadless;
const { Unicode11Addon } = unicode11;
const encoder = new TextEncoder();

/**
 * @typedef {'default' | number} Color
 * @typedef {{ chars: string, width: number, fg: Color, bg: Color, bold: boolean, dim: boolean, italic: boolean,
 *   underline: number, underlineColor: Color | null, blink: boolean, inverse: boolean,
 *   invisible: boolean, strikethrough: boolean, overline: boolean }} Cell
 * @typedef {{ wrapped: boolean, cells: Cell[] }} Line
 * @typedef {{
 *   cols: number, rows: number, buffer: string, baseY: number,
 *   cursor: { x: number, y: number, visible: boolean },
 *   modes: { applicationCursorKeys: boolean, applicationKeypad: boolean, bracketedPaste: boolean, insert: boolean,
 *     mouseTracking: string, origin: boolean, sendFocus: boolean, wraparound: boolean,
 *     reverseWraparound: boolean, synchronizedOutput: boolean },
 *   lines: Record<string, Line>,
 * }} Screen
 *   win32InputMode는 넣지 않는다: 이 설정의 xterm에서 ?9001h로 켜지지 않아 레버를 만들 수 없다.
 * @typedef {{ path: string, field: string, xterm: unknown, subject: unknown }} Diff
 *   path 예 "lines[-3].cells[4].fg", field는 path에서 [..]를 뺀 것 "lines.cells.fg"
 * @typedef {Uint8Array | { cols: number, rows: number }} Event   write 또는 resize
 */

/** wmux snapshotTestTerminal과 같은 설정. reflowCursorLine은 기본값(false) 그대로 둔다. */
export function xterm(cols, rows, scrollback) {
  const t = new XTerminal({
    cols, rows, scrollback, allowProposedApi: true, logLevel: 'off',
    vtExtensions: { colorSchemeQuery: false, kittySgrBoldFaintControl: false },
  });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}

/** 설치된 기준 xterm이 package.json 고정 버전과 다르면 이유를, 같으면 null. */
export function oracleMismatch(
  pinned = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).devDependencies,
) {
  const require = createRequire(import.meta.url);
  for (const name of ['@xterm/headless', '@xterm/addon-unicode11']) {
    const installed = require(`${name}/package.json`).version;
    if (installed !== pinned[name]) return `${name} ${installed} installed, package.json pins ${pinned[name]}`;
  }
  return null;
}

/**
 * 이벤트를 순서대로 모든 터미널에 적용하고 쓴 바이트 수를 돌려준다.
 * xterm에는 항상 바이트로 쓴다: 문자열로 이어 쓰면 미완 UTF-8 상태가 사라진다.
 * @param {(Event | string)[]} events
 */
export async function play(events, ...terms) {
  let written = 0;
  for (const e of events) {
    if (typeof e === 'string' || e instanceof Uint8Array) {
      const bytes = typeof e === 'string' ? encoder.encode(e) : e;
      for (const t of terms) {
        if (t instanceof XTerminal) await new Promise((resolve) => t.write(bytes, resolve));
        else t.write(bytes);
      }
      written += bytes.length;
    } else {
      for (const t of terms) t.resize(e.cols, e.rows);
    }
  }
  return written;
}

const xcolor = (mode, value) => (mode === 0 ? 'default' : (mode | value) >>> 0);
const DEFAULT_FG = (1 << 24) | 256;
const DEFAULT_BG = (1 << 24) | 257;
const ocolor = (packed, def) => (packed === def ? 'default' : packed >>> 0);

/** 줄 키를 아래 기준으로 매긴다. oldest는 가장 오래된 줄의 키. */
function keyed(count, rows, line) {
  const lines = {};
  for (let i = 0; i < count; i++) lines[i - (count - rows)] = line(i - (count - rows), i === 0);
  return lines;
}

/** @returns {Screen} */
export function xtermScreen(t) {
  const b = t.buffer.active;
  const m = t.modes;
  return {
    cols: t.cols, rows: t.rows, buffer: b.type, baseY: b.baseY,
    cursor: { x: Math.min(b.cursorX, t.cols - 1), y: b.cursorY, visible: m.showCursor },
    modes: {
      applicationCursorKeys: m.applicationCursorKeysMode, applicationKeypad: m.applicationKeypadMode,
      bracketedPaste: m.bracketedPasteMode, insert: m.insertMode, mouseTracking: m.mouseTrackingMode,
      origin: m.originMode, sendFocus: m.sendFocusMode, wraparound: m.wraparoundMode,
      reverseWraparound: m.reverseWraparoundMode, synchronizedOutput: m.synchronizedOutputMode,
    },
    lines: keyed(b.length, t.rows, (y, oldest) => {
      const l = b.getLine(b.baseY + y);
      const cells = [];
      for (let x = 0; x < t.cols; x++) {
        const c = l.getCell(x);
        const width = c.getWidth();
        const underline = c.getUnderlineStyle();
        cells.push({
          chars: width === 0 ? '' : c.getChars() || ' ', width,
          fg: xcolor(c.getFgColorMode(), c.getFgColor()), bg: xcolor(c.getBgColorMode(), c.getBgColor()),
          bold: !!c.isBold(), dim: !!c.isDim(), italic: !!c.isItalic(), underline,
          underlineColor: underline ? xcolor(c.getUnderlineColorMode(), c.getUnderlineColor()) : null,
          blink: !!c.isBlink(), inverse: !!c.isInverse(), invisible: !!c.isInvisible(),
          strikethrough: !!c.isStrikethrough(), overline: !!c.isOverline(),
        });
      }
      return { wrapped: !oldest && l.isWrapped, cells };
    }),
  };
}

const UNDERLINES = [
  [Attr.UNDERLINE, 1], [Attr.DOUBLE_UNDERLINE, 2], [Attr.CURLY_UNDERLINE, 3],
  [Attr.DOTTED_UNDERLINE, 4], [Attr.DASHED_UNDERLINE, 5],
];
const mouse = (m) => (m & Mode.MOUSE_MOTION ? 'any' : m & Mode.MOUSE_DRAG ? 'drag' : m & Mode.MOUSE_CLICK ? 'vt200' : 'none');

/** @returns {Screen} oxtty 공개 API만 쓴다. 부수 효과: 잡혀 있던 동기화 출력을 적용한다(위 규칙). */
export function oxttyScreen(t) {
  const synchronizedOutput = t.syncPending();
  t.flushSync();
  const history = t.historyLength;
  const c = t.cursor();
  const m = t.modes();
  return {
    cols: t.cols, rows: t.rows, buffer: m & Mode.ALT_SCREEN ? 'alternate' : 'normal', baseY: history,
    cursor: { x: c.col, y: c.line, visible: c.visible },
    modes: {
      applicationCursorKeys: !!(m & Mode.APP_CURSOR), applicationKeypad: !!(m & Mode.APP_KEYPAD),
      bracketedPaste: !!(m & Mode.BRACKETED_PASTE), insert: !!(m & Mode.INSERT), mouseTracking: mouse(m),
      origin: !!(m & Mode.ORIGIN), sendFocus: !!(m & Mode.FOCUS_EVENTS), wraparound: !!(m & Mode.LINE_WRAP),
      reverseWraparound: false, synchronizedOutput,
    },
    lines: keyed(history + t.rows, t.rows, (y, oldest) => {
      const words = t.rowCells(y);
      const extras = new Map(t.rowExtras(y).map((e) => [e.col, e]));
      const cells = [];
      for (let x = 0; x < t.cols; x++) {
        const [ch, fg, bg, a] = words.subarray(x * 4, x * 4 + 4);
        const e = extras.get(x);
        const width = a & Attr.WIDE_SPACER ? 0 : a & Attr.WIDE ? 2 : 1;
        const underline = UNDERLINES.find(([bit]) => a & bit)?.[1] ?? 0;
        cells.push({
          chars: width === 0 ? '' : e?.text ?? String.fromCodePoint(ch), width,
          fg: ocolor(fg, DEFAULT_FG), bg: ocolor(bg, DEFAULT_BG),
          bold: !!(a & Attr.BOLD), dim: !!(a & Attr.DIM), italic: !!(a & Attr.ITALIC), underline,
          underlineColor: underline ? e?.underlineColor ?? 'default' : null,
          blink: !!(a & Attr.BLINK), inverse: !!(a & Attr.INVERSE), invisible: !!(a & Attr.HIDDEN),
          strikethrough: !!(a & Attr.STRIKEOUT), overline: false,
        });
      }
      return { wrapped: !oldest && t.rowWrapped(y - 1), cells };
    }),
  };
}

/** oxtty가 상수로 내는 필드. 레버 테스트가 "이것만 상수"임을 강제한다. */
export const OXTTY_CONSTANT = new Set([
  'lines.cells.overline', // SGR 53: oxtty 셀에 비트가 없다
  'modes.reverseWraparound', // ?45 미지원
]);

/** 모든 비교 필드 → 그 필드를 20x6 빈 화면에서 바꾸는 입력. 필드가 늘면 레버도 늘어야 테스트가 통과한다. */
export const LEVERS = {
  cols: [{ cols: 21, rows: 6 }], rows: [{ cols: 20, rows: 7 }],
  buffer: ['\x1b[?1049h'], baseY: ['\r\n'.repeat(6)],
  lines: ['\r\n'.repeat(6)], 'lines.cells': [{ cols: 21, rows: 6 }],
  'cursor.x': ['X'], 'cursor.y': ['\n'], 'cursor.visible': ['\x1b[?25l'],
  'lines.wrapped': ['X'.repeat(21)],
  'lines.cells.chars': ['X'], 'lines.cells.width': ['한'],
  'lines.cells.fg': ['\x1b[31mX'], 'lines.cells.bg': ['\x1b[41mX'],
  'lines.cells.bold': ['\x1b[1mX'], 'lines.cells.dim': ['\x1b[2mX'], 'lines.cells.italic': ['\x1b[3mX'],
  // 밑줄 레버에 fg를 같이 켠다: SGR 58 없는 밑줄 색이 'default'인지(fg로 대체하지 않는지)를 여기서 고정한다.
  'lines.cells.underline': ['\x1b[31;4:3mX'], 'lines.cells.underlineColor': ['\x1b[4;58;5;1mX'],
  'lines.cells.blink': ['\x1b[5mX'], 'lines.cells.inverse': ['\x1b[7mX'], 'lines.cells.invisible': ['\x1b[8mX'],
  'lines.cells.strikethrough': ['\x1b[9mX'], 'lines.cells.overline': ['\x1b[53mX'],
  'modes.applicationCursorKeys': ['\x1b[?1h'], 'modes.applicationKeypad': ['\x1b='],
  'modes.bracketedPaste': ['\x1b[?2004h'], 'modes.insert': ['\x1b[4h'], 'modes.mouseTracking': ['\x1b[?1000h'],
  'modes.origin': ['\x1b[?6h'], 'modes.sendFocus': ['\x1b[?1004h'], 'modes.wraparound': ['\x1b[?7l'],
  'modes.reverseWraparound': ['\x1b[?45h'], 'modes.synchronizedOutput': ['\x1b[?2026h'],
};

// 숫자 키(줄 번호·셀 인덱스)는 데이터가 정하는 키라 path에 [k]로 쓰고 field에서는 뺀다.
const isIndex = (k) => /^-?\d+$/.test(k);
const step = (path, k) => (isIndex(k) ? `${path}[${k}]` : path ? `${path}.${k}` : k);
const fieldOf = (path) => path.replace(/\[-?\d+\]/g, '');

/** 깊은 비교. 한쪽에만 있는 키는 그 키 자리에서 없는 쪽을 undefined로 보고한다. @returns {Diff[]} */
export function diffScreens(xtermSide, subjectSide, path = '', out = []) {
  if (typeof xtermSide === 'object' && xtermSide && typeof subjectSide === 'object' && subjectSide) {
    for (const k of new Set([...Object.keys(xtermSide), ...Object.keys(subjectSide)])) {
      const p = step(path, k);
      if (!(k in xtermSide) || !(k in subjectSide)) {
        out.push({ path: p, field: fieldOf(p), xterm: xtermSide[k], subject: subjectSide[k] });
      } else {
        diffScreens(xtermSide[k], subjectSide[k], p, out);
      }
    }
  } else if (xtermSide !== subjectSide) {
    out.push({ path, field: fieldOf(path), xterm: xtermSide, subject: subjectSide });
  }
  return out;
}

/** diffScreens가 낼 수 있는 모든 field: 값 필드와, 키가 데이터인 컨테이너(lines, lines.cells). */
export function fieldsOf(screen, path = '', out = new Set()) {
  if (typeof screen !== 'object' || screen === null) return out.add(path);
  const keys = Object.keys(screen);
  if (keys.length && keys.every(isIndex)) {
    out.add(path);
    for (const k of keys) fieldsOf(screen[k], path, out);
  } else {
    for (const k of keys) fieldsOf(screen[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}
