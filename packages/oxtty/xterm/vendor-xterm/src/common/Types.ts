// Borrowed by oxtty: xterm.js src/common/Types.ts @ f447274f430fd22513f6adbf9862d19524471c04 (tag 6.0.0), MIT license — vendor-xterm/LICENSE
// Excerpt (original lines cut out as is, see the oxtty note below)
/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// oxtty excerpt: only the types the renderer parts use, cut out verbatim (lines 27-29, 39-41, 104-120, 136-220, 419-431).
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

// IntRange from https://stackoverflow.com/a/39495173
type Enumerate<N extends number, Acc extends number[] = []> = Acc['length'] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc['length']]>;
type IntRange<F extends number, T extends number> = Exclude<Enumerate<T>, Enumerate<F>>;

export type ColorIndex = IntRange<0, 256>; // number from 0 to 255
export type AllColorIndex = ColorIndex | SpecialColorIndex;
export const enum SpecialColorIndex {
  FOREGROUND = 256,
  BACKGROUND = 257,
  CURSOR = 258
}
