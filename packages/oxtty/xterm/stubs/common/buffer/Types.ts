// [oxtty stub] Replaces xterm.js 6.1 src/common/buffer/Types.ts (the buffer data model) for the copied selection parts.
// Interfaces keeping only the members SelectionService, SelectionModel and MoveToCell read. Implemented by
// src/selection/SelectionController.ts over `terminal.buffer.active`, which reads the engine (PRD D7).
import type { Event as IEvent } from 'vs/base/common/event';

/** One cell as `IBufferLine.loadCell` fills it. */
export interface ICellData {
  // Written by loadCell
  chars: string;
  width: number;
  // SelectionService: word separators and wide characters
  getWidth(): number;
  getChars(): string;
}

export interface IBufferLine {
  readonly length: number;
  // True when the line continues the one above
  readonly isWrapped: boolean;
  loadCell(index: number, cell: ICellData): ICellData;
  hasWidth(index: number): number;
  getWidth(index: number): number;
  getString(index: number): string;
  getCodePoint(index: number): number;
}

export interface IBuffer {
  // MoveToCell: wheel arrows and row navigation
  readonly hasScrollback: boolean;
  readonly x: number;
  readonly y: number;
  readonly ybase: number;
  readonly ydisp: number;
  readonly lines: {
    readonly length: number;
    get(index: number): IBufferLine | undefined;
    // SelectionService: keeps the selection on its text as the scrollback drops its oldest lines
    readonly onTrim: IEvent<number>;
  };
  translateBufferLineToString(lineIndex: number, trimRight: boolean, startCol?: number, endCol?: number): string;
  getWrappedRangeForLine(y: number): { first: number, last: number };
}
