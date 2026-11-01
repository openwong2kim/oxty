//! ANSI snapshot: turns the engine screen into "bytes that produce the same screen when written to an empty xterm.js".
//!
//! Origin: ported from `core/wmux-term/src/native_serialize.rs` in wmux (openwong2kim/wmux, MIT, written by the owner)
//! (the serializer), plus the corrections the host used to fill in, `src/daemon/RustSnapshot.ts` and
//! `src/daemon/util/ansiStreamScan.ts` (incomplete escape tail, UTF-8 carry, margin rejection).
//! The same author redistributes it under Apache-2.0 in oxtty.
//!
//! Output = serialize(grid) ‖ raw tail. During sync: serialize(grid before BSU) ‖ `CSI ?2026h` ‖ raw pending bytes.
//! Cursor visibility carries the engine state (`SHOW_CURSOR`) as is — the vt option
//! `ris_keeps_cursor_visibility` aligns RIS behavior with xterm.js.
use crate::history::History;
use crate::vt::event::EventListener;
use crate::vt::grid::{Dimensions, Grid, Row};
use crate::vt::index::{Column, Line};
use crate::vt::term::cell::{Cell, Flags, Hyperlink};
use crate::vt::term::{Term, TermMode};
use crate::vt::vte::ansi::{Color, NamedColor};
use std::fmt::{self, Write};

/// Why [`crate::Engine::ansi_snapshot`] cannot rebuild the screen; replay the
/// raw output instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SnapshotRefusal {
    /// A fullwidth glyph is missing one of its halves: it starts in the last
    /// column or lost its right half to a resize, or an insert left its right
    /// half alone. Printing it again would wrap or fill both halves instead.
    WideEdge,
    /// Scroll margins (DECSTBM) narrower than the screen are set; the
    /// snapshot does not carry them.
    Margins,
    /// The output ends inside an escape sequence longer than 4096 bytes.
    TailOverflow,
}

impl SnapshotRefusal {
    /// The reason as wmux reports it: `"unsupported-wide-edge"`, `"margins"`
    /// or `"partial-tail-overflow"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WideEdge => "unsupported-wide-edge",
            Self::Margins => "margins",
            Self::TailOverflow => "partial-tail-overflow",
        }
    }
}

impl fmt::Display for SnapshotRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::error::Error for SnapshotRefusal {}

/// Maximum length of an incomplete sequence to carry over (wmux `MAX_PENDING_TAIL_CHARS`).
const MAX_PENDING_TAIL: usize = 4096;

/// The raw end of what `feed` received. vte does not give back the parser's incomplete state as raw bytes, so the engine keeps it.
///
/// ESC starts a new sequence from any state (common to vte and xterm), so the tail always starts at the
/// last ESC in the stream. So each feed scans only what follows the last ESC.
#[derive(Default)]
pub(crate) struct RawTail {
    state: Scan,
    /// Raw incomplete sequence (including ESC). On overflow it is cleared and `overflowed` is set.
    escape: Vec<u8>,
    overflowed: bool,
    /// Up to the last 3 bytes of the stream — for computing the incomplete UTF-8 suffix.
    last: Vec<u8>,
}

/// wmux `ScanState`. An ESC inside a string (OSC/DCS/SOS/PM/APC) proceeds the same as `Esc`, whether it is ST or an abort.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Scan {
    #[default]
    Ground,
    Esc,
    EscIntermediate,
    Csi,
    String,
}

impl RawTail {
    pub(crate) fn push(&mut self, bytes: &[u8]) {
        let start = match bytes.iter().rposition(|&b| b == 0x1b) {
            Some(at) => {
                self.state = Scan::Ground;
                at
            }
            None if self.state == Scan::Ground => bytes.len(),
            None => 0,
        };
        for &b in &bytes[start..] {
            let was = self.state;
            self.state = step(was, b);
            if self.state == Scan::Ground {
                // This is after the last ESC, so the remaining bytes are plain text.
                self.escape.clear();
                self.overflowed = false;
                break;
            }
            if was == Scan::Ground {
                self.escape.clear();
                self.overflowed = false;
            }
            // A C0 inside a sequence (the LF in `\x1b[31\n`) has already been executed here. Dropping it so it does not run again leaves the parameter state the same.
            if b < 0x20 && b != 0x1b {
                continue;
            }
            if !self.overflowed {
                if self.escape.len() >= MAX_PENDING_TAIL {
                    self.overflowed = true;
                    self.escape.clear();
                } else {
                    self.escape.push(b);
                }
            }
        }
        let keep = self.last.len().min(3 - bytes.len().min(3));
        self.last.drain(..self.last.len() - keep);
        self.last
            .extend_from_slice(&bytes[bytes.len().saturating_sub(3)..]);
    }

