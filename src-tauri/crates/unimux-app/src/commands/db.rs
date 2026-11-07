//! Commands of the `db` domain: D1-D12: database connections and sessions (db:*); the db port owner registers with ctx.ports.register("db", ...).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! D1 (port of the DB parts of src/main/index.ts, src/main/db/ipc.ts, history.ts, sqliteFiles.ts): the saved connections and
//! their passwords (`db/vault.json` through the app's safeStorage), the sessions with their states, prompts, pins and idle
//! disconnect (`unimux_db::service`), the query history (`db/query_history.json`, written 1.5 s after a change and in the
//! wind-down's save phase), the SQLite file and CA dialogs, the result export, and the `db:*` events. Every request passes
//! the 1.1.4 validation first (`unimux_db::ipc`). The sessions themselves are D4 / D7 / D9 / D11 (routed by D12): until they
//! land, the host link ends every session with `unsupported`, and tunnels wait for the SSH coordinator (S3).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use unimux_core::i18n::translate;
use unimux_db::history::{DbHistoryStore, WRITE_DELAY_MS};
use unimux_db::host::{DbHostLink, Spawn, UnavailableHost};
use unimux_db::ipc;
use unimux_db::service::{DbDeps, DbEvents, DbService, DbStateAccess, NoCoordinator, PROMPT_TIMEOUT_MS, ReadCa, TEST_TIMEOUT_MS};
use unimux_db::sql::limits;
use unimux_db::sqlite_files::create_sqlite_file;
use unimux_db::timers::{Timers, TokioTimers};
use unimux_db::vault::DbVault;
use unimux_ipc::{Events, IpcError, RouterBuilder};
use unimux_oscrypt::SafeCipher;

use crate::commands::os::{PickRequest, SaveRequest, language};
use crate::context::AppContext;
use crate::lifecycle::wind_down::phase;

/// The state the DB service reads and edits: the app's StateController.
struct AppState(Arc<AppContext>);

impl DbStateAccess for AppState {
    fn state(&self) -> Arc<Value> {
        self.0.state.get()
    }
    fn change(&self, f: Box<dyn FnOnce(&Value) -> Value + Send>) {
        let _ = self.0.state.change(move |s| Ok(f(s)), None, false);
    }
    fn ssh_host_exists(&self, host_id: &str) -> bool {
        self.0
            .state
            .get()
            .get("sshHosts")
            .and_then(Value::as_array)
            .is_some_and(|hosts| hosts.iter().any(|h| h.get("id").and_then(Value::as_str) == Some(host_id)))
    }
}

/// `db:session`, `db:prompt`, `db:hostCrashed`, `db:vault:changed` (broadcast to every app window).
struct AppEvents {
    events: Arc<Events>,
    vault: Arc<DbVault>,
}

impl DbEvents for AppEvents {
    fn session(&self, state: &Value) {
        self.events.send("db:session", vec![state.clone()]);
    }
    fn prompt(&self, session_id: &str, prompt: Option<&Value>) {
        self.events.send("db:prompt", vec![json!(session_id), prompt.cloned().unwrap_or(Value::Null)]);
    }
    fn host_crashed(&self) {
        self.events.send("db:hostCrashed", vec![]);
    }
    fn vault_changed(&self) {
        self.events.send("db:vault:changed", vec![self.vault.info().to_json()]);
    }
}

/// `path.isAbsolute` of Node on this OS (Windows also takes `\x` and `/x`, which are rooted on the current drive).
fn is_absolute(path: &str) -> bool {
    let p = Path::new(path);
    p.is_absolute() || p.has_root()
}

/// The CA file of a verify-full connection: read at connect time, never sent back (None: not absolute, not a file, too big
/// or unreadable).
fn read_ca() -> ReadCa {
    Arc::new(|path: String| {
        Box::pin(async move {
            if !is_absolute(&path) {
                return None;
            }
            let info = tokio::fs::metadata(&path).await.ok()?;
            if !info.is_file() || info.len() > limits::CA_BYTES as u64 {
                return None;
            }
            let bytes = tokio::fs::read(&path).await.ok()?;
            Some(String::from_utf8_lossy(&bytes).into_owned())
        })
    })
}

fn connection_exists(ctx: &AppContext, id: &str) -> bool {
    ctx.state
        .get()
        .get("dbConnections")
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|c| c.get("id").and_then(Value::as_str) == Some(id)))
}

