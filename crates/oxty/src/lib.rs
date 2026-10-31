//! # oxty
//!
//! A terminal emulator engine: feed it the bytes a program writes to its PTY,
//! and it keeps the screen — characters, colours, cursor, modes, scrollback.
//! It does not draw anything. A renderer (WebGL, DOM, wgpu, a test) asks which
//! rows changed since it last looked and reads only those.
//!
//! The same engine builds natively and for `wasm32-unknown-unknown`, so a
//! daemon, a desktop app and a browser can share one interpretation of the
//! byte stream.
//!
//! ```
//! let mut term = oxty::Engine::new(80, 24, 1000);
//! term.feed("안녕 \x1b[31mred\x1b[0m\r\n".as_bytes());
//! assert_eq!(term.row_text(0).unwrap(), "안녕 red");
//! assert_eq!(term.cursor().line, 1);
//! ```
//!
//! Parsing and the screen model come from a lightly patched
//! [`alacritty_terminal`](https://crates.io/crates/alacritty_terminal) 0.26
//! built into this crate as [`vt`] (see `src/vt/PATCHES.md`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

// 내장 Alacritty 포크. 원본 서식을 유지해 업그레이드 diff를 작게 한다.
#[rustfmt::skip]
pub mod vt;

mod snapshot;
pub use snapshot::SnapshotRefusal;

use crate::vt::event::{Event, EventListener};
use crate::vt::grid::{Dimensions, Scroll};
use crate::vt::index::{Column, Line};
use crate::vt::term::cell::{Cell as AlacCell, Flags};
use crate::vt::term::{Config, Term, TermDamage, TermMode};
use crate::vt::vte::ansi::{Color, CursorShape as AlacCursorShape, Processor, Timeout};

/// Smallest and largest accepted dimensions.
pub const MIN_COLS: u16 = 2;
pub const MAX_COLS: u16 = 1000;
pub const MIN_ROWS: u16 = 1;
pub const MAX_ROWS: u16 = 1000;
/// Upper bound on retained scrollback lines.
pub const MAX_SCROLLBACK: usize = 100_000;

/// How long a synchronized update (`CSI ? 2026 h`) may hold output back
/// before the host should call [`Engine::flush_sync`]. Matches Alacritty.
pub const SYNC_TIMEOUT: Duration = Duration::from_millis(150);

/// Cell attribute bits returned in [`Cell::attrs`]. Stable across versions.
pub mod attr {
    pub const BOLD: u32 = 1 << 0;
    pub const DIM: u32 = 1 << 1;
    pub const ITALIC: u32 = 1 << 2;
    pub const UNDERLINE: u32 = 1 << 3;
    pub const DOUBLE_UNDERLINE: u32 = 1 << 4;
    pub const CURLY_UNDERLINE: u32 = 1 << 5;
    pub const DOTTED_UNDERLINE: u32 = 1 << 6;
    pub const DASHED_UNDERLINE: u32 = 1 << 7;
    pub const INVERSE: u32 = 1 << 8;
    pub const HIDDEN: u32 = 1 << 9;
    pub const STRIKEOUT: u32 = 1 << 10;
    pub const BLINK: u32 = 1 << 11;
    /// First half of a double-width character.
    pub const WIDE: u32 = 1 << 12;
    /// Second half of a double-width character; renderers skip it.
    pub const WIDE_SPACER: u32 = 1 << 13;
    /// The cell carries combining marks; read them with [`crate::Engine::row_extras`].
    pub const COMBINING: u32 = 1 << 14;
    /// The cell has an underline colour (SGR 58); see [`crate::Engine::row_extras`].
    pub const UNDERLINE_COLOR: u32 = 1 << 15;
    /// The cell is part of an OSC 8 hyperlink; see [`crate::Engine::row_extras`].
    pub const HYPERLINK: u32 = 1 << 16;
}