    /// Raw bytes to append to the payload: the incomplete sequence (including any incomplete UTF-8 in it), or else the incomplete UTF-8 suffix.
    fn pending(&self) -> Result<&[u8], SnapshotRefusal> {
        if self.state != Scan::Ground {
            return if self.overflowed {
                Err(SnapshotRefusal::TailOverflow)
            } else {
                Ok(&self.escape)
            };
        }
        Ok(&self.last[self.last.len() - incomplete_utf8_suffix_len(&self.last)..])
    }
}

/// Byte version of wmux `PartialSequenceTracker.advance`.
fn step(state: Scan, b: u8) -> Scan {
    if b == 0x1b {
        return Scan::Esc;
    }
    match state {
        Scan::Ground => Scan::Ground,
        Scan::Esc => match b {
            b'[' => Scan::Csi,
            b']' | b'P' | b'X' | b'^' | b'_' => Scan::String,
            0x20..=0x2f => Scan::EscIntermediate,
            _ => Scan::Ground,
        },
        Scan::EscIntermediate => match b {
            0x20..=0x2f => Scan::EscIntermediate,
            _ => Scan::Ground,
        },
        Scan::Csi => match b {
            0x40..=0x7e | 0x18 | 0x1a => Scan::Ground,
            // Parameter and intermediate bytes, and C0s that do not end the sequence.
            _ => Scan::Csi,
        },
        Scan::String => match b {
            0x07 | 0x18 | 0x1a => Scan::Ground,
            _ => Scan::String,
        },
    }
}

/// Number of incomplete UTF-8 bytes at the end (0~3). wmux `incompleteUtf8SuffixLength`.
fn incomplete_utf8_suffix_len(buf: &[u8]) -> usize {
    // vte keeps exactly what `from_utf8` calls an unfinished character at the end; bytes that can
    // never start a character (E0 80, a lone continuation) were already handled as invalid.
    (1..=buf.len().min(3))
        .rev()
        .find(|&n| {
            std::str::from_utf8(&buf[buf.len() - n..])
                .is_err_and(|e| e.valid_up_to() == 0 && e.error_len().is_none())
        })
        .unwrap_or(0)
}

/// The body of [`crate::Engine::ansi_snapshot`]. The rejection order is the same as wmux: margins → tail overflow → wide edge.
pub(crate) fn ansi<T: EventListener>(
    term: &Term<T>,
    held_sync: Option<&[u8]>,
    tail: &RawTail,
    older: Option<&History>,
) -> Result<Vec<u8>, SnapshotRefusal> {
    let region = term.scroll_region();
    if region.start.0 != 0 || region.end.0 != term.screen_lines() as i32 {
        return Err(SnapshotRefusal::Margins);
    }
    // During sync, all raw bytes after BSU are the tail (the parser is in ground right after BSU) — no overflow check needed.
    let tail = match held_sync {
        Some(held) => held,
        None => tail.pending()?,
    };
    let mut out = serialize(term, older)?;
    if held_sync.is_some() {
        out.push_str("\x1b[?2026h");
    }
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(tail);
    Ok(bytes)
}

// From here on, code ported from wmux native_serialize.rs. Changes: listener generic, rejection enum,
// tab cells as spaces, DECOM before the cursor.

