// Mouse reports and the wheel for the Terminal (M2 step 2). The copied xterm.js 6.1 MouseService and
// MouseStateService do the work; this file gives them their services from oxtty: modes from the Viewport (the last
// frame, PRD D7), cells from the renderer dimensions, the cursor and scroll position from `buffer.active`.
import { Mode } from '../../../src/index.js';
import { MouseCoordsService } from 'browser/services/MouseCoordsService';
import { MouseService } from 'browser/services/MouseService';
import type { IMouseCoordsService, IRenderService, ISelectionService } from 'browser/services/MouseServices';
import type { IDisposable } from 'common/Lifecycle';
import { isFirefox, isMac } from 'common/Platform';
import { MouseStateService } from 'common/services/MouseStateService';
import type { IBufferService, ICoreService, IMouseStateService, IOptionsService } from 'common/services/MouseServices';
import { CoreMouseEventType } from 'common/Types.mouse';
import { Emitter } from 'vs/base/common/event';
import type { Viewport } from '../engine-view';
import type { Dimensions } from '../renderer/types';

/** The lines of `terminal.buffer.active` the mouse reads. */
export interface MouseBuffer {
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly length: number;
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string } | undefined;
}

/** What the Terminal hands the mouse. Everything is read when an event comes, never kept. */
export interface MouseHost {
  /** The `.xterm` element, where xterm.js listens for the mouse. */
  readonly element: HTMLElement;
  /** The `.xterm-screen` element: reports are measured against it, and the view scrolls for wheels over it. */
  readonly screenElement: HTMLElement;
  /** The last frame: mouse modes, DECCKM, the alternate screen, cols and rows. */
  readonly viewport: Viewport;
  /** `Terminal.dimensions`: the renderer may re-measure at any time. */
  readonly dimensions: Dimensions | undefined;
  readonly buffer: MouseBuffer;
  /** Terminal options as set; unset ones take the xterm.js defaults. */
  readonly options: Readonly<Record<string, unknown>>;
  /** User input for `onData`, like keys (xterm.js `triggerDataEvent(data, true)`). */
  sendData(data: string): void;
  /** Default-encoding mouse reports for `onBinary` (xterm.js `triggerBinaryEvent`). */
  sendBinary(data: string): void;
  /** `Terminal.scrollLines`: positive scrolls towards the newest output. */
  scrollLines(amount: number): void;
  /** Every mousedown focuses the terminal. */
  focus(): void;
  /** Builds the selection, which shares the mouse coordinates and the reporting state with the mouse. */
  createSelection(mouseCoordsService: IMouseCoordsService, mouseStateService: IMouseStateService): MouseSelection;
}

/**
 * What selection does with the mouse, like xterm.js SelectionService: it sees every mousedown on the element before
 * mouse reporting does, takes the drags reporting leaves (reporting off, or forced by a modifier) and is disabled
 * while reporting is on. Built by `MouseHost.createSelection`.
 */
export interface MouseSelection extends ISelectionService {
  handleMouseDown(event: MouseEvent): void;
  dispose(): void;
}

/** xterm.js 6.1 defaults (common/services/OptionsService.ts) of the options the mouse reads. */
const DEFAULT_OPTIONS = {
  fastScrollSensitivity: 5,
  logLevel: 'info',
  mouseEventsRequireAlt: false,
  scrollback: 1000,
  scrollSensitivity: 1,
};

const NO_DIMENSIONS: Dimensions = {
  css: { cell: { width: 0, height: 0 }, canvas: { width: 0, height: 0 } },
  device: { cell: { width: 0, height: 0 }, canvas: { width: 0, height: 0 } },
};

/** CSS pixels the view scrolls per wheel unit (scrollableElement.ts `SCROLL_WHEEL_SENSITIVITY`). */
const SCROLL_WHEEL_SENSITIVITY = 50;

export class MouseController {
  private readonly _mouseStateService = new MouseStateService();
  private readonly _mouseService: MouseService;
  private readonly _options: Readonly<typeof DEFAULT_OPTIONS>;
  private readonly _onOptionChange = new Emitter<string>();
  private readonly _disposables: IDisposable[] = [];
  private readonly _selection: MouseSelection;
  private _wheelReports = false;
  private _alternate = false;
  /** View scroll position in CSS pixels, kept between wheels like xterm.js `Viewport`. */
  private _scrollTop = 0;
  private _latestYDisp: number | undefined;

