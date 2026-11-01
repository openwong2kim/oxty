//! The built-in `SearchAddon`, `@xterm/addon-search` in Rust: `findNext`/`findPrevious` select a match and scroll it
//! into view; with `decorations` every match is painted through the renderer's `"search"` highlight layer.
//!
//! Ported from xterm.js `addons/addon-search/src/SearchAddon.ts` lines 33-256, `SearchEngine.ts` lines 44-342,
//! `SearchState.ts` lines 12-106, `SearchResultTracker.ts` lines 23-119 and the row split of
//! `DecorationManager.ts` lines 116-128 at 08829c7 (as published in `@xterm/addon-search` 0.17.0-beta.330, MIT),
//! quirks included: a whole-word search looks only at the first match
//! of each line, and `findNext` goes on from the end of the selection only when the term is unchanged (the
//! `incremental` option changes nothing). Lines come from the engine's `searchLine` (rows joined across soft wraps,
//! each UTF-16 unit mapped to its cell) instead of `translateToString` and walks over the cells; plain text is
//! matched with the JS string methods and regular expressions with `RegExp`, so no matcher is compiled into the wasm.
//!
//! Memory: an addon keeps its term, its options and, with decorations, the matches (up to `highlightLimit`, 16 bytes
//! each), in rows that stay put as the scrollback trims. Lines are read for one search and dropped.
//!
//! The selected match is the terminal's selection (`select`), and the next search starts from the selection, whatever
//! made it (`getSelectionPosition`), like the addon.
use std::cell::{Cell, OnceCell, RefCell};
use std::rc::{Rc, Weak};

use js_sys::{Array, Function, JsString, Object, Reflect, Uint32Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::emitter::{Disposable, Emitter};
use crate::engine::{get, Engine};
use crate::events;
use crate::render::Highlight;
use crate::terminal::{Shared, Terminal};
use crate::timer;

/// `@xterm/addon-search` `NON_WORD_CHARACTERS`.
const NON_WORD: &[u8] = b" ~!@#$%^&*()+`-=[]{}|\\;:\"',./<>?";
const DEFAULT_HIGHLIGHT_LIMIT: u32 = 1000;
/// With decorations, matches are searched again this long after output or a resize.
const UPDATE_DELAY_MS: i32 = 200;
/// Bit 31 of a `searchLine` cell: the unit is a wide character.
const CELL_WIDE: u32 = 1 << 31;

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = r#"
export interface ISearchOptions {
  regex?: boolean;
  wholeWord?: boolean;
  caseSensitive?: boolean;
  incremental?: boolean;
  decorations?: ISearchDecorationOptions;
}
export interface ISearchDecorationOptions {
  matchBackground?: string;
  matchBorder?: string;
  matchOverviewRuler: string;
  activeMatchBackground?: string;
  activeMatchBorder?: string;
  activeMatchColorOverviewRuler: string;
}
export interface ISearchResultChangeEvent {
  resultIndex: number;
  resultCount: number;
}
export interface ISearchAddonOptions {
  highlightLimit: number;
}
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = RegExp)]
    type Pattern;
    /// `RegExp(source, flags)`; a bad pattern throws, out of `findNext`, like the addon.
    #[wasm_bindgen(catch, js_name = RegExp)]
    fn pattern(source: &JsString, flags: &str) -> Result<Pattern, JsValue>;
    #[wasm_bindgen(method, catch)]
    fn exec(this: &Pattern, text: &JsString) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, getter = lastIndex)]
    fn last_index(this: &Pattern) -> u32;
    #[wasm_bindgen(method, setter = lastIndex)]
    fn set_last_index(this: &Pattern, index: u32);

    /// A JS string, for `indexOf` with a JS string to look for (js-sys takes a Rust `&str`).
    #[wasm_bindgen(js_name = String)]
    type Text;
    #[wasm_bindgen(method, js_name = indexOf)]
    fn index_of(this: &Text, search: &JsString, from: i32) -> i32;
    #[wasm_bindgen(method, js_name = lastIndexOf)]
    fn last_index_of(this: &Text, search: &JsString, from: i32) -> i32;
}