fn color(out: &mut String, value: Color, foreground: bool) {
    let base = if foreground { 38 } else { 48 };
    match value {
        Color::Spec(rgb) => {
            let _ = write!(out, ";{base};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        }
        Color::Indexed(index) => {
            let _ = write!(out, ";{base};5;{index}");
        }
        Color::Named(NamedColor::Foreground | NamedColor::Background) => {}
        Color::Named(value) => {
            let index = value as u32;
            if index < 8 {
                let _ = write!(out, ";{}", (if foreground { 30 } else { 40 }) + index);
            } else if index < 16 {
                let _ = write!(out, ";{}", (if foreground { 90 } else { 100 }) + index - 8);
            }
        }
    }
}

fn style(cell: &Cell) -> String {
    let mut out = String::from("\x1b[0");
    for (flag, code) in [
        (Flags::BOLD, 1),
        (Flags::DIM, 2),
        (Flags::ITALIC, 3),
        (Flags::BLINK, 5),
        (Flags::INVERSE, 7),
        (Flags::HIDDEN, 8),
        (Flags::STRIKEOUT, 9),
    ] {
        if cell.flags.contains(flag) {
            let _ = write!(out, ";{code}");
        }
    }
    let underline = if cell.flags.contains(Flags::DOUBLE_UNDERLINE) {
        Some(2)
    } else if cell.flags.contains(Flags::UNDERCURL) {
        Some(3)
    } else if cell.flags.contains(Flags::DOTTED_UNDERLINE) {
        Some(4)
    } else if cell.flags.contains(Flags::DASHED_UNDERLINE) {
        Some(5)
    } else if cell.flags.contains(Flags::UNDERLINE) {
        Some(1)
    } else {
        None
    };
    if let Some(kind) = underline {
        let _ = write!(out, ";4:{kind}");
    }
    color(&mut out, cell.fg, true);
    color(&mut out, cell.bg, false);
    if let Some(value) = cell.underline_color() {
        match value {
            Color::Spec(rgb) => {
                let _ = write!(out, ";58:2::{}:{}:{}", rgb.r, rgb.g, rgb.b);
            }
            Color::Indexed(index) => {
                let _ = write!(out, ";58:5:{index}");
            }
            Color::Named(_) => {}
        }
    }
    out.push('m');
    out
}

/// Opens `link` or closes the open one. A program's own id is kept so separate runs of one
/// link stay one link; an id Alacritty generated is left out, and the receiver generates its
/// own (a new run starts wherever the link changes, so links stay apart).
fn link(out: &mut String, link: Option<&Hyperlink>) {
    match link {
        Some(link) if link.id().ends_with("_alacritty") => {
            let _ = write!(out, "\x1b]8;;{}\x1b\\", link.uri());
        }
        Some(link) => {
            let _ = write!(out, "\x1b]8;id={};{}\x1b\\", link.id(), link.uri());
        }
        None => out.push_str("\x1b]8;;\x1b\\"),
    }
}

fn glyph(out: &mut String, cell: &Cell) {
    // Writing the '\t' left in the first cell a tab passed over as is would make xterm execute it as a tab again.
    out.push(if cell.c == '\t' { ' ' } else { cell.c });
    if let Some(chars) = cell.zerowidth() {
        out.extend(chars);
    }
}

fn cursor(out: &mut String, grid: &Grid<Cell>) {
    let point = grid.cursor.point;
    let mut col = point.column.0;
    if grid.cursor.input_needs_wrap
        && grid[point.line][Column(col)]
            .flags
            .contains(Flags::WIDE_CHAR_SPACER)
    {
        col = col.saturating_sub(1);
    }
    let _ = write!(out, "\x1b[{};{}H", point.line.0 + 1, col + 1);
    // CUP clears the pending wrap at line end, so rewrite the edge cell to restore that state.
    if grid.cursor.input_needs_wrap {
        let cell = &grid[point.line][Column(col)];
        out.push_str(&style(cell));
        let edge = cell.hyperlink();
        if edge.is_some() {
            link(out, edge.as_ref());
        }
        glyph(out, cell);
        if edge.is_some() {
            link(out, None);
        }
    }
    out.push_str(&style(&grid.cursor.template));
    // The program may be in the middle of writing a link.
    if let Some(open) = grid.cursor.template.hyperlink() {
        link(out, Some(&open));
    }
}

/// `older` is the compressed history older than this grid (primary screen only).
fn screen(out: &mut String, grid: &Grid<Cell>, older: Option<&History>) {
    let mut previous_style = String::new();
    let mut previous_link: Option<Hyperlink> = None;
    let mut row = |out: &mut String, line: &Row<Cell>, last: bool| {
        for cell in &line[..] {
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let next_style = style(cell);
            if next_style != previous_style {
                out.push_str(&next_style);
                previous_style = next_style;
            }
            let next_link = cell.hyperlink();
            if next_link != previous_link {
                link(out, next_link.as_ref());
                previous_link = next_link;
            }
            glyph(out, cell);
        }
        if !last && !line[grid.last_column()].flags.contains(Flags::WRAPLINE) {
            // Clear attributes before scrolling. Otherwise a colored blank template
            // paints cells outside the serialized content.
            out.push_str("\x1b[0m\r\n");
            previous_style.clear();
        }
    };
    for i in 0..older.map_or(0, History::len) {
        row(out, &older.expect("len is 0 without history").row(i), false);
    }
    for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
        row(out, &grid[Line(y)], y == grid.screen_lines() as i32 - 1);
    }
    if previous_link.is_some() {
        link(out, None);
    }
}

/// Whether a wide char in `row` lacks one of its halves.
fn split_wide(row: &Row<Cell>) -> bool {
    let mut leader = false;
    for cell in &row[..] {
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) != leader {
            return true;
        }
        leader = cell.flags.contains(Flags::WIDE_CHAR);
    }
    leader
}

