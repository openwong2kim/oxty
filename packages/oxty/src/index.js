// oxty — terminal emulator engine (Rust → WebAssembly).
// Works in browsers, bundlers (Vite/webpack resolve the .wasm URL) and Node ≥ 18.

const ABI = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @type {any} */
let wasm = null;
let initPromise = null;

/**
 * Loads the WebAssembly module once. Call before creating terminals.
 * @param {URL | string | ArrayBuffer | ArrayBufferView | WebAssembly.Module | Response} [source]
 */
export function init(source) {
  initPromise ??= load(source).catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function load(source) {
  source ??= new URL('./oxty.wasm', import.meta.url);
  let instance;
  if (source instanceof WebAssembly.Module) {
    instance = await WebAssembly.instantiate(source, {});
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    ({ instance } = await WebAssembly.instantiate(source, {}));
  } else {
    const response = typeof Response !== 'undefined' && source instanceof Response
      ? source
      : await fetchWasm(source);
    if (response instanceof Uint8Array) {
      ({ instance } = await WebAssembly.instantiate(response, {}));
    } else if (WebAssembly.instantiateStreaming &&
      response.headers.get('content-type')?.startsWith('application/wasm')) {
      ({ instance } = await WebAssembly.instantiateStreaming(response, {}));
    } else {
      ({ instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {}));
    }
  }
  const abi = instance.exports.oxty_abi();
  if (abi !== ABI) throw new Error(`oxty: wasm ABI ${abi} does not match JS wrapper ABI ${ABI}`);
  wasm = instance.exports;
}

async function fetchWasm(source) {
  const base = globalThis.location?.href ?? import.meta.url;
  const url = source instanceof URL ? source : new URL(String(source), base);
  if (url.protocol === 'file:') {
    // 이름을 변수로 둬서 브라우저 번들러가 node: 모듈을 따라가지 않게 한다.
    const fsModule = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fsModule);
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`oxty: failed to fetch ${url} (${response.status})`);
  return response;
}

function requireWasm() {
  if (!wasm) throw new Error('oxty: call `await init()` before creating a Terminal');
  return wasm;
}

const bytesOut = (len) => new Uint8Array(wasm.memory.buffer, wasm.oxty_out_ptr(), len).slice();
const textOut = (len) => (len <= 0 ? '' : decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.oxty_out_ptr(), len)));
const wordsOut = (n) => (n <= 0 ? new Uint32Array(0) : new Uint32Array(wasm.memory.buffer, wasm.oxty_out32_ptr(), n).slice());

const registry = typeof FinalizationRegistry === 'undefined'
  ? null
  : new FinalizationRegistry((handle) => wasm?.oxty_drop(handle));

/** Cell attribute bits (`rowCells` word 3). */
export const Attr = Object.freeze({
  BOLD: 1 << 0, DIM: 1 << 1, ITALIC: 1 << 2, UNDERLINE: 1 << 3,
  DOUBLE_UNDERLINE: 1 << 4, CURLY_UNDERLINE: 1 << 5, DOTTED_UNDERLINE: 1 << 6, DASHED_UNDERLINE: 1 << 7,
  INVERSE: 1 << 8, HIDDEN: 1 << 9, STRIKEOUT: 1 << 10, BLINK: 1 << 11,
  WIDE: 1 << 12, WIDE_SPACER: 1 << 13, COMBINING: 1 << 14, UNDERLINE_COLOR: 1 << 15, HYPERLINK: 1 << 16,
});

/** Terminal mode bits (`modes()`). */
export const Mode = Object.freeze({
  SHOW_CURSOR: 1 << 0, APP_CURSOR: 1 << 1, APP_KEYPAD: 1 << 2, BRACKETED_PASTE: 1 << 3,
  MOUSE_CLICK: 1 << 4, MOUSE_DRAG: 1 << 5, MOUSE_MOTION: 1 << 6, SGR_MOUSE: 1 << 7,
  FOCUS_EVENTS: 1 << 8, ALT_SCREEN: 1 << 9, ALTERNATE_SCROLL: 1 << 10, LINE_WRAP: 1 << 11,
  INSERT: 1 << 12, ORIGIN: 1 << 13, KITTY_KEYBOARD: 1 << 14,
});

const CURSOR_SHAPES = ['block', 'underline', 'bar'];

