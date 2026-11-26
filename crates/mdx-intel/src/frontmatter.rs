//! Frontmatter parsing and JSON Schema validation.
//!
//! The same schema files (`.mdx-ide/schemas/*.schema.json`) drive both the
//! diagnostics here and the generated frontmatter form in the UI.

use mdx_core::{Diagnostic, DiagnosticSource, Frontmatter, FrontmatterFormat, Point, Range, Severity};
use serde_json::Value;

/// Parse frontmatter into JSON.
pub fn to_json(fm: &Frontmatter) -> Result<Value, Diagnostic> {
    let parsed = match fm.format {
        FrontmatterFormat::Yaml => serde_yaml::from_str::<Value>(&fm.raw).map_err(|e| e.to_string()),
        FrontmatterFormat::Toml => toml::from_str::<Value>(&fm.raw).map_err(|e| e.to_string()),
    };
    // Empty YAML (`---\n---`) parses to null; treat it as an empty object.
    parsed
        .map(|v| if v.is_null() { Value::Object(Default::default()) } else { v })
        .map_err(|message| Diagnostic::new(DiagnosticSource::Frontmatter, Severity::Error, "frontmatter-parse", message, fm.range))
}

/// Validate frontmatter against a JSON Schema.
///
/// `fm = None` is validated as `{}` so `required` fields are still reported.
pub fn validate(fm: Option<&Frontmatter>, schema: &Value) -> Vec<Diagnostic> {
    let range = fm.and_then(|f| f.range);
    let instance = match fm.map(to_json).transpose() {
        Ok(v) => v.unwrap_or_else(|| Value::Object(Default::default())),
        Err(d) => return vec![d],
    };
    let validator = match jsonschema::validator_for(schema) {
        Ok(v) => v,
        Err(e) => {
            return vec![Diagnostic::new(
                DiagnosticSource::Frontmatter,
                Severity::Error,
                "frontmatter-schema-invalid",
                format!("The frontmatter schema itself is invalid: {e}"),
                None,
            )]
        }
    };
    validator
        .iter_errors(&instance)
        .map(|e| {
            let path = e.instance_path().to_string();
            let key = path.trim_start_matches('/').split('/').next().unwrap_or_default();
            let location = if path.is_empty() { String::new() } else { format!("{} ", path.trim_start_matches('/').replace('/', ".")) };
            let range = fm.and_then(|f| key_range(f, key)).or(range);
            Diagnostic::new(
                DiagnosticSource::Frontmatter,
                Severity::Error,
                "frontmatter-schema",
                format!("{location}{e}").trim().to_owned(),
                range,
            )
        })
        .collect()
}

/// Range of the top-level `key:` / `key =` line inside the frontmatter block.
fn key_range(fm: &Frontmatter, key: &str) -> Option<Range> {
    let block = fm.range?;
    if key.is_empty() {
        return None;
    }
    // The block starts with the opening fence line (`---` / `+++`).
    let fence_len = 4; // "---\n"
    let mut offset = block.start.offset + fence_len;
    for (i, line) in fm.raw.lines().enumerate() {
        let rest = line.strip_prefix(key).map(str::trim_start);
        if rest.is_some_and(|r| r.starts_with(':') || r.starts_with('=')) {
            let line_no = block.start.line + 1 + i;
            let start = Point { line: line_no, column: 1, offset };
            let end = Point { line: line_no, column: line.chars().count() + 1, offset: offset + line.len() };
            return Some(Range { start, end });
        }
        offset += line.len() + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!({
            "type": "object",
            "required": ["title", "status"],
            "properties": {
                "title": { "type": "string", "minLength": 3 },
                "status": { "enum": ["draft", "review", "published"] },
                "tags": { "type": "array", "items": { "type": "string" } }
            }
        })
    }

    fn fm(raw: &str) -> Frontmatter {
        Frontmatter { format: FrontmatterFormat::Yaml, raw: raw.into(), range: None }
    }

    #[test]
    fn valid() {
        assert!(validate(Some(&fm("title: Intro\nstatus: draft\ntags: [a, b]")), &schema()).is_empty());
    }

    #[test]
    fn invalid() {
        let d = validate(Some(&fm("title: Intro\nstatus: wip")), &schema());
        assert_eq!(d.len(), 1);
        assert!(d[0].message.starts_with("status"), "{}", d[0].message);
        assert_eq!(validate(None, &schema()).len(), 2);
        assert_eq!(validate(Some(&fm("title: [unclosed")), &schema())[0].rule, "frontmatter-parse");
    }

    #[test]
    fn points_at_the_key() {
        let src = "---\ntitle: Intro\nstatus: wip\n---\n\n# Hi\n";
        let a = mdx_syntax::analyze(src);
        let d = validate(a.frontmatter.as_ref(), &schema());
        let r = d[0].range.unwrap();
        assert_eq!(r.start.line, 3);
        assert_eq!(&src[r.start.offset..r.end.offset], "status: wip");
    }

    #[test]
    fn toml() {
        let f = Frontmatter { format: FrontmatterFormat::Toml, raw: "title = \"Intro\"\nstatus = \"draft\"".into(), range: None };
        assert!(validate(Some(&f), &schema()).is_empty());
    }
}