#[derive(Clone, Default)]
struct Decorations {
    match_background: Option<String>,
    match_border: Option<String>,
    active_match_background: Option<String>,
    active_match_border: Option<String>,
}

#[derive(Clone, Default)]
struct SearchOptions {
    regex: bool,
    whole_word: bool,
    case_sensitive: bool,
    decorations: Option<Decorations>,
}

impl SearchOptions {
    /// `None` for anything but an object, like the addon's `searchOptions?.`.
    fn parse(value: &JsValue) -> Option<Self> {
        if !value.is_object() {
            return None;
        }
        let decorations = get(value, "decorations");
        let color = |key: &str| get(&decorations, key).as_string();
        Some(Self {
            regex: get(value, "regex").is_truthy(),
            whole_word: get(value, "wholeWord").is_truthy(),
            case_sensitive: get(value, "caseSensitive").is_truthy(),
            decorations: decorations.is_truthy().then(|| Decorations {
                match_background: color("matchBackground"),
                match_border: color("matchBorder"),
                active_match_background: color("activeMatchBackground"),
                active_match_border: color("activeMatchBorder"),
            }),
        })
    }
}

/// A match as the search engine finds it: buffer row, column and length in cells (running on into later rows).
#[derive(Clone, Copy, PartialEq)]
struct Found {
    row: i32,
    col: u32,
    size: u32,
}

/// A match kept across searches: `row` counts from the first line that ever entered the scrollback, so the buffer
/// row is `row - trimmed lines` whenever it is read.
#[derive(Clone, Copy, PartialEq)]
struct Hit {
    row: f64,
    col: u32,
    size: u32,
}

impl Hit {
    fn new(found: Found, trimmed: f64) -> Self {
        Self {
            row: f64::from(found.row) + trimmed,
            col: found.col,
            size: found.size,
        }
    }
}

/// The terminal's `getSelectionPosition()`: buffer cells, end exclusive.
#[derive(Clone, Copy)]
struct SelectionPosition {
    start: (u32, i32),
    end: (u32, i32),
}

impl SelectionPosition {
    fn of(shared: &Rc<Shared>) -> Option<Self> {
        let (start, end) = crate::selection::selection_position(shared)?;
        Some(Self {
            start: (start[0] as u32, start[1] as i32),
            end: (end[0] as u32, end[1] as i32),
        })
    }
}

/// One logical line, as the addon's line cache holds it.
struct Line {
    /// Its first buffer row.
    first: i32,
    rows: i32,
    text: JsString,
    /// Lower-cased once, for plain searches that ignore case.
    lower: OnceCell<JsString>,
    /// The cell of each UTF-16 unit, counted from the start of `first`; [`CELL_WIDE`] for wide characters.
    cells: Vec<u32>,
}

/// `searchPosition` of the addon: `col` runs on past the row into the rows its line wraps into.
struct Pos {
    row: i32,
    col: u32,
}

/// One search over the engine (SearchEngine.ts), reading each line once.
struct Search<'a> {
    engine: &'a Engine,
    cols: u32,
    history: i32,
    /// One past the last buffer row (`baseY + rows`).
    end: i32,
    term: &'a JsString,
    /// What is looked for in plain searches: the term, lower-cased when case is ignored.
    needle: JsString,
    regex: Option<Pattern>,
    fold_case: bool,
    whole_word: bool,
    line: Option<Rc<Line>>,
}

impl<'a> Search<'a> {
    fn new(
        engine: &'a Engine,
        term: &'a JsString,
        options: &SearchOptions,
    ) -> Result<Self, JsValue> {
        let flags = if options.case_sensitive { "g" } else { "gi" };
        let regex = if options.regex {
            Some(pattern(term, flags)?)
        } else {
            None
        };
        let fold_case = !options.regex && !options.case_sensitive;
        let history = engine.history_length() as i32;
        Ok(Self {
            engine,
            cols: engine.cols().max(1),
            history,
            end: history + engine.rows() as i32,
            term,
            needle: if fold_case {
                term.to_lower_case()
            } else {
                term.clone()
            },
            regex,
            fold_case,
            whole_word: options.whole_word,
            line: None,
        })
    }

