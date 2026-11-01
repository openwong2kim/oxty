// Public types of `oxtty/xterm`: the part of the xterm.js 6 API that oxtty implements, under the same names.
// A member that is not here is not implemented, so TypeScript reports it at compile time. What is planned and
// what is not: xterm/test/api-checklist.json in the repository.

/** Loads the engine's WebAssembly module. `await init()` once before creating terminals. */
export function init(source?: URL | string | ArrayBuffer | ArrayBufferView | WebAssembly.Module | Response): Promise<void>;

export interface IDisposable {
  dispose(): void;
}

export interface IEvent<T, U = void> {
  (listener: (arg1: T, arg2: U) => any): IDisposable;
}

/** Colours as CSS strings; unset entries keep the xterm.js defaults. */
export interface ITheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
  /** Palette entries 16–255. */
  extendedAnsi?: string[];
}

/** oxtty option: host clipboard access for programs (OSC 52). Without a handler the request is ignored. */
export interface IClipboardHandler {
  /** The program copies `text` to the clipboard (`'c'`) or primary selection (`'p'`). */
  write?(text: string, selection: 'c' | 'p'): void;
  /** The program reads the clipboard. A rejected or thrown read answers it with an empty clipboard. */
  read?(selection: 'c' | 'p'): string | Promise<string>;
}

export interface ITerminalInitOnlyOptions {
  /** Default 80. Change it later with `resize`. */
  cols?: number;
  /** Default 24. Change it later with `resize`. */
  rows?: number;
  /** Lines of history (default 1000). Unlike xterm.js it cannot change after construction. */
  scrollback?: number;
}

export interface ITerminalOptions {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: FontWeight;
  fontWeightBold?: FontWeight;
  lineHeight?: number;
  letterSpacing?: number;
  /** Also the colours OSC 4/10/11/12 queries are answered with. */
  theme?: ITheme;
  drawBoldTextInBrightColors?: boolean;
  minimumContrastRatio?: number;
  customGlyphs?: boolean;
  allowTransparency?: boolean;
  rescaleOverlappingGlyphs?: boolean;
  cursorBlink?: boolean;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorWidth?: number;
  cursorInactiveStyle?: 'outline' | 'block' | 'bar' | 'underline' | 'none';
  /** Only the width the fit keeps free for a scrollbar (14 by default, 0 without scrollback) so far. */
  scrollbar?: { showScrollbar?: boolean; width?: number };
  /** Accepted for xterm.js compatibility; oxtty has no proposed API gate. */
  allowProposedApi?: boolean;
  /** oxtty: OSC 52 clipboard access. */
  clipboard?: IClipboardHandler;
  /** macOS: Option sends ESC-prefixed keys instead of composing characters (default false). */
  macOptionIsMeta?: boolean;
  /** Keys, IME and paste scroll a scrolled-back view to the bottom (default true). */
  scrollOnUserInput?: boolean;
  /** Drops all input, and the replies to the program, like xterm.js (default false). */
  disableStdin?: boolean;
  /** `kittyKeyboard`: the program may push kitty keyboard flags (`CSI > flags u`), and keys are then encoded that way. */
  vtExtensions?: { kittyKeyboard?: boolean };
}

export type FontWeight = 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | number;

export interface IModes {
  readonly applicationCursorKeysMode: boolean;
  readonly applicationKeypadMode: boolean;
  readonly bracketedPasteMode: boolean;
  readonly insertMode: boolean;
  /** Never `'x10'`: the engine does not track X10 mouse mode (`CSI ? 9 h`). */
  readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  readonly originMode: boolean;
  /** Always false: oxtty has no reverse wraparound. */
  readonly reverseWraparoundMode: boolean;
  readonly sendFocusMode: boolean;
  readonly showCursor: boolean;
  readonly synchronizedOutputMode: boolean;
  /** Always false: oxtty has no win32 input mode. */
  readonly win32InputMode: boolean;
  readonly wraparoundMode: boolean;
}

export interface IBufferCell {
  /** Cell text; '' for the right half of a wide character. */
  getChars(): string;
  getCode(): number;
  /** 2 for a wide character, 0 for its right half, else 1. */
  getWidth(): number;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
}

