//! Slide decks are ordinary pages whose frontmatter says `type: slides`.

use mdx_core::{Frontmatter, FrontmatterFormat};

pub fn is_deck(frontmatter: Option<&Frontmatter>) -> bool {
    frontmatter.is_some_and(|f| declares_slides(&f.raw, matches!(f.format, FrontmatterFormat::Toml)))
}

/// The same question for source text whose body may not parse yet (while typing), or for
/// just the start of a document.
pub fn declares_deck(source: &str) -> bool {
    let mut lines = source.strip_prefix('\u{feff}').unwrap_or(source).lines();
    let fence = match lines.next().map(str::trim_end) {
        Some(fence @ ("---" | "+++")) => fence,
        _ => return false,
    };
    let mut raw = String::new();
    for line in lines {
        if line.trim_end() == fence {
            return declares_slides(&raw, fence == "+++");
        }
        raw.push_str(line);
        raw.push('\n');
    }
    false
}

fn declares_slides(raw: &str, toml: bool) -> bool {
    let kind = if toml {
        raw.parse::<toml::Table>().ok().and_then(|t| t.get("type")?.as_str().map(str::to_owned))
    } else {
        serde_yaml::from_str::<serde_yaml::Value>(raw).ok().and_then(|v| v.get("type")?.as_str().map(str::to_owned))
    };
    kind.as_deref() == Some("slides")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_decks_from_text_and_from_analysis() {
        for deck in ["---\ntype: slides\n---\n<Unclosed", "---\r\ntitle: x\r\ntype: \"slides\"\r\n---\r\n", "+++\ntype = \"slides\"\n+++\n"]
        {
            assert!(declares_deck(deck), "{deck:?}");
        }
        for other in ["# type: slides\n", "---\ntitle: x\n---\ntype: slides\n", "---\ntype: slides\n", "\n---\ntype: slides\n---\n", ""] {
            assert!(!declares_deck(other), "{other:?}");
        }
        assert!(is_deck(crate::analyze("---\ntype: slides\n---\n").frontmatter.as_ref()));
        assert!(!is_deck(crate::analyze("# Page\n").frontmatter.as_ref()));
    }
}
