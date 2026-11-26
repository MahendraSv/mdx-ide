//! Internal link, anchor and image checking.

use std::path::{Component, Path, PathBuf};

use mdx_core::{Diagnostic, DiagnosticSource, LinkKind, LinkRef, OutlineItem, Severity};

/// How URLs map onto files. Mirrors the docs site's conventions.
#[derive(Debug, Clone)]
pub struct LinkContext<'a> {
    /// Workspace root.
    pub root: &'a Path,
    /// The document being checked (absolute path).
    pub document: &'a Path,
    /// Directories that root-relative URLs (`/img/x.png`) resolve against,
    /// e.g. `static/` (Docusaurus) or `public/` (Next.js / Astro).
    pub static_dirs: &'a [PathBuf],
    /// Directories that root-relative page URLs (`/docs/intro`) resolve against.
    pub content_dirs: &'a [PathBuf],
}

/// Check links in one document.
///
/// `outline_of` returns heading slugs for another document, used to
/// validate `other.mdx#anchor`. The caller backs it with the workspace index.
pub fn check(
    links: &[LinkRef],
    own_outline: &[OutlineItem],
    cx: &LinkContext<'_>,
    outline_of: &dyn Fn(&Path) -> Option<Vec<String>>,
) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for link in links.iter().filter(|l| !l.is_external()) {
        let (path_part, anchor) = split_url(&link.url);
        let what = if link.kind == LinkKind::Image { "Image" } else { "Link" };
        let diag = |rule: &str, message: String| Diagnostic::new(DiagnosticSource::Links, Severity::Warning, rule, message, link.range);

        if path_part.is_empty() {
            if let Some(anchor) = anchor {
                if !own_outline.iter().any(|o| o.slug == anchor) {
                    out.push(diag("broken-anchor", format!("No heading with anchor `#{anchor}` in this document")));
                }
            }
            continue;
        }

        let Some(target) = resolve(path_part, link.kind == LinkKind::Image, cx) else {
            out.push(diag("broken-link", format!("{what} target `{path_part}` does not exist")));
            continue;
        };

        if let (Some(anchor), true) = (anchor, is_mdx(&target)) {
            if let Some(slugs) = outline_of(&target) {
                if !slugs.iter().any(|s| s == anchor) {
                    out.push(diag("broken-anchor", format!("No heading `#{anchor}` in `{path_part}`")));
                }
            }
        }
    }
    out
}

fn split_url(url: &str) -> (&str, Option<&str>) {
    let url = url.split('?').next().unwrap_or(url);
    match url.split_once('#') {
        Some((p, a)) => (p, Some(a).filter(|a| !a.is_empty())),
        None => (url, None),
    }
}

fn is_mdx(p: &Path) -> bool {
    matches!(p.extension().and_then(|e| e.to_str()), Some("mdx" | "md"))
}

/// Resolve a URL path to an existing file, trying docs-site conventions:
/// exact file, `.mdx`/`.md` extension, `index.mdx` in a directory.
pub fn resolve(url_path: &str, is_asset: bool, cx: &LinkContext<'_>) -> Option<PathBuf> {
    let decoded = percent_decode(url_path);
    let bases: Vec<PathBuf> = if let Some(rooted) = decoded.strip_prefix('/') {
        let dirs = if is_asset { cx.static_dirs } else { cx.content_dirs };
        let mut b: Vec<PathBuf> = dirs.iter().map(|d| cx.root.join(d).join(rooted)).collect();
        // Pages can also point at static files and vice versa.
        b.extend(cx.static_dirs.iter().chain(cx.content_dirs).map(|d| cx.root.join(d).join(rooted)));
        b.push(cx.root.join(rooted));
        b
    } else {
        vec![cx.document.parent().unwrap_or(cx.root).join(&decoded)]
    };

    for base in bases {
        let base = normalize(&base);
        // Never resolve outside the workspace.
        if !base.starts_with(cx.root) {
            continue;
        }
        let candidates =
            [base.clone(), base.with_extension("mdx"), base.with_extension("md"), base.join("index.mdx"), base.join("index.md")];
        if let Some(found) = candidates.into_iter().find(|c| c.is_file()) {
            return Some(found);
        }
    }
    None
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn checks_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("docs/guides")).unwrap();
        fs::create_dir_all(root.join("static/img")).unwrap();
        fs::write(root.join("docs/intro.mdx"), "# Intro\n").unwrap();
        fs::write(root.join("docs/guides/setup.mdx"), "# Setup\n\n## Install it\n").unwrap();
        fs::write(root.join("static/img/logo copy.png"), "").unwrap();

        let src = "# Intro\n\n[a](./guides/setup.mdx#install-it) [b](./guides/setup#nope) [c](/guides/setup)\n\
                   [d](./missing.mdx) [e](#intro) [f](#gone) ![logo](/img/logo%20copy.png) ![x](/img/none.png)\n\
                   [g](https://example.com) [h](../../etc/passwd)\n";
        let a = mdx_syntax::analyze(src);
        let doc = root.join("docs/intro.mdx");
        let static_dirs = [PathBuf::from("static")];
        let content_dirs = [PathBuf::from("docs")];
        let cx = LinkContext { root, document: &doc, static_dirs: &static_dirs, content_dirs: &content_dirs };
        let outline_of = |p: &Path| Some(mdx_syntax::analyze(&fs::read_to_string(p).ok()?).outline.into_iter().map(|o| o.slug).collect());

        let found: Vec<(String, String)> = check(&a.links, &a.outline, &cx, &outline_of).into_iter().map(|d| (d.rule, d.message)).collect();
        let rules: Vec<&str> = found.iter().map(|(r, _)| r.as_str()).collect();
        assert_eq!(rules, vec!["broken-anchor", "broken-link", "broken-anchor", "broken-link", "broken-link"], "{found:#?}");
        assert!(found[0].1.contains("#nope"));
        assert!(found[1].1.contains("missing.mdx"));
        assert!(found[2].1.contains("#gone"));
        assert!(found[3].1.contains("none.png"));
        assert!(found[4].1.contains("passwd"));
    }
}
