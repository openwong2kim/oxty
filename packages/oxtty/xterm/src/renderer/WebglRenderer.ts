// The WebGL renderer: takes the place of xterm.js WebglRenderer.ts and ties together the copied GlyphRenderer,
// RectangleRenderer, TextureAtlas (shared through CharAtlasCache), RenderModel and CellColorResolver. The render model is
// filled from `Viewport` rows instead of the buffer (IBufferLine.loadCell).
// Not here yet: character joining (ligatures) and the link layer.
import type { CellExtra, Cursor } from '../../../src/index.js';
import type { Viewport } from '../engine-view';
import type { Renderer, RendererOptions, SelectionRange } from './types';
import { createRenderDimensions } from 'browser/renderer/shared/RendererUtils';
import { CharSizeService } from 'browser/services/CharSizeService';
import { ThemeService } from 'browser/services/ThemeService';
import { ITerminal } from 'browser/Types';
import { Attributes, NULL_CELL_CODE } from 'common/buffer/Constants';
import { Emitter } from 'vs/base/common/event';
import { CellColorResolver } from '../../vendor-xterm/addons/addon-webgl/src/CellColorResolver';
import { acquireTextureAtlas, removeTerminalFromCache } from '../../vendor-xterm/addons/addon-webgl/src/CharAtlasCache';
import { CursorBlinkStateManager } from '../../vendor-xterm/addons/addon-webgl/src/CursorBlinkStateManager';
import { observeDevicePixelDimensions } from '../../vendor-xterm/addons/addon-webgl/src/DevicePixelObserver';
import { GlyphRenderer } from '../../vendor-xterm/addons/addon-webgl/src/GlyphRenderer';
import { RectangleRenderer } from '../../vendor-xterm/addons/addon-webgl/src/RectangleRenderer';
import { COMBINED_CHAR_BIT_MASK, RENDER_MODEL_BG_OFFSET, RENDER_MODEL_EXT_OFFSET, RENDER_MODEL_FG_OFFSET, RENDER_MODEL_INDICIES_PER_CELL, RenderModel } from '../../vendor-xterm/addons/addon-webgl/src/RenderModel';
import { ITextureAtlas, IWebGL2RenderingContext } from '../../vendor-xterm/addons/addon-webgl/src/Types';
import { OxttyCellData } from './CellData';
import { CoreBrowserServiceStub, DecorationServiceStub, OptionsService, UnicodeServiceStub } from './services';

const ATTR_WIDE = 1 << 12;

/** How long a lost context may take to come back by itself before the renderer makes a new one (as in xterm.js). */
const CONTEXT_RESTORE_TIMEOUT = 3000;
const DIMENSION_OPTIONS: readonly (keyof RendererOptions)[] = ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing'];

// Widths are decided per code point by the engine, so one record serves every atlas.
const unicodeService = new UnicodeServiceStub();

// Live renderers. A browser keeps only so many WebGL contexts per page (16 in Chrome) and takes the oldest one away when
// a new one goes over; renderers use this to hand contexts to the ones in view.
const renderers = new Set<WebglRenderer>();

/** `live`: drawing. `lost`: waiting for `webglcontextrestored`. `parked`: no context until one is handed over. */
type ContextState = 'live' | 'lost' | 'parked';

interface TerminalView {
  cols: number;
  rows: number;
  element: HTMLElement;
  buffer: { active: { viewportY: number } };
  _core: ITerminal;
}

export class WebglRenderer implements Renderer {
  public readonly dimensions = createRenderDimensions();
  private _canvas!: HTMLCanvasElement;
  private _gl!: IWebGL2RenderingContext;
  private _deviceMaxTextureSize = 0;
  private _rectangles: RectangleRenderer | undefined;
  private _glyphs: GlyphRenderer | undefined;
  private _atlas: ITextureAtlas | undefined;
  private readonly _model = new RenderModel();
  private readonly _cell = new OxttyCellData();

  private readonly _options: OptionsService;
  private readonly _coreBrowser = new CoreBrowserServiceStub();
  private readonly _theme: ThemeService;
  private readonly _charSize: CharSizeService;
  private readonly _colorResolver: CellColorResolver;
  // What the copied parts read from the xterm.js Terminal (cols, rows, element, viewportY) and its core (CharAtlasCache, SelectionRenderModel)
  private readonly _view: TerminalView;
  private _dpr: number;

