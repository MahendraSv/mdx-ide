//! Debounced file watching. Emits `workspace://changed` with the changed
//! `.mdx` paths, and reloads the team config when `.mdx-ide/` changes.

use std::path::PathBuf;
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebouncedEventBatch, DebouncedEventKind, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

pub type WatcherHandle = Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedPayload {
    paths: Vec<String>,
    config_changed: bool,
}

pub fn watch(app: AppHandle, root: PathBuf) -> notify_debouncer_mini::notify::Result<WatcherHandle> {
    let root_for_cb = root.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(250), move |res: notify_debouncer_mini::DebounceEventResult| {
        let mut paths = Vec::new();
        let mut config_changed = false;
        let mut folders_changed = false;
        // A commit, checkout or staging done elsewhere: the Git panel needs a refresh.
        let mut git_changed = false;
        let events = match res {
            Ok(DebouncedEventBatch::Events(events)) => events,
            // Missed events (or a future variant): refresh everything.
            Ok(_) => {
                config_changed = true;
                Vec::new()
            }
            Err(_) => return,
        };
        for e in events.iter().filter(|e| matches!(e.kind, DebouncedEventKind::Any | DebouncedEventKind::AnyContinuous)) {
            let Ok(rel) = e.path.strip_prefix(&root_for_cb) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel == ".git/HEAD" || rel == ".git/index" || rel.starts_with(".git/refs/") {
                git_changed = true;
            }
            if rel.starts_with(".git/") || rel.contains("node_modules/") || rel.ends_with(".mdx-ide-tmp") {
                continue;
            }
            if rel.starts_with(".mdx-ide/") {
                config_changed = true;
            } else if rel.ends_with(".mdx") {
                paths.push(rel);
            } else if !rel.starts_with("target/") && (e.path.is_dir() || e.path.extension().is_none()) {
                // A folder added, renamed or removed: the explorer needs a fresh listing.
                folders_changed = true;
            }
        }
        if config_changed {
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut guard) = state.workspace.lock() {
                    if let Some(ws) = guard.as_mut() {
                        let _ = ws.reload_config();
                    }
                }
            }
        }
        if config_changed || folders_changed || git_changed || !paths.is_empty() {
            paths.sort();
            paths.dedup();
            let _ = app.emit("workspace://changed", ChangedPayload { paths, config_changed });
        }
    })?;
    debouncer.watcher().watch(&root, RecursiveMode::Recursive)?;
    Ok(debouncer)
}
