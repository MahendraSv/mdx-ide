//! Team configuration, committed to the docs repo at `.mdx-ide/config.toml`.
//! Every teammate who opens the repo gets the same behaviour.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const CONFIG_DIR: &str = ".mdx-ide";
pub const CONFIG_FILE: &str = "config.toml";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WorkspaceConfig {
    /// Where MDX content lives (relative to the repo root). Root-relative page
    /// links (`/guides/setup`) resolve against these.
    pub content_dirs: Vec<PathBuf>,
    /// Where root-relative assets (`/img/logo.png`) live: `static` (Docusaurus), `public` (Next.js/Astro).
    pub static_dirs: Vec<PathBuf>,
    /// Folder where pasted / dropped images are copied.
    pub assets_dir: PathBuf,
    /// Generated component manifest (see `sidecars/manifest-gen`).
    pub component_manifest: Option<PathBuf>,
    /// Frontmatter schemas, matched by glob against the file path. First match wins.
    pub schemas: Vec<SchemaRule>,
    pub preview: PreviewConfig,
    pub lint: LintConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaRule {
    /// Glob, e.g. `docs/blog/**/*.mdx`.
    pub files: String,
    /// JSON Schema file, relative to the repo root.
    pub schema: PathBuf,
    /// Template for new documents in this collection.
    #[serde(default)]
    pub template: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PreviewConfig {
    /// `docusaurus` | `nextjs` | `astro` | `generic` — used for site-aware preview (v1).
    pub site: String,
    /// Prebundled ESM build of the team component library (see `preview-runtime/`).
    pub components_bundle: Option<PathBuf>,
    /// Global CSS files injected into the preview.
    pub css: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LintConfig {
    pub check_links: bool,
    pub check_components: bool,
    pub a11y: bool,
    /// Run `mdxlint` over the document when saving (needs Node; see sidecars/mdxlint).
    pub format_on_save: bool,
    /// Show `mdxlint` (remark-lint) rules in the Problems panel (needs Node; see sidecars/mdxlint).
    pub mdxlint_rules: bool,
    /// Optional rc file for mdxlint, relative to the repo root (default: `.mdx-ide/mdxlintrc.json`, then the bundled one).
    pub mdxlint_config: Option<PathBuf>,
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self {
            content_dirs: vec![PathBuf::from("docs")],
            static_dirs: vec![PathBuf::from("static"), PathBuf::from("public")],
            assets_dir: PathBuf::from("static/img"),
            component_manifest: Some(PathBuf::from(".mdx-ide/component-manifest.json")),
            schemas: vec![],
            preview: PreviewConfig::default(),
            lint: LintConfig::default(),
        }
    }
}

impl Default for PreviewConfig {
    fn default() -> Self {
        Self { site: "generic".into(), components_bundle: None, css: vec![] }
    }
}

impl Default for LintConfig {
    fn default() -> Self {
        Self { check_links: true, check_components: true, a11y: true, format_on_save: true, mdxlint_rules: true, mdxlint_config: None }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("could not read {0}: {1}")]
    Io(String, std::io::Error),
    #[error("invalid {0}: {1}")]
    Parse(String, toml::de::Error),
}

impl WorkspaceConfig {
    /// Load `<root>/.mdx-ide/config.toml`, or defaults if it doesn't exist.
    pub fn load(root: &Path) -> Result<Self, ConfigError> {
        let path = root.join(CONFIG_DIR).join(CONFIG_FILE);
        match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).map_err(|e| ConfigError::Parse(path.display().to_string(), e)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(ConfigError::Io(path.display().to_string(), e)),
        }
    }
}
