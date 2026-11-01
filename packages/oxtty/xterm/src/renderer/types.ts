// What the Terminal facade needs from a renderer. The WebGL renderer implements it; the facade owns the
// frame loop (requestAnimationFrame), the engine and the DOM element the canvas goes into.
import type { Viewport } from '../engine-view';

/** Colours as CSS strings, named like xterm.js `ITheme`. Unset entries keep the defaults. */
export interface Theme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black?: string; red?: string; green?: string; yellow?: string;
  blue?: string; magenta?: string; cyan?: string; white?: string;
  brightBlack?: string; brightRed?: string; brightGreen?: string; brightYellow?: string;
  brightBlue?: string; brightMagenta?: string; brightCyan?: string; brightWhite?: string;
  /** Palette entries 16–255. */
  extendedAnsi?: string[];
}

/** The xterm.js options a renderer reads, with xterm.js defaults when unset. */
export interface RendererOptions {
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  fontWeightBold: string | number;
  lineHeight: number;
  letterSpacing: number;
  theme: Theme;
  drawBoldTextInBrightColors: boolean;
  minimumContrastRatio: number;
  customGlyphs: boolean;
  allowTransparency: boolean;
  rescaleOverlappingGlyphs: boolean;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorWidth: number;
  cursorInactiveStyle: 'outline' | 'block' | 'bar' | 'underline' | 'none';
}

/** Selection in viewport cells, end exclusive; `columnSelect` is a rectangle. */
export interface SelectionRange {
  start: [col: number, row: number];
  end: [col: number, row: number];
  columnSelect: boolean;
}

export interface Dimensions {
  /** CSS pixels of one cell and of the whole canvas. */
  css: { cell: { width: number; height: number }; canvas: { width: number; height: number } };
  /** Device pixels (CSS × devicePixelRatio). */
  device: { cell: { width: number; height: number }; canvas: { width: number; height: number } };
}

export interface Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly dimensions: Dimensions;
  /** Re-measures and rebuilds glyphs for the options that change them, then redraws. */
  setOptions(options: Partial<RendererOptions>): void;
  /** Resizes the canvas; the next `render` gets a full frame. */
  resize(cols: number, rows: number): void;
  /**
   * Draws rows that changed: `changed` comes from `Viewport.apply`, `hostDirty` are rows the host changed
   * (selection, blink); `'all'` redraws everything. The renderer reads cells only from `viewport`.
   */
  render(viewport: Viewport, changed: readonly number[], hostDirty?: Iterable<number> | 'all'): void;
  setSelection(selection: SelectionRange | undefined): void;
  /** Focus picks the cursor style (`cursorInactiveStyle`) and runs the blink, which the renderer times itself. */
  setFocused(focused: boolean): void;
  /**
   * `onDimensionsChange`: cell size changed without a call from the host (fonts finished loading,
   * devicePixelRatio changed), so the host can refit. `onRedrawRequest`: the renderer needs a frame without new
   * output (cursor blink, WebGL context restored with `'all'`).
   */
  onDimensionsChange(listener: () => void): () => void;
  onRedrawRequest(listener: (rows: number[] | 'all') => void): () => void;
  dispose(): void;
}
