//! This module is private module and can be changed without notice.
//!
//! MDX IDE patch: upstream re-exports `serde::__private`, which serde >= 1.0.220
//! renamed (now `__private<version>`). Nothing in our build uses it (swc's
//! `serde-impl` features are off), so re-export the crate root instead.
//! Remove this vendored copy once mdxjs moves to a newer swc_core.

pub use serde;
