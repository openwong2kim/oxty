// ../../packages/oxtty/dist/index.js
var ABI = 6;
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var IN_MIN = 4096;
var IN_KEEP = 256 * 1024;
var wasm = null;
var initPromise = null;
var wasmModule = null;
var generation = 0;
function init(source) {
  initPromise ??= load(source).catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}
async function load(source) {
  source ??= new URL("./oxtty.wasm", import.meta.url);
  let module;
  let instance;
  if (source instanceof WebAssembly.Module) {
    module = source;
    instance = await WebAssembly.instantiate(source, {});
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    ({ module, instance } = await WebAssembly.instantiate(source, {}));
  } else {
    const response = typeof Response !== "undefined" && source instanceof Response ? source : await fetchWasm(source);
    if (response instanceof Uint8Array) {
      ({ module, instance } = await WebAssembly.instantiate(response, {}));
    } else if (WebAssembly.instantiateStreaming && response.headers.get("content-type")?.startsWith("application/wasm")) {
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
function guard(exports) {
  const guarded = { memory: exports.memory };
  for (const [name, fn] of Object.entries(exports)) {
    if (typeof fn !== "function") continue;
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
  if (url.protocol === "file:") {
    const fsModule = "node:fs/promises";
    const { readFile } = await import(
      /* @vite-ignore */
      /* webpackIgnore: true */
      fsModule
    );
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`oxtty: failed to fetch ${url} (${response.status})`);
  return response;
}
function requireWasm() {
  if (!wasm) throw new Error("oxtty: call `await init()` before creating a Terminal");
  return wasm;
}
var bytesOut = (len) => new Uint8Array(wasm.memory.buffer, wasm.oxtty_out_ptr(), len).slice();
var textOut = (len) => len <= 0 ? "" : decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.oxtty_out_ptr(), len));
var wordsOut = (n) => n <= 0 ? new Uint32Array(0) : new Uint32Array(wasm.memory.buffer, wasm.oxtty_out32_ptr(), n).slice();
var registry = typeof FinalizationRegistry === "undefined" ? null : new FinalizationRegistry(({ h, gen }) => {
  if (gen === generation) wasm?.oxtty_drop(h);
});
var Attr = Object.freeze({
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  DOUBLE_UNDERLINE: 1 << 4,
  CURLY_UNDERLINE: 1 << 5,
  DOTTED_UNDERLINE: 1 << 6,
  DASHED_UNDERLINE: 1 << 7,
  INVERSE: 1 << 8,
  HIDDEN: 1 << 9,
  STRIKEOUT: 1 << 10,
  BLINK: 1 << 11,
  WIDE: 1 << 12,
  WIDE_SPACER: 1 << 13,
  COMBINING: 1 << 14,
  UNDERLINE_COLOR: 1 << 15,
  HYPERLINK: 1 << 16
});
var Mode = Object.freeze({
  SHOW_CURSOR: 1 << 0,
  APP_CURSOR: 1 << 1,
  APP_KEYPAD: 1 << 2,
  BRACKETED_PASTE: 1 << 3,
  MOUSE_CLICK: 1 << 4,
  MOUSE_DRAG: 1 << 5,
  MOUSE_MOTION: 1 << 6,
  SGR_MOUSE: 1 << 7,
  FOCUS_EVENTS: 1 << 8,
  ALT_SCREEN: 1 << 9,
  ALTERNATE_SCROLL: 1 << 10,
  LINE_WRAP: 1 << 11,
  INSERT: 1 << 12,
  ORIGIN: 1 << 13,
  KITTY_KEYBOARD: 1 << 14,
  MOUSE_X10: 1 << 15
});
var CURSOR_SHAPES = ["block", "underline", "bar"];
var ColorKind = Object.freeze({ NAMED: 1, INDEXED: 2, RGB: 3 });
var COLOR_SLOTS = 259;
var Terminal = class {
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
  #kittyKeyboard = false;
  #colors = null;
  /**
   * @param {{ cols?: number, rows?: number, scrollback?: number, syncTimeoutMs?: number, onSyncFlush?: () => void, onCrash?: (error: unknown) => void }} [options]
   */
  constructor({ cols = 80, rows = 24, scrollback = 1e3, syncTimeoutMs = 150, onSyncFlush, onCrash } = {}) {
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
    if (!this.#h) throw new Error("oxtty: terminal is disposed");
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
    if (this.#kittyKeyboard) wasm.oxtty_set_kitty_keyboard(this.#h, 1);
    if (this.#colors) this.setColors(this.#colors);
    this.#onCrash?.(new Error("oxtty: the engine crashed and this terminal was reset"));
  }
  /** Feeds program output. Strings are encoded as UTF-8. */
  write(data) {
    const h = this.#handle();
    if (typeof data === "string") {
      if (!data.length) return;
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
  get cols() {
    this.#handle();
    return this.#cols;
  }
  get rows() {
    this.#handle();
    return this.#rows;
  }
  /** Scrollback lines; address them as rows -1 (newest) … -historyLength (oldest). */
  get historyLength() {
    return wasm.oxtty_history_len(this.#handle());
  }
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
      texts.push(len ? decoder.decode(bytes.subarray(at, at + len)) : void 0);
      at += len;
    }
    const parts = decoder.decode(bytes.subarray(at)).split("\0");
    const links = [];
    for (let i = 0; i + 1 < parts.length; i += 2) links.push(Object.freeze({ id: parts[i], uri: parts[i + 1] }));
    const extras = [];
    for (let i = 0; i < n; i++) {
      const e = { col: words[i * 4] };
      if (texts[i] !== void 0) e.text = texts[i];
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
      line: c >>> 16 & 32767,
      col: c & 65535,
      visible: c >>> 31 === 1,
      shape: CURSOR_SHAPES[style & 255] ?? "block",
      blink: (style >>> 8 & 1) === 1,
      styled: (style >>> 9 & 1) === 1
    };
  }
  /** Rows the view is scrolled back into history (0 = following output). */
  get displayOffset() {
    return wasm.oxtty_display_offset(this.#handle());
  }
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
  /** Lets the program use the kitty keyboard protocol (off by default); switching drops its pushed flags. */
  setKittyKeyboard(enabled) {
    this.#kittyKeyboard = !!enabled;
    wasm.oxtty_set_kitty_keyboard(this.#handle(), enabled ? 1 : 0);
  }
  /** Drops the kitty keyboard flags the program pushed, keeping the protocol on or off. */
  resetKittyKeyboard() {
    wasm.oxtty_reset_kitty_keyboard(this.#handle());
  }
  /** Active kitty keyboard flags: 1 disambiguate, 2 event types, 4 alternate keys, 8 all keys as escapes, 16 associated text. */
  kittyFlags() {
    return wasm.oxtty_kitty_flags(this.#handle());
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
};

// ../../packages/oxtty/xterm/vendor-xterm/src/browser/renderer/shared/RendererUtils.ts
function throwIfFalsy(value) {
  if (!value) {
    throw new Error("value must not be falsy");
  }
  return value;
}
function isPowerlineGlyph(codepoint) {
  return 57508 <= codepoint && codepoint <= 57558;
}
function isRestrictedPowerlineGlyph(codepoint) {
  return 57520 <= codepoint && codepoint <= 57527;
}
function isNerdFontGlyph(codepoint) {
  return 57344 <= codepoint && codepoint <= 63743;
}
function isBoxOrBlockGlyph(codepoint) {
  return 9472 <= codepoint && codepoint <= 9631;
}
function isEmoji(codepoint) {
  return codepoint >= 128512 && codepoint <= 128591 || // Emoticons
  codepoint >= 127744 && codepoint <= 128511 || // Misc Symbols and Pictographs
  codepoint >= 128640 && codepoint <= 128767 || // Transport and Map
  codepoint >= 9728 && codepoint <= 9983 || // Misc symbols
  codepoint >= 9984 && codepoint <= 10175 || // Dingbats
  codepoint >= 65024 && codepoint <= 65039 || // Variation Selectors
  codepoint >= 129280 && codepoint <= 129535 || // Supplemental Symbols and Pictographs
  codepoint >= 127462 && codepoint <= 127487;
}
function allowRescaling(codepoint, width, glyphSizeX, deviceCellWidth) {
  return (
    // Is single cell width
    width === 1 && // Glyph exceeds cell bounds, add 50% to avoid hurting readability by rescaling glyphs that
    // barely overlap
    glyphSizeX > Math.ceil(deviceCellWidth * 1.5) && // Never rescale ascii
    codepoint !== void 0 && codepoint > 255 && // Never rescale emoji
    !isEmoji(codepoint) && // Never rescale powerline or nerd fonts
    !isPowerlineGlyph(codepoint) && !isNerdFontGlyph(codepoint)
  );
}
function treatGlyphAsBackgroundColor(codepoint) {
  return isPowerlineGlyph(codepoint) || isBoxOrBlockGlyph(codepoint);
}
function createRenderDimensions() {
  return {
    css: {
      canvas: createDimension(),
      cell: createDimension()
    },
    device: {
      canvas: createDimension(),
      cell: createDimension(),
      char: {
        width: 0,
        height: 0,
        left: 0,
        top: 0
      }
    }
  };
}
function createDimension() {
  return {
    width: 0,
    height: 0
  };
}
function computeNextVariantOffset(cellWidth, lineWidth, currentOffset = 0) {
  return (cellWidth - (Math.round(lineWidth) * 2 - currentOffset)) % (Math.round(lineWidth) * 2);
}

// ../../packages/oxtty/xterm/vendor-xterm/src/common/buffer/Constants.ts
var DEFAULT_COLOR = 0;
var DEFAULT_ATTR = 0 << 18 | DEFAULT_COLOR << 9 | 256 << 0;
var DEFAULT_EXT = 0;
var NULL_CELL_CODE = 0;

// ../../packages/oxtty/xterm/vendor-xterm/src/common/Color.ts
var $r = 0;
var $g = 0;
var $b = 0;
var $a = 0;
var NULL_COLOR = {
  css: "#00000000",
  rgba: 0
};
var channels;
((channels2) => {
  function toCss(r, g, b, a) {
    if (a !== void 0) {
      return `#${toPaddedHex(r)}${toPaddedHex(g)}${toPaddedHex(b)}${toPaddedHex(a)}`;
    }
    return `#${toPaddedHex(r)}${toPaddedHex(g)}${toPaddedHex(b)}`;
  }
  channels2.toCss = toCss;
  function toRgba(r, g, b, a = 255) {
    return (r << 24 | g << 16 | b << 8 | a) >>> 0;
  }
  channels2.toRgba = toRgba;
  function toColor(r, g, b, a) {
    return {
      css: channels2.toCss(r, g, b, a),
      rgba: channels2.toRgba(r, g, b, a)
    };
  }
  channels2.toColor = toColor;
})(channels || (channels = {}));
var color;
((color2) => {
  function blend(bg, fg) {
    $a = (fg.rgba & 255) / 255;
    if ($a === 1) {
      return {
        css: fg.css,
        rgba: fg.rgba
      };
    }
    const fgR = fg.rgba >> 24 & 255;
    const fgG = fg.rgba >> 16 & 255;
    const fgB = fg.rgba >> 8 & 255;
    const bgR = bg.rgba >> 24 & 255;
    const bgG = bg.rgba >> 16 & 255;
    const bgB = bg.rgba >> 8 & 255;
    $r = bgR + Math.round((fgR - bgR) * $a);
    $g = bgG + Math.round((fgG - bgG) * $a);
    $b = bgB + Math.round((fgB - bgB) * $a);
    const css2 = channels.toCss($r, $g, $b);
    const rgba2 = channels.toRgba($r, $g, $b);
    return { css: css2, rgba: rgba2 };
  }
  color2.blend = blend;
  function isOpaque(color3) {
    return (color3.rgba & 255) === 255;
  }
  color2.isOpaque = isOpaque;
  function ensureContrastRatio(bg, fg, ratio) {
    const result = rgba.ensureContrastRatio(bg.rgba, fg.rgba, ratio);
    if (!result) {
      return void 0;
    }
    return channels.toColor(
      result >> 24 & 255,
      result >> 16 & 255,
      result >> 8 & 255
    );
  }
  color2.ensureContrastRatio = ensureContrastRatio;
  function opaque(color3) {
    const rgbaColor = (color3.rgba | 255) >>> 0;
    [$r, $g, $b] = rgba.toChannels(rgbaColor);
    return {
      css: channels.toCss($r, $g, $b),
      rgba: rgbaColor
    };
  }
  color2.opaque = opaque;
  function opacity(color3, opacity2) {
    $a = Math.round(opacity2 * 255);
    [$r, $g, $b] = rgba.toChannels(color3.rgba);
    return {
      css: channels.toCss($r, $g, $b, $a),
      rgba: channels.toRgba($r, $g, $b, $a)
    };
  }
  color2.opacity = opacity;
  function multiplyOpacity(color3, factor) {
    $a = color3.rgba & 255;
    return opacity(color3, $a * factor / 255);
  }
  color2.multiplyOpacity = multiplyOpacity;
  function toColorRGB(color3) {
    return [color3.rgba >> 24 & 255, color3.rgba >> 16 & 255, color3.rgba >> 8 & 255];
  }
  color2.toColorRGB = toColorRGB;
})(color || (color = {}));
var css;
((css2) => {
  let $ctx;
  let $litmusColor;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", {
      willReadFrequently: true
    });
    if (ctx) {
      $ctx = ctx;
      $ctx.globalCompositeOperation = "copy";
      $litmusColor = $ctx.createLinearGradient(0, 0, 1, 1);
    }
  } catch {
  }
  function toColor(css3) {
    if (css3.match(/#[\da-f]{3,8}/i)) {
      switch (css3.length) {
        case 4: {
          $r = parseInt(css3.slice(1, 2).repeat(2), 16);
          $g = parseInt(css3.slice(2, 3).repeat(2), 16);
          $b = parseInt(css3.slice(3, 4).repeat(2), 16);
          return channels.toColor($r, $g, $b);
        }
        case 5: {
          $r = parseInt(css3.slice(1, 2).repeat(2), 16);
          $g = parseInt(css3.slice(2, 3).repeat(2), 16);
          $b = parseInt(css3.slice(3, 4).repeat(2), 16);
          $a = parseInt(css3.slice(4, 5).repeat(2), 16);
          return channels.toColor($r, $g, $b, $a);
        }
        case 7:
          return {
            css: css3,
            rgba: (parseInt(css3.slice(1), 16) << 8 | 255) >>> 0
          };
        case 9:
          return {
            css: css3,
            rgba: parseInt(css3.slice(1), 16) >>> 0
          };
      }
    }
    const rgbaMatch = css3.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*(0|1|\d?\.(\d+))\s*)?\)/);
    if (rgbaMatch) {
      $r = parseInt(rgbaMatch[1]);
      $g = parseInt(rgbaMatch[2]);
      $b = parseInt(rgbaMatch[3]);
      $a = Math.round((rgbaMatch[5] === void 0 ? 1 : parseFloat(rgbaMatch[5])) * 255);
      return channels.toColor($r, $g, $b, $a);
    }
    if (!$ctx || !$litmusColor) {
      throw new Error("css.toColor: Unsupported css format");
    }
    $ctx.fillStyle = $litmusColor;
    $ctx.fillStyle = css3;
    if (typeof $ctx.fillStyle !== "string") {
      throw new Error("css.toColor: Unsupported css format");
    }
    $ctx.fillRect(0, 0, 1, 1);
    [$r, $g, $b, $a] = $ctx.getImageData(0, 0, 1, 1).data;
    if ($a !== 255) {
      throw new Error("css.toColor: Unsupported css format");
    }
    return {
      rgba: channels.toRgba($r, $g, $b, $a),
      css: css3
    };
  }
  css2.toColor = toColor;
})(css || (css = {}));
var rgb;
((rgb2) => {
  function relativeLuminance(rgb3) {
    return relativeLuminance2(
      rgb3 >> 16 & 255,
      rgb3 >> 8 & 255,
      rgb3 & 255
    );
  }
  rgb2.relativeLuminance = relativeLuminance;
  function relativeLuminance2(r, g, b) {
    const rs = r / 255;
    const gs = g / 255;
    const bs = b / 255;
    const rr = rs <= 0.03928 ? rs / 12.92 : Math.pow((rs + 0.055) / 1.055, 2.4);
    const rg = gs <= 0.03928 ? gs / 12.92 : Math.pow((gs + 0.055) / 1.055, 2.4);
    const rb = bs <= 0.03928 ? bs / 12.92 : Math.pow((bs + 0.055) / 1.055, 2.4);
    return rr * 0.2126 + rg * 0.7152 + rb * 0.0722;
  }
  rgb2.relativeLuminance2 = relativeLuminance2;
})(rgb || (rgb = {}));
var rgba;
((rgba2) => {
  function blend(bg, fg) {
    $a = (fg & 255) / 255;
    if ($a === 1) {
      return fg;
    }
    const fgR = fg >> 24 & 255;
    const fgG = fg >> 16 & 255;
    const fgB = fg >> 8 & 255;
    const bgR = bg >> 24 & 255;
    const bgG = bg >> 16 & 255;
    const bgB = bg >> 8 & 255;
    $r = bgR + Math.round((fgR - bgR) * $a);
    $g = bgG + Math.round((fgG - bgG) * $a);
    $b = bgB + Math.round((fgB - bgB) * $a);
    return channels.toRgba($r, $g, $b);
  }
  rgba2.blend = blend;
  function ensureContrastRatio(bgRgba, fgRgba, ratio) {
    const bgL = rgb.relativeLuminance(bgRgba >> 8);
    const fgL = rgb.relativeLuminance(fgRgba >> 8);
    const cr = contrastRatio(bgL, fgL);
    if (cr < ratio) {
      if (fgL < bgL) {
        const resultA2 = reduceLuminance(bgRgba, fgRgba, ratio);
        const resultARatio2 = contrastRatio(bgL, rgb.relativeLuminance(resultA2 >> 8));
        if (resultARatio2 < ratio) {
          const resultB = increaseLuminance(bgRgba, fgRgba, ratio);
          const resultBRatio = contrastRatio(bgL, rgb.relativeLuminance(resultB >> 8));
          return resultARatio2 > resultBRatio ? resultA2 : resultB;
        }
        return resultA2;
      }
      const resultA = increaseLuminance(bgRgba, fgRgba, ratio);
      const resultARatio = contrastRatio(bgL, rgb.relativeLuminance(resultA >> 8));
      if (resultARatio < ratio) {
        const resultB = reduceLuminance(bgRgba, fgRgba, ratio);
        const resultBRatio = contrastRatio(bgL, rgb.relativeLuminance(resultB >> 8));
        return resultARatio > resultBRatio ? resultA : resultB;
      }
      return resultA;
    }
    return void 0;
  }
  rgba2.ensureContrastRatio = ensureContrastRatio;
  function reduceLuminance(bgRgba, fgRgba, ratio) {
    const bgR = bgRgba >> 24 & 255;
    const bgG = bgRgba >> 16 & 255;
    const bgB = bgRgba >> 8 & 255;
    let fgR = fgRgba >> 24 & 255;
    let fgG = fgRgba >> 16 & 255;
    let fgB = fgRgba >> 8 & 255;
    let cr = contrastRatio(rgb.relativeLuminance2(fgR, fgG, fgB), rgb.relativeLuminance2(bgR, bgG, bgB));
    while (cr < ratio && (fgR > 0 || fgG > 0 || fgB > 0)) {
      fgR -= Math.max(0, Math.ceil(fgR * 0.1));
      fgG -= Math.max(0, Math.ceil(fgG * 0.1));
      fgB -= Math.max(0, Math.ceil(fgB * 0.1));
      cr = contrastRatio(rgb.relativeLuminance2(fgR, fgG, fgB), rgb.relativeLuminance2(bgR, bgG, bgB));
    }
    return (fgR << 24 | fgG << 16 | fgB << 8 | 255) >>> 0;
  }
  rgba2.reduceLuminance = reduceLuminance;
  function increaseLuminance(bgRgba, fgRgba, ratio) {
    const bgR = bgRgba >> 24 & 255;
    const bgG = bgRgba >> 16 & 255;
    const bgB = bgRgba >> 8 & 255;
    let fgR = fgRgba >> 24 & 255;
    let fgG = fgRgba >> 16 & 255;
    let fgB = fgRgba >> 8 & 255;
    let cr = contrastRatio(rgb.relativeLuminance2(fgR, fgG, fgB), rgb.relativeLuminance2(bgR, bgG, bgB));
    while (cr < ratio && (fgR < 255 || fgG < 255 || fgB < 255)) {
      fgR = Math.min(255, fgR + Math.ceil((255 - fgR) * 0.1));
      fgG = Math.min(255, fgG + Math.ceil((255 - fgG) * 0.1));
      fgB = Math.min(255, fgB + Math.ceil((255 - fgB) * 0.1));
      cr = contrastRatio(rgb.relativeLuminance2(fgR, fgG, fgB), rgb.relativeLuminance2(bgR, bgG, bgB));
    }
    return (fgR << 24 | fgG << 16 | fgB << 8 | 255) >>> 0;
  }
  rgba2.increaseLuminance = increaseLuminance;
  function toChannels(value) {
    return [value >> 24 & 255, value >> 16 & 255, value >> 8 & 255, value & 255];
  }
  rgba2.toChannels = toChannels;
})(rgba || (rgba = {}));
function toPaddedHex(c) {
  const s = c.toString(16);
  return s.length < 2 ? "0" + s : s;
}
function contrastRatio(l1, l2) {
  if (l1 < l2) {
    return (l2 + 0.05) / (l1 + 0.05);
  }
  return (l1 + 0.05) / (l2 + 0.05);
}

// ../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/CellColorResolver.ts
var $fg = 0;
var $bg = 0;
var $hasFg = false;
var $hasBg = false;
var $isSelected = false;
var $colors;
var $variantOffset = 0;
var CellColorResolver = class {
  constructor(_terminal, _optionService, _selectionRenderModel, _decorationService, _coreBrowserService, _themeService) {
    this._terminal = _terminal;
    this._optionService = _optionService;
    this._selectionRenderModel = _selectionRenderModel;
    this._decorationService = _decorationService;
    this._coreBrowserService = _coreBrowserService;
    this._themeService = _themeService;
    /**
     * The shared result of the {@link resolve} call. This is only safe to use immediately after as
     * any other calls will share object.
     */
    this.result = {
      fg: 0,
      bg: 0,
      ext: 0
    };
  }
  /**
   * Resolves colors for the cell, putting the result into the shared {@link result}. This resolves
   * overrides, inverse and selection for the cell which can then be used to feed into the renderer.
   */
  resolve(cell, x, y, deviceCellWidth) {
    this.result.bg = cell.bg;
    this.result.fg = cell.fg;
    this.result.ext = cell.bg & 268435456 /* HAS_EXTENDED */ ? cell.extended.ext : 0;
    $bg = 0;
    $fg = 0;
    $hasBg = false;
    $hasFg = false;
    $isSelected = false;
    $colors = this._themeService.colors;
    $variantOffset = 0;
    const code = cell.getCode();
    if (code !== NULL_CELL_CODE && cell.extended.underlineStyle === 4 /* DOTTED */) {
      const lineWidth = Math.max(1, Math.floor(this._optionService.rawOptions.fontSize * this._coreBrowserService.dpr / 15));
      $variantOffset = x * deviceCellWidth % (Math.round(lineWidth) * 2);
    }
    this._decorationService.forEachDecorationAtCell(x, y, "bottom", (d) => {
      if (d.backgroundColorRGB) {
        $bg = d.backgroundColorRGB.rgba >> 8 & 16777215 /* RGB_MASK */;
        $hasBg = true;
      }
      if (d.foregroundColorRGB) {
        $fg = d.foregroundColorRGB.rgba >> 8 & 16777215 /* RGB_MASK */;
        $hasFg = true;
      }
    });
    $isSelected = this._selectionRenderModel.isCellSelected(this._terminal, x, y);
    if ($isSelected) {
      if (this.result.fg & 67108864 /* INVERSE */ || (this.result.bg & 50331648 /* CM_MASK */) !== 0 /* CM_DEFAULT */) {
        if (this.result.fg & 67108864 /* INVERSE */) {
          switch (this.result.fg & 50331648 /* CM_MASK */) {
            case 16777216 /* CM_P16 */:
            case 33554432 /* CM_P256 */:
              $bg = this._themeService.colors.ansi[this.result.fg & 255 /* PCOLOR_MASK */].rgba;
              break;
            case 50331648 /* CM_RGB */:
              $bg = (this.result.fg & 16777215 /* RGB_MASK */) << 8 | 255;
              break;
            case 0 /* CM_DEFAULT */:
            default:
              $bg = this._themeService.colors.foreground.rgba;
          }
        } else {
          switch (this.result.bg & 50331648 /* CM_MASK */) {
            case 16777216 /* CM_P16 */:
            case 33554432 /* CM_P256 */:
              $bg = this._themeService.colors.ansi[this.result.bg & 255 /* PCOLOR_MASK */].rgba;
              break;
            case 50331648 /* CM_RGB */:
              $bg = (this.result.bg & 16777215 /* RGB_MASK */) << 8 | 255;
              break;
          }
        }
        $bg = rgba.blend(
          $bg,
          (this._coreBrowserService.isFocused ? $colors.selectionBackgroundOpaque : $colors.selectionInactiveBackgroundOpaque).rgba & 4294967040 | 128
        ) >> 8 & 16777215 /* RGB_MASK */;
      } else {
        $bg = (this._coreBrowserService.isFocused ? $colors.selectionBackgroundOpaque : $colors.selectionInactiveBackgroundOpaque).rgba >> 8 & 16777215 /* RGB_MASK */;
      }
      $hasBg = true;
      if ($colors.selectionForeground) {
        $fg = $colors.selectionForeground.rgba >> 8 & 16777215 /* RGB_MASK */;
        $hasFg = true;
      }
      if (treatGlyphAsBackgroundColor(cell.getCode())) {
        if (this.result.fg & 67108864 /* INVERSE */ && (this.result.bg & 50331648 /* CM_MASK */) === 0 /* CM_DEFAULT */) {
          $fg = (this._coreBrowserService.isFocused ? $colors.selectionBackgroundOpaque : $colors.selectionInactiveBackgroundOpaque).rgba >> 8 & 16777215 /* RGB_MASK */;
        } else {
          if (this.result.fg & 67108864 /* INVERSE */) {
            switch (this.result.bg & 50331648 /* CM_MASK */) {
              case 16777216 /* CM_P16 */:
              case 33554432 /* CM_P256 */:
                $fg = this._themeService.colors.ansi[this.result.bg & 255 /* PCOLOR_MASK */].rgba;
                break;
              case 50331648 /* CM_RGB */:
                $fg = (this.result.bg & 16777215 /* RGB_MASK */) << 8 | 255;
                break;
            }
          } else {
            switch (this.result.fg & 50331648 /* CM_MASK */) {
              case 16777216 /* CM_P16 */:
              case 33554432 /* CM_P256 */:
                $fg = this._themeService.colors.ansi[this.result.fg & 255 /* PCOLOR_MASK */].rgba;
                break;
              case 50331648 /* CM_RGB */:
                $fg = (this.result.fg & 16777215 /* RGB_MASK */) << 8 | 255;
                break;
              case 0 /* CM_DEFAULT */:
              default:
                $fg = this._themeService.colors.foreground.rgba;
            }
          }
          $fg = rgba.blend(
            $fg,
            (this._coreBrowserService.isFocused ? $colors.selectionBackgroundOpaque : $colors.selectionInactiveBackgroundOpaque).rgba & 4294967040 | 128
          ) >> 8 & 16777215 /* RGB_MASK */;
        }
        $hasFg = true;
      }
    }
    this._decorationService.forEachDecorationAtCell(x, y, "top", (d) => {
      if (d.backgroundColorRGB) {
        $bg = d.backgroundColorRGB.rgba >> 8 & 16777215 /* RGB_MASK */;
        $hasBg = true;
      }
      if (d.foregroundColorRGB) {
        $fg = d.foregroundColorRGB.rgba >> 8 & 16777215 /* RGB_MASK */;
        $hasFg = true;
      }
    });
    if ($hasBg) {
      if ($isSelected) {
        $bg = cell.bg & ~16777215 /* RGB_MASK */ & ~134217728 /* DIM */ | $bg | 50331648 /* CM_RGB */;
      } else {
        $bg = cell.bg & ~16777215 /* RGB_MASK */ | $bg | 50331648 /* CM_RGB */;
      }
    }
    if ($hasFg) {
      $fg = cell.fg & ~16777215 /* RGB_MASK */ & ~67108864 /* INVERSE */ | $fg | 50331648 /* CM_RGB */;
    }
    if (this.result.fg & 67108864 /* INVERSE */) {
      if ($hasBg && !$hasFg) {
        if ((this.result.bg & 50331648 /* CM_MASK */) === 0 /* CM_DEFAULT */) {
          $fg = this.result.fg & ~(16777215 /* RGB_MASK */ | 67108864 /* INVERSE */ | 50331648 /* CM_MASK */) | $colors.background.rgba >> 8 & 16777215 /* RGB_MASK */ & 16777215 /* RGB_MASK */ | 50331648 /* CM_RGB */;
        } else {
          $fg = this.result.fg & ~(16777215 /* RGB_MASK */ | 67108864 /* INVERSE */ | 50331648 /* CM_MASK */) | this.result.bg & (16777215 /* RGB_MASK */ | 50331648 /* CM_MASK */);
        }
        $hasFg = true;
      }
      if (!$hasBg && $hasFg) {
        if ((this.result.fg & 50331648 /* CM_MASK */) === 0 /* CM_DEFAULT */) {
          $bg = this.result.bg & ~(16777215 /* RGB_MASK */ | 50331648 /* CM_MASK */) | $colors.foreground.rgba >> 8 & 16777215 /* RGB_MASK */ & 16777215 /* RGB_MASK */ | 50331648 /* CM_RGB */;
        } else {
          $bg = this.result.bg & ~(16777215 /* RGB_MASK */ | 50331648 /* CM_MASK */) | this.result.fg & (16777215 /* RGB_MASK */ | 50331648 /* CM_MASK */);
        }
        $hasBg = true;
      }
    }
    $colors = void 0;
    this.result.bg = $hasBg ? $bg : this.result.bg;
    this.result.fg = $hasFg ? $fg : this.result.fg;
    this.result.ext &= ~3758096384 /* VARIANT_OFFSET */;
    this.result.ext |= $variantOffset << 29 & 3758096384 /* VARIANT_OFFSET */;
  }
};

// ../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/CharAtlasUtils.ts
function generateConfig(deviceCellWidth, deviceCellHeight, deviceCharWidth, deviceCharHeight, options, colors, devicePixelRatio, deviceMaxTextureSize) {
  const clonedColors = {
    foreground: colors.foreground,
    background: colors.background,
    cursor: NULL_COLOR,
    cursorAccent: NULL_COLOR,
    selectionForeground: NULL_COLOR,
    selectionBackgroundTransparent: NULL_COLOR,
    selectionBackgroundOpaque: NULL_COLOR,
    selectionInactiveBackgroundTransparent: NULL_COLOR,
    selectionInactiveBackgroundOpaque: NULL_COLOR,
    overviewRulerBorder: NULL_COLOR,
    scrollbarSliderBackground: NULL_COLOR,
    scrollbarSliderHoverBackground: NULL_COLOR,
    scrollbarSliderActiveBackground: NULL_COLOR,
    // For the static char atlas, we only use the first 16 colors, but we need all 256 for the
    // dynamic character atlas.
    ansi: colors.ansi.slice(),
    contrastCache: colors.contrastCache,
    halfContrastCache: colors.halfContrastCache
  };
  return {
    customGlyphs: options.customGlyphs,
    devicePixelRatio,
    deviceMaxTextureSize,
    letterSpacing: options.letterSpacing,
    lineHeight: options.lineHeight,
    deviceCellWidth,
    deviceCellHeight,
    deviceCharWidth,
    deviceCharHeight,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    fontWeight: options.fontWeight,
    fontWeightBold: options.fontWeightBold,
    allowTransparency: options.allowTransparency,
    drawBoldTextInBrightColors: options.drawBoldTextInBrightColors,
    minimumContrastRatio: options.minimumContrastRatio,
    colors: clonedColors
  };
}
function configEquals(a, b) {
  for (let i = 0; i < a.colors.ansi.length; i++) {
    if (a.colors.ansi[i].rgba !== b.colors.ansi[i].rgba) {
      return false;
    }
  }
  return a.devicePixelRatio === b.devicePixelRatio && a.customGlyphs === b.customGlyphs && a.lineHeight === b.lineHeight && a.letterSpacing === b.letterSpacing && a.fontFamily === b.fontFamily && a.fontSize === b.fontSize && a.fontWeight === b.fontWeight && a.fontWeightBold === b.fontWeightBold && a.allowTransparency === b.allowTransparency && a.deviceCharWidth === b.deviceCharWidth && a.deviceCharHeight === b.deviceCharHeight && a.drawBoldTextInBrightColors === b.drawBoldTextInBrightColors && a.minimumContrastRatio === b.minimumContrastRatio && a.colors.foreground.rgba === b.colors.foreground.rgba && a.colors.background.rgba === b.colors.background.rgba;
}

// ../../packages/oxtty/xterm/vendor-xterm/src/common/Platform.ts
var isNode = typeof process !== "undefined" && "title" in process ? true : false;
var userAgent = isNode ? "node" : navigator.userAgent;
var platform = isNode ? "node" : navigator.platform;
var isFirefox = userAgent.includes("Firefox");
var isLegacyEdge = userAgent.includes("Edge");
var isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
var isMac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(platform);
var isWindows = ["Windows", "Win16", "Win32", "WinCE"].includes(platform);
var isLinux = platform.indexOf("Linux") >= 0;
var isChromeOS = /\bCrOS\b/.test(userAgent);

// ../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/Constants.ts
var DIM_OPACITY = 0.5;
var TEXT_BASELINE = isFirefox || isLegacyEdge ? "bottom" : "ideographic";

// ../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/CustomGlyphs.ts
var blockElementDefinitions = {
  // Block elements (0x2580-0x2590)
  "\u2580": [{ x: 0, y: 0, w: 8, h: 4 }],
  // UPPER HALF BLOCK
  "\u2581": [{ x: 0, y: 7, w: 8, h: 1 }],
  // LOWER ONE EIGHTH BLOCK
  "\u2582": [{ x: 0, y: 6, w: 8, h: 2 }],
  // LOWER ONE QUARTER BLOCK
  "\u2583": [{ x: 0, y: 5, w: 8, h: 3 }],
  // LOWER THREE EIGHTHS BLOCK
  "\u2584": [{ x: 0, y: 4, w: 8, h: 4 }],
  // LOWER HALF BLOCK
  "\u2585": [{ x: 0, y: 3, w: 8, h: 5 }],
  // LOWER FIVE EIGHTHS BLOCK
  "\u2586": [{ x: 0, y: 2, w: 8, h: 6 }],
  // LOWER THREE QUARTERS BLOCK
  "\u2587": [{ x: 0, y: 1, w: 8, h: 7 }],
  // LOWER SEVEN EIGHTHS BLOCK
  "\u2588": [{ x: 0, y: 0, w: 8, h: 8 }],
  // FULL BLOCK
  "\u2589": [{ x: 0, y: 0, w: 7, h: 8 }],
  // LEFT SEVEN EIGHTHS BLOCK
  "\u258A": [{ x: 0, y: 0, w: 6, h: 8 }],
  // LEFT THREE QUARTERS BLOCK
  "\u258B": [{ x: 0, y: 0, w: 5, h: 8 }],
  // LEFT FIVE EIGHTHS BLOCK
  "\u258C": [{ x: 0, y: 0, w: 4, h: 8 }],
  // LEFT HALF BLOCK
  "\u258D": [{ x: 0, y: 0, w: 3, h: 8 }],
  // LEFT THREE EIGHTHS BLOCK
  "\u258E": [{ x: 0, y: 0, w: 2, h: 8 }],
  // LEFT ONE QUARTER BLOCK
  "\u258F": [{ x: 0, y: 0, w: 1, h: 8 }],
  // LEFT ONE EIGHTH BLOCK
  "\u2590": [{ x: 4, y: 0, w: 4, h: 8 }],
  // RIGHT HALF BLOCK
  // Block elements (0x2594-0x2595)
  "\u2594": [{ x: 0, y: 0, w: 8, h: 1 }],
  // UPPER ONE EIGHTH BLOCK
  "\u2595": [{ x: 7, y: 0, w: 1, h: 8 }],
  // RIGHT ONE EIGHTH BLOCK
  // Terminal graphic characters (0x2596-0x259F)
  "\u2596": [{ x: 0, y: 4, w: 4, h: 4 }],
  // QUADRANT LOWER LEFT
  "\u2597": [{ x: 4, y: 4, w: 4, h: 4 }],
  // QUADRANT LOWER RIGHT
  "\u2598": [{ x: 0, y: 0, w: 4, h: 4 }],
  // QUADRANT UPPER LEFT
  "\u2599": [{ x: 0, y: 0, w: 4, h: 8 }, { x: 0, y: 4, w: 8, h: 4 }],
  // QUADRANT UPPER LEFT AND LOWER LEFT AND LOWER RIGHT
  "\u259A": [{ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 4, w: 4, h: 4 }],
  // QUADRANT UPPER LEFT AND LOWER RIGHT
  "\u259B": [{ x: 0, y: 0, w: 4, h: 8 }, { x: 4, y: 0, w: 4, h: 4 }],
  // QUADRANT UPPER LEFT AND UPPER RIGHT AND LOWER LEFT
  "\u259C": [{ x: 0, y: 0, w: 8, h: 4 }, { x: 4, y: 0, w: 4, h: 8 }],
  // QUADRANT UPPER LEFT AND UPPER RIGHT AND LOWER RIGHT
  "\u259D": [{ x: 4, y: 0, w: 4, h: 4 }],
  // QUADRANT UPPER RIGHT
  "\u259E": [{ x: 4, y: 0, w: 4, h: 4 }, { x: 0, y: 4, w: 4, h: 4 }],
  // QUADRANT UPPER RIGHT AND LOWER LEFT
  "\u259F": [{ x: 4, y: 0, w: 4, h: 8 }, { x: 0, y: 4, w: 8, h: 4 }],
  // QUADRANT UPPER RIGHT AND LOWER LEFT AND LOWER RIGHT
  // VERTICAL ONE EIGHTH BLOCK-2 through VERTICAL ONE EIGHTH BLOCK-7
  "\u{1FB70}": [{ x: 1, y: 0, w: 1, h: 8 }],
  "\u{1FB71}": [{ x: 2, y: 0, w: 1, h: 8 }],
  "\u{1FB72}": [{ x: 3, y: 0, w: 1, h: 8 }],
  "\u{1FB73}": [{ x: 4, y: 0, w: 1, h: 8 }],
  "\u{1FB74}": [{ x: 5, y: 0, w: 1, h: 8 }],
  "\u{1FB75}": [{ x: 6, y: 0, w: 1, h: 8 }],
  // HORIZONTAL ONE EIGHTH BLOCK-2 through HORIZONTAL ONE EIGHTH BLOCK-7
  "\u{1FB76}": [{ x: 0, y: 1, w: 8, h: 1 }],
  "\u{1FB77}": [{ x: 0, y: 2, w: 8, h: 1 }],
  "\u{1FB78}": [{ x: 0, y: 3, w: 8, h: 1 }],
  "\u{1FB79}": [{ x: 0, y: 4, w: 8, h: 1 }],
  "\u{1FB7A}": [{ x: 0, y: 5, w: 8, h: 1 }],
  "\u{1FB7B}": [{ x: 0, y: 6, w: 8, h: 1 }],
  // LEFT AND LOWER ONE EIGHTH BLOCK
  "\u{1FB7C}": [{ x: 0, y: 0, w: 1, h: 8 }, { x: 0, y: 7, w: 8, h: 1 }],
  // LEFT AND UPPER ONE EIGHTH BLOCK
  "\u{1FB7D}": [{ x: 0, y: 0, w: 1, h: 8 }, { x: 0, y: 0, w: 8, h: 1 }],
  // RIGHT AND UPPER ONE EIGHTH BLOCK
  "\u{1FB7E}": [{ x: 7, y: 0, w: 1, h: 8 }, { x: 0, y: 0, w: 8, h: 1 }],
  // RIGHT AND LOWER ONE EIGHTH BLOCK
  "\u{1FB7F}": [{ x: 7, y: 0, w: 1, h: 8 }, { x: 0, y: 7, w: 8, h: 1 }],
  // UPPER AND LOWER ONE EIGHTH BLOCK
  "\u{1FB80}": [{ x: 0, y: 0, w: 8, h: 1 }, { x: 0, y: 7, w: 8, h: 1 }],
  // HORIZONTAL ONE EIGHTH BLOCK-1358
  "\u{1FB81}": [{ x: 0, y: 0, w: 8, h: 1 }, { x: 0, y: 2, w: 8, h: 1 }, { x: 0, y: 4, w: 8, h: 1 }, { x: 0, y: 7, w: 8, h: 1 }],
  // UPPER ONE QUARTER BLOCK
  "\u{1FB82}": [{ x: 0, y: 0, w: 8, h: 2 }],
  // UPPER THREE EIGHTHS BLOCK
  "\u{1FB83}": [{ x: 0, y: 0, w: 8, h: 3 }],
  // UPPER FIVE EIGHTHS BLOCK
  "\u{1FB84}": [{ x: 0, y: 0, w: 8, h: 5 }],
  // UPPER THREE QUARTERS BLOCK
  "\u{1FB85}": [{ x: 0, y: 0, w: 8, h: 6 }],
  // UPPER SEVEN EIGHTHS BLOCK
  "\u{1FB86}": [{ x: 0, y: 0, w: 8, h: 7 }],
  // RIGHT ONE QUARTER BLOCK
  "\u{1FB87}": [{ x: 6, y: 0, w: 2, h: 8 }],
  // RIGHT THREE EIGHTHS B0OCK
  "\u{1FB88}": [{ x: 5, y: 0, w: 3, h: 8 }],
  // RIGHT FIVE EIGHTHS BL0CK
  "\u{1FB89}": [{ x: 3, y: 0, w: 5, h: 8 }],
  // RIGHT THREE QUARTERS 0LOCK
  "\u{1FB8A}": [{ x: 2, y: 0, w: 6, h: 8 }],
  // RIGHT SEVEN EIGHTHS B0OCK
  "\u{1FB8B}": [{ x: 1, y: 0, w: 7, h: 8 }],
  // CHECKER BOARD FILL
  "\u{1FB95}": [
    { x: 0, y: 0, w: 2, h: 2 },
    { x: 4, y: 0, w: 2, h: 2 },
    { x: 2, y: 2, w: 2, h: 2 },
    { x: 6, y: 2, w: 2, h: 2 },
    { x: 0, y: 4, w: 2, h: 2 },
    { x: 4, y: 4, w: 2, h: 2 },
    { x: 2, y: 6, w: 2, h: 2 },
    { x: 6, y: 6, w: 2, h: 2 }
  ],
  // INVERSE CHECKER BOARD FILL
  "\u{1FB96}": [
    { x: 2, y: 0, w: 2, h: 2 },
    { x: 6, y: 0, w: 2, h: 2 },
    { x: 0, y: 2, w: 2, h: 2 },
    { x: 4, y: 2, w: 2, h: 2 },
    { x: 2, y: 4, w: 2, h: 2 },
    { x: 6, y: 4, w: 2, h: 2 },
    { x: 0, y: 6, w: 2, h: 2 },
    { x: 4, y: 6, w: 2, h: 2 }
  ],
  // HEAVY HORIZONTAL FILL (upper middle and lower one quarter block)
  "\u{1FB97}": [{ x: 0, y: 2, w: 8, h: 2 }, { x: 0, y: 6, w: 8, h: 2 }]
};
var patternCharacterDefinitions = {
  // Shade characters (0x2591-0x2593)
  "\u2591": [
    // LIGHT SHADE (25%)
    [1, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 0]
  ],
  "\u2592": [
    // MEDIUM SHADE (50%)
    [1, 0],
    [0, 0],
    [0, 1],
    [0, 0]
  ],
  "\u2593": [
    // DARK SHADE (75%)
    [0, 1],
    [1, 1],
    [1, 0],
    [1, 1]
  ]
};
var boxDrawingDefinitions = {
  // Uniform normal and bold
  "\u2500": { [1 /* NORMAL */]: "M0,.5 L1,.5" /* LEFT_TO_RIGHT */ },
  "\u2501": { [3 /* BOLD */]: "M0,.5 L1,.5" /* LEFT_TO_RIGHT */ },
  "\u2502": { [1 /* NORMAL */]: "M.5,0 L.5,1" /* TOP_TO_BOTTOM */ },
  "\u2503": { [3 /* BOLD */]: "M.5,0 L.5,1" /* TOP_TO_BOTTOM */ },
  "\u250C": { [1 /* NORMAL */]: "M0.5,1 L.5,.5 L1,.5" /* RIGHT_TO_BOTTOM */ },
  "\u250F": { [3 /* BOLD */]: "M0.5,1 L.5,.5 L1,.5" /* RIGHT_TO_BOTTOM */ },
  "\u2510": { [1 /* NORMAL */]: "M0,.5 L.5,.5 L.5,1" /* LEFT_TO_BOTTOM */ },
  "\u2513": { [3 /* BOLD */]: "M0,.5 L.5,.5 L.5,1" /* LEFT_TO_BOTTOM */ },
  "\u2514": { [1 /* NORMAL */]: "M.5,0 L.5,.5 L1,.5" /* TOP_TO_RIGHT */ },
  "\u2517": { [3 /* BOLD */]: "M.5,0 L.5,.5 L1,.5" /* TOP_TO_RIGHT */ },
  "\u2518": { [1 /* NORMAL */]: "M.5,0 L.5,.5 L0,.5" /* TOP_TO_LEFT */ },
  "\u251B": { [3 /* BOLD */]: "M.5,0 L.5,.5 L0,.5" /* TOP_TO_LEFT */ },
  "\u251C": { [1 /* NORMAL */]: "M.5,0 L.5,1 M.5,.5 L1,.5" /* T_RIGHT */ },
  "\u2523": { [3 /* BOLD */]: "M.5,0 L.5,1 M.5,.5 L1,.5" /* T_RIGHT */ },
  "\u2524": { [1 /* NORMAL */]: "M.5,0 L.5,1 M.5,.5 L0,.5" /* T_LEFT */ },
  "\u252B": { [3 /* BOLD */]: "M.5,0 L.5,1 M.5,.5 L0,.5" /* T_LEFT */ },
  "\u252C": { [1 /* NORMAL */]: "M0,.5 L1,.5 M.5,.5 L.5,1" /* T_BOTTOM */ },
  "\u2533": { [3 /* BOLD */]: "M0,.5 L1,.5 M.5,.5 L.5,1" /* T_BOTTOM */ },
  "\u2534": { [1 /* NORMAL */]: "M0,.5 L1,.5 M.5,.5 L.5,0" /* T_TOP */ },
  "\u253B": { [3 /* BOLD */]: "M0,.5 L1,.5 M.5,.5 L.5,0" /* T_TOP */ },
  "\u253C": { [1 /* NORMAL */]: "M0,.5 L1,.5 M.5,0 L.5,1" /* CROSS */ },
  "\u254B": { [3 /* BOLD */]: "M0,.5 L1,.5 M.5,0 L.5,1" /* CROSS */ },
  "\u2574": { [1 /* NORMAL */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */ },
  "\u2578": { [3 /* BOLD */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */ },
  "\u2575": { [1 /* NORMAL */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */ },
  "\u2579": { [3 /* BOLD */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */ },
  "\u2576": { [1 /* NORMAL */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */ },
  "\u257A": { [3 /* BOLD */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */ },
  "\u2577": { [1 /* NORMAL */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */ },
  "\u257B": { [3 /* BOLD */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */ },
  // Double border
  "\u2550": { [1 /* NORMAL */]: (xp, yp) => `M0,${0.5 - yp} L1,${0.5 - yp} M0,${0.5 + yp} L1,${0.5 + yp}` },
  "\u2551": { [1 /* NORMAL */]: (xp, yp) => `M${0.5 - xp},0 L${0.5 - xp},1 M${0.5 + xp},0 L${0.5 + xp},1` },
  "\u2552": { [1 /* NORMAL */]: (xp, yp) => `M.5,1 L.5,${0.5 - yp} L1,${0.5 - yp} M.5,${0.5 + yp} L1,${0.5 + yp}` },
  "\u2553": { [1 /* NORMAL */]: (xp, yp) => `M${0.5 - xp},1 L${0.5 - xp},.5 L1,.5 M${0.5 + xp},.5 L${0.5 + xp},1` },
  "\u2554": { [1 /* NORMAL */]: (xp, yp) => `M1,${0.5 - yp} L${0.5 - xp},${0.5 - yp} L${0.5 - xp},1 M1,${0.5 + yp} L${0.5 + xp},${0.5 + yp} L${0.5 + xp},1` },
  "\u2555": { [1 /* NORMAL */]: (xp, yp) => `M0,${0.5 - yp} L.5,${0.5 - yp} L.5,1 M0,${0.5 + yp} L.5,${0.5 + yp}` },
  "\u2556": { [1 /* NORMAL */]: (xp, yp) => `M${0.5 + xp},1 L${0.5 + xp},.5 L0,.5 M${0.5 - xp},.5 L${0.5 - xp},1` },
  "\u2557": { [1 /* NORMAL */]: (xp, yp) => `M0,${0.5 + yp} L${0.5 - xp},${0.5 + yp} L${0.5 - xp},1 M0,${0.5 - yp} L${0.5 + xp},${0.5 - yp} L${0.5 + xp},1` },
  "\u2558": { [1 /* NORMAL */]: (xp, yp) => `M.5,0 L.5,${0.5 + yp} L1,${0.5 + yp} M.5,${0.5 - yp} L1,${0.5 - yp}` },
  "\u2559": { [1 /* NORMAL */]: (xp, yp) => `M1,.5 L${0.5 - xp},.5 L${0.5 - xp},0 M${0.5 + xp},.5 L${0.5 + xp},0` },
  "\u255A": { [1 /* NORMAL */]: (xp, yp) => `M1,${0.5 - yp} L${0.5 + xp},${0.5 - yp} L${0.5 + xp},0 M1,${0.5 + yp} L${0.5 - xp},${0.5 + yp} L${0.5 - xp},0` },
  "\u255B": { [1 /* NORMAL */]: (xp, yp) => `M0,${0.5 + yp} L.5,${0.5 + yp} L.5,0 M0,${0.5 - yp} L.5,${0.5 - yp}` },
  "\u255C": { [1 /* NORMAL */]: (xp, yp) => `M0,.5 L${0.5 + xp},.5 L${0.5 + xp},0 M${0.5 - xp},.5 L${0.5 - xp},0` },
  "\u255D": { [1 /* NORMAL */]: (xp, yp) => `M0,${0.5 - yp} L${0.5 - xp},${0.5 - yp} L${0.5 - xp},0 M0,${0.5 + yp} L${0.5 + xp},${0.5 + yp} L${0.5 + xp},0` },
  "\u255E": { [1 /* NORMAL */]: (xp, yp) => `${"M.5,0 L.5,1" /* TOP_TO_BOTTOM */} M.5,${0.5 - yp} L1,${0.5 - yp} M.5,${0.5 + yp} L1,${0.5 + yp}` },
  "\u255F": { [1 /* NORMAL */]: (xp, yp) => `M${0.5 - xp},0 L${0.5 - xp},1 M${0.5 + xp},0 L${0.5 + xp},1 M${0.5 + xp},.5 L1,.5` },
  "\u2560": { [1 /* NORMAL */]: (xp, yp) => `M${0.5 - xp},0 L${0.5 - xp},1 M1,${0.5 + yp} L${0.5 + xp},${0.5 + yp} L${0.5 + xp},1 M1,${0.5 - yp} L${0.5 + xp},${0.5 - yp} L${0.5 + xp},0` },
  "\u2561": { [1 /* NORMAL */]: (xp, yp) => `${"M.5,0 L.5,1" /* TOP_TO_BOTTOM */} M0,${0.5 - yp} L.5,${0.5 - yp} M0,${0.5 + yp} L.5,${0.5 + yp}` },
  "\u2562": { [1 /* NORMAL */]: (xp, yp) => `M0,.5 L${0.5 - xp},.5 M${0.5 - xp},0 L${0.5 - xp},1 M${0.5 + xp},0 L${0.5 + xp},1` },
  "\u2563": { [1 /* NORMAL */]: (xp, yp) => `M${0.5 + xp},0 L${0.5 + xp},1 M0,${0.5 + yp} L${0.5 - xp},${0.5 + yp} L${0.5 - xp},1 M0,${0.5 - yp} L${0.5 - xp},${0.5 - yp} L${0.5 - xp},0` },
  "\u2564": { [1 /* NORMAL */]: (xp, yp) => `M0,${0.5 - yp} L1,${0.5 - yp} M0,${0.5 + yp} L1,${0.5 + yp} M.5,${0.5 + yp} L.5,1` },
  "\u2565": { [1 /* NORMAL */]: (xp, yp) => `${"M0,.5 L1,.5" /* LEFT_TO_RIGHT */} M${0.5 - xp},.5 L${0.5 - xp},1 M${0.5 + xp},.5 L${0.5 + xp},1` },
  "\u2566": { [1 /* NORMAL */]: (xp, yp) => `M0,${0.5 - yp} L1,${0.5 - yp} M0,${0.5 + yp} L${0.5 - xp},${0.5 + yp} L${0.5 - xp},1 M1,${0.5 + yp} L${0.5 + xp},${0.5 + yp} L${0.5 + xp},1` },
  "\u2567": { [1 /* NORMAL */]: (xp, yp) => `M.5,0 L.5,${0.5 - yp} M0,${0.5 - yp} L1,${0.5 - yp} M0,${0.5 + yp} L1,${0.5 + yp}` },
  "\u2568": { [1 /* NORMAL */]: (xp, yp) => `${"M0,.5 L1,.5" /* LEFT_TO_RIGHT */} M${0.5 - xp},.5 L${0.5 - xp},0 M${0.5 + xp},.5 L${0.5 + xp},0` },
  "\u2569": { [1 /* NORMAL */]: (xp, yp) => `M0,${0.5 + yp} L1,${0.5 + yp} M0,${0.5 - yp} L${0.5 - xp},${0.5 - yp} L${0.5 - xp},0 M1,${0.5 - yp} L${0.5 + xp},${0.5 - yp} L${0.5 + xp},0` },
  "\u256A": { [1 /* NORMAL */]: (xp, yp) => `${"M.5,0 L.5,1" /* TOP_TO_BOTTOM */} M0,${0.5 - yp} L1,${0.5 - yp} M0,${0.5 + yp} L1,${0.5 + yp}` },
  "\u256B": { [1 /* NORMAL */]: (xp, yp) => `${"M0,.5 L1,.5" /* LEFT_TO_RIGHT */} M${0.5 - xp},0 L${0.5 - xp},1 M${0.5 + xp},0 L${0.5 + xp},1` },
  "\u256C": { [1 /* NORMAL */]: (xp, yp) => `M0,${0.5 + yp} L${0.5 - xp},${0.5 + yp} L${0.5 - xp},1 M1,${0.5 + yp} L${0.5 + xp},${0.5 + yp} L${0.5 + xp},1 M0,${0.5 - yp} L${0.5 - xp},${0.5 - yp} L${0.5 - xp},0 M1,${0.5 - yp} L${0.5 + xp},${0.5 - yp} L${0.5 + xp},0` },
  // Diagonal
  "\u2571": { [1 /* NORMAL */]: "M1,0 L0,1" },
  "\u2572": { [1 /* NORMAL */]: "M0,0 L1,1" },
  "\u2573": { [1 /* NORMAL */]: "M1,0 L0,1 M0,0 L1,1" },
  // Mixed weight
  "\u257C": { [1 /* NORMAL */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */, [3 /* BOLD */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */ },
  "\u257D": { [1 /* NORMAL */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */, [3 /* BOLD */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */ },
  "\u257E": { [1 /* NORMAL */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */, [3 /* BOLD */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */ },
  "\u257F": { [1 /* NORMAL */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */, [3 /* BOLD */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */ },
  "\u250D": { [1 /* NORMAL */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */, [3 /* BOLD */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */ },
  "\u250E": { [1 /* NORMAL */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */, [3 /* BOLD */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */ },
  "\u2511": { [1 /* NORMAL */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */, [3 /* BOLD */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */ },
  "\u2512": { [1 /* NORMAL */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */, [3 /* BOLD */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */ },
  "\u2515": { [1 /* NORMAL */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */, [3 /* BOLD */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */ },
  "\u2516": { [1 /* NORMAL */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */, [3 /* BOLD */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */ },
  "\u2519": { [1 /* NORMAL */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */, [3 /* BOLD */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */ },
  "\u251A": { [1 /* NORMAL */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */, [3 /* BOLD */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */ },
  "\u251D": { [1 /* NORMAL */]: "M.5,0 L.5,1" /* TOP_TO_BOTTOM */, [3 /* BOLD */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */ },
  "\u251E": { [1 /* NORMAL */]: "M0.5,1 L.5,.5 L1,.5" /* RIGHT_TO_BOTTOM */, [3 /* BOLD */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */ },
  "\u251F": { [1 /* NORMAL */]: "M.5,0 L.5,.5 L1,.5" /* TOP_TO_RIGHT */, [3 /* BOLD */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */ },
  "\u2520": { [1 /* NORMAL */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */, [3 /* BOLD */]: "M.5,0 L.5,1" /* TOP_TO_BOTTOM */ },
  "\u2521": { [1 /* NORMAL */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */, [3 /* BOLD */]: "M.5,0 L.5,.5 L1,.5" /* TOP_TO_RIGHT */ },
  "\u2522": { [1 /* NORMAL */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */, [3 /* BOLD */]: "M0.5,1 L.5,.5 L1,.5" /* RIGHT_TO_BOTTOM */ },
  "\u2525": { [1 /* NORMAL */]: "M.5,0 L.5,1" /* TOP_TO_BOTTOM */, [3 /* BOLD */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */ },
  "\u2526": { [1 /* NORMAL */]: "M0,.5 L.5,.5 L.5,1" /* LEFT_TO_BOTTOM */, [3 /* BOLD */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */ },
  "\u2527": { [1 /* NORMAL */]: "M.5,0 L.5,.5 L0,.5" /* TOP_TO_LEFT */, [3 /* BOLD */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */ },
  "\u2528": { [1 /* NORMAL */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */, [3 /* BOLD */]: "M.5,0 L.5,1" /* TOP_TO_BOTTOM */ },
  "\u2529": { [1 /* NORMAL */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */, [3 /* BOLD */]: "M.5,0 L.5,.5 L0,.5" /* TOP_TO_LEFT */ },
  "\u252A": { [1 /* NORMAL */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */, [3 /* BOLD */]: "M0,.5 L.5,.5 L.5,1" /* LEFT_TO_BOTTOM */ },
  "\u252D": { [1 /* NORMAL */]: "M0.5,1 L.5,.5 L1,.5" /* RIGHT_TO_BOTTOM */, [3 /* BOLD */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */ },
  "\u252E": { [1 /* NORMAL */]: "M0,.5 L.5,.5 L.5,1" /* LEFT_TO_BOTTOM */, [3 /* BOLD */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */ },
  "\u252F": { [1 /* NORMAL */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */, [3 /* BOLD */]: "M0,.5 L1,.5" /* LEFT_TO_RIGHT */ },
  "\u2530": { [1 /* NORMAL */]: "M0,.5 L1,.5" /* LEFT_TO_RIGHT */, [3 /* BOLD */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */ },
  "\u2531": { [1 /* NORMAL */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */, [3 /* BOLD */]: "M0,.5 L.5,.5 L.5,1" /* LEFT_TO_BOTTOM */ },
  "\u2532": { [1 /* NORMAL */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */, [3 /* BOLD */]: "M0.5,1 L.5,.5 L1,.5" /* RIGHT_TO_BOTTOM */ },
  "\u2535": { [1 /* NORMAL */]: "M.5,0 L.5,.5 L1,.5" /* TOP_TO_RIGHT */, [3 /* BOLD */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */ },
  "\u2536": { [1 /* NORMAL */]: "M.5,0 L.5,.5 L0,.5" /* TOP_TO_LEFT */, [3 /* BOLD */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */ },
  "\u2537": { [1 /* NORMAL */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */, [3 /* BOLD */]: "M0,.5 L1,.5" /* LEFT_TO_RIGHT */ },
  "\u2538": { [1 /* NORMAL */]: "M0,.5 L1,.5" /* LEFT_TO_RIGHT */, [3 /* BOLD */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */ },
  "\u2539": { [1 /* NORMAL */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */, [3 /* BOLD */]: "M.5,0 L.5,.5 L0,.5" /* TOP_TO_LEFT */ },
  "\u253A": { [1 /* NORMAL */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */, [3 /* BOLD */]: "M.5,0 L.5,.5 L1,.5" /* TOP_TO_RIGHT */ },
  "\u253D": { [1 /* NORMAL */]: `${"M.5,0 L.5,1" /* TOP_TO_BOTTOM */} ${"M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */}`, [3 /* BOLD */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */ },
  "\u253E": { [1 /* NORMAL */]: `${"M.5,0 L.5,1" /* TOP_TO_BOTTOM */} ${"M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */}`, [3 /* BOLD */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */ },
  "\u253F": { [1 /* NORMAL */]: "M.5,0 L.5,1" /* TOP_TO_BOTTOM */, [3 /* BOLD */]: "M0,.5 L1,.5" /* LEFT_TO_RIGHT */ },
  "\u2540": { [1 /* NORMAL */]: `${"M0,.5 L1,.5" /* LEFT_TO_RIGHT */} ${"M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */}`, [3 /* BOLD */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */ },
  "\u2541": { [1 /* NORMAL */]: `${"M.5,.5 L.5,0" /* MIDDLE_TO_TOP */} ${"M0,.5 L1,.5" /* LEFT_TO_RIGHT */}`, [3 /* BOLD */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */ },
  "\u2542": { [1 /* NORMAL */]: "M0,.5 L1,.5" /* LEFT_TO_RIGHT */, [3 /* BOLD */]: "M.5,0 L.5,1" /* TOP_TO_BOTTOM */ },
  "\u2543": { [1 /* NORMAL */]: "M0.5,1 L.5,.5 L1,.5" /* RIGHT_TO_BOTTOM */, [3 /* BOLD */]: "M.5,0 L.5,.5 L0,.5" /* TOP_TO_LEFT */ },
  "\u2544": { [1 /* NORMAL */]: "M0,.5 L.5,.5 L.5,1" /* LEFT_TO_BOTTOM */, [3 /* BOLD */]: "M.5,0 L.5,.5 L1,.5" /* TOP_TO_RIGHT */ },
  "\u2545": { [1 /* NORMAL */]: "M.5,0 L.5,.5 L1,.5" /* TOP_TO_RIGHT */, [3 /* BOLD */]: "M0,.5 L.5,.5 L.5,1" /* LEFT_TO_BOTTOM */ },
  "\u2546": { [1 /* NORMAL */]: "M.5,0 L.5,.5 L0,.5" /* TOP_TO_LEFT */, [3 /* BOLD */]: "M0.5,1 L.5,.5 L1,.5" /* RIGHT_TO_BOTTOM */ },
  "\u2547": { [1 /* NORMAL */]: "M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */, [3 /* BOLD */]: `${"M.5,.5 L.5,0" /* MIDDLE_TO_TOP */} ${"M0,.5 L1,.5" /* LEFT_TO_RIGHT */}` },
  "\u2548": { [1 /* NORMAL */]: "M.5,.5 L.5,0" /* MIDDLE_TO_TOP */, [3 /* BOLD */]: `${"M0,.5 L1,.5" /* LEFT_TO_RIGHT */} ${"M.5,.5 L.5,1" /* MIDDLE_TO_BOTTOM */}` },
  "\u2549": { [1 /* NORMAL */]: "M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */, [3 /* BOLD */]: `${"M.5,0 L.5,1" /* TOP_TO_BOTTOM */} ${"M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */}` },
  "\u254A": { [1 /* NORMAL */]: "M.5,.5 L0,.5" /* MIDDLE_TO_LEFT */, [3 /* BOLD */]: `${"M.5,0 L.5,1" /* TOP_TO_BOTTOM */} ${"M.5,.5 L1,.5" /* MIDDLE_TO_RIGHT */}` },
  // Dashed
  "\u254C": { [1 /* NORMAL */]: "M.1,.5 L.4,.5 M.6,.5 L.9,.5" /* TWO_DASHES_HORIZONTAL */ },
  "\u254D": { [3 /* BOLD */]: "M.1,.5 L.4,.5 M.6,.5 L.9,.5" /* TWO_DASHES_HORIZONTAL */ },
  "\u2504": { [1 /* NORMAL */]: "M.0667,.5 L.2667,.5 M.4,.5 L.6,.5 M.7333,.5 L.9333,.5" /* THREE_DASHES_HORIZONTAL */ },
  "\u2505": { [3 /* BOLD */]: "M.0667,.5 L.2667,.5 M.4,.5 L.6,.5 M.7333,.5 L.9333,.5" /* THREE_DASHES_HORIZONTAL */ },
  "\u2508": { [1 /* NORMAL */]: "M.05,.5 L.2,.5 M.3,.5 L.45,.5 M.55,.5 L.7,.5 M.8,.5 L.95,.5" /* FOUR_DASHES_HORIZONTAL */ },
  "\u2509": { [3 /* BOLD */]: "M.05,.5 L.2,.5 M.3,.5 L.45,.5 M.55,.5 L.7,.5 M.8,.5 L.95,.5" /* FOUR_DASHES_HORIZONTAL */ },
  "\u254E": { [1 /* NORMAL */]: "M.5,.1 L.5,.4 M.5,.6 L.5,.9" /* TWO_DASHES_VERTICAL */ },
  "\u254F": { [3 /* BOLD */]: "M.5,.1 L.5,.4 M.5,.6 L.5,.9" /* TWO_DASHES_VERTICAL */ },
  "\u2506": { [1 /* NORMAL */]: "M.5,.0667 L.5,.2667 M.5,.4 L.5,.6 M.5,.7333 L.5,.9333" /* THREE_DASHES_VERTICAL */ },
  "\u2507": { [3 /* BOLD */]: "M.5,.0667 L.5,.2667 M.5,.4 L.5,.6 M.5,.7333 L.5,.9333" /* THREE_DASHES_VERTICAL */ },
  "\u250A": { [1 /* NORMAL */]: "M.5,.05 L.5,.2 M.5,.3 L.5,.45 L.5,.55 M.5,.7 L.5,.95" /* FOUR_DASHES_VERTICAL */ },
  "\u250B": { [3 /* BOLD */]: "M.5,.05 L.5,.2 M.5,.3 L.5,.45 L.5,.55 M.5,.7 L.5,.95" /* FOUR_DASHES_VERTICAL */ },
  // Curved
  "\u256D": { [1 /* NORMAL */]: (xp, yp) => `M.5,1 L.5,${0.5 + yp / 0.15 * 0.5} C.5,${0.5 + yp / 0.15 * 0.5},.5,.5,1,.5` },
  "\u256E": { [1 /* NORMAL */]: (xp, yp) => `M.5,1 L.5,${0.5 + yp / 0.15 * 0.5} C.5,${0.5 + yp / 0.15 * 0.5},.5,.5,0,.5` },
  "\u256F": { [1 /* NORMAL */]: (xp, yp) => `M.5,0 L.5,${0.5 - yp / 0.15 * 0.5} C.5,${0.5 - yp / 0.15 * 0.5},.5,.5,0,.5` },
  "\u2570": { [1 /* NORMAL */]: (xp, yp) => `M.5,0 L.5,${0.5 - yp / 0.15 * 0.5} C.5,${0.5 - yp / 0.15 * 0.5},.5,.5,1,.5` }
};
var powerlineDefinitions = {
  // Git branch
  "\uE0A0": { d: "M.3,1 L.03,1 L.03,.88 C.03,.82,.06,.78,.11,.73 C.15,.7,.2,.68,.28,.65 L.43,.6 C.49,.58,.53,.56,.56,.53 C.59,.5,.6,.47,.6,.43 L.6,.27 L.4,.27 L.69,.1 L.98,.27 L.78,.27 L.78,.46 C.78,.52,.76,.56,.72,.61 C.68,.66,.63,.67,.56,.7 L.48,.72 C.42,.74,.38,.76,.35,.78 C.32,.8,.31,.84,.31,.88 L.31,1 M.3,.5 L.03,.59 L.03,.09 L.3,.09 L.3,.655", type: 0 /* FILL */ },
  // L N
  "\uE0A1": { d: "M.7,.4 L.7,.47 L.2,.47 L.2,.03 L.355,.03 L.355,.4 L.705,.4 M.7,.5 L.86,.5 L.86,.95 L.69,.95 L.44,.66 L.46,.86 L.46,.95 L.3,.95 L.3,.49 L.46,.49 L.71,.78 L.69,.565 L.69,.5", type: 0 /* FILL */ },
  // Lock
  "\uE0A2": { d: "M.25,.94 C.16,.94,.11,.92,.11,.87 L.11,.53 C.11,.48,.15,.455,.23,.45 L.23,.3 C.23,.25,.26,.22,.31,.19 C.36,.16,.43,.15,.51,.15 C.59,.15,.66,.16,.71,.19 C.77,.22,.79,.26,.79,.3 L.79,.45 C.87,.45,.91,.48,.91,.53 L.91,.87 C.91,.92,.86,.94,.77,.94 L.24,.94 M.53,.2 C.49,.2,.45,.21,.42,.23 C.39,.25,.38,.27,.38,.3 L.38,.45 L.68,.45 L.68,.3 C.68,.27,.67,.25,.64,.23 C.61,.21,.58,.2,.53,.2 M.58,.82 L.58,.66 C.63,.65,.65,.63,.65,.6 C.65,.58,.64,.57,.61,.56 C.58,.55,.56,.54,.52,.54 C.48,.54,.46,.55,.43,.56 C.4,.57,.39,.59,.39,.6 C.39,.63,.41,.64,.46,.66 L.46,.82 L.57,.82", type: 0 /* FILL */ },
  // Right triangle solid
  "\uE0B0": { d: "M0,0 L1,.5 L0,1", type: 0 /* FILL */, rightPadding: 2 },
  // Right triangle line
  "\uE0B1": { d: "M-1,-.5 L1,.5 L-1,1.5", type: 1 /* STROKE */, leftPadding: 1, rightPadding: 1 },
  // Left triangle solid
  "\uE0B2": { d: "M1,0 L0,.5 L1,1", type: 0 /* FILL */, leftPadding: 2 },
  // Left triangle line
  "\uE0B3": { d: "M2,-.5 L0,.5 L2,1.5", type: 1 /* STROKE */, leftPadding: 1, rightPadding: 1 },
  // Right semi-circle solid
  "\uE0B4": { d: "M0,0 L0,1 C0.552,1,1,0.776,1,.5 C1,0.224,0.552,0,0,0", type: 0 /* FILL */, rightPadding: 1 },
  // Right semi-circle line
  "\uE0B5": { d: "M.2,1 C.422,1,.8,.826,.78,.5 C.8,.174,0.422,0,.2,0", type: 1 /* STROKE */, rightPadding: 1 },
  // Left semi-circle solid
  "\uE0B6": { d: "M1,0 L1,1 C0.448,1,0,0.776,0,.5 C0,0.224,0.448,0,1,0", type: 0 /* FILL */, leftPadding: 1 },
  // Left semi-circle line
  "\uE0B7": { d: "M.8,1 C0.578,1,0.2,.826,.22,.5 C0.2,0.174,0.578,0,0.8,0", type: 1 /* STROKE */, leftPadding: 1 },
  // Lower left triangle
  "\uE0B8": { d: "M-.5,-.5 L1.5,1.5 L-.5,1.5", type: 0 /* FILL */ },
  // Backslash separator
  "\uE0B9": { d: "M-.5,-.5 L1.5,1.5", type: 1 /* STROKE */, leftPadding: 1, rightPadding: 1 },
  // Lower right triangle
  "\uE0BA": { d: "M1.5,-.5 L-.5,1.5 L1.5,1.5", type: 0 /* FILL */ },
  // Upper left triangle
  "\uE0BC": { d: "M1.5,-.5 L-.5,1.5 L-.5,-.5", type: 0 /* FILL */ },
  // Forward slash separator
  "\uE0BD": { d: "M1.5,-.5 L-.5,1.5", type: 1 /* STROKE */, leftPadding: 1, rightPadding: 1 },
  // Upper right triangle
  "\uE0BE": { d: "M-.5,-.5 L1.5,1.5 L1.5,-.5", type: 0 /* FILL */ }
};
powerlineDefinitions["\uE0BB"] = powerlineDefinitions["\uE0BD"];
powerlineDefinitions["\uE0BF"] = powerlineDefinitions["\uE0B9"];
function tryDrawCustomChar(ctx, c, xOffset, yOffset, deviceCellWidth, deviceCellHeight, fontSize, devicePixelRatio) {
  const blockElementDefinition = blockElementDefinitions[c];
  if (blockElementDefinition) {
    drawBlockElementChar(ctx, blockElementDefinition, xOffset, yOffset, deviceCellWidth, deviceCellHeight);
    return true;
  }
  const patternDefinition = patternCharacterDefinitions[c];
  if (patternDefinition) {
    drawPatternChar(ctx, patternDefinition, xOffset, yOffset, deviceCellWidth, deviceCellHeight);
    return true;
  }
  const boxDrawingDefinition = boxDrawingDefinitions[c];
  if (boxDrawingDefinition) {
    drawBoxDrawingChar(ctx, boxDrawingDefinition, xOffset, yOffset, deviceCellWidth, deviceCellHeight, devicePixelRatio);
    return true;
  }
  const powerlineDefinition = powerlineDefinitions[c];
  if (powerlineDefinition) {
    drawPowerlineChar(ctx, powerlineDefinition, xOffset, yOffset, deviceCellWidth, deviceCellHeight, fontSize, devicePixelRatio);
    return true;
  }
  return false;
}
function drawBlockElementChar(ctx, charDefinition, xOffset, yOffset, deviceCellWidth, deviceCellHeight) {
  for (let i = 0; i < charDefinition.length; i++) {
    const box = charDefinition[i];
    const xEighth = deviceCellWidth / 8;
    const yEighth = deviceCellHeight / 8;
    ctx.fillRect(
      xOffset + box.x * xEighth,
      yOffset + box.y * yEighth,
      box.w * xEighth,
      box.h * yEighth
    );
  }
}
var cachedPatterns = /* @__PURE__ */ new Map();
function drawPatternChar(ctx, charDefinition, xOffset, yOffset, deviceCellWidth, deviceCellHeight) {
  let patternSet = cachedPatterns.get(charDefinition);
  if (!patternSet) {
    patternSet = /* @__PURE__ */ new Map();
    cachedPatterns.set(charDefinition, patternSet);
  }
  const fillStyle = ctx.fillStyle;
  if (typeof fillStyle !== "string") {
    throw new Error(`Unexpected fillStyle type "${fillStyle}"`);
  }
  let pattern = patternSet.get(fillStyle);
  if (!pattern) {
    const width = charDefinition[0].length;
    const height = charDefinition.length;
    const tmpCanvas = ctx.canvas.ownerDocument.createElement("canvas");
    tmpCanvas.width = width;
    tmpCanvas.height = height;
    const tmpCtx = throwIfFalsy(tmpCanvas.getContext("2d"));
    const imageData = new ImageData(width, height);
    let r;
    let g;
    let b;
    let a;
    if (fillStyle.startsWith("#")) {
      r = parseInt(fillStyle.slice(1, 3), 16);
      g = parseInt(fillStyle.slice(3, 5), 16);
      b = parseInt(fillStyle.slice(5, 7), 16);
      a = fillStyle.length > 7 && parseInt(fillStyle.slice(7, 9), 16) || 1;
    } else if (fillStyle.startsWith("rgba")) {
      [r, g, b, a] = fillStyle.substring(5, fillStyle.length - 1).split(",").map((e) => parseFloat(e));
    } else {
      throw new Error(`Unexpected fillStyle color format "${fillStyle}" when drawing pattern glyph`);
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        imageData.data[(y * width + x) * 4] = r;
        imageData.data[(y * width + x) * 4 + 1] = g;
        imageData.data[(y * width + x) * 4 + 2] = b;
        imageData.data[(y * width + x) * 4 + 3] = charDefinition[y][x] * (a * 255);
      }
    }
    tmpCtx.putImageData(imageData, 0, 0);
    pattern = throwIfFalsy(ctx.createPattern(tmpCanvas, null));
    patternSet.set(fillStyle, pattern);
  }
  ctx.fillStyle = pattern;
  ctx.fillRect(xOffset, yOffset, deviceCellWidth, deviceCellHeight);
}
function drawBoxDrawingChar(ctx, charDefinition, xOffset, yOffset, deviceCellWidth, deviceCellHeight, devicePixelRatio) {
  ctx.strokeStyle = ctx.fillStyle;
  for (const [fontWeight, instructions] of Object.entries(charDefinition)) {
    ctx.beginPath();
    ctx.lineWidth = devicePixelRatio * Number.parseInt(fontWeight);
    let actualInstructions;
    if (typeof instructions === "function") {
      const xp = 0.15;
      const yp = 0.15 / deviceCellHeight * deviceCellWidth;
      actualInstructions = instructions(xp, yp);
    } else {
      actualInstructions = instructions;
    }
    for (const instruction of actualInstructions.split(" ")) {
      const type = instruction[0];
      const f = svgToCanvasInstructionMap[type];
      if (!f) {
        console.error(`Could not find drawing instructions for "${type}"`);
        continue;
      }
      const args = instruction.substring(1).split(",");
      if (!args[0] || !args[1]) {
        continue;
      }
      f(ctx, translateArgs(args, deviceCellWidth, deviceCellHeight, xOffset, yOffset, true, devicePixelRatio));
    }
    ctx.stroke();
    ctx.closePath();
  }
}
function drawPowerlineChar(ctx, charDefinition, xOffset, yOffset, deviceCellWidth, deviceCellHeight, fontSize, devicePixelRatio) {
  const clipRegion = new Path2D();
  clipRegion.rect(xOffset, yOffset, deviceCellWidth, deviceCellHeight);
  ctx.clip(clipRegion);
  ctx.beginPath();
  const cssLineWidth = fontSize / 12;
  ctx.lineWidth = devicePixelRatio * cssLineWidth;
  for (const instruction of charDefinition.d.split(" ")) {
    const type = instruction[0];
    const f = svgToCanvasInstructionMap[type];
    if (!f) {
      console.error(`Could not find drawing instructions for "${type}"`);
      continue;
    }
    const args = instruction.substring(1).split(",");
    if (!args[0] || !args[1]) {
      continue;
    }
    f(ctx, translateArgs(
      args,
      deviceCellWidth,
      deviceCellHeight,
      xOffset,
      yOffset,
      false,
      devicePixelRatio,
      (charDefinition.leftPadding ?? 0) * (cssLineWidth / 2),
      (charDefinition.rightPadding ?? 0) * (cssLineWidth / 2)
    ));
  }
  if (charDefinition.type === 1 /* STROKE */) {
    ctx.strokeStyle = ctx.fillStyle;
    ctx.stroke();
  } else {
    ctx.fill();
  }
  ctx.closePath();
}
function clamp(value, max, min = 0) {
  return Math.max(Math.min(value, max), min);
}
var svgToCanvasInstructionMap = {
  "C": (ctx, args) => ctx.bezierCurveTo(args[0], args[1], args[2], args[3], args[4], args[5]),
  "L": (ctx, args) => ctx.lineTo(args[0], args[1]),
  "M": (ctx, args) => ctx.moveTo(args[0], args[1])
};
function translateArgs(args, cellWidth, cellHeight, xOffset, yOffset, doClamp, devicePixelRatio, leftPadding = 0, rightPadding = 0) {
  const result = args.map((e) => parseFloat(e) || parseInt(e));
  if (result.length < 2) {
    throw new Error("Too few arguments for instruction");
  }
  for (let x = 0; x < result.length; x += 2) {
    result[x] *= cellWidth - leftPadding * devicePixelRatio - rightPadding * devicePixelRatio;
    if (doClamp && result[x] !== 0) {
      result[x] = clamp(Math.round(result[x] + 0.5) - 0.5, cellWidth, 0);
    }
    result[x] += xOffset + leftPadding * devicePixelRatio;
  }
  for (let y = 1; y < result.length; y += 2) {
    result[y] *= cellHeight;
    if (doClamp && result[y] !== 0) {
      result[y] = clamp(Math.round(result[y] + 0.5) - 0.5, cellHeight, 0);
    }
    result[y] += yOffset;
  }
  return result;
}

// ../../packages/oxtty/xterm/vendor-xterm/src/common/MultiKeyMap.ts
var TwoKeyMap = class {
  constructor() {
    this._data = {};
  }
  set(first, second, value) {
    if (!this._data[first]) {
      this._data[first] = {};
    }
    this._data[first][second] = value;
  }
  get(first, second) {
    return this._data[first] ? this._data[first][second] : void 0;
  }
  clear() {
    this._data = {};
  }
};
var FourKeyMap = class {
  constructor() {
    this._data = new TwoKeyMap();
  }
  set(first, second, third, fourth, value) {
    if (!this._data.get(first, second)) {
      this._data.set(first, second, new TwoKeyMap());
    }
    this._data.get(first, second).set(third, fourth, value);
  }
  get(first, second, third, fourth) {
    return this._data.get(first, second)?.get(third, fourth);
  }
  clear() {
    this._data.clear();
  }
};

// ../../packages/oxtty/xterm/vendor-xterm/src/common/TaskQueue.ts
var TaskQueue = class {
  constructor() {
    this._tasks = [];
    this._i = 0;
  }
  enqueue(task) {
    this._tasks.push(task);
    this._start();
  }
  flush() {
    while (this._i < this._tasks.length) {
      if (!this._tasks[this._i]()) {
        this._i++;
      }
    }
    this.clear();
  }
  clear() {
    if (this._idleCallback) {
      this._cancelCallback(this._idleCallback);
      this._idleCallback = void 0;
    }
    this._i = 0;
    this._tasks.length = 0;
  }
  _start() {
    if (!this._idleCallback) {
      this._idleCallback = this._requestCallback(this._process.bind(this));
    }
  }
  _process(deadline) {
    this._idleCallback = void 0;
    let taskDuration = 0;
    let longestTask = 0;
    let lastDeadlineRemaining = deadline.timeRemaining();
    let deadlineRemaining = 0;
    while (this._i < this._tasks.length) {
      taskDuration = performance.now();
      if (!this._tasks[this._i]()) {
        this._i++;
      }
      taskDuration = Math.max(1, performance.now() - taskDuration);
      longestTask = Math.max(taskDuration, longestTask);
      deadlineRemaining = deadline.timeRemaining();
      if (longestTask * 1.5 > deadlineRemaining) {
        if (lastDeadlineRemaining - taskDuration < -20) {
          console.warn(`task queue exceeded allotted deadline by ${Math.abs(Math.round(lastDeadlineRemaining - taskDuration))}ms`);
        }
        this._start();
        return;
      }
      lastDeadlineRemaining = deadlineRemaining;
    }
    this.clear();
  }
};
var PriorityTaskQueue = class extends TaskQueue {
  _requestCallback(callback) {
    return setTimeout(() => callback(this._createDeadline(16)));
  }
  _cancelCallback(identifier) {
    clearTimeout(identifier);
  }
  _createDeadline(duration) {
    const end = performance.now() + duration;
    return {
      timeRemaining: () => Math.max(0, end - performance.now())
    };
  }
};
var IdleTaskQueueInternal = class extends TaskQueue {
  _requestCallback(callback) {
    return requestIdleCallback(callback);
  }
  _cancelCallback(identifier) {
    cancelIdleCallback(identifier);
  }
};
var IdleTaskQueue = !isNode && "requestIdleCallback" in window ? IdleTaskQueueInternal : PriorityTaskQueue;

// ../../packages/oxtty/xterm/vendor-xterm/src/common/buffer/AttributeData.ts
var AttributeData = class _AttributeData {
  constructor() {
    // data
    this.fg = 0;
    this.bg = 0;
    this.extended = new ExtendedAttrs();
  }
  static toColorRGB(value) {
    return [
      value >>> 16 /* RED_SHIFT */ & 255,
      value >>> 8 /* GREEN_SHIFT */ & 255,
      value & 255
    ];
  }
  static fromColorRGB(value) {
    return (value[0] & 255) << 16 /* RED_SHIFT */ | (value[1] & 255) << 8 /* GREEN_SHIFT */ | value[2] & 255;
  }
  clone() {
    const newObj = new _AttributeData();
    newObj.fg = this.fg;
    newObj.bg = this.bg;
    newObj.extended = this.extended.clone();
    return newObj;
  }
  // flags
  isInverse() {
    return this.fg & 67108864 /* INVERSE */;
  }
  isBold() {
    return this.fg & 134217728 /* BOLD */;
  }
  isUnderline() {
    if (this.hasExtendedAttrs() && this.extended.underlineStyle !== 0 /* NONE */) {
      return 1;
    }
    return this.fg & 268435456 /* UNDERLINE */;
  }
  isBlink() {
    return this.fg & 536870912 /* BLINK */;
  }
  isInvisible() {
    return this.fg & 1073741824 /* INVISIBLE */;
  }
  isItalic() {
    return this.bg & 67108864 /* ITALIC */;
  }
  isDim() {
    return this.bg & 134217728 /* DIM */;
  }
  isStrikethrough() {
    return this.fg & 2147483648 /* STRIKETHROUGH */;
  }
  isProtected() {
    return this.bg & 536870912 /* PROTECTED */;
  }
  isOverline() {
    return this.bg & 1073741824 /* OVERLINE */;
  }
  // color modes
  getFgColorMode() {
    return this.fg & 50331648 /* CM_MASK */;
  }
  getBgColorMode() {
    return this.bg & 50331648 /* CM_MASK */;
  }
  isFgRGB() {
    return (this.fg & 50331648 /* CM_MASK */) === 50331648 /* CM_RGB */;
  }
  isBgRGB() {
    return (this.bg & 50331648 /* CM_MASK */) === 50331648 /* CM_RGB */;
  }
  isFgPalette() {
    return (this.fg & 50331648 /* CM_MASK */) === 16777216 /* CM_P16 */ || (this.fg & 50331648 /* CM_MASK */) === 33554432 /* CM_P256 */;
  }
  isBgPalette() {
    return (this.bg & 50331648 /* CM_MASK */) === 16777216 /* CM_P16 */ || (this.bg & 50331648 /* CM_MASK */) === 33554432 /* CM_P256 */;
  }
  isFgDefault() {
    return (this.fg & 50331648 /* CM_MASK */) === 0;
  }
  isBgDefault() {
    return (this.bg & 50331648 /* CM_MASK */) === 0;
  }
  isAttributeDefault() {
    return this.fg === 0 && this.bg === 0;
  }
  // colors
  getFgColor() {
    switch (this.fg & 50331648 /* CM_MASK */) {
      case 16777216 /* CM_P16 */:
      case 33554432 /* CM_P256 */:
        return this.fg & 255 /* PCOLOR_MASK */;
      case 50331648 /* CM_RGB */:
        return this.fg & 16777215 /* RGB_MASK */;
      default:
        return -1;
    }
  }
  getBgColor() {
    switch (this.bg & 50331648 /* CM_MASK */) {
      case 16777216 /* CM_P16 */:
      case 33554432 /* CM_P256 */:
        return this.bg & 255 /* PCOLOR_MASK */;
      case 50331648 /* CM_RGB */:
        return this.bg & 16777215 /* RGB_MASK */;
      default:
        return -1;
    }
  }
  // extended attrs
  hasExtendedAttrs() {
    return this.bg & 268435456 /* HAS_EXTENDED */;
  }
  updateExtended() {
    if (this.extended.isEmpty()) {
      this.bg &= ~268435456 /* HAS_EXTENDED */;
    } else {
      this.bg |= 268435456 /* HAS_EXTENDED */;
    }
  }
  getUnderlineColor() {
    if (this.bg & 268435456 /* HAS_EXTENDED */ && ~this.extended.underlineColor) {
      switch (this.extended.underlineColor & 50331648 /* CM_MASK */) {
        case 16777216 /* CM_P16 */:
        case 33554432 /* CM_P256 */:
          return this.extended.underlineColor & 255 /* PCOLOR_MASK */;
        case 50331648 /* CM_RGB */:
          return this.extended.underlineColor & 16777215 /* RGB_MASK */;
        default:
          return this.getFgColor();
      }
    }
    return this.getFgColor();
  }
  getUnderlineColorMode() {
    return this.bg & 268435456 /* HAS_EXTENDED */ && ~this.extended.underlineColor ? this.extended.underlineColor & 50331648 /* CM_MASK */ : this.getFgColorMode();
  }
  isUnderlineColorRGB() {
    return this.bg & 268435456 /* HAS_EXTENDED */ && ~this.extended.underlineColor ? (this.extended.underlineColor & 50331648 /* CM_MASK */) === 50331648 /* CM_RGB */ : this.isFgRGB();
  }
  isUnderlineColorPalette() {
    return this.bg & 268435456 /* HAS_EXTENDED */ && ~this.extended.underlineColor ? (this.extended.underlineColor & 50331648 /* CM_MASK */) === 16777216 /* CM_P16 */ || (this.extended.underlineColor & 50331648 /* CM_MASK */) === 33554432 /* CM_P256 */ : this.isFgPalette();
  }
  isUnderlineColorDefault() {
    return this.bg & 268435456 /* HAS_EXTENDED */ && ~this.extended.underlineColor ? (this.extended.underlineColor & 50331648 /* CM_MASK */) === 0 : this.isFgDefault();
  }
  getUnderlineStyle() {
    return this.fg & 268435456 /* UNDERLINE */ ? this.bg & 268435456 /* HAS_EXTENDED */ ? this.extended.underlineStyle : 1 /* SINGLE */ : 0 /* NONE */;
  }
  getUnderlineVariantOffset() {
    return this.extended.underlineVariantOffset;
  }
};
var ExtendedAttrs = class _ExtendedAttrs {
  constructor(ext = 0, urlId = 0) {
    this._ext = 0;
    this._urlId = 0;
    this._ext = ext;
    this._urlId = urlId;
  }
  get ext() {
    if (this._urlId) {
      return this._ext & ~469762048 /* UNDERLINE_STYLE */ | this.underlineStyle << 26;
    }
    return this._ext;
  }
  set ext(value) {
    this._ext = value;
  }
  get underlineStyle() {
    if (this._urlId) {
      return 5 /* DASHED */;
    }
    return (this._ext & 469762048 /* UNDERLINE_STYLE */) >> 26;
  }
  set underlineStyle(value) {
    this._ext &= ~469762048 /* UNDERLINE_STYLE */;
    this._ext |= value << 26 & 469762048 /* UNDERLINE_STYLE */;
  }
  get underlineColor() {
    return this._ext & (50331648 /* CM_MASK */ | 16777215 /* RGB_MASK */);
  }
  set underlineColor(value) {
    this._ext &= ~(50331648 /* CM_MASK */ | 16777215 /* RGB_MASK */);
    this._ext |= value & (50331648 /* CM_MASK */ | 16777215 /* RGB_MASK */);
  }
  get urlId() {
    return this._urlId;
  }
  set urlId(value) {
    this._urlId = value;
  }
  get underlineVariantOffset() {
    const val = (this._ext & 3758096384 /* VARIANT_OFFSET */) >> 29;
    if (val < 0) {
      return val ^ 4294967288;
    }
    return val;
  }
  set underlineVariantOffset(value) {
    this._ext &= ~3758096384 /* VARIANT_OFFSET */;
    this._ext |= value << 29 & 3758096384 /* VARIANT_OFFSET */;
  }
  clone() {
    return new _ExtendedAttrs(this._ext, this._urlId);
  }
  /**
   * Convenient method to indicate whether the object holds no additional information,
   * that needs to be persistant in the buffer.
   */
  isEmpty() {
    return this.underlineStyle === 0 /* NONE */ && this._urlId === 0;
  }
};

// ../../packages/oxtty/xterm/stubs/vs/base/common/event.ts
var Emitter = class {
  constructor() {
    this._listeners = /* @__PURE__ */ new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return { dispose: () => this._listeners.delete(listener) };
    };
  }
  fire(e) {
    for (const l of this._listeners) l(e);
  }
  dispose() {
    this._listeners.clear();
  }
};

// ../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/TextureAtlas.ts
var NULL_RASTERIZED_GLYPH = {
  texturePage: 0,
  texturePosition: { x: 0, y: 0 },
  texturePositionClipSpace: { x: 0, y: 0 },
  offset: { x: 0, y: 0 },
  size: { x: 0, y: 0 },
  sizeClipSpace: { x: 0, y: 0 }
};
var TMP_CANVAS_GLYPH_PADDING = 2;
var $glyph = void 0;
var TextureAtlas = class _TextureAtlas {
  constructor(_document, _config, _unicodeService) {
    this._document = _document;
    this._config = _config;
    this._unicodeService = _unicodeService;
    this._didWarmUp = false;
    this._cacheMap = new FourKeyMap();
    this._cacheMapCombined = new FourKeyMap();
    // The texture that the atlas is drawn to
    this._pages = [];
    // The set of atlas pages that can be written to
    this._activePages = [];
    this._workBoundingBox = { top: 0, left: 0, bottom: 0, right: 0 };
    this._workAttributeData = new AttributeData();
    this._textureSize = 512;
    this._onAddTextureAtlasCanvas = new Emitter();
    this.onAddTextureAtlasCanvas = this._onAddTextureAtlasCanvas.event;
    this._onRemoveTextureAtlasCanvas = new Emitter();
    this.onRemoveTextureAtlasCanvas = this._onRemoveTextureAtlasCanvas.event;
    this._requestClearModel = false;
    this._createNewPage();
    this._tmpCanvas = createCanvas(
      _document,
      this._config.deviceCellWidth * 4 + TMP_CANVAS_GLYPH_PADDING * 2,
      this._config.deviceCellHeight + TMP_CANVAS_GLYPH_PADDING * 2
    );
    this._tmpCtx = throwIfFalsy(this._tmpCanvas.getContext("2d", {
      alpha: this._config.allowTransparency,
      willReadFrequently: true
    }));
  }
  get pages() {
    return this._pages;
  }
  dispose() {
    this._tmpCanvas.remove();
    for (const page of this.pages) {
      page.canvas.remove();
    }
    this._onAddTextureAtlasCanvas.dispose();
  }
  warmUp() {
    if (!this._didWarmUp) {
      this._doWarmUp();
      this._didWarmUp = true;
    }
  }
  _doWarmUp() {
    const queue = new IdleTaskQueue();
    for (let i = 33; i < 126; i++) {
      queue.enqueue(() => {
        if (!this._cacheMap.get(i, DEFAULT_COLOR, DEFAULT_COLOR, DEFAULT_EXT)) {
          const rasterizedGlyph = this._drawToCache(i, DEFAULT_COLOR, DEFAULT_COLOR, DEFAULT_EXT, false, void 0);
          this._cacheMap.set(i, DEFAULT_COLOR, DEFAULT_COLOR, DEFAULT_EXT, rasterizedGlyph);
        }
      });
    }
  }
  beginFrame() {
    return this._requestClearModel;
  }
  clearTexture() {
    if (this._pages[0].currentRow.x === 0 && this._pages[0].currentRow.y === 0) {
      return;
    }
    for (const page of this._pages) {
      page.clear();
    }
    this._cacheMap.clear();
    this._cacheMapCombined.clear();
    this._didWarmUp = false;
  }
  _createNewPage() {
    if (_TextureAtlas.maxAtlasPages && this._pages.length >= Math.max(4, _TextureAtlas.maxAtlasPages)) {
      const pagesBySize = this._pages.filter((e) => {
        return e.canvas.width * 2 <= (_TextureAtlas.maxTextureSize || 4096 /* FORCED_MAX_TEXTURE_SIZE */);
      }).sort((a, b) => {
        if (b.canvas.width !== a.canvas.width) {
          return b.canvas.width - a.canvas.width;
        }
        return b.percentageUsed - a.percentageUsed;
      });
      let sameSizeI = -1;
      let size = 0;
      for (let i = 0; i < pagesBySize.length; i++) {
        if (pagesBySize[i].canvas.width !== size) {
          sameSizeI = i;
          size = pagesBySize[i].canvas.width;
        } else if (i - sameSizeI === 3) {
          break;
        }
      }
      const mergingPages = pagesBySize.slice(sameSizeI, sameSizeI + 4);
      const sortedMergingPagesIndexes = mergingPages.map((e) => e.glyphs[0].texturePage).sort((a, b) => a > b ? 1 : -1);
      const mergedPageIndex = this.pages.length - mergingPages.length;
      const mergedPage = this._mergePages(mergingPages, mergedPageIndex);
      mergedPage.version++;
      for (let i = sortedMergingPagesIndexes.length - 1; i >= 0; i--) {
        this._deletePage(sortedMergingPagesIndexes[i]);
      }
      this.pages.push(mergedPage);
      this._requestClearModel = true;
      this._onAddTextureAtlasCanvas.fire(mergedPage.canvas);
    }
    const newPage = new AtlasPage(this._document, this._textureSize);
    this._pages.push(newPage);
    this._activePages.push(newPage);
    this._onAddTextureAtlasCanvas.fire(newPage.canvas);
    return newPage;
  }
  _mergePages(mergingPages, mergedPageIndex) {
    const mergedSize = mergingPages[0].canvas.width * 2;
    const mergedPage = new AtlasPage(this._document, mergedSize, mergingPages);
    for (const [i, p] of mergingPages.entries()) {
      const xOffset = i * p.canvas.width % mergedSize;
      const yOffset = Math.floor(i / 2) * p.canvas.height;
      mergedPage.ctx.drawImage(p.canvas, xOffset, yOffset);
      for (const g of p.glyphs) {
        g.texturePage = mergedPageIndex;
        g.sizeClipSpace.x = g.size.x / mergedSize;
        g.sizeClipSpace.y = g.size.y / mergedSize;
        g.texturePosition.x += xOffset;
        g.texturePosition.y += yOffset;
        g.texturePositionClipSpace.x = g.texturePosition.x / mergedSize;
        g.texturePositionClipSpace.y = g.texturePosition.y / mergedSize;
      }
      this._onRemoveTextureAtlasCanvas.fire(p.canvas);
      const index = this._activePages.indexOf(p);
      if (index !== -1) {
        this._activePages.splice(index, 1);
      }
    }
    return mergedPage;
  }
  _deletePage(pageIndex) {
    this._pages.splice(pageIndex, 1);
    for (let j = pageIndex; j < this._pages.length; j++) {
      const adjustingPage = this._pages[j];
      for (const g of adjustingPage.glyphs) {
        g.texturePage--;
      }
      adjustingPage.version++;
    }
  }
  getRasterizedGlyphCombinedChar(chars, bg, fg, ext, restrictToCellHeight, domContainer) {
    return this._getFromCacheMap(this._cacheMapCombined, chars, bg, fg, ext, restrictToCellHeight, domContainer);
  }
  getRasterizedGlyph(code, bg, fg, ext, restrictToCellHeight, domContainer) {
    return this._getFromCacheMap(this._cacheMap, code, bg, fg, ext, restrictToCellHeight, domContainer);
  }
  /**
   * Gets the glyphs texture coords, drawing the texture if it's not already
   */
  _getFromCacheMap(cacheMap, key, bg, fg, ext, restrictToCellHeight, domContainer) {
    $glyph = cacheMap.get(key, bg, fg, ext);
    if (!$glyph) {
      $glyph = this._drawToCache(key, bg, fg, ext, restrictToCellHeight, domContainer);
      cacheMap.set(key, bg, fg, ext, $glyph);
    }
    return $glyph;
  }
  _getColorFromAnsiIndex(idx) {
    if (idx >= this._config.colors.ansi.length) {
      throw new Error("No color found for idx " + idx);
    }
    return this._config.colors.ansi[idx];
  }
  _getBackgroundColor(bgColorMode, bgColor, inverse, dim) {
    if (this._config.allowTransparency) {
      return NULL_COLOR;
    }
    let result;
    switch (bgColorMode) {
      case 16777216 /* CM_P16 */:
      case 33554432 /* CM_P256 */:
        result = this._getColorFromAnsiIndex(bgColor);
        break;
      case 50331648 /* CM_RGB */:
        const arr = AttributeData.toColorRGB(bgColor);
        result = channels.toColor(arr[0], arr[1], arr[2]);
        break;
      case 0 /* CM_DEFAULT */:
      default:
        if (inverse) {
          result = color.opaque(this._config.colors.foreground);
        } else {
          result = this._config.colors.background;
        }
        break;
    }
    if (!this._config.allowTransparency) {
      result = color.opaque(result);
    }
    return result;
  }
  _getForegroundColor(bg, bgColorMode, bgColor, fg, fgColorMode, fgColor, inverse, dim, bold, excludeFromContrastRatioDemands) {
    const minimumContrastColor = this._getMinimumContrastColor(bg, bgColorMode, bgColor, fg, fgColorMode, fgColor, inverse, bold, dim, excludeFromContrastRatioDemands);
    if (minimumContrastColor) {
      return minimumContrastColor;
    }
    let result;
    switch (fgColorMode) {
      case 16777216 /* CM_P16 */:
      case 33554432 /* CM_P256 */:
        if (this._config.drawBoldTextInBrightColors && bold && fgColor < 8) {
          fgColor += 8;
        }
        result = this._getColorFromAnsiIndex(fgColor);
        break;
      case 50331648 /* CM_RGB */:
        const arr = AttributeData.toColorRGB(fgColor);
        result = channels.toColor(arr[0], arr[1], arr[2]);
        break;
      case 0 /* CM_DEFAULT */:
      default:
        if (inverse) {
          result = this._config.colors.background;
        } else {
          result = this._config.colors.foreground;
        }
    }
    if (this._config.allowTransparency) {
      result = color.opaque(result);
    }
    if (dim) {
      result = color.multiplyOpacity(result, DIM_OPACITY);
    }
    return result;
  }
  _resolveBackgroundRgba(bgColorMode, bgColor, inverse) {
    switch (bgColorMode) {
      case 16777216 /* CM_P16 */:
      case 33554432 /* CM_P256 */:
        return this._getColorFromAnsiIndex(bgColor).rgba;
      case 50331648 /* CM_RGB */:
        return bgColor << 8;
      case 0 /* CM_DEFAULT */:
      default:
        if (inverse) {
          return this._config.colors.foreground.rgba;
        }
        return this._config.colors.background.rgba;
    }
  }
  _resolveForegroundRgba(fgColorMode, fgColor, inverse, bold) {
    switch (fgColorMode) {
      case 16777216 /* CM_P16 */:
      case 33554432 /* CM_P256 */:
        if (this._config.drawBoldTextInBrightColors && bold && fgColor < 8) {
          fgColor += 8;
        }
        return this._getColorFromAnsiIndex(fgColor).rgba;
      case 50331648 /* CM_RGB */:
        return fgColor << 8;
      case 0 /* CM_DEFAULT */:
      default:
        if (inverse) {
          return this._config.colors.background.rgba;
        }
        return this._config.colors.foreground.rgba;
    }
  }
  _getMinimumContrastColor(bg, bgColorMode, bgColor, fg, fgColorMode, fgColor, inverse, bold, dim, excludeFromContrastRatioDemands) {
    if (this._config.minimumContrastRatio === 1 || excludeFromContrastRatioDemands) {
      return void 0;
    }
    const cache = this._getContrastCache(dim);
    const adjustedColor = cache.getColor(bg, fg);
    if (adjustedColor !== void 0) {
      return adjustedColor || void 0;
    }
    const bgRgba = this._resolveBackgroundRgba(bgColorMode, bgColor, inverse);
    const fgRgba = this._resolveForegroundRgba(fgColorMode, fgColor, inverse, bold);
    const result = rgba.ensureContrastRatio(bgRgba, fgRgba, this._config.minimumContrastRatio / (dim ? 2 : 1));
    if (!result) {
      cache.setColor(bg, fg, null);
      return void 0;
    }
    const color2 = channels.toColor(
      result >> 24 & 255,
      result >> 16 & 255,
      result >> 8 & 255
    );
    cache.setColor(bg, fg, color2);
    return color2;
  }
  _getContrastCache(dim) {
    if (dim) {
      return this._config.colors.halfContrastCache;
    }
    return this._config.colors.contrastCache;
  }
  _drawToCache(codeOrChars, bg, fg, ext, restrictToCellHeight, domContainer) {
    const chars = typeof codeOrChars === "number" ? String.fromCharCode(codeOrChars) : codeOrChars;
    if (domContainer && this._tmpCanvas.parentElement !== domContainer) {
      this._tmpCanvas.style.display = "none";
      domContainer.append(this._tmpCanvas);
    }
    const allowedWidth = Math.min(this._config.deviceCellWidth * Math.max(chars.length, 2) + TMP_CANVAS_GLYPH_PADDING * 2, this._config.deviceMaxTextureSize);
    if (this._tmpCanvas.width < allowedWidth) {
      this._tmpCanvas.width = allowedWidth;
    }
    const allowedHeight = Math.min(this._config.deviceCellHeight + TMP_CANVAS_GLYPH_PADDING * 4, this._textureSize);
    if (this._tmpCanvas.height < allowedHeight) {
      this._tmpCanvas.height = allowedHeight;
    }
    this._tmpCtx.save();
    this._workAttributeData.fg = fg;
    this._workAttributeData.bg = bg;
    this._workAttributeData.extended.ext = ext;
    const invisible = !!this._workAttributeData.isInvisible();
    if (invisible) {
      return NULL_RASTERIZED_GLYPH;
    }
    const bold = !!this._workAttributeData.isBold();
    const inverse = !!this._workAttributeData.isInverse();
    const dim = !!this._workAttributeData.isDim();
    const italic = !!this._workAttributeData.isItalic();
    const underline = !!this._workAttributeData.isUnderline();
    const strikethrough = !!this._workAttributeData.isStrikethrough();
    const overline = !!this._workAttributeData.isOverline();
    let fgColor = this._workAttributeData.getFgColor();
    let fgColorMode = this._workAttributeData.getFgColorMode();
    let bgColor = this._workAttributeData.getBgColor();
    let bgColorMode = this._workAttributeData.getBgColorMode();
    if (inverse) {
      const temp = fgColor;
      fgColor = bgColor;
      bgColor = temp;
      const temp2 = fgColorMode;
      fgColorMode = bgColorMode;
      bgColorMode = temp2;
    }
    const backgroundColor = this._getBackgroundColor(bgColorMode, bgColor, inverse, dim);
    this._tmpCtx.globalCompositeOperation = "copy";
    this._tmpCtx.fillStyle = backgroundColor.css;
    this._tmpCtx.fillRect(0, 0, this._tmpCanvas.width, this._tmpCanvas.height);
    this._tmpCtx.globalCompositeOperation = "source-over";
    const fontWeight = bold ? this._config.fontWeightBold : this._config.fontWeight;
    const fontStyle = italic ? "italic" : "";
    this._tmpCtx.font = `${fontStyle} ${fontWeight} ${this._config.fontSize * this._config.devicePixelRatio}px ${this._config.fontFamily}`;
    this._tmpCtx.textBaseline = TEXT_BASELINE;
    const powerlineGlyph = chars.length === 1 && isPowerlineGlyph(chars.charCodeAt(0));
    const restrictedPowerlineGlyph = chars.length === 1 && isRestrictedPowerlineGlyph(chars.charCodeAt(0));
    const foregroundColor = this._getForegroundColor(bg, bgColorMode, bgColor, fg, fgColorMode, fgColor, inverse, dim, bold, treatGlyphAsBackgroundColor(chars.charCodeAt(0)));
    this._tmpCtx.fillStyle = foregroundColor.css;
    const padding = restrictedPowerlineGlyph ? 0 : TMP_CANVAS_GLYPH_PADDING * 2;
    let customGlyph = false;
    if (this._config.customGlyphs !== false) {
      customGlyph = tryDrawCustomChar(this._tmpCtx, chars, padding, padding, this._config.deviceCellWidth, this._config.deviceCellHeight, this._config.fontSize, this._config.devicePixelRatio);
    }
    let enableClearThresholdCheck = !powerlineGlyph;
    let chWidth;
    if (typeof codeOrChars === "number") {
      chWidth = this._unicodeService.wcwidth(codeOrChars);
    } else {
      chWidth = this._unicodeService.getStringCellWidth(codeOrChars);
    }
    if (underline) {
      this._tmpCtx.save();
      const lineWidth = Math.max(1, Math.floor(this._config.fontSize * this._config.devicePixelRatio / 15));
      const yOffset = lineWidth % 2 === 1 ? 0.5 : 0;
      this._tmpCtx.lineWidth = lineWidth;
      if (this._workAttributeData.isUnderlineColorDefault()) {
        this._tmpCtx.strokeStyle = this._tmpCtx.fillStyle;
      } else if (this._workAttributeData.isUnderlineColorRGB()) {
        enableClearThresholdCheck = false;
        this._tmpCtx.strokeStyle = `rgb(${AttributeData.toColorRGB(this._workAttributeData.getUnderlineColor()).join(",")})`;
      } else {
        enableClearThresholdCheck = false;
        let fg2 = this._workAttributeData.getUnderlineColor();
        if (this._config.drawBoldTextInBrightColors && this._workAttributeData.isBold() && fg2 < 8) {
          fg2 += 8;
        }
        this._tmpCtx.strokeStyle = this._getColorFromAnsiIndex(fg2).css;
      }
      this._tmpCtx.beginPath();
      const xLeft = padding;
      const yTop = Math.ceil(padding + this._config.deviceCharHeight) - yOffset - (restrictToCellHeight ? lineWidth * 2 : 0);
      const yMid = yTop + lineWidth;
      const yBot = yTop + lineWidth * 2;
      let nextOffset = this._workAttributeData.getUnderlineVariantOffset();
      for (let i = 0; i < chWidth; i++) {
        this._tmpCtx.save();
        const xChLeft = xLeft + i * this._config.deviceCellWidth;
        const xChRight = xLeft + (i + 1) * this._config.deviceCellWidth;
        const xChMid = xChLeft + this._config.deviceCellWidth / 2;
        switch (this._workAttributeData.extended.underlineStyle) {
          case 2 /* DOUBLE */:
            this._tmpCtx.moveTo(xChLeft, yTop);
            this._tmpCtx.lineTo(xChRight, yTop);
            this._tmpCtx.moveTo(xChLeft, yBot);
            this._tmpCtx.lineTo(xChRight, yBot);
            break;
          case 3 /* CURLY */:
            const yCurlyBot = lineWidth <= 1 ? yBot : Math.ceil(padding + this._config.deviceCharHeight - lineWidth / 2) - yOffset;
            const yCurlyTop = lineWidth <= 1 ? yTop : Math.ceil(padding + this._config.deviceCharHeight + lineWidth / 2) - yOffset;
            const clipRegion = new Path2D();
            clipRegion.rect(xChLeft, yTop, this._config.deviceCellWidth, yBot - yTop);
            this._tmpCtx.clip(clipRegion);
            this._tmpCtx.moveTo(xChLeft - this._config.deviceCellWidth / 2, yMid);
            this._tmpCtx.bezierCurveTo(
              xChLeft - this._config.deviceCellWidth / 2,
              yCurlyTop,
              xChLeft,
              yCurlyTop,
              xChLeft,
              yMid
            );
            this._tmpCtx.bezierCurveTo(
              xChLeft,
              yCurlyBot,
              xChMid,
              yCurlyBot,
              xChMid,
              yMid
            );
            this._tmpCtx.bezierCurveTo(
              xChMid,
              yCurlyTop,
              xChRight,
              yCurlyTop,
              xChRight,
              yMid
            );
            this._tmpCtx.bezierCurveTo(
              xChRight,
              yCurlyBot,
              xChRight + this._config.deviceCellWidth / 2,
              yCurlyBot,
              xChRight + this._config.deviceCellWidth / 2,
              yMid
            );
            break;
          case 4 /* DOTTED */:
            const offsetWidth = nextOffset === 0 ? 0 : nextOffset >= lineWidth ? lineWidth * 2 - nextOffset : lineWidth - nextOffset;
            const isLineStart = nextOffset >= lineWidth ? false : true;
            if (isLineStart === false || offsetWidth === 0) {
              this._tmpCtx.setLineDash([Math.round(lineWidth), Math.round(lineWidth)]);
              this._tmpCtx.moveTo(xChLeft + offsetWidth, yTop);
              this._tmpCtx.lineTo(xChRight, yTop);
            } else {
              this._tmpCtx.setLineDash([Math.round(lineWidth), Math.round(lineWidth)]);
              this._tmpCtx.moveTo(xChLeft, yTop);
              this._tmpCtx.lineTo(xChLeft + offsetWidth, yTop);
              this._tmpCtx.moveTo(xChLeft + offsetWidth + lineWidth, yTop);
              this._tmpCtx.lineTo(xChRight, yTop);
            }
            nextOffset = computeNextVariantOffset(xChRight - xChLeft, lineWidth, nextOffset);
            break;
          case 5 /* DASHED */:
            const lineRatio = 0.6;
            const gapRatio = 0.3;
            const xChWidth = xChRight - xChLeft;
            const line = Math.floor(lineRatio * xChWidth);
            const gap = Math.floor(gapRatio * xChWidth);
            const end = xChWidth - line - gap;
            this._tmpCtx.setLineDash([line, gap, end]);
            this._tmpCtx.moveTo(xChLeft, yTop);
            this._tmpCtx.lineTo(xChRight, yTop);
            break;
          case 1 /* SINGLE */:
          default:
            this._tmpCtx.moveTo(xChLeft, yTop);
            this._tmpCtx.lineTo(xChRight, yTop);
            break;
        }
        this._tmpCtx.stroke();
        this._tmpCtx.restore();
      }
      this._tmpCtx.restore();
      if (!customGlyph && this._config.fontSize >= 12) {
        if (!this._config.allowTransparency && chars !== " ") {
          this._tmpCtx.save();
          this._tmpCtx.textBaseline = "alphabetic";
          const metrics = this._tmpCtx.measureText(chars);
          this._tmpCtx.restore();
          if ("actualBoundingBoxDescent" in metrics && metrics.actualBoundingBoxDescent > 0) {
            this._tmpCtx.save();
            const clipRegion = new Path2D();
            clipRegion.rect(xLeft, yTop - Math.ceil(lineWidth / 2), this._config.deviceCellWidth * chWidth, yBot - yTop + Math.ceil(lineWidth / 2));
            this._tmpCtx.clip(clipRegion);
            this._tmpCtx.lineWidth = this._config.devicePixelRatio * 3;
            this._tmpCtx.strokeStyle = backgroundColor.css;
            this._tmpCtx.strokeText(chars, padding, padding + this._config.deviceCharHeight);
            this._tmpCtx.restore();
          }
        }
      }
    }
    if (overline) {
      const lineWidth = Math.max(1, Math.floor(this._config.fontSize * this._config.devicePixelRatio / 15));
      const yOffset = lineWidth % 2 === 1 ? 0.5 : 0;
      this._tmpCtx.lineWidth = lineWidth;
      this._tmpCtx.strokeStyle = this._tmpCtx.fillStyle;
      this._tmpCtx.beginPath();
      this._tmpCtx.moveTo(padding, padding + yOffset);
      this._tmpCtx.lineTo(padding + this._config.deviceCharWidth * chWidth, padding + yOffset);
      this._tmpCtx.stroke();
    }
    if (!customGlyph) {
      this._tmpCtx.fillText(chars, padding, padding + this._config.deviceCharHeight);
    }
    if (chars === "_" && !this._config.allowTransparency) {
      let isBeyondCellBounds = clearColor(this._tmpCtx.getImageData(padding, padding, this._config.deviceCellWidth, this._config.deviceCellHeight), backgroundColor, foregroundColor, enableClearThresholdCheck);
      if (isBeyondCellBounds) {
        for (let offset = 1; offset <= 5; offset++) {
          this._tmpCtx.save();
          this._tmpCtx.fillStyle = backgroundColor.css;
          this._tmpCtx.fillRect(0, 0, this._tmpCanvas.width, this._tmpCanvas.height);
          this._tmpCtx.restore();
          this._tmpCtx.fillText(chars, padding, padding + this._config.deviceCharHeight - offset);
          isBeyondCellBounds = clearColor(this._tmpCtx.getImageData(padding, padding, this._config.deviceCellWidth, this._config.deviceCellHeight), backgroundColor, foregroundColor, enableClearThresholdCheck);
          if (!isBeyondCellBounds) {
            break;
          }
        }
      }
    }
    if (strikethrough) {
      const lineWidth = Math.max(1, Math.floor(this._config.fontSize * this._config.devicePixelRatio / 10));
      const yOffset = this._tmpCtx.lineWidth % 2 === 1 ? 0.5 : 0;
      this._tmpCtx.lineWidth = lineWidth;
      this._tmpCtx.strokeStyle = this._tmpCtx.fillStyle;
      this._tmpCtx.beginPath();
      this._tmpCtx.moveTo(padding, padding + Math.floor(this._config.deviceCharHeight / 2) - yOffset);
      this._tmpCtx.lineTo(padding + this._config.deviceCharWidth * chWidth, padding + Math.floor(this._config.deviceCharHeight / 2) - yOffset);
      this._tmpCtx.stroke();
    }
    this._tmpCtx.restore();
    const imageData = this._tmpCtx.getImageData(
      0,
      0,
      this._tmpCanvas.width,
      this._tmpCanvas.height
    );
    let isEmpty;
    if (!this._config.allowTransparency) {
      isEmpty = clearColor(imageData, backgroundColor, foregroundColor, enableClearThresholdCheck);
    } else {
      isEmpty = checkCompletelyTransparent(imageData);
    }
    if (isEmpty) {
      return NULL_RASTERIZED_GLYPH;
    }
    const rasterizedGlyph = this._findGlyphBoundingBox(imageData, this._workBoundingBox, allowedWidth, restrictedPowerlineGlyph, customGlyph, padding);
    let activePage;
    let activeRow;
    while (true) {
      if (this._activePages.length === 0) {
        const newPage = this._createNewPage();
        activePage = newPage;
        activeRow = newPage.currentRow;
        activeRow.height = rasterizedGlyph.size.y;
        break;
      }
      activePage = this._activePages[this._activePages.length - 1];
      activeRow = activePage.currentRow;
      for (const p of this._activePages) {
        if (rasterizedGlyph.size.y <= p.currentRow.height) {
          activePage = p;
          activeRow = p.currentRow;
        }
      }
      for (let i = this._activePages.length - 1; i >= 0; i--) {
        for (const row of this._activePages[i].fixedRows) {
          if (row.height <= activeRow.height && rasterizedGlyph.size.y <= row.height) {
            activePage = this._activePages[i];
            activeRow = row;
          }
        }
      }
      if (rasterizedGlyph.size.x > this._textureSize) {
        if (!this._overflowSizePage) {
          this._overflowSizePage = new AtlasPage(this._document, this._config.deviceMaxTextureSize);
          this.pages.push(this._overflowSizePage);
          this._requestClearModel = true;
          this._onAddTextureAtlasCanvas.fire(this._overflowSizePage.canvas);
        }
        activePage = this._overflowSizePage;
        activeRow = this._overflowSizePage.currentRow;
        if (activeRow.x + rasterizedGlyph.size.x >= activePage.canvas.width) {
          activeRow.x = 0;
          activeRow.y += activeRow.height;
          activeRow.height = 0;
        }
        break;
      }
      if (activeRow.y + rasterizedGlyph.size.y >= activePage.canvas.height || activeRow.height > rasterizedGlyph.size.y + 2 /* ROW_PIXEL_THRESHOLD */) {
        let wasPageAndRowFound = false;
        if (activePage.currentRow.y + activePage.currentRow.height + rasterizedGlyph.size.y >= activePage.canvas.height) {
          let candidatePage;
          for (const p of this._activePages) {
            if (p.currentRow.y + p.currentRow.height + rasterizedGlyph.size.y < p.canvas.height) {
              candidatePage = p;
              break;
            }
          }
          if (candidatePage) {
            activePage = candidatePage;
          } else {
            if (_TextureAtlas.maxAtlasPages && this._pages.length >= _TextureAtlas.maxAtlasPages && activeRow.y + rasterizedGlyph.size.y <= activePage.canvas.height && activeRow.height >= rasterizedGlyph.size.y && activeRow.x + rasterizedGlyph.size.x <= activePage.canvas.width) {
              wasPageAndRowFound = true;
            } else {
              const newPage = this._createNewPage();
              activePage = newPage;
              activeRow = newPage.currentRow;
              activeRow.height = rasterizedGlyph.size.y;
              wasPageAndRowFound = true;
            }
          }
        }
        if (!wasPageAndRowFound) {
          if (activePage.currentRow.height > 0) {
            activePage.fixedRows.push(activePage.currentRow);
          }
          activeRow = {
            x: 0,
            y: activePage.currentRow.y + activePage.currentRow.height,
            height: rasterizedGlyph.size.y
          };
          activePage.fixedRows.push(activeRow);
          activePage.currentRow = {
            x: 0,
            y: activeRow.y + activeRow.height,
            height: 0
          };
        }
      }
      if (activeRow.x + rasterizedGlyph.size.x <= activePage.canvas.width) {
        break;
      }
      if (activeRow === activePage.currentRow) {
        activeRow.x = 0;
        activeRow.y += activeRow.height;
        activeRow.height = 0;
      } else {
        activePage.fixedRows.splice(activePage.fixedRows.indexOf(activeRow), 1);
      }
    }
    rasterizedGlyph.texturePage = this._pages.indexOf(activePage);
    rasterizedGlyph.texturePosition.x = activeRow.x;
    rasterizedGlyph.texturePosition.y = activeRow.y;
    rasterizedGlyph.texturePositionClipSpace.x = activeRow.x / activePage.canvas.width;
    rasterizedGlyph.texturePositionClipSpace.y = activeRow.y / activePage.canvas.height;
    rasterizedGlyph.sizeClipSpace.x /= activePage.canvas.width;
    rasterizedGlyph.sizeClipSpace.y /= activePage.canvas.height;
    activeRow.height = Math.max(activeRow.height, rasterizedGlyph.size.y);
    activeRow.x += rasterizedGlyph.size.x;
    activePage.ctx.putImageData(
      imageData,
      rasterizedGlyph.texturePosition.x - this._workBoundingBox.left,
      rasterizedGlyph.texturePosition.y - this._workBoundingBox.top,
      this._workBoundingBox.left,
      this._workBoundingBox.top,
      rasterizedGlyph.size.x,
      rasterizedGlyph.size.y
    );
    activePage.addGlyph(rasterizedGlyph);
    activePage.version++;
    return rasterizedGlyph;
  }
  /**
   * Given an ImageData object, find the bounding box of the non-transparent
   * portion of the texture and return an IRasterizedGlyph with these
   * dimensions.
   * @param imageData The image data to read.
   * @param boundingBox An IBoundingBox to put the clipped bounding box values.
   */
  _findGlyphBoundingBox(imageData, boundingBox, allowedWidth, restrictedGlyph, customGlyph, padding) {
    boundingBox.top = 0;
    const height = restrictedGlyph ? this._config.deviceCellHeight : this._tmpCanvas.height;
    const width = restrictedGlyph ? this._config.deviceCellWidth : allowedWidth;
    let found = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alphaOffset = y * this._tmpCanvas.width * 4 + x * 4 + 3;
        if (imageData.data[alphaOffset] !== 0) {
          boundingBox.top = y;
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    boundingBox.left = 0;
    found = false;
    for (let x = 0; x < padding + width; x++) {
      for (let y = 0; y < height; y++) {
        const alphaOffset = y * this._tmpCanvas.width * 4 + x * 4 + 3;
        if (imageData.data[alphaOffset] !== 0) {
          boundingBox.left = x;
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    boundingBox.right = width;
    found = false;
    for (let x = padding + width - 1; x >= padding; x--) {
      for (let y = 0; y < height; y++) {
        const alphaOffset = y * this._tmpCanvas.width * 4 + x * 4 + 3;
        if (imageData.data[alphaOffset] !== 0) {
          boundingBox.right = x;
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    boundingBox.bottom = height;
    found = false;
    for (let y = height - 1; y >= 0; y--) {
      for (let x = 0; x < width; x++) {
        const alphaOffset = y * this._tmpCanvas.width * 4 + x * 4 + 3;
        if (imageData.data[alphaOffset] !== 0) {
          boundingBox.bottom = y;
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    return {
      texturePage: 0,
      texturePosition: { x: 0, y: 0 },
      texturePositionClipSpace: { x: 0, y: 0 },
      size: {
        x: boundingBox.right - boundingBox.left + 1,
        y: boundingBox.bottom - boundingBox.top + 1
      },
      sizeClipSpace: {
        x: boundingBox.right - boundingBox.left + 1,
        y: boundingBox.bottom - boundingBox.top + 1
      },
      offset: {
        x: -boundingBox.left + padding + (restrictedGlyph || customGlyph ? Math.floor((this._config.deviceCellWidth - this._config.deviceCharWidth) / 2) : 0),
        y: -boundingBox.top + padding + (restrictedGlyph || customGlyph ? this._config.lineHeight === 1 ? 0 : Math.round((this._config.deviceCellHeight - this._config.deviceCharHeight) / 2) : 0)
      }
    };
  }
};
var AtlasPage = class {
  constructor(document2, size, sourcePages) {
    this._usedPixels = 0;
    this._glyphs = [];
    /**
     * Used to check whether the canvas of the atlas page has changed.
     */
    this.version = 0;
    // Texture atlas current positioning data. The texture packing strategy used is to fill from
    // left-to-right and top-to-bottom. When the glyph being written is less than half of the current
    // row's height, the following happens:
    //
    // - The current row becomes the fixed height row A
    // - A new fixed height row B the exact size of the glyph is created below the current row
    // - A new dynamic height current row is created below B
    //
    // This strategy does a good job preventing space being wasted for very short glyphs such as
    // underscores, hyphens etc. or those with underlines rendered.
    this.currentRow = {
      x: 0,
      y: 0,
      height: 0
    };
    this.fixedRows = [];
    if (sourcePages) {
      for (const p of sourcePages) {
        this._glyphs.push(...p.glyphs);
        this._usedPixels += p._usedPixels;
      }
    }
    this.canvas = createCanvas(document2, size, size);
    this.ctx = throwIfFalsy(this.canvas.getContext("2d", { alpha: true }));
  }
  get percentageUsed() {
    return this._usedPixels / (this.canvas.width * this.canvas.height);
  }
  get glyphs() {
    return this._glyphs;
  }
  addGlyph(glyph) {
    this._glyphs.push(glyph);
    this._usedPixels += glyph.size.x * glyph.size.y;
  }
  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.currentRow.x = 0;
    this.currentRow.y = 0;
    this.currentRow.height = 0;
    this.fixedRows.length = 0;
    this.version++;
  }
};
function clearColor(imageData, bg, fg, enableThresholdCheck) {
  const r = bg.rgba >>> 24;
  const g = bg.rgba >>> 16 & 255;
  const b = bg.rgba >>> 8 & 255;
  const fgR = fg.rgba >>> 24;
  const fgG = fg.rgba >>> 16 & 255;
  const fgB = fg.rgba >>> 8 & 255;
  const threshold = Math.floor((Math.abs(r - fgR) + Math.abs(g - fgG) + Math.abs(b - fgB)) / 12);
  let isEmpty = true;
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    if (imageData.data[offset] === r && imageData.data[offset + 1] === g && imageData.data[offset + 2] === b) {
      imageData.data[offset + 3] = 0;
    } else {
      if (enableThresholdCheck && Math.abs(imageData.data[offset] - r) + Math.abs(imageData.data[offset + 1] - g) + Math.abs(imageData.data[offset + 2] - b) < threshold) {
        imageData.data[offset + 3] = 0;
      } else {
        isEmpty = false;
      }
    }
  }
  return isEmpty;
}
function checkCompletelyTransparent(imageData) {
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    if (imageData.data[offset + 3] > 0) {
      return false;
    }
  }
  return true;
}
function createCanvas(document2, width, height) {
  const canvas = document2.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// ../../packages/oxtty/xterm/stubs/vs/base/common/lifecycle.ts
function toDisposable(fn) {
  return { dispose: fn };
}
var Disposable = class {
  constructor() {
    this._store = [];
  }
  _register(d) {
    this._store.push(d);
    return d;
  }
  dispose() {
    for (const d of this._store.splice(0)) d.dispose();
  }
};

// ../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/WebglUtils.ts
var PROJECTION_MATRIX = new Float32Array([
  2,
  0,
  0,
  0,
  0,
  -2,
  0,
  0,
  0,
  0,
  1,
  0,
  -1,
  1,
  0,
  1
]);
function createProgram(gl, vertexSource, fragmentSource) {
  const program = throwIfFalsy(gl.createProgram());
  gl.attachShader(program, throwIfFalsy(createShader(gl, gl.VERTEX_SHADER, vertexSource)));
  gl.attachShader(program, throwIfFalsy(createShader(gl, gl.FRAGMENT_SHADER, fragmentSource)));
  gl.linkProgram(program);
  const success = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (success) {
    return program;
  }
  console.error(gl.getProgramInfoLog(program));
  gl.deleteProgram(program);
}
function createShader(gl, type, source) {
  const shader = throwIfFalsy(gl.createShader(type));
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (success) {
    return shader;
  }
  console.error(gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
}
function expandFloat32Array(source, max) {
  const newLength = Math.min(source.length * 2, max);
  const newArray = new Float32Array(newLength);
  for (let i = 0; i < source.length; i++) {
    newArray[i] = source[i];
  }
  return newArray;
}
var GLTexture = class {
  constructor(texture) {
    this.texture = texture;
    this.version = -1;
  }
};

// ../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/GlyphRenderer.ts
var vertexShaderSource = `#version 300 es
layout (location = ${0 /* UNIT_QUAD */}) in vec2 a_unitquad;
layout (location = ${1 /* CELL_POSITION */}) in vec2 a_cellpos;
layout (location = ${2 /* OFFSET */}) in vec2 a_offset;
layout (location = ${3 /* SIZE */}) in vec2 a_size;
layout (location = ${4 /* TEXPAGE */}) in float a_texpage;
layout (location = ${5 /* TEXCOORD */}) in vec2 a_texcoord;
layout (location = ${6 /* TEXSIZE */}) in vec2 a_texsize;

uniform mat4 u_projection;
uniform vec2 u_resolution;

out vec2 v_texcoord;
flat out int v_texpage;

void main() {
  vec2 zeroToOne = (a_offset / u_resolution) + a_cellpos + (a_unitquad * a_size);
  gl_Position = u_projection * vec4(zeroToOne, 0.0, 1.0);
  v_texpage = int(a_texpage);
  v_texcoord = a_texcoord + a_unitquad * a_texsize;
}`;
function createFragmentShaderSource(maxFragmentShaderTextureUnits) {
  let textureConditionals = "";
  for (let i = 1; i < maxFragmentShaderTextureUnits; i++) {
    textureConditionals += ` else if (v_texpage == ${i}) { outColor = texture(u_texture[${i}], v_texcoord); }`;
  }
  return `#version 300 es
precision lowp float;

in vec2 v_texcoord;
flat in int v_texpage;

uniform sampler2D u_texture[${maxFragmentShaderTextureUnits}];

out vec4 outColor;

void main() {
  if (v_texpage == 0) {
    outColor = texture(u_texture[0], v_texcoord);
  } ${textureConditionals}
}`;
}
var INDICES_PER_CELL = 11;
var BYTES_PER_CELL = INDICES_PER_CELL * Float32Array.BYTES_PER_ELEMENT;
var CELL_POSITION_INDICES = 2;
var $i = 0;
var $glyph2 = void 0;
var $leftCellPadding = 0;
var $clippedPixels = 0;
var GlyphRenderer = class extends Disposable {
  constructor(_terminal, _gl, _dimensions, _optionsService) {
    super();
    this._terminal = _terminal;
    this._gl = _gl;
    this._dimensions = _dimensions;
    this._optionsService = _optionsService;
    this._activeBuffer = 0;
    this._vertices = {
      count: 0,
      attributes: new Float32Array(0),
      attributesBuffers: [
        new Float32Array(0),
        new Float32Array(0)
      ]
    };
    const gl = this._gl;
    if (TextureAtlas.maxAtlasPages === void 0) {
      TextureAtlas.maxAtlasPages = Math.min(32, throwIfFalsy(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)));
      TextureAtlas.maxTextureSize = throwIfFalsy(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    }
    this._program = throwIfFalsy(createProgram(gl, vertexShaderSource, createFragmentShaderSource(TextureAtlas.maxAtlasPages)));
    this._register(toDisposable(() => gl.deleteProgram(this._program)));
    this._projectionLocation = throwIfFalsy(gl.getUniformLocation(this._program, "u_projection"));
    this._resolutionLocation = throwIfFalsy(gl.getUniformLocation(this._program, "u_resolution"));
    this._textureLocation = throwIfFalsy(gl.getUniformLocation(this._program, "u_texture"));
    this._vertexArrayObject = gl.createVertexArray();
    gl.bindVertexArray(this._vertexArrayObject);
    const unitQuadVertices = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const unitQuadVerticesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(unitQuadVerticesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuadVerticesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, unitQuadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0 /* UNIT_QUAD */);
    gl.vertexAttribPointer(0 /* UNIT_QUAD */, 2, this._gl.FLOAT, false, 0, 0);
    const unitQuadElementIndices = new Uint8Array([0, 1, 2, 3]);
    const elementIndicesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(elementIndicesBuffer)));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elementIndicesBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, unitQuadElementIndices, gl.STATIC_DRAW);
    this._attributesBuffer = throwIfFalsy(gl.createBuffer());
    this._register(toDisposable(() => gl.deleteBuffer(this._attributesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.enableVertexAttribArray(2 /* OFFSET */);
    gl.vertexAttribPointer(2 /* OFFSET */, 2, gl.FLOAT, false, BYTES_PER_CELL, 0);
    gl.vertexAttribDivisor(2 /* OFFSET */, 1);
    gl.enableVertexAttribArray(3 /* SIZE */);
    gl.vertexAttribPointer(3 /* SIZE */, 2, gl.FLOAT, false, BYTES_PER_CELL, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(3 /* SIZE */, 1);
    gl.enableVertexAttribArray(4 /* TEXPAGE */);
    gl.vertexAttribPointer(4 /* TEXPAGE */, 1, gl.FLOAT, false, BYTES_PER_CELL, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(4 /* TEXPAGE */, 1);
    gl.enableVertexAttribArray(5 /* TEXCOORD */);
    gl.vertexAttribPointer(5 /* TEXCOORD */, 2, gl.FLOAT, false, BYTES_PER_CELL, 5 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(5 /* TEXCOORD */, 1);
    gl.enableVertexAttribArray(6 /* TEXSIZE */);
    gl.vertexAttribPointer(6 /* TEXSIZE */, 2, gl.FLOAT, false, BYTES_PER_CELL, 7 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(6 /* TEXSIZE */, 1);
    gl.enableVertexAttribArray(1 /* CELL_POSITION */);
    gl.vertexAttribPointer(1 /* CELL_POSITION */, 2, gl.FLOAT, false, BYTES_PER_CELL, 9 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(1 /* CELL_POSITION */, 1);
    gl.useProgram(this._program);
    const textureUnits = new Int32Array(TextureAtlas.maxAtlasPages);
    for (let i = 0; i < TextureAtlas.maxAtlasPages; i++) {
      textureUnits[i] = i;
    }
    gl.uniform1iv(this._textureLocation, textureUnits);
    gl.uniformMatrix4fv(this._projectionLocation, false, PROJECTION_MATRIX);
    this._atlasTextures = [];
    for (let i = 0; i < TextureAtlas.maxAtlasPages; i++) {
      const glTexture = new GLTexture(throwIfFalsy(gl.createTexture()));
      this._register(toDisposable(() => gl.deleteTexture(glTexture.texture)));
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, glTexture.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 255]));
      this._atlasTextures[i] = glTexture;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.handleResize();
  }
  beginFrame() {
    return this._atlas ? this._atlas.beginFrame() : true;
  }
  updateCell(x, y, code, bg, fg, ext, chars, width, lastBg) {
    this._updateCell(this._vertices.attributes, x, y, code, bg, fg, ext, chars, width, lastBg);
  }
  _updateCell(array, x, y, code, bg, fg, ext, chars, width, lastBg) {
    $i = (y * this._terminal.cols + x) * INDICES_PER_CELL;
    if (code === NULL_CELL_CODE || code === void 0) {
      array.fill(0, $i, $i + INDICES_PER_CELL - 1 - CELL_POSITION_INDICES);
      return;
    }
    if (!this._atlas) {
      return;
    }
    if (chars && chars.length > 1) {
      $glyph2 = this._atlas.getRasterizedGlyphCombinedChar(chars, bg, fg, ext, false, this._terminal.element);
    } else {
      $glyph2 = this._atlas.getRasterizedGlyph(code, bg, fg, ext, false, this._terminal.element);
    }
    $leftCellPadding = Math.floor((this._dimensions.device.cell.width - this._dimensions.device.char.width) / 2);
    if (bg !== lastBg && $glyph2.offset.x > $leftCellPadding) {
      $clippedPixels = $glyph2.offset.x - $leftCellPadding;
      array[$i] = -($glyph2.offset.x - $clippedPixels) + this._dimensions.device.char.left;
      array[$i + 1] = -$glyph2.offset.y + this._dimensions.device.char.top;
      array[$i + 2] = ($glyph2.size.x - $clippedPixels) / this._dimensions.device.canvas.width;
      array[$i + 3] = $glyph2.size.y / this._dimensions.device.canvas.height;
      array[$i + 4] = $glyph2.texturePage;
      array[$i + 5] = $glyph2.texturePositionClipSpace.x + $clippedPixels / this._atlas.pages[$glyph2.texturePage].canvas.width;
      array[$i + 6] = $glyph2.texturePositionClipSpace.y;
      array[$i + 7] = $glyph2.sizeClipSpace.x - $clippedPixels / this._atlas.pages[$glyph2.texturePage].canvas.width;
      array[$i + 8] = $glyph2.sizeClipSpace.y;
    } else {
      array[$i] = -$glyph2.offset.x + this._dimensions.device.char.left;
      array[$i + 1] = -$glyph2.offset.y + this._dimensions.device.char.top;
      array[$i + 2] = $glyph2.size.x / this._dimensions.device.canvas.width;
      array[$i + 3] = $glyph2.size.y / this._dimensions.device.canvas.height;
      array[$i + 4] = $glyph2.texturePage;
      array[$i + 5] = $glyph2.texturePositionClipSpace.x;
      array[$i + 6] = $glyph2.texturePositionClipSpace.y;
      array[$i + 7] = $glyph2.sizeClipSpace.x;
      array[$i + 8] = $glyph2.sizeClipSpace.y;
    }
    if (this._optionsService.rawOptions.rescaleOverlappingGlyphs) {
      if (allowRescaling(code, width, $glyph2.size.x, this._dimensions.device.cell.width)) {
        array[$i + 2] = (this._dimensions.device.cell.width - 1) / this._dimensions.device.canvas.width;
      }
    }
  }
  clear() {
    const terminal = this._terminal;
    const newCount = terminal.cols * terminal.rows * INDICES_PER_CELL;
    if (this._vertices.count !== newCount) {
      this._vertices.attributes = new Float32Array(newCount);
    } else {
      this._vertices.attributes.fill(0);
    }
    let i = 0;
    for (; i < this._vertices.attributesBuffers.length; i++) {
      if (this._vertices.count !== newCount) {
        this._vertices.attributesBuffers[i] = new Float32Array(newCount);
      } else {
        this._vertices.attributesBuffers[i].fill(0);
      }
    }
    this._vertices.count = newCount;
    i = 0;
    for (let y = 0; y < terminal.rows; y++) {
      for (let x = 0; x < terminal.cols; x++) {
        this._vertices.attributes[i + 9] = x / terminal.cols;
        this._vertices.attributes[i + 10] = y / terminal.rows;
        i += INDICES_PER_CELL;
      }
    }
  }
  handleResize() {
    const gl = this._gl;
    gl.useProgram(this._program);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.uniform2f(this._resolutionLocation, gl.canvas.width, gl.canvas.height);
    this.clear();
  }
  render(renderModel) {
    if (!this._atlas) {
      return;
    }
    const gl = this._gl;
    gl.useProgram(this._program);
    gl.bindVertexArray(this._vertexArrayObject);
    this._activeBuffer = (this._activeBuffer + 1) % 2;
    const activeBuffer = this._vertices.attributesBuffers[this._activeBuffer];
    let bufferLength = 0;
    for (let y = 0; y < renderModel.lineLengths.length; y++) {
      const si = y * this._terminal.cols * INDICES_PER_CELL;
      const sub = this._vertices.attributes.subarray(si, si + renderModel.lineLengths[y] * INDICES_PER_CELL);
      activeBuffer.set(sub, bufferLength);
      bufferLength += sub.length;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, activeBuffer.subarray(0, bufferLength), gl.STREAM_DRAW);
    for (let i = 0; i < this._atlas.pages.length; i++) {
      if (this._atlas.pages[i].version !== this._atlasTextures[i].version) {
        this._bindAtlasPageTexture(gl, this._atlas, i);
      }
    }
    gl.drawElementsInstanced(gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_BYTE, 0, bufferLength / INDICES_PER_CELL);
  }
  setAtlas(atlas) {
    this._atlas = atlas;
    for (const glTexture of this._atlasTextures) {
      glTexture.version = -1;
    }
  }
  _bindAtlasPageTexture(gl, atlas, i) {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, this._atlasTextures[i].texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.pages[i].canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    this._atlasTextures[i].version = atlas.pages[i].version;
  }
  setDimensions(dimensions) {
    this._dimensions = dimensions;
  }
};

// ../../packages/oxtty/xterm/vendor-xterm/src/browser/renderer/shared/SelectionRenderModel.ts
var SelectionRenderModel = class {
  constructor() {
    this.clear();
  }
  clear() {
    this.hasSelection = false;
    this.columnSelectMode = false;
    this.viewportStartRow = 0;
    this.viewportEndRow = 0;
    this.viewportCappedStartRow = 0;
    this.viewportCappedEndRow = 0;
    this.startCol = 0;
    this.endCol = 0;
    this.selectionStart = void 0;
    this.selectionEnd = void 0;
  }
  update(terminal, start, end, columnSelectMode = false) {
    this.selectionStart = start;
    this.selectionEnd = end;
    if (!start || !end || start[0] === end[0] && start[1] === end[1]) {
      this.clear();
      return;
    }
    const viewportY = terminal.buffers.active.ydisp;
    const viewportStartRow = start[1] - viewportY;
    const viewportEndRow = end[1] - viewportY;
    const viewportCappedStartRow = Math.max(viewportStartRow, 0);
    const viewportCappedEndRow = Math.min(viewportEndRow, terminal.rows - 1);
    if (viewportCappedStartRow >= terminal.rows || viewportCappedEndRow < 0) {
      this.clear();
      return;
    }
    this.hasSelection = true;
    this.columnSelectMode = columnSelectMode;
    this.viewportStartRow = viewportStartRow;
    this.viewportEndRow = viewportEndRow;
    this.viewportCappedStartRow = viewportCappedStartRow;
    this.viewportCappedEndRow = viewportCappedEndRow;
    this.startCol = start[0];
    this.endCol = end[0];
  }
  isCellSelected(terminal, x, y) {
    if (!this.hasSelection) {
      return false;
    }
    y -= terminal.buffer.active.viewportY;
    if (this.columnSelectMode) {
      if (this.startCol <= this.endCol) {
        return x >= this.startCol && y >= this.viewportCappedStartRow && x < this.endCol && y <= this.viewportCappedEndRow;
      }
      return x < this.startCol && y >= this.viewportCappedStartRow && x >= this.endCol && y <= this.viewportCappedEndRow;
    }
    return y > this.viewportStartRow && y < this.viewportEndRow || this.viewportStartRow === this.viewportEndRow && y === this.viewportStartRow && x >= this.startCol && x < this.endCol || this.viewportStartRow < this.viewportEndRow && y === this.viewportEndRow && x < this.endCol || this.viewportStartRow < this.viewportEndRow && y === this.viewportStartRow && x >= this.startCol;
  }
};
function createSelectionRenderModel() {
  return new SelectionRenderModel();
}

// ../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/RenderModel.ts
var RENDER_MODEL_INDICIES_PER_CELL = 4;
var RENDER_MODEL_BG_OFFSET = 1;
var RENDER_MODEL_FG_OFFSET = 2;
var RENDER_MODEL_EXT_OFFSET = 3;
var COMBINED_CHAR_BIT_MASK = 2147483648;
var RenderModel = class {
  constructor() {
    this.cells = new Uint32Array(0);
    this.lineLengths = new Uint32Array(0);
    this.selection = createSelectionRenderModel();
  }
  resize(cols, rows) {
    const indexCount = cols * rows * RENDER_MODEL_INDICIES_PER_CELL;
    if (indexCount !== this.cells.length) {
      this.cells = new Uint32Array(indexCount);
      this.lineLengths = new Uint32Array(rows);
    }
  }
  clear() {
    this.cells.fill(0, 0);
    this.lineLengths.fill(0, 0);
  }
};

// ../../packages/oxtty/xterm/vendor-xterm/addons/addon-webgl/src/RectangleRenderer.ts
var vertexShaderSource2 = `#version 300 es
layout (location = ${0 /* POSITION */}) in vec2 a_position;
layout (location = ${1 /* SIZE */}) in vec2 a_size;
layout (location = ${2 /* COLOR */}) in vec4 a_color;
layout (location = ${3 /* UNIT_QUAD */}) in vec2 a_unitquad;

uniform mat4 u_projection;

out vec4 v_color;

void main() {
  vec2 zeroToOne = a_position + (a_unitquad * a_size);
  gl_Position = u_projection * vec4(zeroToOne, 0.0, 1.0);
  v_color = a_color;
}`;
var fragmentShaderSource = `#version 300 es
precision lowp float;

in vec4 v_color;

out vec4 outColor;

void main() {
  outColor = v_color;
}`;
var INDICES_PER_RECTANGLE = 8;
var BYTES_PER_RECTANGLE = INDICES_PER_RECTANGLE * Float32Array.BYTES_PER_ELEMENT;
var INITIAL_BUFFER_RECTANGLE_CAPACITY = 20 * INDICES_PER_RECTANGLE;
var Vertices = class {
  constructor() {
    this.attributes = new Float32Array(INITIAL_BUFFER_RECTANGLE_CAPACITY);
    this.count = 0;
  }
};
var $rgba = 0;
var $x1 = 0;
var $y1 = 0;
var $r2 = 0;
var $g2 = 0;
var $b2 = 0;
var $a2 = 0;
var RectangleRenderer = class extends Disposable {
  constructor(_terminal, _gl, _dimensions, _themeService) {
    super();
    this._terminal = _terminal;
    this._gl = _gl;
    this._dimensions = _dimensions;
    this._themeService = _themeService;
    this._vertices = new Vertices();
    this._verticesCursor = new Vertices();
    const gl = this._gl;
    this._program = throwIfFalsy(createProgram(gl, vertexShaderSource2, fragmentShaderSource));
    this._register(toDisposable(() => gl.deleteProgram(this._program)));
    this._projectionLocation = throwIfFalsy(gl.getUniformLocation(this._program, "u_projection"));
    this._vertexArrayObject = gl.createVertexArray();
    gl.bindVertexArray(this._vertexArrayObject);
    const unitQuadVertices = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const unitQuadVerticesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(unitQuadVerticesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuadVerticesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, unitQuadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3 /* UNIT_QUAD */);
    gl.vertexAttribPointer(3 /* UNIT_QUAD */, 2, this._gl.FLOAT, false, 0, 0);
    const unitQuadElementIndices = new Uint8Array([0, 1, 2, 3]);
    const elementIndicesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(elementIndicesBuffer)));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elementIndicesBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, unitQuadElementIndices, gl.STATIC_DRAW);
    this._attributesBuffer = throwIfFalsy(gl.createBuffer());
    this._register(toDisposable(() => gl.deleteBuffer(this._attributesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.enableVertexAttribArray(0 /* POSITION */);
    gl.vertexAttribPointer(0 /* POSITION */, 2, gl.FLOAT, false, BYTES_PER_RECTANGLE, 0);
    gl.vertexAttribDivisor(0 /* POSITION */, 1);
    gl.enableVertexAttribArray(1 /* SIZE */);
    gl.vertexAttribPointer(1 /* SIZE */, 2, gl.FLOAT, false, BYTES_PER_RECTANGLE, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(1 /* SIZE */, 1);
    gl.enableVertexAttribArray(2 /* COLOR */);
    gl.vertexAttribPointer(2 /* COLOR */, 4, gl.FLOAT, false, BYTES_PER_RECTANGLE, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(2 /* COLOR */, 1);
    this._updateCachedColors(_themeService.colors);
    this._register(this._themeService.onChangeColors((e) => {
      this._updateCachedColors(e);
      this._updateViewportRectangle();
    }));
  }
  renderBackgrounds() {
    this._renderVertices(this._vertices);
  }
  renderCursor() {
    this._renderVertices(this._verticesCursor);
  }
  _renderVertices(vertices) {
    const gl = this._gl;
    gl.useProgram(this._program);
    gl.bindVertexArray(this._vertexArrayObject);
    gl.uniformMatrix4fv(this._projectionLocation, false, PROJECTION_MATRIX);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices.attributes, gl.DYNAMIC_DRAW);
    gl.drawElementsInstanced(this._gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_BYTE, 0, vertices.count);
  }
  handleResize() {
    this._updateViewportRectangle();
  }
  setDimensions(dimensions) {
    this._dimensions = dimensions;
  }
  _updateCachedColors(colors) {
    this._bgFloat = this._colorToFloat32Array(colors.background);
    this._cursorFloat = this._colorToFloat32Array(colors.cursor);
  }
  _updateViewportRectangle() {
    this._addRectangleFloat(
      this._vertices.attributes,
      0,
      0,
      0,
      this._terminal.cols * this._dimensions.device.cell.width,
      this._terminal.rows * this._dimensions.device.cell.height,
      this._bgFloat
    );
  }
  updateBackgrounds(model) {
    const terminal = this._terminal;
    const vertices = this._vertices;
    let rectangleCount = 1;
    let y;
    let x;
    let currentStartX;
    let currentBg;
    let currentFg;
    let currentInverse;
    let modelIndex;
    let bg;
    let fg;
    let inverse;
    let offset;
    for (y = 0; y < terminal.rows; y++) {
      currentStartX = -1;
      currentBg = 0;
      currentFg = 0;
      currentInverse = false;
      for (x = 0; x < terminal.cols; x++) {
        modelIndex = (y * terminal.cols + x) * RENDER_MODEL_INDICIES_PER_CELL;
        bg = model.cells[modelIndex + RENDER_MODEL_BG_OFFSET];
        fg = model.cells[modelIndex + RENDER_MODEL_FG_OFFSET];
        inverse = !!(fg & 67108864 /* INVERSE */);
        if (bg !== currentBg || fg !== currentFg && (currentInverse || inverse)) {
          if (currentBg !== 0 || currentInverse && currentFg !== 0) {
            offset = rectangleCount++ * INDICES_PER_RECTANGLE;
            this._updateRectangle(vertices, offset, currentFg, currentBg, currentStartX, x, y);
          }
          currentStartX = x;
          currentBg = bg;
          currentFg = fg;
          currentInverse = inverse;
        }
      }
      if (currentBg !== 0 || currentInverse && currentFg !== 0) {
        offset = rectangleCount++ * INDICES_PER_RECTANGLE;
        this._updateRectangle(vertices, offset, currentFg, currentBg, currentStartX, terminal.cols, y);
      }
    }
    vertices.count = rectangleCount;
  }
  updateCursor(model) {
    const vertices = this._verticesCursor;
    const cursor = model.cursor;
    if (!cursor || cursor.style === "block") {
      vertices.count = 0;
      return;
    }
    let offset;
    let rectangleCount = 0;
    if (cursor.style === "bar" || cursor.style === "outline") {
      offset = rectangleCount++ * INDICES_PER_RECTANGLE;
      this._addRectangleFloat(
        vertices.attributes,
        offset,
        cursor.x * this._dimensions.device.cell.width,
        cursor.y * this._dimensions.device.cell.height,
        cursor.style === "bar" ? cursor.dpr * cursor.cursorWidth : cursor.dpr,
        this._dimensions.device.cell.height,
        this._cursorFloat
      );
    }
    if (cursor.style === "underline" || cursor.style === "outline") {
      offset = rectangleCount++ * INDICES_PER_RECTANGLE;
      this._addRectangleFloat(
        vertices.attributes,
        offset,
        cursor.x * this._dimensions.device.cell.width,
        (cursor.y + 1) * this._dimensions.device.cell.height - cursor.dpr,
        cursor.width * this._dimensions.device.cell.width,
        cursor.dpr,
        this._cursorFloat
      );
    }
    if (cursor.style === "outline") {
      offset = rectangleCount++ * INDICES_PER_RECTANGLE;
      this._addRectangleFloat(
        vertices.attributes,
        offset,
        cursor.x * this._dimensions.device.cell.width,
        cursor.y * this._dimensions.device.cell.height,
        cursor.width * this._dimensions.device.cell.width,
        cursor.dpr,
        this._cursorFloat
      );
      offset = rectangleCount++ * INDICES_PER_RECTANGLE;
      this._addRectangleFloat(
        vertices.attributes,
        offset,
        (cursor.x + cursor.width) * this._dimensions.device.cell.width - cursor.dpr,
        cursor.y * this._dimensions.device.cell.height,
        cursor.dpr,
        this._dimensions.device.cell.height,
        this._cursorFloat
      );
    }
    vertices.count = rectangleCount;
  }
  _updateRectangle(vertices, offset, fg, bg, startX, endX, y) {
    if (fg & 67108864 /* INVERSE */) {
      switch (fg & 50331648 /* CM_MASK */) {
        case 16777216 /* CM_P16 */:
        case 33554432 /* CM_P256 */:
          $rgba = this._themeService.colors.ansi[fg & 255 /* PCOLOR_MASK */].rgba;
          break;
        case 50331648 /* CM_RGB */:
          $rgba = (fg & 16777215 /* RGB_MASK */) << 8;
          break;
        case 0 /* CM_DEFAULT */:
        default:
          $rgba = this._themeService.colors.foreground.rgba;
      }
    } else {
      switch (bg & 50331648 /* CM_MASK */) {
        case 16777216 /* CM_P16 */:
        case 33554432 /* CM_P256 */:
          $rgba = this._themeService.colors.ansi[bg & 255 /* PCOLOR_MASK */].rgba;
          break;
        case 50331648 /* CM_RGB */:
          $rgba = (bg & 16777215 /* RGB_MASK */) << 8;
          break;
        case 0 /* CM_DEFAULT */:
        default:
          $rgba = this._themeService.colors.background.rgba;
      }
    }
    if (vertices.attributes.length < offset + 4) {
      vertices.attributes = expandFloat32Array(vertices.attributes, this._terminal.rows * this._terminal.cols * INDICES_PER_RECTANGLE);
    }
    $x1 = startX * this._dimensions.device.cell.width;
    $y1 = y * this._dimensions.device.cell.height;
    $r2 = ($rgba >> 24 & 255) / 255;
    $g2 = ($rgba >> 16 & 255) / 255;
    $b2 = ($rgba >> 8 & 255) / 255;
    $a2 = 1;
    this._addRectangle(vertices.attributes, offset, $x1, $y1, (endX - startX) * this._dimensions.device.cell.width, this._dimensions.device.cell.height, $r2, $g2, $b2, $a2);
  }
  _addRectangle(array, offset, x1, y1, width, height, r, g, b, a) {
    array[offset] = x1 / this._dimensions.device.canvas.width;
    array[offset + 1] = y1 / this._dimensions.device.canvas.height;
    array[offset + 2] = width / this._dimensions.device.canvas.width;
    array[offset + 3] = height / this._dimensions.device.canvas.height;
    array[offset + 4] = r;
    array[offset + 5] = g;
    array[offset + 6] = b;
    array[offset + 7] = a;
  }
  _addRectangleFloat(array, offset, x1, y1, width, height, color2) {
    array[offset] = x1 / this._dimensions.device.canvas.width;
    array[offset + 1] = y1 / this._dimensions.device.canvas.height;
    array[offset + 2] = width / this._dimensions.device.canvas.width;
    array[offset + 3] = height / this._dimensions.device.canvas.height;
    array[offset + 4] = color2[0];
    array[offset + 5] = color2[1];
    array[offset + 6] = color2[2];
    array[offset + 7] = color2[3];
  }
  _colorToFloat32Array(color2) {
    return new Float32Array([
      (color2.rgba >> 24 & 255) / 255,
      (color2.rgba >> 16 & 255) / 255,
      (color2.rgba >> 8 & 255) / 255,
      (color2.rgba & 255) / 255
    ]);
  }
};

// src/convert.ts
function toXtermColor(packed) {
  const value = packed & 16777215;
  switch (packed >>> 24) {
    case 3 /* RGB */:
      return 50331648 /* CM_RGB */ | value;
    case 2 /* INDEXED */:
      return (value < 16 ? 16777216 /* CM_P16 */ : 33554432 /* CM_P256 */) | value;
    default:
      if (value < 16) return 16777216 /* CM_P16 */ | value;
      if (value >= 259 && value <= 266) return 16777216 /* CM_P16 */ | value - 259;
      return 0 /* CM_DEFAULT */;
  }
}
function underlineStyle(attrs) {
  if (attrs & 32 /* CURLY_UNDERLINE */) return 3 /* CURLY */;
  if (attrs & 16 /* DOUBLE_UNDERLINE */) return 2 /* DOUBLE */;
  if (attrs & 64 /* DOTTED_UNDERLINE */) return 4 /* DOTTED */;
  if (attrs & 128 /* DASHED_UNDERLINE */) return 5 /* DASHED */;
  if (attrs & 8 /* UNDERLINE */) return 1 /* SINGLE */;
  return 0 /* NONE */;
}
var OxttyCellData = class extends AttributeData {
  constructor() {
    super(...arguments);
    this.content = 0;
    this.combinedData = "";
    this._code = 0;
    this._width = 1;
  }
  /**
   * @param chars for a COMBINING cell, the full string from the engine's rowExtras(); otherwise an empty string
   * @param underlineColor the underline color from rowExtras() (oxtty packing), or 0 if none
   */
  load(codepoint, oxFg, oxBg, attrs, chars, underlineColor = 0) {
    if (attrs & 8192 /* WIDE_SPACER */) {
      this._code = 0;
      this._width = 0;
      this.combinedData = "";
    } else {
      this._code = codepoint;
      this._width = attrs & 4096 /* WIDE */ ? 2 : 1;
      this.combinedData = chars;
    }
    let fg = toXtermColor(oxFg);
    let bg = toXtermColor(oxBg);
    if (attrs & 1 /* BOLD */) fg |= 134217728 /* BOLD */;
    if (attrs & 256 /* INVERSE */) fg |= 67108864 /* INVERSE */;
    if (attrs & 512 /* HIDDEN */) fg |= 1073741824 /* INVISIBLE */;
    if (attrs & 1024 /* STRIKEOUT */) fg |= 2147483648 /* STRIKETHROUGH */;
    if (attrs & 2048 /* BLINK */) fg |= 536870912 /* BLINK */;
    if (attrs & 2 /* DIM */) bg |= 134217728 /* DIM */;
    if (attrs & 4 /* ITALIC */) bg |= 67108864 /* ITALIC */;
    const style = underlineStyle(attrs);
    this.extended.ext = 0;
    if (style !== 0 /* NONE */) {
      fg |= 268435456 /* UNDERLINE */;
      if (style !== 1 /* SINGLE */) {
        bg |= 268435456 /* HAS_EXTENDED */;
        this.extended.underlineStyle = style;
      }
    }
    if (underlineColor) {
      bg |= 268435456 /* HAS_EXTENDED */;
      this.extended.underlineColor = toXtermColor(underlineColor);
    }
    this.fg = fg;
    this.bg = bg;
  }
  isCombined() {
    return this.combinedData.length > 1 ? 1 : 0;
  }
  getWidth() {
    return this._width;
  }
  getChars() {
    if (this.combinedData) return this.combinedData;
    return this._code ? String.fromCodePoint(this._code) : "";
  }
  getCode() {
    return this._code;
  }
  setFromCharData(_value) {
    throw new Error("not implemented");
  }
  getAsCharData() {
    return [this.fg, this.getChars(), this.getWidth(), this.getCode()];
  }
};

// ../../packages/oxtty/xterm/vendor-xterm/src/browser/Types.ts
var DEFAULT_ANSI_COLORS = Object.freeze((() => {
  const colors = [
    // dark:
    css.toColor("#2e3436"),
    css.toColor("#cc0000"),
    css.toColor("#4e9a06"),
    css.toColor("#c4a000"),
    css.toColor("#3465a4"),
    css.toColor("#75507b"),
    css.toColor("#06989a"),
    css.toColor("#d3d7cf"),
    // bright:
    css.toColor("#555753"),
    css.toColor("#ef2929"),
    css.toColor("#8ae234"),
    css.toColor("#fce94f"),
    css.toColor("#729fcf"),
    css.toColor("#ad7fa8"),
    css.toColor("#34e2e2"),
    css.toColor("#eeeeec")
  ];
  const v = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    const r = v[i / 36 % 6 | 0];
    const g = v[i / 6 % 6 | 0];
    const b = v[i % 6];
    colors.push({
      css: channels.toCss(r, g, b),
      rgba: channels.toRgba(r, g, b)
    });
  }
  for (let i = 0; i < 24; i++) {
    const c = 8 + i * 10;
    colors.push({
      css: channels.toCss(c, c, c),
      rgba: channels.toRgba(c, c, c)
    });
  }
  return colors;
})());

// ../../packages/oxtty/xterm/vendor-xterm/src/browser/ColorContrastCache.ts
var ColorContrastCache = class {
  constructor() {
    this._color = new TwoKeyMap();
    this._css = new TwoKeyMap();
  }
  setCss(bg, fg, value) {
    this._css.set(bg, fg, value);
  }
  getCss(bg, fg) {
    return this._css.get(bg, fg);
  }
  setColor(bg, fg, value) {
    this._color.set(bg, fg, value);
  }
  getColor(bg, fg) {
    return this._color.get(bg, fg);
  }
  clear() {
    this._color.clear();
    this._css.clear();
  }
};

// src/services.ts
var terminalOptions = {
  customGlyphs: true,
  letterSpacing: 0,
  lineHeight: 1,
  fontFamily: 'Menlo, "Apple SD Gothic Neo", monospace',
  fontSize: 14,
  fontWeight: "normal",
  fontWeightBold: "bold",
  allowTransparency: false,
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
  rescaleOverlappingGlyphs: false,
  theme: {}
};
var OptionsServiceStub = class {
  constructor() {
    this.rawOptions = terminalOptions;
  }
  // Options never change in the spike.
  onSpecificOptionChange() {
    return { dispose() {
    } };
  }
  onMultipleOptionChange() {
    return { dispose() {
    } };
  }
};
function createColorSet() {
  const foreground = css.toColor("#d4d4d4");
  const background = css.toColor("#1e1e1e");
  const selection = css.toColor("#ffffff4d");
  return {
    foreground,
    background,
    cursor: css.toColor("#ffcc00"),
    cursorAccent: background,
    selectionForeground: void 0,
    selectionBackgroundTransparent: selection,
    selectionBackgroundOpaque: color.blend(background, selection),
    selectionInactiveBackgroundTransparent: selection,
    selectionInactiveBackgroundOpaque: color.blend(background, selection),
    scrollbarSliderBackground: selection,
    scrollbarSliderHoverBackground: selection,
    scrollbarSliderActiveBackground: selection,
    overviewRulerBorder: foreground,
    ansi: DEFAULT_ANSI_COLORS.slice(),
    contrastCache: new ColorContrastCache(),
    halfContrastCache: new ColorContrastCache()
  };
}
var ThemeServiceStub = class {
  constructor(colors) {
    this.colors = colors;
    this._onChangeColors = new Emitter();
    this.onChangeColors = this._onChangeColors.event;
  }
};
var UnicodeServiceStub = class {
  constructor() {
    this._wide = /* @__PURE__ */ new Set();
  }
  recordWide(codepoint) {
    this._wide.add(codepoint);
  }
  wcwidth(codepoint) {
    return this._wide.has(codepoint) ? 2 : 1;
  }
  getStringCellWidth(s) {
    return this.wcwidth(s.codePointAt(0) ?? 0);
  }
};
var DecorationServiceStub = class {
  forEachDecorationAtCell() {
  }
};
var CoreBrowserServiceStub = class {
  constructor(dpr) {
    this.dpr = dpr;
    this.isFocused = true;
    this.window = window;
  }
};

// src/OxttyWebglRenderer.ts
var atlasCache = [];
function sharedAtlas(config) {
  let entry = atlasCache.find((e) => configEquals(e.config, config));
  if (!entry) {
    const unicode = new UnicodeServiceStub();
    entry = { config, atlas: new TextureAtlas(document, config, unicode), unicode };
    atlasCache.push(entry);
  }
  return entry;
}
var ATTR_WIDE = 1 << 12;
var ATTR_COMBINING = 1 << 14;
var ATTR_UNDERLINE_COLOR = 1 << 15;
var OxttyWebglRenderer = class {
  /** Turn on `preserveDrawingBuffer` only when the canvas needs to be read (it allocates one more buffer). */
  constructor(_term, container, preserveDrawingBuffer = false) {
    this._term = _term;
    this._dimensions = createRenderDimensions();
    this._model = new RenderModel();
    this._cell = new OxttyCellData();
    this._options = new OptionsServiceStub();
    this._theme = new ThemeServiceStub(createColorSet());
    const dpr = window.devicePixelRatio || 1;
    this._coreBrowser = new CoreBrowserServiceStub(dpr);
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", { antialias: false, depth: false, preserveDrawingBuffer });
    if (!gl) throw new Error("WebGL2 not supported");
    this._gl = gl;
    container.appendChild(this.canvas);
    const term = this._term;
    this._view = {
      get cols() {
        return term.cols;
      },
      get rows() {
        return term.rows;
      },
      element: container,
      buffer: { active: { viewportY: 0 } }
    };
    this._colorResolver = new CellColorResolver(this._view, this._options, this._model.selection, new DecorationServiceStub(), this._coreBrowser, this._theme);
    this._updateDimensions(dpr);
    this._rectangles = new RectangleRenderer(this._view, this._gl, this._dimensions, this._theme);
    this._glyphs = new GlyphRenderer(this._view, this._gl, this._dimensions, this._options);
    this._model.resize(term.cols, term.rows);
    this.canvas.width = this._dimensions.device.canvas.width;
    this.canvas.height = this._dimensions.device.canvas.height;
    this.canvas.style.width = `${this._dimensions.css.canvas.width}px`;
    this.canvas.style.height = `${this._dimensions.css.canvas.height}px`;
    this._rectangles.setDimensions(this._dimensions);
    this._rectangles.handleResize();
    this._glyphs.setDimensions(this._dimensions);
    this._glyphs.handleResize();
    const d = this._dimensions.device;
    const config = generateConfig(d.cell.width, d.cell.height, d.char.width, d.char.height, terminalOptions, this._theme.colors, dpr, this._gl.getParameter(this._gl.MAX_TEXTURE_SIZE));
    ({ atlas: this._atlas, unicode: this._unicode } = sharedAtlas(config));
    this._glyphs.setAtlas(this._atlas);
  }
  // Measures the character size the same way as xterm.js CharSizeService (TextMetricsMeasureStrategy)
  _updateDimensions(dpr) {
    const ctx = new OffscreenCanvas(1, 1).getContext("2d");
    ctx.font = `${terminalOptions.fontSize}px ${terminalOptions.fontFamily}`;
    const metrics = ctx.measureText("W".repeat(32));
    const charWidth = metrics.width / 32;
    const charHeight = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
    const dim = this._dimensions;
    dim.device.char.width = Math.floor(charWidth * dpr);
    dim.device.char.height = Math.ceil(charHeight * dpr);
    dim.device.cell.height = Math.floor(dim.device.char.height * terminalOptions.lineHeight);
    dim.device.char.top = 0;
    dim.device.cell.width = dim.device.char.width;
    dim.device.char.left = 0;
    dim.device.canvas.height = this._term.rows * dim.device.cell.height;
    dim.device.canvas.width = this._term.cols * dim.device.cell.width;
    dim.css.canvas.height = Math.round(dim.device.canvas.height / dpr);
    dim.css.canvas.width = Math.round(dim.device.canvas.width / dpr);
    dim.css.cell.height = dim.device.cell.height / dpr;
    dim.css.cell.width = dim.device.cell.width / dpr;
  }
  /** Reads engine damage, applies only the changed lines to the model, and draws. */
  render() {
    const damage = this._term.takeDamage();
    if (this._glyphs.beginFrame()) {
      this._model.clear();
      this._glyphs.clear();
      this._updateRows(this._allRows());
    } else if (damage.full || damage.scroll > 0) {
      this._updateRows(this._allRows());
    } else {
      this._updateRows(damage.lines);
    }
    this._rectangles.renderBackgrounds();
    this._glyphs.render(this._model);
    this._rectangles.renderCursor();
  }
  _allRows() {
    return Array.from({ length: this._term.rows }, (_, i) => i);
  }
  // WebglRenderer._updateModel minus character joiners, selection and cursor blinking
  _updateRows(lines) {
    const term = this._term;
    const cols = term.cols;
    const cell = this._cell;
    const result = this._colorResolver.result;
    const cursor = term.cursor();
    const cursorX = Math.min(cursor.col, cols - 1);
    let lastCursorX = -1;
    let modelUpdated = false;
    this._model.cursor = void 0;
    for (const y of lines) {
      let cells = term.rowCellsView(y);
      if (!cells) continue;
      let extras;
      for (let x = 0; x < cols; x++) {
        if (cells[x * 4 + 3] & (ATTR_COMBINING | ATTR_UNDERLINE_COLOR)) {
          extras = new Map((term.rowExtras(y) ?? []).map((e) => [e.col, e]));
          cells = term.rowCellsView(y);
          break;
        }
      }
      this._model.lineLengths[y] = 0;
      for (let x = 0; x < cols; x++) {
        const lastBg = result.bg;
        const o = x * 4;
        const attrs = cells[o + 3];
        if (attrs & ATTR_WIDE) this._unicode.recordWide(cells[o]);
        const extra = extras?.get(x);
        cell.load(cells[o], cells[o + 1], cells[o + 2], attrs, extra?.text ?? "", extra?.underlineColor ?? 0);
        const chars = cell.getChars();
        let code = cell.getCode();
        const i = (y * cols + x) * RENDER_MODEL_INDICIES_PER_CELL;
        this._colorResolver.resolve(cell, x, y, this._dimensions.device.cell.width);
        if (cursor.visible && y === cursor.line) {
          if (x === cursorX) {
            this._model.cursor = { x: cursorX, y, width: cell.getWidth(), style: cursor.shape, cursorWidth: 1, dpr: this._coreBrowser.dpr };
            lastCursorX = cursorX + cell.getWidth() - 1;
          }
          if (cursor.shape === "block" && x >= cursorX && x <= lastCursorX) {
            result.fg = 50331648 /* CM_RGB */ | this._theme.colors.cursorAccent.rgba >> 8 & 16777215 /* RGB_MASK */;
            result.bg = 50331648 /* CM_RGB */ | this._theme.colors.cursor.rgba >> 8 & 16777215 /* RGB_MASK */;
          }
        }
        if (code !== NULL_CELL_CODE) this._model.lineLengths[y] = x + 1;
        if (this._model.cells[i] === code && this._model.cells[i + RENDER_MODEL_BG_OFFSET] === result.bg && this._model.cells[i + RENDER_MODEL_FG_OFFSET] === result.fg && this._model.cells[i + RENDER_MODEL_EXT_OFFSET] === result.ext) {
          continue;
        }
        modelUpdated = true;
        if (chars.length > 1) code |= COMBINED_CHAR_BIT_MASK;
        this._model.cells[i] = code;
        this._model.cells[i + RENDER_MODEL_BG_OFFSET] = result.bg;
        this._model.cells[i + RENDER_MODEL_FG_OFFSET] = result.fg;
        this._model.cells[i + RENDER_MODEL_EXT_OFFSET] = result.ext;
        this._glyphs.updateCell(x, y, code, result.bg, result.fg, result.ext, chars, cell.getWidth(), lastBg);
      }
    }
    if (modelUpdated) this._rectangles.updateBackgrounds(this._model);
    this._rectangles.updateCursor(this._model);
  }
};

// src/main.ts
var ESC = "\x1B[";
var reset = `${ESC}0m`;
function demoText(cols) {
  const lines = [];
  lines.push(`${ESC}1;38;2;120;200;255moxtty D3 spike${reset} \u2014 xterm.js 6.0.0 WebGL \uBD80\uD488 + oxtty rowCells()`);
  lines.push("\uD55C\uAE00: \uC548\uB155\uD558\uC138\uC694, \uD130\uBBF8\uB110 \uC5D4\uC9C4 oxtty\uC785\uB2C8\uB2E4. (\uAC00\uB098\uB2E4\uB77C\uB9C8\uBC14\uC0AC)");
  let fg16 = "16\uC0C9 fg: ";
  for (let i = 0; i < 8; i++) fg16 += `${ESC}${30 + i}m\uC0C9${i}${reset} `;
  for (let i = 0; i < 8; i++) fg16 += `${ESC}${90 + i}m${8 + i}${reset} `;
  lines.push(fg16);
  let bg16 = "16\uC0C9 bg: ";
  for (let i = 0; i < 8; i++) bg16 += `${ESC}${40 + i}m  ${reset}`;
  for (let i = 0; i < 8; i++) bg16 += `${ESC}${100 + i}m  ${reset}`;
  lines.push(bg16);
  for (let row = 0; row < 3; row++) {
    let s = "";
    for (let i = 0; i < 72; i++) s += `${ESC}48;5;${16 + row * 72 + i}m ${reset}`;
    lines.push(s);
  }
  let grey = "";
  for (let i = 232; i < 256; i++) grey += `${ESC}48;5;${i}m   ${reset}`;
  lines.push(grey);
  let rgb2 = "";
  for (let i = 0; i < cols; i++) {
    const t = i / (cols - 1);
    rgb2 += `${ESC}48;2;${Math.round(255 * (1 - t))};${Math.round(80 + 100 * t)};${Math.round(255 * t)}m ${reset}`;
  }
  lines.push(rgb2);
  lines.push(`RGB fg: ${ESC}38;2;255;140;0m\uC8FC\uD669 #ff8c00${reset} ${ESC}38;2;0;200;120m\uCD08\uB85D #00c878${reset} ${ESC}38;5;201m256\uC0C9 201${reset}`);
  lines.push(`\uC18D\uC131: ${ESC}1mbold \uAD75\uAC8C${reset} ${ESC}3mitalic \uAE30\uC6B8\uC784${reset} ${ESC}4munderline \uBC11\uC904${reset} ${ESC}7minverse \uBC18\uC804${reset} ${ESC}2mdim${reset} ${ESC}9mstrike${reset} ${ESC}4:3;58;2;255;0;0mcurly${reset}`);
  lines.push(`\uC870\uD569: ${ESC}1;3;4;31mbold+italic+underline \uBE68\uAC15${reset} ${ESC}7;32m inverse \uCD08\uB85D ${reset} ${ESC}1;34m\uAD75\uC740 \uD30C\uB791(\uBC1D\uAC8C)${reset}`);
  lines.push("\uC774\uBAA8\uC9C0: \u{1F600} \u{1F389} \u{1F44D} |\uACBD\uACC4| \uD55C\u{1F600}\uAE00  \uACB0\uD569: e\u0301 a\u0308 n\u0303");
  lines.push(`\uBC15\uC2A4: \u250C\u2500\u2500\u252C\u2500\u2500\u2510 \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588 ${ESC}36m\u276F${reset} \uCEE4\uC11C \u2192`);
  return lines.join("\r\n");
}
async function main() {
  await init();
  const term = new Terminal({ cols: 80, rows: 16, scrollback: 0 });
  term.write(demoText(term.cols));
  term.write(" ");
  const container = document.getElementById("terminal");
  const renderer = new OxttyWebglRenderer(term, container);
  renderer.render();
  term.write(`${ESC}16;1H${ESC}32m2\uCC28 write:${reset} damage \uC904\uB9CC \uAC31\uC2E0, \uB9C9\uB300 \uCEE4\uC11C \u2192 ${ESC}6 q`);
  renderer.render();
  const c = term.cursor();
  window.__oxtty = { ready: true, cursor: c, rows: Array.from({ length: term.rows }, (_, y) => term.rowText(y)) };
}
main().catch((err) => {
  console.error(err);
  window.__oxtty = { ready: true, error: String(err) };
});
/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */
/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */
/**
 * Copyright (c) 2016 The xterm.js authors. All rights reserved.
 * @license MIT
 */
/**
 * Copyright (c) 2021 The xterm.js authors. All rights reserved.
 * @license MIT
 */
/**
 * Copyright (c) 2022 The xterm.js authors. All rights reserved.
 * @license MIT
 */
/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */
//# sourceMappingURL=main.js.map
