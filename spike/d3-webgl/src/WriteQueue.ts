// Splits writes by time like the xterm.js WriteBuffer: feed the engine only up to TIME_BUDGET_MS per task and
// defer the rest to the next task (setTimeout 0) so large output does not block frames.
// The engine resumes split UTF-8 and escape sequences, so the bytes can be cut anywhere.
import type { Terminal as OxttyTerminal } from '../../../packages/oxtty/dist/index.js';

const TIME_BUDGET_MS = 12;
const SLICE_BYTES = 16 * 1024;

export class WriteQueue {
  private readonly _chunks: Uint8Array[] = [];
  private readonly _done: (() => void)[] = [];
  private _scheduled = false;

  constructor(private readonly _term: OxttyTerminal, private readonly _onWritten: () => void) {}

  /** Resolves once everything has been fed to the engine. */
  public write(data: Uint8Array): Promise<void> {
    return new Promise(resolve => {
      this._chunks.push(data);
      this._done.push(resolve);
      if (!this._scheduled) {
        this._scheduled = true;
        setTimeout(() => this._drain());
      }
    });
  }

  private _drain(): void {
    const start = performance.now();
    while (this._chunks.length) {
      const chunk = this._chunks[0];
      const n = Math.min(SLICE_BYTES, chunk.length);
      this._term.write(chunk.subarray(0, n));
      if (n === chunk.length) {
        this._chunks.shift();
        this._done.shift()!();
      } else {
        this._chunks[0] = chunk.subarray(n);
      }
      if (performance.now() - start >= TIME_BUDGET_MS) break;
    }
    this._onWritten();
    if (this._chunks.length) setTimeout(() => this._drain());
    else this._scheduled = false;
  }
}
