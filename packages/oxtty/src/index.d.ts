/** Loads the WebAssembly module once. Defaults to the bundled `oxtty.wasm`. */
export function init(
  source?: URL | string | ArrayBuffer | ArrayBufferView | WebAssembly.Module | Response,
): Promise<void>;

export interface TerminalOptions {
  cols?: number;
  rows?: number;
  /** Lines of history to keep (default 1000, max 100000). */
  scrollback?: number;
  /** Flush a synchronized update the program never ended after this many ms (default 150). */
  syncTimeoutMs?: number;
  /** Called after such a timed flush, so the renderer can redraw. */
  onSyncFlush?: () => void;
}

export interface Cursor {
  /** Screen line; while scrolled back it is drawn on viewport row `line + displayOffset`. */
  line: number;
  col: number;
  visible: boolean;
  /** Set by the program with DECSCUSR (`CSI Ps SP q`). */
  shape: 'block' | 'underline' | 'bar';
  blink: boolean;
}

export interface Damage {
  /** Redraw everything; `scroll` is 0 and `lines` is empty. */
  full: boolean;
  /** Move drawn rows up by this many first (the top ones fall off). */
  scroll: number;
  /** Viewport rows to redraw after scrolling, top to bottom. */
  lines: number[];
}

export interface Hyperlink {
  /** Shared by every cell of one link (generated when the program gave none). */
  id: string;
  uri: string;
}

/** What a cell carries beyond `rowCells`. */
export interface CellExtra {
  col: number;
  /** Full cell text when it has combining marks. */
  text?: string;
  /** Underline colour (SGR 58), packed like `rowCells` colours. */
  underlineColor?: number;
  /** OSC 8 hyperlink; cells of one link share the same object. */
  hyperlink?: Hyperlink;
}

/**
 * `payload` written to a fresh xterm.js of the same size and scrollback
 * rebuilds this screen; it ends with the unfinished escape sequence or UTF-8
 * character the output stopped in. During a synchronized update it is the
 * screen from before the update, then `CSI ? 2026 h` and the held output raw.
 * On refusal replay the raw output instead.
 */
export type AnsiSnapshot =
  | { ok: true; payload: Uint8Array }
  /** `"unsupported-wide-edge"`, `"margins"` or `"partial-tail-overflow"`. */
  | { ok: false; reason: string };

export class Terminal {
  constructor(options?: TerminalOptions);
  /** Feeds program output. Strings are encoded as UTF-8. */
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  readonly cols: number;
  readonly rows: number;
  /** Scrollback lines; address them as rows -1 (newest) … -historyLength (oldest). */
  readonly historyLength: number;
  rowText(line: number): string | null;
  /** `[codepoint, fg, bg, attrs]` per cell. */
  rowCells(line: number): Uint32Array | null;
  /**
   * Like `rowCells`, but a view into WebAssembly memory instead of a copy:
   * valid only until the next call into any terminal. For renderers that read
   * every visible row each frame.
   */
  rowCellsView(line: number): Uint32Array | null;
  rowWrapped(line: number): boolean;
  /** Cell text including combining marks. */
  cellText(line: number, col: number): string | null;
  /** Cells with combining marks, an underline colour or a hyperlink (see `Attr`). */
  rowExtras(line: number): CellExtra[] | null;
  cursor(): Cursor;
  /** Rows the view is scrolled back into history (0 = following output). Viewport row `y` is line `y - displayOffset`. */
  readonly displayOffset: number;
  /** Positive `delta` scrolls back into history; clamped. Damage becomes full when the view moves. */
  scrollDisplay(delta: number): void;
  scrollToBottom(): void;
  /** Bitwise OR of {@link Mode} values. */
  modes(): number;
  takeDamage(): Damage;
  /** Bytes to write back to the PTY (status reports, …). */
  takeReplies(): Uint8Array;
  /** New window title, or null if unchanged ("" = reset). */
  takeTitle(): string | null;
  takeBells(): number;
  syncPending(): boolean;
  flushSync(): void;
  /** Does not change the terminal, so it is safe while a renderer draws it; two calls give the same bytes. */
  ansiSnapshot(): AnsiSnapshot;
  dispose(): void;
}

export declare const Attr: Readonly<{
  BOLD: number; DIM: number; ITALIC: number; UNDERLINE: number;
  DOUBLE_UNDERLINE: number; CURLY_UNDERLINE: number; DOTTED_UNDERLINE: number; DASHED_UNDERLINE: number;
  INVERSE: number; HIDDEN: number; STRIKEOUT: number; BLINK: number;
  WIDE: number; WIDE_SPACER: number; COMBINING: number; UNDERLINE_COLOR: number; HYPERLINK: number;
}>;

export declare const Mode: Readonly<{
  SHOW_CURSOR: number; APP_CURSOR: number; APP_KEYPAD: number; BRACKETED_PASTE: number;
  MOUSE_CLICK: number; MOUSE_DRAG: number; MOUSE_MOTION: number; SGR_MOUSE: number;
  FOCUS_EVENTS: number; ALT_SCREEN: number; ALTERNATE_SCROLL: number; LINE_WRAP: number;
  INSERT: number; ORIGIN: number; KITTY_KEYBOARD: number;
}>;

export declare const ColorKind: Readonly<{ NAMED: 1; INDEXED: 2; RGB: 3 }>;

/** Named: 0–15 ANSI, 256 default fg, 257 default bg. Indexed: 0–255. RGB: 0xRRGGBB. */
export function decodeColor(packed: number): { kind: 'named' | 'indexed' | 'rgb'; value: number };
