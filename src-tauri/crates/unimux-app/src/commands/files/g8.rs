//! G8: notes (`notes:image:save` with the image as the raw body, `notes:image:read`, `notes:export`), the fs probes
//! (`fs:exists` with 1.1.4's 4 s limit, `fs:pathKinds`), the Monitor panel (`monitor:sample`, `monitor:kill`) and the
//! changelog (`changelog:get`). The work lives in unimux-files; this file runs it off the IPC threads and gives it the app's
//! parts: the data folder, the save dialog, the WebView2 processes and the HTTP client.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, Weak};

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_files::changelog::{Changelog, RELEASES_API, epoch_ms};
use unimux_files::monitor::{AppProcInfo, Monitor, RawProc};
use unimux_files::{notes, probe};
use unimux_ipc::RouterBuilder;

use super::blocking;
use crate::context::AppContext;

static MONITOR: OnceLock<Arc<Monitor>> = OnceLock::new();

/// The Monitor of this run (the pty service hands it the running cells with `set_cells`; the check build's test bridge
/// does so for the real-app checks).
#[cfg_attr(not(feature = "test-bridge"), allow(dead_code))]
pub fn monitor() -> Option<Arc<Monitor>> {
    MONITOR.get().cloned()
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    register_notes(r, ctx);
    register_probes(r);
    register_monitor(r, ctx);
    register_changelog(r, ctx);
}

// ── notes ────────────────────────────────────────────────────────────────────

fn register_notes(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let dir = ctx.data_dir.clone();
    r.invoke("notes:image:save", move |call| {
        let dir = dir.clone();
        async move {
            // The Uint8Array travels as the raw body (mc_invoke_raw); anything else leaves `body` empty and is refused.
            let body = call.body.clone();
            let mime = call.arg(1).clone();
            let name = blocking(&call.command, move || notes::save_note_image(&dir, body.as_deref(), &mime)).await?;
            Ok(name.map(Value::String).unwrap_or(Value::Null))
        }
    });

    let dir = ctx.data_dir.clone();
    r.invoke("notes:image:read", move |call| {
        let dir = dir.clone();
        async move {
            let name = call.arg(0).clone();
            let url = blocking(&call.command, move || notes::read_note_image(&dir, &name)).await?;
            Ok(url.map(Value::String).unwrap_or(Value::Null))
        }
    });

    let weak = Arc::downgrade(ctx);
    r.invoke("notes:export", move |call| {
        let weak = weak.clone();
        async move {
            let Some(request) = notes::export_request(call.arg(0), call.arg(1), call.arg(2)) else {
                return Ok(json!({ "ok": false }));
            };
            let Some(ctx) = weak.upgrade() else { return Ok(json!({ "ok": false })) };
            // MC_NOTES_EXPORT_DIR (check builds): straight into that folder, no dialog.
            let target = match &ctx.overrides.notes_export_dir {
                Some(dir) => Some(dir.join(notes::export_basename(&request.name))),
                None => pick_save_path(&ctx, &request).await,
            };
            let text = request.text;
            blocking(&call.command, move || notes::write_export(target, &text)).await
        }
    });
}

/// The save dialog of 1.1.4 (`pickSavePath`): the export title, the suggested name, one filter named after the extension, on
/// the main window while it exists. An offscreen check run records it instead of showing anything.
async fn pick_save_path(ctx: &Arc<AppContext>, request: &notes::ExportRequest) -> Option<PathBuf> {
    let language = crate::commands::os::language(&ctx.state.get());
    let title = unimux_core::i18n::translate(
        &language,
        if request.conversation { "Eksportuj rozmowę do Markdown" } else { "Eksportuj notatkę" },
        &[],
    );
    let (filter_name, ext) = notes::export_filter(&request.name);
    let main = ctx.app().and_then(|app| tauri::Manager::get_webview_window(app, crate::windows::MAIN));
    if let Some(recorder) = ctx.os.get().and_then(|os| os.recorder.clone()) {
        use crate::commands::os::{Desktop, PickRequest};
        let pick = PickRequest { folder: false, title, filter: Some((filter_name, vec![ext])), more_filters: Vec::new() };
        return recorder.pick(main, pick).await.map(PathBuf::from);
    }
    if ctx.overrides.offscreen {
        return None;
    }
    show_save_dialog(main, title, request.name.clone(), filter_name, ext).await
}

