// xterm.js `terminal.buffer`, read straight from the engine (PRD D7 lets the buffer API do that). Lines are
// numbered like xterm.js: 0 is the oldest scrollback line, `baseY` the top of the screen.
import { Attr, Mode, type Terminal as Engine } from '../../src/index.js';
import { Emitter } from 'vs/base/common/event';

export class BufferCell {
  constructor(
    /** Cell text ('' for the right half of a wide character). */
    private readonly _chars: string,
    private readonly _width: number,
    private readonly _attrs: number,
  ) {}

  public getChars(): string { return this._chars; }
  public getCode(): number { return this._chars.codePointAt(0) ?? 0; }
  public getWidth(): number { return this._width; }
  public isBold(): number { return this._attrs & Attr.BOLD; }
  public isDim(): number { return this._attrs & Attr.DIM; }
  public isItalic(): number { return this._attrs & Attr.ITALIC; }
  public isUnderline(): number {
    return this._attrs & (Attr.UNDERLINE | Attr.DOUBLE_UNDERLINE | Attr.CURLY_UNDERLINE | Attr.DOTTED_UNDERLINE | Attr.DASHED_UNDERLINE);
  }
  public isBlink(): number { return this._attrs & Attr.BLINK; }
  public isInverse(): number { return this._attrs & Attr.INVERSE; }
  public isInvisible(): number { return this._attrs & Attr.HIDDEN; }
  public isStrikethrough(): number { return this._attrs & Attr.STRIKEOUT; }
}

const NULL_CELL = new BufferCell('', 1, 0);

/** A copy of one line taken when `getLine` was called (xterm.js hands out a live view). */
export class BufferLine {
  private readonly _chars: string[] = [];

  constructor(
    private readonly _cells: Uint32Array,
    extras: { col: number; text?: string }[],
    public readonly isWrapped: boolean,
  ) {
    for (let x = 0; x * 4 < _cells.length; x++) {
      const attrs = _cells[x * 4 + 3];
      this._chars.push(attrs & Attr.WIDE_SPACER ? '' : String.fromCodePoint(_cells[x * 4] || 32));
    }
    for (const e of extras) if (e.text !== undefined) this._chars[e.col] = e.text;
  }

  public get length(): number {
    return this._chars.length;
  }

  /** Returns a new cell; `cell` is accepted for xterm.js compatibility and not reused. */
  public getCell(x: number, cell?: BufferCell): BufferCell | undefined {
    if (x < 0 || x >= this.length) return undefined;
    const attrs = this._cells[x * 4 + 3];
    return new BufferCell(this._chars[x], attrs & Attr.WIDE ? 2 : attrs & Attr.WIDE_SPACER ? 0 : 1, attrs);
  }

  /**
   * Like xterm.js: blank cells are spaces, a wide character covers two columns, and a range that starts on
   * the right half of one gets a space there. Unlike xterm.js, the engine does not tell typed spaces from
   * erased cells, so `trimRight` drops trailing typed spaces too.
   */
  public translateToString(trimRight = false, startColumn = 0, endColumn = this.length): string {
    if (trimRight) {
      let end = this.length;
      while (end > 0 && (this._chars[end - 1] === ' ' || this._chars[end - 1] === '')) end--;
      // Keep the right half of a wide character that ends the text.
      if (end > 0 && this._chars[end] === '') end++;
      endColumn = Math.min(endColumn, end);
    }
    let text = '';
    for (let x = startColumn; x < endColumn; x += this._cells[x * 4 + 3] & Attr.WIDE ? 2 : 1) text += this._chars[x] || ' ';
    return text;
  }
}

export class Buffer {
  constructor(private readonly _engine: Engine) {}

  public get type(): 'normal' | 'alternate' {
    return this._engine.modes() & Mode.ALT_SCREEN ? 'alternate' : 'normal';
  }
  public get cursorX(): number { return this._engine.cursor().col; }
  public get cursorY(): number { return this._engine.cursor().line; }
  public get baseY(): number { return this._engine.historyLength; }
  public get viewportY(): number { return this._engine.historyLength - this._engine.displayOffset; }
  public get length(): number { return this._engine.historyLength + this._engine.rows; }

  public getLine(y: number): BufferLine | undefined {
    const e = this._engine;
    const line = y - e.historyLength;
    const cells = e.rowCells(line);
    if (!cells) return undefined;
    // Engine rows carry "wraps into the next row"; xterm.js lines carry "continues the previous one".
    return new BufferLine(cells, e.rowExtras(line) ?? [], y > 0 && e.rowWrapped(line - 1));
  }

  public getNullCell(): BufferCell {
    return NULL_CELL;
  }
}

export class BufferNamespace {
  public readonly active: Buffer;
  public readonly _onBufferChange = new Emitter<Buffer>();
  public readonly onBufferChange = this._onBufferChange.event;

  constructor(engine: Engine) {
    this.active = new Buffer(engine);
  }
}
