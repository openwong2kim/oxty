// [oxtty stub] Replaces xterm.js 6.1 src/browser/scrollable/touch.ts (485 lines, VS Code touch gestures).
// MouseService registers a gesture target and listens for gesture events; here no gesture is ever recognised, so touch
// scrolling is off and the mouse paths are unchanged.
import type { IDisposable } from 'common/Lifecycle';

export namespace EventType {
  export const CHANGE = '-xterm-gesturechange';
  export const START = '-xterm-gesturestart';
}

export interface IGestureEvent extends MouseEvent {
  initialTarget: EventTarget | undefined;
  translationX: number;
  translationY: number;
  pageX: number;
  pageY: number;
  clientX: number;
  clientY: number;
  tapCount: number;
}

export class Gesture {
  public static addTarget(_element: HTMLElement): IDisposable {
    return { dispose: () => {} };
  }
}
