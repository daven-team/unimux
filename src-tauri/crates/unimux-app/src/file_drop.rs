//! OS file drops (PLAN W3): the absolute paths of files and folders dragged in from Explorer / Finder, for
//! `window.mc.pathsForFiles` (1.1.4: `webUtils.getPathForFile`, synchronous).
//!
//! Tauri's own drag-drop handler stays off on every app webview (`disable_drag_drop_handler`): it swallows every drop, so
//! HTML5 drag and drop (tab reorder and detach, snippets, notes, the explorer tree, SFTP) would stop working, and the page's
//! drop event (which element, which modifier, the File objects) is what 1.1.4's handlers are written against. The paths come
//! on the side:
//!
//! - Windows: the page hands the dropped `File` objects to
//!   `chrome.webview.postMessageWithAdditionalObjects('{"mcPaths":"<id>"}', files)`; WebView2 gives them to this handler as
//!   `ICoreWebView2File`, whose `Path` is the absolute path. The answer goes back with
//!   `PostWebMessageAsJson({mcPaths: id, paths})` to the same page (src/renderer/src/bridge/filePaths.ts). Only pages of the
//!   app origin are answered. The request is a STRING message on purpose: wry's own WebMessageReceived handler (registered
//!   first) returns an error for a non-string message (`TryGetWebMessageAsString?`), and WebView2 then does not call the later
//!   handlers, so an object request never reached this one (measured in the real app). A string passes wry; Tauri's IPC
//!   parser then refuses it as not an invoke message and writes one `console.error` into the page (visible in devtools only).
//! - macOS: WKWebView gives a `File` no path either. `performDragOperation:` of wry's `WryWebView` class is wrapped: the
//!   file URLs of the drag pasteboard are recorded, then wry's own method runs (with the handler off it hands the drop to
//!   WebKit, so the page gets its normal drop event). The page asks for the recorded paths with the `mc_dropped_paths`
//!   command and matches them to its Files by name. Compile-checked only (no Mac in wave 1).

use std::sync::Arc;

use tauri::WebviewWindow;

use crate::context::AppContext;

/// Installs the path source on an app window (main now, detached windows with W5).
pub fn install(window: &WebviewWindow, ctx: Arc<AppContext>) {
    #[cfg(windows)]
    windows_paths::install(window, ctx);
    #[cfg(target_os = "macos")]
    {
        let _ = (window, ctx);
        mac_paths::install();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (window, ctx);
}

/// The request of the page: the string `{"mcPaths":"<id>"}` (anything else on the channel, Tauri's IPC included, is not
/// ours).
#[cfg(any(windows, test))]
pub fn request_id(message: &str) -> Option<String> {
    if !message.starts_with("{\"mcPaths\"") {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(message).ok()?;
    let id = value.as_object()?.get("mcPaths")?.as_str()?;
    (!id.is_empty() && id.len() <= 128).then(|| id.to_string())
}

/// The answer: `{"mcPaths": "<id>", "paths": [...]}` ('' for an object that is not a file with a path).
#[cfg(any(windows, test))]
pub fn answer_json(id: &str, paths: &[String]) -> String {
    serde_json::json!({ "mcPaths": id, "paths": paths }).to_string()
}

#[cfg(windows)]
mod windows_paths {
    use std::sync::Arc;

    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
    use windows::core::{HSTRING, Interface, PCWSTR, PWSTR};

    use crate::context::{AppContext, app_origins};

    pub fn install(window: &WebviewWindow, ctx: Arc<AppContext>) {
        let label = window.label().to_string();
        let result = window.with_webview(move |webview| {
            // SAFETY: COM calls on the live controller, on the UI thread Tauri runs this closure on; the handler runs on the
            // same thread.
            unsafe {
                let Ok(core) = webview.controller().CoreWebView2() else { return };
                let handler = WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
                    let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
                    if let Some(answer) = answer(&args) {
                        let text = HSTRING::from(answer);
                        let _ = sender.PostWebMessageAsJson(PCWSTR(text.as_ptr()));
                    }
                    Ok(())
                }));
                let mut token = 0i64;
                if let Err(e) = core.add_WebMessageReceived(&handler, &mut token) {
                    ctx.crash.warn(&format!("file drop paths for {label}: {e}"));
                }
            }
        });
        if let Err(e) = result {
            eprintln!("file drop paths: {e}");
        }
    }

    /// The answer to a path request of an app page, or None (another message, another origin).
    unsafe fn answer(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Option<String> {
        // SAFETY: the event's own arguments, read during the event.
        unsafe {
            let mut source = PWSTR::null();
            args.Source(&mut source).ok()?;
            let source = take_pwstr(source);
            let origin = unimux_ipc::guard::origin_of(&source);
            if !app_origins().iter().any(|o| o.eq_ignore_ascii_case(origin)) {
                return None;
            }
            // A request is a string (see the module doc); anything else is not ours.
            let mut text = PWSTR::null();
            args.TryGetWebMessageAsString(&mut text).ok()?;
            let id = super::request_id(&take_pwstr(text))?;
            let mut paths = Vec::new();
            if let Ok(objects) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>().and_then(|a| a.AdditionalObjects()) {
                let mut count = 0u32;
                let _ = objects.Count(&mut count);
                for i in 0..count {
                    let path = objects
                        .GetValueAtIndex(i)
                        .and_then(|o| o.cast::<ICoreWebView2File>())
                        .and_then(|file| {
                            let mut p = PWSTR::null();
                            file.Path(&mut p).map(|()| take_pwstr(p))
                        })
                        .unwrap_or_default();
                    paths.push(path);
                }
            }
            Some(super::answer_json(&id, &paths))
        }
    }
}

