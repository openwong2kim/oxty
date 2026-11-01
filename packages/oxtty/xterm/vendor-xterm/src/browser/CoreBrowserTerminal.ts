// Borrowed by oxtty: xterm.js src/browser/CoreBrowserTerminal.ts @ 08829c7eb6279dda2a9e86df901353a1a89858ca (npm @xterm/xterm 6.1.0-beta.336), MIT license — vendor-xterm/LICENSE
// Excerpt (original lines cut out as is, see the oxtty note below)
/**
 * Copyright (c) 2014 The xterm.js authors. All rights reserved.
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * @license MIT
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 *   The original design remains. The terminal itself
 *   has been extended to include xterm CSI codes, among
 *   other features.
 *
 * Terminal Emulation References:
 *   http://vt100.net/
 *   http://invisible-island.net/xterm/ctlseqs/ctlseqs.txt
 *   http://invisible-island.net/xterm/ctlseqs/ctlseqs.html
 *   http://invisible-island.net/vttest/
 *   http://www.inwap.com/pdp10/ansicode.txt
 *   http://linux.die.net/man/4/console_codes
 *   http://linux.die.net/man/7/urxvt
 */

// oxtty excerpt: the textarea focus, key, keypress, input and paste handling of CoreBrowserTerminal, cut out verbatim
// (lines 64-65, 78, 80, 97-122, 129-130, 138-141, 283-290, 302-361, 410-431, 692-700, 735-741, 841-1058, 1135-1141,
// 1164-1177).
// The class is abstract and extends the lifecycle stub instead of CoreTerminal: the [oxtty stub] block declares the
// members the excerpt reads from the rest of xterm.js, and oxtty's InputController (src/input) provides them.
// The imports are rewritten to this tree's paths; the stubs are in xterm/stubs.
import { paste, handlePasteEvent } from 'browser/Clipboard';
import { CustomKeyEventHandler, IBrowser, ICompositionHelper } from 'browser/Types';
import { addDisposableListener } from 'browser/Dom';
import { IKeyboardService, IRenderService } from 'browser/services/Services';
import * as Browser from 'common/Platform';
import { KeyboardResultType } from 'common/Types';
import { C0 } from 'common/data/EscapeSequences';
import { IBuffer, ICoreService, IOptionsService } from 'common/services/Services';
import { Emitter, type Event as IEvent } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';

// [oxtty stub] The original is `export class CoreBrowserTerminal extends CoreTerminal implements ITerminal`.
export abstract class CoreBrowserTerminal extends Disposable {
  // [oxtty stub] Read by the excerpt; the original gets them from CoreTerminal, its services and the rest of the class.
  public abstract readonly rows: number;
  public abstract readonly cols: number;
  public abstract readonly options: { readonly macOptionIsMeta: boolean; readonly scrollOnUserInput: boolean };
  public abstract readonly optionsService: IOptionsService;
  public abstract readonly coreService: ICoreService;
  public abstract readonly buffer: IBuffer;
  public abstract readonly onRender: IEvent<{ start: number, end: number }>;
  public abstract readonly onCursorMove: IEvent<void>;
  public abstract readonly onResize: IEvent<{ cols: number, rows: number }>;
  public abstract readonly onRequestSendFocus: IEvent<void>;
  protected abstract readonly _keyboardService: IKeyboardService;
  protected abstract readonly _renderService: IRenderService | undefined;
  protected abstract _compositionHelper: ICompositionHelper | undefined;
  public abstract refresh(start: number, end: number): void;
  public abstract scrollLines(disp: number): void;
  public abstract scrollToBottom(disableSmoothScroll?: boolean): void;
  public abstract selectAll(): void;
  public abstract updateCursorStyle(ev: KeyboardEvent | MouseEvent): void;

