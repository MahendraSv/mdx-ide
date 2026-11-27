//! Authoring help for slide decks: the tags the preview provides on slides, and checks.

use mdx_core::{Diagnostic, DiagnosticSource, OutlineItem, Point, Range, Severity};

use crate::manifest::{ComponentManifest, ComponentSpec};

/// The tags built into the preview for slides (`preview-runtime/src/deck.tsx`).
const COMPONENTS: &str = r#"[
  { "name": "Slide", "category": "Slides", "acceptsChildren": false,
    "description": "Settings for the slide it is written on.",
    "snippet": "Slide layout=\"${1:center}\" />",
    "props": [ { "name": "layout", "type": "\"center\" | \"full\"", "values": ["center", "full"],
                 "description": "center: centred content. full: no margins, for a large demo." } ] },
  { "name": "Columns", "category": "Slides", "acceptsChildren": true,
    "description": "Places each child side by side. Use Column to keep several blocks together.",
    "snippet": "Columns>\n  <Column>\n    ${1}\n  </Column>\n  <Column>\n    ${2}\n  </Column>\n</Columns>",
    "props": [] },
  { "name": "Column", "category": "Slides", "acceptsChildren": true,
    "description": "One column inside Columns.", "props": [] },
  { "name": "Step", "category": "Slides", "acceptsChildren": true,
    "description": "Appears on a key press while presenting.", "props": [] },
  { "name": "Notes", "category": "Slides", "acceptsChildren": true,
    "description": "Speaker notes: shown below the slide while editing, hidden while presenting.", "props": [] }
]"#;

pub fn components() -> Vec<ComponentSpec> {
    serde_json::from_str(COMPONENTS).expect("built-in slide components are valid")
}

/// The team's components plus the slide tags. A team component of the same name wins, as it
/// does in the preview.
pub fn with_slide_components(manifest: &ComponentManifest) -> ComponentManifest {
    let mut merged = manifest.clone();
    merged.components.extend(components().into_iter().filter(|c| manifest.get(&c.name).is_none()));
    merged
}

/// `---` directly under a line of text makes that line a heading (Markdown's "setext" form),
/// where the writer meant to start a new slide.
pub fn check(outline: &[OutlineItem], source: &str) -> Vec<Diagnostic> {
    outline
        .iter()
        .filter(|heading| heading.depth == 2)
        .filter_map(|heading| {
            let range = heading.range?;
            let text = source.get(range.start.offset..range.end.offset)?.trim_end();
            let (_, underline) = text.rsplit_once('\n')?;
            let dashes = underline.trim();
            if dashes.len() < 3 || !dashes.bytes().all(|b| b == b'-') {
                return None;
            }
            let offset = range.start.offset + text.len() - underline.len();
            let line = range.start.line + text.matches('\n').count();
            Some(Diagnostic::new(
                DiagnosticSource::Slides,
                Severity::Warning,
                "slide-break",
                "This `---` turns the text above it into a heading instead of starting a new slide. Add a blank line before it.",
                Some(Range { start: Point { line, column: 1, offset }, end: range.end }),
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_about_a_rule_that_became_a_heading() {
        let found = |source: &str| check(&mdx_syntax::analyze(source).outline, source);
        let d = found("# One\n\nsome text\nmore text\n---\n\nnext\n");
        assert_eq!(d.len(), 1);
        let start = d[0].range.unwrap().start;
        assert_eq!((start.line, start.offset), (5, 27));
        for fine in ["text\n\n---\n\ntext\n", "## Two\n\n---\n", "Title\n===\n", "> quote\n> ---\n"] {
            assert!(found(fine).is_empty(), "{fine:?}");
        }
    }

    #[test]
    fn slide_tags_are_known_in_decks() {
        let team: ComponentManifest = serde_json::from_str(r#"{"components":[{"name":"Step","props":[{"name":"n"}]}]}"#).unwrap();
        let merged = with_slide_components(&team);
        // The team's own Step is kept.
        assert_eq!(merged.get("Step").unwrap().props.len(), 1);
        let a = mdx_syntax::analyze("<Slide layout=\"center\" />\n\n<Columns>\n  <Column>x</Column>\n</Columns>\n\n<Notes>y</Notes>\n");
        assert!(merged.check(&a.components, &[]).is_empty());
        let wrong = mdx_syntax::analyze("<Slide layout=\"middle\" />\n");
        assert_eq!(merged.check(&wrong.components, &[])[0].rule, "invalid-prop-value");
    }
}
