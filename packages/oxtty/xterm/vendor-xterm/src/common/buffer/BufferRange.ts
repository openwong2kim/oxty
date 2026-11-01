// Borrowed by oxtty: xterm.js src/common/buffer/BufferRange.ts @ 08829c7eb6279dda2a9e86df901353a1a89858ca (npm @xterm/xterm 6.1.0-beta.336), MIT license — vendor-xterm/LICENSE
// Verbatim (unmodified)
/**
 * Copyright (c) 2021 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IBufferRange } from '@xterm/xterm';

export function getRangeLength(range: IBufferRange, bufferCols: number): number {
  if (range.start.y > range.end.y) {
    throw new Error(`Buffer range end (${range.end.x}, ${range.end.y}) cannot be before start (${range.start.x}, ${range.start.y})`);
  }
  return bufferCols * (range.end.y - range.start.y) + (range.end.x - range.start.x + 1);
}
