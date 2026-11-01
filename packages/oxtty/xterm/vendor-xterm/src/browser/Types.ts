// Borrowed by oxtty: xterm.js src/browser/Types.ts @ f447274f430fd22513f6adbf9862d19524471c04 (tag 6.0.0), MIT license — vendor-xterm/LICENSE
// Excerpt (original lines cut out as is, see the oxtty note below)
/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// oxtty excerpt: only CustomKeyEventHandler, ICompositionHelper, IBrowser, IColorSet, ReadonlyColorSet, IColorContrastCache and DEFAULT_ANSI_COLORS, cut out verbatim (lines 33, 38-56, 58-88, 180-226).
// ITerminal is a stub holding only the members SelectionRenderModel and CharAtlasCache use, instead of the xterm.js internal terminal (dozens of members).
import { IColor } from 'common/Types';
import { channels, css } from 'common/Color';
import { IUnicodeService } from 'common/services/Services';

// [oxtty stub] The original extends InternalPassthroughApis & ICoreTerminal.
export interface ITerminal {
  rows: number;
  buffers: { active: { ydisp: number } };
  unicodeService: IUnicodeService;
}

export type CustomKeyEventHandler = (event: KeyboardEvent) => boolean;

export interface ICompositionHelper {
  readonly isComposing: boolean;
  compositionstart(): void;
  compositionupdate(ev: CompositionEvent): void;
  compositionend(): void;
  updateCompositionElements(dontRecurse?: boolean): void;
  keydown(ev: KeyboardEvent): boolean;
}

export interface IBrowser {
  isNode: boolean;
  userAgent: string;
  platform: string;
  isFirefox: boolean;
  isMac: boolean;
  isIpad: boolean;
  isIphone: boolean;
  isWindows: boolean;
}

export interface IColorSet {
  foreground: IColor;
  background: IColor;
  cursor: IColor;
  cursorAccent: IColor;
  selectionForeground: IColor | undefined;
  selectionBackgroundTransparent: IColor;
  /** The selection blended on top of background. */
  selectionBackgroundOpaque: IColor;
  selectionInactiveBackgroundTransparent: IColor;
  selectionInactiveBackgroundOpaque: IColor;
  scrollbarSliderBackground: IColor;
  scrollbarSliderHoverBackground: IColor;
  scrollbarSliderActiveBackground: IColor;
  overviewRulerBorder: IColor;
  ansi: IColor[];
  /** Maps original colors to colors that respect minimum contrast ratio. */
  contrastCache: IColorContrastCache;
  /** Maps original colors to colors that respect _half_ of the minimum contrast ratio. */
  halfContrastCache: IColorContrastCache;
}

export type ReadonlyColorSet = Readonly<Omit<IColorSet, 'ansi'>> & { ansi: Readonly<Pick<IColorSet, 'ansi'>['ansi']> };

export interface IColorContrastCache {
  clear(): void;
  setCss(bg: number, fg: number, value: string | null): void;
  getCss(bg: number, fg: number): string | null | undefined;
  setColor(bg: number, fg: number, value: IColor | null): void;
  getColor(bg: number, fg: number): IColor | null | undefined;
}

// An IIFE to generate DEFAULT_ANSI_COLORS.
export const DEFAULT_ANSI_COLORS = Object.freeze((() => {
  const colors = [
    // dark:
    css.toColor('#2e3436'),
    css.toColor('#cc0000'),
    css.toColor('#4e9a06'),
    css.toColor('#c4a000'),
    css.toColor('#3465a4'),
    css.toColor('#75507b'),
    css.toColor('#06989a'),
    css.toColor('#d3d7cf'),
    // bright:
    css.toColor('#555753'),
    css.toColor('#ef2929'),
    css.toColor('#8ae234'),
    css.toColor('#fce94f'),
    css.toColor('#729fcf'),
    css.toColor('#ad7fa8'),
    css.toColor('#34e2e2'),
    css.toColor('#eeeeec')
  ];

  // Fill in the remaining 240 ANSI colors.
  // Generate colors (16-231)
  const v = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  for (let i = 0; i < 216; i++) {
    const r = v[(i / 36) % 6 | 0];
    const g = v[(i / 6) % 6 | 0];
    const b = v[i % 6];
    colors.push({
      css: channels.toCss(r, g, b),
      rgba: channels.toRgba(r, g, b)
    });
  }

  // Generate greys (232-255)
  for (let i = 0; i < 24; i++) {
    const c = 8 + i * 10;
    colors.push({
      css: channels.toCss(c, c, c),
      rgba: channels.toRgba(c, c, c)
    });
  }

  return colors;
})());