#[cfg(any(windows, target_os = "macos"))]
async fn show_save_dialog(
    parent: Option<tauri::WebviewWindow>,
    title: String,
    name: String,
    filter_name: String,
    ext: String,
) -> Option<PathBuf> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title(&title).set_file_name(&name).add_filter(&filter_name, &[ext]);
    if let Some(parent) = &parent {
        dialog = dialog.set_parent(parent);
    }
    dialog.save_file().await.map(|f| f.path().to_path_buf())
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn show_save_dialog(
    _parent: Option<tauri::WebviewWindow>,
    _title: String,
    _name: String,
    _filter_name: String,
    _ext: String,
) -> Option<PathBuf> {
    None
}

// ── fs probes ────────────────────────────────────────────────────────────────

fn register_probes(r: &mut RouterBuilder) {
    r.invoke("fs:exists", |call| async move {
        let Some(path) = probe::exists_arg(call.arg(0)) else { return Ok(Value::Bool(false)) };
        // After 4 s the folder counts as unreachable; the check itself may go on in the background (like 1.1.4's access()).
        let check = tauri::async_runtime::spawn_blocking(move || probe::path_exists_now(&path));
        let exists = matches!(tokio::time::timeout(probe::EXISTS_TIMEOUT, check).await, Ok(Ok(true)));
        Ok(Value::Bool(exists))
    });

    r.invoke("fs:pathKinds", |call| async move {
        let Some(paths) = probe::path_kinds_arg(call.arg(0)) else { return Ok(json!([])) };
        // Every stat at once (Promise.all), each on the blocking pool.
        let checks = paths.iter().cloned().map(|p| tauri::async_runtime::spawn_blocking(move || probe::path_kind(&p)));
        let kinds = futures::future::join_all(checks).await;
        Ok(Value::Array(kinds.into_iter().map(|k| k.ok().flatten().map(Value::from).unwrap_or(Value::Null)).collect()))
    });
}

// ── monitor ──────────────────────────────────────────────────────────────────

