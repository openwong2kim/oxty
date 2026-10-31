// oxty 셀([codepoint, fg, bg, attrs]) → xterm.js 렌더 모델 형식(fg·bg·ext 패킹) 변환.
// xterm.js의 CellData/BufferLine.loadCell 자리를 대신한다.
import { AttributeData } from 'common/buffer/AttributeData';
import { Attributes, BgFlags, FgFlags, UnderlineStyle } from 'common/buffer/Constants';
import { CharData, ICellData } from 'common/Types';

// oxty 패키지의 Attr·ColorKind와 같은 값(packages/oxty/src/index.js)
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

// CellColorResolver·GlyphRenderer가 읽는 ICellData를 oxty 셀 하나로 채운다.
export class OxtyCellData extends AttributeData implements ICellData {
  public content = 0;
  public combinedData = '';
  private _code = 0;
  private _width = 1;

  /**
   * @param chars COMBINING 셀이면 엔진의 rowExtras()로 받은 전체 문자열, 아니면 빈 문자열
   * @param underlineColor rowExtras()의 밑줄 색(oxty 패킹), 없으면 0
   */
  public load(codepoint: number, oxFg: number, oxBg: number, attrs: number, chars: string, underlineColor = 0): void {
    if (attrs & OxAttr.WIDE_SPACER) {
      // 넓은 글자의 뒤 칸: xterm.js처럼 코드 0·폭 0, 색은 유지해 배경 사각형이 이어지게 한다
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
