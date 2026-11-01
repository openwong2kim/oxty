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
  /**
   * Called when the engine crashed (a trap in the shared WebAssembly
   * instance) and this terminal started over empty at the same size. The
   * call that hit the crash throws; the terminal works again afterwards.
   */
  onCrash?: (error: Error) => void;
}

export interface Cursor {
  /** Screen line; while scrolled back it is drawn on viewport row `line + displayOffset`. */
  line: number;
  col: number;
  visible: boolean;
  /** Set by the program with DECSCUSR (`CSI Ps SP q`). */
  shape: 'block' | 'underline' | 'bar';
  blink: boolean;
  /** The program chose `shape` and `blink`; when false they are defaults (block, steady) and the host's own style applies. */
  styled: boolean;
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
  /**
   * Lines that have left the top of the scrollback so far (a full history dropping its oldest, ED3, RIS), like
   * xterm.js `onTrim` summed up. History row `-k` is line `trimmedLines + historyLength - k` counted from the first
   * line ever kept, until a resize reflows the history.
   */
  readonly trimmedLines: number;
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
  /** Lets the program use the kitty keyboard protocol (off by default, its sequences ignored); switching drops the flags it pushed. */
  setKittyKeyboard(enabled: boolean): void;
  /** Drops the kitty keyboard flags the program pushed on both screens, keeping the protocol on or off. */
  resetKittyKeyboard(): void;
  /** Active kitty keyboard flags: 1 disambiguate, 2 event types, 4 alternate keys, 8 all keys as escapes, 16 associated text. */
  kittyFlags(): number;
  takeDamage(): Damage;
  /** Bytes to write back to the PTY (status reports, …). */
  takeReplies(): Uint8Array;
  /** New window title, or null if unchanged ("" = reset). */
  takeTitle(): string | null;
  takeBells(): number;
  /** Full resets (RIS, `ESC c`) the program sent since the last call, so the host can drop its own screen state (selection). */
  takeResets(): number;
  /** Lets the program read and/or write the host clipboards with OSC 52 (both off by default). */
  setClipboardAccess(access?: { read?: boolean; write?: boolean }): void;
  /** Oldest text the program asked to copy, or null. */
  takeClipboardWrite(): { selection: 'c' | 'p'; text: string } | null;
  /** Oldest clipboard the program asked to read, or null. Answer it with replyClipboard. */
  takeClipboardRead(): 'c' | 'p' | null;
  /** Answers the oldest read of `selection`; the reply joins takeReplies(). False if none is waiting. */
  replyClipboard(selection: 'c' | 'p', text: string): boolean;
  /** Colours (0xRRGGBB, COLOR_SLOTS of them: palette 0–255, foreground, background, cursor) that answer OSC 4/10/11/12 queries; null stops answering. */
  setColors(colors: ArrayLike<number> | null): void;
  syncPending(): boolean;
  flushSync(): void;
  /** Does not change the terminal, so it is safe while a renderer draws it; two calls give the same bytes. */
  ansiSnapshot(): AnsiSnapshot;
  dispose(): void;
}

/** Entries `setColors` takes: palette 0–255, then foreground, background, cursor. */
export declare const COLOR_SLOTS: 259;
export declare const Attr: Readonly<{
  BOLD: number; DIM: number; ITALIC: number; UNDERLINE: number;
  DOUBLE_UNDERLINE: number; CURLY_UNDERLINE: number; DOTTED_UNDERLINE: number; DASHED_UNDERLINE: number;
  INVERSE: number; HIDDEN: number; STRIKEOUT: number; BLINK: number;
  WIDE: number; WIDE_SPACER: number; COMBINING: number; UNDERLINE_COLOR: number; HYPERLINK: number;
  /** Blank end of a wrapped row whose wide character moved to the next row; not text. */
  LEADING_WIDE_SPACER: number;
}>;

export declare const Mode: Readonly<{
  SHOW_CURSOR: number; APP_CURSOR: number; APP_KEYPAD: number; BRACKETED_PASTE: number;
  MOUSE_CLICK: number; MOUSE_DRAG: number; MOUSE_MOTION: number; SGR_MOUSE: number;
  FOCUS_EVENTS: number; ALT_SCREEN: number; ALTERNATE_SCROLL: number; LINE_WRAP: number;
  INSERT: number; ORIGIN: number; KITTY_KEYBOARD: number; MOUSE_X10: number; SGR_PIXELS_MOUSE: number;
}>;

export declare const ColorKind: Readonly<{ NAMED: 1; INDEXED: 2; RGB: 3 }>;

/** Named: 0–15 ANSI, 256 default fg, 257 default bg. Indexed: 0–255. RGB: 0xRRGGBB. */
export function decodeColor(packed: number): { kind: 'named' | 'indexed' | 'rgb'; value: number };
