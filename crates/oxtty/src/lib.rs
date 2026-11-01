//! # oxtty
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
//! let mut term = oxtty::Engine::new(80, 24, 1000);
//! term.feed("안녕 \x1b[31mred\x1b[0m\r\n".as_bytes());
//! assert_eq!(term.row_text(0).unwrap(), "안녕 red");
//! assert_eq!(term.cursor().line, 1);
//! ```
//!
//! Parsing and the screen model come from a lightly patched
//! [`alacritty_terminal`](https://crates.io/crates/alacritty_terminal) 0.26
//! built into this crate as [`vt`] (see `src/vt/PATCHES.md`).

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

// The built-in Alacritty fork. It keeps the upstream formatting so upgrade diffs stay small.
#[rustfmt::skip]
pub mod vt;

mod history;
mod snapshot;
pub use history::TermHistory;
pub use snapshot::SnapshotRefusal;

use crate::history::History;
use crate::vt::event::{Event, EventListener};
use crate::vt::grid::{Dimensions, Grid, Row, Scroll};
use crate::vt::index::Line;
use crate::vt::term::cell::{Cell as AlacCell, Flags};
use crate::vt::term::{ClipboardType, Config, Osc52, Term, TermDamage, TermMode};
use crate::vt::vte::ansi::Rgb;
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

/// The clipboard an OSC 52 request names: `c`, or `p`/`s` (the primary selection).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Clipboard {
    Clipboard,
    Selection,
}

impl From<ClipboardType> for Clipboard {
    fn from(ty: ClipboardType) -> Self {
        match ty {
            ClipboardType::Clipboard => Clipboard::Clipboard,
            ClipboardType::Selection => Clipboard::Selection,
        }
    }
}

/// Colours that answer OSC 4/10/11/12 queries: the 256 palette entries, then
/// foreground, background and cursor, as `0xRRGGBB`.
pub const COLOR_SLOTS: usize = 259;

/// Decoded compressed-history rows kept for repeated reads (a scrolled-back
/// view redraws the same rows every frame).
const ROW_CACHE: usize = 64;

/// Unanswered clipboard reads and untaken writes kept at most (oldest dropped first).
const CLIPBOARD_QUEUE: usize = 16;

/// Cap on reply bytes the host has not taken. Past it, new replies are dropped
/// whole (a program sending `CSI 6n` forever to a host that never calls
/// [`Engine::take_replies`]).
pub const MAX_REPLIES: usize = 1 << 20;

type ClipboardFormatter = Arc<dyn Fn(&str) -> String + Sync + Send>;
type ColorFormatter = Arc<dyn Fn(Rgb) -> String + Sync + Send>;

#[derive(Default)]
struct Inbox {
    replies: Vec<u8>,
    title: Option<String>,
    bells: u32,
    clipboard_read: bool,
    clipboard_write: bool,
    clipboard_writes: VecDeque<(Clipboard, String)>,
    clipboard_reads: VecDeque<Clipboard>,
    // Reads waiting for an answer, with their reply format (it echoes the request's selection character).
    clipboard_pending: VecDeque<(Clipboard, ClipboardFormatter)>,
    // Colour queries: where in `replies` the answer goes, the colour index and the format. Answers are
    // inserted at that position to keep the order of replies.
    color_queries: Vec<(usize, usize, ColorFormatter)>,
}

fn push_bounded<T>(queue: &mut VecDeque<T>, item: T) {
    if queue.len() == CLIPBOARD_QUEUE {
        queue.pop_front();
    }
    queue.push_back(item);
}

/// Receives Alacritty's events and keeps what a host has to act on.
#[derive(Clone, Default)]
struct Listener(Arc<Mutex<Inbox>>);

