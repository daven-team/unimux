//! Debug-only commands for the real-app harness (feature `test-bridge`, never in a release build; CI checks the release
//! binary). They replace the Electron mainInspector: state peek, emitting an event, panic injection, a guard probe.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::ipc::Request;
use tauri::{Manager, State, Webview};

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
        // The page's answer to an eval-bridge request (eval_bridge.rs, the macOS stand-in for CDP).
        "evalResult" => crate::eval_bridge::deliver(&args).map(|_| Value::Null).map_err(|e| fail(&e)),
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
        // A main-to-renderer message through the 1.1.4 routing (routeMessage): `{channel, args}`.
        "send" => {
            let channel = args.get("channel").and_then(Value::as_str).ok_or_else(|| fail("send needs {channel, args}"))?;
            let list = args.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
            ctx.events.send(channel, list);
            Ok(Value::Null)
        }
        // W5: what the detached-window service holds, the open app windows and the screen in DIPs.
        "detached" => Ok(json!({
            "service": ctx.detached.debug_view(),
            "appWindows": ctx.events.app_windows(),
        })),
        // W5: a detached window as the OS sees it (physical outer rect, visible, maximized), or a move / resize / close of
        // it like a user's: {id, action: "state" | "move" | "close", x?, y?, width?, height?}.
        "detachedWindow" => crate::detached::host::test_window_op(&ctx, &args).await,
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
        // safeStorage (B2): `info` tells whether the key was opened before this call (null: nothing touched it yet), then
        // opens it; `encrypt` / `decrypt` go through the same base64 helpers the vaults use. Check build only: the harness
        // works on scratch data dirs with throwaway secrets.
        "safeStorage" => {
            use unimux_oscrypt::SafeCipher;
            let storage = &ctx.safe_storage;
            let strings = |key: &str| -> Vec<String> {
                args.get(key)
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default()
            };
            match args.get("op").and_then(Value::as_str).unwrap_or("info") {
                "info" => {
                    let before = storage.opened().map(|o| o.label());
                    Ok(json!({
                        "openedBefore": before,
                        "storage": storage.storage(),
                        "available": storage.available(),
                        "origin": storage.opened().map(|o| o.label()),
                        "reason": storage.opened().and_then(|o| o.reason()),
                    }))
                }
                "encrypt" => Ok(Value::Array(
                    strings("texts")
                        .iter()
                        .map(|t| storage.encrypt_base64(t).map_or_else(|e| json!({ "error": e.to_string() }), Value::String))
                        .collect(),
                )),
                "decrypt" => Ok(Value::Array(
                    strings("secrets")
                        .iter()
                        .map(|s| {
                            storage
                                .decrypt_base64(s)
                                .map_or_else(|e| json!({ "error": e.to_string() }), |t| json!({ "text": t.as_str() }))
                        })
                        .collect(),
                )),
                other => Err(fail(&format!("unknown safeStorage op {other}"))),
            }
        }
        // Ends the app the normal way: app.exit goes through the quit (question, wind-down, last save), W6.
        "quit" => {
            if let Some(app) = ctx.app() {
                app.exit(0);
            }
            Ok(Value::Null)
        }
        // W6: the main window's close request (the close button, Alt+F4, the taskbar's "Close window").
        "close" => {
            let window =
                ctx.app().and_then(|a| a.get_webview_window(crate::windows::MAIN)).ok_or_else(|| fail("no main window"))?;
            window.close().map_err(|e| fail(&e.to_string()))?;
            Ok(Value::Null)
        }
        // W6: quit question, session end, renderer state, the wind-down plan and the dialogs an unattended run recorded.
        "lifecycle" => Ok(crate::lifecycle::report(&ctx)),
        // W6: answers a recorded dialog, {id, response} (the index of the button).
        "dialogAnswer" => {
            let id = args.get("id").and_then(Value::as_u64).ok_or_else(|| fail("dialogAnswer needs {id, response}"))?;
            let response = args.get("response").and_then(Value::as_u64).unwrap_or(0) as usize;
            Ok(json!({ "answered": crate::lifecycle::answer_dialog(&ctx, id, response) }))
        }
        // W6: a slow service (a wind-down step that takes {ms}), so a start during the wind-down can be tested; also the pid.
        "windDownDelay" => {
            let ms = args.get("ms").and_then(Value::as_u64).unwrap_or(3000).min(15_000);
            ctx.lifecycle.wind_down.register(
                crate::lifecycle::wind_down::phase::STOP_SERVICES,
                "test delay",
                std::time::Duration::from_millis(ms + 1000),
                move || async move { tokio::time::sleep(std::time::Duration::from_millis(ms)).await },
            );
            Ok(json!({ "pid": std::process::id() }))
        }
        // W6: the pid of the main page's renderer process (the harness ends it to test the crash path).
        "rendererPid" => {
            let label = args.get("label").and_then(Value::as_str).unwrap_or(crate::windows::MAIN);
            let window = ctx.app().and_then(|a| a.get_webview_window(label)).ok_or_else(|| fail("no such window"))?;
            let pid = tauri::async_runtime::spawn_blocking(move || crate::lifecycle::webview::renderer_pid(&window))
                .await
                .map_err(|e| fail(&e.to_string()))?;
            Ok(json!({ "pid": pid }))
        }
        // Live send / port lanes (a destroyed window must leave none behind).
        "lanes" => Ok(json!({
            "sends": ctx.sends.get().map(|q| q.lane_count()),
            "portPosts": ctx.port_posts.get().map(|q| q.lane_count()),
        })),
        "report" => Ok(serde_json::to_value(ctx.router().report()).unwrap_or(Value::Null)),
        // W4: the offscreen desktop recorder (toasts, dialogs, shell, beep, flash, clipboard), see commands::os::test_op.
        "os" => crate::commands::os::test_op(&ctx, &args).map_err(|e| fail(&e)),
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
        // U2: stage and warm the runtime copy ahead of the hand-over, as U1 does once the download is verified (1.1.4 staged it
        // when the update was found), {updaterRoot, version?}.
        "update-stage" => {
            let root = args.get("updaterRoot").and_then(Value::as_str).ok_or_else(|| fail("update-stage needs updaterRoot"))?;
            let root = std::path::PathBuf::from(root);
            let version = args.get("version").and_then(Value::as_str).unwrap_or(unimux_core::VERSION).to_string();
            let exe = std::env::current_exe().map_err(|e| fail(&e.to_string()))?;
            let staged = tauri::async_runtime::spawn_blocking(move || unimux_update::window::prestage(&exe, &root, &version))
                .await
                .map_err(|e| fail(&e.to_string()))?
                .map_err(|e| fail(&e.to_string()))?;
            Ok(serde_json::to_value(staged).unwrap_or(Value::Null))
        }
        // SP6: the update window hand-over with a local installer (U1/U2 call it after the download and the wind-down), then
        // the app exits like an update does. Args: {installer, updaterRoot, version?, fromVersion?, language?, timeoutMs?,
        // env? (extra environment of the window), webviewDir?, windDownMs?}.
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
            // `windDownMs`: how long the app takes to exit after the window is shown (W6's wind-down; default 300 ms), so a run
            // can show the window's "closing" stage.
            let wind_down = args.get("windDownMs").and_then(Value::as_u64).unwrap_or(300);
            if let Some(app) = ctx.app().cloned() {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(wind_down));
                    app.exit(0);
                });
            }
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        // W2: the app menu as installed (none on Windows) and, on macOS, the WebKit text defaults WebKit will read.
        "macos" => {
            let menu = ctx.app().and_then(|a| a.menu()).map(|m| menu_json(m.items().unwrap_or_default()));
            #[cfg(target_os = "macos")]
            let text_defaults: Value =
                unimux_platform::mac::text_defaults().into_iter().map(|(k, v)| (k.to_string(), json!(v))).collect();
            #[cfg(not(target_os = "macos"))]
            let text_defaults = Value::Null;
            Ok(json!({ "menu": menu, "textDefaults": text_defaults }))
        }
        _ => Err(fail(&format!("unknown op {op}"))),
    }
}

/// A menu as `[{text, items?}]` (separators as "-"), for the eval-bridge smoke.
fn menu_json<R: tauri::Runtime>(items: Vec<tauri::menu::MenuItemKind<R>>) -> Value {
    use tauri::menu::MenuItemKind;
    Value::Array(
        items
            .into_iter()
            .map(|item| match item {
                MenuItemKind::Submenu(sub) => {
                    json!({ "text": sub.text().unwrap_or_default(), "items": menu_json(sub.items().unwrap_or_default()) })
                }
                MenuItemKind::MenuItem(i) => json!({ "text": i.text().unwrap_or_default(), "id": i.id().as_ref() }),
                MenuItemKind::Predefined(i) => {
                    let text = i.text().unwrap_or_default();
                    json!({ "text": if text.is_empty() { "-".to_string() } else { text } })
                }
                MenuItemKind::Check(i) => json!({ "text": i.text().unwrap_or_default() }),
                MenuItemKind::Icon(i) => json!({ "text": i.text().unwrap_or_default() }),
            })
            .collect(),
    )
}