    /// The logical line buffer row `row` is on; `None` outside the buffer.
    fn line(&mut self, row: i32) -> Option<Rc<Line>> {
        if let Some(line) = &self.line {
            if row >= line.first && row < line.first + line.rows {
                return Some(line.clone());
            }
        }
        if row < 0 || row >= self.end {
            return None;
        }
        let value = self.engine.search_line(row - self.history).ok()?;
        if !value.is_object() {
            return None;
        }
        let line = Rc::new(Line {
            first: get(&value, "first").as_f64()? as i32 + self.history,
            rows: get(&value, "rows").as_f64()?.max(1.0) as i32,
            text: get(&value, "text").dyn_into().ok()?,
            lower: OnceCell::new(),
            cells: get(&value, "cells")
                .dyn_into::<Uint32Array>()
                .ok()?
                .to_vec(),
        });
        self.line = Some(line.clone());
        Some(line)
    }

    /// `SearchEngine.find`: the first match at or after (`row`, `col`), down to the bottom of the screen.
    fn find(&mut self, row: i32, col: u32) -> Result<Option<Found>, JsValue> {
        if col >= self.cols {
            // The addon throws; its callers never get here.
            return Ok(None);
        }
        let mut pos = Pos { row, col };
        let mut result = self.find_in_line(&mut pos, false)?;
        let mut y = row + 1;
        while result.is_none() && y < self.end {
            pos = Pos { row: y, col: 0 };
            result = self.find_in_line(&mut pos, false)?;
            y += 1;
        }
        Ok(result)
    }

    /// Every match from the top, as `_highlightAllMatches` collects them.
    fn find_all(&mut self, limit: u32) -> Result<Vec<Found>, JsValue> {
        let mut results = Vec::new();
        let mut previous: Option<(i32, u32)> = None;
        let mut result = self.find(0, 0)?;
        while let Some(found) = result {
            if previous == Some((found.row, found.col)) || results.len() >= limit as usize {
                break;
            }
            previous = Some((found.row, found.col));
            results.push(found);
            let mut col = found.col.saturating_add(found.size);
            let mut row = found.row;
            if col >= self.cols {
                row += (col / self.cols) as i32;
                col %= self.cols;
            }
            result = self.find(row, col)?;
        }
        Ok(results)
    }

    /// `findNextWithSelection`, after the selection was read and cleared.
    fn find_next(
        &mut self,
        selection: Option<SelectionPosition>,
        same_term: bool,
    ) -> Result<Option<Found>, JsValue> {
        let (start_col, start_row) = match selection {
            Some(s) if same_term => s.end,
            Some(s) => s.start,
            None => (0, 0),
        };
        let mut pos = Pos {
            row: start_row,
            col: start_col,
        };
        let mut result = self.find_in_line(&mut pos, false)?;
        let mut y = start_row + 1;
        while result.is_none() && y < self.end {
            pos = Pos { row: y, col: 0 };
            result = self.find_in_line(&mut pos, false)?;
            y += 1;
        }
        // Wrap around to the top.
        if result.is_none() && start_row != 0 {
            for y in 0..start_row {
                pos = Pos { row: y, col: 0 };
                result = self.find_in_line(&mut pos, false)?;
                if result.is_some() {
                    break;
                }
            }
        }
        // Only one match: the selected one again.
        if let (None, Some(s)) = (result, selection) {
            pos = Pos {
                row: s.start.1,
                col: 0,
            };
            result = self.find_in_line(&mut pos, false)?;
        }
        Ok(result)
    }

    /// `findPreviousWithSelection`, after the selection was read and cleared.
    fn find_previous(
        &mut self,
        selection: Option<SelectionPosition>,
        same_term: bool,
    ) -> Result<Option<Found>, JsValue> {
        let bottom = self.end - 1;
        let mut start_row = bottom;
        let mut pos = Pos {
            row: start_row,
            col: self.cols,
        };
        let mut result = None;
        if let Some(s) = selection {
            start_row = s.start.1;
            pos = Pos {
                row: s.start.1,
                col: s.start.0,
            };
            if !same_term {
                // Try to grow the selection to the right first.
                result = self.find_in_line(&mut pos, false)?;
                if result.is_none() {
                    start_row = s.end.1;
                    pos = Pos {
                        row: s.end.1,
                        col: s.end.0,
                    };
                }
            }
        }
        if result.is_none() {
            result = self.find_in_line(&mut pos, true)?;
        }
        if result.is_none() {
            pos.col = pos.col.max(self.cols);
            for y in (0..start_row).rev() {
                pos.row = y;
                result = self.find_in_line(&mut pos, true)?;
                if result.is_some() {
                    break;
                }
            }
        }
        // Wrap around to the bottom.
        if result.is_none() && start_row != bottom {
            let mut y = bottom;
            while y >= start_row {
                pos.row = y;
                result = self.find_in_line(&mut pos, true)?;
                if result.is_some() {
                    break;
                }
                y -= 1;
            }
        }
        Ok(result)
    }

