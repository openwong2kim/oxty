//! N-API binding: `new Terminal(cols, rows, scrollback?)` for Node and
//! Electron's main process. Same engine as the WebAssembly build.

use napi::bindgen_prelude::{Buffer, Either, Uint32Array};
use napi_derive::napi;

#[napi(object)]
pub struct Cursor {
    pub line: u32,
    pub col: u32,
    pub visible: bool,
    /// `"block"`, `"underline"` or `"bar"`.
    pub shape: String,
    pub blink: bool,
}

#[napi(object)]
pub struct Damage {
    /// Redraw everything; `scroll` is 0 and `lines` is empty.
    pub full: bool,
    /// Move drawn rows up by this many first.
    pub scroll: u32,
    pub lines: Vec<u32>,
}

#[napi(object)]
pub struct Hyperlink {
    pub id: String,
    pub uri: String,
}

#[napi(object)]
pub struct CellExtra {
    pub col: u32,
    pub text: Option<String>,
    pub underline_color: Option<u32>,
    pub hyperlink: Option<Hyperlink>,
}

/// `{ ok: true, payload }` or `{ ok: false, reason }`.
#[napi(object)]
pub struct AnsiSnapshot {
    pub ok: bool,
    pub payload: Option<Buffer>,
    /// `"unsupported-wide-edge"`, `"margins"` or `"partial-tail-overflow"`.
    pub reason: Option<String>,
}

#[napi]
pub struct Terminal {
    inner: oxty::Engine,
}

#[napi]
impl Terminal {
    #[napi(constructor)]
    pub fn new(cols: u32, rows: u32, scrollback: Option<u32>) -> Self {
        Self {
            inner: oxty::Engine::new(
                cols.min(u16::MAX as u32) as u16,
                rows.min(u16::MAX as u32) as u16,
                scrollback.unwrap_or(1000) as usize,
            ),
        }
    }

    /// Feeds program output (string as UTF-8, or raw bytes).
    #[napi]
    pub fn write(&mut self, data: Either<String, Buffer>) {
        match data {
            Either::A(s) => self.inner.feed(s.as_bytes()),
            Either::B(b) => self.inner.feed(&b),
        }
    }

    #[napi]
    pub fn resize(&mut self, cols: u32, rows: u32) {
        self.inner.resize(
            cols.min(u16::MAX as u32) as u16,
            rows.min(u16::MAX as u32) as u16,
        );
    }

    #[napi(getter)]
    pub fn cols(&self) -> u32 {
        self.inner.cols() as u32
    }

    #[napi(getter)]
    pub fn rows(&self) -> u32 {
        self.inner.rows() as u32
    }

    #[napi(getter)]
    pub fn history_length(&self) -> u32 {
        self.inner.history_len() as u32
    }

    #[napi]
    pub fn row_text(&self, line: i32) -> Option<String> {
        self.inner.row_text(line)
    }

    /// `[ch, fg, bg, attrs]` per cell, or `null` if out of range.
    #[napi]
    pub fn row_cells(&self, line: i32) -> Option<Uint32Array> {
        let mut out = Vec::new();
        self.inner
            .row_packed(line, &mut out)
            .then(|| Uint32Array::new(out))
    }

    #[napi]
    pub fn row_wrapped(&self, line: i32) -> bool {
        self.inner.row_wrapped(line)
    }

    #[napi]
    pub fn cell_text(&self, line: i32, col: u32) -> Option<String> {
        self.inner.cell_text(line, col.min(u16::MAX as u32) as u16)
    }

    /// Cells with combining marks, an underline colour or a hyperlink, or
    /// `null` if out of range.
    #[napi]
    pub fn row_extras(&self, line: i32) -> Option<Vec<CellExtra>> {
        let mut extras = Vec::new();
        self.inner.row_extras(line, &mut extras).then(|| {
            extras
                .into_iter()
                .map(|e| CellExtra {
                    col: e.col as u32,
                    text: e.text,
                    underline_color: e.underline_color,
                    hyperlink: e.hyperlink.map(|l| Hyperlink {
                        id: l.id,
                        uri: l.uri,
                    }),
                })
                .collect()
        })
    }

    #[napi]
    pub fn cursor(&self) -> Cursor {
        let c = self.inner.cursor();
        let shape = match c.shape {
            oxty::CursorShape::Block => "block",
            oxty::CursorShape::Underline => "underline",
            oxty::CursorShape::Bar => "bar",
        };
        Cursor {
            line: c.line as u32,
            col: c.col as u32,
            visible: c.visible,
            shape: shape.into(),
            blink: c.blinking,
        }
    }

    /// Rows the view is scrolled back into history (0 = following output).
    #[napi(getter)]
    pub fn display_offset(&self) -> u32 {
        self.inner.display_offset() as u32
    }

    /// Positive `delta` scrolls back into history.
    #[napi]
    pub fn scroll_display(&mut self, delta: i32) {
        self.inner.scroll_display(delta);
    }

    #[napi]
    pub fn scroll_to_bottom(&mut self) {
        self.inner.scroll_to_bottom();
    }

    #[napi]
    pub fn modes(&self) -> u32 {
        self.inner.modes()
    }

    #[napi]
    pub fn take_damage(&mut self) -> Damage {
        match self.inner.take_damage() {
            oxty::Damage::Full => Damage {
                full: true,
                scroll: 0,
                lines: Vec::new(),
            },
            oxty::Damage::Lines { scroll, lines } => Damage {
                full: false,
                scroll: scroll.into(),
                lines: lines.into_iter().map(u32::from).collect(),
            },
        }
    }

    #[napi]
    pub fn take_replies(&mut self) -> Buffer {
        self.inner.take_replies().into()
    }

    #[napi]
    pub fn take_title(&mut self) -> Option<String> {
        self.inner.take_title()
    }

    #[napi]
    pub fn take_bells(&mut self) -> u32 {
        self.inner.take_bells()
    }

    #[napi]
    pub fn sync_pending(&self) -> bool {
        self.inner.sync_pending()
    }

    #[napi]
    pub fn flush_sync(&mut self) {
        self.inner.flush_sync();
    }

    /// Bytes that rebuild this screen in a fresh xterm.js, or why they cannot.
    #[napi]
    pub fn ansi_snapshot(&self) -> AnsiSnapshot {
        match self.inner.ansi_snapshot() {
            Ok(bytes) => AnsiSnapshot {
                ok: true,
                payload: Some(bytes.into()),
                reason: None,
            },
            Err(why) => AnsiSnapshot {
                ok: false,
                payload: None,
                reason: Some(why.as_str().into()),
            },
        }
    }
}
