//! Commands of the `ssh` domain: S1-S4: SSH vault, keys, known hosts, connect, command history (ssh:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! S1: the stores (`ctx.ssh`) and the channels that only read them or belong to the history store in 1.1.4
//! (src/main/ssh/commandHistory.ts `registerCommandHistoryIpc`): `ssh:history:list` / `record` / `clear` / `status`, and
//! the read-only `ssh:vault:info`, `ssh:storage:status`, `ssh:knownHosts:list` of src/main/ssh/ipc.ts. The other `ssh:*`
//! channels (keys, passwords) are S4's. Store work runs on the blocking pool.
//!
//! S3 ([`link`]): the SSH coordinator with its owner slots and event routes, and `ssh:connect`, `ssh:sessions`,
//! `ssh:prompt:answer`.

pub mod link;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use unimux_ipc::{IpcError, RouterBuilder};

use crate::context::AppContext;
use crate::lifecycle::wind_down::phase;

pub use link::{DbSink, DbTunnels, SshLink};

async fn blocking<T: Send + 'static>(command: &str, f: impl FnOnce() -> T + Send + 'static) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IpcError::failed(command, e.to_string()))
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    link::register(r, ctx);
    let c = ctx.clone();
    r.invoke("ssh:vault:info", move |_call| {
        let c = c.clone();
        async move {
            let vault = c.ssh.vault().await;
            let info = vault.lock().info();
            Ok(info)
        }
    });

    let c = ctx.clone();
    r.invoke("ssh:storage:status", move |_call| {
        let c = c.clone();
        async move {
            let (vault, known) = (c.ssh.vault().await, c.ssh.known_hosts().await);
            let (vault, known) = (vault.lock(), known.lock());
            Ok(json!({
                "vaultFile": vault.file_path().to_string_lossy(), "vaultReadOnly": vault.read_only(),
                "knownHostsFile": known.file_path().to_string_lossy(), "knownHostsReadOnly": known.read_only(),
            }))
        }
    });

    let c = ctx.clone();
    r.invoke("ssh:knownHosts:list", move |_call| {
        let c = c.clone();
        async move {
            let known = c.ssh.known_hosts().await;
            let info = known.lock().info();
            Ok(info)
        }
    });

    // `window.mc.sshHistory`: bad arguments get the empty answer (the guard already refused foreign windows).
    let c = ctx.clone();
    r.invoke("ssh:history:list", move |call| {
        let history = c.ssh.history().clone();
        async move {
            let host = call.arg(0).clone();
            blocking(&call.command, move || history.list_json(&host)).await
        }
    });

    let c = ctx.clone();
    r.send("ssh:history:record", move |call| {
        let history = c.ssh.history().clone();
        async move {
            let (host, command) = (call.arg(0).clone(), call.arg(1).clone());
            let _ = tauri::async_runtime::spawn_blocking(move || history.record(&host, &command)).await;
        }
    });

    let c = ctx.clone();
    r.invoke("ssh:history:clear", move |call| {
        let history = c.ssh.history().clone();
        async move {
            let host = call.arg(0).clone();
            let ok = blocking(&call.command, move || history.clear(&host)).await?;
            Ok(json!({ "ok": ok }))
        }
    });

    let c = ctx.clone();
    r.invoke("ssh:history:status", move |call| {
        let history = c.ssh.history().clone();
        async move { blocking(&call.command, move || history.status()).await }
    });
}

/// After the main window (1.1.4 startSsh in startMainApp): the vault (with its DPAPI check) and the known hosts open on
/// the blocking pool, so the first `ssh:vault:info` finds them ready; the history is written before the app quits.
pub fn app_started(ctx: &Arc<AppContext>) {
    let stores = ctx.ssh.clone();
    tauri::async_runtime::spawn(async move { stores.init().await });
    let history = ctx.ssh.history().clone();
    ctx.lifecycle.wind_down.register(phase::BEFORE_QUIT, "ssh history flush", Duration::from_secs(1), move || {
        let history = history.clone();
        async move {
            let _ = tokio::task::spawn_blocking(move || history.flush()).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::Instant;
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};
    use unimux_ipc::router::Status;
    use unimux_ipc::{Call, Caller, Contract, Reply};

    const HOST: &str = "00000000-0000-4000-8000-00000000000a";

    fn context(dir: &std::path::Path) -> Arc<AppContext> {
        // No real key in a unit test: the vault reports `unavailable` and keeps everything in memory.
        let overrides = DevOverrides { ssh_no_safestorage: true, ..DevOverrides::default() };
        AppContext::new(
            dir.to_path_buf(),
            overrides,
            Arc::new(RollingLog::crash_log(dir)),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.join("startup.log"), "")),
            json!({"version": 1, "projects": [], "sshHosts": [{"id": HOST}]}),
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn history_and_read_only_channels_answer_like_1_1_4() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        let mut builder = RouterBuilder::new(Contract::embedded());
        register(&mut builder, &ctx);
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        let router = builder.build(ctx.guard.clone());
        for channel in [
            "ssh:vault:info",
            "ssh:storage:status",
            "ssh:knownHosts:list",
            "ssh:history:list",
            "ssh:history:record",
            "ssh:history:clear",
            "ssh:history:status",
        ] {
            assert_eq!(router.status(channel), Status::Implemented, "{channel}");
        }
        let call = |command: &str, args: Vec<Value>| Call::new(command, Caller::new("main", "http://tauri.localhost/"), args);
        let ask = |command: &str, args: Vec<Value>| {
            let router = &router;
            let c = call(command, args);
            async move {
                match router.invoke(c).await {
                    Ok(Reply::Json(v)) => v,
                    other => panic!("no JSON answer: {other:?}"),
                }
            }
        };
        router.run_send(call("ssh:history:record", vec![json!(HOST), json!("ls -la")])).await;
        router.run_send(call("ssh:history:record", vec![json!("00000000-0000-4000-8000-0000000000ff"), json!("pwd")])).await;
        let list = ask("ssh:history:list", vec![json!(HOST)]).await;
        assert_eq!(list[0]["command"], "ls -la");
        assert_eq!(ask("ssh:history:list", vec![json!(5)]).await, json!([]));
        let status = ask("ssh:history:status", vec![]).await;
        assert_eq!(status["counts"], json!({ HOST: 1 }));
        assert_eq!(status["readOnly"], false);
        assert_eq!(ask("ssh:history:clear", vec![json!("bad")]).await, json!({ "ok": false }));
        let info = ask("ssh:vault:info", vec![]).await;
        assert_eq!(info["storage"], "unavailable");
        assert_eq!(info["readOnly"], false);
        let storage = ask("ssh:storage:status", vec![]).await;
        assert!(storage["vaultFile"].as_str().unwrap().ends_with("vault.json"), "{storage}");
        assert_eq!(ask("ssh:knownHosts:list", vec![]).await, json!([]));
        ctx.ssh.history().flush();
        assert!(dir.path().join("ssh").join("command_history.json").exists());
        ctx.saver.stop();
    }
}
