// Selection for the Terminal (M2 step 4). The copied xterm.js 6.1 SelectionService and SelectionModel do the work
// (drag, word, line and column selection, autoscroll, Alt+click cursor moves, the copied text); this file gives them
// their services from oxtty: text and wrapping from `buffer.active` (which reads the engine, PRD D7), trims from the
// engine's `trimmedLines`, and the selection drawn by handing it to the renderer in viewport cells of the last frame.
import { copyHandler, moveTextAreaUnderMouseCursor, rightClickHandler } from 'browser/Clipboard.selection';
import type { ILinkifier2 } from 'browser/Types.selection';
import type { IMouseCoordsService } from 'browser/services/MouseServices';
import { SelectionService } from 'browser/services/SelectionService';
import type { IBuffer, IBufferLine, ICellData } from 'common/buffer/Types';
import { isFirefox, isLinux, isMac } from 'common/Platform';
import type { IMouseStateService } from 'common/services/MouseServices';
import type { IBufferService, ICoreService, IOptionsService } from 'common/services/SelectionServices';
import { Emitter } from 'vs/base/common/event';
import type { Viewport } from '../engine-view';
import type { MouseSelection } from '../mouse/MouseController';
import type { Dimensions, Renderer, SelectionRange } from '../renderer/types';

/** A line of `terminal.buffer.active` (a copy taken by `getLine`). */
interface SelectionBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): { getChars(): string; getCode(): number; getWidth(): number } | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/** What selection reads of `terminal.buffer.active`. */
export interface SelectionBuffer {
  readonly type: 'normal' | 'alternate';
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly length: number;
  getLine(y: number): SelectionBufferLine | undefined;
}

/** What the Terminal hands selection. Everything is read when it is needed, never kept. */
export interface SelectionHost {
  /** The `.xterm` element: copy, the context menu and Alt+click coordinates. */
  readonly element: HTMLElement;
  /** The `.xterm-screen` element: selection coordinates and autoscroll are measured against it. */
  readonly screenElement: HTMLElement;
  /** The hidden textarea the context menu copies from. */
  readonly textarea: HTMLTextAreaElement | undefined;
  /** The engine's size, which `buffer` lines follow (the Viewport catches up on the next frame). */
  readonly cols: number;
  readonly rows: number;
  /** The last frame: where the view is when the selection is drawn. */
  readonly viewport: Viewport;
  /** `Terminal.dimensions`: the renderer may re-measure at any time. */
  readonly dimensions: Dimensions | undefined;
  readonly buffer: SelectionBuffer;
  /** Engine `trimmedLines`, read with `buffer` so both describe the same lines. */
  readonly trimmedLines: number;
  /** Terminal options as set; unset ones take the xterm.js defaults. */
  readonly options: Readonly<Record<string, unknown>>;
  /** Alt+click cursor moves go out as user input; user input clears the selection. */
  readonly coreService: ICoreService;
  /** `Terminal.scrollLines`, for autoscroll while dragging past the top or bottom. */
  scrollLines(amount: number): void;
  /** The selection moved: draw a frame. */
  redraw(): void;
  /** `Terminal.onSelectionChange`. */
  selectionChanged(): void;
}

/** xterm.js 6.1 defaults (common/services/OptionsService.ts) of the options selection reads. */
const DEFAULT_OPTIONS = {
  altClickMovesCursor: true,
  macOptionClickForcesSelection: false,
  mouseEventsRequireAlt: false,
  rightClickSelectsWord: isMac,
  scrollback: 1000,
  wordSeparator: ' ()[]{}\',"`',
};

/** Links are a later step: there is never a link under the mouse, so a double click selects the word. */
const NO_LINKS: ILinkifier2 = {
  currentLink: undefined,
  onShowLinkUnderline: () => ({ dispose: () => {} }),
  onHideLinkUnderline: () => ({ dispose: () => {} }),
  dispose: () => {},
};

/**
 * A row of `buffer.active` and where its content ends. xterm.js keeps empty cells apart from typed spaces and trims
 * only empty ones; the engine shows both as spaces. Here the spaces that end a row are empty, as `translateToString`
 * trims them, unless the row wraps: then the output typed them on its way to the next row, and only a blank last cell
 * before a wide character that starts the next row is empty. That is where the engine leaves the wide character it
 * pushed to the next row (xterm.js leaves the cell empty); a typed space there looks the same and is taken for it.
 */
