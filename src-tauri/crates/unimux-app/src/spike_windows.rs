//! Check-build only (feature `test-bridge`): the window probes of spike SP1 (docs/tauri/spikes/SP1.md).
//!
//! - `openWindow`: a second app window on the same WebView2 data folder, with the same browser arguments as the main window
//!   (or, to show the failure, different ones), hidden or visible, registered with the guard like a detached window.
//! - `window`: minimize / restore / hide / show a window or switch its WebView2 controller's `IsVisible`, and report how the
//!   window looks afterwards (Tauri, Win32 and WebView2 views of it).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use unimux_ipc::IpcError;

use crate::context::AppContext;

fn fail(m: &str) -> IpcError {
    IpcError::failed("test_bridge", m)
}

pub async fn open_window(ctx: &Arc<AppContext>, args: &Value) -> Result<Value, IpcError> {
    let label = args.get("label").and_then(Value::as_str).unwrap_or("detached-sp1").to_string();
    if !label.starts_with("detached-") {
        return Err(fail("openWindow: the label must start with detached-"));
    }
    let url = args.get("url").and_then(Value::as_str).unwrap_or("index.html?sp1=1").to_string();
    let visible = args.get("visible").and_then(Value::as_bool).unwrap_or(false);
    let different = args.get("browserArgs").and_then(Value::as_str) == Some("different");
    let app = ctx.app().ok_or_else(|| fail("no app yet"))?.clone();
    // A taken label belongs to a live window: refuse it before touching the guard, so a failed build can never drop the
    // live window's registration (W5 builds detached windows the same way).
    if app.get_webview_window(&label).is_some() {
        return Ok(json!({ "ok": false, "label": label, "error": "a window with this label exists", "buildMs": 0.0 }));
    }
    let registered = args.get("register").and_then(Value::as_bool).unwrap_or(true) && ctx.guard.register_detached(&label);
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.clone().into()))
        .title("unimux")
        .inner_size(1100.0, 700.0)
        .background_color(tauri::window::Color(0x0d, 0x0d, 0x0d, 0xff))
        .visible(visible)
        .initialization_script(crate::windows::boot_script(ctx, &label))
        .devtools(cfg!(dev_overrides))
        .disable_drag_drop_handler();
    #[cfg(windows)]
    {
        let mut browser_args = crate::windows::browser_args(ctx.overrides.debug_port);
        if different {
            browser_args.push_str(" --disable-gpu-vsync");
        }
        builder = builder.additional_browser_args(&browser_args).data_directory(crate::windows::webview_dir(ctx));
    }
    #[cfg(not(windows))]
    let _ = different;
    if ctx.overrides.offscreen {
        builder = builder.position(-6000.0, 0.0).skip_taskbar(true).focused(false).focusable(false);
    }
    let started = std::time::Instant::now();
    match builder.build() {
        Ok(window) => {
            crate::windows::apply_webview_settings(&window);
            crate::windows::forget_on_destroy(&window, ctx.clone());
            Ok(json!({ "ok": true, "label": label, "url": url, "buildMs": started.elapsed().as_secs_f64() * 1000.0 }))
        }
        Err(e) => {
            if registered {
                ctx.guard.forget_detached(&label);
            }
            Ok(
                json!({ "ok": false, "label": label, "error": e.to_string(), "buildMs": started.elapsed().as_secs_f64() * 1000.0 }),
            )
        }
    }
}