  private _blink: CursorBlinkStateManager | undefined;
  private _cursor: Cursor = { line: 0, col: 0, visible: false, shape: 'block', blink: false };
  private _cursorRow = -1;
  private _fullRedraw = true;
  private readonly _dirty = new Set<number>();

  private _state: ContextState = 'live';
  private _contextGone = false;
  private _visible = true;
  private _disposed = false;
  private _restoreTimeout: number | undefined;
  private _recreateTimeout: number | undefined;
  private _lastRecreate = -Infinity;
  private _recreateGap = 1000;
  private _contextDisposables: (() => void)[] = [];
  private readonly _disposables: (() => void)[] = [];

  private readonly _onDimensionsChange = new Emitter<void>();
  private readonly _onRedrawRequest = new Emitter<number[] | 'all'>();

  constructor(private readonly _container: HTMLElement, cols: number, rows: number, options: Partial<RendererOptions> = {}) {
    this._options = new OptionsService(options);
    this._theme = new ThemeService(this._options);
    this._charSize = new CharSizeService(document, _container, this._options);
    this._charSize.measure();
    this._dpr = this._coreBrowser.dpr;
    const view: TerminalView = {
      cols,
      rows,
      element: _container,
      buffer: { active: { viewportY: 0 } },
      _core: { get rows() { return view.rows; }, buffers: { active: { ydisp: 0 } }, unicodeService }
    };
    this._view = view;
    this._colorResolver = new CellColorResolver(view, this._options, this._model.selection, new DecorationServiceStub(), this._coreBrowser, this._theme);

    this._createContext();
    renderers.add(this);
    this._initializeWebGLState();
    this._updateCursorBlink();

    const fonts = document.fonts;
    const onFontsLoaded = (): void => this._handleFontsLoaded();
    fonts?.addEventListener('loadingdone', onFontsLoaded);
    this._disposables.push(() => fonts?.removeEventListener('loadingdone', onFontsLoaded));
    const onWindowResize = (): void => void this._checkDevicePixelRatio();
    window.addEventListener('resize', onWindowResize);
    this._disposables.push(() => window.removeEventListener('resize', onWindowResize));
    const visibility = new IntersectionObserver(entries => this._handleVisibility(entries[entries.length - 1].isIntersecting));
    visibility.observe(_container);
    this._disposables.push(() => visibility.disconnect());
  }

  public get canvas(): HTMLCanvasElement {
    return this._canvas;
  }

  public onDimensionsChange(listener: () => void): () => void {
    const d = this._onDimensionsChange.event(listener);
    return () => d.dispose();
  }

  public onRedrawRequest(listener: (rows: number[] | 'all') => void): () => void {
    const d = this._onRedrawRequest.event(listener);
    return () => d.dispose();
  }

  public setOptions(options: Partial<RendererOptions>): void {
    // ThemeService picks up `theme` and CharSizeService re-measures for `fontFamily`/`fontSize` while the options are set
    const changed = this._options.set(options);
    if (!changed.length) return;
    if (changed.some(k => DIMENSION_OPTIONS.includes(k))) {
      this._handleResize();
    } else {
      this._refreshCharAtlas();
      this._clearModel(true);
    }
    this._updateCursorBlink();
    this._requestRedraw('all');
  }

  public resize(cols: number, rows: number): void {
    this._view.cols = cols;
    this._view.rows = rows;
    this._handleResize();
  }

  public setFocused(focused: boolean): void {
    if (this._coreBrowser.isFocused === focused) return;
    this._coreBrowser.isFocused = focused;
    if (focused) this._blink?.resume();
    else this._blink?.pause();
    // Cursor style and selection colours both depend on focus
    this._requestRedraw('all');
  }

  public setSelection(selection: SelectionRange | undefined): void {
    const model = this._model.selection;
    const rows = new Set<number>();
    const addRows = (): void => {
      if (!model.hasSelection) return;
      for (let y = model.viewportCappedStartRow; y <= model.viewportCappedEndRow; y++) rows.add(y);
    };
    addRows();
    model.update(this._view._core, selection?.start, selection?.end, selection?.columnSelect);
    addRows();
    if (rows.size) this._requestRedraw([...rows]);
  }