/** Packed colour kinds (`rowCells` words 1 and 2). */
export const ColorKind = Object.freeze({ NAMED: 1, INDEXED: 2, RGB: 3 });

/**
 * @param {number} packed
 * @returns {{ kind: 'named' | 'indexed' | 'rgb', value: number }}
 */
export function decodeColor(packed) {
  const kind = packed >>> 24;
  const value = packed & 0xffffff;
  return { kind: kind === ColorKind.RGB ? 'rgb' : kind === ColorKind.INDEXED ? 'indexed' : 'named', value };
}

export class Terminal {
  #h;
  // 렌더러가 칸마다 읽으므로 wasm을 부르지 않게 크기를 들고 있다(resize 때만 바뀐다)
  #cols = 0;
  #rows = 0;
  #inPtr = 0;
  #inCap = 0;
  #syncTimer = null;
  #syncTimeoutMs;
  #onSyncFlush;

  /**
   * @param {{ cols?: number, rows?: number, scrollback?: number, syncTimeoutMs?: number, onSyncFlush?: () => void }} [options]
   */
  constructor({ cols = 80, rows = 24, scrollback = 1000, syncTimeoutMs = 150, onSyncFlush } = {}) {
    const w = requireWasm();
    this.#h = w.oxty_new(cols, rows, scrollback);
    this.#readSize();
    this.#syncTimeoutMs = syncTimeoutMs;
    this.#onSyncFlush = onSyncFlush;
    registry?.register(this, this.#h, this);
  }

  #handle() {
    if (!this.#h) throw new Error('oxty: terminal is disposed');
    return this.#h;
  }

  /** Feeds program output. Strings are encoded as UTF-8. */
  write(data) {
    const h = this.#handle();
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (!bytes.length) return;
    if (bytes.length > this.#inCap) {
      if (this.#inPtr) wasm.oxty_free(this.#inPtr, this.#inCap);
      this.#inCap = Math.max(bytes.length, 4096);
      this.#inPtr = wasm.oxty_alloc(this.#inCap);
    }
    new Uint8Array(wasm.memory.buffer, this.#inPtr, bytes.length).set(bytes);
    wasm.oxty_feed(h, this.#inPtr, bytes.length);
    this.#armSync();
  }

  // Synchronized output (CSI ? 2026 h) holds the screen until the program
  // ends it; if it never does, flush after a timeout like other terminals.
  #armSync() {
    const pending = wasm.oxty_sync_pending(this.#h) === 1;
    if (pending && !this.#syncTimer) {
      this.#syncTimer = setTimeout(() => {
        this.#syncTimer = null;
        if (this.#h && wasm.oxty_sync_pending(this.#h) === 1) {
          wasm.oxty_flush_sync(this.#h);
          this.#onSyncFlush?.();
        }
      }, this.#syncTimeoutMs);
    } else if (!pending && this.#syncTimer) {
      clearTimeout(this.#syncTimer);
      this.#syncTimer = null;
    }
  }

  #readSize() {
    this.#cols = wasm.oxty_cols(this.#h);
    this.#rows = wasm.oxty_rows(this.#h);
  }

  resize(cols, rows) {
    wasm.oxty_resize(this.#handle(), cols, rows);
    this.#readSize();
  }

  get cols() { this.#handle(); return this.#cols; }
  get rows() { this.#handle(); return this.#rows; }
  /** Scrollback lines; address them as rows -1 (newest) … -historyLength (oldest). */
  get historyLength() { return wasm.oxty_history_len(this.#handle()); }

  /** @returns {string | null} */
  rowText(line) {
    const n = wasm.oxty_row_text(this.#handle(), line);
    return n < 0 ? null : textOut(n);
  }

  /** `[codepoint, fg, bg, attrs]` per cell. @returns {Uint32Array | null} */
  rowCells(line) {
    const n = wasm.oxty_row_cells(this.#handle(), line);
    return n < 0 ? null : wordsOut(n * 4);
  }

  /**
   * Like `rowCells`, but a view into WebAssembly memory instead of a copy:
   * valid only until the next call into any terminal. For renderers that read
   * every visible row each frame. @returns {Uint32Array | null}
   */
  rowCellsView(line) {
    const n = wasm.oxty_row_cells(this.#handle(), line);
    return n < 0 ? null : new Uint32Array(wasm.memory.buffer, wasm.oxty_out32_ptr(), n * 4);
  }

  rowWrapped(line) {
    return wasm.oxty_row_wrapped(this.#handle(), line) === 1;
  }

  /** Cell text including combining marks. @returns {string | null} */
  cellText(line, col) {
    const n = wasm.oxty_cell_text(this.#handle(), line, col);
    return n < 0 ? null : textOut(n);
  }

  /** Cells with combining marks, an underline colour or a hyperlink. */
  rowExtras(line) {
    const n = wasm.oxty_row_extras(this.#handle(), line);
    if (n < 0) return null;
    if (n === 0) return [];
    const words = wordsOut(n * 4);
    const bytes = new Uint8Array(wasm.memory.buffer, wasm.oxty_out_ptr(), wasm.oxty_out_len()).slice();
    let at = 0;
    const texts = [];
    for (let i = 0; i < n; i++) {
      const len = words[i * 4 + 2];
      texts.push(len ? decoder.decode(bytes.subarray(at, at + len)) : undefined);
      at += len;
    }
    // 텍스트 뒤에는 이 줄의 링크가 `id \0 uri \0` 순서로 온다.
    const parts = decoder.decode(bytes.subarray(at)).split('\0');
    const links = [];
    for (let i = 0; i + 1 < parts.length; i += 2) links.push(Object.freeze({ id: parts[i], uri: parts[i + 1] }));
    const extras = [];
    for (let i = 0; i < n; i++) {
      const e = { col: words[i * 4] };
      if (texts[i] !== undefined) e.text = texts[i];
      if (words[i * 4 + 1]) e.underlineColor = words[i * 4 + 1];
      if (words[i * 4 + 3]) e.hyperlink = links[words[i * 4 + 3] - 1];
      extras.push(e);
    }
    return extras;
  }

  cursor() {
    const h = this.#handle();
    const c = wasm.oxty_cursor(h);
    const style = wasm.oxty_cursor_style(h);
    return {
      line: (c >>> 16) & 0x7fff,
      col: c & 0xffff,
      visible: c >>> 31 === 1,
      shape: CURSOR_SHAPES[style & 0xff] ?? 'block',
      blink: (style >>> 8) === 1,
    };
  }

  /** Rows the view is scrolled back into history (0 = following output). */
  get displayOffset() { return wasm.oxty_display_offset(this.#handle()); }

  /** Positive `delta` scrolls back into history; clamped. Damage becomes full when the view moves. */
  scrollDisplay(delta) {
    wasm.oxty_scroll_display(this.#handle(), delta);
  }

  scrollToBottom() {
    wasm.oxty_scroll_to_bottom(this.#handle());
  }

  modes() {
    return wasm.oxty_modes(this.#handle());
  }

  /** Viewport changes since the last call: move drawn rows up by `scroll`, then redraw `lines`. */
  takeDamage() {
    const n = wasm.oxty_take_damage(this.#handle());
    if (n < 0) return { full: true, scroll: 0, lines: [] };
    const words = wordsOut(n + 1);
    return { full: false, scroll: words[0], lines: Array.from(words.subarray(1)) };
  }

  /** Bytes to write back to the PTY (status reports, …). */
  takeReplies() {
    const n = wasm.oxty_take_replies(this.#handle());
    return n === 0 ? new Uint8Array(0) : bytesOut(n);
  }

  /** @returns {string | null} new title, or null if unchanged */
  takeTitle() {
    const n = wasm.oxty_take_title(this.#handle());
    return n < 0 ? null : textOut(n);
  }

  takeBells() {
    return wasm.oxty_take_bells(this.#handle());
  }

  syncPending() {
    return wasm.oxty_sync_pending(this.#handle()) === 1;
  }

  flushSync() {
    wasm.oxty_flush_sync(this.#handle());
    this.#armSync();
  }

  /** Bytes that rebuild this screen in a fresh xterm.js, or why they cannot. */
  ansiSnapshot() {
    const n = wasm.oxty_ansi_snapshot(this.#handle());
    return n > 0 ? { ok: true, payload: bytesOut(n) } : { ok: false, reason: textOut(-n) };
  }

  dispose() {
    if (!this.#h) return;
    if (this.#syncTimer) clearTimeout(this.#syncTimer);
    if (this.#inPtr) wasm.oxty_free(this.#inPtr, this.#inCap);
    wasm.oxty_drop(this.#h);
    registry?.unregister(this);
    this.#h = 0;
    this.#inPtr = 0;
    this.#inCap = 0;
  }
}
