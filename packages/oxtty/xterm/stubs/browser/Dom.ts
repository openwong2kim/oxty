// [oxtty stub] Replaces xterm.js src/browser/Dom.ts (178 lines).
// Keeps only addDisposableListener, which the copied CoreBrowserTerminal parts use.
import { IDisposable } from 'vs/base/common/lifecycle';

export function addDisposableListener(node: EventTarget, type: string, handler: (event: any) => void, options?: boolean | AddEventListenerOptions): IDisposable {
  node.addEventListener(type, handler, options);
  return { dispose: () => node.removeEventListener(type, handler, options) };
}
