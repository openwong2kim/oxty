// [oxtty stub] Replaces xterm.js src/common/services/Services.ts (396 lines, 22 services).
// Interfaces keeping only the members the copied renderer parts actually call. Implementations are in src/renderer/services.ts.
import type { ITerminalOptions } from '@xterm/xterm';
import { IColor } from 'common/Types';
import { IDisposable } from 'vs/base/common/lifecycle';

export type { ITheme } from '@xterm/xterm';

// ThemeService and CharSizeService take it as a constructor parameter decorator (createDecorator in xterm.js), which does nothing here
export const IOptionsService = (_target: unknown, _key: string | symbol | undefined, _index: number): void => {};
export interface IOptionsService {
  // GlyphRenderer: rescaleOverlappingGlyphs, CellColorResolver: fontSize, CharSizeService: fontFamily·fontSize, ThemeService: theme
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
