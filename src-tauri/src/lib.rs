//! Tauri shell: IPC commands, file watching and the sandboxed preview protocol.
//!
//! The heavy lifting lives in `crates/`; this layer only adapts it to IPC.

mod commands;
mod export;
mod git;
mod preview_protocol;
mod watcher;

use std::sync::Mutex;

use mdx_workspace::Workspace;
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
const QUIT_ID: &str = "quit";

/// The native macOS "Quit" item terminates the process without asking the window. Replace it
/// with an item that closes the window instead, so the UI can warn about unsaved files.
#[cfg(target_os = "macos")]
fn guarded_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        // `Menu::default` puts Quit last in the application submenu.
        let count = app_menu.items()?.len();
        app_menu.remove_at(count.saturating_sub(1))?;
        app_menu.append(&MenuItem::with_id(app, QUIT_ID, "Quit MDX IDE", true, Some("CmdOrCtrl+Q"))?)?;
    }
    Ok(menu)
}

#[derive(Default)]
pub struct AppState {
    pub workspace: Mutex<Option<Workspace>>,
    pub watcher: Mutex<Option<watcher::WatcherHandle>>,
    /// The page the hidden PDF export window is printing.
    pub print_document: Mutex<Option<String>>,
    /// Held for the duration of an export.
    pub exporting: tauri::async_runtime::Mutex<()>,
    /// Folder passed on the command line: `mdx-ide path/to/docs-repo`.
    pub initial_folder: Option<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(guarded_menu).on_menu_event(|app, event| {
        if event.id() == QUIT_ID {
            match app.get_webview_window("main") {
                Some(window) => {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    let _ = window.close(); // emits "close requested"; see ui/src/App.tsx
                }
                None => app.exit(0),
            }
        }
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { initial_folder: std::env::args().skip(1).find(|a| !a.starts_with('-')), ..Default::default() })
        // Preview iframe content is served from its own origin so it can never
        // reach the app's IPC. See preview_protocol.rs.
        .register_uri_scheme_protocol(preview_protocol::SCHEME, preview_protocol::handle)
        .invoke_handler(tauri::generate_handler![
            commands::initial_folder,
            commands::open_workspace,
            commands::list_files,
            commands::read_file,
            commands::write_file,
            commands::create_file,
            commands::create_folder,
            commands::rename_entry,
            commands::trash_entry,
            commands::entry_file_count,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_branches,
            git::git_switch,
            git::git_create_branch,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_diff,
            git::git_blame,
            commands::analyze,
            commands::compile_preview,
            commands::search,
            commands::slide_components,
            commands::complete_components,
            commands::complete_props,
            commands::complete_prop_values,
            commands::frontmatter_schema,
            commands::save_asset,
            commands::format_mdx,
            export::export_pdf,
            commands::lint_mdx,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MDX IDE");
}
