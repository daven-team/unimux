//! Port of src/main/cliInstall.ts: the guided install of Claude Code / Codex. The vendor's official command runs in a visible
//! terminal (a pty typed into the configured shell, like the login window) and progress is reported. The command is never taken
//! from the renderer: it sends `{cli, method}`, which is validated against the allow-list of [`super::shared`].
//!
//! Timers are tokio tasks (tests run on the paused clock); every I/O goes through [`InstallDeps`].

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use super::shared::*;
use crate::cli::status::{CliId, CliState, CliStatus, CliStatusMap, Env, InstallMethod, Os, clean_env, dirname, parse_version};
use crate::cli::{ExecRequest, ExecResult};

/// The whole install may take this long.
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const POLL: Duration = Duration::from_secs(5);
/// After the detector found the CLI while the command still runs: how long to wait for the command to return.
const GRACE: Duration = Duration::from_secs(20);
/// After Ctrl+C in the install terminal: how long the shell may still print the end marker before the run counts as aborted.
const ABORT_GRACE: Duration = Duration::from_secs(3);
const TOOLS_TTL_MS: i64 = 30_000;
const TOOL_TIMEOUT_MS: u64 = 5000;
/// Output kept for the marker and the failure classes (UTF-16 units, like `slice(-OUTPUT_KEEP)`).
const OUTPUT_KEEP: usize = 16 * 1024;

/// The terminal of an install (`spawnPty({id, command, env})`): `env` is the complete environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPty {
    pub id: String,
    pub command: String,
    pub env: Env,
}

/// The I/O of the install manager (`InstallDeps`).
pub trait InstallDeps: Send + Sync + 'static {
    fn os(&self) -> Os;
    fn home(&self) -> String;
    /// settings.shell of the live state.
    fn shell(&self) -> Option<String>;
    fn env(&self) -> Env;
    fn now(&self) -> i64;
    /// The detector's exec (stdin closed, timeout, capped output); only used to look for prerequisites. Never fails.
    fn exec(&self, request: ExecRequest) -> BoxFuture<'static, ExecResult>;
    /// `detector.get(cli, {force: true})`: a fresh look that does not invalidate the caches.
    fn detect(&self, cli: CliId) -> BoxFuture<'static, CliStatus>;
    /// `detector.recheck(cli)`.
    fn recheck(&self, cli: CliId) -> BoxFuture<'static, CliStatusMap>;
    /// `detector.applyEnv(env)`: the registry-refreshed PATH.
    fn apply_env(&self, env: Env) -> BoxFuture<'static, Env>;
    /// Starts the typed command in a tapped pty (its events come back through [`InstallManager::on_host_event`]).
    fn spawn_pty(&self, spec: InstallPty) -> Result<(), String>;
    fn kill_pty(&self, id: &str);
    /// Kills the shell and everything it started (taskkill /T on Windows, the process group elsewhere).
    fn kill_tree(&self, pid: u32);
    fn emit(&self, state: &InstallState);
    /// Check builds only (dev-overrides, tests): the text typed instead of the official command.
    fn command_override(&self, cli: CliId, method: InstallMethod) -> Option<String>;
}

/// The timings (tests shorten them).
#[derive(Debug, Clone, Copy)]
pub struct InstallTimings {
    pub timeout: Duration,
    pub poll: Duration,
    pub grace: Duration,
    pub abort_grace: Duration,
    pub tools_ttl_ms: i64,
}

impl Default for InstallTimings {
    fn default() -> Self {
        Self { timeout: INSTALL_TIMEOUT, poll: POLL, grace: GRACE, abort_grace: ABORT_GRACE, tools_ttl_ms: TOOLS_TTL_MS }
    }
}

/// One event of an install terminal (the `install:` messages of the pty service).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent<'a> {
    Spawned { id: &'a str, pid: u32 },
    SpawnError { id: &'a str },
    Tap { id: &'a str, data: &'a str },
    Interrupt { id: &'a str },
    Exit { id: &'a str, code: i64 },
}

impl PtyEvent<'_> {
    fn id(&self) -> &str {
        match self {
            Self::Spawned { id, .. }
            | Self::SpawnError { id }
            | Self::Tap { id, .. }
            | Self::Interrupt { id }
            | Self::Exit { id, .. } => id,
        }
    }
}

/// `{ok: false, error}` of `install:start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartError {
    Invalid,
    Busy,
    Unavailable,
    Spawn,
}

impl StartError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::Busy => "busy",
            Self::Unavailable => "unavailable",
            Self::Spawn => "spawn",
        }
    }
}

