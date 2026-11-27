//! Slide decks: an ordinary MDX page with `type: slides` in its frontmatter,
//! where each top-level `---` starts a new slide.

use markdown::mdast;
use mdxjs::hast;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Deck {
    /// The source line each slide starts on; one entry per slide.
    pub starts: Vec<usize>,
    /// The first heading of each slide, for the slide list.
    pub titles: Vec<Option<String>>,
    /// Component names used in the page. The preview needs them in advance, so that a
    /// missing component breaks only the slide that uses it.
    pub components: Vec<String>,
}

struct Slide {
    /// First source line.
    from: usize,
    layout: Option<String>,
    content: Vec<hast::Node>,
}

impl Slide {
    fn starting(from: usize) -> Self {
        Self { from, layout: None, content: Vec::new() }
    }
}

/// If the page is a deck, wrap each slide in `<section data-slide="index">`.
///
/// `import` / `export` blocks stay at the top level, where JavaScript requires them.
pub fn split(source: &mdast::Node, tree: &mut hast::Node) -> Option<Deck> {
    let analysis = mdx_syntax::analyze_tree(source);
    if !mdx_syntax::is_deck(analysis.frontmatter.as_ref()) {
        return None;
    }
    let hast::Node::Root(root) = tree else { return None };

    let mut top = Vec::new();
    let mut slides = vec![Slide::starting(1)];
    for child in std::mem::take(&mut root.children) {
        match child {
            hast::Node::MdxjsEsm(_) => top.push(child),
            // A Markdown rule. An `<hr />` written as a tag is a JSX node and stays on its slide.
            hast::Node::Element(ref el) if el.tag_name == "hr" => {
                let line = el.position.as_ref().map_or(1, |p| p.start.line);
                // A rule before any content opens the first slide, it does not end an empty one.
                match slides.as_mut_slice() {
                    [first] if first.layout.is_none() && first.content.iter().all(is_blank) => first.from = line + 1,
                    _ => slides.push(Slide::starting(line + 1)),
                }
            }
            mut child => {
                let Some(slide) = slides.last_mut() else { continue };
                match take_settings(&mut child) {
                    Some(settings) => {
                        slide.layout = settings.layout.or(slide.layout.take());
                        slide.content.extend(settings.content);
                    }
                    None => slide.content.push(child),
                }
            }
        }
    }

    let starts = slides.iter().map(|s| s.from).collect();
    let titles = slides.iter().map(|s| title(&s.content)).collect();
    root.children = top;
    root.children.extend(slides.into_iter().enumerate().map(|(index, slide)| {
        let mut properties = vec![("dataSlide".into(), hast::PropertyValue::String(index.to_string()))];
        if let Some(layout) = slide.layout {
            properties.push(("dataLayout".into(), hast::PropertyValue::String(layout)));
        }
        hast::Node::Element(hast::Element { tag_name: "section".into(), properties, children: slide.content, position: None })
    }));

    let mut components: Vec<String> =
        analysis.components.into_iter().filter_map(|c| c.name).filter(|n| n.starts_with(char::is_uppercase)).collect();
    components.sort();
    components.dedup();
    Some(Deck { starts, titles, components })
}

fn is_blank(node: &hast::Node) -> bool {
    matches!(node, hast::Node::Text(t) if t.value.trim().is_empty())
}

/// What a `<Slide>` tag says about the slide it is written on.
struct Settings {
    layout: Option<String>,
    /// Anything written inside the tag; it stays on the slide.
    content: Vec<hast::Node>,
}

/// Reads `<Slide layout="…" />`, emptying the tag. `None` if the node is something else.
fn take_settings(node: &mut hast::Node) -> Option<Settings> {
    match node {
        // With source lines, a component sits in a wrapper carrying its name.
        hast::Node::Element(wrapper) if wrapper.children.len() == 1 => take_settings(&mut wrapper.children[0]),
        hast::Node::MdxJsxElement(tag) if tag.name.as_deref() == Some("Slide") => {
            let layout = tag.attributes.iter().find_map(|a| match a {
                mdast::AttributeContent::Property(p) if p.name == "layout" => match &p.value {
                    Some(mdast::AttributeValue::Literal(value)) => Some(value.clone()),
                    _ => None,
                },
                _ => None,
            });
            Some(Settings { layout, content: std::mem::take(&mut tag.children) })
        }
        _ => None,
    }
}

/// The text of the first heading on a slide, outside its speaker notes.
fn title(nodes: &[hast::Node]) -> Option<String> {
    nodes.iter().find_map(|node| match node {
        hast::Node::Element(el) if matches!(el.tag_name.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
            Some(text(&el.children).split_whitespace().collect::<Vec<_>>().join(" ")).filter(|t| !t.is_empty())
        }
        hast::Node::Element(el) => title(&el.children),
        hast::Node::MdxJsxElement(e) if e.name.as_deref() != Some("Notes") => title(&e.children),
        _ => None,
    })
}

fn text(nodes: &[hast::Node]) -> String {
    nodes
        .iter()
        .map(|node| match node {
            hast::Node::Text(t) => t.value.clone(),
            hast::Node::Element(el) => text(&el.children),
            hast::Node::MdxJsxElement(e) => text(&e.children),
            _ => String::new(),
        })
        .collect()
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
    fn slide_tag_sets_the_layout_of_its_slide() {
        let source = format!(
            "{FRONT}<Slide layout=\"center\" />\n\n# One\n\n---\n\n## Two\n\n---\n\n<Slide layout=\"full\">\n  <Demo />\n</Slide>\n"
        );
        for source_lines in [true, false] {
            let out = compile(&source, &CompileOptions { source_lines, slides: true, ..Default::default() }).unwrap();
            assert_eq!(out.slides.as_ref().unwrap().starts.len(), 3);
            assert_eq!(out.code.matches("\"data-layout\": \"center\"").count(), 1, "{}", out.code);
            assert_eq!(out.code.matches("\"data-layout\": \"full\"").count(), 1, "{}", out.code);
            // The tag itself is gone; what it contained stays.
            assert!(!out.code.contains("_jsx(Slide") && out.code.contains("_jsx(Demo"), "{}", out.code);
        }
        // A first slide holding only its settings is still a slide.
        assert_eq!(deck(&format!("{FRONT}<Slide layout=\"center\" />\n\n---\n\n# Two\n")).slides.unwrap().starts.len(), 2);
    }

    #[test]
    fn slides_are_titled_by_their_first_heading() {
        let source = format!(
            "{FRONT}# The **big** idea\n\n## Not this\n\n---\n\n<Notes>\n  ## Nor this\n</Notes>\n\n<Columns>\n  ### In a column\n</Columns>\n\n---\n\nNo heading.\n"
        );
        let titles = deck(&source).slides.unwrap().titles;
        assert_eq!(titles, [Some("The big idea".into()), Some("In a column".into()), None]);
    }

    #[test]
    fn the_new_deck_template_compiles() {
        let template = include_str!("../../mdx-workspace/src/new-deck.mdx").replace("${title_yaml}", "Demo").replace("${title}", "Demo");
        let slides = deck(&template).slides.unwrap();
        assert_eq!(slides.titles.len(), 3);
        assert_eq!(slides.titles[0].as_deref(), Some("Demo"));
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
