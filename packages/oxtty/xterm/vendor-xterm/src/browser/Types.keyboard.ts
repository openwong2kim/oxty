// Borrowed by oxtty: xterm.js src/browser/Types.ts @ 08829c7eb6279dda2a9e86df901353a1a89858ca (npm @xterm/xterm 6.1.0-beta.336), MIT license — vendor-xterm/LICENSE
// Excerpt (original lines cut out as is, see the oxtty note below)
/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// oxtty excerpt: only CustomKeyEventHandler, ICompositionHelper and IBrowser, cut out verbatim (lines 35, 40-58).
// They live apart from the 6.0.0 excerpt in Types.ts so the two versions do not mix in one file.

export type CustomKeyEventHandler = (event: KeyboardEvent) => boolean;

export interface ICompositionHelper {
  readonly isComposing: boolean;
  compositionstart(): void;
  compositionupdate(ev: CompositionEvent): void;
  compositionend(): void;
  updateCompositionElements(dontRecurse?: boolean): void;
  keydown(ev: KeyboardEvent): boolean;
}

export interface IBrowser {
  isNode: boolean;
  userAgent: string;
  platform: string;
  isFirefox: boolean;
  isMac: boolean;
  isIpad: boolean;
  isIphone: boolean;
  isWindows: boolean;
}
