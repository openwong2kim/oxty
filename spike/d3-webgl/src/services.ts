// xterm.js 내부 서비스 스텁의 구현. 인터페이스는 stubs/**/Services.ts.
// 실제 xterm.js 구현(OptionsService·ThemeService·UnicodeService·DecorationService·CoreBrowserService)은 가져오지 않는다.
import { ICoreBrowserService, IThemeService } from 'browser/services/Services';
import { IColorSet, ReadonlyColorSet, DEFAULT_ANSI_COLORS } from 'browser/Types';
import { ColorContrastCache } from 'browser/ColorContrastCache';
import { css, color } from 'common/Color';
import { IDecorationService, IOptionsService, IUnicodeService } from 'common/services/Services';
import { Emitter } from 'vs/base/common/event';
import type { ITerminalOptions } from '@xterm/xterm';

// 렌더러 옵션. xterm.js 기본값을 따르고 글꼴만 바꿨다.
export const terminalOptions: Required<ITerminalOptions> & { rescaleOverlappingGlyphs: boolean } = {
  customGlyphs: true,
  letterSpacing: 0,
  lineHeight: 1,
  fontFamily: 'Menlo, "Apple SD Gothic Neo", monospace',
  fontSize: 14,
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  allowTransparency: false,
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
  rescaleOverlappingGlyphs: false
};

export class OptionsServiceStub implements IOptionsService {
  public readonly rawOptions = terminalOptions;
}

// 테마는 렌더러가 정한다(oxtty D2). 팔레트는 xterm.js DEFAULT_ANSI_COLORS를 그대로 쓴다.
export function createColorSet(): IColorSet {
  const foreground = css.toColor('#d4d4d4');
  const background = css.toColor('#1e1e1e');
  const selection = css.toColor('#ffffff4d');
  return {
    foreground,
    background,
    cursor: css.toColor('#ffcc00'),
    cursorAccent: background,
    selectionForeground: undefined,
    selectionBackgroundTransparent: selection,
    selectionBackgroundOpaque: color.blend(background, selection),
    selectionInactiveBackgroundTransparent: selection,
    selectionInactiveBackgroundOpaque: color.blend(background, selection),
    scrollbarSliderBackground: selection,
    scrollbarSliderHoverBackground: selection,
    scrollbarSliderActiveBackground: selection,
    overviewRulerBorder: foreground,
    ansi: DEFAULT_ANSI_COLORS.slice(),
    contrastCache: new ColorContrastCache(),
    halfContrastCache: new ColorContrastCache()
  };
}

export class ThemeServiceStub implements IThemeService {
  private readonly _onChangeColors = new Emitter<ReadonlyColorSet>();
  public readonly onChangeColors = this._onChangeColors.event;
  constructor(public readonly colors: ReadonlyColorSet) {}
}

// 글자 폭은 oxtty 엔진이 이미 판정했다(WIDE 비트). 렌더러가 행을 읽으며 넓은 글자를 기록하고,
// 아틀라스는 그 결과를 묻는다. xterm.js의 유니코드 폭 표(UnicodeV6/V11)는 가져오지 않는다.
export class UnicodeServiceStub implements IUnicodeService {
  private readonly _wide = new Set<number>();

  public recordWide(codepoint: number): void {
    this._wide.add(codepoint);
  }

  public wcwidth(codepoint: number): number {
    return this._wide.has(codepoint) ? 2 : 1;
  }

  public getStringCellWidth(s: string): number {
    return this.wcwidth(s.codePointAt(0) ?? 0);
  }
}

// 데코레이션 API가 없으므로 아무것도 덮어쓰지 않는다.
export class DecorationServiceStub implements IDecorationService {
  public forEachDecorationAtCell(): void {}
}

export class CoreBrowserServiceStub implements ICoreBrowserService {
  public readonly isFocused = true;
  constructor(public readonly dpr: number) {}
}
