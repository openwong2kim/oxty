//! `vte` 0.15.0 (Apache-2.0 OR MIT) with its `ansi` module built in, so the parser can stop at a sequence the host
//! hooked before its default action. The byte-level [`Parser`] stays the published crate's. Changes are listed in
//! `../PATCHES.md`.

pub use ::vte::{Params, ParamsIter, Parser, Perform};

pub mod ansi;
