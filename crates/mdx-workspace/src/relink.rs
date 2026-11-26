//! Keeping links working when pages and folders are renamed or moved.
//!
//! 1. Before the move, every link and relative import in every page is resolved to the file it
//!    points at (the same rules the broken-link check uses).
//! 2. The entry is moved.
//! 3. A target is rewritten only if, as written, it no longer reaches that same file. The new
//!    text keeps the author's style: relative or root-relative, with or without extension,
//!    `index` folder links, `#anchors`.
//!
//! Links that were already broken are left exactly as they are.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use mdx_intel::links::{resolve, LinkContext};
use mdx_syntax::urls::{url_spans, UrlKind, UrlSpan};
use serde::Serialize;

use crate::{Workspace, WorkspaceError};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameReport {
    /// The entry's new relative path.
    pub path: String,
    /// Pages in which links were updated.
    pub files: Vec<RelinkedFile>,
    /// Pages whose links could not be checked or saved, with the reason.
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkedFile {
    /// Path after the move.
    pub path: String,
    /// Number of links updated (in the saved file, or in the unsaved text if only that changed).
    pub links: usize,
    /// New contents written to disk, if the saved file changed.
    pub disk: Option<String>,
    /// New unsaved text, if the editor's copy was provided and changed.
    pub buffer: Option<String>,
}

/// A link whose destination is known, found before anything moved.
struct Found {
    span: UrlSpan,
    target: PathBuf,
}

struct Page {
    old: String,
    disk: Option<(String, Vec<Found>)>,
    buffer: Option<(String, Vec<Found>)>,
}

const MODULE_EXTENSIONS: &[&str] = &["mdx", "md", "tsx", "ts", "jsx", "js", "mjs", "json", "css"];

impl Workspace {
    /// [`Workspace::rename`], then update the links affected by it.
    ///
    /// `unsaved` holds the editor's text for open pages with unsaved changes, keyed by their
    /// current path. Their saved file and their unsaved text are updated independently.
    pub fn rename_updating_links(&self, from: &str, to: &str, unsaved: &HashMap<String, String>) -> Result<RenameReport, WorkspaceError> {
        let from = from.trim().trim_matches('/');
        let mut skipped_old = Vec::new();
        let pages: Vec<Page> = self
            .mdx_files()
            .into_iter()
            .map(|file| {
                let disk = std::fs::read_to_string(self.root().join(&file.path)).ok();
                let mut scan = |text: String| match self.scan(&file.path, &text) {
                    Some(found) => Some((text, found)),
                    None => {
                        skipped_old.push(file.path.clone());
                        None
                    }
                };
                let buffer = unsaved.get(&file.path).cloned().and_then(&mut scan);
                let disk = disk.and_then(&mut scan);
                Page { old: file.path, disk, buffer }
            })
            .collect();

        // Fails without touching anything if the move is not allowed.
        let to = self.rename(from, to)?;
        let mut report = RenameReport { path: to.clone(), ..Default::default() };
        if to == from {
            return Ok(report);
        }
        let moved = |rel: &str| match rel.strip_prefix(from) {
            Some("") => to.clone(),
            Some(rest) if rest.starts_with('/') => format!("{to}{rest}"),
            _ => rel.to_owned(),
        };
        let old_root = self.root().join(from);
        let new_root = self.root().join(&to);
        let moved_path = |path: &Path| match path.strip_prefix(&old_root) {
            Ok(rest) if rest.as_os_str().is_empty() => new_root.clone(),
            Ok(rest) => new_root.join(rest),
            Err(_) => path.to_path_buf(),
        };

        skipped_old.sort();
        skipped_old.dedup();
        report.skipped = skipped_old.iter().map(|p| format!("{}: has a syntax error, links not checked", moved(p))).collect();

        for page in pages {
            let path = moved(&page.old);
            let document = self.root().join(&path);
            let rewrite = |(text, found): &(String, Vec<Found>)| {
                let mut out = text.clone();
                let mut count = 0;
                // Back to front, so earlier offsets stay valid.
                for f in found.iter().rev() {
                    if let Some(url) = self.new_url(&document, &f.span, &f.target, &moved_path(&f.target)) {
                        out.replace_range(f.span.start..f.span.end, &url);
                        count += 1;
                    }
                }
                (count > 0).then_some((out, count))
            };
            let mut disk = page.disk.as_ref().and_then(rewrite);
            let buffer = page.buffer.as_ref().and_then(rewrite);
            if let Some((text, _)) = &disk {
                if let Err(e) = self.write(&path, text) {
                    report.skipped.push(format!("{path}: {e}"));
                    disk = None;
                }
            }
            if disk.is_some() || buffer.is_some() {
                let links = disk.as_ref().or(buffer.as_ref()).map_or(0, |(_, n)| *n);
                report.files.push(RelinkedFile { path, links, disk: disk.map(|(t, _)| t), buffer: buffer.map(|(t, _)| t) });
            }
        }
        Ok(report)
    }

    fn link_context<'a>(&'a self, document: &'a Path) -> LinkContext<'a> {
        LinkContext { root: self.root(), document, static_dirs: &self.config.static_dirs, content_dirs: &self.config.content_dirs }
    }

    /// Resolve every local target in a page. `None` if the page cannot be parsed.
    fn scan(&self, rel: &str, text: &str) -> Option<Vec<Found>> {
        let document = self.root().join(rel);
        let spans = url_spans(text).ok()?;
        Some(spans.into_iter().filter_map(|span| self.target_of(&document, &span).map(|target| Found { span, target })).collect())
    }

    fn target_of(&self, document: &Path, span: &UrlSpan) -> Option<PathBuf> {
        if span.kind == UrlKind::Import {
            // Packages and aliases (`react`, `@/components`) do not depend on file locations.
            if !span.url.starts_with('.') {
                return None;
            }
            let base = normalize(&document.parent()?.join(&span.url));
            if !base.starts_with(self.root()) {
                return None;
            }
            let with = |ext: &str| PathBuf::from(format!("{}.{ext}", base.display()));
            return std::iter::once(base.clone())
                .chain(MODULE_EXTENSIONS.iter().map(|e| with(e)))
                .chain(MODULE_EXTENSIONS.iter().map(|e| base.join(format!("index.{e}"))))
                .find(|c| c.is_file());
        }
        let path = split_suffix(&span.url).0;
        if path.is_empty() || is_external(&span.url) {
            return None;
        }
        resolve(path, span.kind == UrlKind::Image, &self.link_context(document))
    }

    /// The replacement for a link now written in `document`, or `None` if it still works.
    fn new_url(&self, document: &Path, span: &UrlSpan, old_target: &Path, target: &Path) -> Option<String> {
        if self.target_of(document, span).as_deref() == Some(target) {
            return None;
        }
        let (path, suffix) = split_suffix(&span.url);
        let import = span.kind == UrlKind::Import;
        let style = Style::of(&decode(path), old_target);
        let from_dir = document.parent().unwrap_or(self.root());

        let candidate = |style: Style| -> String {
            let wanted = style.apply(target);
            let mut url = None;
            if path.starts_with('/') {
                url = self.root_relative(path, old_target, &wanted);
            }
            let mut url = url.unwrap_or_else(|| {
                let relative = relative_to(from_dir, &wanted);
                let dotted = import || path == "." || path.starts_with("./") || relative.is_empty();
                match relative.as_str() {
                    "" => {
                        if path.ends_with('/') || !import {
                            "./".into()
                        } else {
                            ".".into()
                        }
                    }
                    r if r.starts_with("..") => relative,
                    _ if dotted => format!("./{relative}"),
                    _ => relative,
                }
            });
            if path.ends_with('/') && !url.ends_with('/') {
                url.push('/');
            }
            if !import {
                url = encode(&url);
            }
            url + suffix
        };

        let preferred = candidate(style);
        // If the preferred style would not reach the file (e.g. a sibling shadows it), spell it out.
        let check = UrlSpan { url: preferred.clone(), ..span.clone() };
        let url = if self.target_of(document, &check).as_deref() == Some(target) { preferred } else { candidate(Style::Exact) };
        (url != span.url).then_some(url)
    }

    /// `/…` form of `wanted`, preferring the content / static directory the old link used.
    fn root_relative(&self, old_url: &str, old_target: &Path, wanted: &Path) -> Option<String> {
        let rooted = decode(old_url);
        let rooted = rooted.trim_matches('/');
        let dirs: Vec<PathBuf> = self.config.static_dirs.iter().chain(&self.config.content_dirs).map(|d| self.root().join(d)).collect();
        let used = dirs.iter().find(|dir| {
            let base = normalize(&dir.join(rooted));
            old_target == base || old_target.parent() == Some(&base) || old_target.with_extension("") == base
        });
        let base = used.into_iter().chain(&dirs).map(|d| normalize(d)).find(|dir| wanted.starts_with(dir));
        let base = match base {
            Some(b) => b,
            // A link written from the repository root stays that way.
            None if used.is_none() => self.root().to_path_buf(),
            None => return None,
        };
        let relative = wanted.strip_prefix(base).ok()?;
        Some(format!("/{}", slashes(relative)))
    }
}

/// How the author referred to a file.
#[derive(Clone, Copy)]
enum Style {
    /// With its extension.
    Exact,
    /// Without extension.
    Bare,
    /// By the folder holding its `index` file.
    Folder,
}

impl Style {
    fn of(url: &str, target: &Path) -> Style {
        let last = url.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
        let name = target.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
        let stem = target.file_stem().map(|n| n.to_string_lossy()).unwrap_or_default();
        if last.eq_ignore_ascii_case(&name) {
            Style::Exact
        } else if last.eq_ignore_ascii_case(&stem) {
            Style::Bare
        } else if stem == "index" {
            Style::Folder
        } else {
            Style::Exact
        }
    }

    fn apply(self, target: &Path) -> PathBuf {
        match self {
            Style::Exact => target.to_path_buf(),
            Style::Folder if target.file_stem().is_some_and(|s| s == "index") => target.parent().unwrap_or(target).to_path_buf(),
            Style::Bare | Style::Folder => target.with_extension(""),
        }
    }
}

fn is_external(url: &str) -> bool {
    url.starts_with("//")
        || url.split_once(':').is_some_and(|(scheme, _)| {
            scheme.starts_with(|c: char| c.is_ascii_alphabetic()) && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        })
}

/// Split off `?query` / `#anchor`.
fn split_suffix(url: &str) -> (&str, &str) {
    url.split_at(url.find(['?', '#']).unwrap_or(url.len()))
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
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

/// Percent-encode the characters that would end or change a Markdown link destination.
fn encode(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            ' ' | '(' | ')' | '<' | '>' | '"' | '\'' | '#' | '?' | '%' => format!("%{:02X}", c as u32),
            other => other.to_string(),
        })
        .collect()
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
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

fn slashes(path: &Path) -> String {
    path.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// Path from folder `from` to `to`, with `/` separators.
fn relative_to(from: &Path, to: &Path) -> String {
    let a: Vec<_> = from.components().collect();
    let b: Vec<_> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts = vec!["..".to_owned(); a.len() - common];
    parts.extend(b[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace(files: &[(&str, &str)]) -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let p = dir.path().join(path);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    fn broken_links(ws: &Workspace) -> Vec<String> {
        ws.mdx_files()
            .iter()
            .flat_map(|f| ws.analyze(&f.path, &ws.read(&f.path).unwrap()).diagnostics)
            .filter(|d| d.rule.starts_with("broken"))
            .map(|d| d.message)
            .collect()
    }

    #[test]
    fn renaming_a_page_updates_links_in_every_style() {
        let (_d, ws) = workspace(&[
            (
                "docs/intro.mdx",
                "import S from './guides/setup.mdx'\n\n[a](./guides/setup.mdx#install) [b](guides/setup) [c](/guides/setup?x=1)\n\
                 <a href=\"./guides/setup\">d</a> [e][ref] [f](https://x.com/guides/setup) [g](./missing.mdx)\n\n[ref]: ./guides/setup.mdx \"T\"\n",
            ),
            ("docs/guides/setup.mdx", "# Setup\n\n## Install\n\n[self](./setup.mdx)\n"),
        ]);
        let report = ws.rename_updating_links("docs/guides/setup.mdx", "docs/guides/get started.mdx", &HashMap::new()).unwrap();
        assert_eq!(
            ws.read("docs/intro.mdx").unwrap(),
            "import S from './guides/get started.mdx'\n\n[a](./guides/get%20started.mdx#install) [b](guides/get%20started) [c](/guides/get%20started?x=1)\n\
             <a href=\"./guides/get%20started\">d</a> [e][ref] [f](https://x.com/guides/setup) [g](./missing.mdx)\n\n[ref]: ./guides/get%20started.mdx \"T\"\n"
        );
        assert!(ws.read("docs/guides/get started.mdx").unwrap().contains("[self](./get%20started.mdx)"));
        assert_eq!(report.files.iter().map(|f| f.links).sum::<usize>(), 7);
        assert_eq!(broken_links(&ws), vec!["Link target `./missing.mdx` does not exist"]);
    }

    #[test]
    fn moving_a_page_rebases_its_own_links_and_imports() {
        let (_d, ws) = workspace(&[
            ("docs/a/page.mdx", "import C from '../../components/Chart'\nimport R from 'react'\n\n![i](../img/x.png) ![s](/img/y.png) [n](./near.mdx) [h](#top)\n\n# Top\n"),
            ("docs/a/near.mdx", "[back](page)\n"),
            ("docs/img/x.png", ""),
            ("static/img/y.png", ""),
            ("components/Chart.tsx", ""),
        ]);
        ws.rename_updating_links("docs/a/page.mdx", "docs/b/c/page.mdx", &HashMap::new()).unwrap();
        assert_eq!(
            ws.read("docs/b/c/page.mdx").unwrap(),
            "import C from '../../../components/Chart'\nimport R from 'react'\n\n![i](../../img/x.png) ![s](/img/y.png) [n](../../a/near.mdx) [h](#top)\n\n# Top\n"
        );
        assert_eq!(ws.read("docs/a/near.mdx").unwrap(), "[back](../b/c/page)\n");
        assert!(broken_links(&ws).is_empty(), "{:?}", broken_links(&ws));
    }

    #[test]
    fn moving_a_folder_keeps_internal_links_and_fixes_outside_ones() {
        let inside = "[sib](./two.mdx) [up](../home.mdx) ![p](pic.png)\n";
        let (_d, ws) = workspace(&[
            ("docs/home.mdx", "[i](./guides) [s](./guides/) [t](/guides/two) [o](./guides/index.mdx)\n"),
            ("docs/guides/index.mdx", inside),
            ("docs/guides/two.mdx", "[idx](.) [home](/home)\n"),
            ("docs/guides/pic.png", ""),
        ]);
        let report = ws.rename_updating_links("docs/guides", "docs/archive/howto", &HashMap::new()).unwrap();
        assert_eq!(
            ws.read("docs/home.mdx").unwrap(),
            "[i](./archive/howto) [s](./archive/howto/) [t](/archive/howto/two) [o](./archive/howto/index.mdx)\n"
        );
        // Only the link leaving the folder changes.
        assert_eq!(ws.read("docs/archive/howto/index.mdx").unwrap(), "[sib](./two.mdx) [up](../../home.mdx) ![p](pic.png)\n");
        assert_eq!(ws.read("docs/archive/howto/two.mdx").unwrap(), "[idx](.) [home](/home)\n");
        assert_eq!(report.files.len(), 2);
        assert!(broken_links(&ws).is_empty(), "{:?}", broken_links(&ws));
    }

    #[test]
    fn unsaved_text_and_saved_file_are_updated_separately() {
        let (_d, ws) = workspace(&[("a.mdx", "[b](./b.mdx)\n"), ("b.mdx", "# B\n"), ("bad.mdx", "<Open>\n")]);
        let unsaved = HashMap::from([("a.mdx".to_owned(), "New words\n\n[b](./b.mdx) and [again](b)\n".to_owned())]);
        let report = ws.rename_updating_links("b.mdx", "c.mdx", &unsaved).unwrap();
        assert_eq!(ws.read("a.mdx").unwrap(), "[b](./c.mdx)\n");
        assert_eq!(report.files[0].buffer.as_deref(), Some("New words\n\n[b](./c.mdx) and [again](c)\n"));
        assert_eq!(report.skipped, vec!["bad.mdx: has a syntax error, links not checked"]);
    }

    #[test]
    fn a_refused_move_changes_nothing() {
        let (_d, ws) = workspace(&[("a.mdx", "[b](./b.mdx)\n"), ("b.mdx", "# B\n"), ("c.mdx", "# C\n")]);
        assert!(ws.rename_updating_links("b.mdx", "c.mdx", &HashMap::new()).is_err());
        assert_eq!(ws.read("a.mdx").unwrap(), "[b](./b.mdx)\n");
    }
}
