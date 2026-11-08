//! H6: the guided CLI install (`install:options`, `install:start`, `install:cancel`, `install:current`, the `install:state`
//! event) and the auxiliary terminals that are not cells: the install window's `install:` terminal and the login windows'
//! `auth:` terminals (A4 spawns them through [`spawn_login_terminal`]).
//!
//! The renderer names a CLI and a method; nothing else (no command text, no paths, no environment) is ever forwarded. The typed
//! command comes from the allow-list of `unimux_agents::install::shared`.

use std::sync::{Arc, Weak};

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::Value;
use unimux_agents::cli::status::{CliId, CliStatus, CliStatusMap, Env, InstallMethod, Os, clean_env};
use unimux_agents::cli::system::{kill_process_tree, process_env, run_program};
use unimux_agents::cli::{CliDetector, ExecRequest, ExecResult, GetOptions};
use unimux_agents::install::manager::start_result_json;
use unimux_agents::install::{InstallDeps, InstallManager, InstallPty, InstallState, InstallTimings, PtyEvent};
use unimux_ipc::RouterBuilder;
use unimux_pty::manager::SpawnRequest;
use unimux_pty::service::HostEvent;
use unimux_pty::shell::ShellKind;

use crate::commands::pty::{AUTH_PTY_PREFIX, INSTALL_PTY_PREFIX, host, service};
use crate::context::AppContext;

/// Size of the install and login terminals (index.ts: `cols: 100, rows: 28`).
const AUX_COLS: u16 = 100;
const AUX_ROWS: u16 = 28;

/// settings.shell of the live state (`state.settings.shell`).
fn settings_shell(ctx: &AppContext) -> Option<String> {
    ctx.state.get().get("settings").and_then(|s| s.get("shell")).and_then(Value::as_str).map(str::to_string)
}

/// The shell kind a terminal runs: settings.shell, else the platform default of src/shared/state.ts.
fn shell_kind(shell: Option<&str>) -> ShellKind {
    shell.and_then(ShellKind::parse).unwrap_or(if cfg!(windows) { ShellKind::Powershell } else { ShellKind::Zsh })
}

/// A terminal that is not a cell, in the home folder, typed `command` once the shell is up.
fn aux_request(id: &str, command: String, env: Env, shell: Option<&str>) -> SpawnRequest {
    let mut req = SpawnRequest::new(id, unimux_core::home::home_dir(), shell_kind(shell));
    req.cols = AUX_COLS;
    req.rows = AUX_ROWS;
    req.env = env;
    req.command = Some(command);
    req
}

/// The login window's terminal (index.ts `login.spawnPty`): the CLI runs from where it was detected (an install made after the
/// app started is not on the app's own PATH yet); `extra` (the login's own variables) goes on top. Only `auth:` ids.
#[allow(dead_code, reason = "the login managers (A4) spawn their terminals here")]
pub async fn spawn_login_terminal(ctx: &Arc<AppContext>, id: &str, command: &str, extra: &[(String, String)]) -> bool {
    if !id.starts_with(AUTH_PTY_PREFIX) {
        return false;
    }
    let cli = if command.starts_with("codex") { CliId::Codex } else { CliId::Claude };
    let detector = super::cli_detector(ctx);
    let mut env = detector.apply_env(clean_env(&process_env()), Some(cli)).await;
    for (k, v) in extra {
        match env.iter_mut().find(|(n, _)| n == k) {
            Some(slot) => slot.1 = v.clone(),
            None => env.push((k.clone(), v.clone())),
        }
    }
    let shell = settings_shell(ctx);
    service().spawn(aux_request(id, command.to_string(), env, shell.as_deref()), false)
}

/// Kills a login terminal (`login.killPty`).
#[allow(dead_code, reason = "the login managers (A4) kill their terminals here")]
pub fn kill_login_terminal(id: &str) {
    if id.starts_with(AUTH_PTY_PREFIX) {
        service().kill(id);
    }
}

/// The app's side of the install manager: the detector, the pty service, `install:state` to the main window.
struct AppInstallDeps {
    ctx: Weak<AppContext>,
    detector: Arc<CliDetector>,
    command_override: Option<String>,
}