/** A copy of the line taken by `getLine` (xterm.js hands out a live view). */
export interface IBufferLine {
  /** This line continues the previous one (soft wrap). */
  readonly isWrapped: boolean;
  readonly length: number;
  /** Returns a new cell; `cell` is accepted and not reused. */
  getCell(x: number, cell?: IBufferCell): IBufferCell | undefined;
  /** `trimRight` also drops trailing typed spaces (the engine does not tell them from erased cells). */
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/** Lines are numbered from the oldest scrollback line (0); the screen starts at `baseY`. */
export interface IBuffer {
  readonly type: 'normal' | 'alternate';
  readonly cursorY: number;
  readonly cursorX: number;
  readonly viewportY: number;
  readonly baseY: number;
  readonly length: number;
  getLine(y: number): IBufferLine | undefined;
  getNullCell(): IBufferCell;
}

export interface IBufferNamespace {
  readonly active: IBuffer;
  readonly onBufferChange: IEvent<IBuffer>;
}

/** The engine measures character widths with the Unicode 11 tables only. */
export interface IUnicodeHandling {
  readonly versions: ReadonlyArray<string>;
  /** Always '11'; setting another version throws. */
  activeVersion: string;
}

export interface IRenderDimensions {
  css: { canvas: { width: number; height: number }; cell: { width: number; height: number } };
  device: { canvas: { width: number; height: number }; cell: { width: number; height: number } };
}

export interface ITerminalAddon extends IDisposable {
  activate(terminal: Terminal): void;
}

/**
 * `payload` written to a fresh terminal of the same size and scrollback rebuilds this screen. On refusal
 * (`"unsupported-wide-edge"`, `"margins"`, `"partial-tail-overflow"`) replay the raw output instead.
 */
export type AnsiSnapshot = { ok: true; payload: Uint8Array } | { ok: false; reason: string };

export class Terminal {
  /** Throws unless `await init()` has finished. */
  constructor(options?: ITerminalOptions & ITerminalInitOnlyOptions);

  readonly cols: number;
  readonly rows: number;
  /** The root element (`div.terminal.xterm`), set by `open`. */
  readonly element: HTMLElement | undefined;
  /** Cell and canvas size, undefined before `open`. */
  readonly dimensions: IRenderDimensions | undefined;
  /** The hidden textarea that takes keyboard and IME input, set by `open`. */
  readonly textarea: HTMLTextAreaElement | undefined;
  /** oxtty: the kitty keyboard flags keys are encoded with, as of the last frame (0 while the program pushed none). */
  readonly kittyKeyboardFlags: number;
  readonly buffer: IBufferNamespace;
  readonly modes: IModes;
  readonly unicode: IUnicodeHandling;
  /** Setting a key applies it at once. `cols`, `rows` and `scrollback` throw when changed here. */
  options: ITerminalOptions & ITerminalInitOnlyOptions;

  /** Input (keys, IME, paste, focus reports) and replies to the program (status reports, colour queries, OSC 52 reads). */
  readonly onData: IEvent<string>;
  /** oxtty: fires just before `onData` for data the user produced (keys, IME, paste), never for replies. */
  readonly onUserInput: IEvent<void>;
  readonly onBinary: IEvent<string>;
  readonly onResize: IEvent<{ cols: number; rows: number }>;
  readonly onTitleChange: IEvent<string>;
  readonly onBell: IEvent<void>;
  /** The new `buffer.active.viewportY`, also when output moves the view. */
  readonly onScroll: IEvent<number>;
  /** Viewport rows drawn by a frame. */
  readonly onRender: IEvent<{ start: number; end: number }>;
  /** After each batch of writes has been parsed. */
  readonly onWriteParsed: IEvent<void>;
  readonly onCursorMove: IEvent<void>;
  /** The cell size changed: after a font option, or when fonts finish loading (a loaded fit addon refits then). */
  readonly onDimensionsChange: IEvent<IRenderDimensions>;

  /** Builds the DOM in `parent` and starts drawing; opening again moves the element to `parent`. */
  open(parent: HTMLElement): void;
  /** `callback` runs once the data has been parsed; `write('', callback)` waits for earlier writes. */
  write(data: string | Uint8Array, callback?: () => void): void;
  writeln(data: string | Uint8Array, callback?: () => void): void;
  resize(columns: number, rows: number): void;
  /** Full reset (RIS), applied at once. */
  reset(): void;
  /** Redraws viewport rows `start`…`end` on the next frame. */
  refresh(start: number, end: number): void;
  scrollLines(amount: number): void;
  scrollPages(pageCount: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  scrollToLine(line: number): void;
  focus(): void;
  blur(): void;
  /** Sends `data` as typed: newlines become CR, bracketed when the program enabled bracketed paste. */
  paste(data: string): void;
  /** `customKeyEventHandler` sees every keydown, keypress and keyup first; returning false stops the terminal from handling it. */
  attachCustomKeyEventHandler(customKeyEventHandler: (event: KeyboardEvent) => boolean): void;
  /** oxtty: drops the kitty keyboard flags the program pushed, on both screens, at once. */
  resetKittyKeyboard(): void;
  /**
   * Accepts `FitAddon` (from here or `@xterm/addon-fit` 0.12) and absorbs `@xterm/addon-webgl` (the WebGL
   * renderer is built in; its `onContextLoss` never fires) and `@xterm/addon-unicode11` (the engine already
   * uses those widths). Any other addon throws.
   */
  loadAddon(addon: ITerminalAddon): void;
  /** oxtty: the screen and scrollback as bytes, in place of `@xterm/addon-serialize`. */
  ansiSnapshot(): AnsiSnapshot;
  dispose(): void;
}

/** Sizes the terminal to its element's parent, like `@xterm/addon-fit`. */
export class FitAddon implements ITerminalAddon {
  activate(terminal: Terminal): void;
  dispose(): void;
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}
