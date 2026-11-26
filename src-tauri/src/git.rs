//! Git IPC commands. git runs on a blocking thread, without holding the workspace lock.

use std::path::PathBuf;

use mdx_git::{Blame, Branch, FileDiff, GitError, Pushed, Repo, Status};
use serde::Serialize;
use tauri::State;

use crate::AppState;

type CmdResult<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Absolute path of the repository.
    repo_root: String,
    /// The open folder inside the repository (`""`, or e.g. `"website/docs/"`). File paths in
    /// `status` are relative to the repository.
    workspace_prefix: String,
    #[serde(flatten)]
    status: Status,
}

fn workspace_root(state: &State<'_, AppState>) -> CmdResult<PathBuf> {
    let guard = state.workspace.lock().map_err(|e| e.to_string())?;
    Ok(guard.as_ref().ok_or("No folder is open")?.root().to_path_buf())
}

/// Run `work` against the repository containing the open folder.
async fn with_repo<T: Send + 'static>(
    state: State<'_, AppState>,
    work: impl FnOnce(Repo, PathBuf) -> Result<T, GitError> + Send + 'static,
) -> CmdResult<T> {
    let workspace = workspace_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = Repo::discover(&workspace).map_err(|e| e.to_string())?.ok_or("This folder is not in a Git repository")?;
        work(repo, workspace).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The open folder relative to the repository, with a trailing `/` unless empty.
fn prefix(repo: &Repo, workspace: &std::path::Path) -> String {
    let canonical = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let relative =
        canonical(workspace).strip_prefix(canonical(repo.root())).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    if relative.is_empty() {
        relative
    } else {
        format!("{relative}/")
    }
}

/// `None` when the open folder is not in a repository.
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> CmdResult<Option<GitStatus>> {
    let workspace = workspace_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(repo) = Repo::discover(&workspace).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let status = repo.status().map_err(|e| e.to_string())?;
        Ok(Some(GitStatus { repo_root: repo.root().display().to_string(), workspace_prefix: prefix(&repo, &workspace), status }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(state: State<'_, AppState>, paths: Vec<String>) -> CmdResult<()> {
    with_repo(state, move |repo, _| repo.stage(&paths)).await
}

#[tauri::command]
pub async fn git_unstage(state: State<'_, AppState>, paths: Vec<String>) -> CmdResult<()> {
    with_repo(state, move |repo, _| repo.unstage(&paths)).await
}

#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, message: String) -> CmdResult<String> {
    with_repo(state, move |repo, _| repo.commit(&message)).await
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>) -> CmdResult<Vec<Branch>> {
    with_repo(state, |repo, _| repo.branches()).await
}

#[tauri::command]
pub async fn git_switch(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    with_repo(state, move |repo, _| repo.switch(&name)).await
}

#[tauri::command]
pub async fn git_create_branch(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    with_repo(state, move |repo, _| repo.create_branch(&name)).await
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>) -> CmdResult<()> {
    with_repo(state, |repo, _| repo.fetch()).await
}

/// Fast-forward only. Returns the number of commits received.
#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>) -> CmdResult<u32> {
    with_repo(state, |repo, _| repo.pull()).await
}

/// Push the current branch, publishing it if it is new. Never forces.
#[tauri::command]
pub async fn git_push(state: State<'_, AppState>) -> CmdResult<Pushed> {
    with_repo(state, |repo, _| repo.push()).await
}

/// `path` is relative to the repository.
#[tauri::command]
pub async fn git_diff(state: State<'_, AppState>, path: String, staged: bool) -> CmdResult<FileDiff> {
    with_repo(state, move |repo, _| repo.diff(&path, staged)).await
}

/// `path` is relative to the open folder; `contents` is the editor's text.
#[tauri::command]
pub async fn git_blame(state: State<'_, AppState>, path: String, contents: String) -> CmdResult<Blame> {
    with_repo(state, move |repo, workspace| {
        let path = format!("{}{path}", prefix(&repo, &workspace));
        repo.blame(&path, &contents)
    })
    .await
}
