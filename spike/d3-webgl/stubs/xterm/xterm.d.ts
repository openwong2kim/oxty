// [oxtty 스텁] xterm.js typings/xterm.d.ts(1957줄, 공개 API)를 대체한다.
// 복사한 렌더러 부품이 타입으로 참조하는 멤버만 둔다. 런타임 코드는 없다.

declare module '@xterm/xterm' {
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

  // CharAtlasUtils.generateConfig가 읽는 옵션
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
}
