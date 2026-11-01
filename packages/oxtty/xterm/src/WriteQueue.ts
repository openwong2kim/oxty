// Splits writes by time like the xterm.js WriteBuffer: feed the engine only up to TIME_BUDGET_MS per task and
// defer the rest to the next task (setTimeout 0) so large output does not block frames.
// The engine resumes split UTF-8 and escape sequences, so bytes can be cut anywhere; strings are cut between
// UTF-16 surrogate pairs.

const TIME_BUDGET_MS = 12;
const SLICE = 16 * 1024;

export class WriteQueue {
  private _chunks: (string | Uint8Array)[] = [];
  private _callbacks: ((() => void) | undefined)[] = [];
  private _timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * `write` feeds the engine. A `WebAssembly.RuntimeError` from it means the engine crashed and starts over:
   * the chunk is dropped and draining goes on. `onParsed` runs after each whole chunk (before its callback),
   * `onDrained` after each task that fed the engine.
   */
  constructor(
    private readonly _write: (data: string | Uint8Array) => void,
    private readonly _onParsed: () => void,
    private readonly _onDrained: () => void,
  ) {}

  /** `callback` runs once `data` has been fed to the engine, also for empty data (a parse barrier). */
  public write(data: string | Uint8Array, callback?: () => void): void {
    this._chunks.push(data);
    this._callbacks.push(callback);
    this._timer ??= setTimeout(() => this._drain());
  }

  /** Drops pending writes without running their callbacks, like xterm.js. */
  public dispose(): void {
    clearTimeout(this._timer);
    this._timer = undefined;
    this._chunks = [];
    this._callbacks = [];
  }

  private _drain(): void {
    this._timer = undefined;
    const start = performance.now();
    try {
      while (this._chunks.length) {
        const chunk = this._chunks[0];
        let n = Math.min(SLICE, chunk.length);
        if (typeof chunk === 'string' && n < chunk.length && isHighSurrogate(chunk.charCodeAt(n - 1))) n--;
        try {
          if (n) this._write(typeof chunk === 'string' ? chunk.slice(0, n) : chunk.subarray(0, n));
        } catch (err) {
          if (!(err instanceof WebAssembly.RuntimeError)) throw err;
          n = chunk.length;
        }
        if (n === chunk.length) {
          this._chunks.shift();
          const callback = this._callbacks.shift();
          this._onParsed();
          callback?.();
        } else {
          this._chunks[0] = typeof chunk === 'string' ? chunk.slice(n) : chunk.subarray(n);
        }
        if (performance.now() - start >= TIME_BUDGET_MS) break;
      }
    } finally {
      // A throwing callback must not leave the rest of the queue stranded.
      if (this._chunks.length) this._timer ??= setTimeout(() => this._drain());
      this._onDrained();
    }
  }
}

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