/// The id of the window that asked (`senderWindow`): a detached window's id, else `main`.
fn window_of(ctx: &AppContext, label: &str) -> String {
    ctx.detached.sender_window(label)
}

/// `window` of a DB operation: None for the main window.
fn op_window(ctx: &AppContext, label: &str) -> Option<String> {
    Some(window_of(ctx, label)).filter(|w| w != "main")
}

fn tr(ctx: &AppContext, key: &str) -> String {
    translate(&language(&ctx.state.get()), key, &[])
}

/// Runs vault and file work off the async threads (DPAPI / Keychain, atomic writes).
async fn blocking<T: Send + 'static>(command: &str, f: impl FnOnce() -> T + Send + 'static) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IpcError::failed(command, e.to_string()))
}

fn db_filters() -> Vec<(String, Vec<String>)> {
    vec![("*".to_string(), vec!["*".to_string()])]
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let spawn: Spawn = Arc::new(|f| {
        tauri::async_runtime::spawn(f);
    });
    let timers: Arc<dyn Timers> = Arc::new(TokioTimers::new(tauri::async_runtime::handle().inner().clone()));
    let db_dir = ctx.data_dir.join("db");
    let vault = Arc::new(DbVault::new(db_dir.join("vault.json"), ctx.safe_storage.clone() as Arc<dyn SafeCipher>));
    // 1.1.4 decrypts a DPAPI vault when it opens it at start (locked passwords show at once); off the main thread, since the
    // first cipher call opens the key.
    let warm = vault.clone();
    let _ = std::thread::Builder::new().name("unimux-db-vault".into()).spawn(move || warm.warm());
    let host = UnavailableHost::new(spawn.clone());
    let service = DbService::new(DbDeps {
        state: Arc::new(AppState(ctx.clone())),
        host: host.clone() as Arc<dyn DbHostLink>,
        coordinator: Arc::new(NoCoordinator),
        vault: vault.clone(),
        read_ca: read_ca(),
        events: Arc::new(AppEvents { events: ctx.events.clone(), vault: vault.clone() }),
        timers: timers.clone(),
        spawn,
        now: Arc::new(unimux_core::time::now_ms),
        new_uuid: Arc::new(|| uuid::Uuid::new_v4().to_string()),
        idle_ms: limits::IDLE_MS,
        prompt_timeout_ms: PROMPT_TIMEOUT_MS,
        test_timeout_ms: TEST_TIMEOUT_MS,
    });
    host.connect_weak(Arc::downgrade(&service), |s: &DbService, m| s.on_host_message(m));

    // After every state change: the passwords of deleted connections go (1.1.4 `db?.stateChanged()`).
    let svc = service.clone();
    ctx.state.on_change(move |change| svc.state_changed(&change.snapshot.state));

    // A page reloads, crashed or its window closed: that window's pins go (its page pins its tabs again).
    let svc = service.clone();
    ctx.lifecycle.on_page_gone(move |label| {
        if label == crate::windows::MAIN {
            svc.renderer_gone("main");
        } else if let Some(id) = unimux_ipc::route::detached_id(label) {
            svc.renderer_gone(&id);
        }
    });
    let svc = service.clone();
    ctx.detached.hooks().on_page_gone.push(Arc::new(move |id: &str, _closed: bool| svc.renderer_gone(id)));

    // The query history: written 1.5 s after a change, and in the wind-down once the renderers had their last say.
    let weak = Arc::downgrade(ctx);
    let history = DbHistoryStore::new(
        db_dir.join("query_history.json"),
        move |id| weak.upgrade().is_some_and(|c| connection_exists(&c, id)),
        timers,
        WRITE_DELAY_MS,
    );
    let h = history.clone();
    ctx.lifecycle.wind_down.register(phase::SAVE, "db history save", Duration::from_secs(1), move || async move {
        let _ = tauri::async_runtime::spawn_blocking(move || h.flush()).await;
    });

    register_connections(r, ctx, &service);
    register_sessions(r, ctx, &service);
    register_history(r, &history);
    register_files(r, ctx);
}

