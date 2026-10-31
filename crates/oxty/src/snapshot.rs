//! ANSI 스냅샷: 엔진 화면을 "빈 xterm.js에 쓰면 같은 화면이 되는 바이트"로 만든다.
//!
//! 출처: wmux(openwong2kim/wmux, 오너 작성 MIT)의 `core/wmux-term/src/native_serialize.rs`
//! (직렬화기)와, 호스트가 메우던 보정 `src/daemon/RustSnapshot.ts`·
//! `src/daemon/util/ansiStreamScan.ts`(미완 escape 꼬리, UTF-8 carry, 마진 거부)를 옮겼다.
//! oxty에서는 MIT OR Apache-2.0으로 배포한다.
//!
//! 출력 = 직렬화(grid) ‖ (동기화가 열려 있었으면 `CSI ?2026h`) ‖ 원문 꼬리.
//! 커서 가시성은 엔진 상태(`SHOW_CURSOR`)를 그대로 싣는다 — RIS 동작은 vt 옵션
//! `ris_keeps_cursor_visibility`가 xterm.js에 맞춘다.
use crate::vt::event::EventListener;
use crate::vt::grid::{Dimensions, Grid};
use crate::vt::index::{Column, Line};
use crate::vt::term::cell::{Cell, Flags};
use crate::vt::term::{Term, TermMode};
use crate::vt::vte::ansi::{Color, NamedColor};
use std::fmt::{self, Write};

/// Why [`crate::Engine::ansi_snapshot`] cannot rebuild the screen; replay the
/// raw output instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SnapshotRefusal {
    /// A fullwidth glyph starts in the last column (a resize clipped it);
    /// printing it again would wrap instead.
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

/// 넘겨줄 미완 시퀀스의 최대 길이(wmux `MAX_PENDING_TAIL_CHARS`).
const MAX_PENDING_TAIL: usize = 4096;

/// `feed`가 받은 원문의 끝. vte는 파서의 미완 상태를 원문으로 돌려주지 않으므로 엔진이 들고 있다.
///
/// ESC는 어느 상태에서든 새 시퀀스를 시작하므로(vte·xterm 공통) 꼬리는 항상 스트림의
/// 마지막 ESC부터다. 그래서 feed마다 마지막 ESC 이후만 훑는다.
#[derive(Default)]
pub(crate) struct RawTail {
    state: Scan,
    /// 미완 시퀀스 원문(ESC 포함). 넘치면 비우고 `overflowed`.
    escape: Vec<u8>,
    overflowed: bool,
    /// 스트림의 마지막 최대 3바이트 — 미완 UTF-8 접미 계산용.
    last: Vec<u8>,
}

/// wmux `ScanState`. 문자열(OSC/DCS/SOS/PM/APC) 안의 ESC는 ST든 중단이든 `Esc`와 같게 진행한다.
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
                // 마지막 ESC 뒤이므로 남은 바이트는 평문이다.
                self.escape.clear();
                self.overflowed = false;
                break;
            }
            if was == Scan::Ground {
                self.escape.clear();
                self.overflowed = false;
            }
            // 시퀀스 안의 C0(`\x1b[31\n`의 LF)는 여기서 이미 실행됐다. 다시 실행되지 않게 빼도 파라미터 상태는 같다.
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

    /// payload 끝에 붙일 원문: 미완 시퀀스(그 안의 미완 UTF-8 포함), 없으면 미완 UTF-8 접미.
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

/// wmux `PartialSequenceTracker.advance`의 바이트판.
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
            // 파라미터·중간 바이트, 그리고 시퀀스를 끝내지 않는 C0.
            _ => Scan::Csi,
        },
        Scan::String => match b {
            0x07 | 0x18 | 0x1a => Scan::Ground,
            _ => Scan::String,
        },
    }
}