    /// `_findInLine`: searches the logical line `pos.row` starts, from (forwards) or before (`reverse`) `pos.col`.
    /// A row that continues a wrapped line is searched from its line's first row going forwards, and skipped
    /// (widening `pos.col` to cover it) going backwards.
    #[inline(never)]
    fn find_in_line(&mut self, pos: &mut Pos, reverse: bool) -> Result<Option<Found>, JsValue> {
        let Some(line) = self.line(pos.row) else {
            return Ok(None);
        };
        if pos.row > line.first {
            if reverse {
                pos.col = pos.col.saturating_add(self.cols);
                return Ok(None);
            }
            pos.col = pos
                .col
                .saturating_add(((pos.row - line.first) as u32).saturating_mul(self.cols));
            pos.row = line.first;
        }
        let text = if self.fold_case {
            line.lower.get_or_init(|| line.text.to_lower_case()).clone()
        } else {
            line.text.clone()
        };
        let offset = line
            .cells
            .iter()
            .take_while(|&&cell| cell & !CELL_WIDE < pos.col)
            .count() as u32;
        let (index, len) = match &self.regex {
            Some(regex) => {
                let mut found = (-1, 0);
                if reverse {
                    // The last match in 0..offset.
                    let head = text.slice(0, offset);
                    regex.set_last_index(0);
                    loop {
                        let m = regex.exec(&head)?;
                        if m.is_null() {
                            break;
                        }
                        let n = matched_len(&m);
                        let end = regex.last_index();
                        found = (end.saturating_sub(n) as i64, n);
                        regex.set_last_index((end + 1).saturating_sub(n));
                    }
                } else {
                    regex.set_last_index(0);
                    let m = regex.exec(&text.slice(offset, text.length()))?;
                    let n = matched_len(&m);
                    if n > 0 {
                        found = ((offset + regex.last_index() - n) as i64, n);
                    }
                }
                found
            }
            None => {
                let n = self.needle.length();
                let index = if !reverse {
                    text.unchecked_ref::<Text>()
                        .index_of(&self.needle, offset as i32)
                } else if offset >= n {
                    text.unchecked_ref::<Text>()
                        .last_index_of(&self.needle, (offset - n) as i32)
                } else {
                    -1
                };
                (index as i64, self.term.length())
            }
        };
        if index < 0 {
            return Ok(None);
        }
        let index = index as usize;
        if self.whole_word && !is_whole_word(&text, index as u32, len) {
            return Ok(None);
        }
        let Some(&start) = line.cells.get(index) else {
            return Ok(None);
        };
        let start = start & !CELL_WIDE;
        let end = match (index + len as usize).checked_sub(1) {
            Some(last) if len > 0 => {
                let cell = line
                    .cells
                    .get(last)
                    .or(line.cells.last())
                    .copied()
                    .unwrap_or(start);
                (cell & !CELL_WIDE) + if cell & CELL_WIDE != 0 { 2 } else { 1 }
            }
            _ => start,
        };
        Ok(Some(Found {
            row: line.first + (start / self.cols) as i32,
            col: start % self.cols,
            size: end.saturating_sub(start),
        }))
    }
}

/// Length of `exec`'s whole match, 0 for no match.
fn matched_len(m: &JsValue) -> u32 {
    if !Array::is_array(m) {
        return 0;
    }
    Array::from(m)
        .get(0)
        .dyn_into::<JsString>()
        .map_or(0, |s| s.length())
}

