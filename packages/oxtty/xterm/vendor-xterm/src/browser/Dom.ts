// Borrowed by oxtty: xterm.js src/browser/Dom.ts @ 08829c7eb6279dda2a9e86df901353a1a89858ca (npm @xterm/xterm 6.1.0-beta.336), MIT license — vendor-xterm/LICENSE
// Excerpt (original lines cut out as is, see the oxtty note below)
/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Minimal DOM helpers for xterm.js browser code.
 */
// oxtty excerpt: getWindow, DomListener and addDisposableListener (lines 11-54), cut out verbatim; the relative import of line 9 is mapped below.
import { IDisposable } from 'common/Lifecycle';

export function getWindow(e: Node | UIEvent | undefined | null): Window {
  const candidateNode = e as Node | undefined | null;
  if (candidateNode?.ownerDocument?.defaultView) {
    return candidateNode.ownerDocument.defaultView;
  }

  const candidateEvent = e as UIEvent | undefined | null;
  if (candidateEvent?.view) {
    return candidateEvent.view;
  }

  return window;
}

class DomListener implements IDisposable {
  private _handler: ((e: any) => void) | null;
  private _node: EventTarget | null;
  private readonly _type: string;
  private readonly _options: boolean | AddEventListenerOptions | undefined;

  constructor(node: EventTarget, type: string, handler: (e: any) => void, options?: boolean | AddEventListenerOptions) {
    this._node = node;
    this._type = type;
    this._handler = handler;
    this._options = options;
    node.addEventListener(type, handler, options);
  }

  public dispose(): void {
    if (!this._node || !this._handler) {
      return;
    }
    this._node.removeEventListener(this._type, this._handler, this._options);
    this._node = null;
    this._handler = null;
  }
}

export function addDisposableListener<K extends keyof GlobalEventHandlersEventMap>(node: EventTarget, type: K, handler: (event: GlobalEventHandlersEventMap[K]) => void, useCapture?: boolean): IDisposable;
export function addDisposableListener(node: EventTarget, type: string, handler: (event: any) => void, useCapture?: boolean): IDisposable;
export function addDisposableListener(node: EventTarget, type: string, handler: (event: any) => void, options: AddEventListenerOptions): IDisposable;
export function addDisposableListener(node: EventTarget, type: string, handler: (event: any) => void, useCaptureOrOptions?: boolean | AddEventListenerOptions): IDisposable {
  return new DomListener(node, type, handler, useCaptureOrOptions);
}