/// A started install (`{ok: true, sessionId, ptyId, command}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub session_id: String,
    pub pty_id: String,
    pub command: String,
}

/// `install:start`'s answer as JSON.
pub fn start_result_json(result: &Result<Started, StartError>) -> Value {
    match result {
        Ok(s) => json!({ "ok": true, "sessionId": s.session_id, "ptyId": s.pty_id, "command": s.command }),
        Err(e) => json!({ "ok": false, "error": e.as_str() }),
    }
}

/// The running install (`active()`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveInstall {
    pub session_id: String,
    pub pty_id: String,
    pub cli: CliId,
    pub method: InstallMethod,
    pub command: String,
}

impl ActiveInstall {
    pub fn to_json(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "ptyId": self.pty_id,
            "cli": self.cli.as_str(),
            "method": method_name(self.method),
            "command": self.command,
        })
    }
}

#[derive(Default)]
struct Timers {
    poll: Option<JoinHandle<()>>,
    timeout: Option<JoinHandle<()>>,
    grace: Option<JoinHandle<()>>,
    abort: Option<JoinHandle<()>>,
}

impl Timers {
    fn clear(&mut self) {
        for t in [self.poll.take(), self.timeout.take(), self.grace.take(), self.abort.take()].into_iter().flatten() {
            t.abort();
        }
    }
}

#[derive(Default)]
struct SessionState {
    pid: Option<u32>,
    output: String,
    ended: bool,
    finishing: bool,
    timers: Timers,
}

struct Session {
    id: String,
    pty_id: String,
    cli: CliId,
    method: InstallMethod,
    command: String,
    st: Mutex<SessionState>,
}

impl Session {
    fn ended(&self) -> bool {
        self.st.lock().ended
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    Timeout,
    Aborted,
}

type ToolsTask = Shared<BoxFuture<'static, InstallTools>>;

#[derive(Default)]
struct Inner {
    current: Option<Arc<Session>>,
    tools: Option<(i64, ToolsTask)>,
}

/// `InstallManager`: one install at a time.
pub struct InstallManager {
    deps: Arc<dyn InstallDeps>,
    /// The runtime its timers run on (events come from the pty service's threads).
    rt: Handle,
    timings: InstallTimings,
    inner: Mutex<Inner>,
}

/// `slice(-keep)` in UTF-16 units (a cut inside a pair drops the half).
fn keep_tail(text: &mut String, keep: usize) {
    let len = unimux_core::utf16::len(text);
    if len > keep {
        *text = unimux_core::utf16::slice(text, len - keep, len);
    }
}

impl InstallManager {
    pub fn new(deps: Arc<dyn InstallDeps>, timings: InstallTimings, rt: Handle) -> Arc<Self> {
        Arc::new(Self { deps, rt, timings, inner: Mutex::new(Inner::default()) })
    }

    pub fn is_active(&self) -> bool {
        self.inner.lock().current.is_some()
    }

    /// The running install (a window opened later attaches to it instead of being refused).
    pub fn active(&self) -> Option<ActiveInstall> {
        let session = self.inner.lock().current.clone()?;
        if session.ended() {
            return None;
        }
        Some(ActiveInstall {
            session_id: session.id.clone(),
            pty_id: session.pty_id.clone(),
            cli: session.cli,
            method: session.method,
            command: session.command.clone(),
        })
    }

    /// `options(cli)`: methods that can work on this machine, each with the exact command that will be typed. Nothing runs
    /// here. None for anything that is not a CLI id.
    pub async fn options(self: &Arc<Self>, cli: &Value) -> Option<Value> {
        let cli = CliId::from_value(cli)?;
        let tools = self.tools().await;
        let os = self.deps.os();
        let shell = self.deps.shell();
        let options: Vec<(InstallMethod, String)> = available_methods(cli, os, &tools)
            .into_iter()
            .filter_map(|m| install_command_for(cli, m, os, shell.as_deref()).map(|c| (m, c)))
            .collect();
        let has_npm = options.iter().any(|(m, _)| *m == InstallMethod::Npm);
        let mut out = json!({
            "cli": cli.as_str(),
            "options": options.iter().map(|(m, c)| json!({ "method": method_name(*m), "command": c })).collect::<Vec<_>>(),
        });
        if let Some(v) = tools.node_version.filter(|_| has_npm) {
            out["nodeVersion"] = json!(v);
        }
        Some(out)
    }

