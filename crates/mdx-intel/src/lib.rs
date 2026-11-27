//! Team-aware language intelligence.
//!
//! The core idea: instead of depending on the (in-flux) MDX language
//! server for component knowledge, the team generates a
//! `component-manifest.json` from its design system
//! (`sidecars/manifest-gen`) and the IDE uses it for completion, hover
//! docs, the component palette and diagnostics.

pub mod completion;
pub mod frontmatter;
pub mod links;
pub mod manifest;
pub mod slides;

pub use manifest::{ComponentManifest, ComponentSpec, PropSpec};
