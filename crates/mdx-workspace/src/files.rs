//! Explorer file operations: create, rename / move, trash, and folder listing.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::{Workspace, WorkspaceError};

impl Workspace {
    /// All folders (workspace-relative), respecting `.gitignore` and skipping hidden ones.
    pub fn directories(&self) -> Vec<String> {
        let mut dirs: Vec<String> = ignore::WalkBuilder::new(self.root())
            .hidden(true)
            .filter_entry(|e| e.file_name() != "node_modules")
            .build()
            .filter_map(Result::ok)
            .filter(|e| e.depth() > 0 && e.file_type().is_some_and(|t| t.is_dir()))
            .map(|e| self.relative(e.path()))
            .collect();
        dirs.sort();
        dirs
    }

    /// Create a folder, including missing parents. Returns its normalised relative path.
    pub fn create_dir(&self, rel: &str) -> Result<String, WorkspaceError> {
        let (rel, target) = self.new_entry(rel)?;
        std::fs::create_dir_all(&target)?;
        Ok(rel)
    }

    /// Create a new `.mdx` page, including missing parent folders. Never overwrites.
    ///
    /// The contents come from the matching schema rule's `template` (with `${title}` and
    /// `${date}` filled in, `${author}` left empty), otherwise a minimal page.
    pub fn create_file(&self, rel: &str, date: &str) -> Result<String, WorkspaceError> {
        self.create_with(rel, |rel| self.new_page(rel, date))
    }

    /// Create a slide deck with a few example slides.
    pub fn create_deck(&self, rel: &str) -> Result<String, WorkspaceError> {
        self.create_with(rel, |rel| {
            let title = title_of(rel);
            Ok(include_str!("new-deck.mdx").replace("${title_yaml}", &yaml_string(&title)).replace("${title}", &title))
        })
    }

    fn create_with(&self, rel: &str, contents: impl FnOnce(&str) -> Result<String, WorkspaceError>) -> Result<String, WorkspaceError> {
        if !rel.trim().ends_with(".mdx") {
            return Err(invalid("only .mdx files can be created"));
        }
        let (rel, target) = self.new_entry(rel)?;
        let contents = contents(&rel)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // `create_new` fails if something appeared since the check above.
        std::fs::OpenOptions::new().write(true).create_new(true).open(&target)?.write_all(contents.as_bytes())?;
        Ok(rel)
    }

    fn new_page(&self, rel: &str, date: &str) -> Result<String, WorkspaceError> {
        let title = title_of(rel);
        let rule = self.schema_rule_for(rel);
        if let Some(template) = rule.and_then(|r| r.template.as_ref()) {
            let path = self.root().join(template).canonicalize()?;
            if !path.starts_with(self.root()) {
                return Err(WorkspaceError::OutsideWorkspace(template.display().to_string()));
            }
            let text = std::fs::read_to_string(path)?;
            return Ok(text.replace("${title}", &title).replace("${date}", date).replace("${author}", ""));
        }
        Ok(match rule {
            // A schema applies, so start with frontmatter the form can edit.
            Some(_) => format!("---\ntitle: {}\n---\n\n# {title}\n", yaml_string(&title)),
            None => format!("# {title}\n"),
        })
    }

    /// Rename or move a page or folder. Never overwrites. Returns the new relative path.
    pub fn rename(&self, from: &str, to: &str) -> Result<String, WorkspaceError> {
        let (from, source) = self.existing_entry(from)?;
        let is_dir = source.symlink_metadata()?.is_dir();
        let to = clean(to)?;
        if !is_dir && !to.ends_with(".mdx") {
            return Err(invalid("pages must keep the .mdx extension"));
        }
        if to == from {
            return Ok(to);
        }
        if is_dir && to.to_lowercase().starts_with(&format!("{}/", from.to_lowercase())) {
            return Err(invalid("a folder cannot be moved into itself"));
        }
        let target = self.root().join(&to);
        // On case-insensitive disks `readme.mdx` → `Readme.mdx` finds itself; that is allowed.
        if !same_entry(&source, &target) {
            self.new_entry(&to)?;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(source, target)?;
        Ok(to)
    }

    /// Move a page or folder to the system Trash, so it can be recovered.
    pub fn trash(&self, rel: &str) -> Result<(), WorkspaceError> {
        let (rel, path) = self.existing_entry(rel)?;
        #[allow(unused_mut)]
        let mut context = trash::TrashContext::new();
        // The default macOS method scripts Finder, which prompts for automation permission.
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            context.set_delete_method(DeleteMethod::NsFileManager);
        }
        context.delete(path).map_err(|e| invalid(&format!("could not move \"{rel}\" to the Trash: {e}")))
    }

