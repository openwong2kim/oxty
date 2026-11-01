// [oxtty stub] Replaces xterm.js src/common/services/Services.ts (396 lines, 22 services).
// Interfaces keeping only the members the copied renderer and input parts actually call. Implementations are in
// src/renderer/services.ts and src/input/services.ts.
import type { ITerminalOptions } from '@xterm/xterm';
import { IColor } from 'common/Types';
import { IDisposable } from 'vs/base/common/lifecycle';

export type { ITheme } from '@xterm/xterm';

// ThemeService, CharSizeService and CompositionHelper take it as a constructor parameter decorator (createDecorator in xterm.js), which does nothing here
export const IOptionsService = (_target: unknown, _key: string | symbol | undefined, _index: number): void => {};
export interface IOptionsService {
  // GlyphRenderer: rescaleOverlappingGlyphs, CellColorResolver: fontSize, CharSizeService: fontFamily·fontSize, ThemeService: theme,
  // CompositionHelper: fontFamily·fontSize, CoreBrowserTerminal: screenReaderMode·disableStdin, Clipboard: ignoreBracketedPasteMode
  readonly rawOptions: Required<ITerminalOptions>;
  // ThemeService: theme·minimumContrastRatio
  onSpecificOptionChange<T extends keyof ITerminalOptions>(key: T, listener: (arg1: Required<ITerminalOptions>[T]) => any): IDisposable;
  // CharSizeService: fontFamily·fontSize
  onMultipleOptionChange(keys: (keyof ITerminalOptions)[], listener: () => any): IDisposable;
}

export interface IUnicodeService {
  // TextureAtlas: used only to size underlines and strikethroughs by character cell count
  wcwidth(codepoint: number): number;
  getStringCellWidth(s: string): number;
}

export interface IDecorationService {
  // CellColorResolver: decoration color overrides
  forEachDecorationAtCell(x: number, y: number, layer: 'bottom' | 'top' | undefined, callback: (decoration: { backgroundColorRGB: IColor | undefined, foregroundColorRGB: IColor | undefined }) => void): void;
}

// CompositionHelper and KeyboardService parameter decorator, like IOptionsService
export const ICoreService = (_target: unknown, _key: string | symbol | undefined, _index: number): void => {};
export interface ICoreService {
  // CoreBrowserTerminal._showCursor
  isCursorInitialized: boolean;
  // KeyboardService (applicationCursorKeys, win32InputMode), Clipboard (bracketedPasteMode), CoreBrowserTerminal focus reports (sendFocus)
  readonly decPrivateModes: { readonly applicationCursorKeys: boolean; readonly bracketedPasteMode: boolean; readonly sendFocus: boolean; readonly win32InputMode: boolean };
  // KeyboardService: the active kitty flags
  readonly kittyKeyboard: { readonly flags: number };
  // Every user input (keys, IME, paste) and every reply
  triggerDataEvent(data: string, wasUserInput?: boolean): void;
}

// The IBuffer members CompositionHelper and CoreBrowserTerminal read: the cursor (x, y relative to ybase) and the scroll position
export interface IBuffer {
  readonly x: number;
  readonly y: number;
  readonly ybase: number;
  readonly ydisp: number;
  readonly isCursorInViewport: boolean;
  // CoreBrowserTerminal._syncTextArea: the width of the cell under the cursor
  readonly lines: { get(index: number): { getWidth(index: number): number } | undefined };
}

// CompositionHelper parameter decorator, like IOptionsService
export const IBufferService = (_target: unknown, _key: string | symbol | undefined, _index: number): void => {};
export interface IBufferService {
  readonly cols: number;
  readonly buffer: IBuffer;
}