/// `_isWholeWord`: a non-word character or the line end on both sides.
fn is_whole_word(text: &JsString, at: u32, len: u32) -> bool {
    let non_word = |i: u32| {
        let unit = text.char_code_at(i);
        unit < 128.0 && NON_WORD.contains(&(unit as u8))
    };
    (at == 0 || non_word(at - 1)) && (at + len == text.length() || non_word(at + len))
}

/// The `onWriteParsed`/`onResize` and `onScroll` subscriptions of a loaded addon, removed when dropped.
struct Listeners {
    subscriptions: Vec<Disposable>,
    _closures: [Closure<dyn FnMut()>; 2],
}

impl Drop for Listeners {
    fn drop(&mut self) {
        for subscription in &self.subscriptions {
            subscription.dispose();
        }
    }
}

#[derive(Default)]
struct Inner {
    terminal: Weak<Shared>,
    listeners: Option<Listeners>,
    update: Option<timer::Timeout>,
    cached_term: Option<JsString>,
    last_options: Option<SearchOptions>,
    /// The matches `_highlightAllMatches` found (SearchResultTracker).
    results: Vec<Hit>,
    /// The active match (the selected decoration).
    active: Option<Hit>,
    colors: Option<Decorations>,
    /// The renderer was last given something to draw.
    painted: bool,
}

struct SearchState {
    id: u32,
    highlight_limit: u32,
    inner: RefCell<Inner>,
    before_search: Rc<Emitter>,
    after_search: Rc<Emitter>,
    did_change_results: Rc<Emitter>,
}

thread_local! {
    /// For `loadAddon`, which gets the JS object: the addon is found by the id it carries.
    static ADDONS: RefCell<Vec<Weak<SearchState>>> = const { RefCell::new(Vec::new()) };
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
}

/// `loadAddon` for the built-in `SearchAddon`: activates it on the terminal and returns true, or false for any
/// other addon.
pub fn load(terminal: &Terminal, addon: &JsValue) -> bool {
    let Some(id) = get(addon, "__oxttySearchAddon").as_f64() else {
        return false;
    };
    let state = ADDONS.with(|a| {
        a.borrow()
            .iter()
            .filter_map(Weak::upgrade)
            .find(|s| f64::from(s.id) == id)
    });
    match state {
        Some(state) => {
            state.activate(&terminal.shared);
            true
        }
        None => false,
    }
}

impl SearchState {
    fn terminal(&self) -> Option<Rc<Shared>> {
        self.inner.borrow().terminal.upgrade()
    }

    /// `activate`: follows output and resizes (to search again) and scrolling (to repaint).
    fn activate(self: &Rc<Self>, shared: &Rc<Shared>) {
        let weak = Rc::downgrade(self);
        let on_change = Closure::<dyn FnMut()>::new(move || {
            if let Some(state) = weak.upgrade() {
                state.update_matches();
                state.paint();
            }
        });
        let weak = Rc::downgrade(self);
        let on_scroll = Closure::<dyn FnMut()>::new(move || {
            if let Some(state) = weak.upgrade() {
                state.paint();
            }
        });
        let change: &Function = on_change.as_ref().unchecked_ref();
        let scroll: &Function = on_scroll.as_ref().unchecked_ref();
        let e = &shared.events;
        let listeners = Listeners {
            subscriptions: vec![
                e.write_parsed.event(change.clone()),
                e.resize.event(change.clone()),
                e.scroll.event(scroll.clone()),
            ],
            _closures: [on_change, on_scroll],
        };
        let old = {
            let mut inner = self.inner.borrow_mut();
            inner.terminal = Rc::downgrade(shared);
            inner.listeners.replace(listeners)
        };
        drop(old);
    }

    /// `_updateMatches`: with decorations, searches the cached term again shortly after output or a resize.
    fn update_matches(self: &Rc<Self>) {
        let mut inner = self.inner.borrow_mut();
        inner.update = None;
        let decorated = inner
            .last_options
            .as_ref()
            .is_some_and(|o| o.decorations.is_some());
        if inner.cached_term.is_none() || !decorated {
            return;
        }
        let weak = Rc::downgrade(self);
        inner.update = Some(timer::Timeout::new(UPDATE_DELAY_MS, move || {
            let Some(state) = weak.upgrade() else {
                return;
            };
            let (term, options) = {
                let mut inner = state.inner.borrow_mut();
                inner.update = None;
                (inner.cached_term.take(), inner.last_options.clone())
            };
            if let Some(term) = term {
                if let Err(error) = state.search(term.into(), options, false, true) {
                    web_sys::console::error_1(&error);
                }
            }
        }));
    }