  public render(viewport: Viewport, changed: readonly number[], hostDirty?: Iterable<number> | 'all'): void {
    const { cols, rows } = this._view;
    if (this._state !== 'live' || !this._glyphs || !this._rectangles || viewport.cols !== cols || viewport.rows !== rows) return;

    const cursor = viewport.cursor;
    if (cursor.line !== this._cursor.line || cursor.col !== this._cursor.col) this._blink?.restartBlinkAnimation();
    const blinkChanged = cursor.shape !== this._cursor.shape || cursor.blink !== this._cursor.blink;
    this._cursor = cursor;
    if (blinkChanged) this._updateCursorBlink();

    let all = this._fullRedraw || hostDirty === 'all';
    // Upon a model clear also refresh the full viewport model (also triggered by an atlas page merge)
    if (this._glyphs.beginFrame()) {
      this._clearModel(true);
      all = true;
    }
    this._fullRedraw = false;
    let lines: Iterable<number>;
    if (all) {
      lines = Array.from({ length: rows }, (_, y) => y);
    } else {
      const set = this._dirty;
      for (const y of changed) set.add(y);
      if (hostDirty && hostDirty !== 'all') for (const y of hostDirty) set.add(y);
      // The rows the cursor left and entered (the engine does not report cursor moves as damage)
      set.add(this._cursorRow);
      set.add(cursor.line);
      lines = [...set].filter(y => y >= 0 && y < rows);
    }
    this._dirty.clear();
    this._cursorRow = cursor.visible ? cursor.line : -1;
    this._updateModel(viewport, lines);

    this._rectangles.renderBackgrounds();
    this._glyphs.render(this._model);
    if (!this._blink || this._blink.isCursorVisible) this._rectangles.renderCursor();
  }

