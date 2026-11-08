//! Commands of the `pty` domain: P1-P5: cells and the pty port (cell:*).
//!
//! P2: the pty port. The app's [`PtyEngine`] (unimux-pty: OutputChannel, FlowGate, TailBuffer, per-window batcher,
//! host-side DA1) owns the port `pty`: a page attaches it on every load (`mc_port_attach`, ipc.rs picks the transport:
//! WebView2 shared buffers on Windows, the pull transport on macOS, the Channel as fallback) and posts its messages
//! through `mc_port_post` in order.
//!
//! P3: the pty service ([`PtyService`], the 1.1.4 Pty Host and its client) and what main did with its messages
//! (index.ts `ptyHost.on('message' | 'crashed' | 'fatal')`, `cell:kill`, `cell:killAndWait`, `cell:alive`):
//! - `spawned` / `exit` / `spawnError` keep the cell bookkeeping: W7's alive set, the shell pids the Monitor lists, the
//!   startup prompt files, hookWatch, the cell's MCP token and config, verifiedCodex and the cell observers (automation
//!   statuses, M3); a failed spawn reaches the cell's window as `cell:spawnError`;
//! - terminals that are not cells (`install:` ids of the install window, `auth:` ids of the login windows, SSH sessions)
//!   go to the interceptors their packages register ([`PtyHost::intercept`]) and never touch the cells;
//! - service errors reach crash.log at most 20 a minute;
//! - a crash forgets every terminal ([`PtyHost::on_crashed`] hooks: logins, the install window, SSH sessions, the app
//!   start claim) and sends `ptyhost:crashed` (whether a conversation resumes); after too many crashes `ptyhost:fatal`
//!   and the question "Restart terminals" / "Quit";
//! - routes of a detached grid's cells come from the StateController's owner table (W5's `on_route` hook), never from a
//!   window field in a message;
//! - the quit shuts the terminals down in the hosts phase of the wind-down (4 s), the hard limit kills them at once.
//!
//! `cell:spawn` (the launch line, gates, CLI decision) is P4's ([`spawn`]); `cell:runtime` is W7's.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use unimux_agents::cell_files::{CellFileDirs, Kind, remove_cell_files};
use unimux_agents::hooks::route::{cell_cli, find_cell};
use unimux_core::crash_log::ReportLimiter;
use unimux_core::i18n::translate;
use unimux_ipc::route::detached_label;
use unimux_ipc::{PortOwner, PortSink, RouterBuilder, Scope};
use unimux_platform::lifecycle::{DialogKind, MessageDialog};
use unimux_pty::batch::Transport;
use unimux_pty::engine::PtyEngine;
use unimux_pty::service::{HostEvent, KILL_AND_WAIT, LogLevel, PtyService, SHUTDOWN_WAIT};
use unimux_state::normalize::js::truthy;

use crate::context::AppContext;

/// The prefix of the install window's terminal (src/shared/cliInstall.ts INSTALL_PTY_PREFIX).
pub const INSTALL_PTY_PREFIX: &str = "install:";
/// The prefix of the login windows' terminals (index.ts: "login windows are not cells").
pub const AUTH_PTY_PREFIX: &str = "auth:";

static ENGINE: OnceLock<PtyEngine> = OnceLock::new();
static SERVICE: OnceLock<PtyService> = OnceLock::new();
static HOST: OnceLock<PtyHost> = OnceLock::new();

/// The engine of this run (created on first use).
pub fn engine() -> &'static PtyEngine {
    ENGINE.get_or_init(PtyEngine::new)
}

/// The pty service of this run (created on first use, over [`engine`]); its events go to [`host`].
pub fn service() -> &'static PtyService {
    SERVICE.get_or_init(|| {
        let service = PtyService::new(engine().clone());
        service.set_listener(|event| host().handle(event));
        service
    })
}

/// Main's side of the pty service (the cell bookkeeping around it).
pub fn host() -> &'static PtyHost {
    HOST.get_or_init(PtyHost::default)
}