/// The paths of the last OS drop on any app webview (macOS), with the time it happened.
#[cfg(any(target_os = "macos", test))]
pub mod last_drop {
    use std::time::{Duration, Instant};

    use parking_lot::Mutex;

    static LAST: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
    /// The page asks right after its drop event; an older record belongs to an earlier drop.
    pub const MAX_AGE: Duration = Duration::from_secs(10);

    pub fn record(paths: Vec<String>) {
        *LAST.lock() = Some((Instant::now(), paths));
    }

    pub fn recent() -> Vec<String> {
        match &*LAST.lock() {
            Some((at, paths)) if at.elapsed() <= MAX_AGE => paths.clone(),
            _ => Vec::new(),
        }
    }
}

#[cfg(target_os = "macos")]
mod mac_paths {
    use std::ffi::CStr;
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, ProtocolObject, Sel};
    use objc2::{ClassType, sel};
    use objc2_app_kit::NSDraggingInfo;
    use objc2_foundation::{NSArray, NSURL};

    static ORIGINAL: OnceLock<Option<Imp>> = OnceLock::new();

    type PerformDrag = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool;

    /// Wraps `-[WryWebView performDragOperation:]` once per process (the class exists after the first webview).
    pub fn install() {
        ORIGINAL.get_or_init(|| {
            let class = AnyClass::get(c"WryWebView")?;
            let method = class.instance_method(sel!(performDragOperation:))?;
            // SAFETY: same signature as wry's method (self, _cmd, id<NSDraggingInfo>) -> BOOL; the original is kept and
            // called for every drop.
            unsafe {
                let ours: PerformDrag = perform_drag_operation;
                Some(method.set_implementation(std::mem::transmute::<PerformDrag, Imp>(ours)))
            }
        });
    }

    unsafe extern "C-unwind" fn perform_drag_operation(this: *mut AnyObject, cmd: Sel, info: *mut AnyObject) -> Bool {
        // SAFETY: `info` is the NSDraggingInfo AppKit passes to performDragOperation:.
        unsafe {
            if let Some(info) = (info as *const ProtocolObject<dyn NSDraggingInfo>).as_ref() {
                super::last_drop::record(file_paths(info));
            }
            match ORIGINAL.get().copied().flatten() {
                Some(original) => std::mem::transmute::<Imp, PerformDrag>(original)(this, cmd, info),
                None => Bool::NO,
            }
        }
    }

    /// The file URLs on the drag pasteboard as paths (what wry's own collector reads).
    unsafe fn file_paths(info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<String> {
        // SAFETY: AppKit objects of the running drag.
        unsafe {
            let pasteboard = info.draggingPasteboard();
            let classes = NSArray::from_slice(&[NSURL::class()]);
            let mut out = Vec::new();
            if let Some(items) = pasteboard.readObjectsForClasses_options(&classes, None) {
                for item in items.iter() {
                    let Some(url) = item.downcast_ref::<NSURL>() else { continue };
                    if !url.isFileURL() {
                        continue;
                    }
                    if let Some(path) = url.filePathURL().and_then(|u| u.path()) {
                        out.push(CStr::from_ptr(path.UTF8String()).to_string_lossy().into_owned());
                    }
                }
            }
            out
        }
    }
}

/// macOS: the paths of the last OS drop (the page matches them to its Files by name). Empty elsewhere.
#[tauri::command]
pub async fn mc_dropped_paths(webview: tauri::Webview) -> Vec<String> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    let origin = unimux_ipc::guard::origin_of(&url);
    if !crate::context::app_origins().iter().any(|o| o.eq_ignore_ascii_case(origin)) {
        return Vec::new();
    }
    #[cfg(target_os = "macos")]
    {
        last_drop::recent()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_path_requests_are_answered() {
        assert_eq!(request_id(r#"{"mcPaths":"a1"}"#).as_deref(), Some("a1"));
        assert_eq!(request_id(r#"{"mcPaths":""}"#), None);
        assert_eq!(request_id(r#"{"mcPaths":3}"#), None);
        assert_eq!(request_id(r#"{"cmd":"x","mcPaths":"a1"}"#), None, "Tauri's IPC messages are not ours");
        assert_eq!(request_id(r#" {"mcPaths":"a1"}"#), None);
        assert_eq!(request_id(&format!(r#"{{"mcPaths":"{}"}}"#, "x".repeat(129))), None);
        assert_eq!(request_id("not json"), None);
    }

    #[test]
    fn the_answer_keeps_the_order_and_empty_entries() {
        let a = answer_json("id", &[r"C:\a b\ł.txt".into(), String::new()]);
        let v: serde_json::Value = serde_json::from_str(&a).unwrap();
        assert_eq!(v, serde_json::json!({ "mcPaths": "id", "paths": [r"C:\a b\ł.txt", ""] }));
    }

    #[test]
    fn the_last_drop_expires() {
        last_drop::record(vec!["/tmp/a".into()]);
        assert_eq!(last_drop::recent(), ["/tmp/a"]);
    }
}