/// The kind and label of a WebView2 / WebKit process, remembered per process (pid and start) so its command line is read once.
type KindCache = Mutex<HashMap<(u32, u64), (String, Option<String>)>>;
/// A process's panel kind and label from its command line (None when it cannot be read).
#[cfg(windows)]
type Classify<'a> = &'a dyn Fn(Option<&str>) -> (&'static str, Option<String>);

fn register_monitor(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let weak = Arc::downgrade(ctx);
    let cache: Arc<KindCache> = Arc::default();
    let app_procs = move |procs: &[RawProc]| app_processes(&weak, &cache, procs);
    let monitor = MONITOR.get_or_init(|| Arc::new(Monitor::system(Arc::new(app_procs)))).clone();

    let m = monitor.clone();
    r.invoke("monitor:sample", move |call| {
        let m = m.clone();
        async move { blocking(&call.command, move || m.sample().to_json()).await }
    });

    let m = monitor;
    r.invoke("monitor:kill", move |call| {
        let m = m.clone();
        async move {
            let pid = call.arg(0).clone();
            blocking(&call.command, move || Value::Bool(m.kill(&pid))).await
        }
    });
}

/// The app's own processes: unimux.exe (`main`) and the WebView2 processes by the kind WebView2 gives them (macOS: the
/// WebKit processes the app is responsible for). Electron's hosts are gone: the pty, SFTP and DB services run in `main`.
fn app_processes(ctx: &Weak<AppContext>, cache: &KindCache, procs: &[RawProc]) -> Vec<AppProcInfo> {
    let main = std::process::id();
    let mut list = vec![AppProcInfo::new(main, "main", None)];
    #[cfg(windows)]
    {
        use unimux_files::monitor::model::{children_of, descendants};
        use unimux_files::monitor::webview::{self, WEBVIEW_EXE};
        use unimux_files::monitor::win::command_line;
        let start_of: HashMap<u32, u64> = procs.iter().map(|p| (p.pid, p.start.to_bits())).collect();
        let mut cache = cache.lock();
        cache.retain(|(pid, start), _| start_of.get(pid) == Some(start));
        let mut label = |pid: u32, classify: Classify| {
            let key = (pid, start_of.get(&pid).copied().unwrap_or(0));
            cache
                .entry(key)
                .or_insert_with(|| {
                    let (kind, name) = classify(command_line(pid).as_deref());
                    (kind.to_string(), name)
                })
                .clone()
        };
        let listed = ctx.upgrade().map(|c| webview2_processes(&c)).unwrap_or_default();
        let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::from([main]);
        for (pid, kind) in listed {
            if !seen.insert(pid) {
                continue;
            }
            let (kind, name) = if kind == webview::KIND_UTILITY {
                label(pid, &|line| webview::from_webview_kind(kind, line))
            } else {
                let (k, n) = webview::from_webview_kind(kind, None);
                (k.to_string(), n)
            };
            list.push(AppProcInfo { pid, kind, name });
        }
        // WebView2 processes WebView2 does not list (the crash handler; everything when the list could not be read).
        let children = children_of(procs);
        for i in descendants(procs, &children, main) {
            let p = &procs[i];
            if seen.contains(&p.pid) || !p.name.eq_ignore_ascii_case(WEBVIEW_EXE) {
                continue;
            }
            seen.insert(p.pid);
            let (kind, name) = label(p.pid, &|line| line.map(webview::from_command_line).unwrap_or(("other", None)));
            list.push(AppProcInfo { pid: p.pid, kind, name });
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (ctx, cache);
        list.extend(unimux_files::monitor::mac::webkit_processes(main, procs));
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (ctx, cache, procs);
    list
}

/// ICoreWebView2Environment8::GetProcessInfos of the app's WebView2 environment (one for every window): (pid, kind). Asked
/// on the UI thread through any app window; empty when no window answers within a second.
#[cfg(windows)]
fn webview2_processes(ctx: &AppContext) -> Vec<(u32, i32)> {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_PROCESS_KIND, ICoreWebView2Environment8};
    use windows::core::Interface;
    let Some(app) = ctx.app() else { return Vec::new() };
    let windows = app.webview_windows();
    let Some(window) = windows.get(crate::windows::MAIN).or_else(|| windows.values().next()) else { return Vec::new() };
    let (tx, rx) = std::sync::mpsc::channel::<Vec<(u32, i32)>>();
    let asked = window.with_webview(move |webview| {
        let mut out = Vec::new();
        // SAFETY: COM calls on the UI thread (with_webview); GetProcessInfos answers synchronously.
        unsafe {
            if let Ok(list) = webview.environment().cast::<ICoreWebView2Environment8>().and_then(|env| env.GetProcessInfos()) {
                let mut count = 0u32;
                let _ = list.Count(&mut count);
                for i in 0..count {
                    let Ok(info) = list.GetValueAtIndex(i) else { continue };
                    let (mut pid, mut kind) = (0i32, COREWEBVIEW2_PROCESS_KIND::default());
                    if info.ProcessId(&mut pid).is_ok() && info.Kind(&mut kind).is_ok() && pid > 0 {
                        out.push((pid as u32, kind.0));
                    }
                }
            }
        }
        let _ = tx.send(out);
    });
    if asked.is_err() {
        return Vec::new();
    }
    rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap_or_default()
}

// ── changelog ────────────────────────────────────────────────────────────────

fn http_client() -> Result<&'static unimux_net::HttpClient, String> {
    static CLIENT: OnceLock<Result<unimux_net::HttpClient, String>> = OnceLock::new();
    CLIENT.get_or_init(|| unimux_net::HttpClient::new().map_err(|e| e.to_string())).as_ref().map_err(Clone::clone)
}

/// index.ts changelog `fetchJson`: GitHub's media type, `User-Agent: unimux`, 10 s; a non-2xx answer is `GitHub <status>`.
fn fetch_releases() -> BoxFuture<'static, Result<Value, String>> {
    async {
        let client = http_client()?;
        let request = unimux_net::calls::changelog(RELEASES_API).map_err(|e| e.to_string())?;
        let response = client.fetch(request).await.map_err(|e| e.to_string())?;
        if !response.ok() {
            return Err(format!("GitHub {}", response.status));
        }
        // response.json(): UTF-8 with a leading BOM dropped.
        let text = String::from_utf8_lossy(&response.body);
        unimux_core::js_json::parse(text.strip_prefix('\u{feff}').unwrap_or(&text)).map_err(|e| e.to_string())
    }
    .boxed()
}