  // [oxtty stub] What the constructor, open() and _initGlobal() register for input once the textarea is in place
  // (lines 187, 513-514, 574-581 without the render service calls, 378-380), then _bindKeys().
  protected _bindInput(): void {
    this._register(this.onRequestSendFocus(() => this._reportFocus()));
    this._register(addDisposableListener(this.textarea!, 'focus', (ev: FocusEvent) => this._handleTextAreaFocus(ev)));
    this._register(addDisposableListener(this.textarea!, 'blur', () => this._handleTextAreaBlur()));
    this._register(this.onCursorMove(() => this._syncTextArea()));
    this._register(this.onResize(() => this._syncTextArea()));
    const pasteHandlerWrapper = (event: ClipboardEvent): void => handlePasteEvent(event, this.textarea!, this.coreService, this.optionsService);
    this._register(addDisposableListener(this.textarea!, 'paste', pasteHandlerWrapper));
    this._register(addDisposableListener(this.element!, 'paste', pasteHandlerWrapper));
    this._bindKeys();
  }

  public textarea: HTMLTextAreaElement | undefined;
  public element: HTMLElement | undefined;

  public browser: IBrowser = Browser as any;

  private _customKeyEventHandler: CustomKeyEventHandler | undefined;

  /**
   * Records whether the keydown event has already been handled and triggered a data event, if so
   * the keypress event should not trigger a data event but should still print to the textarea so
   * screen readers will announce it.
   */
  private _keyDownHandled: boolean = false;

  /**
   * Records whether a keydown event has occurred since the last keyup event, i.e. whether a key
   * is currently "pressed".
   */
  private _keyDownSeen: boolean = false;

  /**
   * Records whether the keypress event has already been handled and triggered a data event, if so
   * the input event should not trigger a data event but should still print to the textarea so
   * screen readers will announce it.
   */
  private _keyPressHandled: boolean = false;

  /**
   * Records whether there has been a keydown event for a dead key without a corresponding keydown
   * event for the composed/alternative character. If we cancel the keydown event for the dead key,
   * no events will be emitted for the final character.
   */
  private _unprocessedDeadKey: boolean = false;

  private readonly _onKey = this._register(new Emitter<{ key: string, domEvent: KeyboardEvent }>());
  public readonly onKey = this._onKey.event;

  private _onFocus = this._register(new Emitter<void>());
  public get onFocus(): IEvent<void> { return this._onFocus.event; }
  private _onBlur = this._register(new Emitter<void>());
  public get onBlur(): IEvent<void> { return this._onBlur.event; }

  /**
   * Focus the terminal. Delegates focus handling to the terminal's DOM element.
   */
  public focus(): void {
    if (this.textarea) {
      this.textarea.focus({ preventScroll: true });
    }
  }

  /**
   * Binds the desired focus behavior on a given terminal object.
   */
  private _handleTextAreaFocus(ev: FocusEvent): void {
    if (this.coreService.decPrivateModes.sendFocus) {
      this.coreService.triggerDataEvent(C0.ESC + '[I');
    }
    this.element!.classList.add('focus');
    this._showCursor();
    this._onFocus.fire();
  }

  /**
   * Blur the terminal, calling the blur function on the terminal's underlying
   * textarea.
   */
  public blur(): void {
    return this.textarea?.blur();
  }

  /**
   * Binds the desired blur behavior on a given terminal object.
   */
  private _handleTextAreaBlur(): void {
    // Text can safely be removed on blur. Doing it earlier could interfere with
    // screen readers reading it out.
    this.textarea!.value = '';
    this.refresh(this.buffer.y, this.buffer.y);
    if (this.coreService.decPrivateModes.sendFocus) {
      this.coreService.triggerDataEvent(C0.ESC + '[O');
    }
    this.element!.classList.remove('focus');
    this._onBlur.fire();
  }

