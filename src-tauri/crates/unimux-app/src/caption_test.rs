//! Check-build only (feature `test-bridge`): the probes of the W1 caption check (scripts/verify-caption.mjs).
//!
//! - `probe`: the hit-test child of a window (rect, area, visibility) and the window's Win32 state.
//! - `scale`: a fixed WebView2 rasterization scale (the page's devicePixelRatio), the way the 1.1.4 references were taken
//!   with `--force-device-scale-factor`: 100, 125, 150 and 200 percent on any monitor.
//! - `guard` / `log`: records the system commands and context menus the window gets and swallows the ones that would put
//!   something on the user's desktop (a real maximize onto a monitor, the system menu, a move or size loop), so a check can
//!   prove a double-click or a right click on the title bar without showing anything.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{Manager, WebviewWindow};

use unimux_ipc::IpcError;

use crate::context::AppContext;

fn fail(m: &str) -> IpcError {
    IpcError::failed("test_bridge", m)
}

pub async fn caption_op(ctx: &Arc<AppContext>, args: &Value) -> Result<Value, IpcError> {
    let label = args.get("label").and_then(Value::as_str).unwrap_or("main");
    let action = args.get("action").and_then(Value::as_str).unwrap_or("probe");
    let app = ctx.app().ok_or_else(|| fail("no app yet"))?;
    let window = app.get_webview_window(label).ok_or_else(|| fail(&format!("no window {label}")))?;
    match action {
        "probe" => Ok(probe(&window)),
        "scale" => {
            let scale = args.get("scale").and_then(Value::as_f64).ok_or_else(|| fail("scale needs {scale}"))?;
            set_scale(&window, scale).await?;
            Ok(probe(&window))
        }
        "guard" => {
            guard(&window)?;
            Ok(json!({ "guarded": true }))
        }
        "log" => Ok(json!({ "log": win::take_log() })),
        other => Err(fail(&format!("unknown caption action {other}"))),
    }
}

fn probe(window: &WebviewWindow) -> Value {
    let mut out = crate::caption::probe(window.label());
    if let Ok(hwnd) = window.hwnd() {
        out["hwnd"] = json!(hwnd.0 as isize);
    }
    out["maximized"] = json!(window.is_maximized().ok());
    out["decorated"] = json!(window.is_decorated().ok());
    out
}

async fn set_scale(window: &WebviewWindow, scale: f64) -> Result<(), IpcError> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
    use windows::core::Interface;
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            // SAFETY: COM calls on the live controller, on the thread Tauri runs this closure on.
            let ok = unsafe {
                webview.controller().cast::<ICoreWebView2Controller3>().is_ok_and(|c3| {
                    c3.SetShouldDetectMonitorScaleChanges(false).is_ok() && c3.SetRasterizationScale(scale).is_ok()
                })
            };
            let _ = tx.send(ok);
        })
        .map_err(|e| fail(&e.to_string()))?;
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(true)) => Ok(()),
        _ => Err(fail("SetRasterizationScale failed")),
    }
}

fn guard(window: &WebviewWindow) -> Result<(), IpcError> {
    let hwnd = window.hwnd().map_err(|e| fail(&e.to_string()))?.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(win::install(hwnd));
        })
        .map_err(|e| fail(&e.to_string()))?;
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(true) => Ok(()),
        _ => Err(fail("SetWindowSubclass failed")),
    }
}

mod win {
    use parking_lot::Mutex;
    use serde_json::{Value, json};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        SC_KEYMENU, SC_MAXIMIZE, SC_MOUSEMENU, SC_MOVE, SC_SIZE, WM_CONTEXTMENU, WM_SYSCOMMAND,
    };

    static LOG: Mutex<Vec<Value>> = Mutex::new(Vec::new());
    const ID: usize = 0x5731; // "W1"

    pub fn take_log() -> Vec<Value> {
        std::mem::take(&mut *LOG.lock())
    }

    /// On the window's UI thread.
    pub fn install(hwnd: isize) -> bool {
        // SAFETY: subclasses the app's own top-level window from its UI thread; the procedure has no reference data.
        unsafe { SetWindowSubclass(HWND(hwnd as *mut _), Some(proc_), ID, 0).as_bool() }
    }

    unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_SYSCOMMAND {
            let command = (wparam.0 & 0xFFF0) as u32;
            LOG.lock().push(json!({ "msg": "syscommand", "command": command }));
            // A real maximize goes onto a monitor, a move / size loop and the system menu show on the desktop (a restore of
            // the off-screen window is harmless and lets a check bring a minimized window back).
            if [SC_MAXIMIZE, SC_MOVE, SC_SIZE, SC_KEYMENU, SC_MOUSEMENU].contains(&command) {
                return LRESULT(0);
            }
        }
        // WM_POPUPSYSTEMMENU (0x313, undocumented): DefWindowProc opens the system menu at the given point.
        if msg == 0x313 {
            LOG.lock().push(json!({ "msg": "popupsystemmenu", "w": wparam.0, "l": lparam.0 }));
            return LRESULT(0);
        }
        if msg == WM_CONTEXTMENU {
            let (x, y) = ((lparam.0 & 0xffff) as u16 as i16 as i32, ((lparam.0 >> 16) & 0xffff) as u16 as i16 as i32);
            LOG.lock().push(json!({ "msg": "contextmenu", "x": x, "y": y, "from": wparam.0 as isize }));
            // DefWindowProc would open the system menu here (right click on the caption).
            return LRESULT(0);
        }
        // SAFETY: the next procedure in the chain.
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }
}
