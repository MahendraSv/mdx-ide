//! Shared types used by every crate and sent over Tauri IPC to the UI.
//!
//! Everything here is plain data with `serde` derives so the frontend can
//! consume it as JSON. Lines and columns are **1-based** (matching
//! markdown-rs), offsets are **0-based UTF-8 byte offsets**.

use serde::{Deserialize, Serialize};

/// A point in a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    pub line: usize,
    pub column: usize,
    pub offset: usize,
}

/// A span in a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start: Point,
    pub end: Point,
}

impl Range {
    pub fn at(point: Point) -> Self {
        Self { start: point, end: point }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// Where a diagnostic came from. Shown in the Problems panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticSource {
    /// MDX syntax errors from markdown-rs.
    Syntax,
    /// Compile errors from mdxjs (e.g. invalid JS in ESM/expressions).
    Compile,
    /// Unknown components, missing / invalid props (component manifest).
    Components,
    /// Frontmatter JSON Schema validation.
    Frontmatter,
    /// Broken internal links, anchors and images.
    Links,
    /// Accessibility checks (alt text, heading levels, ...).
    A11y,
    /// Style / consistency rules from `mdxlint` (remark-lint).
    Mdxlint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub range: Option<Range>,
    pub severity: Severity,
    pub source: DiagnosticSource,
    /// Stable rule id, e.g. `unknown-component`.
    pub rule: String,
    pub message: String,
}

impl Diagnostic {
    pub fn new(
        source: DiagnosticSource,
        severity: Severity,
        rule: impl Into<String>,
        message: impl Into<String>,
        range: Option<Range>,
    ) -> Self {
        Self { range, severity, source, rule: rule.into(), message: message.into() }
    }
}

/// One heading in the outline / TOC panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutlineItem {
    pub depth: u8,
    pub text: String,
    /// GitHub-style slug used for `#anchor` links.
    pub slug: String,
    pub range: Option<Range>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Link,
    Image,
    Definition,
    /// `href` / `src` attribute on a JSX element.
    JsxAttribute,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkRef {
    pub kind: LinkKind,
    pub url: String,
    pub range: Option<Range>,
}

impl LinkRef {
    /// `http(s)://`, `mailto:`, protocol-relative, etc.
    pub fn is_external(&self) -> bool {
        let u = self.url.trim();
        u.starts_with("//")
            || u.split_once(':').is_some_and(|(scheme, _)| {
                !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
            })
    }
}

/// A value passed to a JSX attribute, as far as we can know it statically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum AttrValue {
    /// `<X flag />`
    Boolean,
    /// `<X type="warning" />`
    Literal(String),
    /// `<X count={3} />` — source text of the expression.
    Expression(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsxAttr {
    pub name: String,
    pub value: AttrValue,
}

/// A use of a JSX element in the document, e.g. `<Callout type="info">`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentUsage {
    /// `None` for fragments (`<>...</>`).
    pub name: Option<String>,
    pub attributes: Vec<JsxAttr>,
    /// `true` if there was a `{...spread}` attribute (we can't validate props then).
    pub has_spread: bool,
    pub inline: bool,
    pub range: Option<Range>,
}

impl ComponentUsage {
    /// Components start with an uppercase letter or contain a dot (`<Tabs.Item>`).
    /// Lowercase names are plain HTML elements.
    pub fn is_component(&self) -> bool {
        self.name.as_deref().is_some_and(|n| n.contains('.') || n.chars().next().is_some_and(|c| c.is_ascii_uppercase()))
    }
}

/// Frontmatter block as found in the document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frontmatter {
    #[serde(rename = "format")]
    pub format: FrontmatterFormat,
    pub raw: String,
    pub range: Option<Range>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrontmatterFormat {
    Yaml,
    Toml,
}

/// Everything the UI needs after an edit, computed in one pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAnalysis {
    pub outline: Vec<OutlineItem>,
    pub links: Vec<LinkRef>,
    pub components: Vec<ComponentUsage>,
    pub frontmatter: Option<Frontmatter>,
    /// Local bindings created by ESM `import` statements in the document.
    /// Components imported this way are not checked against the manifest.
    pub imported_names: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub word_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links() {
        let l = |u: &str| LinkRef { kind: LinkKind::Link, url: u.into(), range: None };
        assert!(l("https://example.com").is_external());
        assert!(l("mailto:a@b.c").is_external());
        assert!(l("//cdn.example.com/x.png").is_external());
        assert!(!l("./guide.mdx").is_external());
        assert!(!l("/docs/intro").is_external());
        assert!(!l("#section").is_external());
    }

    #[test]
    fn component_detection() {
        let u = |n: &str| ComponentUsage { name: Some(n.into()), attributes: vec![], has_spread: false, inline: false, range: None };
        assert!(u("Callout").is_component());
        assert!(u("Tabs.Item").is_component());
        assert!(!u("div").is_component());
    }
}