fn serialize<T: EventListener>(
    term: &Term<T>,
    older: Option<&History>,
) -> Result<String, SnapshotRefusal> {
    // When cutting the cursor paragraph, xterm can leave half of a wide character. Printing that character
    // wraps the line, so reject instead of corrupting it. The inactive grid is serialized only when on the
    // alternate screen, so check it only then (so leftover alternate screen content after leaving does not cause a rejection).
    // A resize also leaves a left half without its right half mid-row (cut, then widened), and
    // ICH in the middle of a wide char leaves a right half alone (xterm.js `insertCells`); no
    // printed text rebuilds either.
    let alt = term.mode().contains(TermMode::ALT_SCREEN);
    for grid in std::iter::once(term.grid()).chain(alt.then(|| term.inactive_grid())) {
        for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
            if split_wide(&grid[Line(y)]) {
                return Err(SnapshotRefusal::WideEdge);
            }
        }
    }
    if let Some(older) = older {
        if (0..older.len()).any(|i| split_wide(&older.row(i))) {
            return Err(SnapshotRefusal::WideEdge);
        }
    }
    let mut out = String::from("\x1b[0m\x1b[?6l\x1b[?7h\x1b[4l\x1b[H");
    let modes = term.mode();
    let alt = modes.contains(TermMode::ALT_SCREEN);
    if alt {
        screen(&mut out, term.inactive_grid(), older);
        cursor(&mut out, term.inactive_grid());
        out.push_str("\x1b[?1049h\x1b[0m\x1b[H");
        // SGR 0 leaves an OSC 8 link open; the primary pen's link is saved with 1049 and must not spill.
        if term.inactive_grid().cursor.template.hyperlink().is_some() {
            link(&mut out, None);
        }
    }
    screen(&mut out, term.grid(), if alt { None } else { older });
    // Turning on DECOM sends the cursor home, so emit it before CUP (margins are rejected, so CUP is relative to the whole screen).
    if modes.contains(TermMode::ORIGIN) {
        out.push_str("\x1b[?6h");
    }
    cursor(&mut out, term.grid());
    for (mode, code) in [
        (TermMode::APP_CURSOR, 1),
        (TermMode::FOCUS_IN_OUT, 1004),
        (TermMode::SGR_MOUSE, 1006),
        (TermMode::BRACKETED_PASTE, 2004),
    ] {
        if modes.contains(mode) {
            let _ = write!(out, "\x1b[?{code}h");
        }
    }
    if modes.contains(TermMode::INSERT) {
        out.push_str("\x1b[4h");
    }
    if modes.contains(TermMode::APP_KEYPAD) {
        out.push_str("\x1b=");
    }
    if !modes.contains(TermMode::LINE_WRAP) {
        out.push_str("\x1b[?7l");
    }
    if modes.contains(TermMode::MOUSE_MOTION) {
        out.push_str("\x1b[?1003h");
    } else if modes.contains(TermMode::MOUSE_DRAG) {
        out.push_str("\x1b[?1002h");
    } else if modes.contains(TermMode::MOUSE_REPORT_CLICK) {
        out.push_str("\x1b[?1000h");
    }
    out.push_str(if modes.contains(TermMode::SHOW_CURSOR) {
        "\x1b[?25h"
    } else {
        "\x1b[?25l"
    });
    Ok(out)
}
