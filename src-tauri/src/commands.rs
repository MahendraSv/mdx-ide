//! IPC commands. Errors are returned as strings for the UI to display.

use std::collections::HashMap;

use mdx_compile::{CompileOptions, CompileOutput};
use mdx_core::{Diagnostic, DocumentAnalysis};
use mdx_intel::completion::{self, CompletionItem};
use mdx_intel::ComponentManifest;
use mdx_workspace::{FileEntry, RenameReport, SearchHit, SearchOptions, Workspace};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{watcher, AppState};

type CmdResult<T> = Result<T, String>;

fn with_ws<T>(state: &State<'_, AppState>, f: impl FnOnce(&Workspace) -> CmdResult<T>) -> CmdResult<T> {
    let guard = state.workspace.lock().map_err(|e| e.to_string())?;
    let ws = guard.as_ref().ok_or("No folder is open")?;
    f(ws)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    root: String,
    files: Vec<FileEntry>,
    dirs: Vec<String>,
    manifest: Option<ComponentManifest>,
    config_problems: Vec<String>,
    format_on_save: bool,
    mdxlint_rules: bool,
}

fn info(ws: &Workspace) -> WorkspaceInfo {
    WorkspaceInfo {
        root: ws.root().display().to_string(),
        files: ws.mdx_files(),
        dirs: ws.directories(),
        manifest: ws.manifest.clone(),
        config_problems: ws.config_diagnostics.clone(),
        format_on_save: ws.config.lint.format_on_save,
        mdxlint_rules: ws.config.lint.mdxlint_rules,
    }
}

#[tauri::command]
pub fn initial_folder(state: State<'_, AppState>) -> Option<String> {
    state.initial_folder.clone()
}

