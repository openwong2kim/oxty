// Borrowed by oxtty: xterm.js src/browser/Types.ts @ 08829c7eb6279dda2a9e86df901353a1a89858ca (npm @xterm/xterm 6.1.0-beta.336), MIT license — vendor-xterm/LICENSE
// Excerpt (original lines cut out as is, see the oxtty note below)
/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// oxtty excerpt: the link and buffer range types SelectionService uses, cut out verbatim (lines 114-161). A separate
// file from Types.ts (the 6.0.0 renderer excerpt). The imports of lines 9 and 11 are mapped to the oxtty modules below.
import { IDisposable } from '@xterm/xterm';
import type { Event as IEvent } from 'vs/base/common/event';

export interface ILinkifierEvent {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cols: number;
  fg: number | undefined;
}

interface ILinkState {
  decorations: ILinkDecorations;
  isHovered: boolean;
}
export interface ILinkWithState {
  link: ILink;
  state?: ILinkState;
}

export interface ILinkifier2 extends IDisposable {
  onShowLinkUnderline: IEvent<ILinkifierEvent>;
  onHideLinkUnderline: IEvent<ILinkifierEvent>;
  readonly currentLink: ILinkWithState | undefined;
}

export interface ILink {
  range: IBufferRange;
  text: string;
  decorations?: ILinkDecorations;
  activate(event: MouseEvent, text: string): void;
  hover?(event: MouseEvent, text: string): void;
  leave?(event: MouseEvent, text: string): void;
  dispose?(): void;
}

export interface ILinkDecorations {
  pointerCursor: boolean;
  underline: boolean;
}

export interface IBufferRange {
  start: IBufferCellPosition;
  end: IBufferCellPosition;
}

export interface IBufferCellPosition {
  x: number;
  y: number;
}