    fn clear_decorations(&self, retain_cached_term: bool) {
        let mut inner = self.inner.borrow_mut();
        inner.active = None;
        inner.results.clear();
        if !retain_cached_term {
            inner.cached_term = None;
        }
    }

    /// `findNext` (`forward`) or `findPrevious`.
    fn search(
        self: &Rc<Self>,
        term: JsValue,
        options: Option<SearchOptions>,
        forward: bool,
        no_scroll: bool,
    ) -> Result<bool, JsValue> {
        let Some(shared) = self.terminal() else {
            return Err(js_sys::Error::new("Cannot use addon until it has been loaded").into());
        };
        self.before_search.fire(&[]);
        let term: JsString = term.dyn_into().unwrap_or_else(|_| JsString::from(""));
        let decorations = options.as_ref().and_then(|o| o.decorations.clone());
        let highlight = {
            let mut inner = self.inner.borrow_mut();
            inner.last_options = options.clone();
            decorations.is_some() && inner.cached_term.as_ref() != Some(&term)
        };
        let options = options.unwrap_or_default();
        if highlight {
            self.highlight_all(&shared, &term, &options)?;
        }
        let (found, scroll) = self.find_and_select(&shared, &term, &options, forward, no_scroll)?;
        if let Some(amount) = scroll {
            let _ = Terminal {
                shared: shared.clone(),
            }
            .scroll_lines(amount);
        }
        if decorations.is_some() {
            let (index, count) = {
                let inner = self.inner.borrow();
                let index = inner
                    .active
                    .and_then(|a| inner.results.iter().position(|&r| r == a))
                    .map_or(-1, |i| i as i32);
                (index, inner.results.len() as u32)
            };
            let event = Object::new();
            let _ = Reflect::set(&event, &"resultIndex".into(), &index.into());
            let _ = Reflect::set(&event, &"resultCount".into(), &count.into());
            self.did_change_results.fire(&[&event.into()]);
        }
        self.inner.borrow_mut().cached_term = Some(term);
        self.after_search.fire(&[]);
        self.paint();
        Ok(found)
    }

    /// `_highlightAllMatches`.
    fn highlight_all(
        &self,
        shared: &Rc<Shared>,
        term: &JsString,
        options: &SearchOptions,
    ) -> Result<(), JsValue> {
        if term.length() == 0 {
            self.clear_decorations(false);
            return Ok(());
        }
        self.clear_decorations(true);
        let (results, trimmed) = {
            let core = shared.core.borrow();
            if core.disposed {
                return Ok(());
            }
            let engine = core.view.engine();
            let results = Search::new(engine, term, options)?.find_all(self.highlight_limit)?;
            (results, engine.trimmed_lines())
        };
        let mut inner = self.inner.borrow_mut();
        inner.results = results.into_iter().map(|f| Hit::new(f, trimmed)).collect();
        if options.decorations.is_some() {
            inner.colors = options.decorations.clone();
        }
        Ok(())
    }

