// [oxtty stub] Replaces xterm.js src/browser/services/Services.ts (158 lines, 9 services).
// Interfaces keeping only the members the copied renderer and input parts actually call. Implementations are in
// src/renderer/services.ts and src/input/services.ts.
import { ReadonlyColorSet } from 'browser/Types';
import { IKeyboardResult } from 'common/Types';
import type { Event } from 'vs/base/common/event';

export interface IThemeService {
  // RectangleRenderer·CellColorResolver
  readonly colors: ReadonlyColorSet;
  readonly onChangeColors: Event<ReadonlyColorSet>;
}

export interface ICoreBrowserService {
  // CellColorResolver: dotted underline phase (dpr), selection color (isFocused); CursorBlinkStateManager: window (timers), isFocused
  readonly dpr: number;
  readonly isFocused: boolean;
  readonly window: Window & typeof globalThis;
}

export interface ICharSizeService {
  // Implemented by the copied CharSizeService
  readonly width: number;
  readonly height: number;
  readonly hasValidSize: boolean;
  readonly onCharSizeChange: Event<void>;
  measure(): void;
}

// CompositionHelper parameter decorator (createDecorator in xterm.js), which does nothing here
export const IRenderService = (_target: unknown, _key: string | symbol | undefined, _index: number): void => {};
export interface IRenderService {
  // CompositionHelper and CoreBrowserTerminal._syncTextArea place the composition view and the textarea at the cursor cell
  readonly dimensions: { readonly css: { readonly cell: { readonly width: number; readonly height: number } } };
}

export interface IKeyboardService {
  // CoreBrowserTerminal._keyDown/_keyUp
  evaluateKeyDown(event: KeyboardEvent): IKeyboardResult;
  evaluateKeyUp(event: KeyboardEvent): IKeyboardResult | undefined;
  readonly useKitty: boolean;
  readonly useWin32InputMode: boolean;
}