#[tauri::command]
pub fn open_workspace(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<WorkspaceInfo> {
    let ws = Workspace::open(&path).map_err(|e| e.to_string())?;
    let result = info(&ws);
    let handle = watcher::watch(app, ws.root().to_path_buf()).map_err(|e| e.to_string())?;
    *state.watcher.lock().map_err(|e| e.to_string())? = Some(handle);
    *state.workspace.lock().map_err(|e| e.to_string())? = Some(ws);
    Ok(result)
}

#[tauri::command]
pub fn list_files(state: State<'_, AppState>) -> CmdResult<WorkspaceInfo> {
    with_ws(&state, |ws| Ok(info(ws)))
}

#[tauri::command]
pub fn read_file(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    with_ws(&state, |ws| ws.read(&path).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn write_file(state: State<'_, AppState>, path: String, contents: String) -> CmdResult<()> {
    if !path.ends_with(".mdx") {
        return Err("MDX IDE only writes .mdx files".into());
    }
    with_ws(&state, |ws| ws.write(&path, &contents).map_err(|e| e.to_string()))
}

/// Create a page (from the collection's template, if any). Returns its relative path.
#[tauri::command]
pub fn create_file(state: State<'_, AppState>, path: String, date: String) -> CmdResult<String> {
    with_ws(&state, |ws| ws.create_file(&path, &date).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn create_folder(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    with_ws(&state, |ws| ws.create_dir(&path).map_err(|e| e.to_string()))
}

/// Rename or move a page or folder, updating the links affected by it.
/// `unsaved` maps open pages with unsaved changes to their editor text.
#[tauri::command]
pub async fn rename_entry(state: State<'_, AppState>, from: String, to: String, unsaved: HashMap<String, String>) -> CmdResult<RenameReport> {
    with_ws(&state, |ws| ws.rename_updating_links(&from, &to, &unsaved).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn trash_entry(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    with_ws(&state, |ws| ws.trash(&path).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn entry_file_count(state: State<'_, AppState>, path: String) -> CmdResult<usize> {
    with_ws(&state, |ws| ws.file_count(&path).map_err(|e| e.to_string()))
}

/// Full analysis: outline, links, components, frontmatter and all diagnostics.
#[tauri::command]
pub async fn analyze(state: State<'_, AppState>, path: String, source: String) -> CmdResult<DocumentAnalysis> {
    with_ws(&state, |ws| Ok(ws.analyze(&path, &source)))
}

/// Compile for the live preview. A compile error is a normal result, not an IPC error.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum PreviewResult {
    Ok(CompileOutput),
    Error { diagnostic: Diagnostic },
}

#[tauri::command]
pub async fn compile_preview(path: String, source: String) -> CmdResult<PreviewResult> {
    let opts = CompileOptions { filepath: Some(path), source_lines: true };
    Ok(match mdx_compile::compile(&source, &opts) {
        Ok(out) => PreviewResult::Ok(out),
        Err(diagnostic) => PreviewResult::Error { diagnostic },
    })
}

#[tauri::command]
pub fn search(state: State<'_, AppState>, options: SearchOptions) -> CmdResult<Vec<SearchHit>> {
    with_ws(&state, |ws| ws.search(&options).map_err(|e| e.to_string()))
}

fn manifest_or_empty(ws: &Workspace) -> ComponentManifest {
    ws.manifest.clone().unwrap_or_default()
}

#[tauri::command]
pub fn complete_components(state: State<'_, AppState>) -> CmdResult<Vec<CompletionItem>> {
    with_ws(&state, |ws| Ok(completion::components(&manifest_or_empty(ws))))
}

#[tauri::command]
pub fn complete_props(state: State<'_, AppState>, component: String, already: Vec<String>) -> CmdResult<Vec<CompletionItem>> {
    with_ws(&state, |ws| Ok(completion::props(&manifest_or_empty(ws), &component, &already)))
}

#[tauri::command]
pub fn complete_prop_values(state: State<'_, AppState>, component: String, prop: String) -> CmdResult<Vec<CompletionItem>> {
    with_ws(&state, |ws| Ok(completion::prop_values(&manifest_or_empty(ws), &component, &prop)))
}

/// JSON Schema for the document's collection; drives the frontmatter form.
#[tauri::command]
pub fn frontmatter_schema(state: State<'_, AppState>, path: String) -> CmdResult<Option<serde_json::Value>> {
    with_ws(&state, |ws| ws.schema_for(&path).transpose().map_err(|e| e.to_string()))
}

/// Copy a pasted / dropped image into the configured assets folder.
/// Returns the path to insert in the document, relative to the document.
#[tauri::command]
pub fn save_asset(state: State<'_, AppState>, path: String, file_name: String, bytes: Vec<u8>) -> CmdResult<String> {
    with_ws(&state, |ws| ws.save_asset(&path, &file_name, &bytes).map_err(|e| e.to_string()))
}

/// Sidecar location in a source checkout; packaged builds will bundle it as a resource.
const SIDECAR_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecars/mdxlint");

enum Run {
    Format,
    Lint,
}

/// Run the `mdxlint` Node sidecar over `source` and return its stdout.
/// Prefers the repo's own mdxlint (pinned by the team), else the bundled sidecar.
fn run_mdxlint(state: &State<'_, AppState>, run: Run, path: &str, source: &str) -> CmdResult<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let (root, rc_override) = with_ws(state, |ws| Ok((ws.root().to_path_buf(), ws.config.lint.mdxlint_config.clone())))?;
    let sidecar = std::path::Path::new(SIDECAR_DIR);

    let bin = [root.join("node_modules/.bin/mdxlint"), sidecar.join("node_modules/.bin/mdxlint")]
        .into_iter()
        .find(|p| p.exists())
        .ok_or("mdxlint is not installed. Run `pnpm install` in sidecars/mdxlint, or add mdxlint to the repo.")?;
    // Format: the configured rc, `.mdx-ide/mdxlintrc.json`, then the bundled one.
    // Lint: `.mdx-ide/mdxlint-rules.json`, then the bundled rule set.
    let candidates: Vec<std::path::PathBuf> = match run {
        Run::Format => rc_override
            .map(|p| root.join(p))
            .into_iter()
            .chain([root.join(".mdx-ide/mdxlintrc.json"), sidecar.join("default-rc.json")])
            .collect(),
        Run::Lint => vec![root.join(".mdx-ide/mdxlint-rules.json"), sidecar.join("lint-rc.json")],
    };
    let rc = candidates.into_iter().find(|p| p.exists()).ok_or("no mdxlint config found")?;
    // unified-engine resolves plugin and reporter names from the working directory, so run from the
    // package that owns the mdxlint binary (`<home>/node_modules/.bin/mdxlint`): the repo's own
    // install uses the repo's plugins, the bundled one uses the sidecar's.
    let home = bin.ancestors().nth(3).map(|p| p.to_path_buf()).unwrap_or_else(|| root.clone());

    let rc_text = std::fs::read_to_string(&rc).map_err(|e| format!("could not read {}: {e}", rc.display()))?;
    let rc_args = mdx_workspace::rc_to_args(&rc_text).map_err(|e| format!("{}: {e}", rc.display()))?;

    let mut cmd = Command::new(&bin);
    cmd.args(["--no-config", "--no-ignore", "--color=false"]).args(rc_args).arg("--file-path").arg(path);
    match run {
        Run::Format => cmd.arg("--quiet"),
        Run::Lint => cmd.args(["--report", "json", "--no-stdout"]),
    };
    let mut child = cmd
        .current_dir(&home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start mdxlint (is Node installed?): {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let input = source.to_owned();
    // Write on a thread so a large document can't deadlock against the stdout pipe.
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = writer.join();
    // `--report json` writes the report to stderr and exits 0 unless the file has fatal messages.
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    match run {
        Run::Format if !out.status.success() => Err(format!("mdxlint failed: {}", stderr.trim())),
        Run::Format => String::from_utf8(out.stdout).map_err(|e| e.to_string()),
        Run::Lint if stderr.trim_start().starts_with('[') => Ok(stderr),
        Run::Lint => Err(format!("mdxlint failed: {}", stderr.trim())),
    }
}

/// Format a document with `mdxlint` (Node sidecar). Returns the formatted text.
/// Errors (Node or mdxlint missing, invalid rc, syntax error) are returned so the UI can
/// still save the unformatted file.
#[tauri::command]
pub async fn format_mdx(state: State<'_, AppState>, path: String, source: String) -> CmdResult<String> {
    let formatted = run_mdxlint(&state, Run::Format, &path, &source)?;
    // Never replace a document with nothing.
    if formatted.trim().is_empty() && !source.trim().is_empty() {
        return Err("mdxlint returned an empty document; keeping your text".into());
    }
    Ok(formatted)
}

/// Style / consistency rules (remark-lint via mdxlint) for the Problems panel.
#[tauri::command]
pub async fn lint_mdx(state: State<'_, AppState>, path: String, source: String) -> CmdResult<Vec<Diagnostic>> {
    let report = run_mdxlint(&state, Run::Lint, &path, &source)?;
    mdx_workspace::parse_mdxlint_report(&report, &source)
}
