// [oxtty stub] Replaces xterm.js src/vs/base/common/lifecycle.ts (801 lines, from VS Code).
// Keeps only Disposable, toDisposable and IDisposable that the copied renderer parts use.

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
