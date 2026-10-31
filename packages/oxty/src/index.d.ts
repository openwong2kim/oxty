/** Loads the WebAssembly module once. Defaults to the bundled `oxty.wasm`. */
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
  line: number;
  col: number;
  visible: boolean;
}

export interface Damage {
  /** Redraw everything; `lines` is empty. */
  full: boolean;
  /** Visible rows that changed, top to bottom. */
  lines: number[];
}

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
  rowWrapped(line: number): boolean;
  /** Cell text including combining marks. */
  cellText(line: number, col: number): string | null;
  cursor(): Cursor;
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
  dispose(): void;
}

export declare const Attr: Readonly<{
  BOLD: number; DIM: number; ITALIC: number; UNDERLINE: number;
  DOUBLE_UNDERLINE: number; CURLY_UNDERLINE: number; DOTTED_UNDERLINE: number; DASHED_UNDERLINE: number;
  INVERSE: number; HIDDEN: number; STRIKEOUT: number; BLINK: number;
  WIDE: number; WIDE_SPACER: number; COMBINING: number;
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
