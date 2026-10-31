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

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

// 내장 Alacritty 포크. 원본 서식을 유지해 업그레이드 diff를 작게 한다.
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
    // 압축 히스토리. 켜져 있으면 Alacritty는 최근 TermHistory::RECENT줄만 들고 더 오래된 줄을 여기로 넘긴다.
    history: Option<TermHistory>,
    scrollback: usize,
    // 압축 히스토리일 때 주 화면의 뷰 위치는 엔진이 정한다(Alacritty 쪽은 늘 0).
    offset: usize,
    // 주 화면 그리드가 위로 스크롤한 줄 수 중 이미 반영한 값.
    scrolled_seen: u64,
    // 뷰가 움직여서 다음 damage는 전체다.
    view_moved: bool,
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
        }
    }

    fn alt_screen(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    /// 히스토리를 가진 주 화면 그리드(대체 화면일 때는 화면 밖에 있다).
    fn primary(&self) -> &Grid<AlacCell> {
        if self.alt_screen() {
            self.term.inactive_grid()
        } else {
            self.term.grid()
        }
    }

    /// 압축 히스토리. 대체 화면에서는 히스토리가 보이지 않으므로 `None`이다.
    fn stored(&self) -> Option<MutexGuard<'_, History>> {
        Some(self.history.as_ref().filter(|_| !self.alt_screen())?.lock())
    }

    /// 주 화면이 스크롤한 만큼 뒤로 올린 뷰를 따라 올린다(Alacritty `display_offset`과 같다).
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
        // Alacritty는 히스토리를 지우면 뷰를 맨 아래로 돌린다(damage는 내지 않는다).
        if cleared {
            self.offset = 0;
        }
        // Alacritty처럼 영역 스크롤에도 올리고, 히스토리가 아니라 한도로 자른다.
        if self.offset > 0 && delta > 0 {
            self.offset = (self.offset + delta).min(self.scrollback);
            self.view_moved = true;
        }
    }

    /// `line`의 행을 `f`에 넘긴다. 압축 히스토리의 줄은 그 자리에서 풀어서 넘긴다.
    fn with_row<R>(&self, line: i32, f: impl FnOnce(&Row<AlacCell>) -> R) -> Option<R> {
        let grid = self.term.grid();
        let recent = grid.history_size() as i32;
        if (-recent..self.rows() as i32).contains(&line) {
            return Some(f(&grid[Line(line)]));
        }
        let stored = self.stored()?;
        let older = stored.len() as i32;
        if line < -recent && line >= -(recent + older) {
            let row = stored.row((older + recent + line) as usize);
            return Some(f(&row));
        }
        None
    }

    /// Interprets bytes written by the program (UTF-8 and escape sequences
    /// may be split across calls).
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        self.follow_scroll();
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
        // 압축 히스토리일 때 Alacritty는 뷰가 늘 맨 아래라고 보므로, 뒤로 올린 만큼 줄을 내린다.
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
                // 뷰가 히스토리로 올라가 있으면 화면 밖으로 밀린 줄은 뺀다.
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
