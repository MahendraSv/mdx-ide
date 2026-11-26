use std::collections::HashMap;
use std::path::Path;

use mdx_core::{AttrValue, ComponentUsage, Diagnostic, DiagnosticSource, Severity};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("could not read component manifest {path}: {source}")]
    Io { path: String, source: std::io::Error },
    #[error("invalid component manifest {path}: {source}")]
    Json { path: String, source: serde_json::Error },
}

/// `component-manifest.json`, generated from the team's design system.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentManifest {
    /// npm package the components come from, e.g. `@team/ui`.
    #[serde(default)]
    pub package: Option<String>,
    pub components: Vec<ComponentSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Palette grouping, e.g. "Feedback", "Layout".
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub props: Vec<PropSpec>,
    /// Whether the component accepts children (block vs. self-closing).
    #[serde(default = "yes")]
    pub accepts_children: bool,
    /// Snippet inserted from the palette / slash menu (CodeMirror snippet syntax: `${1:placeholder}`).
    #[serde(default)]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropSpec {
    pub name: String,
    /// TypeScript type as text, e.g. `"info" | "warning"` or `boolean`.
    #[serde(rename = "type", default)]
    pub ty: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    /// Allowed literal values for string-union props.
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub description: String,
}

fn yes() -> bool {
    true
}

impl ComponentManifest {
    pub fn load(path: &Path) -> Result<Self, ManifestError> {
        let text = std::fs::read_to_string(path).map_err(|source| ManifestError::Io { path: path.display().to_string(), source })?;
        serde_json::from_str(&text).map_err(|source| ManifestError::Json { path: path.display().to_string(), source })
    }

    pub fn get(&self, name: &str) -> Option<&ComponentSpec> {
        self.components.iter().find(|c| c.name == name)
    }

    /// Validate every component usage in a document.
    ///
    /// `imported` are names bound by ESM imports in the document; those
    /// are local components and are not checked.
    pub fn check(&self, usages: &[ComponentUsage], imported: &[String]) -> Vec<Diagnostic> {
        let by_name: HashMap<&str, &ComponentSpec> = self.components.iter().map(|c| (c.name.as_str(), c)).collect();
        let mut out = Vec::new();
        let diag = |severity, rule: &str, message: String, usage: &ComponentUsage| {
            Diagnostic::new(DiagnosticSource::Components, severity, rule, message, usage.range)
        };

        for usage in usages.iter().filter(|u| u.is_component()) {
            let name = usage.name.as_deref().unwrap_or_default();
            let root = name.split('.').next().unwrap_or(name);
            if imported.iter().any(|i| i == root) {
                continue;
            }
            let Some(spec) = by_name.get(name) else {
                let hint = suggest(name, self.components.iter().map(|c| c.name.as_str()))
                    .map(|s| format!(" Did you mean <{s}>?"))
                    .unwrap_or_default();
                out.push(diag(
                    Severity::Warning,
                    "unknown-component",
                    format!("<{name}> is not in the team component manifest.{hint}"),
                    usage,
                ));
                continue;
            };

            for attr in &usage.attributes {
                let Some(prop) = spec.props.iter().find(|p| p.name == attr.name) else {
                    if !is_passthrough_attr(&attr.name) {
                        out.push(diag(Severity::Warning, "unknown-prop", format!("<{name}> has no prop `{}`", attr.name), usage));
                    }
                    continue;
                };
                if let AttrValue::Literal(value) = &attr.value {
                    if !prop.values.is_empty() && !prop.values.contains(value) {
                        out.push(diag(
                            Severity::Error,
                            "invalid-prop-value",
                            format!("`{}` on <{name}> must be one of {}; got \"{value}\"", prop.name, quote_list(&prop.values)),
                            usage,
                        ));
                    }
                }
            }

            if !usage.has_spread {
                for prop in spec.props.iter().filter(|p| p.required && p.name != "children") {
                    if !usage.attributes.iter().any(|a| a.name == prop.name) {
                        out.push(diag(Severity::Error, "missing-required-prop", format!("<{name}> requires prop `{}`", prop.name), usage));
                    }
                }
            }
        }
        out
    }
}

fn is_passthrough_attr(name: &str) -> bool {
    matches!(name, "key" | "className" | "id" | "style") || name.starts_with("data-") || name.starts_with("aria-")
}

fn quote_list(values: &[String]) -> String {
    values.iter().map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join(", ")
}

/// Closest name by edit distance (≤ 2), for "did you mean" hints.
fn suggest<'a>(name: &str, candidates: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    candidates
        .map(|c| (levenshtein(&name.to_lowercase(), &c.to_lowercase()), c))
        .filter(|(d, _)| *d <= 2)
        .min_by_key(|(d, _)| *d)
        .map(|(_, c)| c)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != *cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> ComponentManifest {
        serde_json::from_str(
            r#"{ "package": "@team/ui", "components": [
              { "name": "Callout", "props": [
                { "name": "type", "type": "\"info\" | \"warning\"", "required": true, "values": ["info", "warning"] },
                { "name": "title", "type": "string" } ] },
              { "name": "Tabs", "props": [] }
            ] }"#,
        )
        .unwrap()
    }

    fn rules(src: &str) -> Vec<String> {
        let a = mdx_syntax::analyze(src);
        manifest().check(&a.components, &a.imported_names).into_iter().map(|d| d.rule).collect()
    }

    #[test]
    fn valid_usage_is_clean() {
        assert!(rules("<Callout type=\"info\" title=\"Hi\">x</Callout>\n").is_empty());
    }

    #[test]
    fn catches_problems() {
        assert_eq!(rules("<Callout type=\"danger\">x</Callout>\n"), vec!["invalid-prop-value"]);
        assert_eq!(rules("<Callout>x</Callout>\n"), vec!["missing-required-prop"]);
        assert_eq!(rules("<Callout type=\"info\" colour=\"red\">x</Callout>\n"), vec!["unknown-prop"]);
        assert_eq!(rules("<Calout type=\"info\">x</Calout>\n"), vec!["unknown-component"]);
    }

    #[test]
    fn skips_html_spreads_and_imports() {
        assert!(rules("<div className=\"x\">hi</div>\n").is_empty());
        assert!(rules("<Callout {...props}>x</Callout>\n").is_empty());
        assert!(rules("import Chart from './Chart'\n\n<Chart data={[1]} />\n").is_empty());
    }

    #[test]
    fn did_you_mean() {
        let a = mdx_syntax::analyze("<Calout />\n");
        let d = manifest().check(&a.components, &[]);
        assert!(d[0].message.contains("Did you mean <Callout>?"), "{}", d[0].message);
    }

    /// The manifest-gen sidecar's output must stay loadable by the Rust side.
    #[test]
    fn generated_manifest_parses() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../sidecars/manifest-gen/example/component-manifest.json");
        let m = ComponentManifest::load(std::path::Path::new(path)).unwrap();
        assert_eq!(m.package.as_deref(), Some("@team/ui"));
        let callout = m.get("Callout").unwrap();
        assert!(callout.accepts_children);
        assert_eq!(callout.props[0].values, vec!["info", "warning", "danger", "tip"]);
    }
}
