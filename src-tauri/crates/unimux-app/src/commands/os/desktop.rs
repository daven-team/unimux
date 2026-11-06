//! Where the `os` commands reach the desktop. `RealDesktop` shows toasts, dialogs and Explorer windows, beeps, flashes the
//! taskbar button and uses the OS clipboard. An offscreen check run (`MC_OFFSCREEN`, dev-overrides only) gets the
//! `Recorder` instead: nothing appears on the user's desktop (no toast, dialog, browser, Explorer, beep or flash) and the
//! clipboard is a file in the scratch data dir; the real-app scripts read what was asked and answer dialogs and toasts
//! through the test bridge.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::WebviewWindow;

use unimux_exec::Program;
use unimux_platform::clipboard::{ClipboardIo, OsClipboard};
use unimux_platform::notify::{Native, ToastCallback, ToastEvent, ToastSpec};

/// An open dialog: `dialog:pickFolder` or `sound:pick`.
#[derive(Debug, Clone)]
pub struct PickRequest {
    pub folder: bool,
    pub title: String,
    /// `(name, extensions)` of the one filter.
    pub filter: Option<(String, Vec<String>)>,
}

pub trait Desktop: Send + Sync {
    /// `Notification.isSupported()`.
    fn notifications_supported(&self) -> bool;
    /// Shows a notification; the native object (if any) must be kept while its events matter.
    fn toast(&self, spec: &ToastSpec, on_event: ToastCallback) -> Result<Option<Native>, String>;
    fn beep(&self);
    fn open_external(&self, url: &str);
    fn open_path(&self, path: &str);
    fn reveal(&self, path: &str);
    /// Starts an editor (or `open -a`) that outlives the app.
    fn spawn_detached(&self, program: Program, env: Option<std::collections::HashMap<OsString, OsString>>) -> Result<(), String>;
    fn clipboard(&self) -> Arc<dyn ClipboardIo>;
    /// A native open dialog over `parent` (free-standing without one); the chosen path or None.
    fn pick(&self, parent: Option<WebviewWindow>, request: PickRequest) -> BoxFuture<'static, Option<String>>;
    /// `flashFrame(true)` / `(false)` on the window.
    fn flash(&self, window: &WebviewWindow, on: bool);
    /// macOS Dock badge ('' = none).
    fn dock_badge(&self, window: Option<WebviewWindow>, text: &str);
}

/// The desktop of a normal run.
pub struct RealDesktop {
    pub app_id: String,
    pub dev_app_id: bool,
    registered: AtomicBool,
}

impl RealDesktop {
    pub fn new(app_id: &str, dev_app_id: bool) -> Self {
        Self { app_id: app_id.to_string(), dev_app_id, registered: AtomicBool::new(false) }
    }
}

impl Desktop for RealDesktop {
    fn notifications_supported(&self) -> bool {
        unimux_platform::notify::is_supported()
    }

    fn toast(&self, spec: &ToastSpec, on_event: ToastCallback) -> Result<Option<Native>, String> {
        #[cfg(windows)]
        if self.dev_app_id && !self.registered.swap(true, std::sync::atomic::Ordering::SeqCst) {
            // A development run's AUMID has no Start menu shortcut: register it once so Windows shows its toasts.
            let icon = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("icon.ico"))).filter(|p| p.exists());
            let _ = unimux_platform::notify::register_app_id(&self.app_id, "unimux (dev)", icon.as_deref());
        }
        #[cfg(not(windows))]
        let _ = (&self.registered, self.dev_app_id);
        unimux_platform::notify::show(&self.app_id, spec, on_event).map(Some)
    }

    fn beep(&self) {
        unimux_platform::shell::beep();
    }

    fn open_external(&self, url: &str) {
        unimux_platform::shell::open_external(url);
    }

    fn open_path(&self, path: &str) {
        let path = path.to_string();
        // May block (a slow program association, a network share): never on the IPC task.
        std::thread::spawn(move || {
            let _ = unimux_platform::shell::open_path(&path);
        });
    }

    fn reveal(&self, path: &str) {
        unimux_platform::shell::show_item_in_folder(path);
    }

    fn spawn_detached(&self, program: Program, env: Option<std::collections::HashMap<OsString, OsString>>) -> Result<(), String> {
        unimux_exec::spawn_detached(&program, env, None).map(|_| ()).map_err(|e| e.to_string())
    }

    fn clipboard(&self) -> Arc<dyn ClipboardIo> {
        Arc::new(OsClipboard)
    }

    fn pick(&self, parent: Option<WebviewWindow>, request: PickRequest) -> BoxFuture<'static, Option<String>> {
        Box::pin(async move {
            let mut dialog = rfd::AsyncFileDialog::new().set_title(&request.title);
            if let Some((name, extensions)) = &request.filter {
                dialog = dialog.add_filter(name, extensions);
            }
            if let Some(parent) = &parent {
                dialog = dialog.set_parent(parent);
            }
            let picked = if request.folder { dialog.pick_folder().await } else { dialog.pick_file().await };
            picked.map(|f| f.path().to_string_lossy().into_owned())
        })
    }

    fn flash(&self, window: &WebviewWindow, on: bool) {
        #[cfg(windows)]
        if let Ok(hwnd) = window.hwnd() {
            unimux_platform::shell::flash_window(hwnd.0 as isize, on);
        }
        // macOS: one Dock bounce (NSInformationalRequest), as Electron's flashFrame(true); nothing to stop.
        #[cfg(target_os = "macos")]
        if on {
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = (window, on);
    }

    fn dock_badge(&self, window: Option<WebviewWindow>, text: &str) {
        #[cfg(target_os = "macos")]
        if let Some(window) = window {
            let _ = window.set_badge_label((!text.is_empty()).then(|| text.to_string()));
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (window, text);
    }
}

/// The offscreen desktop of the check build: records every call (the test bridge reads them) and answers dialogs from a
/// queue the test fills; the clipboard is `<data dir>/test-clipboard.json`.
pub struct Recorder {
    log: Mutex<Vec<Value>>,
    toasts: Mutex<Vec<(ToastSpec, ToastCallback)>>,
    answers: Mutex<VecDeque<Option<String>>>,
    clipboard: Arc<FileClipboard>,
}

impl Recorder {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            log: Mutex::new(Vec::new()),
            toasts: Mutex::new(Vec::new()),
            answers: Mutex::new(VecDeque::new()),
            clipboard: Arc::new(FileClipboard { path: data_dir.join("test-clipboard.json") }),
        }
    }

    fn record(&self, entry: Value) {
        self.log.lock().push(entry);
    }

    /// Everything recorded so far (and cleared with `take`).
    pub fn log(&self, take: bool) -> Vec<Value> {
        let mut log = self.log.lock();
        if take { std::mem::take(&mut *log) } else { log.clone() }
    }

    /// The answer of the next dialog (None = cancelled).
    pub fn queue_answer(&self, answer: Option<String>) {
        self.answers.lock().push_back(answer);
    }

    /// Acts on recorded toast `index` like the user would: `click`, `button` (with `button`), `closed` or `failed`.
    pub fn activate(&self, index: usize, event: ToastEvent) -> bool {
        let callback = self.toasts.lock().get(index).map(|(_, cb)| cb.clone());
        match callback {
            Some(cb) => {
                cb(event);
                true
            }
            None => false,
        }
    }
}

