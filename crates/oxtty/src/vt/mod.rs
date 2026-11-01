//! Alacritty `alacritty_terminal` 0.26 포크 (Apache-2.0). 변경 내역은 `PATCHES.md`.
//!
//! 저수준 API이며 oxtty의 버전 안정성 약속 밖이다. 렌더러는 [`crate::Engine`]을 쓴다.

pub mod event;
pub mod grid;
pub mod index;
pub mod selection;
pub mod term;
pub mod vi_mode;

pub use crate::vt::grid::Grid;
pub use crate::vt::term::Term;
pub use vte;

mod wmux_unicode11;
