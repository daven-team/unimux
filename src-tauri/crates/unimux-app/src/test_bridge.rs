//! Debug-only commands for the real-app harness (feature `test-bridge`, never in a release build; CI checks the release
//! binary). They replace the Electron mainInspector: state peek, emitting an event, panic injection, a guard probe, the
//! not-yet and recorded calls of a run (test_record.rs), the app windows and a user-like close request.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::ipc::Request;
use tauri::{Manager, State, Webview};

use unimux_ipc::{Caller, IpcError, Scope};

use crate::context::AppContext;

/// `unimux --launch-line <json>` (check build): the shell line a cell starts its CLI with, from `{profile, opts}` as
/// `buildCliCommand(profile, opts)` of src/shared/profiles.ts takes them, printed as `{"line": ...}`. P4 ports the builder;
/// until then the answer is `{"error": "MC_NOT_YET", ...}` with exit code 3, which verify-cli-contract.mjs reports as
/// "blocked by P4". None when the flag is absent.
pub fn launch_line_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--launch-line")?;
    let input = args.get(i + 1).and_then(|a| serde_json::from_str::<Value>(a).ok());
    let (out, code) = match input {
        None => (json!({ "error": "MC_BAD_ARGS", "message": "--launch-line needs a JSON {profile, opts}" }), 2),
        Some(_) => (json!({ "error": "MC_NOT_YET", "command": "launch-line", "owner": "P4" }), 3),
    };
    println!("{out}");
    Some(code)
}

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
            // `label`: one window (what Electron's `getAllWindows()[0].webContents.send` reached), else every app window.
            let scope = match args.get("label").and_then(Value::as_str) {
                Some(label) => Scope::Window(label.to_string()),
                None => Scope::Broadcast,
            };
            ctx.events.emit(scope, event, list);
            Ok(Value::Null)
        }
        // The window.mc commands pages asked for that no package implements yet ({command: count}), X1 "blocked by".
        "notYet" => Ok(ctx.test_record.not_yet()),
        // Records the calls of {channels: [...]} from now on (added to earlier recordings); `swallow: true` answers them with
        // null without running their handler (the mainInspector stubs of 1.1.4's verify scripts).
        "record" => {
            let channels: Vec<String> = args
                .get("channels")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .ok_or_else(|| fail("record needs {channels: [...]}"))?;
            ctx.test_record.start(channels, args.get("swallow").and_then(Value::as_bool).unwrap_or(false));
            Ok(Value::Null)
        }
        // The recorded calls [{kind, channel, label, args, at}] of {channel?} (default: all); `take: false` leaves them.
        "recorded" => Ok(ctx
            .test_record
            .recorded(args.get("channel").and_then(Value::as_str), args.get("take").and_then(Value::as_bool).unwrap_or(true))),
        // Every app window (main first) with how it looks (label, visible, minimized, focused).
        "windows" => {
            let app = ctx.app().ok_or_else(|| fail("no app yet"))?;
            let mut list: Vec<Value> = app
                .webview_windows()
                .into_values()
                .filter(|w| w.label() == "main" || w.label().starts_with("detached-"))
                .map(|w| {
                    json!({
                        "label": w.label(),
                        "url": w.url().map(|u| u.to_string()).unwrap_or_default(),
                        "visible": w.is_visible().ok(),
                        "minimized": w.is_minimized().ok(),
                        "maximized": w.is_maximized().ok(),
                        "focused": w.is_focused().ok(),
                    })
                })
                .collect();
            list.sort_by_key(|w| w["label"] != "main");
            Ok(Value::Array(list))
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
        // Rust's wall clock (ms since the Unix epoch) for the page's clock offset (Channel latency, SP1).
        "clock" => Ok(json!({ "now": crate::channel_bench::epoch_ms() })),
        // Renderer startup marks with the window that sent them (a hidden window reaches renderer-boot, SP1).
        "marks" => Ok(json!(
            ctx.test_marks
                .lock()
                .iter()
                .map(|(label, name, at)| json!({ "label": label, "name": name, "at": at }))
                .collect::<Vec<_>>()
        )),
        // A second app window (SP1: same browser arguments on two windows; `browserArgs: "different"` shows the 0x8007139F
        // failure a mismatch causes). W5 builds the real detached windows.
        "openWindow" => crate::spike_windows::open_window(&ctx, &args).await,
        // Minimize / hide / WebView2 IsVisible of a window and how it looks afterwards (SP1 background timers).
        "window" => crate::spike_windows::window_op(&ctx, &args).await,
        // SP6: stage the runtime copy ahead of the hand-over (1.1.4 staged it when the update was found), {updaterRoot, version?}.
        "update-stage" => {
            let root = args.get("updaterRoot").and_then(Value::as_str).ok_or_else(|| fail("update-stage needs updaterRoot"))?;
            let version = args.get("version").and_then(Value::as_str).unwrap_or(unimux_core::VERSION);
            let runtime = std::path::Path::new(root).join(format!("runtime-{version}"));
            let exe = std::env::current_exe().map_err(|e| fail(&e.to_string()))?;
            let started = std::time::Instant::now();
            let staged = unimux_update::window::stage_runtime(&exe, &runtime).map_err(|e| fail(&e.to_string()))?;
            Ok(json!({ "runtimeExe": staged, "copyMs": started.elapsed().as_millis() as u64 }))
        }
        // SP6: the update window hand-over with a local installer (U1/U2 call it after the download and the wind-down), then
        // the app exits like an update does. Args: {installer, updaterRoot, version?, fromVersion?, language?, timeoutMs?,
        // env? (extra environment of the window), webviewDir?}.
        "update-handover" => {
            let path = |key: &str| args.get(key).and_then(Value::as_str).map(std::path::PathBuf::from);
            let installer = path("installer").ok_or_else(|| fail("update-handover needs installer"))?;
            let updater_root = path("updaterRoot").ok_or_else(|| fail("update-handover needs updaterRoot"))?;
            let hand = unimux_update::window::HandOver {
                installer,
                version: args.get("version").and_then(Value::as_str).unwrap_or(unimux_core::VERSION).to_string(),
                from_version: args.get("fromVersion").and_then(Value::as_str).unwrap_or(unimux_core::VERSION).to_string(),
                data_dir: ctx.data_dir.clone(),
                updater_root,
                app_exe: std::env::current_exe().map_err(|e| fail(&e.to_string()))?,
                language: args.get("language").and_then(Value::as_str).unwrap_or("en").to_string(),
                timeout_ms: args.get("timeoutMs").and_then(Value::as_u64).unwrap_or(unimux_update::window::INSTALL_TIMEOUT_MS),
                env: args
                    .get("env")
                    .and_then(Value::as_object)
                    .map(|env| env.iter().map(|(k, v)| (k.into(), v.as_str().unwrap_or_default().into())).collect()),
                webview_dir: path("webviewDir"),
            };
            let result = tauri::async_runtime::spawn_blocking(move || unimux_update::window::hand_over(&hand))
                .await
                .map_err(|e| fail(&e.to_string()))?
                .map_err(|e| fail(&e.to_string()))?;
            if let Some(app) = ctx.app().cloned() {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    app.exit(0);
                });
            }
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        _ => Err(fail(&format!("unknown op {op}"))),
    }
}
