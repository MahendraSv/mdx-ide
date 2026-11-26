//! MDX → JavaScript (ESM) for the live preview.
//!
//! This runs the same stages as `mdxjs::compile`, but stops between
//! "mdast → hast" and "hast → SWC" to apply IDE transforms written in Rust
//! (mdxjs-rs has no remark/rehype plugin support):
//!
//! * [`annotate_source_lines`] adds `data-line="N"` to top-level elements so
//!   the preview can scroll in sync with the editor.
//!
//! Add your own transforms (admonitions, heading ids, ...) next to it. If
//! the docs site depends on JS remark/rehype plugins that are too costly to
//! port, use the "site-accurate" Node sidecar for full fidelity instead.

use markdown::Location;
use mdx_core::{Diagnostic, DiagnosticSource};
use mdxjs::hast;
use mdxjs::{JsxRuntime, MdxConstructs, MdxParseOptions, Options};
use serde::Serialize;

#[derive(Debug, Clone, Default)]
pub struct CompileOptions {
    /// File path, used in error messages.
    pub filepath: Option<String>,
    /// Inject `data-line` attributes for scroll sync.
    pub source_lines: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompileOutput {
    /// ESM module. Imports `react/jsx-runtime`; default export is `MDXContent`.
    pub code: String,
}

pub fn options(filepath: Option<String>) -> Options {
    Options {
        parse: MdxParseOptions { constructs: MdxConstructs { frontmatter: true, ..MdxConstructs::gfm() }, ..MdxParseOptions::default() },
        jsx_runtime: Some(JsxRuntime::Automatic),
        jsx_import_source: Some("react".into()),
        development: false,
        filepath,
        ..Options::default()
    }
}

/// Compile MDX source to an ES module.
pub fn compile(source: &str, opts: &CompileOptions) -> Result<CompileOutput, Diagnostic> {
    let options = options(opts.filepath.clone());
    let err = |m: markdown::message::Message| mdx_syntax::message_to_diagnostic(&m, DiagnosticSource::Compile);

    let mdast = mdxjs::mdast_util_from_mdx(source, &options).map_err(err)?;
    let mut hast = mdxjs::mdast_util_to_hast(&mdast);
    if opts.source_lines {
        annotate_source_lines(&mut hast);
    }

    let location = Location::new(source.as_bytes());
    let mut explicit_jsxs = Default::default();
    let mut program = mdxjs::hast_util_to_swc(&hast, &options, Some(&location), &mut explicit_jsxs).map_err(err)?;
    mdxjs::mdx_plugin_recma_document(&mut program, &options, Some(&location)).map_err(err)?;
    mdxjs::mdx_plugin_recma_jsx_rewrite(&mut program, &options, Some(&location), &explicit_jsxs).map_err(err)?;

    Ok(CompileOutput { code: program.serialize() })
}

/// Add `data-line` / `data-line-end` (1-based) to every top-level HTML element, and wrap every
/// top-level JSX component in a `<div data-tag="Name">` carrying the same attributes.
///
/// Components are wrapped rather than annotated because an extra prop could change their
/// behaviour. The preview uses these for scroll sync, click-to-source and the cursor outline.
pub fn annotate_source_lines(tree: &mut hast::Node) {
    let hast::Node::Root(root) = tree else { return };
    for child in &mut root.children {
        match child {
            hast::Node::Element(el) => {
                if let Some(pos) = &el.position {
                    el.properties.extend(line_properties(pos.start.line, pos.end.line));
                }
            }
            hast::Node::MdxJsxElement(jsx) => {
                // Capitalised or member names (`Tabs`, `ui.Card`) are components.
                let name = jsx.name.clone().filter(|n| n.starts_with(char::is_uppercase) || n.contains('.'));
                let (Some(name), Some(pos)) = (name, jsx.position.clone()) else { continue };
                let mut properties = line_properties(pos.start.line, pos.end.line).to_vec();
                properties.push(("dataTag".into(), hast::PropertyValue::String(name)));
                properties.push(("className".into(), hast::PropertyValue::SpaceSeparated(vec!["mdx-ide-block".into()])));
                let inner = std::mem::replace(child, hast::Node::Text(hast::Text { value: String::new(), position: None }));
                *child = hast::Node::Element(hast::Element {
                    tag_name: "div".into(),
                    properties,
                    children: vec![inner],
                    position: Some(pos),
                });
            }
            _ => {}
        }
    }
}

fn line_properties(start: usize, end: usize) -> [(String, hast::PropertyValue); 2] {
    [
        ("dataLine".into(), hast::PropertyValue::String(start.to_string())),
        ("dataLineEnd".into(), hast::PropertyValue::String(end.to_string())),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_to_esm_with_automatic_runtime() {
        let out = compile(
            "---\ntitle: x\n---\n\n# Hello\n\n<Callout type=\"info\">Hi</Callout>\n",
            &CompileOptions { source_lines: true, ..Default::default() },
        )
        .unwrap();
        assert!(out.code.contains("react/jsx-runtime"), "{}", out.code);
        assert!(out.code.contains("export default MDXContent"), "{}", out.code);
        assert!(out.code.contains("\"data-line\": \"5\""), "{}", out.code);
        // Top-level components are wrapped so the preview can outline them.
        assert!(out.code.contains("\"data-tag\": \"Callout\""), "{}", out.code);
        assert!(out.code.contains("\"data-line\": \"7\""), "{}", out.code);
        // Components are taken from props.components, not imported.
        assert!(out.code.contains("Callout"), "{}", out.code);
    }

    #[test]
    fn invalid_expression_reports_position() {
        let e = compile("# Hi\n\n{1 +}\n", &CompileOptions::default()).unwrap_err();
        assert_eq!(e.source, DiagnosticSource::Compile);
        // swc reports "unexpected eof" at the end of the expression.
        assert!((3..=4).contains(&e.range.unwrap().start.line), "{e:?}");
    }
}
