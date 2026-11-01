// Implementations of the xterm.js internal service stubs. The interfaces are in stubs/**/Services.ts.
// The real xterm.js implementations (OptionsService, ThemeService, UnicodeService, DecorationService, CoreBrowserService) are not taken.
import { ICoreBrowserService, IThemeService } from 'browser/services/Services';
import { IColorSet, ReadonlyColorSet, DEFAULT_ANSI_COLORS } from 'browser/Types';
import { ColorContrastCache } from 'browser/ColorContrastCache';
import { css, color } from 'common/Color';
import { IDecorationService, IOptionsService, IUnicodeService } from 'common/services/Services';
import { Emitter } from 'vs/base/common/event';
import type { IDisposable, ITerminalOptions } from '@xterm/xterm';

// Renderer options. Follows the xterm.js defaults, with only the font changed.
// The 0.2 stubs list every option; the spike's renderer parts read only these.
export const terminalOptions = {
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
  rescaleOverlappingGlyphs: false,
  theme: {}
} as unknown as Required<ITerminalOptions> & { rescaleOverlappingGlyphs: boolean };

export class OptionsServiceStub implements IOptionsService {
  public readonly rawOptions = terminalOptions;
  // Options never change in the spike.
  public onSpecificOptionChange(): IDisposable { return { dispose() {} }; }
  public onMultipleOptionChange(): IDisposable { return { dispose() {} }; }
}

// The renderer decides the theme (oxtty D2). The palette is xterm.js DEFAULT_ANSI_COLORS as is.
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

// The oxtty engine has already decided character widths (the WIDE bit). The renderer records wide characters as it reads rows,
// and the atlas queries that result. The xterm.js Unicode width tables (UnicodeV6/V11) are not taken.
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

// There is no decoration API, so nothing is overridden.
export class DecorationServiceStub implements IDecorationService {
  public forEachDecorationAtCell(): void {}
}

export class CoreBrowserServiceStub implements ICoreBrowserService {
  public readonly isFocused = true;
  public readonly window = window;
  constructor(public readonly dpr: number) {}
}
