// oxty 차용: xterm.js src/browser/Types.ts @ f447274f430fd22513f6adbf9862d19524471c04 (태그 6.0.0), MIT 라이선스 — vendor-xterm/LICENSE
// 발췌(원문 줄만 잘라 옴, 아래 oxty 주석 참고)
/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// oxty 발췌: IColorSet·ReadonlyColorSet·IColorContrastCache·DEFAULT_ANSI_COLORS만 원문 그대로 잘라 왔다(줄 58-88, 180-226).
// ITerminal은 xterm.js 내부 터미널(수십 개 멤버) 대신 SelectionRenderModel이 쓰는 멤버만 둔 스텁이다.
import { IColor } from 'common/Types';
import { channels, css } from 'common/Color';

// [oxty 스텁] 원본은 InternalPassthroughApis & ICoreTerminal을 확장한다.
export interface ITerminal {
  rows: number;
  buffers: { active: { ydisp: number } };
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
