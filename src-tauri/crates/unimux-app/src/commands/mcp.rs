//! Commands of the `mcp` domain: M1-M4: MCP server info and automation (mcp:*, automation:*).
//!
//! M1: the MCP server of the app (unimux-mcp `McpServer`), `mcp:info` (incl. `starting` and the listen error) and
//! `mcp:retry`, the `mcp:info` push (250 ms debounce, as 1.1.4's pushLater), the start with two background retries
//! (main.rs setup calls [`start`]) and [`stop`] for the quit path. The tool layer is `NoTools` until M2 / M3 register
//! theirs; P3 / M4 issue and revoke cell tokens through [`server`].

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_ipc::{RouterBuilder, Scope};
use unimux_mcp::tools::NoTools;
use unimux_mcp::{Config, McpServer};

use crate::context::AppContext;

/// The MCP server of this run and the app-side status around it (index.ts `mcpStarting`, `mcpError`).
pub struct McpService {
    pub server: Arc<McpServer>,
    /// True from launch until the first start attempt ended (`McpInfo.starting`).
    starting: AtomicBool,
    /// The message of the last failed start (`McpInfo.error`), cleared by a successful one.
    error: Mutex<Option<String>>,
    /// An `mcp:info` push is scheduled (pushLater).
    push_pending: AtomicBool,
}

static SERVICE: OnceLock<Arc<McpService>> = OnceLock::new();

/// The app's MCP server (None before `register`).
pub fn server() -> Option<Arc<McpServer>> {
    SERVICE.get().map(|s| s.server.clone())
}

impl McpService {
    fn new(ctx: &Arc<AppContext>) -> Arc<Self> {
        let crash = ctx.crash.clone();
        let cfg =
            Config { version: env!("CARGO_PKG_VERSION").to_string(), log: Arc::new(move |m| crash.warn(m)), ..Config::default() };
        Arc::new(Self {
            server: Arc::new(McpServer::new(Arc::new(NoTools), cfg)),
            starting: AtomicBool::new(true),
            error: Mutex::new(None),
            push_pending: AtomicBool::new(false),
        })
    }

    /// index.ts mcpInfo: the server's info, then `error`, then `starting` while the first start has not ended.
    pub fn info(&self) -> Value {
        let mut info = self.server.info();
        let running = info["running"] == json!(true);
        if let Value::Object(map) = &mut info {
            if let Some(error) = self.error.lock().clone() {
                map.insert("error".into(), json!(error));
            }
            if self.starting.load(Ordering::SeqCst) && !running {
                map.insert("starting".into(), json!(true));
            }
        }
        info
    }

    fn push(ctx: &Arc<AppContext>, service: &Arc<Self>) {
        ctx.events.emit(Scope::Broadcast, "mcp:info", vec![service.info()]);
    }

    /// pushLater: at most one `mcp:info` push per 250 ms.
    fn push_later(ctx: &Arc<AppContext>, service: &Arc<Self>) {
        if service.push_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let (ctx, service) = (ctx.clone(), service.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            service.push_pending.store(false, Ordering::SeqCst);
            Self::push(&ctx, &service);
        });
    }

    /// index.ts startMcp: a failed listen (security software, a busy port range) is retried in the background, 1 s apart.
    fn start(ctx: Arc<AppContext>, service: Arc<Self>, retries: u32) -> futures::future::BoxFuture<'static, ()> {
        Box::pin(async move {
            match service.server.start().await {
                Ok(()) => *service.error.lock() = None,
                Err(e) => {
                    let message = e.to_string();
                    ctx.crash.warn(&format!("MCP server did not start: {message}"));
                    *service.error.lock() = Some(message);
                    if retries > 0 {
                        let (ctx, service) = (ctx.clone(), service.clone());
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_secs(1)).await;
                            Self::start(ctx, service, retries - 1).await;
                        });
                    }
                }
            }
            service.starting.store(false, Ordering::SeqCst);
            Self::push(&ctx, &service);
        })
    }
}

fn service(ctx: &Arc<AppContext>) -> Arc<McpService> {
    SERVICE
        .get_or_init(|| {
            let service = McpService::new(ctx);
            let (c, s) = (ctx.clone(), Arc::downgrade(&service));
            service.server.on_change(move || {
                if let Some(s) = s.upgrade() {
                    McpService::push_later(&c, &s);
                }
            });
            service
        })
        .clone()
}

/// Starts the server after the window (index.ts: `startMcp().then(() => mark('mcp-started'))`).
pub fn start(ctx: &Arc<AppContext>) {
    let (ctx, service) = (ctx.clone(), service(ctx));
    tauri::async_runtime::spawn(async move {
        McpService::start(ctx.clone(), service, 2).await;
        ctx.mark("mcp-started");
    });
}

/// The quit path: every token, session, task and connection ends.
pub fn stop() {
    if let Some(server) = server() {
        server.stop();
    }
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let s = service(ctx);
    r.invoke("mcp:info", move |_| {
        let s = s.clone();
        async move { Ok(s.info()) }
    });

    let (c, s) = (ctx.clone(), service(ctx));
    r.invoke("mcp:retry", move |_| {
        let (c, s) = (c.clone(), s.clone());
        async move {
            if s.server.url().is_none() {
                McpService::start(c, s.clone(), 0).await;
            }
            Ok(s.info())
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};

    fn ctx(dir: &std::path::Path) -> Arc<AppContext> {
        AppContext::new(
            dir.to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir)),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.join("startup.log"), "")),
            json!({"version": 1, "projects": []}),
        )
    }

    #[test]
    fn mcp_info_says_starting_until_the_first_start_ended_and_keeps_the_listen_error() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path());
        let service = McpService::new(&ctx);
        assert_eq!(
            service.info(),
            json!({ "running": false, "configuredCellIds": [], "connectedCellIds": [], "starting": true })
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        service.server.fail_next_listen("listen EACCES: permission denied 127.0.0.1");
        rt.block_on(McpService::start(ctx.clone(), service.clone(), 0));
        assert_eq!(
            service.info(),
            json!({ "running": false, "configuredCellIds": [], "connectedCellIds": [],
                "error": "listen EACCES: permission denied 127.0.0.1" })
        );
        rt.block_on(McpService::start(ctx.clone(), service.clone(), 0));
        let info = service.info();
        assert_eq!(info["running"], true);
        assert!(info["url"].as_str().unwrap().starts_with("http://127.0.0.1:"));
        assert!(info.get("error").is_none() && info.get("starting").is_none());
        let keys: Vec<&String> = info.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["running", "url", "configuredCellIds", "connectedCellIds"]);
        service.server.stop();
        ctx.saver.stop();
        assert!(
            std::fs::read_to_string(dir.path().join("crash.log")).unwrap().contains("MCP server did not start: listen EACCES")
        );
    }
}
