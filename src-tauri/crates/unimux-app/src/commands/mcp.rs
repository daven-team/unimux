//! Commands of the `mcp` domain: M1-M4: MCP server info and automation (mcp:*, automation:*).
//!
//! M1: the MCP server of the app (unimux-mcp `McpServer`), `mcp:info` (incl. `starting` and the listen error) and
//! `mcp:retry`, the `mcp:info` push (250 ms debounce, as 1.1.4's pushLater), the start with two background retries
//! (main.rs setup calls [`start`]) and [`stop`] for the quit path. P3 / M4 issue and revoke cell tokens through [`server`].
//!
//! M2: the tool layer is unimux-mcp's `McpTools` (the 1.1.4 tool lists, instructions, argument checks, elicitations)
//! over the automation service (M3, [`crate::commands::automation`]), the elicitation texts in the app language. The
//! check build (feature `test-bridge`) runs the tools over the real service too (M4: verify-team-start, verify-mcp-team and
//! verify-team-stuck drive the team flow through the cells' own tokens), unless it was started with
//! `MC_MCP_FAKE_AUTOMATION=1`: then they run over unimux-mcp's stand-in automation (`fake-automation`, test bridge
//! `mcp-automation`), which scripts/verify-mcp-cli.mjs drives. Its `automation:execute` always reaches the real service.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_ipc::{RouterBuilder, Scope};
use unimux_mcp::host::Tr;
use unimux_mcp::{AutomationService, Config, McpServer, McpTools, ToolHost};
use unimux_state::StateController;

use crate::context::AppContext;

/// The MCP server of this run and the app-side status around it (index.ts `mcpStarting`, `mcpError`).
pub struct McpService {
    pub server: Arc<McpServer>,
    /// The automation service (M3): the tools' operations and `automation:execute`.
    pub automation: Arc<AutomationService>,
    /// True from launch until the first start attempt ended (`McpInfo.starting`).
    starting: AtomicBool,
    /// The message of the last failed start (`McpInfo.error`), cleared by a successful one.
    error: Mutex<Option<String>>,
    /// An `mcp:info` push is scheduled (pushLater).
    push_pending: AtomicBool,
    /// The check build's stand-in automation (test bridge `mcp-automation`).
    #[cfg(feature = "test-bridge")]
    pub fake: unimux_mcp::fake::FakeAutomation,
}

static SERVICE: OnceLock<Arc<McpService>> = OnceLock::new();

/// The elicitation texts in the app language (index.ts `tr`: the saved language, else the OS language).
fn translator(state: Arc<StateController>) -> Tr {
    Arc::new(move |key: &str, params: &[(&str, String)]| {
        let language = crate::commands::os::language(&state.get());
        let p: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
        unimux_core::i18n::translate(&language, key, &p)
    })
}

/// The check build's tool layer (feature `test-bridge`, never in a release build): the real tools over the stand-in
/// automation, plus `test_bridge_panic`, a tool that panics, so scripts/check-mcp-app.mjs can prove the app's panic hook
/// leaves MCP request panics to the server.
#[cfg(feature = "test-bridge")]
mod test_tools {
    use std::sync::Arc;

    use serde_json::Value;
    use unimux_mcp::tools::BoxFuture;
    use unimux_mcp::{Automation, CallCtx, CallError, McpTools, ToolHost};

    pub struct BridgeTools<A: Automation>(pub Arc<McpTools<A>>);

    impl<A: Automation> ToolHost for BridgeTools<A> {
        fn instructions(&self, cell: &str) -> String {
            self.0.instructions(cell)
        }
        fn tools(&self, cell: &str) -> Vec<Value> {
            self.0.tools(cell)
        }
        fn supports_task(&self, name: &str) -> bool {
            self.0.supports_task(name)
        }
        fn call(
            self: Arc<Self>,
            name: String,
            args: Option<Value>,
            ctx: CallCtx,
        ) -> BoxFuture<'static, Result<Value, CallError>> {
            if name == "test_bridge_panic" {
                let text = args.as_ref().and_then(|a| a["message"].as_str()).unwrap_or("test-bridge MCP panic").to_string();
                return Box::pin(async move { panic!("{text}") });
            }
            self.0.clone().call(name, args, ctx)
        }
    }
}

/// The app's MCP server (None before `register`).
pub fn server() -> Option<Arc<McpServer>> {
    SERVICE.get().map(|s| s.server.clone())
}

/// The automation service of this run (None before `register`): P4 tells it about spawns (`runtime_started`, `starting`).
#[allow(dead_code, reason = "kept for the callers outside the automation wiring")]
pub fn automation() -> Option<Arc<AutomationService>> {
    SERVICE.get().map(|s| s.automation.clone())
}

/// The check build answers the MCP tools over the stand-in automation (`MC_MCP_FAKE_AUTOMATION=1`, verify-mcp-cli).
#[cfg(feature = "test-bridge")]
pub fn fake_tools() -> bool {
    std::env::var_os("MC_MCP_FAKE_AUTOMATION").is_some_and(|v| v == "1")
}

/// The check build's stand-in automation (None before `register`).
#[cfg(feature = "test-bridge")]
pub fn fake_automation() -> Option<unimux_mcp::fake::FakeAutomation> {
    SERVICE.get().map(|s| s.fake.clone())
}