impl Listener {
    // A poisoned lock (a panic elsewhere) keeps its contents usable, as TermHistory::lock does.
    fn inbox(&self) -> MutexGuard<'_, Inbox> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Inbox {
    fn reply(&mut self, bytes: &[u8]) {
        if self.replies.len() + bytes.len() <= MAX_REPLIES {
            self.replies.extend_from_slice(bytes);
        }
    }
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let mut inbox = self.inbox();
        match event {
            Event::PtyWrite(text) => inbox.reply(text.as_bytes()),
            Event::Title(title) => inbox.title = Some(title),
            Event::ResetTitle => inbox.title = Some(String::new()),
            Event::Bell => inbox.bells = inbox.bells.saturating_add(1),
            Event::ClipboardStore(ty, text) if inbox.clipboard_write => {
                push_bounded(&mut inbox.clipboard_writes, (ty.into(), text));
            }
            Event::ClipboardLoad(ty, format) if inbox.clipboard_read => {
                push_bounded(&mut inbox.clipboard_reads, ty.into());
                push_bounded(&mut inbox.clipboard_pending, (ty.into(), format));
            }
            Event::ColorRequest(index, format) => {
                let at = inbox.replies.len();
                inbox.color_queries.push((at, index, format));
            }
            // Size queries are host policy; not in 0.1.
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
    // A copy of vte's synchronized-update buffer. vte reports only its length, not its contents.
    held: Vec<u8>,
    // Compressed history. When on, Alacritty keeps only the newest TermHistory::RECENT rows and hands
    // older ones here.
    history: Option<TermHistory>,
    scrollback: usize,
    // With compressed history the engine owns the primary screen's view position (Alacritty's stays 0).
    offset: usize,
    // How many of the primary grid's scrolled lines the view has already followed.
    scrolled_seen: u64,
    // The view moved, so the next damage is full.
    view_moved: bool,
    // Scanner state for a DECSTR (`CSI Ps ! p`) split across feeds.
    decstr: DecstrScan,
    // Host colours that answer colour queries; none means queries go unanswered.
    colors: Option<Box<[u32; COLOR_SLOTS]>>,
    // Recently decoded history rows by their History::id, newest last.
    row_cache: RefCell<VecDeque<(u64, Row<AlacCell>)>>,
}

impl Engine {
    /// Creates a screen of `cols` × `rows` keeping up to `scrollback` lines of
    /// history. Dimensions are clamped to [`MIN_COLS`]..=[`MAX_COLS`] and
    /// [`MIN_ROWS`]..=[`MAX_ROWS`]; scrollback to [`MAX_SCROLLBACK`].
    ///
    /// History older than the newest few lines is kept compressed (text plus
    /// runs of equal attributes); reading it decodes one row at a time.
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        Self::build(cols, rows, scrollback, true)
    }

    /// Like [`Engine::new`], but keeps the whole history uncompressed in the
    /// grid, as upstream Alacritty does. For comparison and fallback.
    pub fn new_uncompressed(cols: u16, rows: u16, scrollback: usize) -> Self {
        Self::build(cols, rows, scrollback, false)
    }

    fn build(cols: u16, rows: u16, scrollback: usize, compress: bool) -> Self {
        let scrollback = scrollback.min(MAX_SCROLLBACK);
        let compress = compress && scrollback > TermHistory::RECENT;
        let config = Config {
            scrolling_history: if compress {
                TermHistory::RECENT
            } else {
                scrollback
            },
            // Like xterm.js's default (reflowCursorLine: false), the cursor paragraph is not reflowed.
            reflow_cursor_line: false,
            // A scroll reports the scrolled row count and the new rows, not full damage.
            scroll_damage: true,
            // Like xterm.js, RIS keeps the cursor hidden.
            ris_keeps_cursor_visibility: true,
            // Like xterm.js, ED2 on the primary screen erases without pushing rows into history.
            scroll_on_erase_in_display: false,
            // Like xterm.js, line feeds and line/screen erases change line continuation.
            xterm_line_wrap: true,
            // Like xterm.js, the left half of an overwritten wide char becomes a blank in the current
            // pen, tabs leave no character in cells, and SGR 21 is a double underline.
            xterm_wide_leader: true,
            store_tabs: false,
            sgr21_double_underline: true,
            // Like xterm.js, device attributes report a VT100 with advanced video (DA1) and xterm 276 (DA2).
            xterm_device_attributes: true,
            // The engine takes OSC 52 and passes it on only with the host's consent (set_clipboard_access).
            osc52: Osc52::CopyPaste,
            ..Config::default()
        };
        let inbox = Listener::default();
        let mut term = Term::new(config, &size(cols, rows), inbox.clone());
        let history = compress.then(|| TermHistory::attach(&mut term, scrollback));
        Self {
            term,
            parser: Processor::new(),
            inbox,
            tail: Default::default(),
            held: Vec::new(),
            history,
            scrollback,
            offset: 0,
            scrolled_seen: 0,
            view_moved: false,
            decstr: DecstrScan::default(),
            colors: None,
            row_cache: RefCell::new(VecDeque::with_capacity(ROW_CACHE)),
        }
    }