/// Terminal mode bits returned by [`Engine::modes`]. Stable across versions.
pub mod mode {
    pub const SHOW_CURSOR: u32 = 1 << 0;
    pub const APP_CURSOR: u32 = 1 << 1;
    pub const APP_KEYPAD: u32 = 1 << 2;
    pub const BRACKETED_PASTE: u32 = 1 << 3;
    pub const MOUSE_CLICK: u32 = 1 << 4;
    pub const MOUSE_DRAG: u32 = 1 << 5;
    pub const MOUSE_MOTION: u32 = 1 << 6;
    pub const SGR_MOUSE: u32 = 1 << 7;
    pub const FOCUS_EVENTS: u32 = 1 << 8;
    pub const ALT_SCREEN: u32 = 1 << 9;
    pub const ALTERNATE_SCROLL: u32 = 1 << 10;
    pub const LINE_WRAP: u32 = 1 << 11;
    pub const INSERT: u32 = 1 << 12;
    pub const ORIGIN: u32 = 1 << 13;
    /// Any kitty keyboard protocol flag is active.
    pub const KITTY_KEYBOARD: u32 = 1 << 14;
}

/// Packed colours in [`Cell::fg`] / [`Cell::bg`]: the top byte is the kind,
/// the low 24 bits the value.
pub mod color {
    /// `value` is a named colour index (0–15 ANSI, 256 = foreground,
    /// 257 = background, 258 = cursor, 259–266 dim variants …), as in Alacritty's `NamedColor`.
    pub const NAMED: u32 = 1 << 24;
    /// `value` is a 256-colour palette index.
    pub const INDEXED: u32 = 2 << 24;
    /// `value` is `0xRRGGBB`.
    pub const RGB: u32 = 3 << 24;
    pub const KIND_MASK: u32 = 0xff << 24;
    pub const VALUE_MASK: u32 = 0x00ff_ffff;
    /// Default foreground (named 256).
    pub const DEFAULT_FG: u32 = NAMED | 256;
    /// Default background (named 257).
    pub const DEFAULT_BG: u32 = NAMED | 257;
}

/// One screen cell, already flattened for a renderer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    pub fg: u32,
    pub bg: u32,
    pub attrs: u32,
}

impl Cell {
    /// Number of `u32` words per cell in [`Engine::row_packed`].
    pub const PACKED_WORDS: usize = 4;
}

/// Cursor shape set by the program (DECSCUSR, `CSI Ps SP q`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Underline,
    Bar,
}

/// Cursor position on the screen (0-based) and its style. While the view is
/// scrolled back ([`Engine::display_offset`]), it is drawn on viewport row
/// `line + display_offset`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub line: u16,
    pub col: u16,
    pub visible: bool,
    pub shape: CursorShape,
    pub blinking: bool,
}

/// What changed in the viewport since the last [`Engine::take_damage`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Damage {
    /// Redraw everything (first frame, resize, view scroll, alternate screen …).
    Full,
    /// First move every drawn row up by `scroll` rows (the top `scroll` rows
    /// fall off), then redraw `lines`, top to bottom.
    Lines { scroll: u16, lines: Vec<u16> },
}

/// What a cell carries beyond [`Cell`]. Only cells with at least one of
/// these are listed by [`Engine::row_extras`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellExtra {
    pub col: u16,
    /// Full cell text when it has combining marks ([`attr::COMBINING`]).
    pub text: Option<String>,
    /// Underline colour (SGR 58) in the [`color`] format ([`attr::UNDERLINE_COLOR`]).
    pub underline_color: Option<u32>,
    /// OSC 8 hyperlink ([`attr::HYPERLINK`]).
    pub hyperlink: Option<Hyperlink>,
}

/// An OSC 8 hyperlink. Cells of one link share its `id` (generated when the
/// program gave none).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hyperlink {
    pub id: String,
    pub uri: String,
}

#[derive(Default)]
struct Inbox {
    replies: Vec<u8>,
    title: Option<String>,
    bells: u32,
}

