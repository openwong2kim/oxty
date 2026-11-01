//! 압축 히스토리: 화면 위로 밀려난 줄을 "UTF-8 글자 + 속성 구간"으로 줄여 담는다.
//!
//! 셀마다 24바이트(Alacritty)·12바이트(xterm.js)를 쓰는 대신, 같은 색·속성이 이어지는 칸을
//! 구간 하나로 묶고 글자만 UTF-8로 적는다. 로그 한 줄(120칸)이 100바이트 안팎이 된다.
//! 넓은 글자와 그 뒤 칸은 한 단위로 묶는다. 결합 문자·밑줄 색·링크(`Cell::extra`)는 드물어서
//! 줄 번호·칸 번호로 따로 둔다.
//!
//! 줄은 64 KiB 블록에 이어 붙이고, 오래된 줄이 다 빠진 블록을 통째로 버린다.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::vt::event::EventListener;
use crate::vt::grid::{Dimensions, HistorySink, Row};
use crate::vt::term::cell::{Cell, CellExtra, Flags};
use crate::vt::term::{Term, TermMode};
use crate::vt::vte::ansi::{Color, NamedColor, Rgb};

const BLOCK_BYTES: usize = 64 << 10;

// 구간 머리 바이트: 글자가 모두 공백이면 글자를 적지 않고, 바뀐 속성만 적는다.
const BLANK: u8 = 1 << 0;
const FG: u8 = 1 << 1;
const BG: u8 = 1 << 2;
const FLAGS: u8 = 1 << 3;
/// 넓은 글자 구간: 단위마다 넓은 글자 칸 + 뒤 칸 두 칸, 글자가 공백인 단위만 좁은 공백 한 칸.
const PAIRS: u8 = 1 << 4;

const DEFAULT_FG: Color = Color::Named(NamedColor::Foreground);
const DEFAULT_BG: Color = Color::Named(NamedColor::Background);

#[derive(Debug)]
struct Block {
    /// 이 블록 첫 줄의 절대 번호.
    first: u64,
    bytes: Vec<u8>,
    /// 줄마다 `bytes` 안의 시작 위치.
    starts: Vec<u32>,
}

type Extras = Box<[(u16, Arc<CellExtra>)]>;

#[derive(Debug)]
pub(crate) struct History {
    limit: usize,
    blocks: VecDeque<Block>,
    /// 남아 있는 가장 오래된 줄의 절대 번호.
    first: u64,
    len: usize,
    /// 줄 번호 순서로 쌓이고 앞에서 빠지므로 정렬된 덱으로 충분하다.
    extras: VecDeque<(u64, Extras)>,
    /// 프로그램이 히스토리를 지웠다(`CSI 3 J`, RIS). 엔진이 뷰를 맨 아래로 돌리고 내린다.
    pub(crate) cleared: bool,
}

impl History {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            blocks: VecDeque::new(),
            first: 0,
            len: 0,
            extras: VecDeque::new(),
            cleared: false,
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    /// Row `i`, 0 being the oldest.
    pub(crate) fn row(&self, i: usize) -> Row<Cell> {
        let abs = self.first + i as u64;
        let at = self
            .blocks
            .partition_point(|b| b.first + b.starts.len() as u64 <= abs);
        let block = &self.blocks[at];
        let k = (abs - block.first) as usize;
        let end = block
            .starts
            .get(k + 1)
            .map_or(block.bytes.len(), |&e| e as usize);
        decode(
            &block.bytes[block.starts[k] as usize..end],
            self.extras
                .binary_search_by_key(&abs, |(at, _)| *at)
                .ok()
                .map(|i| &self.extras[i].1),
        )
    }

    /// Removes every row, oldest first.
    pub(crate) fn take_all(&mut self) -> Vec<Row<Cell>> {
        let rows = (0..self.len).map(|i| self.row(i)).collect();
        self.drop_all();
        rows
    }

    fn drop_all(&mut self) {
        self.first += self.len as u64;
        self.len = 0;
        self.blocks.clear();
        self.extras.clear();
    }

