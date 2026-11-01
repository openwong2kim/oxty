// [oxtty stub] Replaces xterm.js src/vs/base/common/event.ts (1778 lines, from VS Code).
// Keeps only Emitter (event, fire, dispose) and the Event type that the copied renderer parts use.
import { IDisposable } from 'vs/base/common/lifecycle';

export type Event<T> = (listener: (e: T) => unknown) => IDisposable;

export class Emitter<T> {
  private _listeners = new Set<(e: T) => unknown>();

  public readonly event: Event<T> = listener => {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  };

  public fire(e: T): void {
    for (const l of this._listeners) l(e);
  }

  public dispose(): void {
    this._listeners.clear();
  }
}