  constructor(private readonly _host: MouseHost) {
    const host = _host;
    this._options = new Proxy(DEFAULT_OPTIONS, { get: (defaults, key: keyof typeof DEFAULT_OPTIONS) => host.options[key] ?? defaults[key] });
    const options = this._options;
    const optionsService: IOptionsService = {
      rawOptions: options,
      onSpecificOptionChange: (key, listener) => this._onOptionChange.event(k => k === key && listener(options[key])),
    };
    const renderService: IRenderService = {
      get dimensions() { return host.dimensions ?? NO_DIMENSIONS; },
    };
    const coreService: ICoreService = {
      get decPrivateModes() { return { applicationCursorKeys: (host.viewport.modes & Mode.APP_CURSOR) !== 0 }; },
      triggerDataEvent: data => host.sendData(data),
      triggerBinaryEvent: data => host.sendBinary(data),
    };
    const bufferService: IBufferService = {
      get cols() { return host.viewport.cols; },
      get rows() { return host.viewport.rows; },
      buffer: {
        get hasScrollback() { return !(host.viewport.modes & Mode.ALT_SCREEN) && options.scrollback > 0; },
        get x() { return host.buffer.cursorX; },
        get y() { return host.buffer.cursorY; },
        get ybase() { return host.buffer.baseY; },
        get ydisp() { return host.buffer.viewportY; },
        lines: {
          get length() { return host.buffer.length; },
          get: index => host.buffer.getLine(index),
        },
        translateBufferLineToString: (index, trimRight, startCol, endCol) => host.buffer.getLine(index)?.translateToString(trimRight, startCol, endCol) ?? '',
      },
    };
    const charSizeService = {
      get hasValidSize() { return renderService.dimensions.css.cell.width > 0 && renderService.dimensions.css.cell.height > 0; },
    };
    const mouseCoordsService = new MouseCoordsService(charSizeService, renderService);
    this._selection = host.createSelection(mouseCoordsService, this._mouseStateService);
    const coreBrowserService = {
      get dpr() { return host.element.ownerDocument.defaultView?.devicePixelRatio ?? 1; },
    };
    this._mouseService = new MouseService(renderService, mouseCoordsService, this._mouseStateService, coreService, bufferService,
      optionsService, this._selection, { debug: () => {} }, coreBrowserService);

    this._disposables.push(this._mouseStateService.onProtocolChange(events => this._wheelReports = (events & CoreMouseEventType.WHEEL) !== 0));
    this.syncModes();
    // Selection sees the mousedown first, as in xterm.js where it is bound before the mouse service.
    const onMouseDown = (event: MouseEvent): void => this._selection.handleMouseDown(event);
    const onWheel = (event: WheelEvent): void => this._scrollView(event);
    host.element.addEventListener('mousedown', onMouseDown);
    host.screenElement.addEventListener('wheel', onWheel, { passive: false });
    this._disposables.push(
      { dispose: () => host.element.removeEventListener('mousedown', onMouseDown) },
      { dispose: () => host.screenElement.removeEventListener('wheel', onWheel) },
    );
    this._mouseService.bindMouse({ element: host.element, screenElement: host.screenElement, document: host.element.ownerDocument },
      disposable => this._disposables.push(disposable), () => host.focus());
  }

  /** Follows the mouse modes of the frame just applied to the Viewport; call after every `Viewport.apply`. */
  public syncModes(): void {
    const modes = this._host.viewport.modes;
    const protocol = modes & Mode.MOUSE_X10 ? 'X10' : modes & Mode.MOUSE_MOTION ? 'ANY' : modes & Mode.MOUSE_DRAG ? 'DRAG' : modes & Mode.MOUSE_CLICK ? 'VT200' : 'NONE';
    const encoding = modes & Mode.SGR_PIXELS_MOUSE ? 'SGR_PIXELS' : modes & Mode.SGR_MOUSE ? 'SGR' : 'DEFAULT';
    if (this._mouseStateService.activeProtocol !== protocol) this._mouseStateService.activeProtocol = protocol;
    if (this._mouseStateService.activeEncoding !== encoding) this._mouseStateService.activeEncoding = encoding;
    const alternate = (modes & Mode.ALT_SCREEN) !== 0;
    if (alternate !== this._alternate) {
      // A buffer switch forgets the view position, like xterm.js `Viewport` on buffer activation.
      this._alternate = alternate;
      this._latestYDisp = undefined;
    }
  }