    /// `start(request)`: `{cli, method}` only; anything else of the request is ignored.
    pub async fn start(self: &Arc<Self>, request: &Value) -> Result<Started, StartError> {
        let raw = request.as_object().ok_or(StartError::Invalid)?;
        let cli = raw.get("cli").and_then(CliId::from_value).ok_or(StartError::Invalid)?;
        let method = raw.get("method").and_then(parse_method).ok_or(StartError::Invalid)?;
        let os = self.deps.os();
        let shell = self.deps.shell();
        let official = install_command_for(cli, method, os, shell.as_deref()).ok_or(StartError::Invalid)?;

        let session = {
            let mut inner = self.inner.lock();
            if inner.current.is_some() {
                return Err(StartError::Busy);
            }
            let id = uuid_v4();
            let session = Arc::new(Session {
                pty_id: format!("{INSTALL_PTY_PREFIX}{id}"),
                id,
                cli,
                method,
                command: official.clone(),
                st: Mutex::new(SessionState::default()),
            });
            // Claimed before the first await, so a second request is refused.
            inner.current = Some(session.clone());
            session
        };

        let tools = self.tools().await;
        if session.ended() {
            return Err(StartError::Unavailable);
        }
        if !available_methods(cli, os, &tools).contains(&method) {
            self.end(&session);
            return Err(StartError::Unavailable);
        }
        let text = self.deps.command_override(cli, method).filter(|t| !t.is_empty()).unwrap_or_else(|| official.clone());
        let typed = typed_install_command(&text, shell_family(shell.as_deref(), os));
        let env = self.deps.apply_env(clean_env(&self.deps.env())).await;
        if session.ended() {
            return Err(StartError::Unavailable);
        }
        if self.deps.spawn_pty(InstallPty { id: session.pty_id.clone(), command: typed, env }).is_err() {
            self.end(&session);
            return Err(StartError::Spawn);
        }

        {
            let mut st = session.st.lock();
            if !st.ended {
                let (me, s) = (Arc::downgrade(self), session.clone());
                let poll = self.timings.poll;
                st.timers.poll = Some(self.rt.spawn(async move {
                    let mut every = tokio::time::interval_at(tokio::time::Instant::now() + poll, poll);
                    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    loop {
                        every.tick().await;
                        let Some(m) = me.upgrade() else { return };
                        m.tick(&s).await;
                    }
                }));
                let (me, s) = (Arc::downgrade(self), session.clone());
                let timeout = self.timings.timeout;
                st.timers.timeout = Some(self.rt.spawn(async move {
                    tokio::time::sleep(timeout).await;
                    if let Some(m) = me.upgrade() {
                        m.spawn_complete(&s, None, Mode::Timeout);
                    }
                }));
            }
        }
        self.deps.emit(&InstallState::Running { session_id: session.id.clone() });
        Ok(Started { session_id: session.id.clone(), pty_id: session.pty_id.clone(), command: official })
    }

    /// Events of the pty service about an `install:` terminal. True when the event belonged to the running install.
    pub fn on_host_event(self: &Arc<Self>, event: PtyEvent<'_>) -> bool {
        let Some(session) = self.inner.lock().current.clone() else { return false };
        if event.id() != session.pty_id {
            return false;
        }
        let mut st = session.st.lock();
        if st.ended {
            return true;
        }
        match event {
            PtyEvent::Spawned { pid, .. } => st.pid = Some(pid),
            PtyEvent::SpawnError { .. } => {
                drop(st);
                self.fail(&session, InstallReason::Generic, None);
            }
            PtyEvent::Tap { data, .. } => {
                st.output.push_str(data);
                keep_tail(&mut st.output, OUTPUT_KEEP);
                if st.finishing {
                    return true;
                }
                if let Some(code) = parse_install_marker(&st.output) {
                    drop(st);
                    self.spawn_complete(&session, Some(code), Mode::Normal);
                }
            }
            PtyEvent::Interrupt { .. } => {
                // Ctrl+C aborts the rest of the typed line in PowerShell and POSIX shells, so the marker may never come.
                if !st.finishing && st.timers.abort.is_none() {
                    let (me, s) = (Arc::downgrade(self), session.clone());
                    let wait = self.timings.abort_grace;
                    st.timers.abort = Some(self.rt.spawn(async move {
                        tokio::time::sleep(wait).await;
                        if let Some(m) = me.upgrade() {
                            m.spawn_complete(&s, None, Mode::Aborted);
                        }
                    }));
                }
            }
            PtyEvent::Exit { code, .. } => {
                // The shell itself ended (an installer called `exit`, or the user closed it): that is the command's result.
                if !st.finishing {
                    let code = parse_install_marker(&st.output).unwrap_or(code);
                    drop(st);
                    self.spawn_complete(&session, Some(code), Mode::Normal);
                }
            }
        }
        true
    }