function readLine(buffer: SelectionBuffer, y: number): { line: SelectionBufferLine; contentEnd: number } | undefined {
  const line = buffer.getLine(y);
  if (!line) return undefined;
  const next = buffer.getLine(y + 1);
  const chars = (x: number): string | undefined => line.getCell(x)?.getChars();
  let contentEnd = line.length;
  if (next?.isWrapped) {
    if (chars(contentEnd - 1) === ' ' && next.getCell(0)?.getWidth() === 2) contentEnd--;
  } else {
    while (contentEnd > 0 && (chars(contentEnd - 1) === ' ' || chars(contentEnd - 1) === '')) contentEnd--;
    // Keep the right half of a wide character that ends the text
    if (contentEnd > 0 && chars(contentEnd) === '') contentEnd++;
  }
  return { line, contentEnd };
}

/** xterm.js `IBufferLine` over a `buffer.active` row; cells past the end are empty, as in xterm.js. */
class BufferLineAdapter implements IBufferLine {
  constructor(private readonly _line: SelectionBufferLine, private readonly _contentEnd: number) {}

  public get length(): number {
    return this._line.length;
  }

  public get isWrapped(): boolean {
    return this._line.isWrapped;
  }

  public loadCell(index: number, cell: ICellData): ICellData {
    const c = this._line.getCell(index);
    cell.chars = this.getString(index);
    cell.width = c?.getWidth() ?? 0;
    return cell;
  }

  public hasWidth(index: number): number {
    return this._line.getCell(index)?.getWidth() ?? 0;
  }

  public getWidth(index: number): number {
    return this.hasWidth(index);
  }

  public getString(index: number): string {
    return this._isEmpty(index) ? '' : this._line.getCell(index)?.getChars() ?? '';
  }

  public getCodePoint(index: number): number {
    return this._isEmpty(index) ? 0 : this._line.getCell(index)?.getCode() ?? 0;
  }

  private _isEmpty(index: number): boolean {
    return index >= this._contentEnd;
  }
}

export class SelectionController implements MouseSelection {
  public readonly service: SelectionService;
  private readonly _onTrim = new Emitter<number>();
  private readonly _onBufferActivate = new Emitter<{ activeBuffer: IBuffer, inactiveBuffer: IBuffer }>();
  private readonly _onResize = new Emitter<{ cols: number, rows: number, colsChanged: boolean, rowsChanged: boolean }>();
  private readonly _buffer: IBuffer;
  private readonly _options: Readonly<typeof DEFAULT_OPTIONS>;
  private readonly _disposables: (() => void)[] = [];
  private _trimmedLines: number;
  private _alternate: boolean;
  private _columnSelect = false;
  /** What the renderer was last given, in viewport cells. */
  private _drawn: SelectionRange | undefined;

