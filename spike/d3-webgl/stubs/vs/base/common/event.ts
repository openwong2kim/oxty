// [oxty 스텁] xterm.js src/vs/base/common/event.ts(1778줄, VS Code 유래)를 대체한다.
// 복사한 렌더러 부품이 쓰는 Emitter(event·fire·dispose)와 Event 타입만 둔다.
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