/// Receives Alacritty's events and keeps what a host has to act on.
#[derive(Clone, Default)]
struct Listener(Arc<Mutex<Inbox>>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let Ok(mut inbox) = self.0.lock() else { return };
        match event {
            Event::PtyWrite(text) => inbox.replies.extend_from_slice(text.as_bytes()),
            Event::Title(title) => inbox.title = Some(title),
            Event::ResetTitle => inbox.title = Some(String::new()),
            Event::Bell => inbox.bells = inbox.bells.saturating_add(1),
            // Clipboard, colour queries and size queries are host policy; not in 0.1.
            _ => {}
        }
    }
}

/// Synchronized-update timeout without a clock.
///
/// vte's default `StdSyncHandler` calls `Instant::now()`, which traps on
/// `wasm32-unknown-unknown` the moment a program sends `CSI ? 2026 h`.
/// Here the host owns time: it sees [`Engine::sync_pending`] and calls
/// [`Engine::flush_sync`] after [`SYNC_TIMEOUT`].
#[derive(Default)]
struct HostTimeout {
    pending: bool,
}

impl Timeout for HostTimeout {
    fn set_timeout(&mut self, _: Duration) {
        self.pending = true;
    }
    fn clear_timeout(&mut self) {
        self.pending = false;
    }
    fn pending_timeout(&self) -> bool {
        self.pending
    }
}

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

fn size(cols: u16, rows: u16) -> Size {
    Size {
        cols: cols.clamp(MIN_COLS, MAX_COLS) as usize,
        rows: rows.clamp(MIN_ROWS, MAX_ROWS) as usize,
    }
}

/// The terminal engine.
pub struct Engine {
    term: Term<Listener>,
    parser: Processor<HostTimeout>,
    inbox: Listener,
    tail: snapshot::RawTail,
    // vte 동기화 버퍼의 사본. vte는 내용을 공개하지 않고 개수만 알려 준다.
    held: Vec<u8>,
}

