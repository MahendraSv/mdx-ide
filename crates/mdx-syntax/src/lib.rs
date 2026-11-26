//! MDX parsing and structural analysis on top of markdown-rs.
//!
//! [`analyze`] parses a document once and extracts everything the editor
//! panels need (outline, links, JSX component usages, frontmatter, word
//! count) plus syntax diagnostics.
//!
//! Parsing runs on a dedicated thread with a large stack: markdown-rs can
//! overflow the stack on pathological nesting (markdown-rs#280), and a parse
//! must never take the IDE down with it.

mod esm;
mod slug;
pub mod urls;

use markdown::mdast::{AttributeContent, AttributeValue, Node};
use markdown::message::{Message, Place};
use markdown::{unist, Constructs, ParseOptions};
use mdx_core::*;

pub use slug::Slugger;

/// Stack size for the parser thread.
const PARSE_STACK_BYTES: usize = 64 * 1024 * 1024;

/// Parse options matching MDX 3 + GFM + YAML/TOML frontmatter.
///
/// Keep this in sync with `mdx_compile::options` so analysis and preview
/// agree on what is valid.
pub fn parse_options() -> ParseOptions {
    ParseOptions {
        constructs: Constructs {
            frontmatter: true,
            gfm_autolink_literal: true,
            gfm_footnote_definition: true,
            gfm_label_start_footnote: true,
            gfm_strikethrough: true,
            gfm_table: true,
            gfm_task_list_item: true,
            ..Constructs::mdx()
        },
        // markdown-rs only recognizes `import`/`export` blocks when an ESM
        // parser is provided. We accept everything here: real JS validation
        // happens in mdx-compile (SWC) and is reported as a compile error.
        mdx_esm_parse: Some(Box::new(|_esm: &str| markdown::MdxSignal::Ok)),
        ..ParseOptions::mdx()
    }
}

/// Parse MDX into an mdast tree on a big-stack worker thread.
pub fn parse(source: &str) -> Result<Node, Diagnostic> {
    let owned = source.to_owned();
    let handle = std::thread::Builder::new()
        .name("mdx-parse".into())
        .stack_size(PARSE_STACK_BYTES)
        .spawn(move || markdown::to_mdast(&owned, &parse_options()))
        .map_err(|e| internal(format!("could not spawn parser thread: {e}")))?;

    match handle.join() {
        Ok(Ok(tree)) => Ok(tree),
        Ok(Err(message)) => Err(message_to_diagnostic(&message, DiagnosticSource::Syntax)),
        Err(_) => Err(internal("the MDX parser panicked on this document".into())),
    }
}

/// Parse + extract everything. Never fails: syntax errors become diagnostics.
pub fn analyze(source: &str) -> DocumentAnalysis {
    match parse(source) {
        Ok(tree) => analyze_tree(&tree),
        Err(diagnostic) => DocumentAnalysis {
            diagnostics: vec![diagnostic],
            // Still give the user *something* in the word counter.
            word_count: count_words(source),
            ..Default::default()
        },
    }
}

/// Extract outline, links, components and frontmatter from a parsed tree.
pub fn analyze_tree(tree: &Node) -> DocumentAnalysis {
    let mut cx = Collector { out: DocumentAnalysis::default(), slugger: Slugger::default(), text: String::new() };
    cx.visit(tree);
    cx.out.word_count = count_words(&cx.text);
    cx.out
}

struct Collector {
    out: DocumentAnalysis,
    slugger: Slugger,
    /// Prose text, for word count (and later: spell check).
    text: String,
}

impl Collector {
    fn visit(&mut self, node: &Node) {
        let range = node.position().map(to_range);
        match node {
            Node::Yaml(y) => {
                self.out.frontmatter = Some(Frontmatter { format: FrontmatterFormat::Yaml, raw: y.value.clone(), range });
                return;
            }
            Node::Toml(t) => {
                self.out.frontmatter = Some(Frontmatter { format: FrontmatterFormat::Toml, raw: t.value.clone(), range });
                return;
            }
            Node::Heading(h) => {
                let text = node.to_string();
                let slug = self.slugger.slug(&text);
                self.out.outline.push(OutlineItem { depth: h.depth, text, slug, range });
            }
            Node::Link(l) => self.link(LinkKind::Link, &l.url, range),
            Node::Image(i) => {
                self.link(LinkKind::Image, &i.url, range);
                if i.alt.trim().is_empty() {
                    self.out.diagnostics.push(Diagnostic::new(
                        DiagnosticSource::A11y,
                        Severity::Warning,
                        "image-alt",
                        "Image is missing alt text",
                        range,
                    ));
                }
            }
            Node::Definition(d) => self.link(LinkKind::Definition, &d.url, range),
            Node::MdxjsEsm(esm) => self.out.imported_names.extend(esm::imported_names(&esm.value)),
            Node::MdxJsxFlowElement(e) => self.jsx(e.name.clone(), &e.attributes, false, range),
            Node::MdxJsxTextElement(e) => self.jsx(e.name.clone(), &e.attributes, true, range),
            Node::Text(t) => {
                self.text.push_str(&t.value);
                self.text.push(' ');
            }
            Node::InlineCode(c) => {
                self.text.push_str(&c.value);
                self.text.push(' ');
            }
            _ => {}
        }
        if let Some(children) = node.children() {
            for child in children {
                self.visit(child);
            }
        }
    }

