// [oxtty stub] Replaces xterm.js typings/xterm.d.ts (1957 lines, public API).
// Resolved through the `@xterm/xterm` tsconfig path. Keeps only the members the copied renderer parts reference as types. There is no runtime code.

export type FontWeight = 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | number;

export interface IDisposable {
  dispose(): void;
}

// GlyphRenderer·RectangleRenderer: cols·rows·element, SelectionRenderModel: buffer.active.viewportY
export interface Terminal {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  readonly buffer: { readonly active: { readonly viewportY: number } };
}

// Options read by CharAtlasUtils.generateConfig
export interface ITerminalOptions {
  customGlyphs?: boolean;
  letterSpacing?: number;
  lineHeight?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: FontWeight;
  fontWeightBold?: FontWeight;
  allowTransparency?: boolean;
  drawBoldTextInBrightColors?: boolean;
  minimumContrastRatio?: number;
}