  /** Call when a Terminal option changes (`mouseEventsRequireAlt` rebinds; the rest is read per event). */
  public handleOptionChange(key: string): void {
    this._onOptionChange.fire(key);
  }

  /** `Terminal.attachCustomWheelEventHandler`: returning false keeps a wheel from being reported or sent as arrows. */
  public attachCustomWheelEventHandler(handler: ((event: WheelEvent) => boolean) | undefined): void {
    this._mouseStateService.setCustomWheelEventHandler(handler);
  }

  /** `Terminal.reset`: forgets the last report and partial wheel scrolls. */
  public reset(): void {
    this._mouseService.reset();
  }

  public dispose(): void {
    for (const disposable of this._disposables.splice(0)) disposable.dispose();
    this._selection.dispose();
    this._mouseStateService.dispose();
    this._onOptionChange.dispose();
  }

  /**
   * Scrolls the view like xterm.js 6.1, which hands the wheel to VS Code's SmoothScrollableElement in CSS pixels
   * (browser/Viewport.ts, scrollable/scrollableElement.ts `_handleMouseWheel`): 50 px per wheel unit, Alt multiplies
   * by `fastScrollSensitivity`, and the view lands on the nearest row with the rest kept for the next wheel. Without
   * the scrollbar or smooth scrolling (`smoothScrollDuration` 0, the default). Off while the program takes wheel
   * reports; with nothing to scroll the wheel goes on to MouseService, which sends arrow keys without scrollback.
   */
  private _scrollView(event: WheelEvent): void {
    const dimensions = this._host.dimensions;
    if (event.defaultPrevented || this._wheelReports || !dimensions) return;
    const cellHeight = dimensions.css.cell.height;
    const buffer = this._host.buffer;
    const ydisp = buffer.viewportY;
    // Output or the API moved the view since the last wheel (xterm.js `Viewport._sync`).
    if (ydisp !== this._latestYDisp) this._scrollTop = ydisp * cellHeight;
    let deltaY = wheelUnits(event, event.deltaY, 'wheelDeltaY') * this._options.scrollSensitivity;
    const deltaX = wheelUnits(event, event.deltaX, 'wheelDeltaX') * this._options.scrollSensitivity;
    // Only the predominant axis scrolls, and Shift turns vertical into horizontal off macOS: no horizontal scrolling here.
    if (Math.abs(deltaY) < Math.abs(deltaX) || (!isMac && event.shiftKey)) deltaY = 0;
    if (event.altKey) deltaY *= this._options.fastScrollSensitivity;
    if (!deltaY) return;
    const delta = SCROLL_WHEEL_SENSITIVITY * deltaY;
    const maxScrollTop = Math.max(0, cellHeight * buffer.length - dimensions.css.canvas.height);
    const scrollTop = Math.max(0, Math.min(this._scrollTop - (delta < 0 ? Math.floor(delta) : Math.ceil(delta)), maxScrollTop));
    if (scrollTop === this._scrollTop) return;
    this._scrollTop = scrollTop;
    event.preventDefault();
    event.stopPropagation();
    const row = Math.round(scrollTop / cellHeight);
    if (row !== ydisp) {
      this._latestYDisp = row;
      this._host.scrollLines(row - ydisp);
    }
  }
}

/**
 * Wheel units, positive up or left, like VS Code's `StandardWheelEvent` (scrollable/mouseEvent.ts) for `wheel` events:
 * Chromium's `wheelDelta*` in 120ths (times devicePixelRatio up to Chrome 122), else lines, else 40 px.
 */
function wheelUnits(event: WheelEvent, delta: number, legacy: 'wheelDeltaX' | 'wheelDeltaY'): number {
  const wheelDelta = (event as unknown as Record<string, number | undefined>)[legacy];
  if (wheelDelta !== undefined) {
    const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent);
    return wheelDelta / (chrome && +chrome[1] <= 122 ? 120 * (event.view?.devicePixelRatio ?? 1) : 120);
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return isFirefox && !isMac ? -delta / 3 : -delta;
  return -delta / 40;
}
