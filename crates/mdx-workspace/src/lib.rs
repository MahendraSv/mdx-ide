//! A workspace = a docs repository opened in the IDE.
//!
//! Owns the team config and component manifest, discovers `.mdx` files
//! (respecting `.gitignore`), runs full per-document analysis (syntax +
//! components + frontmatter + links), searches, and saves atomically.
//!
//! File watching lives in the Tauri layer (it needs to emit UI events); it
//! calls [`Workspace::reload_config`] when anything under `.mdx-ide/` changes.

pub mod config;
mod files;
mod relink;
mod search;

use std::path::{Path, PathBuf};

use globset::Glob;
use mdx_core::{Diagnostic, DiagnosticSource, DocumentAnalysis, Severity};
use mdx_intel::links::LinkContext;
use mdx_intel::ComponentManifest;
use serde::Serialize;

pub use config::WorkspaceConfig;
pub use relink::{RelinkedFile, RenameReport};
pub use search::{SearchHit, SearchOptions};

/// Translate an mdxlint rc file (`{"plugins": [...], "settings": {...}}`, the same shape as `.remarkrc.json`)
/// into `--use` / `--setting` CLI arguments.
///
/// unified-engine resolves plugin names relative to the rc file, so a team rc committed to the docs
/// repo could not find the plugins installed next to the bundled mdxlint. Passing them as `--use`
/// resolves them from the mdxlint install instead. Plugin options must be objects (a CLI limitation).
pub fn rc_to_args(json: &str) -> Result<Vec<String>, String> {
    use serde_json::Value;
    let rc: Value = serde_json::from_str(json).map_err(|e| format!("invalid mdxlint config: {e}"))?;
    // `{"a":1}` → `"a":1` (unified-args wraps the value in braces itself).
    let inner = |v: &Value| -> Option<String> {
        let o = v.as_object().filter(|o| !o.is_empty())?;
        let s = Value::Object(o.clone()).to_string();
        Some(s[1..s.len() - 1].to_owned())
    };
    let mut args = Vec::new();
    for plugin in rc.get("plugins").and_then(Value::as_array).into_iter().flatten() {
        let (name, opts) = match plugin {
            Value::String(n) => (n.as_str(), None),
            Value::Array(a) => (a.first().and_then(Value::as_str).ok_or("plugin entries must start with a name")?, a.get(1)),
            _ => return Err("plugin entries must be a name or [name, options]".into()),
        };
        match opts {
            None | Some(Value::Bool(true)) | Some(Value::Null) => args.extend(["-u".into(), name.to_owned()]),
            Some(Value::Bool(false)) => {} // rule switched off
            Some(o) if o.is_object() => match inner(o) {
                Some(body) => args.extend(["-u".into(), format!("{name}={body}")]),
                None => args.extend(["-u".into(), name.to_owned()]),
            },
            Some(_) => return Err(format!("options for {name} must be true, false or an object")),
        }
    }
    if let Some(body) = rc.get("settings").and_then(inner) {
        args.extend(["-s".into(), body]);
    }
    Ok(args)
}

/// Convert `mdxlint --report json` output into diagnostics.
///
/// unified positions count characters; our `Point.offset` counts UTF-8 bytes (what the editor expects).
/// Fatal messages are skipped: those are parse errors, which the syntax check already reports.
pub fn parse_mdxlint_report(json: &str, source: &str) -> Result<Vec<Diagnostic>, String> {
    let files: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("unreadable mdxlint report: {e}"))?;
    let byte_offset = |chars: usize| source.char_indices().nth(chars).map_or(source.len(), |(i, _)| i);
    let point = |p: &serde_json::Value| {
        Some(mdx_core::Point {
            line: p.get("line")?.as_u64()? as usize,
            column: p.get("column")?.as_u64()? as usize,
            offset: byte_offset(p.get("offset")?.as_u64()? as usize),
        })
    };
    let mut out = Vec::new();
    for m in files.get(0).and_then(|f| f.get("messages")).and_then(|m| m.as_array()).into_iter().flatten() {
        if m.get("fatal").and_then(|f| f.as_bool()).unwrap_or(false) {
            continue;
        }
        let place = m.get("place");
        let range = place
            .and_then(|p| Some(mdx_core::Range { start: point(p.get("start")?)?, end: point(p.get("end").or(p.get("start"))?)? }));
        let rule = m.get("ruleId").and_then(|r| r.as_str()).unwrap_or("mdxlint");
        let reason = m.get("reason").and_then(|r| r.as_str()).unwrap_or("");
        out.push(Diagnostic::new(DiagnosticSource::Mdxlint, Severity::Warning, rule, reason, range));
    }
    Ok(out)
}