  constructor(private readonly _host: SelectionHost, mouseCoordsService: IMouseCoordsService, mouseStateService: IMouseStateService) {
    const host = _host;
    this._options = new Proxy(DEFAULT_OPTIONS, {
      // xterm.js puts the default back for an empty `wordSeparator`
      get: (defaults, key: keyof typeof DEFAULT_OPTIONS) => key === 'wordSeparator' ? host.options[key] || defaults[key] : host.options[key] ?? defaults[key],
    });
    const options = this._options;
    this._trimmedLines = host.trimmedLines;
    this._alternate = host.buffer.type === 'alternate';
    const buffer: IBuffer = this._buffer = {
      get hasScrollback() { return host.buffer.type === 'normal' && options.scrollback > 0; },
      get x() { return host.buffer.cursorX; },
      get y() { return host.buffer.cursorY; },
      get ybase() { return host.buffer.baseY; },
      get ydisp() { return host.buffer.viewportY; },
      lines: {
        get length() { return host.buffer.length; },
        get: index => {
          const row = readLine(host.buffer, index);
          return row && new BufferLineAdapter(row.line, row.contentEnd);
        },
        onTrim: this._onTrim.event,
      },
      translateBufferLineToString: (index, trimRight, startCol, endCol) => {
        const row = readLine(host.buffer, index);
        if (!row) return '';
        return row.line.translateToString(false, startCol, trimRight ? Math.min(endCol ?? row.contentEnd, row.contentEnd) : endCol);
      },
      // xterm.js Buffer.getWrappedRangeForLine
      getWrappedRangeForLine(y) {
        let first = y;
        let last = y;
        while (first > 0 && host.buffer.getLine(first)!.isWrapped) first--;
        while (last + 1 < host.buffer.length && host.buffer.getLine(last + 1)!.isWrapped) last++;
        return { first, last };
      },
    };
    const bufferService: IBufferService = {
      get cols() { return host.cols; },
      get rows() { return host.rows; },
      buffer,
      buffers: { onBufferActivate: this._onBufferActivate.event },
      onResize: this._onResize.event,
    };
    const optionsService: IOptionsService = { rawOptions: options };
    const renderService = {
      get dimensions() { return host.dimensions ?? { css: { canvas: { height: 0 } } }; },
    };
    const coreBrowserService = {
      get window() { return host.element.ownerDocument.defaultView!; },
    };
    this.service = new SelectionService(host.element, host.screenElement, NO_LINKS, bufferService, host.coreService, mouseCoordsService,
      optionsService, mouseStateService, renderService, coreBrowserService);

    const service = this.service;
    for (const disposable of [
      service.onRequestRedraw(e => {
        this._columnSelect = e.columnSelectMode;
        host.redraw();
      }),
      service.onRequestScrollLines(e => host.scrollLines(e.amount)),
      service.onSelectionChange(() => host.selectionChanged()),
      // xterm.js puts a new selection into the textarea on Linux, so a middle click pastes it
      service.onLinuxMouseSelection(text => {
        const textarea = host.textarea;
        if (!textarea) return;
        textarea.value = text;
        textarea.focus();
        textarea.select();
      }),
    ]) this._disposables.push(() => disposable.dispose());

    // The selection parts of xterm.js CoreBrowserTerminal: copy, the context menu, middle click on Linux and the
    // column select cursor.
    const listen = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void): void => {
      target.addEventListener(type, listener);
      this._disposables.push(() => target.removeEventListener(type, listener));
    };
    listen(host.element, 'copy', event => {
      // While the program reports the mouse, copy is left to it
      if (!service.hasSelection) return;
      copyHandler(event, service);
    });
    const rightClick = (event: MouseEvent): void => {
      if (host.textarea) rightClickHandler(event, host.textarea, host.screenElement, service, !!options.rightClickSelectsWord);
    };
    if (isFirefox) {
      // Firefox doesn't appear to fire the contextmenu event on right click
      listen(host.element, 'mousedown', event => event.button === 2 && rightClick(event));
    } else {
      listen(host.element, 'contextmenu', rightClick);
    }
    if (isLinux) {
      listen(host.element, 'auxclick', event => {
        if (event.button === 1 && host.textarea) moveTextAreaUnderMouseCursor(event, host.textarea, host.screenElement);
      });
    }
    listen(host.screenElement, 'mousemove', event => host.element.classList.toggle('column-select', service.shouldColumnSelect(event)));
  }

  public shouldForceSelection(event: MouseEvent): boolean {
    return this.service.shouldForceSelection(event);
  }

  public enable(): void {
    this.service.enable();
  }

  public disable(): void {
    this.service.disable();
  }

  public handleMouseDown(event: MouseEvent): void {
    this.service.handleMouseDown(event);
  }

  /**
   * Follows the engine after it parsed output or changed size: lines that left the top of the scrollback move the
   * selection up (and clear it once it falls off), a switch to or from the alternate screen clears it.
   */
  public sync(): void {
    const trimmedLines = this._host.trimmedLines;
    if (trimmedLines !== this._trimmedLines) {
      const amount = trimmedLines - this._trimmedLines;
      this._trimmedLines = trimmedLines;
      this._onTrim.fire(amount);
    }
    const alternate = this._host.buffer.type === 'alternate';
    if (alternate !== this._alternate) {
      this._alternate = alternate;
      this._onBufferActivate.fire({ activeBuffer: this._buffer, inactiveBuffer: this._buffer });
    }
  }

  /** `Terminal.resize`, after the engine resized: like xterm.js, a change of rows clears the selection. */
  public handleResize(colsChanged: boolean, rowsChanged: boolean): void {
    this.sync();
    this._onResize.fire({ cols: this._host.cols, rows: this._host.rows, colsChanged, rowsChanged });
  }

  /** `Terminal.reset`: the selection is cleared. */
  public reset(): void {
    this.service.reset();
    this.sync();
  }

  /**
   * Hands the selection to the renderer in viewport cells when it or the view moved; call after every
   * `Viewport.apply`. The renderer redraws the rows the selection left and entered.
   */
  public render(renderer: Renderer): void {
    const start = this.service.selectionStart;
    const end = this.service.selectionEnd;
    const viewportY = this._host.viewport.historyLength - this._host.viewport.displayOffset;
    const range: SelectionRange | undefined = start && end && (start[0] !== end[0] || start[1] !== end[1])
      ? { start: [start[0], start[1] - viewportY], end: [end[0], end[1] - viewportY], columnSelect: this._columnSelect }
      : undefined;
    const drawn = this._drawn;
    if (range === drawn || (range && drawn && range.columnSelect === drawn.columnSelect &&
      range.start.every((v, i) => v === drawn.start[i]) && range.end.every((v, i) => v === drawn.end[i]))) return;
    this._drawn = range;
    renderer.setSelection(range);
  }

  /** After an engine crash, which already dropped the renderer's selection: the selection is cleared. */
  public handleCrash(): void {
    this._drawn = undefined;
    this.reset();
  }

  public dispose(): void {
    for (const dispose of this._disposables.splice(0)) dispose();
    this.service.dispose();
    this._onTrim.dispose();
    this._onBufferActivate.dispose();
    this._onResize.dispose();
  }
}