impl Engine {
    /// Creates a screen of `cols` × `rows` keeping up to `scrollback` lines of
    /// history. Dimensions are clamped to [`MIN_COLS`]..=[`MAX_COLS`] and
    /// [`MIN_ROWS`]..=[`MAX_ROWS`]; scrollback to [`MAX_SCROLLBACK`].
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        let config = Config {
            scrolling_history: scrollback.min(MAX_SCROLLBACK),
            // xterm.js 기본값(reflowCursorLine: false)과 같게 커서 문단은 reflow하지 않는다.
            reflow_cursor_line: false,
            // 스크롤 때 화면 전체 대신 스크롤 줄 수와 새 줄만 damage로 낸다.
            scroll_damage: true,
            // xterm.js처럼 RIS 뒤에도 커서 숨김을 유지한다.
            ris_keeps_cursor_visibility: true,
            // xterm.js처럼 주 화면 ED2는 지우기만 하고 히스토리로 밀지 않는다.
            scroll_on_erase_in_display: false,
            ..Config::default()
        };
        let inbox = Listener::default();
        Self {
            term: Term::new(config, &size(cols, rows), inbox.clone()),
            parser: Processor::new(),
            inbox,
            tail: Default::default(),
            held: Vec::new(),
        }
    }

    /// Interprets bytes written by the program (UTF-8 and escape sequences
    /// may be split across calls).
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        self.tail.push(bytes);
        // vte 동기화 버퍼는 항상 입력 스트림의 연속된 끝부분이라 개수만으로 사본을 맞출 수 있다.
        let n = self.parser.sync_bytes_count();
        if n <= bytes.len() {
            self.held.clear();
            self.held.extend_from_slice(&bytes[bytes.len() - n..]);
        } else {
            let drop = (self.held.len() + bytes.len()).saturating_sub(n);
            self.held.drain(..drop);
            self.held.extend_from_slice(bytes);
        }
        debug_assert_eq!(self.held.len(), n);
    }

    /// Changes the screen size. Damage becomes [`Damage::Full`].
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term.resize(size(cols, rows));
    }

    pub fn cols(&self) -> u16 {
        self.term.columns() as u16
    }

    pub fn rows(&self) -> u16 {
        self.term.screen_lines() as u16
    }

    /// Lines currently held in scrollback. History rows are addressed with
    /// negative line numbers: `-1` is the newest, `-(history_len)` the oldest.
    pub fn history_len(&self) -> usize {
        self.term.grid().history_size()
    }

    fn line(&self, line: i32) -> Option<Line> {
        let history = self.history_len() as i32;
        (-history..self.rows() as i32)
            .contains(&line)
            .then_some(Line(line))
    }

    /// Text of one row with trailing blanks removed; wide-character spacers
    /// skipped and combining marks kept. `None` if `line` is out of range.
    pub fn row_text(&self, line: i32) -> Option<String> {
        let line = self.line(line)?;
        let row = &self.term.grid()[line];
        let mut text = String::with_capacity(self.cols() as usize);
        for col in 0..self.term.columns() {
            let cell = &row[Column(col)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            text.push(cell.c);
            if let Some(marks) = cell.zerowidth() {
                text.extend(marks);
            }
        }
        text.truncate(text.trim_end().len());
        Some(text)
    }

    /// Whether `line` continues on the next line (soft wrap).
    pub fn row_wrapped(&self, line: i32) -> bool {
        self.line(line).is_some_and(|line| {
            self.term.grid()[line][Column(self.term.columns() - 1)]
                .flags
                .contains(Flags::WRAPLINE)
        })
    }

    /// Cells of one row, appended to `out` (cleared first). Returns `false`
    /// if `line` is out of range.
    pub fn row_cells(&self, line: i32, out: &mut Vec<Cell>) -> bool {
        out.clear();
        let Some(line) = self.line(line) else {
            return false;
        };
        let row = &self.term.grid()[line];
        out.extend((0..self.term.columns()).map(|col| flatten(&row[Column(col)])));
        true
    }

    /// Cells of one row as `[ch, fg, bg, attrs]` words — the form handed to
    /// WebAssembly and N-API hosts. Returns `false` if `line` is out of range.
    pub fn row_packed(&self, line: i32, out: &mut Vec<u32>) -> bool {
        out.clear();
        let Some(line) = self.line(line) else {
            return false;
        };
        let row = &self.term.grid()[line];
        out.reserve(self.term.columns() * Cell::PACKED_WORDS);
        for col in 0..self.term.columns() {
            let cell = flatten(&row[Column(col)]);
            out.extend([cell.ch as u32, cell.fg, cell.bg, cell.attrs]);
        }
        true
    }

    /// Cells of one row that carry combining marks, an underline colour or a
    /// hyperlink, appended to `out` (cleared first). Wide-character spacers
    /// are skipped. Returns `false` if `line` is out of range.
    pub fn row_extras(&self, line: i32, out: &mut Vec<CellExtra>) -> bool {
        out.clear();
        let Some(line) = self.line(line) else {
            return false;
        };
        let row = &self.term.grid()[line];
        for col in 0..self.term.columns() {
            let cell = &row[Column(col)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let text = cell
                .zerowidth()
                .filter(|marks| !marks.is_empty())
                .map(|marks| {
                    std::iter::once(cell.c)
                        .chain(marks.iter().copied())
                        .collect()
                });
            let underline_color = cell.underline_color().map(pack_color);
            let hyperlink = cell.hyperlink().map(|link| Hyperlink {
                id: link.id().to_owned(),
                uri: link.uri().to_owned(),
            });
            if text.is_some() || underline_color.is_some() || hyperlink.is_some() {
                out.push(CellExtra {
                    col: col as u16,
                    text,
                    underline_color,
                    hyperlink,
                });
            }
        }
        true
    }

    /// Full text of one cell including combining marks.
    pub fn cell_text(&self, line: i32, col: u16) -> Option<String> {
        let line = self.line(line)?;
        if col as usize >= self.term.columns() {
            return None;
        }
        let cell = &self.term.grid()[line][Column(col as usize)];
        let mut text = String::from(cell.c);
        if let Some(marks) = cell.zerowidth() {
            text.extend(marks);
        }
        Some(text)
    }

    pub fn cursor(&self) -> Cursor {
        let point = self.term.grid().cursor.point;
        let style = self.term.cursor_style();
        let shape = match style.shape {
            AlacCursorShape::Underline => CursorShape::Underline,
            AlacCursorShape::Beam => CursorShape::Bar,
            AlacCursorShape::Block | AlacCursorShape::HollowBlock | AlacCursorShape::Hidden => {
                CursorShape::Block
            }
        };
        Cursor {
            line: point.line.0.max(0) as u16,
            col: point.column.0 as u16,
            visible: self.term.mode().contains(TermMode::SHOW_CURSOR)
                && style.shape != AlacCursorShape::Hidden,
            shape,
            blinking: style.blinking,
        }
    }

    /// Rows the view is scrolled back into history (0 = following output).
    /// Viewport row `y` shows line `y - display_offset` (see [`Engine::row_cells`]).
    pub fn display_offset(&self) -> usize {
        self.term.grid().display_offset()
    }

    /// Scrolls the view; positive `delta` goes back into history. Clamped to
    /// the history. Damage becomes [`Damage::Full`] when the view moves.
    pub fn scroll_display(&mut self, delta: i32) {
        self.term.scroll_display(Scroll::Delta(delta));
    }

    /// Returns the view to the newest output.
    pub fn scroll_to_bottom(&mut self) {
        self.term.scroll_display(Scroll::Bottom);
    }

    /// Active modes as [`mode`] bits.
    pub fn modes(&self) -> u32 {
        let m = *self.term.mode();
        let map = [
            (TermMode::SHOW_CURSOR, mode::SHOW_CURSOR),
            (TermMode::APP_CURSOR, mode::APP_CURSOR),
            (TermMode::APP_KEYPAD, mode::APP_KEYPAD),
            (TermMode::BRACKETED_PASTE, mode::BRACKETED_PASTE),
            (TermMode::MOUSE_REPORT_CLICK, mode::MOUSE_CLICK),
            (TermMode::MOUSE_DRAG, mode::MOUSE_DRAG),
            (TermMode::MOUSE_MOTION, mode::MOUSE_MOTION),
            (TermMode::SGR_MOUSE, mode::SGR_MOUSE),
            (TermMode::FOCUS_IN_OUT, mode::FOCUS_EVENTS),
            (TermMode::ALT_SCREEN, mode::ALT_SCREEN),
            (TermMode::ALTERNATE_SCROLL, mode::ALTERNATE_SCROLL),
            (TermMode::LINE_WRAP, mode::LINE_WRAP),
            (TermMode::INSERT, mode::INSERT),
            (TermMode::ORIGIN, mode::ORIGIN),
        ];
        let mut bits = map
            .iter()
            .filter(|(t, _)| m.contains(*t))
            .fold(0, |acc, (_, b)| acc | b);
        if m.intersects(TermMode::KITTY_KEYBOARD_PROTOCOL) {
            bits |= mode::KITTY_KEYBOARD;
        }
        bits
    }

    /// Viewport changes since the previous call, then resets tracking.
    pub fn take_damage(&mut self) -> Damage {
        let rows = self.term.screen_lines();
        let scroll = self.term.damage_scrolled() as u16;
        let damage = match self.term.damage() {
            TermDamage::Full => Damage::Full,
            TermDamage::Partial(lines) => Damage::Lines {
                scroll,
                // 뷰가 히스토리로 올라가 있으면 화면 밖으로 밀린 줄은 뺀다.
                lines: lines
                    .map(|b| b.line)
                    .filter(|&l| l < rows)
                    .map(|l| l as u16)
                    .collect(),
            },
        };
        self.term.reset_damage();
        damage
    }

    /// Bytes the terminal wants written back to the program (device status
    /// and attribute reports, …). Send them to the PTY.
    pub fn take_replies(&mut self) -> Vec<u8> {
        self.inbox
            .0
            .lock()
            .map(|mut i| std::mem::take(&mut i.replies))
            .unwrap_or_default()
    }

    /// The new window title if it changed since the last call (`""` = reset).
    pub fn take_title(&mut self) -> Option<String> {
        self.inbox.0.lock().ok().and_then(|mut i| i.title.take())
    }

    /// Bells (`BEL`) received since the last call.
    pub fn take_bells(&mut self) -> u32 {
        self.inbox
            .0
            .lock()
            .map(|mut i| std::mem::take(&mut i.bells))
            .unwrap_or(0)
    }

    /// A synchronized update is holding output back. Call
    /// [`Engine::flush_sync`] if it is still pending after [`SYNC_TIMEOUT`].
    pub fn sync_pending(&self) -> bool {
        self.parser.sync_timeout().pending_timeout()
    }

    /// Ends a pending synchronized update and applies the held output.
    pub fn flush_sync(&mut self) {
        if self.sync_pending() {
            self.parser.stop_sync(&mut self.term);
            self.held.clear();
        }
    }

    /// Bytes that rebuild this screen in a fresh xterm.js terminal of the same
    /// size and scrollback: history, both buffers, cursor (pending wrap
    /// included), pen and modes, followed — raw — by the escape sequence or
    /// UTF-8 character the output ended in the middle of, so the program's
    /// next bytes continue there as they do here.
    ///
    /// During a synchronized update the payload is the screen from before the
    /// update, then `CSI ? 2026 h` and the held output raw, so the receiver
    /// is inside the same update and ends it on the same bytes. Refusals are
    /// judged on that earlier screen.
    ///
    /// The engine is not changed (no damage, the update stays held), so it is
    /// safe on an engine being drawn, and calling this twice gives the same
    /// bytes.
    ///
    /// On a [`SnapshotRefusal`] these bytes could not reproduce the screen;
    /// replay the raw output instead.
    pub fn ansi_snapshot(&self) -> Result<Vec<u8>, SnapshotRefusal> {
        let held = self.sync_pending().then_some(self.held.as_slice());
        snapshot::ansi(&self.term, held, &self.tail)
    }
}

fn flatten(cell: &AlacCell) -> Cell {
    let f = cell.flags;
    let pairs = [
        (Flags::BOLD, attr::BOLD),
        (Flags::DIM, attr::DIM),
        (Flags::ITALIC, attr::ITALIC),
        (Flags::UNDERLINE, attr::UNDERLINE),
        (Flags::DOUBLE_UNDERLINE, attr::DOUBLE_UNDERLINE),
        (Flags::UNDERCURL, attr::CURLY_UNDERLINE),
        (Flags::DOTTED_UNDERLINE, attr::DOTTED_UNDERLINE),
        (Flags::DASHED_UNDERLINE, attr::DASHED_UNDERLINE),
        (Flags::INVERSE, attr::INVERSE),
        (Flags::HIDDEN, attr::HIDDEN),
        (Flags::STRIKEOUT, attr::STRIKEOUT),
        (Flags::BLINK, attr::BLINK),
        (Flags::WIDE_CHAR, attr::WIDE),
        (Flags::WIDE_CHAR_SPACER, attr::WIDE_SPACER),
    ];
    let mut attrs = pairs
        .iter()
        .filter(|(a, _)| f.contains(*a))
        .fold(0, |acc, (_, b)| acc | b);
    if cell.zerowidth().is_some_and(|z| !z.is_empty()) {
        attrs |= attr::COMBINING;
    }
    if cell.underline_color().is_some() {
        attrs |= attr::UNDERLINE_COLOR;
    }
    if cell.hyperlink().is_some() {
        attrs |= attr::HYPERLINK;
    }
    Cell {
        ch: cell.c,
        fg: pack_color(cell.fg),
        bg: pack_color(cell.bg),
        attrs,
    }
}

/// Packs an Alacritty colour into the [`color`] format.
pub fn pack_color(c: Color) -> u32 {
    match c {
        Color::Named(n) => color::NAMED | n as u32,
        Color::Indexed(i) => color::INDEXED | i as u32,
        Color::Spec(rgb) => color::RGB | (rgb.r as u32) << 16 | (rgb.g as u32) << 8 | rgb.b as u32,
    }
}