impl McpService {
    fn new(ctx: &Arc<AppContext>) -> Arc<Self> {
        let crash = ctx.crash.clone();
        let cfg =
            Config { version: env!("CARGO_PKG_VERSION").to_string(), log: Arc::new(move |m| crash.warn(m)), ..Config::default() };
        let tr = translator(ctx.state.clone());
        let automation = crate::commands::automation::create(ctx);
        #[cfg(feature = "test-bridge")]
        let (host, fake): (Arc<dyn ToolHost>, _) = {
            let state = ctx.state.clone();
            let fake = unimux_mcp::fake::FakeAutomation::new(Arc::new(move || state.get()));
            let host: Arc<dyn ToolHost> = if fake_tools() {
                Arc::new(test_tools::BridgeTools(McpTools::with_tr(Arc::new(fake.clone()), tr)))
            } else {
                Arc::new(test_tools::BridgeTools(McpTools::with_tr(automation.clone(), tr)))
            };
            (host, fake)
        };
        #[cfg(not(feature = "test-bridge"))]
        let host: Arc<dyn ToolHost> = McpTools::with_tr(automation.clone(), tr);
        let server = Arc::new(McpServer::new(host, cfg));
        let weak = Arc::downgrade(&server);
        automation.set_probe(Arc::new(move |cell| weak.upgrade().map_or("off", |s| s.connection(cell).as_str())));
        #[cfg(feature = "test-bridge")]
        {
            let weak = Arc::downgrade(&server);
            fake.set_probe(Arc::new(move |cell| weak.upgrade().map_or("off", |s| s.connection(cell).as_str())));
        }
        Arc::new(Self {
            server,
            automation,
            starting: AtomicBool::new(true),
            error: Mutex::new(None),
            push_pending: AtomicBool::new(false),
            #[cfg(feature = "test-bridge")]
            fake,
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

/// The server's start after the window (index.ts: `startMcp().then(() => mark('mcp-started'))`); W7's startup runs it next
/// to the hook server and opens the cell services gate after both.
pub fn start(ctx: &Arc<AppContext>) -> futures::future::BoxFuture<'static, ()> {
    let (ctx, service) = (ctx.clone(), service(ctx));
    Box::pin(async move {
        McpService::start(ctx.clone(), service, 2).await;
        ctx.mark("mcp-started");
    })
}

/// The quit path: every token, session, task and connection ends.
pub fn stop() {
    if let Some(server) = server() {
        server.stop();
    }
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let s = service(ctx);
    // W7: a team cell that left the grids (closed or archived) loses its MCP token; waits and sessions of it end.
    let server = s.server.clone();
    ctx.cells.on_revoke("mcp", move |cell| server.revoke_cell(cell));
    crate::commands::automation::register(r, ctx, &s.automation);
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
    use unimux_mcp::Role;

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

    #[test]
    fn the_tools_follow_the_app_state_and_run_the_automation_operations() {
        let (_dir, ctx, _router) = crate::cells::test_ctx(json!({ "version": 1,
                "projects": [{ "id": "p", "name": "Proj", "tabs": [{ "id": "g", "name": "Team", "cells": [
                    { "id": "lead", "name": "Lead", "profileId": "claude", "role": "coordinator" },
                    { "id": "plain", "profileId": "claude" }] }] }],
                "profiles": [{ "id": "claude", "name": "Claude", "cli": "claude" }],
                "settings": { "language": "de", "delegation": { "mode": "ask", "maxAgents": 3 } } }));
        let state = ctx.state.clone();
        let tools = McpTools::with_tr(crate::commands::automation::create(&ctx), translator(state.clone()));
        assert!(tools.instructions("lead").starts_with("Unimux: you are cell lead \"Lead\" (coordinator) in project Proj."));
        assert!(tools.instructions("lead").contains("Create agents only when the user asked to delegate"));
        assert_eq!(tools.instructions("plain"), "Unimux MCP is disabled for this cell.");
        assert_eq!(tools.tools("lead").len(), unimux_mcp::catalog::tools_for_role(Some(Role::Coordinator)).len());
        assert!(tools.tools("plain").is_empty());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let call = |name: &str, args: Value| {
            rt.block_on(tools.clone().call(name.into(), Some(args), unimux_mcp::host::plain_ctx("lead", false)))
        };
        let context = serde_json::to_string(&call("get_context", json!({})).unwrap()).unwrap();
        assert!(context.contains("lead") && context.contains("coordinator"), "{context}");
        assert_eq!(
            call("send_message", json!({ "toCellId": "lead", "text": "  " })),
            Err(unimux_mcp::CallError::Tool(
                "Invalid arguments - text: Too small: expected string to have >=1 characters".into()
            ))
        );
        assert_eq!(call("help", json!({ "topic": "tasks" })).unwrap()["topic"], "tasks");
        // The elicitation texts follow the app language (the saved one, German here).
        let tr = translator(state);
        assert_eq!(
            tr("Kilku agentów nazywa się „{name}”. Którego wybrać?", &[("name", "X".into())]),
            "Mehrere Agenten heißen „X“. Welcher ist gemeint?"
        );
        assert_eq!(tr("Zamknij grid i anuluj zadania", &[]), "Raster schließen und Aufgaben abbrechen");
    }
}
