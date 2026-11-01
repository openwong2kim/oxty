// oxtty — terminal emulator engine (Rust → WebAssembly).
// Works in browsers, bundlers (Vite/webpack resolve the .wasm URL) and Node ≥ 18.

const ABI = 5;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Input buffer: smallest allocation, and the largest one kept between writes.
const IN_MIN = 4096;
const IN_KEEP = 256 * 1024;

/** @type {any} */
let wasm = null;
let initPromise = null;
// The compiled module, kept to rebuild the instance after a trap.
let wasmModule = null;
// Bumped each time the instance is rebuilt; terminals from an older one start over.
let generation = 0;

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
  source ??= new URL('./oxtty.wasm', import.meta.url);
  let module;
  let instance;
  if (source instanceof WebAssembly.Module) {
    module = source;
    instance = await WebAssembly.instantiate(source, {});
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    ({ module, instance } = await WebAssembly.instantiate(source, {}));
  } else {
    const response = typeof Response !== 'undefined' && source instanceof Response
      ? source
      : await fetchWasm(source);
    if (response instanceof Uint8Array) {
      ({ module, instance } = await WebAssembly.instantiate(response, {}));
    } else if (WebAssembly.instantiateStreaming &&
      response.headers.get('content-type')?.startsWith('application/wasm')) {
      ({ module, instance } = await WebAssembly.instantiateStreaming(response, {}));
    } else {
      ({ module, instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {}));
    }
  }
  const abi = instance.exports.oxtty_abi();
  if (abi !== ABI) throw new Error(`oxtty: wasm ABI ${abi} does not match JS wrapper ABI ${ABI}`);
  wasmModule = module;
  wasm = guard(instance.exports);
}

// A Rust panic aborts the whole instance (every terminal in it) with a
// WebAssembly.RuntimeError. Each export is wrapped so that a trap rebuilds the
// instance from the same module before the error reaches the caller; terminals
// notice the new generation on their next call and start over empty.
function guard(exports) {
  const guarded = { memory: exports.memory };
  for (const [name, fn] of Object.entries(exports)) {
    if (typeof fn !== 'function') continue;
    guarded[name] = (a, b, c, d) => {
      try {
        return fn(a, b, c, d);
      } catch (err) {
        if (err instanceof WebAssembly.RuntimeError) rebuild();
        throw err;
      }
    };
  }
  return guarded;
}

function rebuild() {
  wasm = guard(new WebAssembly.Instance(wasmModule, {}).exports);
  generation++;
}

async function fetchWasm(source) {
  const base = globalThis.location?.href ?? import.meta.url;
  const url = source instanceof URL ? source : new URL(String(source), base);
  if (url.protocol === 'file:') {
    // Keep the name in a variable so browser bundlers do not follow the node: module.
    const fsModule = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fsModule);
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`oxtty: failed to fetch ${url} (${response.status})`);
  return response;
}

function requireWasm() {
  if (!wasm) throw new Error('oxtty: call `await init()` before creating a Terminal');
  return wasm;
}

const bytesOut = (len) => new Uint8Array(wasm.memory.buffer, wasm.oxtty_out_ptr(), len).slice();
const textOut = (len) => (len <= 0 ? '' : decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.oxtty_out_ptr(), len)));
const wordsOut = (n) => (n <= 0 ? new Uint32Array(0) : new Uint32Array(wasm.memory.buffer, wasm.oxtty_out32_ptr(), n).slice());

const registry = typeof FinalizationRegistry === 'undefined'
  ? null
  : new FinalizationRegistry(({ h, gen }) => { if (gen === generation) wasm?.oxtty_drop(h); });

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

/** Entries `setColors` takes: palette 0–255, then foreground, background, cursor. */
export const COLOR_SLOTS = 259;