/// `My Shot (1).PNG` → (`my-shot-1`, `png`). Pasted images often have no name (`image.png`).
fn sanitize_file_name(name: &str) -> (String, String) {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let (stem, ext) = base.rsplit_once('.').unwrap_or((base, "png"));
    let mut clean = String::new();
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            clean.push(ch.to_ascii_lowercase());
        } else if !clean.ends_with('-') {
            clean.push('-');
        }
    }
    let clean = clean.trim_matches('-');
    (if clean.is_empty() { "image".into() } else { clean.to_owned() }, ext.to_ascii_lowercase())
}

/// Path from directory `from` to file `to`, both workspace-relative, using `/` separators.
fn relative_path(from: &Path, to: PathBuf) -> String {
    let f: Vec<_> = from.components().collect();
    let t: Vec<_> = to.components().collect();
    let common = f.iter().zip(&t).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); f.len() - common];
    parts.extend(t[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    if parts.first().is_some_and(|p| p != "..") {
        parts.insert(0, ".".into());
    }
    parts.join("/")
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Config(#[from] config::ConfigError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("path is outside the workspace: {0}")]
    OutsideWorkspace(String),
    #[error("invalid search pattern: {0}")]
    Pattern(#[from] regex::Error),
}

pub struct Workspace {
    root: PathBuf,
    pub config: WorkspaceConfig,
    pub manifest: Option<ComponentManifest>,
    /// Problems with the config / manifest / schemas themselves.
    pub config_diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    /// Path relative to the workspace root, `/`-separated.
    pub path: String,
    pub size: u64,
}

impl Workspace {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
        let root = root.as_ref().canonicalize()?;
        let mut ws = Self { config: WorkspaceConfig::default(), root, manifest: None, config_diagnostics: vec![] };
        ws.reload_config()?;
        Ok(ws)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// (Re)load `.mdx-ide/config.toml` and the component manifest.
    pub fn reload_config(&mut self) -> Result<(), WorkspaceError> {
        self.config = WorkspaceConfig::load(&self.root)?;
        self.config_diagnostics.clear();
        self.manifest = match &self.config.component_manifest {
            Some(rel) if self.root.join(rel).exists() => match ComponentManifest::load(&self.root.join(rel)) {
                Ok(m) => Some(m),
                Err(e) => {
                    self.config_diagnostics.push(e.to_string());
                    None
                }
            },
            _ => None,
        };
        // A mistyped preview path would otherwise silently fall back to the demo components.
        let preview = &self.config.preview;
        for rel in preview.components_bundle.iter().chain(&preview.css) {
            if !self.root.join(rel).is_file() {
                self.config_diagnostics.push(format!("preview file not found: {}", rel.display()));
            }
        }
        Ok(())
    }

    /// Resolve a workspace-relative path, refusing anything that escapes the root.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, WorkspaceError> {
        let candidate = self.root.join(rel);
        let parent = candidate.parent().ok_or_else(|| WorkspaceError::OutsideWorkspace(rel.into()))?;
        let canonical_parent = parent.canonicalize()?;
        if !canonical_parent.starts_with(&self.root) {
            return Err(WorkspaceError::OutsideWorkspace(rel.into()));
        }
        Ok(canonical_parent.join(candidate.file_name().ok_or_else(|| WorkspaceError::OutsideWorkspace(rel.into()))?))
    }

    pub fn relative(&self, abs: &Path) -> String {
        abs.strip_prefix(&self.root).unwrap_or(abs).to_string_lossy().replace('\\', "/")
    }

    /// All `.mdx` files, respecting `.gitignore`, sorted by path.
    pub fn mdx_files(&self) -> Vec<FileEntry> {
        let mut files: Vec<FileEntry> = ignore::WalkBuilder::new(&self.root)
            .hidden(true)
            .build()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .filter(|e| e.path().extension().is_some_and(|x| x == "mdx"))
            .map(|e| FileEntry { path: self.relative(e.path()), size: e.metadata().map(|m| m.len()).unwrap_or(0) })
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files
    }

    pub fn read(&self, rel: &str) -> Result<String, WorkspaceError> {
        Ok(std::fs::read_to_string(self.resolve(rel)?)?)
    }

    /// Write via temp file + rename, so a crash never leaves a half-written doc.
    pub fn write(&self, rel: &str, contents: &str) -> Result<(), WorkspaceError> {
        let path = self.resolve(rel)?;
        let tmp = path.with_file_name(format!(".{}.mdx-ide-tmp", path.file_name().unwrap_or_default().to_string_lossy()));
        std::fs::write(&tmp, contents)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Copy a pasted / dropped image into `assets_dir` and return the path to put in the
    /// document, relative to `doc_rel` (e.g. `../../static/img/shot.png`).
    pub fn save_asset(&self, doc_rel: &str, file_name: &str, bytes: &[u8]) -> Result<String, WorkspaceError> {
        const MAX_BYTES: usize = 25 * 1024 * 1024;
        const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
        if bytes.len() > MAX_BYTES {
            return Err(WorkspaceError::Io(std::io::Error::other("image is larger than 25 MB")));
        }
        let (stem, ext) = sanitize_file_name(file_name);
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            return Err(WorkspaceError::Io(std::io::Error::other(format!("unsupported image type: .{ext}"))));
        }

        let assets_rel = &self.config.assets_dir;
        if assets_rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(WorkspaceError::OutsideWorkspace(assets_rel.display().to_string()));
        }
        let dir = self.root.join(assets_rel);
        std::fs::create_dir_all(&dir)?;
        if !dir.canonicalize()?.starts_with(&self.root) {
            return Err(WorkspaceError::OutsideWorkspace(assets_rel.display().to_string()));
        }

        // Never overwrite: shot.png, shot-1.png, shot-2.png, ...
        let mut target = dir.join(format!("{stem}.{ext}"));
        let mut n = 0;
        while target.exists() {
            n += 1;
            target = dir.join(format!("{stem}-{n}.{ext}"));
        }
        std::fs::write(&target, bytes)?;

        let doc_dir = Path::new(doc_rel).parent().unwrap_or(Path::new(""));
        Ok(relative_path(doc_dir, assets_rel.join(target.file_name().unwrap_or_default())))
    }

    pub fn search(&self, opts: &SearchOptions) -> Result<Vec<SearchHit>, WorkspaceError> {
        search::search(self, opts)
    }

    /// The JSON Schema rule for a document, if any.
    pub fn schema_rule_for(&self, rel: &str) -> Option<&config::SchemaRule> {
        self.config.schemas.iter().find(|r| Glob::new(&r.files).ok().is_some_and(|g| g.compile_matcher().is_match(rel)))
    }

    pub fn schema_for(&self, rel: &str) -> Option<Result<serde_json::Value, String>> {
        let rule = self.schema_rule_for(rel)?;
        let path = self.root.join(&rule.schema);
        Some(
            std::fs::read_to_string(&path)
                .map_err(|e| format!("{}: {e}", path.display()))
                .and_then(|t| serde_json::from_str(&t).map_err(|e| format!("{}: {e}", path.display()))),
        )
    }

    /// Full analysis of one document's (possibly unsaved) contents.
    pub fn analyze(&self, rel: &str, source: &str) -> DocumentAnalysis {
        let mut analysis = mdx_syntax::analyze(source);
        let syntax_ok = !analysis.diagnostics.iter().any(|d| d.source == DiagnosticSource::Syntax);
        if !self.config.lint.a11y {
            analysis.diagnostics.retain(|d| d.source != DiagnosticSource::A11y);
        }
        if !syntax_ok {
            return analysis;
        }

        if self.config.lint.check_components {
            if let Some(manifest) = &self.manifest {
                analysis.diagnostics.extend(manifest.check(&analysis.components, &analysis.imported_names));
            }
        }

        match self.schema_for(rel) {
            Some(Ok(schema)) => analysis.diagnostics.extend(mdx_intel::frontmatter::validate(analysis.frontmatter.as_ref(), &schema)),
            Some(Err(e)) => analysis.diagnostics.push(Diagnostic::new(
                DiagnosticSource::Frontmatter,
                Severity::Warning,
                "frontmatter-schema-missing",
                format!("Could not load frontmatter schema: {e}"),
                None,
            )),
            None => {}
        }

        if self.config.lint.check_links {
            if let Ok(doc) = self.resolve(rel) {
                let cx = LinkContext {
                    root: &self.root,
                    document: &doc,
                    static_dirs: &self.config.static_dirs,
                    content_dirs: &self.config.content_dirs,
                };
                // TODO(index): back this with the persistent workspace index instead of re-parsing.
                let outline_of = |p: &Path| {
                    let text = std::fs::read_to_string(p).ok()?;
                    Some(mdx_syntax::analyze(&text).outline.into_iter().map(|o| o.slug).collect())
                };
                analysis.diagnostics.extend(mdx_intel::links::check(&analysis.links, &analysis.outline, &cx, &outline_of));
            }
        }
        analysis
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        fs::create_dir_all(r.join(".mdx-ide/schemas")).unwrap();
        fs::create_dir_all(r.join("docs/blog")).unwrap();
        fs::create_dir_all(r.join("node_modules/pkg")).unwrap();
        fs::write(r.join(".gitignore"), "node_modules\n").unwrap();
        fs::write(r.join("node_modules/pkg/readme.mdx"), "# ignored").unwrap();
        fs::write(
            r.join(".mdx-ide/config.toml"),
            "content_dirs = [\"docs\"]\n[[schemas]]\nfiles = \"docs/blog/**/*.mdx\"\nschema = \".mdx-ide/schemas/blog.schema.json\"\n",
        )
        .unwrap();
        fs::write(r.join(".mdx-ide/schemas/blog.schema.json"), r#"{"type":"object","required":["title"]}"#).unwrap();
        fs::write(
            r.join(".mdx-ide/component-manifest.json"),
            r#"{"components":[{"name":"Callout","props":[{"name":"type","values":["info"]}]}]}"#,
        )
        .unwrap();
        fs::write(r.join("docs/intro.mdx"), "# Intro\n\nSee [post](./blog/post.mdx).\n").unwrap();
        fs::write(r.join("docs/blog/post.mdx"), "---\nauthor: me\n---\n\n<Callout type=\"warn\">x</Callout>\n").unwrap();
        // `.git` is not present, so tell `ignore` to still honour .gitignore.
        fs::create_dir_all(r.join(".git")).unwrap();
        let ws = Workspace::open(r).unwrap();
        (dir, ws)
    }

    #[test]
    fn saves_assets_with_relative_path_and_no_overwrite() {
        let (d, ws) = setup(); // default assets_dir
        let dir = ws.config.assets_dir.clone();
        let a = ws.save_asset("docs/blog/post.mdx", "My Shot (1).PNG", b"x").unwrap();
        let b = ws.save_asset("docs/blog/post.mdx", "My Shot (1).PNG", b"y").unwrap();
        assert!(a.starts_with("../../") && a.ends_with("/my-shot-1.png"), "{a}");
        assert!(b.ends_with("/my-shot-1-1.png"), "{b}");
        assert!(d.path().join(&dir).join("my-shot-1.png").exists());
        assert!(ws.save_asset("docs/intro.mdx", "evil.exe", b"x").is_err());
        assert_eq!(relative_path(Path::new(""), PathBuf::from("img/a.png")), "./img/a.png");
    }

    #[test]
    fn converts_rc_to_cli_args() {
        let args = rc_to_args(
            r#"{"plugins":["remark-gfm",["a",true],["b",false],["c",{"x":true}]],"settings":{"bullet":"-"}}"#,
        )
        .unwrap();
        assert_eq!(args, ["-u", "remark-gfm", "-u", "a", "-u", "c=\"x\":true", "-s", "\"bullet\":\"-\""]);
        assert!(rc_to_args(r#"{"plugins":[["a",80]]}"#).is_err());
    }

    #[test]
    fn parses_mdxlint_report_with_byte_offsets() {
        // "é" is 2 bytes, so char offset 5 → byte offset 6.
        let json = r#"[{"messages":[
            {"line":1,"column":6,"fatal":false,"ruleId":"heading-increment","reason":"skipped",
             "place":{"start":{"line":1,"column":6,"offset":5},"end":{"line":1,"column":8,"offset":7}}},
            {"fatal":true,"reason":"parse error","ruleId":null}]}]"#;
        let d = parse_mdxlint_report(json, "héllo world").unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].rule, "heading-increment");
        assert_eq!(d[0].range.unwrap().start.offset, 6);
        assert!(parse_mdxlint_report("nope", "").is_err());
    }

    #[test]
    fn reports_missing_preview_files() {
        let (d, mut ws) = setup();
        assert!(ws.config_diagnostics.is_empty());
        std::fs::write(d.path().join(".mdx-ide/config.toml"), "[preview]\ncomponents_bundle = \"dist/nope.js\"\n").unwrap();
        ws.reload_config().unwrap();
        assert_eq!(ws.config_diagnostics, vec!["preview file not found: dist/nope.js"]);
    }

    #[test]
    fn lists_mdx_respecting_gitignore() {
        let (_d, ws) = setup();
        let paths: Vec<_> = ws.mdx_files().into_iter().map(|f| f.path).collect();
        assert_eq!(paths, vec!["docs/blog/post.mdx", "docs/intro.mdx"]);
    }

    #[test]
    fn full_analysis() {
        let (_d, ws) = setup();
        assert!(ws.analyze("docs/intro.mdx", &ws.read("docs/intro.mdx").unwrap()).diagnostics.is_empty());
        let post = ws.analyze("docs/blog/post.mdx", &ws.read("docs/blog/post.mdx").unwrap());
        let mut rules: Vec<_> = post.diagnostics.iter().map(|d| d.rule.as_str()).collect();
        rules.sort();
        assert_eq!(rules, vec!["frontmatter-schema", "invalid-prop-value"]);
    }

    #[test]
    fn refuses_escape_and_saves_atomically() {
        let (_d, ws) = setup();
        assert!(matches!(ws.resolve("../outside.mdx"), Err(WorkspaceError::OutsideWorkspace(_))));
        ws.write("docs/intro.mdx", "# Changed\n").unwrap();
        assert_eq!(ws.read("docs/intro.mdx").unwrap(), "# Changed\n");
    }

    #[test]
    fn search_works() {
        let (_d, ws) = setup();
        let hits = ws.search(&SearchOptions { query: "callout".into(), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "docs/blog/post.mdx");
        assert_eq!(hits[0].line, 5);
    }
}
