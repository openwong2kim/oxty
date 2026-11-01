// Keyboard, IME, paste and focus input: the hidden textarea with the key handling copied from xterm.js
// (vendor-xterm/src/browser/CoreBrowserTerminal.ts), wired to the Terminal facade. Encoding reads modes and kitty
// flags from the Viewport through CoreService (PRD D7).
import { CoreBrowserTerminal } from 'browser/CoreBrowserTerminal';
import { CompositionHelper } from 'browser/input/CompositionHelper';
import { KeyboardService } from 'browser/services/KeyboardService';
import { IRenderService } from 'browser/services/Services';
import { ICompositionHelper } from 'browser/Types';
import { IBuffer } from 'common/services/Services';
import { Emitter } from 'vs/base/common/event';
import { Mode } from '../../../src/index.js';
import type { Viewport } from '../engine-view';
import type { Renderer } from '../renderer/types';
import type { Terminal } from '../Terminal';
import { BufferService, CoreService, OptionsService } from './services';

export class InputController extends CoreBrowserTerminal {
  protected readonly _keyboardService: KeyboardService;
  protected _renderService: IRenderService | undefined;
  protected _compositionHelper: ICompositionHelper | undefined;
  private readonly _bufferService: BufferService;
  private readonly _onCursorMove = this._register(new Emitter<void>());
  public readonly onCursorMove = this._onCursorMove.event;
  private readonly _onRequestSendFocus = this._register(new Emitter<void>());
  public readonly onRequestSendFocus = this._onRequestSendFocus.event;
  private _cursor = '';
  private _sendFocus = false;

  constructor(
    private readonly _terminal: Terminal,
    private readonly _viewport: Viewport,
    public readonly coreService: CoreService,
    public readonly optionsService: OptionsService
  ) {
    super();
    this._keyboardService = new KeyboardService(coreService, optionsService);
    this._bufferService = new BufferService(_viewport);
  }

  public get rows(): number {
    return this._terminal.rows;
  }

  public get cols(): number {
    return this._terminal.cols;
  }

  public get options(): { macOptionIsMeta: boolean; scrollOnUserInput: boolean } {
    return this.optionsService.rawOptions;
  }

  public get buffer(): IBuffer {
    return this._bufferService.buffer;
  }

  public get onRender(): Terminal['onRender'] {
    return this._terminal.onRender;
  }

  public get onResize(): Terminal['onResize'] {
    return this._terminal.onResize;
  }

  /** Builds the textarea and the composition view in `helpers` like xterm.js `open`, then binds the input events. */
  public open(element: HTMLElement, helpers: HTMLElement, renderer: Renderer): void {
    const doc = element.ownerDocument;
    this.element = element;
    this._renderService = renderer;
    const textarea = this.textarea = doc.createElement('textarea');
    textarea.classList.add('xterm-helper-textarea');
    textarea.setAttribute('aria-label', 'Terminal input');
    textarea.setAttribute('aria-multiline', 'false');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('spellcheck', 'false');
    textarea.tabIndex = 0;
    this._register(this.optionsService.onSpecificOptionChange('disableStdin', () => textarea.readOnly = this.optionsService.rawOptions.disableStdin));
    textarea.readOnly = this.optionsService.rawOptions.disableStdin;
    helpers.appendChild(textarea);
    const compositionView = doc.createElement('div');
    compositionView.classList.add('composition-view');
    this._compositionHelper = new CompositionHelper(textarea, compositionView, this._bufferService, this.optionsService, this.coreService, renderer);
    helpers.appendChild(compositionView);
    this._bindInput();
  }

  /**
   * After a frame: the textarea follows the cursor cell (xterm.js does this on cursor moves), and turning on focus
   * events reports the current focus, as xterm.js does when it parses `CSI ? 1004 h`.
   */
  public handleFrame(): void {
    const sendFocus = (this._viewport.modes & Mode.FOCUS_EVENTS) !== 0;
    if (sendFocus && !this._sendFocus) this._onRequestSendFocus.fire();
    this._sendFocus = sendFocus;
    const { line, col } = this._viewport.cursor;
    const cursor = `${line},${col}`;
    if (cursor === this._cursor) return;
    this._cursor = cursor;
    this._onCursorMove.fire();
  }

  public refresh(start: number, end: number): void {
    this._terminal.refresh(start, end);
  }

  public scrollLines(disp: number): void {
    this._terminal.scrollLines(disp);
  }

  public scrollToBottom(): void {
    this._terminal.scrollToBottom();
  }

  /** Selection comes with M2 step 4; until then Cmd+A (macOS) selects nothing, as with no selection service. */
  public selectAll(): void {}

  /** The column-select cursor style belongs to selection (M2 step 4). */
  public updateCursorStyle(): void {}
}
