//! Slide decks: an ordinary MDX page with `type: slides` in its frontmatter,
//! where each top-level `---` starts a new slide.

use markdown::mdast;
use mdx_core::FrontmatterFormat;
use mdxjs::hast;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Deck {
    /// The source line each slide starts on; one entry per slide.
    pub starts: Vec<usize>,
    /// Component names used in the page. The preview needs them in advance, so that a
    /// missing component breaks only the slide that uses it.
    pub components: Vec<String>,
}

/// If the page is a deck, wrap each slide in `<section data-slide="index">`.
///
/// `import` / `export` blocks stay at the top level, where JavaScript requires them.
pub fn split(source: &mdast::Node, tree: &mut hast::Node) -> Option<Deck> {
    let analysis = mdx_syntax::analyze_tree(source);
    let frontmatter = analysis.frontmatter?;
    if !is_deck(&frontmatter.raw, frontmatter.format) {
        return None;
    }
    let hast::Node::Root(root) = tree else { return None };

    let mut top = Vec::new();
    // (first source line, content)
    let mut slides: Vec<(usize, Vec<hast::Node>)> = vec![(1, Vec::new())];
    for child in std::mem::take(&mut root.children) {
        match child {
            hast::Node::MdxjsEsm(_) => top.push(child),
            // A Markdown rule. An `<hr />` written as a tag is a JSX node and stays on its slide.
            hast::Node::Element(ref el) if el.tag_name == "hr" => {
                let line = el.position.as_ref().map_or(1, |p| p.start.line);
                // A rule before any content opens the first slide, it does not end an empty one.
                match slides.as_mut_slice() {
                    [(from, content)] if content.iter().all(is_blank) => *from = line + 1,
                    _ => slides.push((line + 1, Vec::new())),
                }
            }
            _ => {
                if let Some((_, content)) = slides.last_mut() {
                    content.push(child);
                }
            }
        }
    }

    let starts = slides.iter().map(|(from, _)| *from).collect();
    root.children = top;
    root.children.extend(slides.into_iter().enumerate().map(|(index, (_, children))| {
        hast::Node::Element(hast::Element {
            tag_name: "section".into(),
            properties: vec![("dataSlide".into(), hast::PropertyValue::String(index.to_string()))],
            children,
            position: None,
        })
    }));

    let mut components: Vec<String> =
        analysis.components.into_iter().filter_map(|c| c.name).filter(|n| n.starts_with(char::is_uppercase)).collect();
    components.sort();
    components.dedup();
    Some(Deck { starts, components })
}

fn is_blank(node: &hast::Node) -> bool {
    matches!(node, hast::Node::Text(t) if t.value.trim().is_empty())
}

fn is_deck(raw: &str, format: FrontmatterFormat) -> bool {
    let kind = match format {
        FrontmatterFormat::Yaml => {
            serde_yaml::from_str::<serde_yaml::Value>(raw).ok().and_then(|v| v.get("type")?.as_str().map(str::to_owned))
        }
        FrontmatterFormat::Toml => raw.parse::<toml::Table>().ok().and_then(|t| t.get("type")?.as_str().map(str::to_owned)),
    };
    kind.as_deref() == Some("slides")
}

#[cfg(test)]
mod tests {
    use crate::{compile, CompileOptions, CompileOutput};

    fn deck(source: &str) -> CompileOutput {
        compile(source, &CompileOptions { source_lines: true, slides: true, ..Default::default() }).unwrap()
    }

    const FRONT: &str = "---\ntitle: Demo\ntype: slides\n---\n\n";

    #[test]
    fn each_rule_starts_a_slide() {
        let out = deck(&format!("{FRONT}# One\n\n---\n\n## Two\n\n<PriceCard plan=\"a\" />\n\n---\n\nThree <Badge>x</Badge>\n"));
        let slides = out.slides.unwrap();
        assert_eq!(slides.starts, [1, 9, 15]);
        assert_eq!(slides.components, ["Badge", "PriceCard"]);
        for expected in ["\"data-slide\": \"0\"", "\"data-slide\": \"2\""] {
            assert!(out.code.contains(expected), "{expected} in {}", out.code);
        }
        assert!(!out.code.contains("_components.hr"), "{}", out.code);
        // Elements keep their own line numbers for click-to-source.
        assert!(out.code.contains("\"data-line\": \"6\""), "{}", out.code);
    }

    #[test]
    fn leading_rule_and_trailing_rule() {
        // A rule straight after the frontmatter does not make an empty first slide.
        assert_eq!(deck(&format!("{FRONT}---\n\n# One\n")).slides.unwrap().starts, [7]);
        // A rule at the end opens the slide about to be written.
        assert_eq!(deck(&format!("{FRONT}# One\n\n---\n")).slides.unwrap().starts.len(), 2);
        assert_eq!(deck(FRONT).slides.unwrap().starts.len(), 1);
    }

    #[test]
    fn imports_stay_at_the_top_level() {
        let out = deck(&format!("{FRONT}# One\n\n---\n\nexport const price = 12\n\n{{price}}\n"));
        assert_eq!(out.slides.unwrap().starts.len(), 2);
        let export = out.code.find("export const price").expect("export kept");
        assert!(export < out.code.find("function _createMdxContent").unwrap(), "{}", out.code);
    }

    #[test]
    fn rules_inside_blocks_do_not_split() {
        let out = deck(&format!("{FRONT}> quote\n>\n> ---\n\n<hr />\n\n```\n---\n```\n"));
        assert_eq!(out.slides.unwrap().starts.len(), 1);
    }

    #[test]
    fn only_decks_are_split() {
        let page = "---\ntitle: x\n---\n\n# One\n\n---\n\n# Two\n";
        assert!(deck(page).slides.is_none());
        assert!(deck("# No frontmatter\n\n---\n").slides.is_none());
        assert!(deck("+++\ntype = \"slides\"\n+++\n\n# One\n").slides.is_some());
        // Asked for an ordinary page (the rendered diff), a deck keeps its rules.
        let plain = compile(&format!("{FRONT}# One\n\n---\n"), &CompileOptions::default()).unwrap();
        assert!(plain.slides.is_none() && plain.code.contains("hr"));
    }
}
