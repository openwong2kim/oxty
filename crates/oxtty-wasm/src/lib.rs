//! Plain C-ABI exports for `wasm32-unknown-unknown` (no wasm-bindgen).
//!
//! Terminals are addressed by integer handles (0 = invalid). Variable-length
//! results are left in shared output buffers; the call returns their length
//! and the host reads them through `oxtty_out_ptr` / `oxtty_out32_ptr` before
//! the next call. The JavaScript wrapper in `packages/oxtty` does all of this.

use std::cell::RefCell;

use oxtty::{CursorShape, Damage, Engine};

/// The same dlmalloc std uses on wasm, but growing linear memory in larger
/// steps: at 64 KiB per `memory.grow`, filling a scrollback calls it thousands
/// of times and that dominated `malloc`. Untouched pages cost no RSS.
#[cfg(target_arch = "wasm32")]
mod alloc {
    use std::alloc::{GlobalAlloc, Layout};
    use std::arch::wasm32::memory_grow;
    use std::cell::UnsafeCell;

    use dlmalloc::{Allocator, Dlmalloc};

    const PAGE: usize = 64 << 10;
    const GROW_STEP: usize = 4 << 20;

    struct Stepped;

    // dlmalloc의 wasm System과 같고, 늘리는 크기만 GROW_STEP 이상으로 올린다
    unsafe impl Allocator for Stepped {
        fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
            let pages = size.max(GROW_STEP).div_ceil(PAGE);
            match memory_grow(0, pages) {
                usize::MAX => (std::ptr::null_mut(), 0, 0),
                prev => ((prev * PAGE) as *mut u8, pages * PAGE, 0),
            }
        }
        fn remap(&self, _: *mut u8, _: usize, _: usize, _: bool) -> *mut u8 {
            std::ptr::null_mut()
        }
        fn free_part(&self, _: *mut u8, _: usize, _: usize) -> bool {
            false
        }
        fn free(&self, _: *mut u8, _: usize) -> bool {
            false
        }
        fn can_release_part(&self, _: u32) -> bool {
            false
        }
        fn allocates_zeros(&self) -> bool {
            true
        }
        fn page_size(&self) -> usize {
            PAGE
        }
    }

    struct Global(UnsafeCell<Dlmalloc<Stepped>>);

    // wasm32-unknown-unknown(atomics 없음)은 스레드가 하나뿐이다
    unsafe impl Sync for Global {}

    unsafe impl GlobalAlloc for Global {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            (*self.0.get()).malloc(l.size(), l.align())
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            (*self.0.get()).calloc(l.size(), l.align())
        }
        unsafe fn dealloc(&self, ptr: *mut u8, l: Layout) {
            (*self.0.get()).free(ptr, l.size(), l.align())
        }
        unsafe fn realloc(&self, ptr: *mut u8, l: Layout, new: usize) -> *mut u8 {
            (*self.0.get()).realloc(ptr, l.size(), l.align(), new)
        }
    }

    #[global_allocator]
    static GLOBAL: Global = Global(UnsafeCell::new(Dlmalloc::new_with_allocator(Stepped)));
}

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
pub extern "C" fn oxtty_abi() -> u32 {
    3
}

#[no_mangle]
pub extern "C" fn oxtty_alloc(len: u32) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len as usize);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from `oxtty_alloc` and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn oxtty_free(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, 0, len as usize));
    }
}

#[no_mangle]
pub extern "C" fn oxtty_out_ptr() -> *const u8 {
    OUT.with_borrow(|out| out.as_ptr())
}

/// Byte length of OUT, for results that return a count instead.
#[no_mangle]
pub extern "C" fn oxtty_out_len() -> u32 {
    OUT.with_borrow(|out| out.len() as u32)
}

#[no_mangle]
pub extern "C" fn oxtty_out32_ptr() -> *const u32 {
    OUT32.with_borrow(|out| out.as_ptr())
}