fn register_connections(r: &mut RouterBuilder, _ctx: &Arc<AppContext>, service: &Arc<DbService>) {
    let s = service.clone();
    r.invoke("db:connections:save", move |call| {
        let s = s.clone();
        async move {
            let (input, change) = (call.arg(0).clone(), call.arg(1).clone());
            blocking(&call.command, move || ipc::save(&s, &input, &change)).await
        }
    });
    let s = service.clone();
    r.invoke("db:connections:delete", move |call| {
        let s = s.clone();
        async move {
            let id = call.arg(0).clone();
            blocking(&call.command, move || ipc::remove(&s, &id)).await
        }
    });
    let s = service.clone();
    r.invoke("db:connections:duplicate", move |call| {
        let s = s.clone();
        async move {
            let id = call.arg(0).clone();
            blocking(&call.command, move || ipc::duplicate(&s, &id)).await
        }
    });
    let s = service.clone();
    r.invoke("db:connections:test", move |call| {
        let s = s.clone();
        async move {
            let (input, password) = (call.arg(0).clone(), call.arg(1).clone());
            // A saved password is decrypted before the test starts: off the async threads.
            let wait = blocking(&call.command, move || ipc::test(&s, &input, &password)).await?;
            Ok(wait.await)
        }
    });
    let s = service.clone();
    r.invoke("db:vault:info", move |call| {
        let s = s.clone();
        async move { blocking(&call.command, move || s.vault_info()).await }
    });
}

fn register_sessions(r: &mut RouterBuilder, ctx: &Arc<AppContext>, service: &Arc<DbService>) {
    let s = service.clone();
    r.invoke("db:connect", move |call| {
        let s = s.clone();
        async move { Ok(ipc::connect(&s, call.arg(0), call.arg(1))) }
    });
    let s = service.clone();
    r.invoke("db:disconnect", move |call| {
        let s = s.clone();
        async move { Ok(ipc::disconnect(&s, call.arg(0))) }
    });
    let s = service.clone();
    r.invoke("db:sessions", move |_call| {
        let s = s.clone();
        async move { Ok(s.snapshot()) }
    });
    let s = service.clone();
    r.invoke("db:prompt:answer", move |call| {
        let s = s.clone();
        async move { Ok(ipc::answer_prompt(&s, call.arg(0))) }
    });
    let (s, c) = (service.clone(), ctx.clone());
    r.invoke("db:pg", move |call| {
        let (s, c) = (s.clone(), c.clone());
        async move { Ok(ipc::pg(&s, call.arg(0), call.arg(1), op_window(&c, &call.caller.label)).await) }
    });
    let (s, c) = (service.clone(), ctx.clone());
    r.invoke("db:redis", move |call| {
        let (s, c) = (s.clone(), c.clone());
        async move { Ok(ipc::redis(&s, call.arg(0), call.arg(1), op_window(&c, &call.caller.label)).await) }
    });
    let (s, c) = (service.clone(), ctx.clone());
    r.send("db:pin", move |call| {
        let (s, c) = (s.clone(), c.clone());
        async move { ipc::pin(&s, call.arg(0), &window_of(&c, &call.caller.label)) }
    });
}

fn register_history(r: &mut RouterBuilder, history: &Arc<DbHistoryStore>) {
    let h = history.clone();
    r.invoke("db:history:list", move |call| {
        let h = h.clone();
        async move {
            let id = call.arg(0).clone();
            blocking(&call.command, move || h.list(&id)).await
        }
    });
    let h = history.clone();
    r.send("db:history:record", move |call| {
        let h = h.clone();
        async move {
            let (id, records) = (call.arg(0).clone(), call.arg(1).clone());
            let _ = tauri::async_runtime::spawn_blocking(move || h.record(&id, &records)).await;
        }
    });
    let h = history.clone();
    r.invoke("db:history:star", move |call| {
        let h = h.clone();
        async move {
            let (cid, id, star) = (call.arg(0).clone(), call.arg(1).clone(), call.arg(2).clone());
            blocking(&call.command, move || ipc::history_star(&h, &cid, &id, &star)).await
        }
    });
    let h = history.clone();
    r.invoke("db:history:clear", move |call| {
        let h = h.clone();
        async move {
            let (cid, stars) = (call.arg(0).clone(), call.arg(1).clone());
            blocking(&call.command, move || ipc::history_clear(&h, &cid, &stars)).await
        }
    });
    let h = history.clone();
    r.invoke("db:history:enabled", move |call| {
        let h = h.clone();
        async move {
            let enabled = call.arg(0).clone();
            blocking(&call.command, move || ipc::history_enabled(&h, &enabled)).await
        }
    });
}

