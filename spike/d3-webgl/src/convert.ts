// Converts oxtty cells ([codepoint, fg, bg, attrs]) → the xterm.js render model format (fg/bg/ext packing).
// Takes the place of xterm.js CellData/BufferLine.loadCell.
import { AttributeData } from 'common/buffer/AttributeData';
import { Attributes, BgFlags, FgFlags, UnderlineStyle } from 'common/buffer/Constants';
import { CharData, ICellData } from 'common/Types';

// Same values as Attr and ColorKind in the oxtty package (packages/oxtty/src/index.js)
const enum OxAttr {
  BOLD = 1 << 0, DIM = 1 << 1, ITALIC = 1 << 2, UNDERLINE = 1 << 3,
  DOUBLE_UNDERLINE = 1 << 4, CURLY_UNDERLINE = 1 << 5, DOTTED_UNDERLINE = 1 << 6, DASHED_UNDERLINE = 1 << 7,
  INVERSE = 1 << 8, HIDDEN = 1 << 9, STRIKEOUT = 1 << 10, BLINK = 1 << 11,
  WIDE = 1 << 12, WIDE_SPACER = 1 << 13, COMBINING = 1 << 14
}
const enum OxColor { NAMED = 1, INDEXED = 2, RGB = 3 }

// Alacritty NamedColor: 0~15 ANSI, 256 Foreground, 257 Background, 258 Cursor,
// 259~266 DimBlack~DimWhite, 267 BrightForeground, 268 DimForeground
export function toXtermColor(packed: number): number {
  const value = packed & 0xffffff;
  switch (packed >>> 24) {
    case OxColor.RGB:
      return Attributes.CM_RGB | value;
    case OxColor.INDEXED:
      return (value < 16 ? Attributes.CM_P16 : Attributes.CM_P256) | value;
    default:
      if (value < 16) return Attributes.CM_P16 | value;
      if (value >= 259 && value <= 266) return Attributes.CM_P16 | (value - 259);
      return Attributes.CM_DEFAULT;
  }
}

function underlineStyle(attrs: number): UnderlineStyle {
  if (attrs & OxAttr.CURLY_UNDERLINE) return UnderlineStyle.CURLY;
  if (attrs & OxAttr.DOUBLE_UNDERLINE) return UnderlineStyle.DOUBLE;
  if (attrs & OxAttr.DOTTED_UNDERLINE) return UnderlineStyle.DOTTED;
  if (attrs & OxAttr.DASHED_UNDERLINE) return UnderlineStyle.DASHED;
  if (attrs & OxAttr.UNDERLINE) return UnderlineStyle.SINGLE;
  return UnderlineStyle.NONE;
}

// Fills the ICellData that CellColorResolver and GlyphRenderer read from a single oxtty cell.
export class OxttyCellData extends AttributeData implements ICellData {
  public content = 0;
  public combinedData = '';
  private _code = 0;
  private _width = 1;

  /**
   * @param chars for a COMBINING cell, the full string from the engine's rowExtras(); otherwise an empty string
   * @param underlineColor the underline color from rowExtras() (oxtty packing), or 0 if none
   */
  public load(codepoint: number, oxFg: number, oxBg: number, attrs: number, chars: string, underlineColor = 0): void {
    if (attrs & OxAttr.WIDE_SPACER) {
      // Trailing cell of a wide character: code 0 and width 0 like xterm.js, keeping colors so the background rectangle continues
      this._code = 0;
      this._width = 0;
      this.combinedData = '';
    } else {
      this._code = codepoint;
      this._width = attrs & OxAttr.WIDE ? 2 : 1;
      this.combinedData = chars;
    }
    let fg = toXtermColor(oxFg);
    let bg = toXtermColor(oxBg);
    if (attrs & OxAttr.BOLD) fg |= FgFlags.BOLD;
    if (attrs & OxAttr.INVERSE) fg |= FgFlags.INVERSE;
    if (attrs & OxAttr.HIDDEN) fg |= FgFlags.INVISIBLE;
    if (attrs & OxAttr.STRIKEOUT) fg |= FgFlags.STRIKETHROUGH;
    if (attrs & OxAttr.BLINK) fg |= FgFlags.BLINK;
    if (attrs & OxAttr.DIM) bg |= BgFlags.DIM;
    if (attrs & OxAttr.ITALIC) bg |= BgFlags.ITALIC;
    const style = underlineStyle(attrs);
    this.extended.ext = 0;
    if (style !== UnderlineStyle.NONE) {
      fg |= FgFlags.UNDERLINE;
      if (style !== UnderlineStyle.SINGLE) {
        bg |= BgFlags.HAS_EXTENDED;
        this.extended.underlineStyle = style;
      }
    }
    if (underlineColor) {
      bg |= BgFlags.HAS_EXTENDED;
      this.extended.underlineColor = toXtermColor(underlineColor);
    }
    this.fg = fg;
    this.bg = bg;
  }

  public isCombined(): number {
    return this.combinedData.length > 1 ? 1 : 0;
  }

  public getWidth(): number {
    return this._width;
  }

  public getChars(): string {
    if (this.combinedData) return this.combinedData;
    return this._code ? String.fromCodePoint(this._code) : '';
  }

  public getCode(): number {
    return this._code;
  }

  public setFromCharData(_value: CharData): void {
    throw new Error('not implemented');
  }

  public getAsCharData(): CharData {
    return [this.fg, this.getChars(), this.getWidth(), this.getCode()];
  }
}
