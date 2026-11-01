// Borrowed by oxtty: xterm.js src/browser/selection/Types.ts @ 08829c7eb6279dda2a9e86df901353a1a89858ca (npm @xterm/xterm 6.1.0-beta.336), MIT license — vendor-xterm/LICENSE
// Verbatim (unmodified)
/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

export interface ISelectionRedrawRequestEvent {
  start: [number, number] | undefined;
  end: [number, number] | undefined;
  columnSelectMode: boolean;
}

export interface ISelectionRequestScrollLinesEvent {
  amount: number;
  suppressScrollEvent: boolean;
}
