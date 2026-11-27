//! `mdxpreview://` — serves the sandboxed preview.
//!
//! The preview iframe executes the document's JavaScript (MDX *is* JS), so it
//! runs on its own origin with `sandbox="allow-scripts"` and no Tauri
//! capabilities. This protocol is the only thing it can talk to:
//!
//! | path                 | serves                                                         |
//! |----------------------|----------------------------------------------------------------|
//! | `/…`                 | the preview runtime (bundled resource `preview/`)              |
//! | `/team/components.js`| the team's prebundled component library (`preview.components_bundle`) |
//! | `/team/css/<n>`      | global CSS `preview.css[n]`                                    |
//! | `/ws/<path>`         | image/media assets from the open workspace (never `.mdx`/source) |
//! | `/static/<path>`     | root-relative assets (`/img/x.png`) looked up in `static_dirs` |
//! | `/print`             | the page being exported to PDF (see `export.rs`)               |
//!
//! URL shape differs per OS (`mdxpreview://localhost/` on macOS/Linux,
//! `http://mdxpreview.localhost/` on Windows); the UI builds it with
//! `convertFileSrc('', 'mdxpreview')`.

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext};

use crate::AppState;

pub const SCHEME: &str = "mdxpreview";

/// Strict CSP for the preview document. `blob:` is needed because compiled
/// MDX is loaded as a blob module.
const CSP: &str = "default-src 'none'; \
    script-src mdxpreview: http://mdxpreview.localhost blob:; \
    style-src 'unsafe-inline' mdxpreview: http://mdxpreview.localhost; \
    img-src mdxpreview: http://mdxpreview.localhost data: blob: https:; \
    media-src mdxpreview: http://mdxpreview.localhost https:; \
    font-src mdxpreview: http://mdxpreview.localhost data:; \
    connect-src mdxpreview: http://mdxpreview.localhost";

const ASSET_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "mp4", "webm", "mp3", "woff", "woff2", "ttf", "pdf"];

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let app = ctx.app_handle();
    let path = percent_decode(request.uri().path());
    let path = path.trim_start_matches('/');
    if path == crate::export::PRINT_PATH {
        return print_page(app);
    }

    let file: Option<PathBuf> = if let Some(rest) = path.strip_prefix("team/") {
        team_file(app, rest)
    } else if let Some(rest) = path.strip_prefix("ws/") {
        workspace_asset(app, rest, false)
    } else if let Some(rest) = path.strip_prefix("static/") {
        workspace_asset(app, rest, true)
    } else {
        let rel = if path.is_empty() { "index.html" } else { path };
        app.path().resource_dir().ok().and_then(|dir| safe_join(&dir.join("preview"), rel))
    };

    match file.and_then(|f| std::fs::read(&f).ok().map(|bytes| (f, bytes))) {
        Some((file, bytes)) => {
            let mime = mime_guess::from_path(&file).first_or_octet_stream();
            let mut res = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.essence_str())
                // The iframe is sandboxed (opaque origin, `Origin: null`), so
                // module scripts and fetches need CORS.
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::CACHE_CONTROL, "no-store");
            if mime.essence_str() == "text/html" {
                res = res.header(header::CONTENT_SECURITY_POLICY, CSP);
            }
            res.body(Cow::Owned(bytes)).unwrap()
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Borrowed(&b"not found"[..]))
            .unwrap(),
    }
}

/// The page being exported to PDF, if an export is running. Served without script permission.
fn print_page<R: Runtime>(app: &tauri::AppHandle<R>) -> Response<Cow<'static, [u8]>> {
    let page = app.try_state::<AppState>().and_then(|s| s.print_document.lock().ok().and_then(|d| d.clone()));
    let status = if page.is_some() { StatusCode::OK } else { StatusCode::NOT_FOUND };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, crate::export::PRINT_CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(page.unwrap_or_default().into_bytes()))
        .unwrap()
}

fn team_file<R: Runtime>(app: &tauri::AppHandle<R>, rest: &str) -> Option<PathBuf> {
    let state = app.try_state::<AppState>()?;
    let guard = state.workspace.lock().ok()?;
    let ws = guard.as_ref()?;
    let rel = if rest == "components.js" {
        ws.config.preview.components_bundle.clone()?
    } else {
        let idx: usize = rest.strip_prefix("css/")?.parse().ok()?;
        ws.config.preview.css.get(idx)?.clone()
    };
    safe_join(ws.root(), &rel.to_string_lossy())
}

fn workspace_asset<R: Runtime>(app: &tauri::AppHandle<R>, rest: &str, in_static_dirs: bool) -> Option<PathBuf> {
    let ext = Path::new(rest).extension()?.to_str()?.to_ascii_lowercase();
    if !ASSET_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let state = app.try_state::<AppState>()?;
    let guard = state.workspace.lock().ok()?;
    let ws = guard.as_ref()?;
    if in_static_dirs {
        return ws.config.static_dirs.iter().find_map(|d| safe_join(&ws.root().join(d), rest));
    }
    safe_join(ws.root(), rest)
}

/// Join without allowing `..`, absolute paths or symlinks out of `base`.
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let joined = base.join(rel).canonicalize().ok()?;
    joined.starts_with(base.canonicalize().ok()?).then_some(joined)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_blocks_traversal() {
        let dir = std::env::temp_dir();
        assert!(safe_join(&dir, "../etc/passwd").is_none());
        assert!(safe_join(&dir, "/etc/passwd").is_none());
        assert_eq!(percent_decode("/ws/my%20img.png"), "/ws/my img.png");
    }
}