    /// `cancel(sessionId)`: no state is emitted, late output is ignored.
    pub fn cancel(&self, session_id: &str) {
        let Some(session) = self.inner.lock().current.clone() else { return };
        if session.id != session_id {
            return;
        }
        self.end(&session);
        self.kill(&session);
    }

    /// `install:cancel(id)` from the renderer: only a string id cancels; anything else is ignored.
    pub fn cancel_request(&self, id: &Value) {
        if let Some(id) = id.as_str() {
            self.cancel(id);
        }
    }

    /// The pty service crashed.
    pub fn fail_active(&self) {
        let Some(session) = self.inner.lock().current.clone() else { return };
        self.fail(&session, InstallReason::Generic, None);
    }

    /// The main window reloaded, crashed or closed, or the app quits: the terminal goes without a state.
    pub fn dispose(&self) {
        let Some(session) = self.inner.lock().current.clone() else { return };
        self.end(&session);
        self.kill(&session);
    }

    // ── completion ─────────────────────────────────────────────────────────────

    /// Periodic early look: the CLI may be there before the typed command returned.
    async fn tick(self: &Arc<Self>, session: &Arc<Session>) {
        {
            let st = session.st.lock();
            if st.ended || st.finishing || st.timers.grace.is_some() {
                return;
            }
        }
        let status = self.deps.detect(session.cli).await;
        let mut st = session.st.lock();
        if st.ended || st.finishing || st.timers.grace.is_some() {
            return;
        }
        // A verified version means the binary runs; a half-written file is not announced as success.
        if status.state == CliState::Found && status.version.is_some() {
            let (me, s) = (Arc::downgrade(self), session.clone());
            let grace = self.timings.grace;
            st.timers.grace = Some(self.rt.spawn(async move {
                tokio::time::sleep(grace).await;
                if let Some(m) = me.upgrade() {
                    m.spawn_complete(&s, None, Mode::Normal);
                }
            }));
        }
    }

    /// Runs [`Self::complete`] as its own task (a timer that calls it is aborted by the completion itself).
    fn spawn_complete(self: &Arc<Self>, session: &Arc<Session>, exit_code: Option<i64>, mode: Mode) {
        {
            let mut st = session.st.lock();
            if st.ended || st.finishing {
                return;
            }
            st.finishing = true;
            st.timers.clear();
        }
        let (me, s) = (self.clone(), session.clone());
        self.rt.spawn(async move { me.complete(&s, exit_code, mode).await });
    }

    /// The command returned (marker, shell exit), the grace period after an early find ran out, or the time limit hit.
    async fn complete(self: &Arc<Self>, session: &Arc<Session>, exit_code: Option<i64>, mode: Mode) {
        let status = self.deps.recheck(session.cli).await.remove(&session.cli);
        if session.ended() {
            return;
        }
        if let Some(status) = status.filter(|s| s.state == CliState::Found) {
            let os = self.deps.os();
            let dir = status.path.as_deref().map(|p| dirname(os, p));
            self.finish(
                session,
                InstallState::Succeeded { session_id: session.id.clone(), version: status.version, path: status.path, dir },
            );
            return;
        }
        let output = session.st.lock().output.clone();
        let reason = classify_install_failure(&FailureInput {
            exit_code,
            output: &output,
            method: session.method,
            installed_but_missing: exit_code == Some(0),
            timed_out: mode == Mode::Timeout,
            aborted: mode == Mode::Aborted,
        });
        self.fail(session, reason, exit_code);
    }