    /// Number of files inside an entry (1 for a file), including ones the explorer hides.
    pub fn file_count(&self, rel: &str) -> Result<usize, WorkspaceError> {
        fn count(path: &Path) -> usize {
            match path.symlink_metadata() {
                Ok(m) if m.is_dir() => std::fs::read_dir(path).map(|d| d.flatten().map(|e| count(&e.path())).sum()).unwrap_or(0),
                Ok(_) => 1,
                Err(_) => 0,
            }
        }
        Ok(count(&self.existing_entry(rel)?.1))
    }

    /// Validate a path to something that exists and may be renamed or removed: a visible folder or
    /// `.mdx` page strictly inside the workspace.
    fn existing_entry(&self, rel: &str) -> Result<(String, PathBuf), WorkspaceError> {
        let rel = clean(rel)?;
        let path = self.root().join(&rel);
        let meta = path.symlink_metadata().map_err(|_| invalid(&format!("\"{rel}\" no longer exists")))?;
        if !meta.is_dir() && !rel.ends_with(".mdx") {
            return Err(invalid("only folders and .mdx pages can be changed"));
        }
        self.inside(&rel, &path)?;
        Ok((rel, path))
    }

    /// Validate a to-be-created path: relative, inside the workspace, visible and not taken.
    fn new_entry(&self, rel: &str) -> Result<(String, PathBuf), WorkspaceError> {
        let rel = clean(rel)?;
        let target = self.root().join(&rel);
        self.inside(&rel, &target)?;
        if target.symlink_metadata().is_ok() {
            return Err(invalid(&format!("\"{rel}\" already exists")));
        }
        Ok((rel, target))
    }

    /// The deepest existing folder above `path` must really be inside the workspace (symlinks).
    fn inside(&self, rel: &str, path: &Path) -> Result<(), WorkspaceError> {
        let existing = path.ancestors().skip(1).find(|p| p.exists()).unwrap_or(self.root());
        if !existing.canonicalize()?.starts_with(self.root()) {
            return Err(WorkspaceError::OutsideWorkspace(rel.into()));
        }
        Ok(())
    }
}

/// Normalise a workspace-relative path, refusing empty, hidden, `..` and unusable names.
fn clean(rel: &str) -> Result<String, WorkspaceError> {
    let parts: Vec<&str> = rel.trim().split('/').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err(invalid("enter a name"));
    }
    for part in &parts {
        if part.starts_with('.') {
            return Err(invalid("names cannot start with a dot"));
        }
        if *part == "node_modules" || part.chars().any(|c| c.is_control() || "\\:*?\"<>|".contains(c)) {
            return Err(invalid(&format!("\"{part}\" is not a valid name")));
        }
    }
    Ok(parts.join("/"))
}

/// Whether two paths name the same file on disk.
fn same_entry(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        matches!((a.symlink_metadata(), b.symlink_metadata()), (Ok(x), Ok(y)) if x.dev() == y.dev() && x.ino() == y.ino())
    }
    #[cfg(not(unix))]
    {
        b.symlink_metadata().is_ok() && a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
}

fn invalid(message: &str) -> WorkspaceError {
    WorkspaceError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, message.to_owned()))
}

