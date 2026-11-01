// xterm.js WebglRenderer.ts 자리를 대신하는 얇은 렌더러.
// 복사한 GlyphRenderer·RectangleRenderer·TextureAtlas·RenderModel·CellColorResolver를 묶고,
// 버퍼(IBufferLine.loadCell) 대신 oxtty rowCells()로 렌더 모델을 채운다.
// 범위 밖: 문자 결합(ligature)·링크 레이어·커서 깜빡임·컨텍스트 손실 복구·DPR 변화 감지.
import type { CellExtra, Terminal as OxttyTerminal } from '../../../packages/oxtty/dist/index.js';
import type { Terminal as XtermTerminalLike } from '@xterm/xterm';
import { createRenderDimensions } from 'browser/renderer/shared/RendererUtils';
import { IRenderDimensions } from 'browser/renderer/shared/Types';
import { Attributes, NULL_CELL_CODE } from 'common/buffer/Constants';
import { CellColorResolver } from '../vendor-xterm/addons/addon-webgl/src/CellColorResolver';
import { configEquals, generateConfig } from '../vendor-xterm/addons/addon-webgl/src/CharAtlasUtils';
import { GlyphRenderer } from '../vendor-xterm/addons/addon-webgl/src/GlyphRenderer';
import { RectangleRenderer } from '../vendor-xterm/addons/addon-webgl/src/RectangleRenderer';
import { COMBINED_CHAR_BIT_MASK, RENDER_MODEL_BG_OFFSET, RENDER_MODEL_EXT_OFFSET, RENDER_MODEL_FG_OFFSET, RENDER_MODEL_INDICIES_PER_CELL, RenderModel } from '../vendor-xterm/addons/addon-webgl/src/RenderModel';
import { TextureAtlas } from '../vendor-xterm/addons/addon-webgl/src/TextureAtlas';
import { ICharAtlasConfig, IWebGL2RenderingContext } from '../vendor-xterm/addons/addon-webgl/src/Types';
import { OxttyCellData } from './convert';
import { CoreBrowserServiceStub, createColorSet, DecorationServiceStub, OptionsServiceStub, terminalOptions, ThemeServiceStub, UnicodeServiceStub } from './services';

// xterm.js CharAtlasCache처럼 설정(글꼴·색·DPR)이 같은 렌더러는 글리프 아틀라스를 하나 쓴다.
// 넓은 글자 기록(UnicodeServiceStub)도 아틀라스에 딸려 함께 쓴다.
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

  /** `preserveDrawingBuffer`는 캔버스를 읽어야 할 때만 켠다(버퍼를 하나 더 잡는다). */
  constructor(private readonly _term: OxttyTerminal, container: HTMLElement, preserveDrawingBuffer = false) {
    const dpr = window.devicePixelRatio || 1;
    this._coreBrowser = new CoreBrowserServiceStub(dpr);
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer });
    if (!gl) throw new Error('WebGL2 not supported');
    this._gl = gl as unknown as IWebGL2RenderingContext;
    container.appendChild(this.canvas);

    // 복사한 부품이 xterm.js 공개 Terminal에서 읽는 멤버는 cols·rows·element·buffer.active.viewportY뿐이다
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

  // xterm.js CharSizeService(TextMetricsMeasureStrategy)와 같은 방식으로 글자 크기를 잰다
  private _updateDimensions(dpr: number): void {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
    ctx.font = `${terminalOptions.fontSize}px ${terminalOptions.fontFamily}`;
    const metrics = ctx.measureText('W'.repeat(32));
    const charWidth = metrics.width / 32;
    const charHeight = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);

    // 이하 WebglRenderer._updateDimensions와 같은 계산(letterSpacing 0, lineHeight 1)
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

  /** 엔진 damage를 읽어 바뀐 줄만 모델에 반영하고 그린다. */
  public render(): void {
    const damage = this._term.takeDamage();
    if (this._glyphs.beginFrame()) {
      this._model.clear();
      this._glyphs.clear();
      this._updateRows(this._allRows());
    } else if (damage.full || damage.scroll > 0) {
      // 글리프 정점에 칸 위치가 들어 있어 줄을 옮길 수 없다. xterm.js처럼 모든 줄을 다시 보되
      // 지우지 않으므로 렌더 모델과 같은 칸은 건너뛴다
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

  // WebglRenderer._updateModel에서 결합 문자(joiner)·선택·커서 깜빡임을 뺀 것
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
      // 복사하지 않는 뷰라 다음 엔진 호출 전까지만 쓴다(프레임마다 줄 배열을 만들지 않게).
      let cells = term.rowCellsView(y);
      if (!cells) continue;
      // 결합 문자·밑줄 색이 있는 줄만 rowExtras()를 한 번 부른다. 그 호출이 뷰를 덮으므로 다시 받는다.
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
        // 앞 칸의 해석된 배경색(GlyphRenderer가 글리프 왼쪽 잘림을 정할 때 쓴다)
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

        // 커서 칸 색 덮어쓰기(블록 커서)
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
