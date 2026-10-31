# Built-in Alacritty fork

Source: the published `alacritty_terminal` 0.26.0 crate from crates.io
(Apache-2.0, `../../LICENSE-APACHE`). The upstream README is kept as
`UPSTREAM-README.md`. The fork started in wmux (`core/wmux-term/vendor`) and is
built into the `oxty` crate as the `oxty::vt` module, so `oxty` publishes as a
single crate.

## Local changes

- `wmux_unicode11.rs` is generated from the xterm.js Unicode 11 provider by
  wmux's `scripts/generate-rust-unicode11.mjs`. Its header records the source
  hash. The xterm.js MIT license is included as `../../LICENSE-XTERM`.
  Regenerate deliberately after a provider update.
- `mod.rs` registers that module; `term/mod.rs` uses its width lookup for
  character input and exposes read-only `inactive_grid()` and
  `scroll_region()` for snapshot replay.
- Cursor-paragraph resize (xterm.js `reflowCursorLine: false`) is an option:
  `term::Config::reflow_cursor_line` (default `true`, upstream behaviour) sets
  `Grid::set_keep_cursor_paragraph`. When kept, `grid/resize.rs` leaves the
  cursor paragraph without reflow, reflows other paragraphs as upstream, and on
  shrink clamps the cursor and clears pending wrap. Clipped fullwidth cells are
  retained to match xterm. Rows added by a shrink follow xterm.js
  `_reflowSmaller`: while history is empty and the cursor is above the bottom
  row, each added row drops the bottom row and moves the cursor down; the rest
  go to history with the cursor row unchanged, even when the reflowed paragraph
  is below the cursor. `oxty::Engine` sets `reflow_cursor_line: false`.
- Scroll damage is an option: `term::Config::scroll_damage` (default `false`,
  upstream full damage on every scroll). When on, a whole-screen scroll at the
  bottom of history moves line damage with the content, damages the new
  bottom lines, moves the last cursor point along, and counts the rows in
  `Term::damage_scrolled()`. Region scrolls, a scrolled-back view, or scrolling
  a full screen height still give full damage. `oxty::Engine` turns it on.
- RIS keeping the cursor hidden is an option:
  `term::Config::ris_keeps_cursor_visibility` (default `false`, upstream: RIS
  shows the cursor again). When on, `reset_state` restores DECTCEM
  (`TermMode::SHOW_CURSOR`) after resetting the modes, as xterm.js does.
  `oxty::Engine` turns it on.
- ED2 scrolling into history is an option:
  `term::Config::scroll_on_erase_in_display` (default `true`, upstream: on the
  primary screen `CSI 2 J` pushes the screen into history through
  `Grid::clear_viewport`). When off, `clear_screen` resets the screen in place
  as on the alternate screen, like xterm.js `scrollOnEraseInDisplay: false`.
  `oxty::Engine` turns it off.
- `term/mod.rs` handles the xterm private modes 47, 1047 and 1048, which the
  `vte` table reports as `PrivateMode::Unknown` and upstream ignores. 47/1047
  switch screens through `swap_alt` like 1049 but keep the primary saved
  cursor; while on the alternate screen the primary cursor is that saved
  cursor, so a later `?1049l` returns to it as xterm.js `restoreCursor` does.
  Leaving with 47/1047 gives the primary screen the alternate cursor (xterm.js
  `activateNormalBuffer`). 1048 saves/restores the cursor like
  DECSC/DECRC.
- `term/cell.rs` uses the remaining u16 flag bit for SGR blink; `term/mod.rs`
  retains SGR 5, ignores SGR 6 like xterm, and clears blink on SGR 25/reset.
  This keeps the 24-byte cell layout while allowing ANSI replay to preserve blink.
- The PTY and event-loop modules (`tty`, `event_loop`, `sync`, `thread`) and
  their dependencies are removed: the engine only takes bytes, and they do not
  build for `wasm32-unknown-unknown`. `Term`, `Grid` and the parser are
  unchanged. The caller must use a clock-free `vte::ansi::Timeout` (the default
  `StdSyncHandler` calls `Instant::now()`, which traps on wasm32 as soon as a
  synchronized update `CSI ?2026h` starts) and expire it with
  `Processor::stop_sync`.
- History kept outside the grid: `grid::HistorySink` receives the rows a full
  history drops, oldest first (`Grid::set_history_sink`; `scroll_up` hands
  them over before rotating, `clear_history` calls `HistorySink::clear`).
  `Grid::scrolled_lines` counts scrolled lines under the same condition that
  moves `display_offset`. `Grid::prepend_history` / `split_off_history` move
  history rows in and out (oxty puts its compressed history back for a
  resize reflow), `Grid::set_display_offset` sets the view without clamping,
  and `Term::inactive_grid_mut` reaches the primary grid on the alternate
  screen. Without a sink the grid behaves as upstream. `oxty::Engine` keeps
  16 recent history rows in the grid and compresses older ones
  (`src/history.rs`).
- `Storage::initialize_up_to` caps the row cache (`MAX_CACHE_SIZE` spare rows)
  at the history limit; `Grid::increase_scroll_limit` uses it so a short
  history does not allocate 1000 spare rows.
- `Row::grow` and `Row::append` count the old cells as occupied. Upstream left
  `occ` short there, so the lazy `Row::reset` could skip cells whose
  background differed from the last cell, and a reused row kept a stale
  background after a resize.
- Mechanical changes by `scripts/vendor-vt.sh`: `lib.rs` → `mod.rs` without
  Alacritty's crate-wide lint attributes, `crate::` → `crate::vt::`,
  `alacritty_terminal::` → `oxty::vt::` in doc examples, and
  `env!("CARGO_PKG_VERSION")` pinned to `"0.26.0"` so the secondary device
  attributes reply keeps reporting Alacritty's version instead of oxty's.
- The module is `#[rustfmt::skip]` so it stays byte-close to upstream.

These changes are compatibility policy, not upstream behaviour.

## Upgrading

1. Download the current (0.26.0) and the new `alacritty_terminal` crates from
   crates.io and unpack them.
2. Run `scripts/vendor-vt.sh <old> <tmp>/old` and
   `scripts/vendor-vt.sh <new> <tmp>/new`.
3. `diff -ruN <tmp>/old/src/vt crates/oxty/src/vt > oxty-vt.patch` — these are
   oxty's changes.
4. Replace `crates/oxty/src/vt` with `<tmp>/new/src/vt`, apply
   `oxty-vt.patch` (`patch -p0` from the right directory) and resolve rejects.
5. Update the pinned version in this file and in the dependency list of
   `crates/oxty/Cargo.toml`, then run `cargo test -p oxty` and the wmux checks
   (`scripts/rust-terminal-core-bench.mjs --verify-only`,
   `scripts/rust-snapshot-verify.mjs`).