/// `getting-started` → `Getting started`.
fn title_from(stem: &str) -> String {
    let words = stem.replace(['-', '_'], " ");
    let mut chars = words.trim().chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

/// Quote a YAML scalar unless it is plainly safe.
fn yaml_string(s: &str) -> String {
    let plain = s.starts_with(char::is_alphabetic)
        && s.chars().all(|c| c.is_alphanumeric() || c == ' ')
        && !["true", "false", "null", "yes", "no", "on", "off"].contains(&s.to_ascii_lowercase().as_str());
    if plain {
        s.to_owned()
    } else {
        serde_json::Value::String(s.to_owned()).to_string()
    }
}

/// A page title from its file name.
fn title_of(rel: &str) -> String {
    title_from(&Path::new(rel).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        fs::create_dir_all(r.join(".mdx-ide/templates")).unwrap();
        fs::write(
            r.join(".mdx-ide/config.toml"),
            "[[schemas]]\nfiles = \"blog/**/*.mdx\"\nschema = \"s.json\"\ntemplate = \".mdx-ide/templates/post.mdx\"\n",
        )
        .unwrap();
        fs::write(r.join(".mdx-ide/templates/post.mdx"), "---\ntitle: ${title}\ndate: ${date}\nauthors: [${author}]\n---\n").unwrap();
        let ws = Workspace::open(r).unwrap();
        (dir, ws)
    }

    #[test]
    fn creates_pages_from_templates_without_overwriting() {
        let (_d, ws) = workspace();
        assert_eq!(ws.create_file("blog/2026/my-first_post.mdx", "2026-11-26").unwrap(), "blog/2026/my-first_post.mdx");
        let text = ws.read("blog/2026/my-first_post.mdx").unwrap();
        assert_eq!(text, "---\ntitle: My first post\ndate: 2026-11-26\nauthors: []\n---\n");
        assert!(ws.create_file("blog/2026/my-first_post.mdx", "x").unwrap_err().to_string().contains("already exists"));
        ws.create_file(" /intro.mdx ", "x").unwrap();
        assert_eq!(ws.read("intro.mdx").unwrap(), "# Intro\n");
    }

    #[test]
    fn creates_and_lists_folders_and_refuses_bad_names() {
        let (_d, ws) = workspace();
        ws.create_dir("guides/advanced").unwrap();
        assert_eq!(ws.directories(), vec!["guides", "guides/advanced"]);
        for bad in ["", "../up", "a/../b", ".hidden", "a/.git", "node_modules", "a:b", "guides"] {
            assert!(ws.create_dir(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(ws.create_file("notes.txt", "x").is_err());

        ws.create_deck("talks/team-demo.mdx").unwrap();
        let deck = ws.read("talks/team-demo.mdx").unwrap();
        assert!(deck.contains("type: slides") && deck.contains("# Team demo"), "{deck}");
        assert!(ws.analyze("talks/team-demo.mdx", &deck).diagnostics.is_empty());
        assert!(ws.create_deck("talks/team-demo.mdx").is_err());
        assert!(ws.create_file("../escape.mdx", "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_leave_the_workspace() {
        let (d, ws) = workspace();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("link")).unwrap();
        assert!(ws.create_file("link/x.mdx", "x").is_err());
        assert!(ws.create_dir("link/sub").is_err());
        assert!(!outside.path().join("x.mdx").exists() && !outside.path().join("sub").exists());
    }

    #[test]
    fn renames_and_moves_without_overwriting() {
        let (d, ws) = workspace();
        ws.create_file("a.mdx", "x").unwrap();
        ws.create_file("b.mdx", "x").unwrap();
        ws.create_dir("guides").unwrap();
        assert_eq!(ws.rename("a.mdx", "guides/intro.mdx").unwrap(), "guides/intro.mdx");
        assert!(ws.rename("b.mdx", "guides/intro.mdx").unwrap_err().to_string().contains("already exists"));
        assert_eq!(ws.read("guides/intro.mdx").unwrap(), "# A\n");
        // Folders move with their contents, but not into themselves.
        assert!(ws.rename("guides", "guides/sub").is_err());
        assert!(ws.rename("guides", "Guides/sub").is_err());
        ws.rename("guides", "docs/guides").unwrap();
        assert!(d.path().join("docs/guides/intro.mdx").is_file());
        // A change of letter case only.
        ws.rename("b.mdx", "B.mdx").unwrap();
        let names: Vec<_> = fs::read_dir(d.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(names.iter().any(|n| n == "B.mdx") && !names.iter().any(|n| n == "b.mdx"), "{names:?}");
    }

    #[test]
    fn protects_hidden_outside_and_non_mdx_entries() {
        let (d, ws) = workspace();
        ws.create_file("a.mdx", "x").unwrap();
        fs::write(d.path().join("notes.txt"), "x").unwrap();
        for bad in ["", ".", "..", "../x", ".mdx-ide", ".mdx-ide/config.toml", "notes.txt", "missing.mdx"] {
            assert!(ws.rename(bad, "z.mdx").is_err(), "rename {bad:?}");
            // `trash` shares the same validation, and fails before touching the disk.
            assert!(ws.trash(bad).is_err(), "trash {bad:?}");
        }
        for bad in ["a.txt", "../a.mdx", ".hidden.mdx", ""] {
            assert!(ws.rename("a.mdx", bad).is_err(), "rename to {bad:?}");
        }
        assert!(d.path().join("a.mdx").is_file() && d.path().join("notes.txt").is_file());
    }

    #[test]
    fn counts_hidden_files_too() {
        let (d, ws) = workspace();
        ws.create_file("g/a.mdx", "x").unwrap();
        fs::write(d.path().join("g/.env"), "x").unwrap();
        fs::write(d.path().join("g/logo.png"), "x").unwrap();
        assert_eq!(ws.file_count("g").unwrap(), 3);
        assert_eq!(ws.file_count("g/a.mdx").unwrap(), 1);
    }

    #[test]
    fn yaml_titles_are_quoted_when_needed() {
        assert_eq!(yaml_string("Getting started"), "Getting started");
        assert_eq!(yaml_string("2026 plan"), "\"2026 plan\"");
        assert_eq!(yaml_string("True"), "\"True\"");
    }
}
