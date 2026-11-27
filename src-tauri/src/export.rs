//! PDF export.
//!
//! The preview hands over a static copy of the page as it currently looks (so component state
//! is kept). It is shown in a hidden window and printed to the chosen file.
//!
//! The copy is document content, so it is treated as untrusted: the print page is served with a
//! policy that allows no scripts and no requests beyond styles, fonts and pictures, the window
//! may not navigate anywhere else, and it has no Tauri capabilities.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::AppState;

/// Path of the print page on the preview protocol.
pub const PRINT_PATH: &str = "print";

pub const PRINT_CSP: &str = "default-src 'none'; \
    style-src 'unsafe-inline' mdxpreview: http://mdxpreview.localhost; \
    img-src mdxpreview: http://mdxpreview.localhost data: https:; \
    font-src mdxpreview: http://mdxpreview.localhost data:; \
    base-uri 'none'; form-action 'none'";

/// Turns the on-screen preview into pages: the card becomes the paper, nothing is cut off at
/// the right edge, and blocks are kept together where they fit on a page.
const PRINT_CSS: &str = r#"
*, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
html, body { margin: 0 !important; padding: 0 !important; background: #ffffff !important; }
#root { padding: 0 !important; }
.mdx-ide-doc { max-width: none !important; margin: 0 !important; padding: 0 !important; border-radius: 0 !important; background: transparent !important; box-shadow: none !important; }
.mdx-ide-doc pre { white-space: pre-wrap !important; overflow-wrap: anywhere; overflow: visible !important; }
.mdx-ide-doc table { display: table !important; width: 100%; }
.mdx-ide-doc :is(h1, h2, h3, h4, h5, h6) { break-after: avoid; }
.mdx-ide-doc :is(img, pre, tr, blockquote, .callout, .tabs), .mdx-ide-block > * { break-inside: avoid; }
img, svg, video { max-width: 100%; }
"#;

/// The same for a slide deck: one slide on each 16:9 page, as it looks on screen.
const DECK_PRINT_CSS: &str = r#"
*, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
html, body { margin: 0 !important; padding: 0 !important; background: #ffffff !important; }
#root { padding: 0 !important; }
/* Pop-ups a component left outside the deck would add stray pages. */
body > :not(#root) { display: none !important; }
.mdx-ide-deck { position: static !important; display: block !important; overflow: visible !important; }
/* WebKit lays a printed page out 1.25 times as wide as the paper, so each slide is enlarged to fill it. */
.mdx-ide-frame { zoom: 1.25; position: relative !important; width: 960px !important; height: 540px !important; overflow: hidden !important; opacity: 1 !important; visibility: visible !important; break-after: page; break-inside: avoid; }
.mdx-ide-frame:last-of-type { break-after: auto; }
.mdx-ide-doc.mdx-ide-slide { position: relative !important; transform: none !important; overflow: hidden !important; border-radius: 0 !important; }
"#;

#[derive(Debug, Deserialize)]
pub struct Snapshot {
    /// The page is a slide deck.
    #[serde(default)]
    slides: bool,
    body: String,
    styles: String,
    theme: String,
}

/// Assemble the page to print. `css_files` is the number of team stylesheets.
fn print_document(snapshot: &Snapshot, title: &str, css_files: usize) -> String {
    let theme = if snapshot.theme == "dark" { "dark" } else { "light" };
    let title = title.replace('&', "&amp;").replace('<', "&lt;");
    let team: String = (0..css_files).map(|i| format!("<link rel=\"stylesheet\" href=\"/team/css/{i}\">")).collect();
    let print_css = if snapshot.slides { DECK_PRINT_CSS } else { PRINT_CSS };
    // Text inside <style> ends only at "</": escape it so CSS strings cannot close the element.
    let styles = snapshot.styles.replace("</", "<\\/");
    format!(
        "<!doctype html><html data-theme=\"{theme}\"><head><meta charset=\"utf-8\"><title>{title}</title>\
         <link rel=\"stylesheet\" href=\"/index.css\">{team}<style>{styles}</style><style>{print_css}</style></head>\
         <body>{}</body></html>",
        snapshot.body
    )
}

/// The destination the user picked in the save dialog.
fn check_destination(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let is_pdf = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if !path.is_absolute() || !is_pdf {
        return Err("choose a file name ending in .pdf".into());
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err("that folder does not exist".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn export_pdf(app: AppHandle, state: State<'_, AppState>, snapshot: Snapshot, title: String, path: String) -> Result<(), String> {
    let destination = check_destination(&path)?;
    let css_files = {
        let guard = state.workspace.lock().map_err(|e| e.to_string())?;
        guard.as_ref().map_or(0, |ws| ws.config.preview.css.len())
    };
    // One export at a time: the print page is shared.
    let _turn = state.exporting.try_lock().map_err(|_| "another PDF export is still running")?;
    *state.print_document.lock().map_err(|e| e.to_string())? = Some(print_document(&snapshot, &title, css_files));
    let result = platform::print_to_file(&app, &destination, snapshot.slides).await;
    *state.print_document.lock().map_err(|e| e.to_string())? = None;
    result
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub async fn print_to_file(_app: &tauri::AppHandle, _destination: &std::path::Path, _slides: bool) -> Result<(), String> {
        Err("PDF export is only available on macOS for now".into())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::Duration;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode, NSWindow};
    use objc2_foundation::{NSDictionary, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    use tauri::webview::PageLoadEvent;
    use tauri::{AppHandle, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    use super::PRINT_PATH;

    const WINDOW: &str = "pdf-export";
    /// Page margin of a document in points (about 15 mm). Slides have none.
    const MARGIN: f64 = 42.0;
    /// A slide, in points (16:9).
    const SLIDE: (f64, f64) = (960.0, 540.0);
    /// Web fonts are requested only once text is laid out, shortly after the page has loaded.
    const SETTLE: Duration = Duration::from_millis(700);
    const TIMEOUT: Duration = Duration::from_secs(60);

    pub async fn print_to_file(app: &AppHandle, destination: &Path, slides: bool) -> Result<(), String> {
        let url = Url::parse(&format!("{}://localhost/{PRINT_PATH}", crate::preview_protocol::SCHEME)).map_err(|e| e.to_string())?;
        let (loaded_tx, loaded) = mpsc::channel();
        let allowed = url.clone();
        let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::CustomProtocol(url))
            .title("PDF export")
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .inner_size(if slides { SLIDE.0 } else { 794.0 }, if slides { SLIDE.1 } else { 1123.0 })
            // Document content must not be able to take the window anywhere else.
            .on_navigation(move |to| *to == allowed)
            .on_page_load(move |_, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = loaded_tx.send(());
                }
            })
            .build()
            .map_err(|e| format!("could not prepare the page: {e}"))?;

        // Print beside the destination, then move into place, so a failure leaves no half file.
        let name = destination.file_name().unwrap_or_default().to_string_lossy();
        let partial = destination.with_file_name(format!(".{name}.mdx-ide-tmp.pdf"));
        let result = drive(&window, loaded, partial.clone(), slides).await;
        let _ = window.destroy();
        let result = result.and_then(|()| {
            let is_pdf = std::fs::read(&partial).is_ok_and(|bytes| bytes.starts_with(b"%PDF"));
            if !is_pdf {
                return Err("macOS did not produce a PDF".into());
            }
            std::fs::rename(&partial, destination).map_err(|e| format!("could not save the PDF: {e}"))
        });
        if result.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        result
    }

    async fn drive(window: &WebviewWindow, loaded: mpsc::Receiver<()>, output: std::path::PathBuf, slides: bool) -> Result<(), String> {
        let (done_tx, done) = mpsc::channel();
        let window = window.clone();
        // Waiting must not block the async runtime, and printing must run on the main thread.
        tauri::async_runtime::spawn_blocking(move || {
            loaded.recv_timeout(TIMEOUT).map_err(|_| "the page took too long to load")?;
            std::thread::sleep(SETTLE);
            window
                .with_webview(move |webview| start(webview.inner(), webview.ns_window(), &output, slides, done_tx))
                .map_err(|e| e.to_string())?;
            match done.recv_timeout(TIMEOUT) {
                Ok(true) => Ok(()),
                Ok(false) => Err("macOS could not print the page".into()),
                Err(_) => Err("printing took too long".into()),
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    struct Ivars {
        done: mpsc::Sender<bool>,
    }

    define_class!(
        // Receives the callback when the print operation has finished.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        struct PrintDelegate;

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _operation: &NSPrintOperation, success: bool, _context: *mut c_void) {
                let _ = self.ivars().done.send(success);
            }
        }
    );

    thread_local! {
        /// AppKit does not retain the delegate; keep it until the next export replaces it.
        static DELEGATE: RefCell<Option<Retained<PrintDelegate>>> = const { RefCell::new(None) };
    }

    /// Start printing `webview` to `output` without showing any panel. Main thread only.
    fn start(webview: *mut c_void, ns_window: *mut c_void, output: &Path, slides: bool, done: mpsc::Sender<bool>) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = done.send(false);
            return;
        };
        // SAFETY: Tauri hands us its live WKWebView and NSWindow, on the main thread.
        let (webview, ns_window) = unsafe { (&*webview.cast::<WKWebView>(), &*ns_window.cast::<NSWindow>()) };

        // SAFETY: an empty dictionary is a valid set of print attributes.
        let info = unsafe { NSPrintInfo::initWithDictionary(NSPrintInfo::alloc(), &NSDictionary::new()) };
        // A slide fills its page; a document goes on the user's usual paper (A4, Letter, ...).
        let (paper, margin) =
            if slides { (NSSize::new(SLIDE.0, SLIDE.1), 0.0) } else { (NSPrintInfo::sharedPrintInfo().paperSize(), MARGIN) };
        info.setPaperSize(paper);
        info.setTopMargin(margin);
        info.setBottomMargin(margin);
        info.setLeftMargin(margin);
        info.setRightMargin(margin);
        info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        info.setVerticallyCentered(false);
        let url = NSURL::fileURLWithPath(&NSString::from_str(&output.to_string_lossy()));
        // SAFETY: the saving-URL attribute takes an NSURL.
        unsafe {
            info.setJobDisposition(NSPrintSaveJob);
            info.dictionary().setObject_forKey(&url, ProtocolObject::from_ref(NSPrintJobSavingURL));
        }

        // SAFETY: `printOperationWithPrintInfo:` exists on every macOS this app supports (11+).
        let operation = unsafe { webview.printOperationWithPrintInfo(&info) };
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        // WKWebView prints blank pages unless its print view has a size.
        if let Some(view) = operation.view() {
            view.setFrame(webview.bounds());
        }

        let delegate = PrintDelegate::alloc(mtm).set_ivars(Ivars { done });
        // SAFETY: plain NSObject initialiser.
        let delegate: Retained<PrintDelegate> = unsafe { msg_send![super(delegate), init] };
        // SAFETY: the selector matches `did_run`, and the delegate is kept alive in DELEGATE.
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                ns_window,
                Some(&delegate),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
        DELEGATE.with(|slot| *slot.borrow_mut() = Some(delegate));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_script_free_page_shell() {
        let snapshot = Snapshot {
            slides: false,
            body: "<div id=\"root\">state</div>".into(),
            styles: ".a::after { content: \"</style><script>x</script>\" }".into(),
            theme: "\"><script>".into(),
        };
        let page = print_document(&snapshot, "a</title><script>", 2);
        assert!(page.starts_with("<!doctype html><html data-theme=\"light\">"));
        assert!(page.contains("<title>a&lt;/title>&lt;script></title>"));
        assert!(page.contains("href=\"/index.css\"") && page.contains("href=\"/team/css/1\"") && !page.contains("/team/css/2"));
        // The styles cannot close their element and start a script.
        assert!(!page.contains("</style><script>"));
        assert!(page.contains("<body><div id=\"root\">state</div></body>"));
        assert!(PRINT_CSP.starts_with("default-src 'none'") && !PRINT_CSP.contains("script-src"));
        // Documents and decks are laid out differently.
        assert!(page.contains(PRINT_CSS) && !page.contains(DECK_PRINT_CSS));
        let deck = print_document(&Snapshot { slides: true, ..snapshot }, "talk", 0);
        assert!(deck.contains(DECK_PRINT_CSS) && !deck.contains(PRINT_CSS));
    }

    #[test]
    fn only_writes_pdf_files_into_existing_folders() {
        let dir = std::env::temp_dir();
        assert!(check_destination(&dir.join("page.PDF").to_string_lossy()).is_ok());
        for bad in ["page.pdf", "/nonexistent-folder-xyz/page.pdf", "/etc/hosts", ""] {
            assert!(check_destination(bad).is_err(), "{bad}");
        }
    }
}
