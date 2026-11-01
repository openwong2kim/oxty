// [oxtty stub] Replaces xterm.js src/browser/services/Services.ts (158 lines, 9 services).
// Interfaces keeping only the members the copied renderer parts actually call. Implementations are in src/renderer/services.ts.
import { ReadonlyColorSet } from 'browser/Types';
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
