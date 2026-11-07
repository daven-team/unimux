//! The update window inside the app process (port of src/main/gateWindow.ts): the startup check's window and the window of
//! the status bar button. It reuses the page of the update window (`resources/update-splash`, the `window.updateSplash`
//! contract); the update window process takes over when the installer starts (U2).
//!
//! The user's update rules (PLAN.md): never always-on-top; it never pushes a full-screen app aside (shown without taking the
//! focus while one is in front); an unattended run (MC_OFFSCREEN) keeps it off screen and never focused.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use unimux_core::i18n::translate;
use unimux_update::gate::{GateHandle, GateView};

use crate::context::AppContext;

pub const LABEL: &str = "update-gate";
const EVENT: &str = "update-splash:state";

/// `GateTexts` of gateWindow.ts, translated.
#[derive(Debug, Clone)]
pub struct GateTexts {
    language: String,
    checking: String,
    downloading: String,
    hint: String,
    preparing: String,
    failed: String,
    close: String,
    ask_message: String,
    ask_hint: String,
    install: String,
    later: String,
}

impl GateTexts {
    /// `gateTexts(failed)` of index.ts; `failed` is the Polish key of the failure line.
    pub fn new(language: &str, failed: &str) -> Self {
        let t = |key: &str| translate(language, key, &[]);
        Self {
            language: language.to_string(),
            checking: t("Sprawdzanie aktualizacji…"),
            downloading: t("Pobieranie aktualizacji…"),
            hint: t("Nie wyłączaj komputera. unimux uruchomi się automatycznie."),
            preparing: t("Przygotowanie aktualizacji…"),
            failed: t(failed),
            close: t("Zamknij"),
            ask_message: t("Zainstalować ją teraz?"),
            ask_hint: t("„Później” uruchamia obecną wersję. Zainstalujesz ją przyciskiem w stopce."),
            install: t("Zainstaluj teraz"),
            later: t("Później"),
        }
    }

    fn updating(&self, version: &str) -> String {
        translate(&self.language, "Aktualizacja do wersji {version}", &[("version", version)])
    }

    fn available(&self, version: &str) -> String {
        translate(&self.language, "Dostępna nowa wersja {version}", &[("version", version)])
    }
}

/// `gateState`: what the update window shows for a gate view (the `SplashState` of the page).
pub fn gate_state(view: &GateView, texts: &GateTexts, current: &str) -> Value {
    let versions = |next: &str| format!("{current} → {next}");
    match view {
        GateView::Checking => json!({
            "stage": "checking", "percent": 0, "message": "", "title": texts.checking, "versions": current, "hint": "",
            "closable": true,
        }),
        GateView::Ask { version } => json!({
            "stage": "ask", "percent": 0, "message": texts.ask_message, "title": texts.available(version),
            "versions": versions(version), "hint": texts.ask_hint, "closable": true, "primary": texts.install,
            "secondary": texts.later,
        }),
        GateView::Downloading { version, percent } => json!({
            "stage": "downloading", "percent": percent, "message": texts.downloading, "title": texts.updating(version),
            "versions": versions(version), "hint": texts.hint, "closable": true,
        }),
        // From here the installer is being started and the window cannot be cancelled any more.
        GateView::Installing { version } => json!({
            "stage": "downloading", "percent": 100, "message": texts.preparing, "title": texts.updating(version),
            "versions": versions(version), "hint": texts.hint, "closable": false,
        }),
        GateView::Failed { version } => json!({
            "stage": "failed", "percent": 0, "message": texts.failed, "title": texts.updating(version),
            "versions": versions(version), "hint": "", "closable": false,
        }),
    }
}

/// One gate window (created on the first `show`, destroyed by `hide`).
pub struct GateWindow {
    app: AppHandle,
    ctx: Arc<AppContext>,
    texts: GateTexts,
    current: String,
    handle: Arc<GateHandle>,
    latest: Mutex<Option<Value>>,
    loaded: AtomicBool,
    created: AtomicBool,
    /// True while `hide()` destroys the window itself, so its Destroyed event is not mistaken for a crash.
    closing: AtomicBool,
    /// Hidden by the flow, kept until [`GateWindow::dispose`].
    hidden: AtomicBool,
    me: std::sync::Weak<GateWindow>,
}