  private _syncTextArea(): void {
    if (!this.textarea || !this.buffer.isCursorInViewport || this._compositionHelper!.isComposing || !this._renderService) {
      return;
    }
    const cursorY = this.buffer.ybase + this.buffer.y;
    const bufferLine = this.buffer.lines.get(cursorY);
    if (!bufferLine) {
      return;
    }
    const cursorX = Math.min(this.buffer.x, this.cols - 1);
    const cellHeight = this._renderService.dimensions.css.cell.height;
    const width = bufferLine.getWidth(cursorX);
    const cellWidth = this._renderService.dimensions.css.cell.width * width;
    const cursorTop = this.buffer.y * this._renderService.dimensions.css.cell.height;
    const cursorLeft = cursorX * this._renderService.dimensions.css.cell.width;

    // Sync the textarea to the exact position of the composition view so the IME knows where the
    // text is.
    this.textarea.style.left = cursorLeft + 'px';
    this.textarea.style.top = cursorTop + 'px';
    this.textarea.style.width = cellWidth + 'px';
    this.textarea.style.height = cellHeight + 'px';
    this.textarea.style.lineHeight = cellHeight + 'px';
    this.textarea.style.zIndex = '-5';
  }

  /**
   * Apply key handling to the terminal
   */
  private _bindKeys(): void {
    this._register(addDisposableListener(this.textarea!, 'keyup', (ev: KeyboardEvent) => this._keyUp(ev), true));
    this._register(addDisposableListener(this.textarea!, 'keydown', (ev: KeyboardEvent) => this._keyDown(ev), true));
    this._register(addDisposableListener(this.textarea!, 'keypress', (ev: KeyboardEvent) => this._keyPress(ev), true));
    this._register(addDisposableListener(this.textarea!, 'compositionstart', () => {
      // Ensure the textarea is synced to the latest cursor location before composition begins. This
      // is to workaround a problem where highly dynamic TUIs like agentic CLIs reprint agressively
      // would cause the IME to appear in the wrong position. The theory is that when the IME is
      // triggered during a partial render the textarea position becomes locked and will not move
      // until it is hidden and a custom move occurs.
      this._syncTextArea();
      this._compositionHelper!.compositionstart();
      this._compositionHelper!.updateCompositionElements();
    }));
    this._register(addDisposableListener(this.textarea!, 'compositionupdate', (e: CompositionEvent) => this._compositionHelper!.compositionupdate(e)));
    this._register(addDisposableListener(this.textarea!, 'compositionend', () => this._compositionHelper!.compositionend()));
    this._register(addDisposableListener(this.textarea!, 'input', (ev: InputEvent) => this._inputEvent(ev), true));
    this._register(this.onRender(() => this._compositionHelper!.updateCompositionElements()));
  }

  /**
   * Display the cursor element
   */
  private _showCursor(): void {
    if (!this.coreService.isCursorInitialized) {
      this.coreService.isCursorInitialized = true;
      this.refresh(this.buffer.y, this.buffer.y);
    }
  }

  public paste(data: string): void {
    paste(data, this.textarea!, this.coreService, this.optionsService);
  }

  public attachCustomKeyEventHandler(customKeyEventHandler: CustomKeyEventHandler): void {
    this._customKeyEventHandler = customKeyEventHandler;
  }

