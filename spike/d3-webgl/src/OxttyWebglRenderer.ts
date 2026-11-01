// A thin renderer that takes the place of xterm.js WebglRenderer.ts.
// Ties together the copied GlyphRenderer, RectangleRenderer, TextureAtlas, RenderModel and CellColorResolver,
// and fills the render model from oxtty rowCells() instead of the buffer (IBufferLine.loadCell).
// Out of scope: character joining (ligatures), the link layer, cursor blinking, context loss recovery, DPR change detection.
import type { CellExtra, Terminal as OxttyTerminal } from '../../../packages/oxtty/dist/index.js';
import type { Terminal as XtermTerminalLike } from '@xterm/xterm';
import { createRenderDimensions } from 'browser/renderer/shared/RendererUtils';
import { IRenderDimensions } from 'browser/renderer/shared/Types';
import { Attributes, NULL_CELL_CODE } from 'common/buffer/Constants';
import { CellColorResolver } from '../../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/CellColorResolver';
import { configEquals, generateConfig } from '../../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/CharAtlasUtils';
import { GlyphRenderer } from '../../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/GlyphRenderer';
import { RectangleRenderer } from '../../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/RectangleRenderer';
import { COMBINED_CHAR_BIT_MASK, RENDER_MODEL_BG_OFFSET, RENDER_MODEL_EXT_OFFSET, RENDER_MODEL_FG_OFFSET, RENDER_MODEL_INDICIES_PER_CELL, RenderModel } from '../../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/RenderModel';
import { TextureAtlas } from '../../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/TextureAtlas';
import { ICharAtlasConfig, IWebGL2RenderingContext } from '../../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/Types';
import { OxttyCellData } from './convert';
import { CoreBrowserServiceStub, createColorSet, DecorationServiceStub, OptionsServiceStub, terminalOptions, ThemeServiceStub, UnicodeServiceStub } from './services';

// Like xterm.js CharAtlasCache, renderers with the same config (font, colors, DPR) share one glyph atlas.
// The wide character record (UnicodeServiceStub) goes with the atlas and is shared too.
const atlasCache: { config: ICharAtlasConfig; atlas: TextureAtlas; unicode: UnicodeServiceStub }[] = [];

function sharedAtlas(config: ICharAtlasConfig): { atlas: TextureAtlas; unicode: UnicodeServiceStub } {
  let entry = atlasCache.find(e => configEquals(e.config, config));
  if (!entry) {
    const unicode = new UnicodeServiceStub();
    entry = { config, atlas: new TextureAtlas(document, config, unicode), unicode };
    atlasCache.push(entry);
  }
  return entry;
}

const ATTR_WIDE = 1 << 12;
const ATTR_COMBINING = 1 << 14;
const ATTR_UNDERLINE_COLOR = 1 << 15;

export class OxttyWebglRenderer {
  public readonly canvas: HTMLCanvasElement;
  private readonly _gl: IWebGL2RenderingContext;
  private readonly _dimensions: IRenderDimensions = createRenderDimensions();
  private readonly _model = new RenderModel();
  private readonly _cell = new OxttyCellData();
  private readonly _view: XtermTerminalLike;

  private readonly _options = new OptionsServiceStub();
  private readonly _theme = new ThemeServiceStub(createColorSet());
  private readonly _unicode: UnicodeServiceStub;
  private readonly _coreBrowser: CoreBrowserServiceStub;
  private readonly _colorResolver: CellColorResolver;
  private readonly _rectangles: RectangleRenderer;
  private readonly _glyphs: GlyphRenderer;
  private readonly _atlas: TextureAtlas;

