// oxtty 차용: xterm.js src/browser/renderer/shared/Types.ts @ f447274f430fd22513f6adbf9862d19524471c04 (태그 6.0.0), MIT 라이선스 — vendor-xterm/LICENSE
// 발췌(원문 줄만 잘라 옴, 아래 oxtty 주석 참고)
/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// oxtty 발췌: IDimensions·IOffset·IRenderDimensions·ISelectionRenderModel만 원문 그대로 잘라 왔다.
import { Terminal } from '@xterm/xterm';
import { ITerminal } from 'browser/Types';


export interface IDimensions {
  width: number;
  height: number;
}

export interface IOffset {
  top: number;
  left: number;
}

export interface IRenderDimensions {
  /**
   * Dimensions measured in CSS pixels (ie. device pixels / device pixel ratio).
   */
  css: {
    canvas: IDimensions;
    cell: IDimensions;
  };
  /**
   * Dimensions measured in actual pixels as rendered to the device.
   */
  device: {
    canvas: IDimensions;
    cell: IDimensions;
    char: IDimensions & IOffset;
  };
}

export interface ISelectionRenderModel {
  readonly hasSelection: boolean;
  readonly columnSelectMode: boolean;
  readonly viewportStartRow: number;
  readonly viewportEndRow: number;
  readonly viewportCappedStartRow: number;
  readonly viewportCappedEndRow: number;
  readonly startCol: number;
  readonly endCol: number;
  readonly selectionStart: [number, number] | undefined;
  readonly selectionEnd: [number, number] | undefined;
  clear(): void;
  update(terminal: ITerminal, start: [number, number] | undefined, end: [number, number] | undefined, columnSelectMode?: boolean): void;
  isCellSelected(terminal: Terminal, x: number, y: number): boolean;
}