    /// `_findNextAndSelect`/`_findPreviousAndSelect` and `_selectResult`: whether a match was selected, and the
    /// lines to scroll to bring it into view.
    fn find_and_select(
        &self,
        shared: &Rc<Shared>,
        term: &JsString,
        options: &SearchOptions,
        forward: bool,
        no_scroll: bool,
    ) -> Result<(bool, Option<i32>), JsValue> {
        let terminal = Terminal {
            shared: shared.clone(),
        };
        if term.length() == 0 {
            terminal.clear_selection();
            self.clear_decorations(false);
            return Ok((false, None));
        }
        // `findNextWithSelection`/`findPreviousWithSelection` read the selection, then clear it.
        let selection = SelectionPosition::of(shared);
        terminal.clear_selection();
        let (found, trimmed, rows, viewport_y) = {
            let core = shared.core.borrow();
            if core.disposed {
                return Ok((false, None));
            }
            let engine = core.view.engine();
            let same_term = self.inner.borrow().cached_term.as_ref() == Some(term);
            let mut search = Search::new(engine, term, options)?;
            let found = if forward {
                search.find_next(selection, same_term)?
            } else {
                search.find_previous(selection, same_term)?
            };
            let viewport_y = engine.history_length() as i32 - engine.display_offset() as i32;
            (
                found,
                engine.trimmed_lines(),
                engine.rows() as i32,
                viewport_y,
            )
        };
        // `_selectResult`
        self.inner.borrow_mut().active = None;
        let Some(found) = found else {
            terminal.clear_selection();
            return Ok((false, None));
        };
        terminal.select(found.col.into(), found.row.into(), found.size.into());
        if options.decorations.is_some() {
            let mut inner = self.inner.borrow_mut();
            inner.active = Some(Hit::new(found, trimmed));
            inner.colors = options.decorations.clone();
        }
        let scroll = (!no_scroll && (found.row >= viewport_y + rows || found.row < viewport_y))
            .then(|| found.row - viewport_y - rows / 2);
        Ok((true, scroll))
    }

    /// Hands the decorations in view to the renderer.
    fn paint(&self) {
        let Some(shared) = self.terminal() else {
            return;
        };
        let Ok(mut inner) = self.inner.try_borrow_mut() else {
            return;
        };
        let Ok(mut core) = shared.core.try_borrow_mut() else {
            return;
        };
        if core.disposed || core.renderer.is_none() {
            return;
        }
        let engine = core.view.engine();
        let (cols, rows, trimmed) = (engine.cols(), engine.rows(), engine.trimmed_lines());
        let viewport_y = f64::from(engine.history_length()) - f64::from(engine.display_offset());
        let mut highlights = Vec::new();
        if let Some(colors) = &inner.colors {
            let mut add = |hit: Hit, background: &Option<String>, border: &Option<String>| {
                if background.is_none() && border.is_none() {
                    return;
                }
                // A match that wraps gets one highlight per row (DecorationManager._createResultDecorations).
                let (mut col, mut left) = (hit.col, hit.size);
                let mut y = hit.row - trimmed - viewport_y;
                while left > 0 && col < cols && y < f64::from(rows) {
                    let n = left.min(cols - col);
                    if y >= 0.0 {
                        highlights.push(Highlight {
                            row: y as u32,
                            start: col,
                            end: col + n,
                            background: background.clone(),
                            border: border.clone(),
                            ..Highlight::default()
                        });
                    }
                    col = 0;
                    left -= n;
                    y += 1.0;
                }
            };
            for &hit in &inner.results {
                add(hit, &colors.match_background, &colors.match_border);
            }
            if let Some(hit) = inner.active {
                add(
                    hit,
                    &colors.active_match_background,
                    &colors.active_match_border,
                );
            }
        }
        let painted = !highlights.is_empty();
        if !painted && !inner.painted {
            return;
        }
        inner.painted = painted;
        let renderer = core.renderer.as_mut().unwrap();
        renderer.set_highlights("search", highlights);
        drop(core);
        drop(inner);
        shared.schedule_frame();
    }
}

/// xterm.js `@xterm/addon-search`, built in: load it with `terminal.loadAddon(new SearchAddon())`.
#[wasm_bindgen]
pub struct SearchAddon {
    state: Rc<SearchState>,
}

#[wasm_bindgen]
impl SearchAddon {
    #[wasm_bindgen(constructor)]
    pub fn new(
        #[wasm_bindgen(unchecked_optional_param_type = "Partial<ISearchAddonOptions>")]
        options: Option<Object>,
    ) -> SearchAddon {
        let limit = options
            .map(|o| get(&o, "highlightLimit"))
            .filter(|v| !v.is_undefined() && !v.is_null())
            .map_or(f64::from(DEFAULT_HIGHLIGHT_LIMIT), |v| {
                v.as_f64().unwrap_or(f64::NAN)
            });
        // `results.length >= limit` never holds for NaN.
        let highlight_limit = if limit.is_nan() {
            u32::MAX
        } else {
            limit.ceil().clamp(0.0, f64::from(u32::MAX)) as u32
        };
        let state = Rc::new(SearchState {
            id: NEXT_ID.with(|n| n.replace(n.get().wrapping_add(1))),
            highlight_limit,
            inner: RefCell::default(),
            before_search: Rc::default(),
            after_search: Rc::default(),
            did_change_results: Rc::default(),
        });
        ADDONS.with(|a| a.borrow_mut().push(Rc::downgrade(&state)));
        SearchAddon { state }
    }

