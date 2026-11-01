// The xterm.js-compatible Terminal: owns the engine, the write queue, the frame loop and the DOM element.
// It implements what wmux uses (xterm/test/api-checklist.json); the public types are xterm/xterm.d.ts.
import { Mode, Terminal as Engine, type AnsiSnapshot } from '../../src/index.js';
import { css } from 'common/Color';
import { Emitter } from 'vs/base/common/event';
import type { IDisposable } from 'vs/base/common/lifecycle';
import { BufferNamespace } from './buffer';
import { LocalEngineView, Viewport } from './engine-view';
import type { Dimensions, Renderer, RendererOptions, Theme } from './renderer/types';
import { WebglRenderer } from './renderer/WebglRenderer';
import { WriteQueue, isHighSurrogate } from './WriteQueue';

/** OSC 52: the program may copy to (`write`) and read from (`read`) the host clipboard only when the handler is set. */
export interface ClipboardHandler {
  write?(text: string, selection: 'c' | 'p'): void;
  /** A rejected or thrown read answers the program with an empty clipboard. */
  read?(selection: 'c' | 'p'): string | Promise<string>;
}

export type FontWeight = 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | number;

export interface TerminalOptions extends Omit<Partial<RendererOptions>, 'fontWeight' | 'fontWeightBold'> {
  fontWeight?: FontWeight;
  fontWeightBold?: FontWeight;
  cols?: number;
  rows?: number;
  scrollback?: number;
  scrollbar?: { showScrollbar?: boolean; width?: number };
  allowProposedApi?: boolean;
  clipboard?: ClipboardHandler;
}

export interface Modes {
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
  bracketedPasteMode: boolean;
  insertMode: boolean;
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  originMode: boolean;
  reverseWraparoundMode: boolean;
  sendFocusMode: boolean;
  showCursor: boolean;
  synchronizedOutputMode: boolean;
  win32InputMode: boolean;
  wraparoundMode: boolean;
}

export interface TerminalAddon extends IDisposable {
  activate(terminal: Terminal): void;
}

export type RendererFactory = (container: HTMLElement, cols: number, rows: number, options: Partial<RendererOptions>) => Renderer;

let rendererFactory: RendererFactory = (container, cols, rows, options) => new WebglRenderer(container, cols, rows, options);

/** Sets how `open` builds the renderer (tests pass a fake one). */
export function setRendererFactory(factory: RendererFactory): void {
  rendererFactory = factory;
}

// xterm.js 6 defaults of the options the facade keeps; the renderer applies its own defaults to the rest.
const DEFAULT_OPTIONS: TerminalOptions = {
  cols: 80, rows: 24, scrollback: 1000, scrollbar: { showScrollbar: true }, allowProposedApi: false,
  cursorBlink: false, cursorStyle: 'block', cursorWidth: 1, cursorInactiveStyle: 'outline', drawBoldTextInBrightColors: true,
  fontFamily: 'monospace', fontSize: 15, fontWeight: 'normal', fontWeightBold: 'bold', lineHeight: 1, letterSpacing: 0,
  minimumContrastRatio: 1, allowTransparency: false, theme: {},
};
const INIT_ONLY = new Set(['cols', 'rows', 'scrollback']);
const RENDERER_OPTIONS: Record<keyof RendererOptions, true> = {
  fontFamily: true, fontSize: true, fontWeight: true, fontWeightBold: true, lineHeight: true, letterSpacing: true, theme: true,
  drawBoldTextInBrightColors: true, minimumContrastRatio: true, customGlyphs: true, allowTransparency: true,
  rescaleOverlappingGlyphs: true, cursorBlink: true, cursorStyle: true, cursorWidth: true, cursorInactiveStyle: true,
};

// xterm.js default palette: 16 ANSI colours, then the 6×6×6 cube and 24 greys.
const ANSI = ['2e3436', 'cc0000', '4e9a06', 'c4a000', '3465a4', '75507b', '06989a', 'd3d7cf',
  '555753', 'ef2929', '8ae234', 'fce94f', '729fcf', 'ad7fa8', '34e2e2', 'eeeeec'];
const CUBE = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed',
  'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

function defaultColor(i: number): number {
  if (i < 16) return parseInt(ANSI[i], 16);
  if (i < 232) return CUBE[((i - 16) / 36 | 0) % 6] << 16 | CUBE[((i - 16) / 6 | 0) % 6] << 8 | CUBE[(i - 16) % 6];
  const grey = 8 + (i - 232) * 10;
  return grey << 16 | grey << 8 | grey;
}

