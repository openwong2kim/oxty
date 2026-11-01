// The built-in fit: sizes the terminal to its element's parent like @xterm/addon-fit 0.12, which reads only
// the public `dimensions`, `element`, `options` and `resize`, so that addon also works on this Terminal as is.
import type { Terminal } from './Terminal';

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;
// xterm.js keeps this much room for its scrollbar when there is scrollback.
const DEFAULT_SCROLLBAR_WIDTH = 14;

export class FitAddon {
  private _terminal: Terminal | undefined;

  public activate(terminal: Terminal): void {
    this._terminal = terminal;
  }

  public dispose(): void {
    this._terminal = undefined;
  }

  public fit(): void {
    const dims = this.proposeDimensions();
    if (!dims || !this._terminal) return;
    if (dims.cols !== this._terminal.cols || dims.rows !== this._terminal.rows) this._terminal.resize(dims.cols, dims.rows);
  }

  public proposeDimensions(): { cols: number; rows: number } | undefined {
    const parent = this._terminal?.element?.parentElement;
    const cell = this._terminal?.dimensions?.css.cell;
    if (!this._terminal?.element || !parent || !cell || !cell.width || !cell.height) return undefined;
    const { scrollback, scrollbar } = this._terminal.options;
    const scrollbarWidth = scrollback === 0 || scrollbar?.showScrollbar === false ? 0 : scrollbar?.width ?? DEFAULT_SCROLLBAR_WIDTH;
    const view = parent.ownerDocument.defaultView ?? window;
    const px = (style: CSSStyleDeclaration, name: string): number => parseInt(style.getPropertyValue(name), 10) || 0;
    const parentStyle = view.getComputedStyle(parent);
    const style = view.getComputedStyle(this._terminal.element);
    const height = Math.max(0, px(parentStyle, 'height')) - px(style, 'padding-top') - px(style, 'padding-bottom');
    const width = Math.max(0, px(parentStyle, 'width')) - px(style, 'padding-left') - px(style, 'padding-right') - scrollbarWidth;
    return {
      cols: Math.max(MINIMUM_COLS, Math.floor(width / cell.width)),
      rows: Math.max(MINIMUM_ROWS, Math.floor(height / cell.height)),
    };
  }
}
