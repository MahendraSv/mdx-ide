//! Where each link target sits in the source, so it can be rewritten in place.

use markdown::mdast::{AttributeContent, AttributeValue, Node};
use mdx_core::Diagnostic;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlKind {
    Link,
    Image,
    /// `[id]: url`
    Definition,
    /// A literal `href` or `src` on a JSX element.
    Jsx,
    /// The specifier of an ESM `import` / `export … from`.
    Import,
}

/// `source[start..end]` is exactly `url`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlSpan {
    pub kind: UrlKind,
    pub url: String,
    pub start: usize,
    pub end: usize,
}

/// All rewritable link targets, in document order. Targets written with escapes or character
/// references (so the source text differs from the URL) are left out.
pub fn url_spans(source: &str) -> Result<Vec<UrlSpan>, Diagnostic> {
    let tree = crate::parse(source)?;
    let mut out = Vec::new();
    visit(&tree, source, &mut out);
    out.sort_by_key(|s| s.start);
    Ok(out)
}

fn visit(node: &Node, source: &str, out: &mut Vec<UrlSpan>) {
    if let Some(position) = node.position() {
        let (start, end) = (position.start.offset, position.end.offset);
        if let Some(text) = source.get(start..end) {
            match node {
                Node::Link(l) => push(out, UrlKind::Link, &l.url, start, destination(text, "](", &l.url)),
                Node::Image(i) => push(out, UrlKind::Image, &i.url, start, destination(text, "](", &i.url)),
                Node::Definition(d) => push(out, UrlKind::Definition, &d.url, start, destination(text, "]:", &d.url)),
                Node::MdxJsxFlowElement(e) => jsx(text, start, &e.attributes, out),
                Node::MdxJsxTextElement(e) => jsx(text, start, &e.attributes, out),
                Node::MdxjsEsm(_) => imports(text, start, out),
                _ => {}
            }
        }
    }
    for child in node.children().into_iter().flatten() {
        visit(child, source, out);
    }
}

fn push(out: &mut Vec<UrlSpan>, kind: UrlKind, url: &str, base: usize, at: Option<usize>) {
    if let (Some(at), false) = (at, url.is_empty()) {
        out.push(UrlSpan { kind, url: url.to_owned(), start: base + at, end: base + at + url.len() });
    }
}

/// Offset of `url` where it follows `marker` (`](` or `]:`), allowing whitespace and `<`.
/// Searches from the right: link text may itself contain the marker.
fn destination(text: &str, marker: &str, url: &str) -> Option<usize> {
    text.rmatch_indices(marker).find_map(|(i, _)| {
        let after = &text[i + marker.len()..];
        let trimmed = after.trim_start();
        let trimmed = trimmed.strip_prefix('<').unwrap_or(trimmed);
        trimmed.starts_with(url).then(|| text.len() - trimmed.len())
    })
}

fn jsx(text: &str, base: usize, attributes: &[AttributeContent], out: &mut Vec<UrlSpan>) {
    // Only the opening tag: children are visited on their own.
    let tag = &text[..opening_tag_end(text)];
    let mut from = 0;
    for attribute in attributes {
        let AttributeContent::Property(p) = attribute else { continue };
        let Some(AttributeValue::Literal(url)) = &p.value else { continue };
        if !matches!(p.name.as_str(), "href" | "src") {
            continue;
        }
        let found = tag[from..].match_indices(p.name.as_str()).find_map(|(i, _)| {
            let i = from + i;
            if !tag[..i].ends_with(char::is_whitespace) {
                return None;
            }
            let rest = tag[i + p.name.len()..].trim_start().strip_prefix('=')?.trim_start();
            let value = rest.strip_prefix(['"', '\''])?;
            value.starts_with(url.as_str()).then(|| tag.len() - value.len())
        });
        if let Some(at) = found {
            push(out, UrlKind::Jsx, url, base, Some(at));
            from = at + url.len();
        }
    }
}

/// Offset just past the `>` that closes the opening tag, skipping quotes and `{…}`.
fn opening_tag_end(text: &str) -> usize {
    let mut depth = 0usize;
    let mut quote = None;
    for (i, c) in text.char_indices() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'' | '`') => quote = Some(c),
            (None, '{') => depth += 1,
            (None, '}') => depth = depth.saturating_sub(1),
            (None, '>') if depth == 0 => return i + 1,
            _ => {}
        }
    }
    text.len()
}

/// String literals that follow `from`, `import` or `import(`, skipping comments and other strings.
fn imports(text: &str, base: usize, out: &mut Vec<UrlSpan>) {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'/') => i += text[i..].find('\n').unwrap_or(text.len() - i),
            b'/' if bytes.get(i + 1) == Some(&b'*') => i += text[i + 2..].find("*/").map_or(text.len() - i, |n| n + 4),
            quote @ (b'"' | b'\'' | b'`') => {
                let mut end = i + 1;
                while end < bytes.len() && bytes[end] != quote {
                    end += if bytes[end] == b'\\' { 2 } else { 1 };
                }
                let before = text[..i].trim_end();
                let before = before.strip_suffix('(').map_or(before, str::trim_end);
                let keyword = ["from", "import"].iter().any(|k| {
                    before.strip_suffix(k).is_some_and(|head| !head.ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.'))
                });
                if keyword && quote != b'`' {
                    if let Some(url) = text.get(i + 1..end) {
                        push(out, UrlKind::Import, url, base, Some(i + 1));
                    }
                }
                i = end + 1;
            }
            _ => i += 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_exact_spans() {
        let src = "---\ntitle: é\n---\n\nimport Chart from '../c/Chart'\n// import x from './no'\nexport { a } from \"./a.mdx\"\nexport const s = 'from ./nope'\n\n\
                   é [a \\](x)](./one.mdx \"t\") [![i](img.png)](two)\n\n[r]: <./three%20x.mdx>\n\n\
                   See <a data-src=\"./no\" href='./four.mdx'>in</a> and [it](./five)\n\n<Card src=\"/img/six.png\" title=\"href='./no'\" />\n\n```\n[c](./code.mdx)\n```\n";
        let spans = url_spans(src).unwrap();
        for s in &spans {
            assert_eq!(&src[s.start..s.end], s.url);
        }
        let urls: Vec<_> = spans.iter().map(|s| s.url.as_str()).collect();
        assert_eq!(
            urls,
            ["../c/Chart", "./a.mdx", "./one.mdx", "img.png", "two", "./three%20x.mdx", "./four.mdx", "./five", "/img/six.png"]
        );
    }
}