    fn push_row(&mut self, row: &Row<Cell>) {
        if self.limit == 0 {
            return;
        }
        let abs = self.first + self.len as u64;
        if self
            .blocks
            .back()
            .is_none_or(|b| b.bytes.len() >= BLOCK_BYTES)
        {
            self.blocks.push_back(Block {
                first: abs,
                bytes: Vec::with_capacity(BLOCK_BYTES + BLOCK_BYTES / 8),
                starts: Vec::new(),
            });
        }
        // 블록 끝에 바로 적는다. 블록을 조금 넘겨도 다음 줄부터 새 블록을 쓴다.
        let block = self.blocks.back_mut().expect("block pushed above");
        block.starts.push(block.bytes.len() as u32);
        let mut extras = Vec::new();
        encode(row, &mut block.bytes, &mut extras);
        if !extras.is_empty() {
            self.extras.push_back((abs, extras.into_boxed_slice()));
        }
        self.len += 1;
        if self.len > self.limit {
            self.pop_oldest();
        }
    }

    fn pop_oldest(&mut self) {
        if self.extras.front().is_some_and(|(at, _)| *at == self.first) {
            self.extras.pop_front();
        }
        self.first += 1;
        self.len -= 1;
        if let Some(front) = self.blocks.front() {
            if self.first >= front.first + front.starts.len() as u64 {
                self.blocks.pop_front();
            }
        }
    }
}

impl HistorySink<Cell> for History {
    fn push(&mut self, row: &Row<Cell>) {
        self.push_row(row);
    }

    fn clear(&mut self) {
        self.drop_all();
        self.cleared = true;
    }
}

/// Compressed scrollback for a caller that drives its own [`Term`] instead of
/// an [`Engine`](crate::Engine).
///
/// Build the term with `scrolling_history: TermHistory::RECENT` and attach
/// this before feeding it: the primary grid then keeps the newest `RECENT`
/// history rows and hands older ones here. Rows are numbered oldest first and
/// sit above the grid's own history; they belong to the primary screen. Resize
/// through [`TermHistory::resize`] so that reflow sees the whole history.
#[derive(Clone)]
pub struct TermHistory {
    inner: Arc<Mutex<History>>,
    scrollback: usize,
}

impl TermHistory {
    /// History rows the grid itself keeps.
    // 넓은 글자를 덮어쓸 때 바로 윗줄(히스토리일 수 있다)을 고치므로 0으로 둘 수 없다.
    pub const RECENT: usize = 16;