impl GateWindow {
    pub fn new(ctx: &Arc<AppContext>, app: AppHandle, texts: GateTexts, handle: Arc<GateHandle>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            app,
            ctx: ctx.clone(),
            texts,
            current: unimux_core::VERSION.to_string(),
            handle,
            latest: Mutex::new(None),
            loaded: AtomicBool::new(false),
            created: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            hidden: AtomicBool::new(false),
            me: me.clone(),
        })
    }

    fn window(&self) -> Option<WebviewWindow> {
        self.app.get_webview_window(LABEL)
    }

    fn closable(&self) -> bool {
        self.latest.lock().as_ref().and_then(|s| s.get("closable")).and_then(Value::as_bool).unwrap_or(false)
    }

    fn push(&self) {
        if !self.loaded.load(Ordering::SeqCst) {
            return;
        }
        if let Some(state) = self.latest.lock().clone() {
            let _ = self.app.emit_to(EventTarget::webview_window(LABEL), EVENT, state);
        }
    }

    pub fn show(&self, view: &GateView) {
        *self.latest.lock() = Some(gate_state(view, &self.texts, &self.current));
        if self.created.swap(true, Ordering::SeqCst) {
            self.push();
            if self.hidden.swap(false, Ordering::SeqCst)
                && self.loaded.load(Ordering::SeqCst)
                && let Some(window) = self.window()
            {
                reveal(self, &window);
            }
            return;
        }
        if let Some(me) = self.me.upgrade()
            && let Err(e) = create(&me)
        {
            self.ctx.crash.warn(&format!("update window: {e}"));
            self.created.store(false, Ordering::SeqCst);
            // A window that cannot be created must never leave the app waiting for an answer nobody can give.
            self.handle.cancel();
        }
    }

    /// Takes the window off the screen. It is destroyed only by [`GateWindow::dispose`], once the main window exists: closing
    /// the last webview of the process lets the WebView2 browser process shut down, and a main window created while it does
    /// never got its page (seen in the U1 harness). Electron kept its browser process; this keeps it too.
    pub fn hide(&self) {
        self.hidden.store(true, Ordering::SeqCst);
        if let Some(window) = self.window() {
            hide_window(&window);
        }
    }

    /// Destroys the window (after the main window was created, or when the process ends anyway).
    pub fn dispose(&self) {
        self.closing.store(true, Ordering::SeqCst);
        if let Some(window) = self.window() {
            let _ = window.destroy();
        }
        self.closing.store(false, Ordering::SeqCst);
        self.created.store(false, Ordering::SeqCst);
        self.loaded.store(false, Ordering::SeqCst);
    }

    /// `update-splash:init`.
    pub fn init_info(&self) -> Value {
        let latest = self.latest.lock().clone();
        let field = |key: &str| latest.as_ref().and_then(|s| s.get(key)).cloned().unwrap_or(json!(""));
        json!({
            "title": field("title"), "hint": field("hint"), "fromVersion": self.current, "version": "",
            "state": latest, "open": "", "close": self.texts.close,
        })
    }

    /// The user closed the window (X, Escape, Alt+F4); the gate decides whether that is still allowed.
    pub fn request_close(&self) {
        if self.closable() {
            self.handle.cancel();
        }
    }

    /// "Install now" of the 'ask' prompt; ignored at any other stage.
    pub fn request_install(&self) {
        let ask = self.latest.lock().as_ref().and_then(|s| s.get("stage")).and_then(Value::as_str) == Some("ask");
        if ask {
            self.handle.install();
        }
    }
}

/// tao does not know about a window shown with SW_SHOWNOACTIVATE (its visible flag stays false), so its own hide() could do
/// nothing; hide through the handle.
#[cfg(windows)]
fn hide_window(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};
    if let Ok(hwnd) = window.hwnd() {
        // SAFETY: the window's own handle.
        unsafe {
            let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd.0), SW_HIDE);
        }
    }
}

#[cfg(not(windows))]
fn hide_window(window: &WebviewWindow) {
    let _ = window.hide();
}

