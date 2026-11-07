//! The main window (PLAN F11): created in code after the startup gate, hidden until the first page load finished or the
//! renderer booted (5 s fallback), with the WebView2 settings and browser arguments of 1.1.4, the boot values for window.mc,
//! the navigation lock and the minimize/restore detection behind `window:shown`.
//!
//! Wave 0 keeps the native title bar (decorations on); W1 replaces it with the caption buttons drawn like 1.1.4's overlay.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use unimux_ipc::Scope;

use crate::context::{AppContext, app_origins};

pub const MAIN: &str = "main";
const BACKGROUND: tauri::window::Color = tauri::window::Color(0x0d, 0x0d, 0x0d, 0xff);

/// The browser arguments of every app webview (they share one WebView2 data folder, so they must be identical: a mismatch
/// fails with 0x8007139F). WebGL contexts for a 5x4 grid, no background throttling, autoplay for alert sounds.
pub fn browser_args(debug_port: Option<u16>) -> String {
    let args = String::from(
        "--max-active-webgl-contexts=96 --disable-background-timer-throttling --disable-renderer-backgrounding \
         --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required \
         --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
    );
    // The DevTools port exists only in builds with dev-overrides: a release binary does not even contain the switch.
    #[cfg(dev_overrides)]
    if let Some(port) = debug_port {
        return format!("{args} --remote-debugging-port={port}");
    }
    #[cfg(not(dev_overrides))]
    let _ = debug_port;
    args
}

#[cfg(windows)]
static WEBVIEW_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Chooses the WebView2 user data folder of every app window once, before any webview exists: `<data>/webview2` when it is a
/// directory this user can write, else `%TEMP%\unimux-webview2\<hash of the data dir>` (PLAN.md U2 / SP6: WebView2 handed a
/// folder it cannot create shows Edge's own "cannot create data directory" box, which a user must never see). When neither is
/// usable the start fails with the app's own message (the same as an unreadable state.json) instead of that box. Windows only
/// (WKWebView uses its default store).
#[cfg(windows)]
pub fn init_webview_dir(data_dir: &std::path::Path, crash: &unimux_core::crash_log::RollingLog) {
    let preferred = data_dir.join("webview2");
    let fallback = unimux_platform::webview::temp_fallback_for(data_dir);
    let (chosen, refused) = unimux_platform::webview::choose_folder(&preferred, std::slice::from_ref(&fallback));
    for e in &refused {
        crash.warn(&format!("WebView2 data folder not usable: {e}"));
    }
    match chosen {
        Some(dir) => {
            if dir != preferred {
                crash.warn(&format!("WebView2 data folder: using {}", dir.display()));
            }
            let _ = WEBVIEW_DIR.set(dir);
        }
        None => crate::startup::startup_failed("no usable WebView2 data folder", Some(&preferred)),
    }
}

/// The folder chosen by [`init_webview_dir`] (`<data>/webview2` before it ran).
#[cfg(windows)]
pub fn webview_dir(ctx: &AppContext) -> std::path::PathBuf {
    WEBVIEW_DIR.get().cloned().unwrap_or_else(|| ctx.data_dir.join("webview2"))
}

/// `window.__MC_BOOT__`: the synchronous values of window.mc (platform, windowsBuild, label).
pub fn boot_script(ctx: &AppContext, label: &str) -> String {
    let boot = json!({ "platform": ctx.platform.as_str(), "windowsBuild": ctx.windows_build, "label": label });
    format!("window.__MC_BOOT__ = Object.freeze({boot});")
}

/// Navigation stays inside the app; an http(s) link opens in the browser and the app stays where it is.
fn allow_navigation(url: &tauri::Url) -> bool {
    let s = url.as_str();
    let origin = unimux_ipc::guard::origin_of(s);
    if app_origins().iter().any(|o| o.eq_ignore_ascii_case(origin)) || s.starts_with("about:blank") {
        return true;
    }
    if matches!(url.scheme(), "http" | "https") {
        unimux_platform::open_url(s);
    }
    false
}

pub fn create_main(app: &AppHandle, ctx: &Arc<AppContext>) -> tauri::Result<WebviewWindow> {
    let offscreen = ctx.overrides.offscreen;
    let (w, h) = if offscreen { (1100.0, 700.0) } else { (1600.0, 1000.0) };
    let page_ctx = ctx.clone();
    let mut builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("unimux")
        .inner_size(w, h)
        .min_inner_size(800.0, 500.0)
        .background_color(BACKGROUND)
        .visible(false)
        .initialization_script(boot_script(ctx, MAIN))
        .on_navigation(allow_navigation)
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                page_ctx.mark("page-loaded");
                show_main(&page_ctx);
            }
        })
        .devtools(cfg!(dev_overrides))
        .zoom_hotkeys_enabled(false)
        .browser_extensions_enabled(false)
        // HTML5 drag and drop (tab reorder and detach, snippets, notes, the explorer, SFTP) needs WebView2's own drop
        // target; Tauri's handler would replace it. OS file drops get their paths through W3 (pathsForFiles).
        .disable_drag_drop_handler();
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(&browser_args(ctx.overrides.debug_port)).data_directory(webview_dir(ctx));
    }
    if offscreen {
        builder = builder.position(-6000.0, 0.0).skip_taskbar(true).focused(false).focusable(false);
    } else {
        builder = builder.center();
    }
    let window = builder.build()?;
    ctx.mark("window-created");
    apply_webview_settings(&window);
    watch_window_state(&window, ctx.clone());
    forget_on_destroy(&window, ctx.clone());

    // The page may never report (a renderer stuck in boot): show the window after 5 s anyway.
    let fallback = ctx.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        show_main(&fallback);
    });
    Ok(window)
}

