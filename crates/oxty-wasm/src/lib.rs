//! Plain C-ABI exports for `wasm32-unknown-unknown` (no wasm-bindgen).
//!
//! Terminals are addressed by integer handles (0 = invalid). Variable-length
//! results are left in shared output buffers; the call returns their length
//! and the host reads them through `oxty_out_ptr` / `oxty_out32_ptr` before
//! the next call. The JavaScript wrapper in `packages/oxty` does all of this.

use std::cell::RefCell;

use oxty::{Damage, Engine};

thread_local! {
    static TERMS: RefCell<Vec<Option<Box<Engine>>>> = const { RefCell::new(Vec::new()) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUT32: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
}

fn with<R>(h: u32, default: R, f: impl FnOnce(&mut Engine) -> R) -> R {
    TERMS.with_borrow_mut(|terms| {
        match h
            .checked_sub(1)
            .and_then(|i| terms.get_mut(i as usize))
            .and_then(Option::as_mut)
        {
            Some(engine) => f(engine),
            None => default,
        }
    })
}

fn set_out(bytes: Vec<u8>) -> u32 {
    OUT.with_borrow_mut(|out| {
        *out = bytes;
        out.len() as u32
    })
}

/// ABI version of these exports; bump on any incompatible change.
#[no_mangle]
pub extern "C" fn oxty_abi() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn oxty_alloc(len: u32) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len as usize);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from `oxty_alloc` and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn oxty_free(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, 0, len as usize));
    }
}

#[no_mangle]
pub extern "C" fn oxty_out_ptr() -> *const u8 {
    OUT.with_borrow(|out| out.as_ptr())
}

#[no_mangle]
pub extern "C" fn oxty_out32_ptr() -> *const u32 {
    OUT32.with_borrow(|out| out.as_ptr())
}

#[no_mangle]
pub extern "C" fn oxty_new(cols: u32, rows: u32, scrollback: u32) -> u32 {
    let engine = Box::new(Engine::new(
        cols.min(u16::MAX as u32) as u16,
        rows.min(u16::MAX as u32) as u16,
        scrollback as usize,
    ));
    TERMS.with_borrow_mut(|terms| {
        if let Some(i) = terms.iter().position(Option::is_none) {
            terms[i] = Some(engine);
            i as u32 + 1
        } else {
            terms.push(Some(engine));
            terms.len() as u32
        }
    })
}

#[no_mangle]
pub extern "C" fn oxty_drop(h: u32) {
    TERMS.with_borrow_mut(|terms| {
        if let Some(slot) = h.checked_sub(1).and_then(|i| terms.get_mut(i as usize)) {
            *slot = None;
        }
    });
}

/// # Safety
/// `ptr` must point to `len` readable bytes in linear memory.
#[no_mangle]
pub unsafe extern "C" fn oxty_feed(h: u32, ptr: *const u8, len: u32) {
    let bytes = std::slice::from_raw_parts(ptr, len as usize);
    with(h, (), |t| t.feed(bytes));
}

#[no_mangle]
pub extern "C" fn oxty_resize(h: u32, cols: u32, rows: u32) {
    with(h, (), |t| {
        t.resize(
            cols.min(u16::MAX as u32) as u16,
            rows.min(u16::MAX as u32) as u16,
        )
    });
}

#[no_mangle]
pub extern "C" fn oxty_cols(h: u32) -> u32 {
    with(h, 0, |t| t.cols() as u32)
}

#[no_mangle]
pub extern "C" fn oxty_rows(h: u32) -> u32 {
    with(h, 0, |t| t.rows() as u32)
}

#[no_mangle]
pub extern "C" fn oxty_history_len(h: u32) -> u32 {
    with(h, 0, |t| t.history_len() as u32)
}

/// UTF-8 row text into OUT; returns its length, or -1 if out of range.
#[no_mangle]
pub extern "C" fn oxty_row_text(h: u32, line: i32) -> i32 {
    with(h, -1, |t| {
        t.row_text(line)
            .map_or(-1, |s| set_out(s.into_bytes()) as i32)
    })
}

/// `[ch, fg, bg, attrs]` × cols into OUT32; returns the cell count, or -1.
#[no_mangle]
pub extern "C" fn oxty_row_cells(h: u32, line: i32) -> i32 {
    with(h, -1, |t| {
        OUT32.with_borrow_mut(|out| {
            if t.row_packed(line, out) {
                (out.len() / 4) as i32
            } else {
                -1
            }
        })
    })
}

#[no_mangle]
pub extern "C" fn oxty_row_wrapped(h: u32, line: i32) -> u32 {
    with(h, 0, |t| t.row_wrapped(line) as u32)
}

/// UTF-8 text of one cell (with combining marks) into OUT; -1 if out of range.
#[no_mangle]
pub extern "C" fn oxty_cell_text(h: u32, line: i32, col: u32) -> i32 {
    with(h, -1, |t| {
        t.cell_text(line, col.min(u16::MAX as u32) as u16)
            .map_or(-1, |s| set_out(s.into_bytes()) as i32)
    })
}

/// `line << 16 | col`, with bit 31 set when the cursor is visible.
#[no_mangle]
pub extern "C" fn oxty_cursor(h: u32) -> u32 {
    with(h, 0, |t| {
        let c = t.cursor();
        (c.visible as u32) << 31 | (c.line as u32) << 16 | c.col as u32
    })
}

#[no_mangle]
pub extern "C" fn oxty_modes(h: u32) -> u32 {
    with(h, 0, |t| t.modes())
}

/// -1 = full redraw; otherwise the number of changed lines, listed in OUT32.
#[no_mangle]
pub extern "C" fn oxty_take_damage(h: u32) -> i32 {
    with(h, -1, |t| match t.take_damage() {
        Damage::Full => -1,
        Damage::Lines(lines) => OUT32.with_borrow_mut(|out| {
            out.clear();
            out.extend(lines.into_iter().map(u32::from));
            out.len() as i32
        }),
    })
}

/// Reply bytes for the PTY into OUT; returns their length.
#[no_mangle]
pub extern "C" fn oxty_take_replies(h: u32) -> u32 {
    with(h, 0, |t| set_out(t.take_replies()))
}

/// New title into OUT and its length, or -1 if unchanged.
#[no_mangle]
pub extern "C" fn oxty_take_title(h: u32) -> i32 {
    with(h, -1, |t| {
        t.take_title()
            .map_or(-1, |s| set_out(s.into_bytes()) as i32)
    })
}

#[no_mangle]
pub extern "C" fn oxty_take_bells(h: u32) -> u32 {
    with(h, 0, |t| t.take_bells())
}

#[no_mangle]
pub extern "C" fn oxty_sync_pending(h: u32) -> u32 {
    with(h, 0, |t| t.sync_pending() as u32)
}

#[no_mangle]
pub extern "C" fn oxty_flush_sync(h: u32) {
    with(h, (), |t| t.flush_sync());
}