#[no_mangle]
pub extern "C" fn oxtty_new(cols: u32, rows: u32, scrollback: u32) -> u32 {
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
pub extern "C" fn oxtty_drop(h: u32) {
    TERMS.with_borrow_mut(|terms| {
        if let Some(slot) = h.checked_sub(1).and_then(|i| terms.get_mut(i as usize)) {
            *slot = None;
        }
    });
}

/// # Safety
/// `ptr` must point to `len` readable bytes in linear memory.
#[no_mangle]
pub unsafe extern "C" fn oxtty_feed(h: u32, ptr: *const u8, len: u32) {
    let bytes = std::slice::from_raw_parts(ptr, len as usize);
    with(h, (), |t| t.feed(bytes));
}

#[no_mangle]
pub extern "C" fn oxtty_resize(h: u32, cols: u32, rows: u32) {
    with(h, (), |t| {
        t.resize(
            cols.min(u16::MAX as u32) as u16,
            rows.min(u16::MAX as u32) as u16,
        )
    });
}

#[no_mangle]
pub extern "C" fn oxtty_cols(h: u32) -> u32 {
    with(h, 0, |t| t.cols() as u32)
}

#[no_mangle]
pub extern "C" fn oxtty_rows(h: u32) -> u32 {
    with(h, 0, |t| t.rows() as u32)
}

#[no_mangle]
pub extern "C" fn oxtty_history_len(h: u32) -> u32 {
    with(h, 0, |t| t.history_len() as u32)
}

/// UTF-8 row text into OUT; returns its length, or -1 if out of range.
#[no_mangle]
pub extern "C" fn oxtty_row_text(h: u32, line: i32) -> i32 {
    with(h, -1, |t| {
        t.row_text(line)
            .map_or(-1, |s| set_out(s.into_bytes()) as i32)
    })
}

/// `[ch, fg, bg, attrs]` × cols into OUT32; returns the cell count, or -1.
#[no_mangle]
pub extern "C" fn oxtty_row_cells(h: u32, line: i32) -> i32 {
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
pub extern "C" fn oxtty_row_wrapped(h: u32, line: i32) -> u32 {
    with(h, 0, |t| t.row_wrapped(line) as u32)
}

/// UTF-8 text of one cell (with combining marks) into OUT; -1 if out of range.
#[no_mangle]
pub extern "C" fn oxtty_cell_text(h: u32, line: i32, col: u32) -> i32 {
    with(h, -1, |t| {
        t.cell_text(line, col.min(u16::MAX as u32) as u16)
            .map_or(-1, |s| set_out(s.into_bytes()) as i32)
    })
}

/// `line << 16 | col`, with bit 31 set when the cursor is visible.
#[no_mangle]
pub extern "C" fn oxtty_cursor(h: u32) -> u32 {
    with(h, 0, |t| {
        let c = t.cursor();
        (c.visible as u32) << 31 | (c.line as u32) << 16 | c.col as u32
    })
}

/// Cursor shape (0 block, 1 underline, 2 bar), with bit 8 set when blinking.
#[no_mangle]
pub extern "C" fn oxtty_cursor_style(h: u32) -> u32 {
    with(h, 0, |t| {
        let c = t.cursor();
        let shape = match c.shape {
            CursorShape::Block => 0,
            CursorShape::Underline => 1,
            CursorShape::Bar => 2,
        };
        (c.blinking as u32) << 8 | shape
    })
}

#[no_mangle]
pub extern "C" fn oxtty_display_offset(h: u32) -> u32 {
    with(h, 0, |t| t.display_offset() as u32)
}

#[no_mangle]
pub extern "C" fn oxtty_scroll_display(h: u32, delta: i32) {
    with(h, (), |t| t.scroll_display(delta));
}

#[no_mangle]
pub extern "C" fn oxtty_scroll_to_bottom(h: u32) {
    with(h, (), |t| t.scroll_to_bottom());
}

/// Cells with combining marks, an underline colour or a hyperlink; returns
/// their count, or -1 if out of range. OUT32 holds `[col, underline colour
/// (0 = none), text byte length (0 = none), link (0 = none, else 1-based
/// index)]` per cell. OUT holds the texts in order, then each link of the row
/// as `id \0 uri \0`.
#[no_mangle]
pub extern "C" fn oxtty_row_extras(h: u32, line: i32) -> i32 {
    with(h, -1, |t| {
        let mut extras = Vec::new();
        if !t.row_extras(line, &mut extras) {
            return -1;
        }
        let mut bytes = Vec::new();
        let mut links: Vec<&oxtty::Hyperlink> = Vec::new();
        let mut words = Vec::with_capacity(extras.len() * 4);
        for e in &extras {
            let text = e.text.as_deref().unwrap_or("");
            bytes.extend_from_slice(text.as_bytes());
            let link =
                e.hyperlink
                    .as_ref()
                    .map_or(0, |l| match links.iter().position(|x| *x == l) {
                        Some(i) => i + 1,
                        None => {
                            links.push(l);
                            links.len()
                        }
                    });
            words.extend([
                e.col as u32,
                e.underline_color.unwrap_or(0),
                text.len() as u32,
                link as u32,
            ]);
        }
        for l in links {
            bytes.extend_from_slice(l.id.as_bytes());
            bytes.push(0);
            bytes.extend_from_slice(l.uri.as_bytes());
            bytes.push(0);
        }
        set_out(bytes);
        OUT32.with_borrow_mut(|out| *out = words);
        extras.len() as i32
    })
}

#[no_mangle]
pub extern "C" fn oxtty_modes(h: u32) -> u32 {
    with(h, 0, |t| t.modes())
}

/// -1 = full redraw; otherwise the number of changed lines. OUT32 holds the
/// rows to scroll up first, then the changed lines.
#[no_mangle]
pub extern "C" fn oxtty_take_damage(h: u32) -> i32 {
    with(h, -1, |t| match t.take_damage() {
        Damage::Full => -1,
        Damage::Lines { scroll, lines } => OUT32.with_borrow_mut(|out| {
            out.clear();
            out.push(scroll.into());
            out.extend(lines.into_iter().map(u32::from));
            out.len() as i32 - 1
        }),
    })
}

/// Reply bytes for the PTY into OUT; returns their length.
#[no_mangle]
pub extern "C" fn oxtty_take_replies(h: u32) -> u32 {
    with(h, 0, |t| set_out(t.take_replies()))
}

/// New title into OUT and its length, or -1 if unchanged.
#[no_mangle]
pub extern "C" fn oxtty_take_title(h: u32) -> i32 {
    with(h, -1, |t| {
        t.take_title()
            .map_or(-1, |s| set_out(s.into_bytes()) as i32)
    })
}

#[no_mangle]
pub extern "C" fn oxtty_take_bells(h: u32) -> u32 {
    with(h, 0, |t| t.take_bells())
}

#[no_mangle]
pub extern "C" fn oxtty_sync_pending(h: u32) -> u32 {
    with(h, 0, |t| t.sync_pending() as u32)
}

#[no_mangle]
pub extern "C" fn oxtty_flush_sync(h: u32) {
    with(h, (), |t| t.flush_sync());
}

/// ANSI snapshot bytes into OUT and their length; on refusal the reason
/// (`SnapshotRefusal::as_str`) into OUT and minus its length. A payload is
/// never empty, so 0 means a bad handle.
#[no_mangle]
pub extern "C" fn oxtty_ansi_snapshot(h: u32) -> i32 {
    with(h, 0, |t| match t.ansi_snapshot() {
        Ok(bytes) => set_out(bytes) as i32,
        Err(why) => -(set_out(why.as_str().as_bytes().to_vec()) as i32),
    })
}