    /// `terminal.loadAddon(searchAddon)` calls this.
    pub fn activate(&self, terminal: &Terminal) {
        self.state.activate(&terminal.shared);
    }

    /// Stops following the terminal and clears the decorations; searching still works, like the addon.
    pub fn dispose(&self) {
        let (listeners, update) = {
            let mut inner = self.state.inner.borrow_mut();
            (inner.listeners.take(), inner.update.take())
        };
        drop((listeners, update));
        self.state.clear_decorations(false);
        self.state.paint();
        for emitter in [
            &self.state.before_search,
            &self.state.after_search,
            &self.state.did_change_results,
        ] {
            emitter.clear();
        }
    }

    /// Selects the next match after the selection (from the top without one), wrapping around, and scrolls it into
    /// view. False when there is none; a bad regular expression throws.
    #[wasm_bindgen(js_name = findNext)]
    pub fn find_next(
        &self,
        #[wasm_bindgen(unchecked_param_type = "string")] term: JsValue,
        #[wasm_bindgen(js_name = searchOptions, unchecked_optional_param_type = "ISearchOptions")]
        search_options: JsValue,
    ) -> Result<bool, JsValue> {
        self.state
            .search(term, SearchOptions::parse(&search_options), true, false)
    }

    /// Like `findNext`, backwards from the selection (from the bottom without one).
    #[wasm_bindgen(js_name = findPrevious)]
    pub fn find_previous(
        &self,
        #[wasm_bindgen(unchecked_param_type = "string")] term: JsValue,
        #[wasm_bindgen(js_name = searchOptions, unchecked_optional_param_type = "ISearchOptions")]
        search_options: JsValue,
    ) -> Result<bool, JsValue> {
        self.state
            .search(term, SearchOptions::parse(&search_options), false, false)
    }

    /// Clears the decorations and forgets the term, so the next search starts over from the selection start.
    #[wasm_bindgen(js_name = clearDecorations)]
    pub fn clear_decorations(&self) {
        self.state.clear_decorations(false);
        self.state.paint();
    }

    /// Clears the active match's decoration (meant for the search box's `blur`).
    #[wasm_bindgen(js_name = clearActiveDecoration)]
    pub fn clear_active_decoration(&self) {
        self.state.inner.borrow_mut().active = None;
        self.state.paint();
    }

    #[wasm_bindgen(getter = onBeforeSearch, unchecked_return_type = "IEvent<void>")]
    pub fn on_before_search(&self) -> Function {
        events::emitter_event(&self.state.before_search)
    }

    #[wasm_bindgen(getter = onAfterSearch, unchecked_return_type = "IEvent<void>")]
    pub fn on_after_search(&self) -> Function {
        events::emitter_event(&self.state.after_search)
    }

    /// With decorations: the active match's index among all matches (-1 if none or past `highlightLimit`) and their
    /// count, after each search.
    #[wasm_bindgen(
        getter = onDidChangeResults,
        unchecked_return_type = "IEvent<ISearchResultChangeEvent>"
    )]
    pub fn on_did_change_results(&self) -> Function {
        events::emitter_event(&self.state.did_change_results)
    }

    /// Internal: marks the built-in addon for `loadAddon`.
    #[wasm_bindgen(getter, js_name = __oxttySearchAddon, skip_typescript)]
    pub fn marker(&self) -> u32 {
        self.state.id
    }
}

impl Drop for SearchAddon {
    fn drop(&mut self) {
        let state = Rc::downgrade(&self.state);
        ADDONS.with(|a| {
            if let Ok(mut a) = a.try_borrow_mut() {
                a.retain(|w| w.strong_count() > 0 && !Weak::ptr_eq(w, &state));
            }
        });
    }
}
