// Implementations of the xterm.js service stubs the copied input parts take (stubs/**/Services.ts). Modes, kitty
// flags and the cursor come from the Viewport, the last frame, never from the engine (PRD D7).
import type { ITerminalOptions } from '@xterm/xterm';
import { IBuffer, IBufferService, ICoreService, IOptionsService } from 'common/services/Services';
import { Emitter } from 'vs/base/common/event';
import { Attr, Mode } from '../../../src/index.js';
import type { Viewport } from '../engine-view';

/** The terminal options as xterm.js `rawOptions`; `fire` tells listeners a key was set. */
export class OptionsService implements IOptionsService {
  private readonly _onOptionChange = new Emitter<string>();

  constructor(public readonly rawOptions: Required<ITerminalOptions>) {}

  public fire(key: string): void {
    this._onOptionChange.fire(key);
  }

  public onSpecificOptionChange<T extends keyof ITerminalOptions>(key: T, listener: (arg1: Required<ITerminalOptions>[T]) => any) {
    return this._onOptionChange.event(k => k === key && listener(this.rawOptions[key]));
  }

  public onMultipleOptionChange(keys: (keyof ITerminalOptions)[], listener: () => any) {
    return this._onOptionChange.event(k => (keys as string[]).includes(k) && listener());
  }

  public dispose(): void {
    this._onOptionChange.dispose();
  }
}

/**
 * Like xterm.js common/services/CoreService.ts: everything for the PTY goes through `triggerDataEvent`, user input
 * and the engine's replies alike, so `disableStdin` silences both as in xterm.js.
 */
export class CoreService implements ICoreService {
  /** The renderer draws the cursor from the start, so `_showCursor` has nothing to do. */
  public isCursorInitialized = true;
  private readonly _onUserInput = new Emitter<void>();
  public readonly onUserInput = this._onUserInput.event;

  constructor(
    private readonly _viewport: Viewport,
    private readonly _options: Required<ITerminalOptions>,
    private readonly _onData: Emitter<string>,
    private readonly _scrollToBottom: () => void
  ) {}

  public get decPrivateModes(): ICoreService['decPrivateModes'] {
    const modes = this._viewport.modes;
    return {
      applicationCursorKeys: !!(modes & Mode.APP_CURSOR),
      bracketedPasteMode: !!(modes & Mode.BRACKETED_PASTE),
      sendFocus: !!(modes & Mode.FOCUS_EVENTS),
      win32InputMode: false,
    };
  }

  public get kittyKeyboard(): ICoreService['kittyKeyboard'] {
    return { flags: this._viewport.kittyFlags };
  }

  public triggerDataEvent(data: string, wasUserInput: boolean = false): void {
    if (this._options.disableStdin) return;
    if (wasUserInput && this._options.scrollOnUserInput && this._viewport.displayOffset !== 0) this._scrollToBottom();
    if (wasUserInput) this._onUserInput.fire();
    this._onData.fire(data);
  }

  public dispose(): void {
    this._onUserInput.dispose();
  }
}

/** The cursor and scroll position in xterm.js buffer terms: `y` is the screen row, `ydisp` the top viewport line. */
export class BufferService implements IBufferService {
  public readonly buffer: IBuffer;

  constructor(private readonly _viewport: Viewport) {
    const viewport = _viewport;
    this.buffer = {
      get x() { return viewport.cursor.col; },
      get y() { return viewport.cursor.line - viewport.displayOffset; },
      get ybase() { return viewport.historyLength; },
      get ydisp() { return viewport.historyLength - viewport.displayOffset; },
      get isCursorInViewport() { return viewport.cursor.line >= 0 && viewport.cursor.line < viewport.rows; },
      lines: {
        get: line => {
          const y = line - this.buffer.ydisp;
          if (y < 0 || y >= viewport.rows) return undefined;
          const row = viewport.row(y);
          return { getWidth: x => row[x * 4 + 3] & Attr.WIDE ? 2 : row[x * 4 + 3] & Attr.WIDE_SPACER ? 0 : 1 };
        },
      },
    };
  }

  public get cols(): number {
    return this._viewport.cols;
  }
}