/** @internal Forces a trap in the instance, to test crash recovery. */
export function __trapForTest() {
  // A feed from far outside linear memory traps on the first read.
  wasm.oxtty_feed(wasm.oxtty_new(2, 1, 0), 0xfffffff0, 64);
}

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
  // Renderers read it per cell, so keep the size here to avoid calling wasm (it changes only on resize)
  #cols = 0;
  #rows = 0;
  #inPtr = 0;
  #inCap = 0;
  #syncTimer = null;
  #syncTimeoutMs;
  #onSyncFlush;
  #onCrash;
  #gen;
  #scrollback;
  // Host settings re-applied when the engine starts over after a crash.
  #clipboard = { read: false, write: false };
  #colors = null;

  /**
   * @param {{ cols?: number, rows?: number, scrollback?: number, syncTimeoutMs?: number, onSyncFlush?: () => void, onCrash?: (error: unknown) => void }} [options]
   */
  constructor({ cols = 80, rows = 24, scrollback = 1000, syncTimeoutMs = 150, onSyncFlush, onCrash } = {}) {
    const w = requireWasm();
    this.#scrollback = scrollback;
    this.#syncTimeoutMs = syncTimeoutMs;
    this.#onSyncFlush = onSyncFlush;
    this.#onCrash = onCrash;
    this.#open(w, cols, rows);
  }

  #open(w, cols, rows) {
    this.#gen = generation;
    this.#h = w.oxtty_new(cols, rows, this.#scrollback);
    this.#readSize();
    registry?.register(this, { h: this.#h, gen: this.#gen }, this);
  }

  #handle() {
    if (!this.#h) throw new Error('oxtty: terminal is disposed');
    if (this.#gen !== generation) this.#restart();
    return this.#h;
  }

  // The instance was rebuilt after a trap: this terminal's state is gone. Start
  // over at the same size with the host's settings, and tell the host.
  #restart() {
    registry?.unregister(this);
    if (this.#syncTimer) clearTimeout(this.#syncTimer);
    this.#syncTimer = null;
    this.#inPtr = 0;
    this.#inCap = 0;
    this.#open(wasm, this.#cols, this.#rows);
    wasm.oxtty_set_clipboard_access(this.#h, this.#clipboard.read ? 1 : 0, this.#clipboard.write ? 1 : 0);
    if (this.#colors) this.setColors(this.#colors);
    this.#onCrash?.(new Error('oxtty: the engine crashed and this terminal was reset'));
  }

  /** Feeds program output. Strings are encoded as UTF-8. */
  write(data) {
    const h = this.#handle();
    if (typeof data === 'string') {
      if (!data.length) return;
      // UTF-8 is at most 3 bytes per UTF-16 unit: encode straight into linear memory.
      const ptr = this.#reserve(data.length * 3);
      const { written } = encoder.encodeInto(data, new Uint8Array(wasm.memory.buffer, ptr, data.length * 3));
      wasm.oxtty_feed(h, ptr, written);
    } else {
      if (!data.length) return;
      wasm.oxtty_feed(h, this.#stage(data), data.length);
    }
    this.#shrinkInput();
    this.#armSync();
  }

  // The reusable input buffer in linear memory, grown to at least `len` bytes.
  #reserve(len) {
    if (len > this.#inCap) {
      if (this.#inPtr) wasm.oxtty_free(this.#inPtr, this.#inCap);
      this.#inCap = Math.max(len, IN_MIN);
      this.#inPtr = wasm.oxtty_alloc(this.#inCap);
    }
    return this.#inPtr;
  }

  // Copies bytes into the input buffer.
  #stage(bytes) {
    const ptr = this.#reserve(bytes.length);
    new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  }

  // A buffer grown for one large write goes back, so the next small write
  // does not keep it allocated.
  #shrinkInput() {
    if (this.#inCap > IN_KEEP) {
      wasm.oxtty_free(this.#inPtr, this.#inCap);
      this.#inPtr = 0;
      this.#inCap = 0;
    }
  }

  // Synchronized output (CSI ? 2026 h) holds the screen until the program
  // ends it; if it never does, flush after a timeout like other terminals.
  #armSync() {
    const pending = wasm.oxtty_sync_pending(this.#h) === 1;
    if (pending && !this.#syncTimer) {
      this.#syncTimer = setTimeout(() => {
        this.#syncTimer = null;
        if (this.#h && wasm.oxtty_sync_pending(this.#h) === 1) {
          wasm.oxtty_flush_sync(this.#h);
          this.#onSyncFlush?.();
        }
      }, this.#syncTimeoutMs);
    } else if (!pending && this.#syncTimer) {
      clearTimeout(this.#syncTimer);
      this.#syncTimer = null;
    }
  }

  #readSize() {
    this.#cols = wasm.oxtty_cols(this.#h);
    this.#rows = wasm.oxtty_rows(this.#h);
  }

  resize(cols, rows) {
    wasm.oxtty_resize(this.#handle(), cols, rows);
    this.#readSize();
  }

  get cols() { this.#handle(); return this.#cols; }
  get rows() { this.#handle(); return this.#rows; }
  /** Scrollback lines; address them as rows -1 (newest) … -historyLength (oldest). */
  get historyLength() { return wasm.oxtty_history_len(this.#handle()); }

  /** @returns {string | null} */
  rowText(line) {
    const n = wasm.oxtty_row_text(this.#handle(), line);
    return n < 0 ? null : textOut(n);
  }

  /** `[codepoint, fg, bg, attrs]` per cell. @returns {Uint32Array | null} */
  rowCells(line) {
    const n = wasm.oxtty_row_cells(this.#handle(), line);
    return n < 0 ? null : wordsOut(n * 4);
  }

  /**
   * Like `rowCells`, but a view into WebAssembly memory instead of a copy:
   * valid only until the next call into any terminal. For renderers that read
   * every visible row each frame. @returns {Uint32Array | null}
   */
  rowCellsView(line) {
    const n = wasm.oxtty_row_cells(this.#handle(), line);
    return n < 0 ? null : new Uint32Array(wasm.memory.buffer, wasm.oxtty_out32_ptr(), n * 4);
  }

  rowWrapped(line) {
    return wasm.oxtty_row_wrapped(this.#handle(), line) === 1;
  }

  /** Cell text including combining marks. @returns {string | null} */
  cellText(line, col) {
    const n = wasm.oxtty_cell_text(this.#handle(), line, col);
    return n < 0 ? null : textOut(n);
  }

  /** Cells with combining marks, an underline colour or a hyperlink. */
  rowExtras(line) {
    const n = wasm.oxtty_row_extras(this.#handle(), line);
    if (n < 0) return null;
    if (n === 0) return [];
    const words = wordsOut(n * 4);
    const bytes = new Uint8Array(wasm.memory.buffer, wasm.oxtty_out_ptr(), wasm.oxtty_out_len()).slice();
    let at = 0;
    const texts = [];
    for (let i = 0; i < n; i++) {
      const len = words[i * 4 + 2];
      texts.push(len ? decoder.decode(bytes.subarray(at, at + len)) : undefined);
      at += len;
    }
    // After the text come this line's links, in `id \0 uri \0` order.
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
    const c = wasm.oxtty_cursor(h);
    const style = wasm.oxtty_cursor_style(h);
    return {
      line: (c >>> 16) & 0x7fff,
      col: c & 0xffff,
      visible: c >>> 31 === 1,
      shape: CURSOR_SHAPES[style & 0xff] ?? 'block',
      blink: ((style >>> 8) & 1) === 1,
      styled: ((style >>> 9) & 1) === 1,
    };
  }

  /** Rows the view is scrolled back into history (0 = following output). */
  get displayOffset() { return wasm.oxtty_display_offset(this.#handle()); }

  /** Positive `delta` scrolls back into history; clamped. Damage becomes full when the view moves. */
  scrollDisplay(delta) {
    wasm.oxtty_scroll_display(this.#handle(), delta);
  }

  scrollToBottom() {
    wasm.oxtty_scroll_to_bottom(this.#handle());
  }

  modes() {
    return wasm.oxtty_modes(this.#handle());
  }

  /** Viewport changes since the last call: move drawn rows up by `scroll`, then redraw `lines`. */
  takeDamage() {
    const n = wasm.oxtty_take_damage(this.#handle());
    if (n < 0) return { full: true, scroll: 0, lines: [] };
    const words = wordsOut(n + 1);
    return { full: false, scroll: words[0], lines: Array.from(words.subarray(1)) };
  }

  /** Bytes to write back to the PTY (status reports, …). */
  takeReplies() {
    const n = wasm.oxtty_take_replies(this.#handle());
    return n === 0 ? new Uint8Array(0) : bytesOut(n);
  }

  /** @returns {string | null} new title, or null if unchanged */
  takeTitle() {
    const n = wasm.oxtty_take_title(this.#handle());
    return n < 0 ? null : textOut(n);
  }

  takeBells() {
    return wasm.oxtty_take_bells(this.#handle());
  }

  /** Lets the program read and/or write the host clipboards with OSC 52 (both off by default). */
  setClipboardAccess({ read = false, write = false } = {}) {
    this.#clipboard = { read, write };
    wasm.oxtty_set_clipboard_access(this.#handle(), read ? 1 : 0, write ? 1 : 0);
  }

  /** @returns {{ selection: 'c' | 'p', text: string } | null} oldest text the program asked to copy */
  takeClipboardWrite() {
    const n = wasm.oxtty_take_clipboard_write(this.#handle());
    if (n < 0) return null;
    const out = bytesOut(n);
    return { selection: String.fromCharCode(out[0]), text: decoder.decode(out.subarray(1)) };
  }

  /** @returns {'c' | 'p' | null} oldest clipboard the program asked to read; answer with replyClipboard */
  takeClipboardRead() {
    const c = wasm.oxtty_take_clipboard_read(this.#handle());
    return c < 0 ? null : String.fromCharCode(c);
  }

  /** Answers the oldest read of `selection`; the reply joins takeReplies(). */
  replyClipboard(selection, text) {
    const h = this.#handle();
    const bytes = encoder.encode(text);
    return wasm.oxtty_reply_clipboard(h, selection.charCodeAt(0), this.#stage(bytes), bytes.length) === 1;
  }

  /** Colours (0xRRGGBB, COLOR_SLOTS of them) that answer OSC 4/10/11/12 queries; null stops answering. */
  setColors(colors) {
    const h = this.#handle();
    if (!colors) {
      this.#colors = null;
      return wasm.oxtty_set_colors(h, 0, 0);
    }
    if (colors.length !== COLOR_SLOTS) throw new RangeError(`oxtty: setColors takes ${COLOR_SLOTS} colours`);
    const words = Uint32Array.from(colors);
    this.#colors = words;
    wasm.oxtty_set_colors(h, this.#stage(new Uint8Array(words.buffer)), words.byteLength);
  }

  syncPending() {
    return wasm.oxtty_sync_pending(this.#handle()) === 1;
  }

  flushSync() {
    wasm.oxtty_flush_sync(this.#handle());
    this.#armSync();
  }

  /** Bytes that rebuild this screen in a fresh xterm.js, or why they cannot. */
  ansiSnapshot() {
    const n = wasm.oxtty_ansi_snapshot(this.#handle());
    return n > 0 ? { ok: true, payload: bytesOut(n) } : { ok: false, reason: textOut(-n) };
  }

  dispose() {
    if (!this.#h) return;
    if (this.#syncTimer) clearTimeout(this.#syncTimer);
    if (this.#gen === generation) {
      if (this.#inPtr) wasm.oxtty_free(this.#inPtr, this.#inCap);
      wasm.oxtty_drop(this.#h);
    }
    registry?.unregister(this);
    this.#h = 0;
    this.#inPtr = 0;
    this.#inCap = 0;
  }
}