/// Whether a full-screen app (a game, a presentation) is in front: the window then appears without taking the focus.
fn full_screen_app_in_front() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::{
            QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState,
        };
        // SAFETY: a plain query without arguments to keep.
        match unsafe { SHQueryUserNotificationState() } {
            Ok(state) => matches!(state, QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE),
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn reveal(gate: &GateWindow, window: &WebviewWindow) {
    if gate.ctx.overrides.offscreen {
        crate::windows::show_offscreen(window);
    } else if full_screen_app_in_front() {
        crate::windows::show_without_focus(window);
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn create(gate: &Arc<GateWindow>) -> tauri::Result<()> {
    let page = gate.clone();
    let mut builder = WebviewWindowBuilder::new(&gate.app, LABEL, WebviewUrl::App("update-splash/index.html".into()))
        .title("unimux")
        .inner_size(440.0, 200.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        // A normal window that others may cover (PLAN.md U2 / U1).
        .always_on_top(false)
        .focused(false)
        .visible(false)
        .background_color(tauri::window::Color(0x0d, 0x0d, 0x0d, 0xff))
        .initialization_script(crate::update_window::BRIDGE)
        .on_navigation(|url| {
            let origin = unimux_ipc::guard::origin_of(url.as_str());
            crate::context::app_origins().iter().any(|o| o.eq_ignore_ascii_case(origin))
        })
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                page.loaded.store(true, Ordering::SeqCst);
                page.push();
                if !page.hidden.load(Ordering::SeqCst) && window.is_visible().ok() != Some(true) {
                    reveal(&page, &window);
                }
            }
        })
        .devtools(cfg!(dev_overrides))
        .zoom_hotkeys_enabled(false)
        .browser_extensions_enabled(false);
    // The app's WebView2 folder and browser arguments: every webview of this process must use the same ones (0x8007139F).
    #[cfg(windows)]
    {
        builder = builder
            .additional_browser_args(&crate::windows::browser_args(gate.ctx.overrides.debug_port))
            .data_directory(crate::windows::webview_dir(&gate.ctx));
    }
    if gate.ctx.overrides.offscreen {
        builder = builder.position(-6000.0, 0.0).skip_taskbar(true).focusable(false);
    } else {
        builder = builder.center();
    }
    let window = builder.build()?;
    let events = gate.clone();
    window.on_window_event(move |event| match event {
        // X, Escape and Alt+F4 while the gate may still be cancelled: the gate decides (the window stays until it hides it).
        WindowEvent::CloseRequested { api, .. } => {
            if events.closable() {
                api.prevent_close();
                events.request_close();
            }
        }
        // Gone without `hide()` (crashed or destroyed): nobody could answer the prompt, so start the current version.
        WindowEvent::Destroyed => {
            events.created.store(false, Ordering::SeqCst);
            events.loaded.store(false, Ordering::SeqCst);
            if !events.closing.load(Ordering::SeqCst) {
                events.handle.cancel();
            }
        }
        _ => {}
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_states_match_gate_window_ts() {
        let texts = GateTexts::new("pl", "Aktualizacja nie powiodła się");
        let ask = gate_state(&GateView::Ask { version: "1.2.1".into() }, &texts, "1.2.0");
        assert_eq!(
            ask,
            json!({"stage": "ask", "percent": 0, "message": "Zainstalować ją teraz?", "title": "Dostępna nowa wersja 1.2.1",
                "versions": "1.2.0 → 1.2.1", "hint": "„Później” uruchamia obecną wersję. Zainstalujesz ją przyciskiem w stopce.",
                "closable": true, "primary": "Zainstaluj teraz", "secondary": "Później"})
        );
        let checking = gate_state(&GateView::Checking, &texts, "1.2.0");
        assert_eq!(checking["versions"], "1.2.0");
        assert_eq!(checking["title"], "Sprawdzanie aktualizacji…");
        let installing = gate_state(&GateView::Installing { version: "1.2.1".into() }, &texts, "1.2.0");
        assert_eq!((installing["stage"].as_str(), installing["closable"].as_bool()), (Some("downloading"), Some(false)));
        assert_eq!(installing["message"], "Przygotowanie aktualizacji…");
        let failed = gate_state(&GateView::Failed { version: "1.2.1".into() }, &texts, "1.2.0");
        assert_eq!(
            (failed["stage"].as_str(), failed["message"].as_str()),
            (Some("failed"), Some("Aktualizacja nie powiodła się"))
        );
        let en = GateTexts::new("en", "Aktualizacja nie powiodła się");
        let downloading = gate_state(&GateView::Downloading { version: "1.2.1".into(), percent: 42.0 }, &en, "1.2.0");
        assert_eq!(downloading["percent"], 42.0);
        assert_ne!(downloading["title"], "Aktualizacja do wersji 1.2.1");
    }
}
