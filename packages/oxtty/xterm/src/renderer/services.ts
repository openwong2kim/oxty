// Implementations of the xterm.js internal service stubs. The interfaces are in stubs/**/Services.ts.
// ThemeService and CharSizeService are the copied xterm.js ones; OptionsService, UnicodeService, DecorationService and
// CoreBrowserService are replaced by the small classes below.
import { ICoreBrowserService } from 'browser/services/Services';
import { IDecorationService, IOptionsService, IUnicodeService } from 'common/services/Services';
import { Emitter } from 'vs/base/common/event';
import type { ITerminalOptions } from '@xterm/xterm';
import type { RendererOptions } from './types';

/** xterm.js defaults (common/services/OptionsService.ts DEFAULT_OPTIONS) for the options a renderer reads. */
export const DEFAULT_OPTIONS: Readonly<RendererOptions> = {
  fontFamily: 'monospace',
  fontSize: 15,
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  lineHeight: 1,
  letterSpacing: 0,
  theme: {},
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
  customGlyphs: true,
  allowTransparency: false,
  rescaleOverlappingGlyphs: false,
  cursorBlink: false,
  cursorStyle: 'block',
  cursorWidth: 1,
  cursorInactiveStyle: 'outline'
};

type RawOptions = RendererOptions & Required<ITerminalOptions>;

export class OptionsService implements IOptionsService {
  public readonly rawOptions: RawOptions;
  private readonly _onOptionChange = new Emitter<keyof RendererOptions>();

  constructor(options: Partial<RendererOptions>) {
    this.rawOptions = { ...DEFAULT_OPTIONS } as RawOptions;
    this.set(options);
  }

  /** Applies `options` and returns the keys whose value changed (listeners have run by then). */
  public set(options: Partial<RendererOptions>): (keyof RendererOptions)[] {
    const changed = (Object.keys(options) as (keyof RendererOptions)[]).filter(k => options[k] !== undefined && options[k] !== this.rawOptions[k]);
    Object.assign(this.rawOptions, ...changed.map(k => ({ [k]: options[k] })));
    for (const k of changed) this._onOptionChange.fire(k);
    return changed;
  }

  public onSpecificOptionChange<T extends keyof ITerminalOptions>(key: T, listener: (arg1: Required<ITerminalOptions>[T]) => any) {
    return this._onOptionChange.event(k => k === key && listener(this.rawOptions[key]));
  }

  public onMultipleOptionChange(keys: (keyof ITerminalOptions)[], listener: () => any) {
    return this._onOptionChange.event(k => (keys as string[]).includes(k) && listener());
  }

  public dispose(): void {
    this._onOptionChange.dispose();
  }
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
  /** Set by the host through `Renderer.setFocused`. */
  public isFocused = false;
  public readonly window = window;
  public get dpr(): number {
    return this.window.devicePixelRatio;
  }
}