  public dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    renderers.delete(this);
    clearTimeout(this._restoreTimeout);
    clearTimeout(this._recreateTimeout);
    this._blink?.dispose();
    for (const d of this._disposables.splice(0)) d();
    this._disposeContext();
    this._rectangles?.dispose();
    this._glyphs?.dispose();
    removeTerminalFromCache(this._view as never);
    this._atlas = undefined;
    this._gl.getExtension('WEBGL_lose_context')?.loseContext();
    this._canvas.remove();
    this._theme.dispose();
    this._charSize.dispose();
    this._options.dispose();
    this._onDimensionsChange.dispose();
    this._onRedrawRequest.dispose();
    // That freed a context
    for (const r of renderers) {
      if (r._state === 'parked' && r._visible) {
        r._recreate();
        break;
      }
    }
  }

  // WebglRenderer._updateModel minus character joiners, reading cells from the viewport
  private _updateModel(viewport: Viewport, lines: Iterable<number>): void {
    const cols = this._view.cols;
    const cell = this._cell;
    const result = this._colorResolver.result;
    const options = this._options.rawOptions;
    const cursor = viewport.cursor;
    const cursorX = Math.min(cursor.col, cols - 1);
    const focused = this._coreBrowser.isFocused;
    const cursorStyle = focused ? this._cursorStyle() : options.cursorInactiveStyle;
    const isCursorVisible = cursor.visible && (!this._blink || this._blink.isCursorVisible);
    let lastCursorX = -1;
    let modelUpdated = false;
    this._model.cursor = undefined;

    for (const y of lines) {
      const cells = viewport.row(y);
      let extras: (CellExtra | undefined)[] | undefined;
      const rowExtras = viewport.extras.get(y);
      if (rowExtras) {
        extras = [];
        for (const e of rowExtras) extras[e.col] = e;
      }
      this._model.lineLengths[y] = 0;
      for (let x = 0; x < cols; x++) {
        // Resolved background color of the previous cell (GlyphRenderer uses it to decide left-side glyph clipping)
        const lastBg = result.bg;
        const o = x * 4;
        const attrs = cells[o + 3];
        if (attrs & ATTR_WIDE) unicodeService.recordWide(cells[o]);
        const extra = extras?.[x];
        cell.load(cells[o], cells[o + 1], cells[o + 2], attrs, extra?.text ?? '', extra?.underlineColor ?? 0);

        const chars = cell.getChars();
        let code = cell.getCode();
        const i = ((y * cols) + x) * RENDER_MODEL_INDICIES_PER_CELL;
        this._colorResolver.resolve(cell, x, y, this.dimensions.device.cell.width);

        // Override colors for the cursor cell
        if (isCursorVisible && y === cursor.line) {
          if (x === cursorX) {
            this._model.cursor = { x: cursorX, y, width: cell.getWidth(), style: cursorStyle, cursorWidth: options.cursorWidth, dpr: this._dpr };
            lastCursorX = cursorX + cell.getWidth() - 1;
          }
          if (cursorStyle === 'block' && x >= cursorX && x <= lastCursorX) {
            result.fg = Attributes.CM_RGB | (this._theme.colors.cursorAccent.rgba >> 8 & Attributes.RGB_MASK);
            result.bg = Attributes.CM_RGB | (this._theme.colors.cursor.rgba >> 8 & Attributes.RGB_MASK);
          }
        }

        if (code !== NULL_CELL_CODE) this._model.lineLengths[y] = x + 1;

        // Nothing has changed, no updates needed
        if (this._model.cells[i] === code &&
            this._model.cells[i + RENDER_MODEL_BG_OFFSET] === result.bg &&
            this._model.cells[i + RENDER_MODEL_FG_OFFSET] === result.fg &&
            this._model.cells[i + RENDER_MODEL_EXT_OFFSET] === result.ext) {
          continue;
        }
        modelUpdated = true;
        // Flag combined chars with a bit mask so they're easily identifiable
        if (chars.length > 1) code |= COMBINED_CHAR_BIT_MASK;
        this._model.cells[i] = code;
        this._model.cells[i + RENDER_MODEL_BG_OFFSET] = result.bg;
        this._model.cells[i + RENDER_MODEL_FG_OFFSET] = result.fg;
        this._model.cells[i + RENDER_MODEL_EXT_OFFSET] = result.ext;
        this._glyphs!.updateCell(x, y, code, result.bg, result.fg, result.ext, chars, cell.getWidth(), lastBg);
      }
    }
    if (modelUpdated) this._rectangles!.updateBackgrounds(this._model);
    this._rectangles!.updateCursor(this._model);
  }

  // The engine reports a steady block until the program sends DECSCUSR, and that reading means "use the options"
  private _programSetCursor(): boolean {
    return this._cursor.shape !== 'block' || this._cursor.blink;
  }

  private _cursorStyle(): RendererOptions['cursorStyle'] {
    return this._programSetCursor() ? this._cursor.shape : this._options.rawOptions.cursorStyle;
  }

  private _updateCursorBlink(): void {
    const blink = this._programSetCursor() ? this._cursor.blink : this._options.rawOptions.cursorBlink;
    if (blink === !!this._blink) return;
    this._blink?.dispose();
    this._blink = blink ? new CursorBlinkStateManager(() => this._requestRedraw([this._cursorRow]), this._coreBrowser) : undefined;
    this._requestRedraw([this._cursorRow]);
  }

  private _requestRedraw(rows: number[] | 'all'): void {
    if (rows === 'all') {
      this._fullRedraw = true;
    } else {
      rows = rows.filter(y => y >= 0);
      if (!rows.length) return;
      for (const y of rows) this._dirty.add(y);
    }
    this._onRedrawRequest.fire(rows);
  }

  private _clearModel(clearGlyphRenderer: boolean): void {
    this._model.clear();
    if (clearGlyphRenderer) this._glyphs?.clear();
    this._fullRedraw = true;
  }

  private _handleResize(): void {
    const { cols, rows } = this._view;
    this._updateDimensions();
    this._model.resize(cols, rows);
    this._canvas.width = this.dimensions.device.canvas.width;
    this._canvas.height = this.dimensions.device.canvas.height;
    this._canvas.style.width = `${this.dimensions.css.canvas.width}px`;
    this._canvas.style.height = `${this.dimensions.css.canvas.height}px`;
    this._rectangles?.setDimensions(this.dimensions);
    this._rectangles?.handleResize();
    this._glyphs?.setDimensions(this.dimensions);
    this._glyphs?.handleResize();
    this._refreshCharAtlas();
    // Resizing the glyph renderer cleared it already
    this._clearModel(false);
  }

  // WebglRenderer._updateDimensions
  private _updateDimensions(): void {
    if (!this._charSize.width || !this._charSize.height) return;
    const { lineHeight, letterSpacing } = this._options.rawOptions;
    const dim = this.dimensions;
    // Width is floored as it must be drawn to an integer grid in order for the char atlas glyphs to not be blurry
    dim.device.char.width = Math.floor(this._charSize.width * this._dpr);
    // Height is ceiled in case devicePixelRatio is a floating point number to ensure there is enough space for the character
    dim.device.char.height = Math.ceil(this._charSize.height * this._dpr);
    dim.device.cell.height = Math.floor(dim.device.char.height * lineHeight);
    dim.device.char.top = lineHeight === 1 ? 0 : Math.round((dim.device.cell.height - dim.device.char.height) / 2);
    dim.device.cell.width = dim.device.char.width + Math.round(letterSpacing);
    dim.device.char.left = Math.floor(letterSpacing / 2);
    dim.device.canvas.height = this._view.rows * dim.device.cell.height;
    dim.device.canvas.width = this._view.cols * dim.device.cell.width;
    // Rounded, not ceiled: devicePixelRatio is often slightly off (1.100000023841858)
    dim.css.canvas.height = Math.round(dim.device.canvas.height / this._dpr);
    dim.css.canvas.width = Math.round(dim.device.canvas.width / this._dpr);
    dim.css.cell.height = dim.device.cell.height / this._dpr;
    dim.css.cell.width = dim.device.cell.width / this._dpr;
  }

  private _refreshCharAtlas(): void {
    const dim = this.dimensions.device;
    if (dim.char.width <= 0 && dim.char.height <= 0) return;
    // Releases this renderer's previous atlas when the config differs, disposing it once no renderer holds it
    this._atlas = acquireTextureAtlas(this._view as never, this._options.rawOptions, this._theme.colors, dim.cell.width, dim.cell.height, dim.char.width, dim.char.height, this._dpr, this._deviceMaxTextureSize);
    this._atlas.warmUp();
    this._glyphs?.setAtlas(this._atlas);
  }

  private _handleFontsLoaded(): void {
    const { width, height } = this.dimensions.css.cell;
    this._charSize.measure();
    this._handleResize();
    // Glyphs drawn before the font arrived are fallback glyphs
    this._atlas?.clearTexture();
    this._clearModel(true);
    if (width !== this.dimensions.css.cell.width || height !== this.dimensions.css.cell.height) this._onDimensionsChange.fire();
    this._requestRedraw('all');
  }

  // Zoom and moving to another screen: the canvas's device pixel size changes, and zoom also resizes the window
  private _checkDevicePixelRatio(): boolean {
    if (this._coreBrowser.dpr === this._dpr) return false;
    // The char atlas needs to be regenerated and the cell size changes
    this._dpr = this._coreBrowser.dpr;
    this._handleResize();
    this._onDimensionsChange.fire();
    this._requestRedraw('all');
    return true;
  }

  private _handleDevicePixels(width: number, height: number): void {
    if (this._checkDevicePixelRatio()) return;
    // While the actual canvas size has changed, keep device canvas dimensions as the value before the change as it's an
    // exact multiple of the cell sizes
    if (this._canvas.width === width && this._canvas.height === height) return;
    this._canvas.width = width;
    this._canvas.height = height;
    this._requestRedraw('all');
  }

  private _initializeWebGLState(): void {
    this._rectangles?.dispose();
    this._glyphs?.dispose();
    this._rectangles = new RectangleRenderer(this._view, this._gl, this.dimensions, this._theme);
    this._glyphs = new GlyphRenderer(this._view, this._gl, this.dimensions, this._options);
    // Update dimensions and acquire the char atlas
    this._handleResize();
  }

  /** Makes a canvas and context, replacing the current canvas in the DOM. */
  private _createContext(): void {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer: false }) as IWebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 not supported');
    // Over the browser's limit, getContext took the oldest context away. Nothing will restore it, so its renderer waits
    // to be handed a context instead of making a new one after the timeout, which would take the next one's.
    for (const r of renderers) {
      if (r !== this && r._state === 'live' && r._gl.isContextLost()) r._contextGone = true;
    }
    this._disposeContext();
    const onLost = (e: Event): void => this._handleContextLost(e);
    const onRestored = (): void => this._handleContextRestored();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    const observer = observeDevicePixelDimensions(canvas, window, (w, h) => this._handleDevicePixels(w, h));
    this._contextDisposables.push(() => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      observer.dispose();
    });
    if (this._canvas?.parentElement) this._canvas.replaceWith(canvas);
    else this._container.appendChild(canvas);
    this._canvas = canvas;
    this._gl = gl;
    this._deviceMaxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this._state = 'live';
    this._contextGone = false;
  }

  private _disposeContext(): void {
    for (const d of this._contextDisposables.splice(0)) d();
  }

  private _handleContextLost(e: Event): void {
    // Prevent the default behavior in order to enable WebGL context restoration
    e.preventDefault();
    if (this._contextGone) {
      this._park();
      return;
    }
    this._state = 'lost';
    // Wait a few seconds to see if the 'webglcontextrestored' event is fired, then make a new context
    this._restoreTimeout = window.setTimeout(() => {
      this._restoreTimeout = undefined;
      if (!this._visible) this._park();
      else this._recreateThrottled();
    }, CONTEXT_RESTORE_TIMEOUT);
  }

  private _handleContextRestored(): void {
    clearTimeout(this._restoreTimeout);
    this._restoreTimeout = undefined;
    if (this._state !== 'lost') return;
    this._state = 'live';
    // The texture atlas and glyph renderer must be fully reinitialized because their contents have been lost
    this._reacquireAtlas();
    this._initializeWebGLState();
    this._requestRedraw('all');
  }

  private _reacquireAtlas(): void {
    removeTerminalFromCache(this._view as never);
    this._atlas = undefined;
  }

  /** Waits without a context. A visible renderer takes one from a renderer out of view, if there is one. */
  private _park(): void {
    this._state = 'parked';
    this._contextGone = false;
    if (this._visible) this._takeContextFromHidden();
  }

  private _takeContextFromHidden(): boolean {
    for (const r of renderers) {
      if (r !== this && r._state === 'live' && !r._visible) {
        r._release();
        this._recreate();
        return true;
      }
    }
    return false;
  }

  /** Gives the context back to the browser, which frees its slot right away. */
  private _release(): void {
    this._contextGone = true;
    this._state = 'parked';
    this._gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private _handleVisibility(visible: boolean): void {
    if (visible === this._visible) return;
    this._visible = visible;
    if (this._disposed) return;
    if (visible && this._state === 'parked') {
      // The pane the user looks at gets drawn, even if that takes the oldest context from another visible pane, which
      // then waits; that only happens again when visibility changes, so it cannot loop
      if (!this._takeContextFromHidden()) this._recreate();
    } else if (!visible && this._state === 'live') {
      for (const r of renderers) {
        if (r._state === 'parked' && r._visible) {
          this._release();
          r._recreate();
          return;
        }
      }
    }
  }

  // Backs off when contexts keep getting lost (a driver that keeps resetting, or contexts outside oxtty taking turns)
  private _recreateThrottled(): void {
    const wait = this._lastRecreate + this._recreateGap - performance.now();
    if (wait <= 0) {
      this._recreate();
      return;
    }
    this._state = 'parked';
    this._recreateTimeout = window.setTimeout(() => {
      this._recreateTimeout = undefined;
      if (this._state === 'parked' && !this._disposed) this._recreate();
    }, wait);
  }

  private _recreate(): void {
    const now = performance.now();
    this._recreateGap = now - this._lastRecreate < 60_000 ? Math.min(this._recreateGap * 2, 60_000) : 1000;
    this._lastRecreate = now;
    clearTimeout(this._restoreTimeout);
    clearTimeout(this._recreateTimeout);
    this._reacquireAtlas();
    this._createContext();
    this._initializeWebGLState();
    this._requestRedraw('all');
  }
}
