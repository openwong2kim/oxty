// The one boundary between the engine and everything drawn or typed on the page (PRD D7).
// The renderer, input and selection read only `Events`, `Frame` and `Viewport`, never the engine itself, so the
// engine can later move to a Web Worker and these become messages. Only `buffer.active.getLine()`, search and
// serialize call the engine directly (a Worker build needs a mirror on the main thread for those).
import type { CellExtra, Cursor, Terminal as Engine } from '../../src/index.js';

/** What the program asked of the host since the last call. Taken after every write drain, not per frame, so replies flow while the page is hidden. */
export interface Events {
  /** Bytes for the PTY (status reports, OSC 52 and colour query answers): `onData`. */
  replies: Uint8Array;
  /** New title, or null if unchanged: `onTitleChange`. */
  title: string | null;
  bells: number;
  clipboardWrites: { selection: 'c' | 'p'; text: string }[];
  clipboardReads: ('c' | 'p')[];
}

/** Everything a renderer needs to bring its picture up to date. */
export interface Frame {
  cols: number;
  rows: number;
  /** The picture must be rebuilt (resize, view scroll, engine crash): every row is in `lines`. */
  full: boolean;
  /** Viewport rows whose cells changed, ascending. Row `lines[k]` is `cells[k * cols * 4 …]`. */
  lines: number[];
  /** `[codepoint, fg, bg, attrs]` per cell for `lines`; reused between frames. */
  cells: Uint32Array;
  /** Extras of the rows in `lines` that have any. */
  extras: Map<number, CellExtra[]>;
  /** Cursor in viewport rows; `visible` is false while it is scrolled out of view. */
  cursor: Cursor;
  displayOffset: number;
  historyLength: number;
  /** Bitwise OR of `Mode`; input encoding reads it from here (one frame late in a Worker build). */
  modes: number;
}

export interface EngineView {
  takeEvents(): Events;
  takeFrame(): Frame;
}

const ATTR_COMBINING = 1 << 14;
const ATTR_UNDERLINE_COLOR = 1 << 15;
const ATTR_HYPERLINK = 1 << 16;
const ATTR_EXTRAS = ATTR_COMBINING | ATTR_UNDERLINE_COLOR | ATTR_HYPERLINK;

/** `EngineView` over an engine on the same thread. */
export class LocalEngineView implements EngineView {
  private _cells = new Uint32Array(0);
  private _full = true;

  constructor(private readonly _engine: Engine) {}

  /** The next frame rebuilds everything (after an engine crash or a renderer restart). */
  public invalidate(): void {
    this._full = true;
  }

  public takeEvents(): Events {
    const e = this._engine;
    const events: Events = { replies: e.takeReplies(), title: e.takeTitle(), bells: e.takeBells(), clipboardWrites: [], clipboardReads: [] };
    for (let w; (w = e.takeClipboardWrite());) events.clipboardWrites.push(w);
    for (let r; (r = e.takeClipboardRead());) events.clipboardReads.push(r);
    return events;
  }

  public takeFrame(): Frame {
    const e = this._engine;
    const { cols, rows, displayOffset } = e;
    const damage = e.takeDamage();
    const full = this._full || damage.full || damage.scroll > 0;
    this._full = false;
    const lines = full ? Array.from({ length: rows }, (_, y) => y) : damage.lines.filter(y => y < rows);
    const stride = cols * 4;
    if (this._cells.length < lines.length * stride) this._cells = new Uint32Array(rows * stride);
    const extras = new Map<number, CellExtra[]>();
    lines.forEach((y, k) => {
      const line = y - displayOffset;
      const view = e.rowCellsView(line);
      if (!view) {
        this._cells.fill(0, k * stride, (k + 1) * stride);
        return;
      }
      this._cells.set(view.subarray(0, stride), k * stride);
      for (let o = 3; o < stride; o += 4) {
        if (view[o] & ATTR_EXTRAS) {
          extras.set(y, e.rowExtras(line) ?? []);
          break;
        }
      }
    });
    const cursor = e.cursor();
    cursor.line += displayOffset;
    if (cursor.line >= rows) cursor.visible = false;
    return { cols, rows, full, lines, cells: this._cells, extras, cursor, displayOffset, historyLength: e.historyLength, modes: e.modes() };
  }
}

/**
 * The visible rows as of the last frame. The renderer redraws from here when the host changes something the
 * engine does not know about (selection, cursor blink, theme), and selection reads visible text from it.
 */
export class Viewport {
  public cols = 0;
  public rows = 0;
  public cells = new Uint32Array(0);
  public extras = new Map<number, CellExtra[]>();
  public cursor: Cursor = { line: 0, col: 0, visible: false, shape: 'block', blink: false };
  public displayOffset = 0;
  public historyLength = 0;
  public modes = 0;

  /** Copies a frame in and returns the rows that changed (all of them when `frame.full`). */
  public apply(frame: Frame): number[] {
    const stride = frame.cols * 4;
    if (frame.cols !== this.cols || frame.rows !== this.rows) {
      this.cols = frame.cols;
      this.rows = frame.rows;
      this.cells = new Uint32Array(frame.rows * stride);
      this.extras.clear();
    }
    if (frame.full) this.extras.clear();
    frame.lines.forEach((y, k) => {
      this.cells.set(frame.cells.subarray(k * stride, (k + 1) * stride), y * stride);
      const extras = frame.extras.get(y);
      if (extras) this.extras.set(y, extras);
      else this.extras.delete(y);
    });
    this.cursor = frame.cursor;
    this.displayOffset = frame.displayOffset;
    this.historyLength = frame.historyLength;
    this.modes = frame.modes;
    return frame.lines;
  }

  /** `[codepoint, fg, bg, attrs]` per cell of viewport row `y` (a view, not a copy). */
  public row(y: number): Uint32Array {
    const stride = this.cols * 4;
    return this.cells.subarray(y * stride, (y + 1) * stride);
  }
}
