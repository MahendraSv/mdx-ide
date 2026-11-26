//! Completion items for JSX tags and props, served to CodeMirror's
//! autocompletion via Tauri IPC.

use serde::Serialize;

use crate::manifest::ComponentManifest;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    pub label: String,
    /// CodeMirror completion type: `class` for components, `property` for props, `enum` for values.
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub detail: Option<String>,
    pub info: Option<String>,
    /// CodeMirror snippet template (`${1:...}`); `None` = insert label.
    pub snippet: Option<String>,
}

/// `<Cal|` → components.
pub fn components(manifest: &ComponentManifest) -> Vec<CompletionItem> {
    manifest
        .components
        .iter()
        .map(|c| CompletionItem {
            label: c.name.clone(),
            kind: "class",
            detail: c.category.clone(),
            info: Some(c.description.clone()).filter(|s| !s.is_empty()),
            snippet: Some(c.snippet.clone().unwrap_or_else(|| default_snippet(c))),
        })
        .collect()
}

/// `<Callout |` → props not yet used.
pub fn props(manifest: &ComponentManifest, component: &str, already: &[String]) -> Vec<CompletionItem> {
    let Some(spec) = manifest.get(component) else { return vec![] };
    spec.props
        .iter()
        .filter(|p| p.name != "children" && !already.contains(&p.name))
        .map(|p| CompletionItem {
            label: p.name.clone(),
            kind: "property",
            detail: Some(format!("{}{}", p.ty, if p.required { " (required)" } else { "" })),
            info: Some(p.description.clone()).filter(|s| !s.is_empty()),
            snippet: Some(if p.ty == "boolean" {
                p.name.clone()
            } else if p.ty == "string" || !p.values.is_empty() {
                format!("{}=\"${{1}}\"", p.name)
            } else {
                format!("{}={{${{1}}}}", p.name)
            }),
        })
        .collect()
}

/// `<Callout type="|` → allowed values.
pub fn prop_values(manifest: &ComponentManifest, component: &str, prop: &str) -> Vec<CompletionItem> {
    manifest
        .get(component)
        .and_then(|c| c.props.iter().find(|p| p.name == prop))
        .map(|p| {
            p.values.iter().map(|v| CompletionItem { label: v.clone(), kind: "enum", detail: None, info: None, snippet: None }).collect()
        })
        .unwrap_or_default()
}

fn default_snippet(c: &crate::ComponentSpec) -> String {
    let required: String = c
        .props
        .iter()
        .filter(|p| p.required && p.name != "children")
        .enumerate()
        .map(|(i, p)| match p.values.first() {
            Some(v) => format!(" {}=\"${{{}:{}}}\"", p.name, i + 1, v),
            None => format!(" {}=\"${{{}}}\"", p.name, i + 1),
        })
        .collect();
    if c.accepts_children {
        format!("{}{}>\n  ${{}}\n</{}>", c.name, required, c.name)
    } else {
        format!("{}{} />", c.name, required)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets() {
        let m: ComponentManifest = serde_json::from_str(
            r#"{"components":[{"name":"Callout","props":[{"name":"type","required":true,"values":["info","warning"]},{"name":"open","type":"boolean"}]},
                              {"name":"Badge","acceptsChildren":false,"props":[]}]}"#,
        )
        .unwrap();
        let items = components(&m);
        assert_eq!(items[0].snippet.as_deref(), Some("Callout type=\"${1:info}\">\n  ${}\n</Callout>"));
        assert_eq!(items[1].snippet.as_deref(), Some("Badge />"));
        let p = props(&m, "Callout", &["type".into()]);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].snippet.as_deref(), Some("open"));
        assert_eq!(prop_values(&m, "Callout", "type").len(), 2);
    }
}