  /**
   * Handle a keydown [KeyboardEvent].
   *
   * [KeyboardEvent]: https://developer.mozilla.org/en-US/docs/DOM/KeyboardEvent
   */
  protected _keyDown(event: KeyboardEvent): boolean | undefined {
    this._keyDownHandled = false;
    // A modifier-only keydown never produces text, so it must neither arm nor disarm the
    // _keyDownSeen gate of _inputEvent. On macOS (WebKit/WKWebView as well as Safari), an IME's
    // direct-commit of a shifted character (e.g. full-width `？` from Shift+/ with Chinese Pinyin)
    // delivers beforeinput/input before the character's own keydown. With Shift held down, its
    // keydown had already armed the gate, so the first insertText is wrongly deduped and dropped —
    // the user has to press the key twice (#5887, #6144). Keyup of the character resets the flag,
    // which is why only the first press is affected. Leaving an already-armed gate in place keeps
    // a following composed insertText deduped.
    if (!wasModifierKeyOnlyEvent(event)) {
      this._keyDownSeen = true;
    }

    if (this._customKeyEventHandler && this._customKeyEventHandler(event) === false) {
      return false;
    }

    // Ignore composing with Alt key on Mac when macOptionIsMeta is enabled
    const shouldIgnoreComposition = this.browser.isMac && this.options.macOptionIsMeta && event.altKey;

    if (!shouldIgnoreComposition && !this._compositionHelper!.keydown(event)) {
      if (this.options.scrollOnUserInput && this.buffer.ybase !== this.buffer.ydisp) {
        this.scrollToBottom(true);
      }
      return false;
    }

    if (!shouldIgnoreComposition && (event.key === 'Dead' || event.key === 'AltGraph')) {
      this._unprocessedDeadKey = true;
    }

    const result = this._keyboardService.evaluateKeyDown(event);

    this.updateCursorStyle(event);

    if (result.type === KeyboardResultType.PAGE_DOWN || result.type === KeyboardResultType.PAGE_UP) {
      const scrollCount = this.rows - 1;
      this.scrollLines(result.type === KeyboardResultType.PAGE_UP ? -scrollCount : scrollCount);
      event.preventDefault();
      event.stopPropagation();
      return false;
    }

    if (result.type === KeyboardResultType.SELECT_ALL) {
      this.selectAll();
    }

    if (this._isThirdLevelShift(this.browser, event)) {
      return true;
    }

    if (result.cancel) {
      // The event is canceled at the end already, is this necessary?
      event.preventDefault();
      event.stopPropagation();
    }

    if (!result.key) {
      return true;
    }

    // HACK: Process A-Z in the keypress event to fix an issue with macOS IMEs where lower case
    // letters cannot be input while caps lock is on. Skip this hack when using kitty protocol
    // or Win32 input mode as they need to send proper sequences for all key events.
    if (!this._keyboardService.useKitty && !this._keyboardService.useWin32InputMode && event.key && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
      if (event.key.charCodeAt(0) >= 65 && event.key.charCodeAt(0) <= 90) {
        return true;
      }
    }

    if (this._unprocessedDeadKey) {
      this._unprocessedDeadKey = false;
      return true;
    }

    // If ctrl+c or enter is being sent, clear out the textarea. This is done so that screen readers
    // will announce deleted characters. This will not work 100% of the time but it should cover
    // most scenarios.
    if (result.key === C0.ETX || result.key === C0.CR) {
      this.textarea!.value = '';
    }

    const wasModifierOnly = this._keyboardService.useWin32InputMode && wasModifierKeyOnlyEvent(event);
    this._onKey.fire({ key: result.key, domEvent: event });
    this._showCursor();
    this.coreService.triggerDataEvent(result.key, !wasModifierOnly);

    // Cancel events when not in screen reader mode so events don't get bubbled up and handled by
    // other listeners. When screen reader mode is enabled, we don't cancel them (unless ctrl or alt
    // is also depressed) so that the cursor textarea can be updated, which triggers the screen
    // reader to read it.
    if (!this.optionsService.rawOptions.screenReaderMode || event.altKey || event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }

    this._keyDownHandled = true;
  }

  private _isThirdLevelShift(browser: IBrowser, ev: KeyboardEvent): boolean {
    const thirdLevelKey =
      (browser.isMac && !this.options.macOptionIsMeta && ev.altKey && !ev.ctrlKey && !ev.metaKey) ||
      (browser.isWindows && ev.altKey && ev.ctrlKey && !ev.metaKey) ||
      (browser.isWindows && ev.getModifierState('AltGraph'));

    if (ev.type === 'keypress') {
      return thirdLevelKey;
    }

    // Don't invoke for arrows, pageDown, home, backspace, etc. (on non-keypress events)
    return thirdLevelKey && (!ev.keyCode || ev.keyCode > 47);
  }