/** 0xRRGGBB, or undefined for an unset or invalid colour (xterm.js falls back to the default too). */
function rgb(color: string | undefined): number | undefined {
  if (color === undefined) return undefined;
  try {
    return css.toColor(color).rgba >>> 8;
  } catch {
    return undefined;
  }
}

/** The colours the engine answers OSC 4/10/11/12 queries with: palette, foreground, background, cursor. */
function themeColors(theme: Theme = {}): number[] {
  const colors = Array.from({ length: 256 }, (_, i) => rgb(i < 16 ? theme[ANSI_NAMES[i]] : theme.extendedAnsi?.[i - 16]) ?? defaultColor(i));
  colors.push(rgb(theme.foreground) ?? 0xffffff, rgb(theme.background) ?? 0x000000, rgb(theme.cursor) ?? 0xffffff);
  return colors;
}

const STYLE_ID = 'oxtty-xterm-style';
const STYLE = `
.xterm { position: relative; cursor: text; user-select: none; -webkit-user-select: none; }
.xterm .xterm-screen { position: relative; }
.xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
`;

const decoder = new TextDecoder();

export class Terminal {
  private readonly _engine: Engine;
  private readonly _view: LocalEngineView;
  private readonly _viewport = new Viewport();
  private readonly _queue: WriteQueue;
  private readonly _options: Record<string, unknown>;
  private readonly _optionsProxy: TerminalOptions;
  private readonly _addons: TerminalAddon[] = [];
  private readonly _fitAddons: { fit(): void }[] = [];
  private _element: HTMLElement | undefined;
  private _screen: HTMLElement | undefined;
  private _renderer: Renderer | undefined;
  /** Renderer and DOM listeners added by `open`. */
  private _openListeners: (() => void)[] = [];
  private _frame = 0;
  /** Rows the host changed since the last frame (redraw requests, `refresh`). */
  private _hostDirty: Set<number> | 'all' = 'all';
  /** A string write that ended in a high surrogate keeps it for the next string write, like xterm.js. */
  private _highSurrogate = '';
  private _clipboardReads = Promise.resolve();
  private _cursorX = 0;
  private _cursorY = 0;
  private _viewportY = 0;
  private _alternate = false;
  private _disposed = false;

  private readonly _onData = new Emitter<string>();
  public readonly onData = this._onData.event;
  /** Fired by input (step 2) for non-UTF-8 mouse reports; never by program output. */
  private readonly _onBinary = new Emitter<string>();
  public readonly onBinary = this._onBinary.event;
  private readonly _onResize = new Emitter<{ cols: number; rows: number }>();
  public readonly onResize = this._onResize.event;
  private readonly _onTitleChange = new Emitter<string>();
  public readonly onTitleChange = this._onTitleChange.event;
  private readonly _onBell = new Emitter<void>();
  public readonly onBell = this._onBell.event;
  private readonly _onScroll = new Emitter<number>();
  public readonly onScroll = this._onScroll.event;
  private readonly _onRender = new Emitter<{ start: number; end: number }>();
  public readonly onRender = this._onRender.event;
  private readonly _onWriteParsed = new Emitter<void>();
  public readonly onWriteParsed = this._onWriteParsed.event;
  private readonly _onCursorMove = new Emitter<void>();
  public readonly onCursorMove = this._onCursorMove.event;
  private readonly _onDimensionsChange = new Emitter<Dimensions>();
  public readonly onDimensionsChange = this._onDimensionsChange.event;

  public readonly buffer: BufferNamespace;

  /** The engine measures widths with the Unicode 11 tables only. */
  public readonly unicode = {
    versions: ['11'] as readonly string[],
    get activeVersion(): string {
      return '11';
    },
    set activeVersion(version: string) {
      if (version !== '11') throw new Error(`oxtty/xterm: the engine uses Unicode 11 widths only, not "${version}"`);
    },
  };

