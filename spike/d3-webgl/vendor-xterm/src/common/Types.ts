// oxtty 차용: xterm.js src/common/Types.ts @ f447274f430fd22513f6adbf9862d19524471c04 (태그 6.0.0), MIT 라이선스 — vendor-xterm/LICENSE
// 발췌(원문 줄만 잘라 옴, 아래 oxtty 주석 참고)
/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// oxtty 발췌: 렌더러 부품이 쓰는 타입만 원문 그대로 잘라 왔다(줄 27-29, 39-41, 104-120, 136-220).
import { UnderlineStyle } from 'common/buffer/Constants';

export interface IDisposable {
  dispose(): void;
}

export type CursorStyle = 'block' | 'underline' | 'bar';

export type CursorInactiveStyle = 'outline' | 'block' | 'bar' | 'underline' | 'none';

export type CharData = [number, string, number, number];

export interface IColor {
  readonly css: string;
  readonly rgba: number; // 32-bit int with rgba in each byte
}
export type IColorRGB = [number, number, number];

export interface IExtendedAttrs {
  ext: number;
  underlineStyle: UnderlineStyle;
  underlineColor: number;
  underlineVariantOffset: number;
  urlId: number;
  clone(): IExtendedAttrs;
  isEmpty(): boolean;
}

export interface IAttributeData {
  /**
   * "fg" is a 32-bit unsigned integer that stores the foreground color of the cell in the 24 least
   * significant bits and additional flags in the remaining 8 bits.
   */
  fg: number;
  /**
   * "bg" is a 32-bit unsigned integer that stores the background color of the cell in the 24 least
   * significant bits and additional flags in the remaining 8 bits.
   */
  bg: number;
  /**
   * "extended", aka "ext", stores extended attributes beyond those available in fg and bg. This
   * data is optional on a cell and encodes less common data.
   */
  extended: IExtendedAttrs;

  clone(): IAttributeData;

  // flags
  isInverse(): number;
  isBold(): number;
  isUnderline(): number;
  isBlink(): number;
  isInvisible(): number;
  isItalic(): number;
  isDim(): number;
  isStrikethrough(): number;
  isProtected(): number;
  isOverline(): number;

  /**
   * The color mode of the foreground color which determines how to decode {@link getFgColor},
   * possible values include {@link Attributes.CM_DEFAULT}, {@link Attributes.CM_P16},
   * {@link Attributes.CM_P256} and {@link Attributes.CM_RGB}.
   */
  getFgColorMode(): number;
  /**
   * The color mode of the background color which determines how to decode {@link getBgColor},
   * possible values include {@link Attributes.CM_DEFAULT}, {@link Attributes.CM_P16},
   * {@link Attributes.CM_P256} and {@link Attributes.CM_RGB}.
   */
  getBgColorMode(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isAttributeDefault(): boolean;

  /**
   * Gets an integer representation of the foreground color, how to decode the color depends on the
   * color mode {@link getFgColorMode}.
   */
  getFgColor(): number;
  /**
   * Gets an integer representation of the background color, how to decode the color depends on the
   * color mode {@link getBgColorMode}.
   */
  getBgColor(): number;

  // extended attrs
  hasExtendedAttrs(): number;
  updateExtended(): void;
  getUnderlineColor(): number;
  getUnderlineColorMode(): number;
  isUnderlineColorRGB(): boolean;
  isUnderlineColorPalette(): boolean;
  isUnderlineColorDefault(): boolean;
  getUnderlineStyle(): number;
  getUnderlineVariantOffset(): number;
}

/** Cell data */
export interface ICellData extends IAttributeData {
  content: number;
  combinedData: string;
  isCombined(): number;
  getWidth(): number;
  getChars(): string;
  getCode(): number;
  setFromCharData(value: CharData): void;
  getAsCharData(): CharData;
}