/// SQLite files, the CA file and the export: only paths go back to the renderer, the renderer never names where to write.
/// The dialogs belong to the main window (1.1.4 `showOpen` / `showSaveDialog(win)`); an offscreen check run answers them from
/// the test bridge's queue (W4's recorder), so no dialog appears on the desktop.
fn register_files(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let c = ctx.clone();
    r.invoke("db:sqlite:pick", move |_call| {
        let c = c.clone();
        async move {
            let Some(os) = c.os.get().cloned() else { return Ok(Value::Null) };
            let request = PickRequest {
                folder: false,
                title: tr(&c, "Otwórz plik bazy SQLite"),
                filter: Some(("SQLite".to_string(), ["db", "sqlite", "sqlite3", "db3"].map(String::from).to_vec())),
                more_filters: db_filters(),
            };
            Ok(os.pick_file(crate::windows::MAIN, request).await.map(Value::String).unwrap_or(Value::Null))
        }
    });
    // No path: the save dialog asks where. A typed path: created there (it must not exist yet).
    let c = ctx.clone();
    r.invoke("db:sqlite:create", move |call| {
        let c = c.clone();
        async move {
            let path = call.arg(0).clone();
            if !path.is_null() {
                return blocking(&call.command, move || ipc::sqlite_create_at(&path)).await;
            }
            let Some(os) = c.os.get().cloned() else { return Ok(json!({ "ok": false, "error": "cancelled" })) };
            let request = SaveRequest {
                title: tr(&c, "Nowy plik bazy SQLite"),
                default_path: "database.sqlite".to_string(),
                filters: vec![("SQLite".to_string(), ["sqlite", "db", "sqlite3"].map(String::from).to_vec())],
            };
            match os.save_file(crate::windows::MAIN, request).await {
                Some(picked) => blocking(&call.command, move || create_sqlite_file(&picked, true).to_json()).await,
                None => Ok(json!({ "ok": false, "error": "cancelled" })),
            }
        }
    });
    // The CA file of a verify-full connection: only its path goes back (it is read at connect time).
    let c = ctx.clone();
    r.invoke("db:pickCaFile", move |_call| {
        let c = c.clone();
        async move {
            let Some(os) = c.os.get().cloned() else { return Ok(Value::Null) };
            let request = PickRequest {
                folder: false,
                title: tr(&c, "Wybierz plik certyfikatu CA"),
                filter: Some(("PEM".to_string(), ["pem", "crt", "cer"].map(String::from).to_vec())),
                more_filters: db_filters(),
            };
            Ok(os.pick_file(crate::windows::MAIN, request).await.map(Value::String).unwrap_or(Value::Null))
        }
    });
    // Export of a result (CSV / JSON): the user picks where in the save dialog. MC_DB_EXPORT_DIR (dev overrides only, for the
    // real-app checks) writes into that folder without the dialog.
    let c = ctx.clone();
    r.invoke("db:export", move |call| {
        let c = c.clone();
        async move {
            let Some((name, text)) = ipc::export_request(call.arg(0), call.arg(1)) else { return Ok(json!({ "ok": false })) };
            let (name, text) = (name.to_string(), text.to_string());
            let path: Option<PathBuf> = match &c.overrides.db_export_dir {
                Some(dir) => Some(dir.join(&name)),
                None => {
                    let Some(os) = c.os.get().cloned() else { return Ok(json!({ "ok": false })) };
                    let ext = ipc::export_extension(&name);
                    let request = SaveRequest {
                        title: tr(&c, "Eksportuj wynik"),
                        default_path: name.clone(),
                        filters: vec![(ext.to_uppercase(), vec![ext])],
                    };
                    os.save_file(crate::windows::MAIN, request).await.map(PathBuf::from)
                }
            };
            let Some(path) = path else { return Ok(json!({ "ok": false, "cancelled": true })) };
            Ok(match tokio::fs::write(&path, text.as_bytes()).await {
                Ok(()) => json!({ "ok": true, "path": path.to_string_lossy() }),
                Err(_) => json!({ "ok": false }),
            })
        }
    });
}