    fn fail(&self, session: &Arc<Session>, reason: InstallReason, exit_code: Option<i64>) {
        let dir = if reason == InstallReason::NotOnPath {
            expected_bin_dir(session.cli, session.method, self.deps.os(), &self.deps.home(), &self.deps.env())
        } else {
            None
        };
        self.finish(session, InstallState::Failed { session_id: session.id.clone(), reason, exit_code, dir });
    }

    fn finish(&self, session: &Arc<Session>, state: InstallState) {
        if session.ended() {
            return;
        }
        self.end(session);
        // The shell is idle at its prompt now; the terminal text stays visible in the window.
        self.kill(session);
        self.deps.emit(&state);
    }

    fn end(&self, session: &Arc<Session>) {
        {
            let mut st = session.st.lock();
            st.ended = true;
            st.timers.clear();
        }
        let mut inner = self.inner.lock();
        if inner.current.as_ref().is_some_and(|c| Arc::ptr_eq(c, session)) {
            inner.current = None;
        }
    }

    fn kill(&self, session: &Arc<Session>) {
        if let Some(pid) = session.st.lock().pid {
            self.deps.kill_tree(pid);
        }
        self.deps.kill_pty(&session.pty_id);
    }

    // ── prerequisites ──────────────────────────────────────────────────────────

    fn tools(&self) -> ToolsTask {
        let now = self.deps.now();
        let mut inner = self.inner.lock();
        if let Some((at, task)) = &inner.tools
            && now - *at <= self.timings.tools_ttl_ms
        {
            return task.clone();
        }
        let deps = self.deps.clone();
        let fallback = InstallTools { curl: deps.os() == Os::Mac, ..InstallTools::default() };
        let handle = self.rt.spawn(probe_tools(deps));
        let task = async move { handle.await.unwrap_or(fallback) }.boxed().shared();
        inner.tools = Some((now, task.clone()));
        task
    }
}

/// Windows: `where` against the registry-refreshed PATH. POSIX: one login-shell probe (brew, nvm and friends live in the rc
/// files).
async fn probe_tools(deps: Arc<dyn InstallDeps>) -> InstallTools {
    let os = deps.os();
    let env = clean_env(&deps.env());
    let request = |file: &str, args: &[&str], env: &Env| ExecRequest {
        file: file.to_string(),
        args: args.iter().map(|a| a.to_string()).collect(),
        timeout_ms: TOOL_TIMEOUT_MS,
        env: env.clone(),
        verbatim: false,
    };
    if os.is_windows() {
        let run_env = deps.apply_env(env).await;
        let (winget, npm, node) = futures::join!(
            deps.exec(request("where.exe", &["winget"], &run_env)),
            deps.exec(request("where.exe", &["npm"], &run_env)),
            deps.exec(request("where.exe", &["node"], &run_env)),
        );
        let mut node_version = None;
        if node.ok {
            // The node `where` found first on the refreshed PATH (CreateProcess would search the app's own PATH instead).
            let first = node.stdout.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("node").to_string();
            let result = deps.exec(request(&first, &["--version"], &run_env)).await;
            let out = result.stdout.trim_start();
            node_version = parse_version(out.strip_prefix(['v', 'V']).unwrap_or(out));
        }
        return InstallTools { winget: winget.ok, brew: false, npm: npm.ok, node: node.ok, curl: true, node_version };
    }
    // The shell cells (and this install) run in, so the PATH of its rc files is what counts.
    let shell = crate::cli::status::posix_shell_file(deps.shell().as_deref(), os);
    // macOS always ships curl; without a usable probe only the native installer is offered.
    let fallback = InstallTools { curl: os == Os::Mac, ..InstallTools::default() };
    let Some(script) = tool_probe_script(shell) else { return fallback };
    let mut probe_env = env;
    probe_env.push(("Unimux_PROBE".to_string(), "1".to_string()));
    let result = deps.exec(request(shell, &["-ilc", script], &probe_env)).await;
    parse_tool_probe(&result.stdout).unwrap_or(fallback)
}

/// A random v4 UUID (`randomUUID()`).
fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        // Never in practice; a time-based id still never repeats within the run.
        let t = unimux_core::time::now_ms().to_le_bytes();
        b[..8].copy_from_slice(&t);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