fn register_changelog(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let changelog = Changelog::new(Arc::new(fetch_releases), ctx.data_dir.join("changelog.json"), Arc::new(epoch_ms));
    r.invoke("changelog:get", move |call| {
        let changelog = changelog.clone();
        async move {
            // `force` skips the freshness check (a GitHub request each time).
            let force = call.arg(0) == &Value::Bool(true);
            Ok(changelog.get(force).await)
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::Instant;
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};
    use unimux_ipc::{Call, Caller, Contract, Reply, Router};

    fn context(data: &Path, overrides: DevOverrides) -> Arc<AppContext> {
        AppContext::new(
            data.to_path_buf(),
            overrides,
            Arc::new(RollingLog::crash_log(data)),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(data.join("startup.log"), "")),
            json!({ "version": 1, "projects": [] }),
        )
    }

    fn router(ctx: &Arc<AppContext>) -> Router {
        let mut builder = RouterBuilder::new(Contract::embedded());
        register(&mut builder, ctx);
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        builder.build(ctx.guard.clone())
    }

    fn call_with(router: &Router, command: &str, args: Value, body: Option<Vec<u8>>) -> Value {
        let caller =
            Caller::new("main", "http://tauri.localhost/index.html").with_request_origin(Some("http://tauri.localhost".into()));
        let mut call = Call::new(command, caller, args.as_array().unwrap().clone());
        call.body = body;
        match tauri::async_runtime::block_on(router.invoke(call)).unwrap() {
            Reply::Json(v) => v,
            other => panic!("{other:?}"),
        }
    }

    fn call(router: &Router, command: &str, args: Value) -> Value {
        call_with(router, command, args, None)
    }

    #[test]
    fn notes_channels_save_read_and_export_like_1_1_4() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let overrides = DevOverrides { notes_export_dir: Some(out.path().to_path_buf()), ..DevOverrides::default() };
        let ctx = context(data.path(), overrides);
        let r = router(&ctx);
        let png = vec![0x89, b'P', b'N', b'G', 1];
        let name = call_with(&r, "notes:image:save", json!([null, "image/png"]), Some(png.clone()));
        let name = name.as_str().unwrap().to_string();
        assert!(notes::is_note_image_name(&name));
        assert_eq!(std::fs::read(data.path().join("note-images").join(&name)).unwrap(), png);
        // Not a Uint8Array (no raw body) or not an image type: null.
        assert_eq!(call(&r, "notes:image:save", json!([[1, 2], "image/png"])), Value::Null);
        assert_eq!(call_with(&r, "notes:image:save", json!([null, "text/html"]), Some(png)), Value::Null);
        let url = call(&r, "notes:image:read", json!([name]));
        assert!(url.as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(call(&r, "notes:image:read", json!(["../state.json"])), Value::Null);
        // The export goes into MC_NOTES_EXPORT_DIR without a dialog.
        let answer = call(&r, "notes:export", json!(["Plan.md", "# Plan", null]));
        let path = out.path().join("Plan.md");
        assert_eq!(answer, json!({ "ok": true, "path": path.to_string_lossy() }));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Plan");
        assert_eq!(call(&r, "notes:export", json!(["../x.md", "x"])), json!({ "ok": false }));
        ctx.saver.stop();
    }

    #[test]
    fn an_offscreen_export_without_the_folder_never_shows_a_dialog() {
        let data = tempfile::tempdir().unwrap();
        let overrides = DevOverrides { offscreen: true, ..DevOverrides::default() };
        let ctx = context(data.path(), overrides);
        let r = router(&ctx);
        assert_eq!(call(&r, "notes:export", json!(["Plan.md", "x", "conversation"])), json!({ "ok": false, "cancelled": true }));
        ctx.saver.stop();
    }

    #[test]
    fn probes_answer_like_1_1_4() {
        let data = tempfile::tempdir().unwrap();
        let ctx = context(data.path(), DevOverrides::default());
        let r = router(&ctx);
        let d = data.path().to_string_lossy().into_owned();
        assert_eq!(call(&r, "fs:exists", json!([d])), json!(true));
        assert_eq!(call(&r, "fs:exists", json!([format!("{d}/nope")])), json!(false));
        assert_eq!(call(&r, "fs:exists", json!([""])), json!(false));
        assert_eq!(call(&r, "fs:exists", json!([7])), json!(false));
        std::fs::write(data.path().join("f"), "x").unwrap();
        let f = data.path().join("f").to_string_lossy().into_owned();
        assert_eq!(
            call(&r, "fs:pathKinds", json!([[d, f, "rel", 5, format!("{d}/gone")]])),
            json!(["dir", "file", null, null, null])
        );
        assert_eq!(call(&r, "fs:pathKinds", json!(["x"])), json!([]));
        assert_eq!(call(&r, "fs:pathKinds", json!([vec!["a"; 201]])), json!([]));
        ctx.saver.stop();
    }

    #[test]
    fn the_monitor_samples_this_process_and_refuses_kills_outside_a_cell() {
        let data = tempfile::tempdir().unwrap();
        let ctx = context(data.path(), DevOverrides::default());
        let r = router(&ctx);
        let sample = call(&r, "monitor:sample", json!([]));
        assert_eq!(sample["ok"], true, "{sample}");
        let me = std::process::id();
        let main = sample["app"].as_array().unwrap().iter().find(|a| a["pid"] == me).unwrap();
        assert_eq!(main["kind"], "main");
        assert!(sample["queryMs"].as_f64().unwrap() < 20.0, "{}", sample["queryMs"]);
        assert_eq!(call(&r, "monitor:kill", json!([me])), json!(false));
        assert_eq!(call(&r, "monitor:kill", json!(["1"])), json!(false));
        ctx.saver.stop();
    }

    #[test]
    fn changelog_get_answers_the_saved_copy_when_github_cannot_be_reached_or_the_live_list() {
        // Offline-safe: either GitHub answers (entries, not stale) or the saved copy is served with the error.
        let data = tempfile::tempdir().unwrap();
        std::fs::write(
            data.path().join("changelog.json"),
            json!([{ "tag_name": "v1.1.4", "name": "unimux 1.1.4", "body": "- x", "published_at": "2026-11-04T00:00:00Z" }])
                .to_string(),
        )
        .unwrap();
        let ctx = context(data.path(), DevOverrides::default());
        let r = router(&ctx);
        let result = call(&r, "changelog:get", json!([false]));
        let entries = result["entries"].as_array().unwrap();
        assert!(!entries.is_empty(), "{result}");
        if result.get("error").is_some() {
            assert_eq!(result["stale"], true);
            assert_eq!(entries[0]["version"], "1.1.4");
        } else {
            assert_eq!(result["stale"], false);
            assert!(entries.iter().any(|e| e["version"] == "1.1.4"));
        }
        ctx.saver.stop();
    }
}