    fn alt_screen(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    /// The primary screen's grid, which holds the history (off screen while the alternate screen is up).
    fn primary(&self) -> &Grid<AlacCell> {
        if self.alt_screen() {
            self.term.inactive_grid()
        } else {
            self.term.grid()
        }
    }

    /// The compressed history; `None` on the alternate screen, where history is not visible.
    fn stored(&self) -> Option<MutexGuard<'_, History>> {
        Some(self.history.as_ref().filter(|_| !self.alt_screen())?.lock())
    }

    /// Moves a scrolled-back view up as far as the primary screen scrolled (as Alacritty's `display_offset` does).
    fn follow_scroll(&mut self) {
        if self.history.is_none() {
            return;
        }
        let scrolled = self.primary().scrolled_lines();
        let delta = (scrolled - self.scrolled_seen) as usize;
        self.scrolled_seen = scrolled;
        let cleared = self
            .history
            .as_ref()
            .is_some_and(|h| std::mem::take(&mut h.lock().cleared));
        // Alacritty returns the view to the bottom when history is cleared (without damage).
        if cleared {
            self.offset = 0;
        }
        // As in Alacritty, region scrolls move the view too, clamped to the limit rather than to the history.
        if self.offset > 0 && delta > 0 {
            self.offset = (self.offset + delta).min(self.scrollback);
            self.view_moved = true;
        }
    }

    /// Hands the row at `line` to `f`, decoding a compressed history row on the spot.
    fn with_row<R>(&self, line: i32, f: impl FnOnce(&Row<AlacCell>) -> R) -> Option<R> {
        let grid = self.term.grid();
        let recent = grid.history_size() as i32;
        if (-recent..self.rows() as i32).contains(&line) {
            return Some(f(&grid[Line(line)]));
        }
        let stored = self.stored()?;
        let older = stored.len() as i32;
        if line < -recent && line >= -(recent + older) {
            let i = (older + recent + line) as usize;
            let id = stored.id(i);
            let mut cache = self.row_cache.borrow_mut();
            if let Some((_, row)) = cache.iter().find(|(at, _)| *at == id) {
                return Some(f(row));
            }
            if cache.len() == ROW_CACHE {
                cache.pop_front();
            }
            cache.push_back((id, stored.row(i)));
            return Some(f(&cache.back()?.1));
        }
        None
    }

    /// Interprets bytes written by the program (UTF-8 and escape sequences
    /// may be split across calls).
    pub fn feed(&mut self, mut bytes: &[u8]) {
        // vte drops DECSTR, so the input is split where it ends and the engine soft-resets.
        // As in xterm.js, DECSTR also ends a synchronized update.
        while let Some(end) = self.decstr.find(bytes) {
            let (head, rest) = bytes.split_at(end);
            self.advance(head);
            self.flush_sync();
            self.term.soft_reset();
            bytes = rest;
        }
        self.advance(bytes);
    }

    fn advance(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        self.answer_color_queries();
        self.follow_scroll();
        self.tail.push(bytes);
        // vte's synchronized-update buffer is always a contiguous tail of the input, so its length is
        // enough to keep the copy in step.
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
        match &self.history {
            Some(history) => {
                self.offset = history.reflow(&mut self.term, size(cols, rows), self.offset);
                self.scrolled_seen = self.primary().scrolled_lines();
            }
            None => self.term.resize(size(cols, rows)),
        }
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
        self.term.grid().history_size() + self.stored().map_or(0, |s| s.len())
    }

    /// Text of one row with trailing blanks removed; wide-character spacers
    /// skipped and combining marks kept. `None` if `line` is out of range.
    pub fn row_text(&self, line: i32) -> Option<String> {
        self.with_row(line, |row| {
            let mut text = String::with_capacity(row.len());
            for cell in &row[..] {
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                text.push(cell.c);
                if let Some(marks) = cell.zerowidth() {
                    text.extend(marks);
                }
            }
            text.truncate(text.trim_end().len());
            text
        })
    }

    /// Whether `line` continues on the next line (soft wrap).
    pub fn row_wrapped(&self, line: i32) -> bool {
        self.with_row(line, |row| {
            row.last()
                .is_some_and(|cell| cell.flags.contains(Flags::WRAPLINE))
        })
        .unwrap_or(false)
    }