  /** Throws unless `await init()` (exported next to this class) has finished. */
  constructor(options: TerminalOptions = {}) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    const { cols, rows, scrollback } = this._options as TerminalOptions;
    this._engine = new Engine({
      cols, rows, scrollback,
      onSyncFlush: () => this._afterChange(),
      onCrash: error => this._handleCrash(error),
    });
    this._view = new LocalEngineView(this._engine);
    this._queue = new WriteQueue(data => this._engine.write(data), () => this._handleEvents(), () => this._afterWrite());
    this._optionsProxy = new Proxy(this._options, {
      set: (_, key, value) => {
        this._setOption(key as string, value);
        return true;
      },
    }) as TerminalOptions;
    this.buffer = new BufferNamespace(this._engine);
    this._engine.setColors(themeColors(this._options.theme as Theme));
    this._applyClipboard();
    this._readState();
  }

  public get cols(): number {
    return this._engine.cols;
  }

  public get rows(): number {
    return this._engine.rows;
  }

  /** The terminal's root element, set by `open`. */
  public get element(): HTMLElement | undefined {
    return this._element;
  }

  /** Cell and canvas size, undefined before `open`. */
  public get dimensions(): Dimensions | undefined {
    return this._renderer?.dimensions;
  }

  public get modes(): Modes {
    const m = this._engine.modes();
    return {
      applicationCursorKeysMode: !!(m & Mode.APP_CURSOR),
      applicationKeypadMode: !!(m & Mode.APP_KEYPAD),
      bracketedPasteMode: !!(m & Mode.BRACKETED_PASTE),
      insertMode: !!(m & Mode.INSERT),
      mouseTrackingMode: m & Mode.MOUSE_MOTION ? 'any' : m & Mode.MOUSE_DRAG ? 'drag' : m & Mode.MOUSE_CLICK ? 'vt200' : 'none',
      originMode: !!(m & Mode.ORIGIN),
      reverseWraparoundMode: false,
      sendFocusMode: !!(m & Mode.FOCUS_EVENTS),
      showCursor: !!(m & Mode.SHOW_CURSOR),
      synchronizedOutputMode: this._engine.syncPending(),
      win32InputMode: false,
      wraparoundMode: !!(m & Mode.LINE_WRAP),
    };
  }

  /** Setting a key applies it at once (renderer options redraw, `theme` also answers colour queries). */
  public get options(): TerminalOptions {
    return this._optionsProxy;
  }

  public set options(options: TerminalOptions) {
    for (const [key, value] of Object.entries(options)) this._setOption(key, value);
  }

  public open(parent: HTMLElement): void {
    if (this._element) {
      // xterm.js keeps its DOM when opened again; a parked element is simply moved.
      if (this._element.parentElement !== parent) parent.appendChild(this._element);
      return;
    }
    const doc = parent.ownerDocument;
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE;
      doc.head.appendChild(style);
    }
    const element = doc.createElement('div');
    element.classList.add('terminal', 'xterm');
    element.dir = 'ltr';
    const screen = doc.createElement('div');
    screen.classList.add('xterm-screen');
    // Input puts the hidden textarea and the IME composition view in here (step 2).
    const helpers = doc.createElement('div');
    helpers.classList.add('xterm-helpers');
    screen.appendChild(helpers);
    element.appendChild(screen);
    parent.appendChild(element);
    this._element = element;
    this._screen = screen;

    const options: Partial<RendererOptions> = {};
    for (const key of Object.keys(RENDERER_OPTIONS)) if (this._options[key] !== undefined) Object.assign(options, { [key]: this._options[key] });
    // The renderer puts its canvas into `screen` and may replace it (WebGL context recreated): never keep it.
    const renderer = rendererFactory(screen, this.cols, this.rows, options);
    this._renderer = renderer;
    // Focus picks the cursor style; the hidden textarea (step 2) focuses inside the element.
    const onFocusIn = (): void => this._setFocused(true);
    const onFocusOut = (e: FocusEvent): void => this._setFocused(element.contains(e.relatedTarget as Node | null));
    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    this._setFocused(element.contains(doc.activeElement));
    this._openListeners.push(
      () => element.removeEventListener('focusin', onFocusIn),
      () => element.removeEventListener('focusout', onFocusOut),
      renderer.onDimensionsChange(() => {
        this._syncScreenSize();
        this._onDimensionsChange.fire(renderer.dimensions);
        for (const addon of this._fitAddons) addon.fit();
      }),
      renderer.onRedrawRequest(rows => this._redraw(rows)),
    );
    this._syncScreenSize();
    this._view.invalidate();
    this._redraw('all');
  }

  /** `callback` runs once the engine has parsed `data`; `write('', callback)` waits for earlier writes. */
  public write(data: string | Uint8Array, callback?: () => void): void {
    if (this._disposed) return;
    if (typeof data === 'string') {
      data = this._highSurrogate + data;
      this._highSurrogate = '';
      if (data.length && isHighSurrogate(data.charCodeAt(data.length - 1))) {
        this._highSurrogate = data.slice(-1);
        data = data.slice(0, -1);
      }
    }
    this._queue.write(data, callback);
  }

  public writeln(data: string | Uint8Array, callback?: () => void): void {
    this.write(data);
    this.write('\r\n', callback);
  }

  public resize(cols: number, rows: number): void {
    if (isNaN(cols) || isNaN(rows) || (cols === this.cols && rows === this.rows)) return;
    this._engine.resize(cols, rows);
    this._options.cols = this.cols;
    this._options.rows = this.rows;
    this._renderer?.resize(this.cols, this.rows);
    this._syncScreenSize();
    this._onResize.fire({ cols: this.cols, rows: this.rows });
    this._afterChange();
  }

  /** Full reset (RIS), applied at once; writes still queued are parsed afterwards. */
  public reset(): void {
    this._highSurrogate = '';
    this._engine.write('\x1bc');
    this._handleEvents();
    this._redraw('all');
    this._afterChange();
  }

  /** Redraws rows `start`…`end` (viewport rows) on the next frame. */
  public refresh(start: number, end: number): void {
    const rows: number[] = [];
    for (let y = Math.max(0, start); y <= Math.min(end, this.rows - 1); y++) rows.push(y);
    this._redraw(rows);
  }

  /** Positive `amount` scrolls down towards the newest output. */
  public scrollLines(amount: number): void {
    this._engine.scrollDisplay(-amount);
    this._afterChange();
  }

  public scrollPages(pageCount: number): void {
    this.scrollLines(pageCount * (this.rows - 1));
  }

  public scrollToTop(): void {
    this._engine.scrollDisplay(this._engine.historyLength);
    this._afterChange();
  }

  public scrollToBottom(): void {
    this._engine.scrollToBottom();
    this._afterChange();
  }

  /** Scrolls so that buffer line `line` is the top viewport row. */
  public scrollToLine(line: number): void {
    this.scrollLines(line - this.buffer.active.viewportY);
  }

  /**
   * Accepts fit addons (this package's `FitAddon` or `@xterm/addon-fit`), and absorbs `@xterm/addon-webgl` and
   * `@xterm/addon-unicode11`, whose work is built in. Any other addon throws.
   */
  public loadAddon(addon: TerminalAddon): void {
    const a = addon as unknown as Record<string, unknown>;
    if (typeof a.fit === 'function' && typeof a.proposeDimensions === 'function') {
      addon.activate(this);
      this._addons.push(addon);
      this._fitAddons.push(addon as unknown as { fit(): void });
      return;
    }
    if (typeof a.onContextLoss === 'function' && typeof a.clearTextureAtlas === 'function') {
      // The WebGL renderer is built in and restores a lost context itself, so the addon is never activated.
      Object.assign(addon, {
        activate: () => {},
        dispose: () => {},
        onContextLoss: () => ({ dispose: () => {} }),
        clearTextureAtlas: () => this._redraw('all'),
      });
      return;
    }
    if (typeof a.findNext === 'function') throw new Error('oxtty/xterm: @xterm/addon-search is not supported yet');
    if (typeof a.serialize === 'function') throw new Error('oxtty/xterm: @xterm/addon-serialize is not supported; use terminal.ansiSnapshot()');
    if (isUnicode11Addon(addon)) return;
    throw new Error(`oxtty/xterm: unsupported addon ${addon.constructor?.name ?? ''}; only fit, webgl and unicode11 addons can be loaded`);
  }

  /** Bytes that rebuild this screen, scrollback included, in a fresh terminal of the same size (engine `ansiSnapshot`). */
  public ansiSnapshot(): AnsiSnapshot {
    return this._engine.ansiSnapshot();
  }

  public dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._queue.dispose();
    if (this._frame) cancelAnimationFrame(this._frame);
    for (const addon of this._addons.splice(0)) addon.dispose();
    for (const unsubscribe of this._openListeners.splice(0)) unsubscribe();
    this._renderer?.dispose();
    this._renderer = undefined;
    this._element?.remove();
    this._engine.dispose();
    for (const emitter of [this._onData, this._onBinary, this._onResize, this._onTitleChange, this._onBell, this._onScroll,
      this._onRender, this._onWriteParsed, this._onCursorMove, this._onDimensionsChange, this.buffer._onBufferChange]) emitter.dispose();
  }

  private _setOption(key: string, value: unknown): void {
    if (INIT_ONLY.has(key)) {
      if (value !== this._options[key]) throw new Error(`oxtty/xterm: option "${key}" can only be set in the constructor`);
      return;
    }
    this._options[key] = value;
    if (key === 'theme') this._engine.setColors(themeColors(value as Theme));
    if (key === 'clipboard') this._applyClipboard();
    if (key in RENDERER_OPTIONS && this._renderer) {
      const { width, height } = this._renderer.dimensions.css.cell;
      this._renderer.setOptions({ [key]: value });
      this._syncScreenSize();
      const cell = this._renderer.dimensions.css.cell;
      if (cell.width !== width || cell.height !== height) this._onDimensionsChange.fire(this._renderer.dimensions);
      this._redraw('all');
    }
  }

  /** Tells the renderer whether the terminal has focus (cursor style and blink); input drives it from step 2. */
  private _setFocused(focused: boolean): void {
    this._renderer?.setFocused(focused);
  }

  private _applyClipboard(): void {
    const clipboard = this._options.clipboard as ClipboardHandler | undefined;
    this._engine.setClipboardAccess({ read: !!clipboard?.read, write: !!clipboard?.write });
  }

  /** Hands what the program asked of the host to the events; runs after every parsed write, frames or not. */
  private _handleEvents(): void {
    const events = this._view.takeEvents();
    if (events.replies.length) this._onData.fire(decoder.decode(events.replies));
    if (events.title !== null) this._onTitleChange.fire(events.title);
    for (let i = 0; i < events.bells; i++) this._onBell.fire();
    const clipboard = this._options.clipboard as ClipboardHandler | undefined;
    for (const { selection, text } of events.clipboardWrites) clipboard?.write?.(text, selection);
    for (const selection of events.clipboardReads) {
      // Reads are answered in order, each with the oldest pending read of its selection.
      this._clipboardReads = this._clipboardReads.then(async () => {
        let text = '';
        try {
          text = await (clipboard?.read?.(selection) ?? '');
        } catch {
          // The program still gets an answer, or its later reads would wait behind this one.
        }
        if (this._disposed) return;
        this._engine.replyClipboard(selection, text);
        this._handleEvents();
      });
    }
  }

  private _afterWrite(): void {
    if (this._disposed) return;
    this._handleEvents();
    this._onWriteParsed.fire();
    this._afterChange();
  }

  /** Fires the state events and schedules a frame after the engine changed. */
  private _afterChange(): void {
    const [cursorX, cursorY, viewportY, alternate] = [this._cursorX, this._cursorY, this._viewportY, this._alternate];
    this._readState();
    if (this._alternate !== alternate) this.buffer._onBufferChange.fire(this.buffer.active);
    if (this._viewportY !== viewportY) this._onScroll.fire(this._viewportY);
    if (this._cursorX !== cursorX || this._cursorY !== cursorY) this._onCursorMove.fire();
    this._scheduleFrame();
  }

  private _readState(): void {
    const e = this._engine;
    const cursor = e.cursor();
    this._cursorX = cursor.col;
    this._cursorY = cursor.line;
    this._viewportY = e.historyLength - e.displayOffset;
    this._alternate = (e.modes() & Mode.ALT_SCREEN) !== 0;
  }

  /** After an engine crash the terminal starts over empty: redraw everything and drop the selection. */
  private _handleCrash(error: Error): void {
    console.warn(error);
    this._view.invalidate();
    this._renderer?.setSelection(undefined);
    this._redraw('all');
  }

  private _redraw(rows: readonly number[] | 'all'): void {
    if (rows === 'all') this._hostDirty = 'all';
    else if (this._hostDirty !== 'all') for (const y of rows) this._hostDirty.add(y);
    this._scheduleFrame();
  }

  private _scheduleFrame(): void {
    if (this._frame || !this._renderer || this._disposed) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._renderFrame();
    });
  }

  private _renderFrame(): void {
    const renderer = this._renderer;
    if (!renderer) return;
    const changed = this._viewport.apply(this._view.takeFrame());
    const dirty = this._hostDirty;
    this._hostDirty = new Set();
    renderer.render(this._viewport, changed, dirty);
    const rows = dirty === 'all' ? [0, this._viewport.rows - 1] : [...changed, ...dirty];
    if (rows.length) this._onRender.fire({ start: Math.min(...rows), end: Math.max(...rows) });
  }

  private _syncScreenSize(): void {
    if (!this._screen || !this._renderer) return;
    const { width, height } = this._renderer.dimensions.css.canvas;
    this._screen.style.width = `${width}px`;
    this._screen.style.height = `${height}px`;
  }
}

/**
 * True for an addon whose `activate` only registers a Unicode 11 width provider (@xterm/addon-unicode11): the
 * engine already measures with those tables. `activate` runs against a stand-in that has nothing but `unicode`.
 */
function isUnicode11Addon(addon: TerminalAddon): boolean {
  let registered = false;
  const unicode = { register: (provider: { version?: string }) => { registered = provider.version === '11'; } };
  const probe = new Proxy({}, {
    get: (_, key) => {
      if (key === 'unicode') return unicode;
      throw new Error(`oxtty/xterm: probe has no ${String(key)}`);
    },
  });
  try {
    addon.activate(probe as Terminal);
  } catch {
    return false;
  }
  return registered;
}
