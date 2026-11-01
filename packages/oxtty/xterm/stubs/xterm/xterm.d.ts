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

// Theme colours as CSS strings (ThemeService)
export interface ITheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionForeground?: string;
  selectionBackground?: string;
  selectionInactiveBackground?: string;
  scrollbarSliderBackground?: string;
  scrollbarSliderHoverBackground?: string;
  scrollbarSliderActiveBackground?: string;
  overviewRulerBorder?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
  extendedAnsi?: string[];
}

// Options read by CharAtlasUtils.generateConfig, GlyphRenderer, CharSizeService and ThemeService, and by the input parts
// (KeyboardService, CoreBrowserTerminal, Clipboard)
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
  rescaleOverlappingGlyphs?: boolean;
  theme?: ITheme;
  macOptionIsMeta?: boolean;
  scrollOnUserInput?: boolean;
  disableStdin?: boolean;
  screenReaderMode?: boolean;
  ignoreBracketedPasteMode?: boolean;
  vtExtensions?: { kittyKeyboard?: boolean; win32InputMode?: boolean };
}