/// 끝에서 미완인 UTF-8 바이트 수(0~3). wmux `incompleteUtf8SuffixLength`.
fn incomplete_utf8_suffix_len(buf: &[u8]) -> usize {
    for back in 1..=buf.len().min(3) {
        let b = buf[buf.len() - back];
        if b & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        let expected = if b & 0b1000_0000 == 0 {
            1
        } else if b & 0b1110_0000 == 0b1100_0000 {
            2
        } else if b & 0b1111_0000 == 0b1110_0000 {
            3
        } else if b & 0b1111_1000 == 0b1111_0000 {
            4
        } else {
            return 0;
        };
        return if expected > back { back } else { 0 };
    }
    0
}

/// [`crate::Engine::ansi_snapshot`]의 본체. 거부 순서는 wmux와 같다: 마진 → 꼬리 넘침 → 와이드 가장자리.
pub(crate) fn ansi<T: EventListener>(
    term: &Term<T>,
    held_sync: bool,
    tail: &RawTail,
) -> Result<Vec<u8>, SnapshotRefusal> {
    let region = term.scroll_region();
    if region.start.0 != 0 || region.end.0 != term.screen_lines() as i32 {
        return Err(SnapshotRefusal::Margins);
    }
    let tail = tail.pending()?;
    let mut out = serialize(term)?;
    if held_sync {
        out.push_str("\x1b[?2026h");
    }
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(tail);
    Ok(bytes)
}

// 여기부터 wmux native_serialize.rs에서 옮긴 코드. 바뀐 점: 리스너 제네릭, 거부 enum,
// 탭 칸을 공백으로, DECOM을 커서보다 먼저.

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

fn glyph(out: &mut String, cell: &Cell) {
    // 탭이 지나간 첫 칸에 남은 '\t'를 그대로 쓰면 xterm이 다시 탭으로 실행한다.
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
    // CUP clears wrap-pending. Repaint the edge cell to restore that state.
    if grid.cursor.input_needs_wrap {
        let cell = &grid[point.line][Column(col)];
        out.push_str(&style(cell));
        glyph(out, cell);
    }
    out.push_str(&style(&grid.cursor.template));
}

fn screen(out: &mut String, grid: &Grid<Cell>) {
    let mut previous_style = String::new();
    for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
        let line = &grid[Line(y)];
        for x in 0..grid.columns() {
            let cell = &line[Column(x)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let next_style = style(cell);
            if next_style != previous_style {
                out.push_str(&next_style);
                previous_style = next_style;
            }
            glyph(out, cell);
        }
        if y < grid.screen_lines() as i32 - 1
            && !line[grid.last_column()].flags.contains(Flags::WRAPLINE)
        {
            // Clear rendition before scrolling; otherwise a colored blank
            // template can paint extra cells beyond the serialized content.
            out.push_str("\x1b[0m\r\n");
            previous_style.clear();
        }
    }
}

fn serialize<T: EventListener>(term: &Term<T>) -> Result<String, SnapshotRefusal> {
    // xterm can retain half a wide glyph when clipping the cursor paragraph.
    // Printing that glyph would wrap instead. Refuse instead of corrupting it.
    for grid in [term.grid(), term.inactive_grid()] {
        for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
            if grid[Line(y)][grid.last_column()]
                .flags
                .contains(Flags::WIDE_CHAR)
            {
                return Err(SnapshotRefusal::WideEdge);
            }
        }
    }
    let mut out = String::from("\x1b[0m\x1b[?6l\x1b[?7h\x1b[4l\x1b[H");
    let modes = term.mode();
    if modes.contains(TermMode::ALT_SCREEN) {
        screen(&mut out, term.inactive_grid());
        cursor(&mut out, term.inactive_grid());
        out.push_str("\x1b[?1049h\x1b[0m\x1b[H");
    }
    screen(&mut out, term.grid());
    // DECOM을 켜면 커서가 홈으로 가므로 CUP보다 먼저 낸다(마진은 거부되므로 CUP 기준은 화면 전체).
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