    /// Cells of one row, appended to `out` (cleared first). Returns `false`
    /// if `line` is out of range.
    pub fn row_cells(&self, line: i32, out: &mut Vec<Cell>) -> bool {
        out.clear();
        self.with_row(line, |row| out.extend(row[..].iter().map(flatten)))
            .is_some()
    }

    /// Cells of one row as `[ch, fg, bg, attrs]` words — the form handed to
    /// WebAssembly and N-API hosts. Returns `false` if `line` is out of range.
    pub fn row_packed(&self, line: i32, out: &mut Vec<u32>) -> bool {
        out.clear();
        self.with_row(line, |row| {
            out.reserve(row.len() * Cell::PACKED_WORDS);
            for cell in row[..].iter().map(flatten) {
                out.extend([cell.ch as u32, cell.fg, cell.bg, cell.attrs]);
            }
        })
        .is_some()
    }

    /// Cells of one row that carry combining marks, an underline colour or a
    /// hyperlink, appended to `out` (cleared first). Wide-character spacers
    /// are skipped. Returns `false` if `line` is out of range.
    pub fn row_extras(&self, line: i32, out: &mut Vec<CellExtra>) -> bool {
        out.clear();
        self.with_row(line, |row| {
            for (col, cell) in row[..].iter().enumerate() {
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
        })
        .is_some()
    }

    /// Full text of one cell including combining marks.
    pub fn cell_text(&self, line: i32, col: u16) -> Option<String> {
        self.with_row(line, |row| {
            let cell = row[..].get(col as usize)?;
            let mut text = String::from(cell.c);
            if let Some(marks) = cell.zerowidth() {
                text.extend(marks);
            }
            Some(text)
        })
        .flatten()
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
        if self.history.is_some() && !self.alt_screen() {
            self.offset
        } else {
            self.term.grid().display_offset()
        }
    }

    /// Scrolls the view; positive `delta` goes back into history. Clamped to
    /// the history. Damage becomes [`Damage::Full`] when the view moves.
    pub fn scroll_display(&mut self, delta: i32) {
        if self.history.is_some() && !self.alt_screen() {
            let offset = (self.offset as i64 + delta as i64).clamp(0, self.history_len() as i64);
            self.view_moved |= offset as usize != self.offset;
            self.offset = offset as usize;
        } else {
            self.term.scroll_display(Scroll::Delta(delta));
        }
    }

    /// Returns the view to the newest output.
    pub fn scroll_to_bottom(&mut self) {
        let offset = self.display_offset() as i32;
        self.scroll_display(-offset);
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
        let mut scroll = self.term.damage_scrolled() as u16;
        let moved = std::mem::take(&mut self.view_moved);
        // With compressed history Alacritty sees the view at the bottom, so lines move down by the scroll-back.
        let shift = if self.history.is_some() && !self.alt_screen() {
            self.offset
        } else {
            0
        };
        if shift > 0 {
            scroll = 0;
        }
        let damage = match self.term.damage() {
            TermDamage::Full => Damage::Full,
            _ if moved => Damage::Full,
            TermDamage::Partial(lines) => Damage::Lines {
                scroll,
                // With the view up in history, lines pushed off the screen are left out.
                lines: lines
                    .map(|b| b.line + shift)
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
        std::mem::take(&mut self.inbox.inbox().replies)
    }

    /// The new window title if it changed since the last call (`""` = reset).
    pub fn take_title(&mut self) -> Option<String> {
        self.inbox.inbox().title.take()
    }

    /// Lets the program read and/or write the host's clipboards with OSC 52.
    /// Both are off by default; requests that arrive while off are dropped.
    pub fn set_clipboard_access(&mut self, read: bool, write: bool) {
        let mut inbox = self.inbox.inbox();
        inbox.clipboard_read = read;
        inbox.clipboard_write = write;
        if !read {
            inbox.clipboard_reads.clear();
            inbox.clipboard_pending.clear();
        }
        if !write {
            inbox.clipboard_writes.clear();
        }
    }

    /// The oldest text the program asked to put on a clipboard (OSC 52) that
    /// the host has not taken yet. Invalid base64 is ignored.
    pub fn take_clipboard_write(&mut self) -> Option<(Clipboard, String)> {
        self.inbox.inbox().clipboard_writes.pop_front()
    }

    /// The oldest clipboard read (OSC 52 `?`) the host has not taken yet.
    /// Answer it with [`Engine::reply_clipboard`].
    pub fn take_clipboard_read(&mut self) -> Option<Clipboard> {
        self.inbox.inbox().clipboard_reads.pop_front()
    }

    /// Answers the oldest unanswered read of `clipboard` with `text`. The
    /// reply joins [`Engine::take_replies`] as xterm.js's clipboard addon
    /// sends it (`OSC 52 ; Pc ; base64 BEL`). Returns `false` when no read of
    /// that clipboard is waiting.
    pub fn reply_clipboard(&mut self, clipboard: Clipboard, text: &str) -> bool {
        let mut inbox = self.inbox.inbox();
        let at = inbox
            .clipboard_pending
            .iter()
            .position(|(c, _)| *c == clipboard);
        let Some((_, format)) = at.and_then(|at| inbox.clipboard_pending.remove(at)) else {
            return false;
        };
        let mut reply = format(text);
        if let Some(body) = reply.strip_suffix("\x1b\\") {
            reply = format!("{body}\x07");
        }
        inbox.reply(reply.as_bytes());
        true
    }

    /// Colours that answer OSC 4/10/11/12 queries: [`COLOR_SLOTS`] entries
    /// (palette 0–255, then foreground, background, cursor) as `0xRRGGBB`. A
    /// colour the program itself set with OSC 4/10/11/12 answers instead.
    /// `None`, the default, leaves the queries unanswered, as
    /// `@xterm/headless` does.
    pub fn set_colors(&mut self, colors: Option<[u32; COLOR_SLOTS]>) {
        self.colors = colors.map(Box::new);
    }

    // Inserts answers to the queued colour queries where each query arrived. Working from the back keeps
    // the earlier positions valid.
    fn answer_color_queries(&mut self) {
        let listener = self.inbox.clone();
        let mut inbox = listener.inbox();
        let queries = std::mem::take(&mut inbox.color_queries);
        let Some(colors) = &self.colors else { return };
        for (at, index, format) in queries.into_iter().rev() {
            let host = colors.get(index).map(|&c| Rgb {
                r: (c >> 16) as u8,
                g: (c >> 8) as u8,
                b: c as u8,
            });
            let Some(rgb) = self.term.colors()[index].or(host) else {
                continue;
            };
            let mut reply = format(rgb);
            // xterm.js answers with ST even when the query ended with BEL.
            if let Some(body) = reply.strip_suffix('\x07') {
                reply = format!("{body}\x1b\\");
            }
            if inbox.replies.len() + reply.len() <= MAX_REPLIES {
                inbox.replies.splice(at..at, reply.into_bytes());
            }
        }
    }

    /// Bells (`BEL`) received since the last call.
    pub fn take_bells(&mut self) -> u32 {
        std::mem::take(&mut self.inbox.inbox().bells)
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
            self.answer_color_queries();
            self.held.clear();
            self.follow_scroll();
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
        let history = self.history.as_ref().map(TermHistory::lock);
        snapshot::ansi(&self.term, held, &self.tail, history.as_deref())
    }
}

/// Byte-level scanner for `ESC [ Ps ! p` (DECSTR). Its state carries across calls.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum DecstrScan {
    #[default]
    Ground,
    Esc,
    Params,
    Bang,
}

impl DecstrScan {
    /// Where a DECSTR ends (just past its last byte), or `None` after advancing the state through `bytes`.
    fn find(&mut self, bytes: &[u8]) -> Option<usize> {
        let mut i = 0;
        while i < bytes.len() {
            if *self == DecstrScan::Ground {
                i += bytes[i..].iter().position(|&b| b == 0x1b)?;
            }
            let b = bytes[i];
            i += 1;
            *self = match (*self, b) {
                (_, 0x1b) => DecstrScan::Esc,
                (DecstrScan::Esc, b'[') => DecstrScan::Params,
                (DecstrScan::Params, b'0'..=b'9' | b';') => DecstrScan::Params,
                (DecstrScan::Params, b'!') => DecstrScan::Bang,
                (DecstrScan::Bang, b'p') => {
                    *self = DecstrScan::Ground;
                    return Some(i);
                }
                _ => DecstrScan::Ground,
            };
        }
        None
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
