//! Debug-only commands for the real-app harness (feature `test-bridge`, never in a release build; CI checks the release
//! binary). They replace the Electron mainInspector: state peek, emitting an event, panic injection, a guard probe.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::ipc::Request;
use tauri::{State, Webview};

use unimux_ipc::{Caller, IpcError, Scope};

use crate::context::AppContext;

#[tauri::command]
pub async fn test_bridge(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    request: Request<'_>,
    op: String,
    args: Option<Value>,
) -> Result<Value, IpcError> {
    let args = args.unwrap_or(Value::Null);
    let fail = |m: &str| IpcError::failed("test_bridge", m);
    match op.as_str() {
        // The state as Rust holds it (revision, the state itself, whether a save is pending).
        "state" => Ok(json!({ "snapshot": ctx.state.snapshot().to_json(), "savePending": ctx.saver.has_pending() })),
        "flush" => Ok(json!({ "saved": ctx.flush_state() })),
        "paths" => Ok(json!({
            "dataDir": ctx.data_dir,
            "crashLog": ctx.crash.path(),
            "startupLog": ctx.startup_log.path(),
        })),
        "emit" => {
            let event = args.get("event").and_then(Value::as_str).ok_or_else(|| fail("emit needs {event, args}"))?;
            let list = args.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
            ctx.events.emit(Scope::Broadcast, event, list);
            Ok(Value::Null)
        }
        // A panic on a background thread: one crash.log line (and the error dialog, rate-limited).
        "panic" => {
            let message = args.get("message").and_then(Value::as_str).unwrap_or("test-bridge panic").to_string();
            let _ =
                std::thread::Builder::new().name("test-bridge-panic".into()).spawn(move || panic!("{message}")).map(|h| h.join());
            Ok(Value::Null)
        }
        // How the guard sees a caller (default: this webview).
        "probe" => {
            let label =
                args.get("label").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| webview.label().to_string());
            let url = args
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| webview.url().map(|u| u.to_string()).unwrap_or_default());
            // Default: the Origin header of this very request (what mc_invoke sees for this page).
            let origin = match args.get("requestOrigin") {
                Some(v) => v.as_str().map(str::to_string),
                None => request.headers().get("origin").and_then(|v| v.to_str().ok()).map(str::to_string),
            };
            let caller = Caller::new(label, url).with_request_origin(origin);
            Ok(json!({
                "label": caller.label,
                "url": caller.url,
                "requestOrigin": caller.request_origin,
                "allowed": ctx.guard_allows(&caller),
            }))
        }
        // Ends the app the normal way (the Exit event saves the state).
        "quit" => {
            if let Some(app) = ctx.app() {
                app.exit(0);
            }
            Ok(Value::Null)
        }
        // Live send / port lanes (a destroyed window must leave none behind).
        "lanes" => Ok(json!({
            "sends": ctx.sends.get().map(|q| q.lane_count()),
            "portPosts": ctx.port_posts.get().map(|q| q.lane_count()),
        })),
        "report" => Ok(serde_json::to_value(ctx.router().report()).unwrap_or(Value::Null)),
        _ => Err(fail(&format!("unknown op {op}"))),
    }
}