    /// Attaches to the primary grid of `term`, keeping `scrollback` history
    /// rows in all.
    pub fn attach<T>(term: &mut Term<T>, scrollback: usize) -> Self {
        let inner = Arc::new(Mutex::new(History::new(
            scrollback.saturating_sub(Self::RECENT),
        )));
        let sink: Arc<Mutex<dyn HistorySink<Cell>>> = inner.clone();
        term.grid_mut().set_history_sink(Some(sink));
        Self { inner, scrollback }
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, History> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Rows held here, above the grid's history.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Row `i`, 0 being the oldest.
    pub fn row(&self, i: usize) -> Row<Cell> {
        self.lock().row(i)
    }

    /// Resizes `term`, reflowing these rows with the grid's.
    pub fn resize<T: EventListener>(&self, term: &mut Term<T>, size: impl Dimensions) {
        self.reflow(term, size, 0);
    }

    /// 압축 히스토리를 주 화면 그리드에 잠시 풀어 넣고 Alacritty의 reflow를 그대로 탄 뒤 다시 압축한다.
    /// `offset`은 주 화면 뷰 위치이고, reflow 뒤의 위치를 돌려준다.
    pub(crate) fn reflow<T: EventListener>(
        &self,
        term: &mut Term<T>,
        size: impl Dimensions,
        offset: usize,
    ) -> usize {
        let older = self.lock().take_all();
        let alt = term.mode().contains(TermMode::ALT_SCREEN);
        let grid = if alt {
            term.inactive_grid_mut()
        } else {
            term.grid_mut()
        };
        let sink = grid.set_history_sink(None);
        grid.prepend_history(older, self.scrollback);
        grid.set_display_offset(offset);
        term.resize(size);
        let grid = if alt {
            term.inactive_grid_mut()
        } else {
            term.grid_mut()
        };
        let offset = grid.display_offset();
        let older = grid.split_off_history(Self::RECENT);
        grid.set_history_sink(sink);
        let mut stored = self.lock();
        for row in &older {
            stored.push(row);
        }
        offset
    }
}

/// 넓은 글자 칸과 바로 뒤 칸(공백, 같은 속성)은 한 단위로 적는다.
#[inline]
fn is_pair(cells: &[Cell], i: usize) -> bool {
    let (Some(wide), Some(spacer)) = (cells.get(i), cells.get(i + 1)) else {
        return false;
    };
    wide.flags.contains(Flags::WIDE_CHAR)
        && wide.c != ' '
        && spacer.c == ' '
        && spacer.extra.is_none()
        && spacer.fg == wide.fg
        && spacer.bg == wide.bg
        && spacer.flags == (wide.flags - Flags::WIDE_CHAR) | Flags::WIDE_CHAR_SPACER
}

/// `row`를 `out` 끝에 덧붙인다.
fn encode(row: &Row<Cell>, out: &mut Vec<u8>, extras: &mut Vec<(u16, Arc<CellExtra>)>) {
    let cells = &row[..];
    // 한 줄이 쓸 만큼 미리 잡아 둔다(칸마다 최대 4바이트 + 구간 머리).
    out.reserve(cells.len() * 4 + 64);
    varint(out, cells.len());
    // 줄 끝의 기본 빈칸은 마지막에 구간 하나로 적는다. `occ` 뒤 칸은 모두 마지막 칸과 같으므로
    // (Row::reset 불변식) 그 앞까지만 훑으면 된다.
    let last_default = cells.last().is_some_and(|c| {
        c.c == ' '
            && c.flags.is_empty()
            && c.fg == DEFAULT_FG
            && c.bg == DEFAULT_BG
            && c.extra.is_none()
    });
    let scan = if last_default {
        row.occ.min(cells.len())
    } else {
        cells.len()
    };
    debug_assert!(
        cells[scan..].iter().all(|c| *c == Cell::default()),
        "cells past occ"
    );
    let used = cells[..scan]
        .iter()
        .rposition(|c| {
            c.c != ' '
                || !c.flags.is_empty()
                || c.fg != DEFAULT_FG
                || c.bg != DEFAULT_BG
                || c.extra.is_some()
        })
        .map_or(0, |i| i + 1);
    let mut prev = (DEFAULT_FG, DEFAULT_BG, Flags::empty());
    let mut start = 0;
    while start < used {
        let pair = is_pair(cells, start);
        let first = &cells[start];
        let key = (
            first.fg,
            first.bg,
            if pair {
                first.flags - Flags::WIDE_CHAR
            } else {
                first.flags
            },
        );
        // 머리를 먼저 적고 글자를 바로 뒤에 붙인 다음, 단위 수와 BLANK를 채운다.
        let head = put_head(out, &mut prev, key, pair);
        let body = out.len();
        // 같은 종류·속성의 단위를 모은다. 넓은 글자가 아닌 구간은 끝의 공백을
        // 글자를 적지 않는 구간으로 떼어 낸다.
        let (mut at, mut units) = (start, 0);
        // 마지막 글자(공백 아닌 단위) 뒤의 위치와 단위 수
        let (mut text_end, mut text_units) = (start, 0);
        while at < used {
            let cell = &cells[at];
            if cell.fg != key.0 || cell.bg != key.1 {
                break;
            }
            if cell.flags == key.2 {
                // 좁은 칸. 넓은 글자 구간에는 같은 속성의 좁은 공백만 넣는다(단어 사이에서 끊기지 않게).
                if pair && cell.c != ' ' {
                    break;
                }
                put_char(out, cell.c);
                if let Some(extra) = &cell.extra {
                    extras.push((at as u16, extra.clone()));
                }
                at += 1;
                units += 1;
                if cell.c != ' ' {
                    (text_end, text_units) = (at, units);
                }
            } else if pair && cell.flags == key.2 | Flags::WIDE_CHAR && is_pair(cells, at) {
                put_char(out, cell.c);
                if let Some(extra) = &cell.extra {
                    extras.push((at as u16, extra.clone()));
                }
                at += 2;
                units += 1;
                (text_end, text_units) = (at, units);
            } else {
                break;
            }
        }
        let (end, units) = if text_units == 0 {
            out.truncate(body);
            out[head] |= BLANK;
            (at, units)
        } else {
            // 떼어 낸 끝 공백(한 칸에 1바이트)은 다음 구간이 다시 읽는다.
            out.truncate(out.len() - (units - text_units));
            while extras
                .last()
                .is_some_and(|(col, _)| *col as usize >= text_end)
            {
                extras.pop();
            }
            (text_end, text_units)
        };
        out[head + 1..head + 3].copy_from_slice(&(units as u16).to_le_bytes());
        start = end;
    }
    if used < cells.len() {
        let key = (DEFAULT_FG, DEFAULT_BG, Flags::empty());
        let head = put_head(out, &mut prev, key, false);
        out[head] |= BLANK;
        out[head + 1..head + 3].copy_from_slice(&((cells.len() - used) as u16).to_le_bytes());
    }
}

/// 구간 머리(종류, 단위 수 자리 2바이트, 앞 구간과 달라진 속성)를 적고 그 위치를 돌려준다.
fn put_head(
    out: &mut Vec<u8>,
    prev: &mut (Color, Color, Flags),
    key: (Color, Color, Flags),
    pair: bool,
) -> usize {
    let mut tag = 0;
    if pair {
        tag |= PAIRS;
    }
    if key.0 != prev.0 {
        tag |= FG;
    }
    if key.1 != prev.1 {
        tag |= BG;
    }
    if key.2 != prev.2 {
        tag |= FLAGS;
    }
    let head = out.len();
    out.extend_from_slice(&[tag, 0, 0]);
    if tag & FG != 0 {
        put_color(out, key.0);
    }
    if tag & BG != 0 {
        put_color(out, key.1);
    }
    if tag & FLAGS != 0 {
        out.extend_from_slice(&key.2.bits().to_le_bytes());
    }
    *prev = key;
    head
}

#[inline(always)]
fn put_char(out: &mut Vec<u8>, c: char) {
    let n = c as u32;
    if n < 0x80 {
        out.push(n as u8);
    } else if n < 0x800 {
        out.extend_from_slice(&[0xc0 | (n >> 6) as u8, 0x80 | (n & 0x3f) as u8]);
    } else if n < 0x1_0000 {
        out.extend_from_slice(&[
            0xe0 | (n >> 12) as u8,
            0x80 | ((n >> 6) & 0x3f) as u8,
            0x80 | (n & 0x3f) as u8,
        ]);
    } else {
        out.extend_from_slice(&[
            0xf0 | (n >> 18) as u8,
            0x80 | ((n >> 12) & 0x3f) as u8,
            0x80 | ((n >> 6) & 0x3f) as u8,
            0x80 | (n & 0x3f) as u8,
        ]);
    }
}

fn decode(mut bytes: &[u8], extras: Option<&Extras>) -> Row<Cell> {
    let cols = take_varint(&mut bytes);
    let mut cells = Vec::with_capacity(cols);
    let (mut fg, mut bg, mut flags) = (DEFAULT_FG, DEFAULT_BG, Flags::empty());
    while cells.len() < cols {
        let head = take(&mut bytes, 3);
        let (tag, n) = (head[0], u16::from_le_bytes([head[1], head[2]]));
        if tag & FG != 0 {
            fg = take_color(&mut bytes);
        }
        if tag & BG != 0 {
            bg = take_color(&mut bytes);
        }
        if tag & FLAGS != 0 {
            let b = take(&mut bytes, 2);
            flags = Flags::from_bits_retain(u16::from_le_bytes([b[0], b[1]]));
        }
        let cell = |c, flags| Cell {
            c,
            fg,
            bg,
            flags,
            extra: None,
        };
        for _ in 0..n {
            if tag & PAIRS != 0 {
                match take_char(&mut bytes) {
                    ' ' => cells.push(cell(' ', flags)),
                    c => {
                        cells.push(cell(c, flags | Flags::WIDE_CHAR));
                        cells.push(cell(' ', flags | Flags::WIDE_CHAR_SPACER));
                    }
                }
            } else if tag & BLANK != 0 {
                cells.push(cell(' ', flags));
            } else {
                cells.push(cell(take_char(&mut bytes), flags));
            }
        }
    }
    for (col, extra) in extras.into_iter().flat_map(|e| e.iter()) {
        cells[*col as usize].extra = Some(extra.clone());
    }
    Row::from_vec(cells, cols)
}

fn put_color(out: &mut Vec<u8>, color: Color) {
    match color {
        Color::Named(n) => {
            out.push(0);
            out.extend_from_slice(&(n as u16).to_le_bytes());
        }
        Color::Indexed(i) => out.extend_from_slice(&[1, i]),
        Color::Spec(Rgb { r, g, b }) => out.extend_from_slice(&[2, r, g, b]),
    }
}

fn take_color(bytes: &mut &[u8]) -> Color {
    match take(bytes, 1)[0] {
        0 => {
            let b = take(bytes, 2);
            Color::Named(named(u16::from_le_bytes([b[0], b[1]])))
        }
        1 => Color::Indexed(take(bytes, 1)[0]),
        _ => {
            let b = take(bytes, 3);
            Color::Spec(Rgb {
                r: b[0],
                g: b[1],
                b: b[2],
            })
        }
    }
}

fn named(index: u16) -> NamedColor {
    use NamedColor::*;
    const ANSI: [NamedColor; 16] = [
        Black,
        Red,
        Green,
        Yellow,
        Blue,
        Magenta,
        Cyan,
        White,
        BrightBlack,
        BrightRed,
        BrightGreen,
        BrightYellow,
        BrightBlue,
        BrightMagenta,
        BrightCyan,
        BrightWhite,
    ];
    const SPECIAL: [NamedColor; 13] = [
        Foreground,
        Background,
        Cursor,
        DimBlack,
        DimRed,
        DimGreen,
        DimYellow,
        DimBlue,
        DimMagenta,
        DimCyan,
        DimWhite,
        BrightForeground,
        DimForeground,
    ];
    match index {
        0..=15 => ANSI[index as usize],
        _ => SPECIAL[(index - 256) as usize],
    }
}

fn varint(out: &mut Vec<u8>, mut n: usize) {
    while n >= 0x80 {
        out.push(n as u8 | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

fn take_varint(bytes: &mut &[u8]) -> usize {
    let mut n = 0;
    let mut shift = 0;
    loop {
        let b = take(bytes, 1)[0];
        n |= ((b & 0x7f) as usize) << shift;
        if b < 0x80 {
            return n;
        }
        shift += 7;
    }
}

fn take_char(bytes: &mut &[u8]) -> char {
    let len = match bytes[0] {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    };
    let s = std::str::from_utf8(take(bytes, len)).expect("encoded from a char");
    s.chars().next().expect("one char")
}

fn take<'a>(bytes: &mut &'a [u8], n: usize) -> &'a [u8] {
    let (head, rest) = bytes.split_at(n);
    *bytes = rest;
    head
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vt::term::cell::Hyperlink;

    fn cell(c: char, fg: Color, bg: Color, flags: Flags) -> Cell {
        Cell {
            c,
            fg,
            bg,
            flags,
            extra: None,
        }
    }

    fn sample_rows() -> Vec<Row<Cell>> {
        let red = Color::Named(NamedColor::Red);
        let rgb = Color::Spec(Rgb { r: 1, g: 200, b: 3 });
        let idx = Color::Indexed(208);
        let mut rows = Vec::new();

        rows.push(Row::new(120));

        let mut log = Row::new(120);
        for (i, c) in "PASS build src/x.ts".chars().enumerate() {
            log[crate::vt::index::Column(i)] = cell(
                c,
                if i < 4 { red } else { DEFAULT_FG },
                DEFAULT_BG,
                Flags::empty(),
            );
        }
        rows.push(log);

        // 넓은 글자와 그 뒤 칸, 줄 끝 wrap, 색 있는 빈칸, 결합 문자·링크·밑줄 색, 탭
        let mut mixed = Row::new(10);
        mixed[crate::vt::index::Column(0)] = cell('한', idx, rgb, Flags::WIDE_CHAR | Flags::BOLD);
        mixed[crate::vt::index::Column(1)] =
            cell(' ', idx, rgb, Flags::WIDE_CHAR_SPACER | Flags::BOLD);
        mixed[crate::vt::index::Column(2)] = cell('😀', DEFAULT_FG, DEFAULT_BG, Flags::WIDE_CHAR);
        mixed[crate::vt::index::Column(3)] =
            cell(' ', DEFAULT_FG, DEFAULT_BG, Flags::WIDE_CHAR_SPACER);
        mixed[crate::vt::index::Column(4)] = cell('\t', DEFAULT_FG, red, Flags::empty());
        let mut e = cell('e', DEFAULT_FG, DEFAULT_BG, Flags::UNDERCURL);
        e.push_zerowidth('\u{301}');
        e.set_underline_color(Some(rgb));
        mixed[crate::vt::index::Column(5)] = e;
        let mut link = cell('L', DEFAULT_FG, DEFAULT_BG, Flags::empty());
        link.set_hyperlink(Some(Hyperlink::new(
            Some("id"),
            "https://example.com".into(),
        )));
        mixed[crate::vt::index::Column(6)] = link;
        mixed[crate::vt::index::Column(8)] = cell(
            ' ',
            DEFAULT_FG,
            Color::Named(NamedColor::DimForeground),
            Flags::empty(),
        );
        mixed[crate::vt::index::Column(9)] =
            cell('z', DEFAULT_FG, DEFAULT_BG, Flags::WRAPLINE | Flags::BLINK);
        rows.push(mixed);
        rows
    }

    #[test]
    fn rows_round_trip() {
        let mut history = History::new(100);
        let rows = sample_rows();
        for row in &rows {
            history.push(row);
        }
        assert_eq!(history.len(), rows.len());
        for (i, row) in rows.iter().enumerate() {
            assert_eq!(&history.row(i)[..], &row[..], "row {i}");
        }
    }

    #[test]
    fn log_row_is_small() {
        let rows = sample_rows();
        let mut out = Vec::new();
        encode(&rows[1], &mut out, &mut Vec::new());
        // 120칸 = xterm.js 1440바이트
        assert!(out.len() < 40, "{} bytes", out.len());
    }

    #[test]
    fn wide_pairs_cost_their_text() {
        // "한글 " × 24: 넓은 글자 사이의 좁은 공백에서 구간이 끊기지 않아야 한다.
        let mut row = Row::new(120);
        for rep in 0..24 {
            for k in 0..2 {
                let col = rep * 5 + k * 2;
                row[crate::vt::index::Column(col)] =
                    cell('한', DEFAULT_FG, DEFAULT_BG, Flags::WIDE_CHAR);
                row[crate::vt::index::Column(col + 1)] =
                    cell(' ', DEFAULT_FG, DEFAULT_BG, Flags::WIDE_CHAR_SPACER);
            }
        }
        let mut out = Vec::new();
        encode(&row, &mut out, &mut Vec::new());
        // 글자 48개 × 3바이트 + 공백 23개 + 머리 몇 바이트
        assert!(out.len() <= 175, "{} bytes", out.len());
        assert_eq!(&decode(&out, None)[..], &row[..]);
    }

    #[test]
    fn oldest_rows_fall_off_across_blocks() {
        let mut history = History::new(3000);
        let mut row = Row::<Cell>::new(80);
        for n in 0..10_000u32 {
            for (i, c) in format!("line {n} {}", "x".repeat((n % 70) as usize))
                .chars()
                .enumerate()
            {
                row[crate::vt::index::Column(i)] = cell(c, DEFAULT_FG, DEFAULT_BG, Flags::empty());
            }
            history.push(&row);
            row.reset(&Cell::default());
        }
        assert_eq!(history.len(), 3000);
        assert!(history.blocks.len() > 1);
        let text = |r: &Row<Cell>| {
            r[..]
                .iter()
                .map(|c| c.c)
                .collect::<String>()
                .trim_end()
                .to_owned()
        };
        assert_eq!(text(&history.row(0)), "line 7000");
        assert_eq!(
            text(&history.row(2999)),
            format!("line 9999 {}", "x".repeat(59))
        );
        HistorySink::clear(&mut history);
        assert_eq!(history.len(), 0);
        history.push(&Row::new(80));
        assert_eq!(history.len(), 1);
    }
}