  protected _keyUp(ev: KeyboardEvent): void {
    this._keyDownSeen = false;

    if (this._customKeyEventHandler && this._customKeyEventHandler(ev) === false) {
      return;
    }

    if (!wasModifierKeyOnlyEvent(ev)) {
      this.focus();
    }

    // Handle key release for Kitty keyboard protocol
    const result = this._keyboardService.evaluateKeyUp(ev);
    if (result?.key) {
      const wasModifierOnly = this._keyboardService.useWin32InputMode && wasModifierKeyOnlyEvent(ev);
      this.coreService.triggerDataEvent(result.key, !wasModifierOnly);
    }

    this.updateCursorStyle(ev);
    this._keyPressHandled = false;
  }

  /**
   * Handle a keypress event.
   * Key Resources:
   *   - https://developer.mozilla.org/en-US/docs/DOM/KeyboardEvent
   * @param ev The keypress event to be handled.
   */
  protected _keyPress(ev: KeyboardEvent): boolean {
    let key;

    this._keyPressHandled = false;

    if (this._keyDownHandled) {
      return false;
    }

    if (this._customKeyEventHandler && this._customKeyEventHandler(ev) === false) {
      return false;
    }

    if (ev.charCode) {
      key = ev.charCode;
    } else if (ev.which === null || ev.which === undefined) {
      key = ev.keyCode;
    } else if (ev.which !== 0 && ev.charCode !== 0) {
      key = ev.which;
    } else {
      return false;
    }

    if (!key || (
      (ev.altKey || ev.ctrlKey || ev.metaKey) && !this._isThirdLevelShift(this.browser, ev)
    )) {
      return false;
    }

    key = String.fromCharCode(key);

    this._onKey.fire({ key, domEvent: ev });
    this._showCursor();
    this.coreService.triggerDataEvent(key, true);

    this._keyPressHandled = true;

    // The key was handled so clear the dead key state, otherwise certain keystrokes like arrow
    // keys could be ignored
    this._unprocessedDeadKey = false;

    return true;
  }

  /**
   * Handle an input event.
   * Key Resources:
   *   - https://developer.mozilla.org/en-US/docs/Web/API/InputEvent
   * @param ev The input event to be handled.
   */
  protected _inputEvent(ev: InputEvent): boolean {
    // Only support emoji IMEs when screen reader mode is disabled as the event must bubble up to
    // support reading out character input which can doubling up input characters
    // Based on these event traces: https://github.com/xtermjs/xterm.js/issues/3679
    if (ev.data && ev.inputType === 'insertText' && (!ev.composed || !this._keyDownSeen) && !this.optionsService.rawOptions.screenReaderMode) {
      if (this._keyPressHandled) {
        return false;
      }

      // The key was handled so clear the dead key state, otherwise certain keystrokes like arrow
      // keys could be ignored
      this._unprocessedDeadKey = false;

      const text = ev.data;
      this.coreService.triggerDataEvent(text, true);
      return true;
    }

    return false;
  }

  private _reportFocus(): void {
    if (this.element?.classList.contains('focus')) {
      this.coreService.triggerDataEvent(C0.ESC + '[I');
    } else {
      this.coreService.triggerDataEvent(C0.ESC + '[O');
    }
  }
}

/**
 * Helpers
 */

function wasModifierKeyOnlyEvent(ev: KeyboardEvent): boolean {
  return ev.keyCode === 16 || // Shift
    ev.keyCode === 17 || // Ctrl
    ev.keyCode === 18 || // Alt
    ev.keyCode === 91 || // Meta (Left)
    ev.keyCode === 92 || // Meta (Right)
    ev.keyCode === 93 || // Meta (Menu)
    ev.keyCode === 224 || // Meta (Firefox)
    ev.key === 'Meta';
}
