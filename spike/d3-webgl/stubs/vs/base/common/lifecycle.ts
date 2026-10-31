// [oxty 스텁] xterm.js src/vs/base/common/lifecycle.ts(801줄, VS Code 유래)를 대체한다.
// 복사한 렌더러 부품이 쓰는 Disposable·toDisposable·IDisposable만 둔다.

export interface IDisposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): IDisposable {
  return { dispose: fn };
}

export abstract class Disposable implements IDisposable {
  private readonly _store: IDisposable[] = [];

  protected _register<T extends IDisposable>(d: T): T {
    this._store.push(d);
    return d;
  }

  public dispose(): void {
    for (const d of this._store.splice(0)) d.dispose();
  }
}