impl InstallDeps for AppInstallDeps {
    fn os(&self) -> Os {
        Os::current()
    }
    fn home(&self) -> String {
        unimux_core::home::home_dir().to_string_lossy().into_owned()
    }
    fn shell(&self) -> Option<String> {
        self.ctx.upgrade().and_then(|c| settings_shell(&c))
    }
    fn env(&self) -> Env {
        process_env()
    }
    fn now(&self) -> i64 {
        unimux_core::time::now_ms()
    }
    fn exec(&self, request: ExecRequest) -> BoxFuture<'static, ExecResult> {
        run_program(request).boxed()
    }
    fn detect(&self, cli: CliId) -> BoxFuture<'static, CliStatus> {
        let d = self.detector.clone();
        async move { d.get(cli, GetOptions { wait_ms: 0, force: true }).await }.boxed()
    }
    fn recheck(&self, cli: CliId) -> BoxFuture<'static, CliStatusMap> {
        let d = self.detector.clone();
        async move { d.recheck(Some(cli)).await }.boxed()
    }
    fn apply_env(&self, env: Env) -> BoxFuture<'static, Env> {
        let d = self.detector.clone();
        async move { d.apply_env(env, None).await }.boxed()
    }
    fn spawn_pty(&self, spec: InstallPty) -> Result<(), String> {
        let ctx = self.ctx.upgrade().ok_or("the app is closing")?;
        if service().is_fatal() {
            return Err("terminals are not running".into());
        }
        let shell = settings_shell(&ctx);
        if service().spawn(aux_request(&spec.id, spec.command, spec.env, shell.as_deref()), true) {
            Ok(())
        } else {
            Err("the terminal could not start".into())
        }
    }
    fn kill_pty(&self, id: &str) {
        service().kill(id);
    }
    fn kill_tree(&self, pid: u32) {
        kill_process_tree(pid);
    }
    fn emit(&self, state: &InstallState) {
        if let Some(ctx) = self.ctx.upgrade() {
            ctx.events.send("install:state", vec![state.to_json()]);
        }
    }
    fn command_override(&self, _cli: CliId, _method: InstallMethod) -> Option<String> {
        self.command_override.clone()
    }
}

/// The install manager of the newest registered context (index.ts `install`).
static INSTALL: Mutex<Option<Arc<InstallManager>>> = Mutex::new(None);

/// The app's install manager, if registered.
#[allow(dead_code, reason = "update:busy (U1) and the quit question ask whether an install runs")]
pub fn install_manager() -> Option<Arc<InstallManager>> {
    INSTALL.lock().clone()
}

/// A pty service event as the manager reads it.
fn pty_event(event: &HostEvent) -> Option<PtyEvent<'_>> {
    Some(match event {
        HostEvent::Spawned { id, pid } => PtyEvent::Spawned { id, pid: *pid },
        HostEvent::SpawnError { id, .. } => PtyEvent::SpawnError { id },
        HostEvent::Tap { id, data } => PtyEvent::Tap { id, data },
        HostEvent::Interrupt { id } => PtyEvent::Interrupt { id },
        HostEvent::Exit { id, code } => PtyEvent::Exit { id, code: *code },
        _ => return None,
    })
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let detector = super::cli_detector(ctx);
    let deps = AppInstallDeps {
        ctx: Arc::downgrade(ctx),
        detector,
        // Check builds only (DevOverrides is empty in a release build): a harmless local script instead of the vendor installer.
        command_override: ctx.overrides.install_command_override.clone().filter(|c| !c.is_empty()),
    };
    let rt = tauri::async_runtime::handle().inner().clone();
    let manager = InstallManager::new(Arc::new(deps), InstallTimings::default(), rt);
    if let Some(old) = INSTALL.lock().replace(manager.clone()) {
        old.dispose();
    }

    // The install window's terminal is not a cell: its events go to the manager only (a handler of an older context answers
    // false, so the newest one sees them too).
    let weak = Arc::downgrade(&manager);
    host().on_prefix(INSTALL_PTY_PREFIX, move |event| {
        let Some(m) = weak.upgrade() else { return false };
        pty_event(event).is_some_and(|e| m.on_host_event(e))
    });
    // The pty service crashed: the running install failed.
    let weak = Arc::downgrade(&manager);
    host().on_crashed("install", move || {
        if let Some(m) = weak.upgrade() {
            m.fail_active();
        }
    });
    // The install window lives in the main window's page: a reload, a crash or a closed window must not leave an invisible
    // install running.
    let weak = Arc::downgrade(&manager);
    ctx.lifecycle.on_page_gone(move |label| {
        if label == crate::windows::MAIN
            && let Some(m) = weak.upgrade()
        {
            m.dispose();
        }
    });
    let weak = Arc::downgrade(&manager);
    ctx.lifecycle.wind_down.register(
        crate::lifecycle::wind_down::phase::STOP_SERVICES,
        "install dispose",
        std::time::Duration::from_secs(1),
        move || async move {
            if let Some(m) = weak.upgrade() {
                m.dispose();
            }
        },
    );

    // ipcMain.handle('install:options'): only a known CLI is answered.
    let m = manager.clone();
    r.invoke("install:options", move |call| {
        let m = m.clone();
        async move { Ok(m.options(call.arg(0)).await.unwrap_or(Value::Null)) }
    });

    // guardedHandle('install:start'): only `cli` and `method` of an object are read.
    let m = manager.clone();
    r.invoke("install:start", move |call| {
        let m = m.clone();
        async move {
            // The manager reads `cli` and `method` of an object and nothing else; anything that is not an object is invalid.
            Ok(start_result_json(&m.start(call.arg(0)).await))
        }
    });

    // guardedOn('install:cancel'): only with a string id.
    let m = manager.clone();
    r.send("install:cancel", move |call| {
        let m = m.clone();
        async move { m.cancel_request(call.arg(0)) }
    });

    // ipcMain.handle('install:current'): the running install, so a window opened later attaches to it.
    let m = manager;
    r.invoke("install:current", move |_call| {
        let m = m.clone();
        async move { Ok(m.active().map_or(Value::Null, |a| a.to_json())) }
    });
}
