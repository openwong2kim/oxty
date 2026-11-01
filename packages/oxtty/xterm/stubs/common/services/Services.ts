// [oxtty stub] Replaces xterm.js src/common/services/Services.ts (396 lines, 22 services).
// Interfaces keeping only the members the copied renderer parts actually call. Implementations are in src/services.ts.
import { IColor } from 'common/Types';

export interface IOptionsService {
  // GlyphRenderer: rescaleOverlappingGlyphs, CellColorResolver: fontSize
  readonly rawOptions: { readonly rescaleOverlappingGlyphs: boolean, readonly fontSize: number };
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