impl Desktop for Recorder {
    fn notifications_supported(&self) -> bool {
        true
    }

    fn toast(&self, spec: &ToastSpec, on_event: ToastCallback) -> Result<Option<Native>, String> {
        let index = {
            let mut toasts = self.toasts.lock();
            toasts.push((spec.clone(), on_event));
            toasts.len() - 1
        };
        self.record(json!({ "op": "toast", "index": index, "title": spec.title, "body": spec.body, "buttons": spec.buttons, "silent": true }));
        Ok(None)
    }

    fn beep(&self) {
        self.record(json!({ "op": "beep" }));
    }

    fn open_external(&self, url: &str) {
        self.record(json!({ "op": "openExternal", "url": url }));
    }

    fn open_path(&self, path: &str) {
        self.record(json!({ "op": "openPath", "path": path }));
    }

    fn reveal(&self, path: &str) {
        self.record(json!({ "op": "revealPath", "path": path }));
    }

    fn spawn_detached(
        &self,
        program: Program,
        _env: Option<std::collections::HashMap<OsString, OsString>>,
    ) -> Result<(), String> {
        let (program, args) = match program {
            Program::Args { program, args } => {
                (program.to_string_lossy().into_owned(), json!(args.iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>()))
            }
            Program::Raw { program, raw } => (program.to_string_lossy().into_owned(), json!(raw)),
        };
        self.record(json!({ "op": "spawnDetached", "program": program, "args": args }));
        Ok(())
    }

    fn clipboard(&self) -> Arc<dyn ClipboardIo> {
        self.clipboard.clone()
    }

    fn pick(&self, parent: Option<WebviewWindow>, request: PickRequest) -> BoxFuture<'static, Option<String>> {
        let answer = self.answers.lock().pop_front().flatten();
        self.record(json!({
            "op": "pick",
            "folder": request.folder,
            "title": request.title,
            "filter": request.filter.as_ref().map(|(name, ext)| json!({ "name": name, "extensions": ext })),
            "parent": parent.as_ref().map(|w| w.label().to_string()),
            "answer": answer,
        }));
        Box::pin(async move { answer })
    }

    fn flash(&self, window: &WebviewWindow, on: bool) {
        self.record(json!({ "op": "flash", "window": window.label(), "on": on }));
    }

    fn dock_badge(&self, _window: Option<WebviewWindow>, text: &str) {
        self.record(json!({ "op": "dockBadge", "text": text }));
    }
}

/// The clipboard of an offscreen run: `{"text": ..., "secret": bool}` in a file, so a script also sees what a quit left.
pub struct FileClipboard {
    path: PathBuf,
}

impl ClipboardIo for FileClipboard {
    fn read(&self) -> Result<String, String> {
        let text = std::fs::read_to_string(&self.path).unwrap_or_default();
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        Ok(value.get("text").and_then(Value::as_str).unwrap_or_default().to_string())
    }
    fn write(&self, text: &str, secret: bool) -> Result<(), String> {
        let body = json!({ "text": text, "secret": secret }).to_string();
        std::fs::write(&self.path, body).map_err(|e| e.to_string())
    }
}
