// [oxtty stub] Replaces xterm.js 6.1 src/common/buffer/CellData.ts (the packed cell): the work cell SelectionService
// hands to `IBufferLine.loadCell`, holding only the text and width it reads.
import type { ICellData } from 'common/buffer/Types';

export class CellData implements ICellData {
  public chars = '';
  public width = 0;

  public getWidth(): number {
    return this.width;
  }

  public getChars(): string {
    return this.chars;
  }
}