/// What happened to a cell's process, for the observers (automation statuses of M3, index.ts `automation.statuses.set`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CellEvent {
    /// cell:spawn started the cell's terminal (`automation.runtimeStarted`, status `starting`, `cliExitCodes.delete`).
    Spawning { cell: String },
    /// `spawned`: the cell's terminal runs (`runtimeStarted`, status `unknown`).
    Started { cell: String, pid: u32 },
    /// `exit`: the terminal ended by itself (status `exited`, `noteExit(code)`).
    Exited { cell: String, code: i64 },
    /// `spawnError` (status `exited`).
    SpawnFailed { cell: String },
    /// `cell:kill` / `cell:killAndWait` / stopCells (status `exited`).
    Killed { cell: String },
    /// The pty service crashed with the cell running (status `exited`).
    Lost { cell: String },
}

type Intercept = Arc<dyn Fn(&HostEvent) -> bool + Send + Sync>;
type CellObserver = Arc<dyn Fn(&CellEvent) + Send + Sync>;
type Hook = Arc<dyn Fn() + Send + Sync>;
type KillHook = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
struct Hooks {
    /// (prefix, handler): events of terminals whose id starts with the prefix.
    prefixed: Vec<(&'static str, Intercept)>,
    /// Handlers that may take any terminal's events first (SSH sessions, P5).
    intercept: Vec<(&'static str, Intercept)>,
    cells: Vec<(&'static str, CellObserver)>,
    crashed: Vec<(&'static str, Hook)>,
    killed: Vec<(&'static str, KillHook)>,
}

/// Per-cell process bookkeeping of main (index.ts `cellPids`, `killCount`, `verifiedCodex`).
#[derive(Debug, Default)]
pub struct CellBook {
    pids: HashMap<String, u32>,
    kills: HashMap<String, u64>,
    verified_codex: HashMap<String, String>,
}

/// Main's side of the pty service.
#[derive(Default)]
pub struct PtyHost {
    ctx: RwLock<Weak<AppContext>>,
    book: Mutex<CellBook>,
    /// Errors the service reports, at most 20 a minute (`createReportLimiter`).
    log_limit: Mutex<ReportLimiter>,
    hooks: RwLock<Hooks>,
}

impl PtyHost {
    fn ctx(&self) -> Option<Arc<AppContext>> {
        self.ctx.read().upgrade()
    }

    // ── registration (later packages) ─────────────────────────────────────────

    /// The events of terminals whose id starts with `prefix` (`install:` H6, `auth:` A4); they never count as cells.
    #[allow(dead_code, reason = "the install window (H6) and the login windows (A4) register here")]
    pub fn on_prefix(&self, prefix: &'static str, handler: impl Fn(&HostEvent) -> bool + Send + Sync + 'static) {
        self.hooks.write().prefixed.push((prefix, Arc::new(handler)));
    }

    /// A handler that sees every terminal event first and takes it by answering true (`ssh.onHostMessage`, P5).
    pub fn intercept(&self, name: &'static str, handler: impl Fn(&HostEvent) -> bool + Send + Sync + 'static) {
        self.hooks.write().intercept.push((name, Arc::new(handler)));
    }

    /// What happens to the cells' processes (automation statuses, M3).
    #[allow(dead_code, reason = "the automation statuses (M3) register here")]
    pub fn on_cell(&self, name: &'static str, observer: impl Fn(&CellEvent) + Send + Sync + 'static) {
        self.hooks.write().cells.push((name, Arc::new(observer)));
    }

    /// The pty service crashed: every terminal is gone (logins A4, the install window H6, SSH sessions P5, the app-start
    /// SSH reconnect claim).
    pub fn on_crashed(&self, name: &'static str, hook: impl Fn() + Send + Sync + 'static) {
        self.hooks.write().crashed.push((name, Arc::new(hook)));
    }

    /// A cell is killed by the user or the team (`ssh.killed(id)`, P5).
    pub fn on_killed(&self, name: &'static str, hook: impl Fn(&str) + Send + Sync + 'static) {
        self.hooks.write().killed.push((name, Arc::new(hook)));
    }

    // ── the bookkeeping (P4, H6, M3) ──────────────────────────────────────────

    /// How often the cell was killed (a spawn that waited for the CLI lookup compares it before and after).
    pub fn kill_count(&self, cell: &str) -> u64 {
        self.book.lock().kills.get(cell).copied().unwrap_or(0)
    }

    /// `verifiedCodex.set`: the Codex session the user chose for the cell (P4 on a confirmed resume).
    pub fn set_verified_codex(&self, cell: &str, session: Option<&str>) {
        let mut book = self.book.lock();
        match session {
            Some(s) => {
                book.verified_codex.insert(cell.to_string(), s.to_string());
            }
            None => {
                book.verified_codex.remove(cell);
            }
        }
    }

    /// `verifiedCodex.get` (agent delivery through `codex queue`, H6).
    #[allow(dead_code, reason = "the agent delivery (H6) reads it")]
    pub fn verified_codex(&self, cell: &str) -> Option<String> {
        self.book.lock().verified_codex.get(cell).cloned()
    }

    /// The running cells and their shells' pids (the Monitor panel), sorted by cell.
    pub fn cell_pids(&self, alive: impl Fn(&str) -> bool) -> Vec<(String, u32)> {
        let mut list: Vec<(String, u32)> =
            self.book.lock().pids.iter().filter(|(c, _)| alive(c)).map(|(c, p)| (c.clone(), *p)).collect();
        list.sort();
        list
    }

    /// A spawn that ended before or instead of its terminal (index.ts cell:spawn: a missing CLI, a failed spawn):
    /// `endCellMcp`, `alive.delete`, the automation status `exited`.
    pub(crate) fn spawn_refused(&self, ctx: &AppContext, cell: &str) {
        end_cell_mcp(ctx, cell);
        ctx.cells.set_alive(cell, false);
        self.cell_event(CellEvent::SpawnFailed { cell: cell.to_string() });
    }

    /// cell:spawn is about to start the cell's terminal (`automation.runtimeStarted`, status `starting`).
    pub(crate) fn spawning(&self, cell: &str) {
        self.cell_event(CellEvent::Spawning { cell: cell.to_string() });
    }

    fn cell_event(&self, event: CellEvent) {
        let observers: Vec<CellObserver> = self.hooks.read().cells.iter().map(|(_, o)| o.clone()).collect();
        for o in observers {
            o(&event);
        }
    }

    // ── service events ────────────────────────────────────────────────────────

    /// One event of the pty service (on the service's threads; nothing here blocks).
    pub fn handle(&self, event: HostEvent) {
        let Some(ctx) = self.ctx() else { return };
        self.handle_in(&ctx, event);
    }

    fn handle_in(&self, ctx: &Arc<AppContext>, event: HostEvent) {
        let id = match &event {
            HostEvent::Log { level, message } => {
                if self.log_limit.lock().allow(unimux_core::time::now_ms()) {
                    match level {
                        LogLevel::Warn => ctx.crash.warn(message),
                        LogLevel::Error => ctx.crash.error(message),
                    }
                }
                return;
            }
            HostEvent::Crashed { message, .. } => {
                let resumes = self.forget_host_terminals(ctx, message);
                ctx.events.emit(Scope::Broadcast, "ptyhost:crashed", vec![Value::Bool(resumes)]);
                return;
            }
            HostEvent::Fatal { message, .. } => {
                let resumes = self.forget_host_terminals(ctx, message);
                ctx.events.emit(Scope::Broadcast, "ptyhost:fatal", vec![]);
                ask_after_fatal(ctx, resumes);
                return;
            }
            HostEvent::Restarted => return,
            HostEvent::Spawned { id, .. }
            | HostEvent::SpawnError { id, .. }
            | HostEvent::Exit { id, .. }
            | HostEvent::Tap { id, .. }
            | HostEvent::Interrupt { id } => id.clone(),
        };
        let (prefixed, intercept) = {
            let h = self.hooks.read();
            let prefixed: Vec<Intercept> = h.prefixed.iter().filter(|(p, _)| id.starts_with(p)).map(|(_, f)| f.clone()).collect();
            (prefixed, h.intercept.iter().map(|(_, f)| f.clone()).collect::<Vec<Intercept>>())
        };
        // The install window and the login windows are not cells, with or without a handler.
        if id.starts_with(INSTALL_PTY_PREFIX) || id.starts_with(AUTH_PTY_PREFIX) || !prefixed.is_empty() {
            for f in prefixed {
                if f(&event) {
                    break;
                }
            }
            return;
        }
        if intercept.iter().any(|f| f(&event)) {
            return;
        }
        match event {
            HostEvent::Spawned { id, pid } => {
                ctx.cells.set_alive(&id, true);
                {
                    let mut book = self.book.lock();
                    if pid > 0 {
                        book.pids.insert(id.clone(), pid);
                    } else {
                        book.pids.remove(&id);
                    }
                }
                self.cell_event(CellEvent::Started { cell: id, pid });
            }
            HostEvent::Exit { id, code } => {
                ctx.cells.set_alive(&id, false);
                ctx.hooks.process_ended(&id);
                {
                    let mut book = self.book.lock();
                    book.pids.remove(&id);
                    book.verified_codex.remove(&id);
                }
                end_cell_mcp(ctx, &id);
                self.cell_event(CellEvent::Exited { cell: id.clone(), code });
                ctx.hooks.release_prompt(&id);
            }
            HostEvent::SpawnError { id, message } => {
                ctx.hooks.release_prompt(&id);
                ctx.cells.set_alive(&id, false);
                end_cell_mcp(ctx, &id);
                self.cell_event(CellEvent::SpawnFailed { cell: id.clone() });
                ctx.events.emit(Scope::Cell(id.clone()), "cell:spawnError", vec![Value::String(id), Value::String(message)]);
            }
            // Only tapped terminals send these, and cells are never tapped.
            _ => {}
        }
    }

    /// `forgetHostTerminals`: everything that ran in the pty service is gone. Returns whether a conversation resumes (the
    /// toast's text).
    fn forget_host_terminals(&self, ctx: &Arc<AppContext>, message: &str) -> bool {
        let tail = message.trim();
        let tail = if tail.is_empty() { String::new() } else { format!("\n{tail}") };
        ctx.crash.error(&format!("pty host exited (panic){tail}"));
        ctx.hooks.release_all_prompts();
        let crashed: Vec<Hook> = self.hooks.read().crashed.iter().map(|(_, h)| h.clone()).collect();
        for hook in crashed {
            hook();
        }
        let alive = ctx.cells.alive();
        for id in &alive {
            end_cell_mcp(ctx, id);
            self.cell_event(CellEvent::Lost { cell: id.clone() });
        }
        {
            let mut book = self.book.lock();
            book.verified_codex.clear();
            book.pids.clear();
        }
        let resumes = resumes_conversation(&ctx.state.get(), &alive);
        ctx.cells.clear_alive();
        resumes
    }

    /// What `cell:kill`, `cell:killAndWait` and stopCells do before the terminal is killed (`hookWatch` only on cell:kill).
    fn before_kill(&self, ctx: &AppContext, cell: &str, forget_hook_watch: bool) {
        *self.book.lock().kills.entry(cell.to_string()).or_insert(0) += 1;
        if forget_hook_watch {
            ctx.hooks.process_ended(cell);
        }
        let killed: Vec<KillHook> = self.hooks.read().killed.iter().map(|(_, h)| h.clone()).collect();
        for hook in killed {
            hook(cell);
        }
        end_cell_mcp(ctx, cell);
        self.book.lock().verified_codex.remove(cell);
        self.cell_event(CellEvent::Killed { cell: cell.to_string() });
        ctx.cells.set_alive(cell, false);
    }
}

/// `endCellMcp`: the cell's MCP token is revoked and its Claude MCP config removed (a locked file: the next start prunes it).
pub(crate) fn end_cell_mcp(ctx: &AppContext, cell: &str) {
    if let Some(server) = crate::commands::mcp::server() {
        server.revoke_cell(cell);
    }
    // Only a `[\w-]{1,64}` id names a file (remove_cell_files checks): an id from a window never reaches another path.
    remove_cell_files(&CellFileDirs::in_data_dir(&ctx.data_dir), cell, &[Kind::Mcp]);
}

/// `resumesConversation`: a cell that was running is a Claude or Codex cell of an open grid that is not an SSH cell.
pub fn resumes_conversation(state: &Value, alive: &[String]) -> bool {
    alive.iter().any(|id| {
        let Some(cell) = find_cell(state, id) else { return false };
        !truthy(cell.get("ssh")) && matches!(cell_cli(state, cell), Some("claude" | "codex"))
    })
}

/// "Proces terminali wielokrotnie się wysypał.": not the blocking error box, main keeps serving while the question is open.
fn ask_after_fatal(ctx: &Arc<AppContext>, resumes: bool) {
    if ctx.lifecycle.is_quitting() {
        return;
    }
    let language = crate::lifecycle::language(ctx);
    let tr = |key: &str| translate(&language, key, &[]);
    let dialog = MessageDialog {
        kind: DialogKind::Error,
        title: "unimux".into(),
        message: tr("Proces terminali wielokrotnie się wysypał."),
        detail: tr("Terminale nie działają. Możesz spróbować uruchomić je ponownie albo zamknąć aplikację."),
        buttons: vec![tr("Uruchom terminale ponownie"), tr("Zamknij aplikację")],
        default_id: 0,
        cancel_id: 0,
    };
    let c = ctx.clone();
    crate::lifecycle::show_dialog(ctx, crate::windows::MAIN, dialog, move |response| {
        if c.lifecycle.is_quitting() {
            return;
        }
        if response == 1 {
            crate::lifecycle::quit_confirmed(&c);
            return;
        }
        service().restart_after_fatal();
        c.events.emit(Scope::Broadcast, "ptyhost:crashed", vec![Value::Bool(resumes)]);
    });
}

// ── commands ─────────────────────────────────────────────────────────────────

/// A port sink as the batcher's transport.
struct SinkTransport(Arc<dyn PortSink>);

impl Transport for SinkTransport {
    fn post(&self, seq: u64, bytes: Vec<u8>) -> bool {
        self.0.post_frames(seq, bytes)
    }
    fn gated(&self) -> bool {
        self.0.gated()
    }
    fn name(&self) -> &'static str {
        self.0.transport()
    }
    fn close(&self) {
        self.0.close();
    }
}

struct PtyPort;

impl PortOwner for PtyPort {
    fn attach(&self, label: &str, sink: Arc<dyn PortSink>) {
        service().attach(label, Arc::new(SinkTransport(sink)));
    }
    fn post(&self, label: &str, message: Value) {
        service().post(label, &message);
    }
    fn detach(&self, label: &str) {
        service().detach(label);
    }
}

#[path = "pty_spawn.rs"]
pub mod spawn;

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    *host().ctx.write() = Arc::downgrade(ctx);
    spawn::register(r, ctx);
    let svc = service();
    ctx.ports.register("pty", Arc::new(PtyPort));

    // Routes of a detached grid's cells: the owner table of the StateController (W5), never a window field from JS. The
    // owners of the state the app starts with were computed before this hook existed.
    ctx.detached.hooks().on_route.push(Arc::new(|cell: &str, window: Option<&str>| {
        let label = window.map(detached_label);
        service().route(cell, label.as_deref());
    }));
    for (cell, window) in unimux_state::detached::cell_owners(&ctx.state.get()) {
        svc.route(&cell, Some(&detached_label(&window)));
    }

    let c = Arc::downgrade(ctx);
    r.send("cell:kill", move |call| {
        let c = c.clone();
        async move {
            let (Some(ctx), Some(id)) = (c.upgrade(), call.arg(0).as_str()) else { return };
            host().before_kill(&ctx, id, true);
            service().kill(id);
        }
    });

    let c = Arc::downgrade(ctx);
    r.invoke("cell:killAndWait", move |call| {
        let c = c.clone();
        async move {
            let (Some(ctx), Some(id)) = (c.upgrade(), call.arg(0).as_str().map(str::to_string)) else {
                return Ok(Value::Null);
            };
            kill_cells_and_wait(&ctx, &[id]).await;
            Ok(Value::Null)
        }
    });

    let c = Arc::downgrade(ctx);
    r.invoke("cell:alive", move |_call| {
        let c = c.clone();
        async move { Ok(c.upgrade().map_or_else(|| json!([]), |ctx| json!(ctx.cells.alive()))) }
    });
}

/// `cell:killAndWait` / the team's stopCells (M3): each cell is killed and the call returns once its processes are gone
/// (4 s at most each, together).
pub async fn kill_cells_and_wait(ctx: &Arc<AppContext>, cells: &[String]) {
    let mut waits = Vec::new();
    for id in cells {
        host().before_kill(ctx, id, false);
        if let Some(rx) = service().kill_and_wait(id, KILL_AND_WAIT) {
            waits.push(rx);
        }
    }
    if waits.is_empty() {
        return;
    }
    let _ = tauri::async_runtime::spawn_blocking(move || {
        for rx in waits {
            let _ = rx.recv_timeout(KILL_AND_WAIT + Duration::from_secs(1));
        }
    })
    .await;
}

/// After the window started (main.rs `start_main_app`): the Monitor lists the running cells, and the quit shuts the
/// terminals down with the other hosts (1.1.4 `ptyHost.shutdown()` 4 s; the hard limit: `ptyHost.forceKill()`).
pub fn app_started(ctx: &Arc<AppContext>) {
    if let Some(monitor) = crate::commands::files::g8::monitor() {
        let c = Arc::downgrade(ctx);
        monitor.set_cells(Arc::new(move || {
            let Some(ctx) = c.upgrade() else { return vec![] };
            host().cell_pids(|cell| ctx.cells.is_alive(cell))
        }));
    }
    use crate::lifecycle::wind_down::phase;
    ctx.lifecycle.wind_down.register(phase::HOSTS, "terminals shutdown", SHUTDOWN_WAIT + Duration::from_secs(1), || async {
        let _ = tauri::async_runtime::spawn_blocking(|| {
            service().kill_all(SHUTDOWN_WAIT);
            service().stop();
        })
        .await;
    });
    ctx.lifecycle.wind_down.on_force_exit(|| service().force_kill());
}

/// The check build's terminals (test bridge op `pty`, never in a release build): the data plane and the pty service
/// without the launch line (P4), so the real-app scripts can drive them with the real renderer.
///
/// `{action: "spawn", id, cwd, cols?, rows?, shell?: "cmd"|"powershell"|"pwsh"|"bash"|"zsh", file?, args?, command?}`
/// (a cell id becomes a running cell: alive, its pid in the Monitor), `{action: "kill", id}`, `{action: "killAll"}`,
/// `{action: "write", id, data}`, `{action: "route", id, window?}`, `{action: "stats"}`, `{action: "replay", id}`,
/// `{action: "panic", message?}` (a crash of the service: `ptyhost:crashed`, after more than 5 in 60 s `ptyhost:fatal`),
/// `{action: "readerPanic", message?}` (the same crash as from a reader thread), `{action: "status"}`.
#[cfg(feature = "test-bridge")]
pub fn test_op(ctx: &Arc<AppContext>, args: &Value) -> Result<Value, String> {
    use unimux_pty::manager::SpawnRequest;
    use unimux_pty::shell::{Launch, ShellKind};

    let s = |k: &str| args.get(k).and_then(Value::as_str);
    let service = service();
    let engine = service.engine();
    match s("action").unwrap_or("") {
        "spawn" => {
            let id = s("id").ok_or("spawn needs an id")?;
            let cwd = s("cwd").ok_or("spawn needs a cwd")?;
            let shell = match s("shell").unwrap_or("cmd") {
                "cmd" => ShellKind::Cmd,
                "powershell" => ShellKind::Powershell,
                "pwsh" => ShellKind::Pwsh,
                "bash" => ShellKind::Bash,
                _ => ShellKind::Zsh,
            };
            let mut req = SpawnRequest::new(id, cwd, shell);
            if let Some(c) = args.get("cols").and_then(Value::as_u64) {
                req.cols = c.clamp(2, 1000) as u16;
            }
            if let Some(r) = args.get("rows").and_then(Value::as_u64) {
                req.rows = r.clamp(1, 1000) as u16;
            }
            req.env = std::env::vars().collect();
            req.cell_id = Some(id.to_string());
            req.command = s("command").map(str::to_string);
            if let Some(file) = s("file") {
                let list: Vec<String> = args
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let refs: Vec<&str> = list.iter().map(String::as_str).collect();
                req.launch = Some(Launch::new(file, &refs));
            }
            let pid = engine.spawn(req).map_err(|e| e.to_string())?;
            // As the service's own spawn would report it (the bookkeeping of a running cell).
            host().handle(HostEvent::Spawned { id: id.to_string(), pid });
            Ok(json!({ "pid": pid }))
        }
        "kill" => {
            let id = s("id").ok_or("kill needs an id")?;
            host().before_kill(ctx, id, true);
            Ok(json!({ "ended": engine.kill_and_wait(id, KILL_AND_WAIT) }))
        }
        "killAll" => Ok(json!({ "ended": engine.kill_all(Duration::from_secs(3)) })),
        "write" => {
            engine.write(s("id").ok_or("write needs an id")?, s("data").unwrap_or("").as_bytes());
            Ok(Value::Null)
        }
        "route" => {
            engine.route(s("id").ok_or("route needs an id")?, s("window"));
            Ok(Value::Null)
        }
        "replay" => {
            let (data, sizes) = engine.replay(s("id").ok_or("replay needs an id")?).ok_or("no such terminal")?;
            Ok(json!({
                "bytes": data.len(),
                "sizes": sizes.iter().map(|z| json!({ "at": z.at, "cols": z.cols, "rows": z.rows })).collect::<Vec<_>>(),
            }))
        }
        "panic" => Ok(json!({ "queued": service.inject_panic(s("message").unwrap_or("test-bridge pty panic")) })),
        "readerPanic" => {
            service.inject_reader_crash(s("message").unwrap_or("test-bridge pty reader panic"));
            Ok(Value::Null)
        }
        "status" => Ok(json!({
            "running": service.is_running(),
            "fatal": service.is_fatal(),
            "terminals": service.ids(),
            "alive": ctx.cells.alive(),
        })),
        "stats" => Ok(engine.stats_json()),
        other => Err(format!("unknown pty action {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state() -> Value {
        json!({
            "version": 1,
            "profiles": [
                { "id": "sh", "cli": "shell" },
                { "id": "cl", "cli": "claude" },
                { "id": "cx", "cli": "codex" },
            ],
            "projects": [{
                "id": "p",
                "tabs": [{ "id": "t", "cells": [
                    { "id": "a", "profileId": "sh" },
                    { "id": "b", "profileId": "cl", "ssh": { "hostId": "h" } },
                    { "id": "c", "profileId": "cx" },
                    { "id": "d", "profileId": "gone" },
                ] }],
                "archive": [{ "id": "t2", "cells": [{ "id": "e", "profileId": "cl" }] }],
            }],
        })
    }

    #[test]
    fn only_running_claude_or_codex_cells_without_ssh_resume_a_conversation() {
        let s = state();
        let ids = |l: &[&str]| l.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(!resumes_conversation(&s, &ids(&[])));
        assert!(!resumes_conversation(&s, &ids(&["a"])), "a shell");
        assert!(!resumes_conversation(&s, &ids(&["b"])), "an SSH cell never resumes");
        assert!(resumes_conversation(&s, &ids(&["a", "c"])), "a Codex cell");
        // An unknown profile falls back to the shell profile; an archived cell is not found.
        assert!(!resumes_conversation(&s, &ids(&["d", "e", "zzz"])));
    }

    fn handled(ctx: &Arc<AppContext>, h: &PtyHost, events: Vec<HostEvent>) {
        for e in events {
            h.handle_in(ctx, e);
        }
    }

    #[test]
    fn spawned_exit_and_spawn_errors_keep_the_cell_bookkeeping() {
        let _one = crate::commands::REGISTER_LOCK.lock();
        let (_dir, ctx, _router) = crate::cells::test_ctx(state());
        let h = PtyHost::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        h.on_cell("test", move |e| s.lock().push(e.clone()));
        handled(
            &ctx,
            &h,
            vec![
                HostEvent::Spawned { id: "a".into(), pid: 41 },
                HostEvent::Spawned { id: "c".into(), pid: 0 },
                HostEvent::Spawned { id: "install:x".into(), pid: 7 },
                HostEvent::Spawned { id: "auth:y".into(), pid: 8 },
            ],
        );
        assert_eq!(ctx.cells.alive(), ["a", "c"], "install and login terminals are not cells");
        assert_eq!(h.cell_pids(|c| ctx.cells.is_alive(c)), [("a".to_string(), 41)], "pid 0 is not listed");
        h.set_verified_codex("c", Some("sess"));
        // A Claude MCP config of the cell goes with its exit.
        let mcp = ctx.data_dir.join("mcp");
        std::fs::create_dir_all(&mcp).unwrap();
        std::fs::write(mcp.join("c.json"), "{}").unwrap();
        handled(&ctx, &h, vec![HostEvent::Exit { id: "c".into(), code: 3 }]);
        assert_eq!(ctx.cells.alive(), ["a"]);
        assert!(!mcp.join("c.json").exists());
        assert_eq!(h.verified_codex("c"), None);
        handled(&ctx, &h, vec![HostEvent::SpawnError { id: "a".into(), message: "boom".into() }]);
        assert!(ctx.cells.alive().is_empty());
        assert_eq!(
            *seen.lock(),
            [
                CellEvent::Started { cell: "a".into(), pid: 41 },
                CellEvent::Started { cell: "c".into(), pid: 0 },
                CellEvent::Exited { cell: "c".into(), code: 3 },
                CellEvent::SpawnFailed { cell: "a".into() },
            ]
        );
        ctx.saver.stop();
    }

    #[test]
    fn prefixed_terminals_go_to_their_handlers_and_interceptors_take_events_first() {
        let _one = crate::commands::REGISTER_LOCK.lock();
        let (_dir, ctx, _router) = crate::cells::test_ctx(state());
        let h = PtyHost::default();
        let install = Arc::new(Mutex::new(Vec::new()));
        let i = install.clone();
        h.on_prefix(INSTALL_PTY_PREFIX, move |e| {
            i.lock().push(e.clone());
            true
        });
        h.intercept("ssh", |e| matches!(e, HostEvent::Spawned { id, .. } if id == "ssh-cell"));
        handled(
            &ctx,
            &h,
            vec![
                HostEvent::Tap { id: "install:1".into(), data: "x".into() },
                HostEvent::Interrupt { id: "install:1".into() },
                HostEvent::Spawned { id: "ssh-cell".into(), pid: 0 },
                HostEvent::Spawned { id: "a".into(), pid: 1 },
            ],
        );
        assert_eq!(install.lock().len(), 2);
        assert_eq!(ctx.cells.alive(), ["a"]);
        ctx.saver.stop();
    }

    #[test]
    fn a_crash_forgets_every_running_cell_and_says_whether_a_conversation_resumes() {
        let _one = crate::commands::REGISTER_LOCK.lock();
        let (_dir, ctx, _router) = crate::cells::test_ctx(state());
        let h = PtyHost::default();
        let crashed = Arc::new(Mutex::new(0));
        let c = crashed.clone();
        h.on_crashed("test", move || *c.lock() += 1);
        handled(&ctx, &h, vec![HostEvent::Spawned { id: "a".into(), pid: 1 }, HostEvent::Spawned { id: "c".into(), pid: 2 }]);
        h.set_verified_codex("c", Some("s"));
        assert!(h.forget_host_terminals(&ctx, "boom"));
        assert!(ctx.cells.alive().is_empty());
        assert_eq!(*crashed.lock(), 1);
        assert_eq!(h.verified_codex("c"), None);
        assert!(h.cell_pids(|_| true).is_empty());
        let log = std::fs::read_to_string(ctx.data_dir.join("crash.log")).unwrap_or_default();
        assert!(log.contains("pty host exited (panic)\nboom"), "{log}");
        // Nothing running: nothing resumes.
        assert!(!h.forget_host_terminals(&ctx, ""));
        ctx.saver.stop();
    }

    #[test]
    fn a_kill_counts_drops_the_cell_and_tells_the_kill_hooks() {
        let _one = crate::commands::REGISTER_LOCK.lock();
        let (_dir, ctx, _router) = crate::cells::test_ctx(state());
        let h = PtyHost::default();
        let killed = Arc::new(Mutex::new(Vec::new()));
        let k = killed.clone();
        h.on_killed("ssh", move |cell| k.lock().push(cell.to_string()));
        handled(&ctx, &h, vec![HostEvent::Spawned { id: "c".into(), pid: 2 }]);
        h.set_verified_codex("c", Some("s"));
        h.before_kill(&ctx, "c", true);
        h.before_kill(&ctx, "c", false);
        assert_eq!(h.kill_count("c"), 2);
        assert_eq!(h.kill_count("a"), 0);
        assert!(!ctx.cells.is_alive("c"));
        assert_eq!(h.verified_codex("c"), None);
        assert_eq!(*killed.lock(), ["c", "c"]);
        ctx.saver.stop();
    }

    #[test]
    fn service_log_lines_are_limited_to_twenty_a_minute() {
        let _one = crate::commands::REGISTER_LOCK.lock();
        let (_dir, ctx, _router) = crate::cells::test_ctx(state());
        let h = PtyHost::default();
        for n in 0..25 {
            h.handle_in(&ctx, HostEvent::Log { level: LogLevel::Warn, message: format!("line-{n}-end") });
        }
        let log = std::fs::read_to_string(ctx.data_dir.join("crash.log")).unwrap_or_default();
        assert_eq!(log.matches("-end").count(), 20, "{log}");
        ctx.saver.stop();
    }
}