pub async fn window_op(ctx: &Arc<AppContext>, args: &Value) -> Result<Value, IpcError> {
    let label = args.get("label").and_then(Value::as_str).unwrap_or("main");
    let action = args.get("action").and_then(Value::as_str).unwrap_or("state");
    let app = ctx.app().ok_or_else(|| fail("no app yet"))?;
    let window = app.get_webview_window(label).ok_or_else(|| fail(&format!("no window {label}")))?;
    let done = match action {
        "minimize" => window.minimize(),
        "unminimize" => window.unminimize(),
        // What a click on the caption's minimize button / a restore from the taskbar does: WM_SYSCOMMAND to the window.
        // Unlike `minimize()` it never goes through tao's flag diff, which adds SW_HIDE when tao's VISIBLE flag is unset
        // (an offscreen run shows the window with a raw ShowWindow), so the window stays WS_VISIBLE + iconic like a user's.
        "sysMinimize" => sys_command(&window, SysCommand::Minimize),
        "sysRestore" => sys_command(&window, SysCommand::Restore),
        // ShowWindow(SW_HIDE), what tao's `hide()` does for a window tao knows is visible. In an offscreen run tao's flag
        // is unset, so `hide()` would be a no-op and the "hidden" phase would measure a shown window.
        "sysHide" => sys_command(&window, SysCommand::Hide),
        "hide" => window.hide(),
        "show" => show_quietly(ctx, &window),
        "close" => window.destroy(),
        "webviewHide" => set_controller_visible(&window, false).await,
        "webviewShow" => set_controller_visible(&window, true).await,
        "state" => Ok(()),
        other => return Err(fail(&format!("unknown window action {other}"))),
    };
    done.map_err(|e| fail(&e.to_string()))?;
    if action == "close" {
        return Ok(json!({ "label": label, "closed": true }));
    }
    // Window messages are posted to the event loop: give them a moment before reading the result back.
    if action != "state" {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Ok(window_state(&window).await)
}

#[derive(Clone, Copy)]
enum SysCommand {
    Minimize,
    Restore,
    Hide,
}

#[cfg(windows)]
fn sys_command(window: &WebviewWindow, cmd: SysCommand) -> tauri::Result<()> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        PostMessageW, SC_MINIMIZE, SC_RESTORE, SW_HIDE, ShowWindowAsync, WM_SYSCOMMAND,
    };
    let hwnd = windows::Win32::Foundation::HWND(window.hwnd()?.0);
    let sc = match cmd {
        SysCommand::Minimize => SC_MINIMIZE,
        SysCommand::Restore => SC_RESTORE,
        SysCommand::Hide => {
            // SAFETY: the window's own handle; the async variant runs on the window's UI thread.
            let _ = unsafe { ShowWindowAsync(hwnd, SW_HIDE) };
            return Ok(());
        }
    };
    // SAFETY: posts a system command to the window's own handle; its UI thread handles it like a caption click.
    let _ = unsafe { PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(sc as usize), LPARAM(0)) };
    Ok(())
}

#[cfg(not(windows))]
fn sys_command(window: &WebviewWindow, cmd: SysCommand) -> tauri::Result<()> {
    match cmd {
        SysCommand::Minimize => window.minimize(),
        SysCommand::Restore => window.unminimize(),
        SysCommand::Hide => window.hide(),
    }
}

/// Shows a window again; an offscreen run (MC_OFFSCREEN) never activates it.
fn show_quietly(ctx: &AppContext, window: &WebviewWindow) -> tauri::Result<()> {
    if ctx.overrides.offscreen {
        crate::windows::show_without_focus(window);
        Ok(())
    } else {
        window.show()
    }
}

#[cfg(windows)]
async fn set_controller_visible(window: &WebviewWindow, visible: bool) -> tauri::Result<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.with_webview(move |webview| {
        // SAFETY: a COM call on the live controller, on the thread Tauri runs this closure on.
        let r = unsafe { webview.controller().SetIsVisible(visible) };
        let _ = tx.send(r.is_ok());
    })?;
    let _ = tokio::time::timeout(Duration::from_secs(5), rx).await;
    Ok(())
}

#[cfg(not(windows))]
async fn set_controller_visible(window: &WebviewWindow, visible: bool) -> tauri::Result<()> {
    if visible { window.show() } else { window.hide() }
}

async fn window_state(window: &WebviewWindow) -> Value {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut state = json!({
        "label": window.label(),
        "visible": window.is_visible().ok(),
        "minimized": window.is_minimized().ok(),
    });
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
        if let Ok(hwnd) = window.hwnd() {
            let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
            // SAFETY: read-only queries on the window's own handle.
            let (shown, iconic) = unsafe { (IsWindowVisible(hwnd).as_bool(), IsIconic(hwnd).as_bool()) };
            state["hwndVisible"] = json!(shown);
            state["iconic"] = json!(iconic);
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        if window
            .with_webview(move |webview| {
                let mut v = windows::core::BOOL::default();
                // SAFETY: a COM getter on the live controller.
                let ok = unsafe { webview.controller().IsVisible(&mut v) }.is_ok();
                let _ = tx.send(ok.then(|| v.as_bool()));
            })
            .is_ok()
            && let Ok(Ok(v)) = tokio::time::timeout(Duration::from_secs(5), rx).await
        {
            state["controllerVisible"] = json!(v);
        }
    }
    state
}