/// Shows the main window once (first page load, renderer-boot or the 5 s fallback). An offscreen run (MC_OFFSCREEN) never
/// takes the focus.
pub fn show_main(ctx: &AppContext) {
    if ctx.main_shown.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) = ctx.app().and_then(|a| a.get_webview_window(MAIN)) else {
        ctx.main_shown.store(false, Ordering::SeqCst);
        return;
    };
    ctx.mark("window-shown");
    // signalUpdateReady (1.1.4 did it on ready-to-show): completes the update window's last step. U3 adds the heartbeat wait
    // and clearGateFailureIfUpdated.
    let data_dir = ctx.data_dir.clone();
    std::thread::spawn(move || unimux_update::window::signal_update_ready(&data_dir, unimux_core::VERSION));
    if ctx.overrides.offscreen {
        show_without_focus(&window);
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(windows)]
pub(crate) fn show_without_focus(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWNOACTIVATE, ShowWindow};
    if let Ok(hwnd) = window.hwnd() {
        // SAFETY: the window's own handle; SW_SHOWNOACTIVATE never activates it.
        unsafe {
            let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd.0), SW_SHOWNOACTIVATE);
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn show_without_focus(window: &WebviewWindow) {
    let _ = window.show();
}

/// A second start of unimux (or a 1.1.x started on the same data dir): bring the main window up.
pub fn focus_main(ctx: &AppContext) {
    let Some(window) = ctx.app().and_then(|a| a.get_webview_window(MAIN)) else { return };
    if ctx.overrides.offscreen {
        return;
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Frees what a window leaves behind (send and port lanes, port sinks, detached registration) once it is destroyed. Every
/// app window (main and, from W5, the detached ones) is built with this.
pub fn forget_on_destroy(window: &WebviewWindow, ctx: Arc<AppContext>) {
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            ctx.window_destroyed(&label);
        }
    });
}

/// `window:shown` (false while minimized or hidden) and `window:maximized`, sent to that window on every change.
fn watch_window_state(window: &WebviewWindow, ctx: Arc<AppContext>) {
    let shown = Arc::new(AtomicBool::new(true));
    let maximized = Arc::new(AtomicBool::new(false));
    let w = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::Focused(_)) {
            return;
        }
        let now_shown = w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false);
        if shown.swap(now_shown, Ordering::SeqCst) != now_shown {
            ctx.events.emit(Scope::Window(w.label().to_string()), "window:shown", vec![Value::Bool(now_shown)]);
        }
        let now_max = w.is_maximized().unwrap_or(false);
        if maximized.swap(now_max, Ordering::SeqCst) != now_max {
            ctx.events.emit(Scope::Window(w.label().to_string()), "window:maximized", vec![Value::Bool(now_max)]);
        }
    });
}

/// WebView2 settings of 1.1.4's BrowserWindow: no default context menu, no browser accelerators (Ctrl+R/F5/P/F reach the
/// app), no zoom (Ctrl+wheel), non-client regions for the W1 caption buttons.
#[cfg(windows)]
pub(crate) fn apply_webview_settings(window: &WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Settings3, ICoreWebView2Settings9};
    use windows::core::Interface;
    let _ = window.with_webview(|webview| {
        // SAFETY: COM calls on the live controller, on the thread Tauri runs this closure on.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            let _ = settings.SetIsZoomControlEnabled(false);
            let _ = settings.SetIsStatusBarEnabled(false);
            if !cfg!(dev_overrides) {
                let _ = settings.SetAreDevToolsEnabled(false);
            }
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
            if let Ok(s9) = settings.cast::<ICoreWebView2Settings9>() {
                let _ = s9.SetIsNonClientRegionSupportEnabled(true);
            }
        }
    });
}

#[cfg(not(windows))]
pub(crate) fn apply_webview_settings(_window: &WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_args_are_the_same_for_every_webview() {
        let a = browser_args(None);
        assert!(a.contains("--max-active-webgl-contexts=96"));
        assert!(a.contains("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion"));
        assert_eq!(a, browser_args(None));
        #[cfg(dev_overrides)]
        assert!(browser_args(Some(9333)).ends_with(" --remote-debugging-port=9333"));
        #[cfg(not(dev_overrides))]
        assert_eq!(browser_args(Some(9333)), a);
    }

    #[test]
    fn navigation_stays_in_the_app() {
        assert!(allow_navigation(&"http://tauri.localhost/index.html?detached=x".parse().unwrap()));
        assert!(allow_navigation(&"tauri://localhost/index.html".parse().unwrap()));
        assert!(!allow_navigation(&"file:///C:/Windows/win.ini".parse().unwrap()));
    }
}
