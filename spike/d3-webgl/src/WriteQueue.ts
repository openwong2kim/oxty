// xterm.js WriteBuffer처럼 쓰기를 시간으로 나눈다: 한 작업에 TIME_BUDGET_MS까지만 엔진에 넣고
// 나머지는 다음 작업(setTimeout 0)으로 미뤄 큰 출력이 프레임을 막지 않게 한다.
// 엔진은 잘린 UTF-8·이스케이프 시퀀스를 이어 받으므로 바이트 어디서 잘라도 된다.
import type { Terminal as OxtyTerminal } from '../../../packages/oxty/dist/index.js';

const TIME_BUDGET_MS = 12;
const SLICE_BYTES = 16 * 1024;

export class WriteQueue {
  private readonly _chunks: Uint8Array[] = [];
  private readonly _done: (() => void)[] = [];
  private _scheduled = false;

  constructor(private readonly _term: OxtyTerminal, private readonly _onWritten: () => void) {}

  /** 엔진에 다 들어가면 풀린다. */
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