  /** Turn on `preserveDrawingBuffer` only when the canvas needs to be read (it allocates one more buffer). */
  constructor(private readonly _term: OxttyTerminal, container: HTMLElement, preserveDrawingBuffer = false) {
    const dpr = window.devicePixelRatio || 1;
    this._coreBrowser = new CoreBrowserServiceStub(dpr);
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer });
    if (!gl) throw new Error('WebGL2 not supported');
    this._gl = gl as unknown as IWebGL2RenderingContext;
    container.appendChild(this.canvas);

    // The only members the copied parts read from the xterm.js public Terminal are cols, rows, element and buffer.active.viewportY
    const term = this._term;
    this._view = {
      get cols() { return term.cols; },
      get rows() { return term.rows; },
      element: container,
      buffer: { active: { viewportY: 0 } }
    };

    this._colorResolver = new CellColorResolver(this._view, this._options, this._model.selection, new DecorationServiceStub(), this._coreBrowser, this._theme);
    this._updateDimensions(dpr);
    this._rectangles = new RectangleRenderer(this._view, this._gl, this._dimensions, this._theme);
    this._glyphs = new GlyphRenderer(this._view, this._gl, this._dimensions, this._options);

    this._model.resize(term.cols, term.rows);
    this.canvas.width = this._dimensions.device.canvas.width;
    this.canvas.height = this._dimensions.device.canvas.height;
    this.canvas.style.width = `${this._dimensions.css.canvas.width}px`;
    this.canvas.style.height = `${this._dimensions.css.canvas.height}px`;
    this._rectangles.setDimensions(this._dimensions);
    this._rectangles.handleResize();
    this._glyphs.setDimensions(this._dimensions);
    this._glyphs.handleResize();

    const d = this._dimensions.device;
    const config = generateConfig(d.cell.width, d.cell.height, d.char.width, d.char.height, terminalOptions, this._theme.colors, dpr, this._gl.getParameter(this._gl.MAX_TEXTURE_SIZE));
    ({ atlas: this._atlas, unicode: this._unicode } = sharedAtlas(config));
    this._glyphs.setAtlas(this._atlas);
  }

  // Measures the character size the same way as xterm.js CharSizeService (TextMetricsMeasureStrategy)
  private _updateDimensions(dpr: number): void {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
    ctx.font = `${terminalOptions.fontSize}px ${terminalOptions.fontFamily}`;
    const metrics = ctx.measureText('W'.repeat(32));
    const charWidth = metrics.width / 32;
    const charHeight = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);

    // From here on, the same computation as WebglRenderer._updateDimensions (letterSpacing 0, lineHeight 1)
    const dim = this._dimensions;
    dim.device.char.width = Math.floor(charWidth * dpr);
    dim.device.char.height = Math.ceil(charHeight * dpr);
    dim.device.cell.height = Math.floor(dim.device.char.height * terminalOptions.lineHeight);
    dim.device.char.top = 0;
    dim.device.cell.width = dim.device.char.width;
    dim.device.char.left = 0;
    dim.device.canvas.height = this._term.rows * dim.device.cell.height;
    dim.device.canvas.width = this._term.cols * dim.device.cell.width;
    dim.css.canvas.height = Math.round(dim.device.canvas.height / dpr);
    dim.css.canvas.width = Math.round(dim.device.canvas.width / dpr);
    dim.css.cell.height = dim.device.cell.height / dpr;
    dim.css.cell.width = dim.device.cell.width / dpr;
  }

  /** Reads engine damage, applies only the changed lines to the model, and draws. */
  public render(): void {
    const damage = this._term.takeDamage();
    if (this._glyphs.beginFrame()) {
      this._model.clear();
      this._glyphs.clear();
      this._updateRows(this._allRows());
    } else if (damage.full || damage.scroll > 0) {
      // Glyph vertices contain the cell position, so lines cannot be moved. Revisit every line like xterm.js, but
      // since nothing is cleared, skip cells equal to the render model
      this._updateRows(this._allRows());
    } else {
      this._updateRows(damage.lines);
    }
    this._rectangles.renderBackgrounds();
    this._glyphs.render(this._model);
    this._rectangles.renderCursor();
  }

  private _allRows(): number[] {
    return Array.from({ length: this._term.rows }, (_, i) => i);
  }

  // WebglRenderer._updateModel minus character joiners, selection and cursor blinking
  private _updateRows(lines: number[]): void {
    const term = this._term;
    const cols = term.cols;
    const cell = this._cell;
    const result = this._colorResolver.result;
    const cursor = term.cursor();
    const cursorX = Math.min(cursor.col, cols - 1);
    let lastCursorX = -1;
    let modelUpdated = false;
    this._model.cursor = undefined;

    for (const y of lines) {
      // A non-copying view, so it is valid only until the next engine call (avoids building a line array every frame).
      let cells = term.rowCellsView(y);
      if (!cells) continue;
      // Call rowExtras() once, only for lines with combining characters or underline colors. That call overwrites the view, so fetch it again.
      let extras: Map<number, CellExtra> | undefined;
      for (let x = 0; x < cols; x++) {
        if (cells[x * 4 + 3] & (ATTR_COMBINING | ATTR_UNDERLINE_COLOR)) {
          extras = new Map((term.rowExtras(y) ?? []).map(e => [e.col, e]));
          cells = term.rowCellsView(y)!;
          break;
        }
      }
      this._model.lineLengths[y] = 0;
      for (let x = 0; x < cols; x++) {
        // Resolved background color of the previous cell (GlyphRenderer uses it to decide left-side glyph clipping)
        const lastBg = result.bg;
        const o = x * 4;
        const attrs = cells[o + 3];
        if (attrs & ATTR_WIDE) this._unicode.recordWide(cells[o]);
        const extra = extras?.get(x);
        cell.load(cells[o], cells[o + 1], cells[o + 2], attrs, extra?.text ?? '', extra?.underlineColor ?? 0);

        const chars = cell.getChars();
        let code = cell.getCode();
        const i = ((y * cols) + x) * RENDER_MODEL_INDICIES_PER_CELL;
        this._colorResolver.resolve(cell, x, y, this._dimensions.device.cell.width);

        // Overwrite the cursor cell colors (block cursor)
        if (cursor.visible && y === cursor.line) {
          if (x === cursorX) {
            this._model.cursor = { x: cursorX, y, width: cell.getWidth(), style: cursor.shape, cursorWidth: 1, dpr: this._coreBrowser.dpr };
            lastCursorX = cursorX + cell.getWidth() - 1;
          }
          if (cursor.shape === 'block' && x >= cursorX && x <= lastCursorX) {
            result.fg = Attributes.CM_RGB | (this._theme.colors.cursorAccent.rgba >> 8 & Attributes.RGB_MASK);
            result.bg = Attributes.CM_RGB | (this._theme.colors.cursor.rgba >> 8 & Attributes.RGB_MASK);
          }
        }

        if (code !== NULL_CELL_CODE) this._model.lineLengths[y] = x + 1;

        if (this._model.cells[i] === code &&
            this._model.cells[i + RENDER_MODEL_BG_OFFSET] === result.bg &&
            this._model.cells[i + RENDER_MODEL_FG_OFFSET] === result.fg &&
            this._model.cells[i + RENDER_MODEL_EXT_OFFSET] === result.ext) {
          continue;
        }
        modelUpdated = true;
        if (chars.length > 1) code |= COMBINED_CHAR_BIT_MASK;
        this._model.cells[i] = code;
        this._model.cells[i + RENDER_MODEL_BG_OFFSET] = result.bg;
        this._model.cells[i + RENDER_MODEL_FG_OFFSET] = result.fg;
        this._model.cells[i + RENDER_MODEL_EXT_OFFSET] = result.ext;
        this._glyphs.updateCell(x, y, code, result.bg, result.fg, result.ext, chars, cell.getWidth(), lastBg);
      }
    }
    if (modelUpdated) this._rectangles.updateBackgrounds(this._model);
    this._rectangles.updateCursor(this._model);
  }
}