    fn link(&mut self, kind: LinkKind, url: &str, range: Option<Range>) {
        self.out.links.push(LinkRef { kind, url: url.to_owned(), range });
    }

    fn jsx(&mut self, name: Option<String>, attributes: &[AttributeContent], inline: bool, range: Option<Range>) {
        let mut attrs = Vec::new();
        let mut has_spread = false;
        for attribute in attributes {
            match attribute {
                AttributeContent::Expression(_) => has_spread = true,
                AttributeContent::Property(p) => {
                    let value = match &p.value {
                        None => AttrValue::Boolean,
                        Some(AttributeValue::Literal(s)) => AttrValue::Literal(s.clone()),
                        Some(AttributeValue::Expression(e)) => AttrValue::Expression(e.value.clone()),
                    };
                    // href/src on JSX elements participate in link checking.
                    if matches!(p.name.as_str(), "href" | "src") {
                        if let AttrValue::Literal(url) = &value {
                            self.link(LinkKind::JsxAttribute, url, range);
                        }
                    }
                    attrs.push(JsxAttr { name: p.name.clone(), value });
                }
            }
        }
        self.out.components.push(ComponentUsage { name, attributes: attrs, has_spread, inline, range });
    }
}

fn count_words(text: &str) -> usize {
    text.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).count()
}

pub fn to_point(p: &unist::Point) -> Point {
    Point { line: p.line, column: p.column, offset: p.offset }
}

pub fn to_range(p: &unist::Position) -> Range {
    Range { start: to_point(&p.start), end: to_point(&p.end) }
}

/// Convert a markdown-rs / mdxjs message into a diagnostic.
pub fn message_to_diagnostic(message: &Message, source: DiagnosticSource) -> Diagnostic {
    let range = message.place.as_deref().map(|place| match place {
        Place::Position(p) => to_range(p),
        Place::Point(p) => Range::at(to_point(p)),
    });
    Diagnostic::new(source, Severity::Error, format!("{}:{}", message.source, message.rule_id), message.reason.clone(), range)
}

fn internal(message: String) -> Diagnostic {
    Diagnostic::new(DiagnosticSource::Syntax, Severity::Error, "internal", message, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"---
title: Getting started
---

import { Callout } from '@team/ui'

# Getting started

Read the [install guide](./install.mdx) first.

<Callout type="warning" dismissible>
  Don't skip **this** step.
</Callout>

## Next steps

![](./img/diagram.png)

Inline <Badge tone={"new"} /> component.
"#;

    #[test]
    fn extracts_structure() {
        let a = analyze(DOC);
        assert_eq!(a.frontmatter.as_ref().unwrap().raw, "title: Getting started");
        let headings: Vec<_> = a.outline.iter().map(|o| (o.depth, o.slug.as_str())).collect();
        assert_eq!(headings, vec![(1, "getting-started"), (2, "next-steps")]);

        let urls: Vec<_> = a.links.iter().map(|l| l.url.as_str()).collect();
        assert_eq!(urls, vec!["./install.mdx", "./img/diagram.png"]);

        let callout = a.components.iter().find(|c| c.name.as_deref() == Some("Callout")).unwrap();
        assert!(!callout.inline);
        assert_eq!(callout.attributes[0].value, AttrValue::Literal("warning".into()));
        assert_eq!(callout.attributes[1].value, AttrValue::Boolean);

        let badge = a.components.iter().find(|c| c.name.as_deref() == Some("Badge")).unwrap();
        assert!(badge.inline);
        assert_eq!(badge.attributes[0].value, AttrValue::Expression("\"new\"".into()));

        // The image with empty alt is flagged.
        assert!(a.diagnostics.iter().any(|d| d.rule == "image-alt"));
        assert!(a.word_count > 5);
        assert_eq!(a.imported_names, vec!["Callout"]);
    }

    #[test]
    fn syntax_error_is_a_diagnostic_with_position() {
        let a = analyze("# Hi\n\n<Callout>\n\nunclosed\n");
        assert_eq!(a.diagnostics.len(), 1);
        let d = &a.diagnostics[0];
        assert_eq!(d.source, DiagnosticSource::Syntax);
        assert!(d.range.is_some(), "{d:?}");
    }

    #[test]
    fn html_comments_are_errors_in_mdx() {
        let a = analyze("<!-- not allowed in MDX 3 -->\n");
        assert_eq!(a.diagnostics.len(), 1);
    }
}
