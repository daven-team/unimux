//! Commands of the `sftp` domain: T1-T5: SFTP sessions and transfers (sftp:*); the sftp port owner registers with ctx.ports.register("sftp", ...).
//!
//! T1 (the SFTP parts of 1.1.4 src/main/index.ts with src/main/sftp/ipc.ts `registerSftpIpc`): the SFTP host
//! (`unimux_sftp::host::SftpHost`, in this process; started lazily like 1.1.4's utility process, so nothing runs before
//! the first SFTP use) plugged into the SSH coordinator's `sftp` owner slot, the service (`unimux_sftp::service`) with the
//! coordinator's `sftp:` events, the 24 `sftp:*` channels with 1.1.4's validation, the `sftp:session` / `sftp:prompt` /
//! `sftp:hostCrashed` events, the transfer port `mc:sftp-port`, the page-gone hooks (a reload counts the view closed and
//! drops the window's pins) and the quit step (`sftp shutdown`, at most about 2 s; the hard limit stops the session tasks).
//! What runs on a connected session (the SFTP client, queues, manage ops, sudo) is T2-T5's backend; until then
//! `UnportedBackend` answers.

use std::sync::{Arc, Weak};

use futures::future::BoxFuture;
use serde_json::{Value, json};
use unimux_ipc::RouterBuilder;
use unimux_sftp::host::{HostDeps, HostOut, SftpHost, UnportedBackend};
use unimux_sftp::ipc;
use unimux_sftp::limits::SHUTDOWN_WAIT;
use unimux_sftp::service::{SftpCoordinator, SftpDeps, SftpEvents, SftpService};
use unimux_sftp::timers::{Timers, TokioTimers};
use unimux_ssh::protocol::{HostMessage, PromptAnswer};
use unimux_ssh::session::{SessionHostKind, SshErrorCode};

use crate::commands::ssh::link::{SessionSink, SshLink, link};
use crate::context::AppContext;
use crate::lifecycle::wind_down::phase;

/// The coordinator as the SFTP service sees it (1.1.4 passes the coordinator itself).
struct Coordinator(Arc<SshLink>);

impl SftpCoordinator for Coordinator {
    fn connect_session(&self, session_id: &str, host_id: &str, sudo: bool) -> BoxFuture<'static, Result<(), SshErrorCode>> {
        let (c, id, host) = (self.0.coordinator.clone(), session_id.to_string(), host_id.to_string());
        Box::pin(async move { c.connect_session(&id, &host, sudo).await })
    }
    fn end_session(&self, id: &str) {
        self.0.coordinator.end_session(id);
    }
    fn answer(&self, answer: PromptAnswer) -> bool {
        self.0.coordinator.answer(answer)
    }
    fn prompts(&self) -> Vec<(String, Value)> {
        self.0.coordinator.session_prompts(SessionHostKind::Sftp)
    }
    fn on_host_message(&self, m: HostMessage) {
        self.0.coordinator.on_host_message(m);
    }
    fn session_host_crashed(&self) {
        self.0.coordinator.session_host_crashed(SessionHostKind::Sftp);
    }
}

/// `sftp:session`, `sftp:prompt`, `sftp:hostCrashed`.
struct Events(Weak<AppContext>);

impl SftpEvents for Events {
    fn session(&self, state: &Value) {
        if let Some(ctx) = self.0.upgrade() {
            ctx.events.send("sftp:session", vec![state.clone()]);
        }
    }
    fn prompt(&self, session_id: &str, prompt: Option<&Value>) {
        if let Some(ctx) = self.0.upgrade() {
            ctx.events.send("sftp:prompt", vec![json!(session_id), prompt.cloned().unwrap_or(Value::Null)]);
        }
    }
    fn host_crashed(&self) {
        if let Some(ctx) = self.0.upgrade() {
            ctx.events.send("sftp:hostCrashed", vec![]);
        }
    }
}

/// The host's messages to the service.
struct ToService(Weak<SftpService>);

impl HostOut for ToService {
    fn ssh(&self, m: HostMessage) {
        if let Some(s) = self.0.upgrade() {
            s.on_host_ssh(m);
        }
    }
    fn queue(&self, id: &str, active: bool) {
        if let Some(s) = self.0.upgrade() {
            s.on_queue(id, active);
        }
    }
    fn crashed(&self, _detail: &str) {
        if let Some(s) = self.0.upgrade() {
            s.host_crashed();
        }
    }
}

/// The coordinator's `sftp:` states and prompts to the service (1.1.4 startSsh `events`).
struct Sink(Weak<SftpService>);

impl SessionSink for Sink {
    fn session(&self, state: &Value) {
        if let Some(s) = self.0.upgrade() {
            s.on_coordinator_session(state);
        }
    }
    fn prompt(&self, session_id: &str, prompt: Option<&Value>) {
        if let Some(s) = self.0.upgrade() {
            s.on_prompt(session_id, prompt);
        }
    }
}

fn ssh_host<'a>(state: &'a Value, id: &str) -> Option<&'a Value> {
    state.get("sshHosts")?.as_array()?.iter().find(|h| h.get("id").and_then(Value::as_str) == Some(id))
}

/// The id of the window that asked (`senderWindow`): a detached window's id, else `main`.
fn window_of(ctx: &AppContext, label: &str) -> String {
    ctx.detached.sender_window(label)
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let runtime = tauri::async_runtime::handle().inner().clone();
    let timers: Arc<dyn Timers> = Arc::new(TokioTimers::new(runtime.clone()));
    let mut deps = HostDeps::new(runtime.clone(), timers.clone());
    let crash = Arc::downgrade(ctx);
    deps.log = Arc::new(move |line: &str| {
        if let Some(c) = crash.upgrade() {
            c.crash.error(line);
        }
    });
    let host = SftpHost::new(deps, |_channels| Arc::new(UnportedBackend));
    let ssh = link(ctx);
    let spawn = {
        let rt = runtime.clone();
        Arc::new(move |f: BoxFuture<'static, ()>| {
            rt.spawn(f);
        })
    };
    let (hosts, sudo_hosts) = (Arc::downgrade(ctx), Arc::downgrade(ctx));
    let service = SftpService::new(SftpDeps {
        coordinator: Arc::new(Coordinator(ssh.clone())),
        host: host.clone(),
        host_exists: Arc::new(move |id| hosts.upgrade().is_some_and(|c| ssh_host(&c.state.get(), id).is_some())),
        host_sudo: Arc::new(move |id| {
            sudo_hosts
                .upgrade()
                .is_some_and(|c| ssh_host(&c.state.get(), id).and_then(|h| h.get("sftpSudo")) == Some(&Value::Bool(true)))
        }),
        events: Arc::new(Events(Arc::downgrade(ctx))),
        timers,
        now: Arc::new(unimux_core::time::now_ms),
        new_uuid: Arc::new(|| uuid::Uuid::new_v4().to_string()),
        defer: spawn.clone(),
        spawn,
        idle_ms: SftpDeps::IDLE_MS,
    });
    host.set_out(Arc::new(ToService(Arc::downgrade(&service))));
    // The coordinator's logins of `sftp:` ids go to this host; its `sftp:` events to the service.
    ssh.owners.set(Some(SessionHostKind::Sftp), host.clone());
    let _ = ssh.events.sftp.set(Arc::new(Sink(Arc::downgrade(&service))));
    ctx.ports.register("sftp", host.clone());

    // A page reloads, crashed or its window closed: main's view counts closed, that window's pins go.
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

    // Quit: the sessions close (1.1.4 `sftpHost.shutdown()`, waited for 4 s); the hard limit stops them.
    let h = host.clone();
    ctx.lifecycle.wind_down.register(phase::HOSTS, "sftp shutdown", SHUTDOWN_WAIT, move || async move { h.shutdown().await });
    let h = host.clone();
    ctx.lifecycle.wind_down.on_force_exit(move || h.force_kill());

    register_sessions(r, ctx, &service);
    register_ops(r, &service);
}

fn register_sessions(r: &mut RouterBuilder, ctx: &Arc<AppContext>, service: &Arc<SftpService>) {
    let s = service.clone();
    r.invoke("sftp:connect", move |call| {
        let s = s.clone();
        async move { Ok(ipc::connect(&s, call.arg(0), call.arg(1), call.arg(2))) }
    });
    let s = service.clone();
    r.invoke("sftp:disconnect", move |call| {
        let s = s.clone();
        async move { Ok(ipc::disconnect(&s, call.arg(0))) }
    });
    let s = service.clone();
    r.invoke("sftp:sessions", move |_call| {
        let s = s.clone();
        async move { Ok(s.snapshot()) }
    });
    let s = service.clone();
    r.invoke("sftp:prompt:answer", move |call| {
        let s = s.clone();
        async move { Ok(ipc::answer(&s, call.arg(0))) }
    });
    let (s, c) = (service.clone(), Arc::downgrade(ctx));
    r.send("sftp:pinHosts", move |call| {
        let (s, c) = (s.clone(), c.clone());
        async move {
            let Some(ctx) = c.upgrade() else { return };
            ipc::pin_hosts(&s, call.arg(0), &window_of(&ctx, &call.caller.label));
        }
    });
    // The SFTP view lives in the main window only: a detached window never opens or closes it.
    let (s, c) = (service.clone(), Arc::downgrade(ctx));
    r.send("sftp:viewOpened", move |call| {
        let (s, c) = (s.clone(), c.clone());
        async move {
            if c.upgrade().is_some_and(|ctx| window_of(&ctx, &call.caller.label) == "main") {
                ipc::view_opened(&s, call.arg(0));
            }
        }
    });
    let (s, c) = (service.clone(), Arc::downgrade(ctx));
    r.send("sftp:viewClosed", move |call| {
        let (s, c) = (s.clone(), c.clone());
        async move {
            if c.upgrade().is_some_and(|ctx| window_of(&ctx, &call.caller.label) == "main") {
                s.view_closed();
            }
        }
    });
}

/// One `(id, a)` channel.
macro_rules! op1 {
    ($r:expr, $service:expr, $channel:literal, $f:path) => {{
        let s = $service.clone();
        $r.invoke($channel, move |call| {
            let s = s.clone();
            async move { Ok($f(&s, call.arg(0), call.arg(1)).await) }
        });
    }};
}

/// One `(id, a, b)` channel.
macro_rules! op2 {
    ($r:expr, $service:expr, $channel:literal, $f:path) => {{
        let s = $service.clone();
        $r.invoke($channel, move |call| {
            let s = s.clone();
            async move { Ok($f(&s, call.arg(0), call.arg(1), call.arg(2)).await) }
        });
    }};
}

fn register_ops(r: &mut RouterBuilder, service: &Arc<SftpService>) {
    op1!(r, service, "sftp:list", ipc::list);
    op1!(r, service, "sftp:stat", ipc::stat);
    op1!(r, service, "sftp:realpath", ipc::realpath);
    op1!(r, service, "sftp:mkdir", ipc::mkdir);
    op2!(r, service, "sftp:rename", ipc::rename);
    op1!(r, service, "sftp:deleteCount", ipc::delete_count_op);
    op2!(r, service, "sftp:delete", ipc::delete);
    op1!(r, service, "sftp:enqueue", ipc::enqueue);
    op1!(r, service, "sftp:cancel", ipc::cancel);
    op2!(r, service, "sftp:answerConflict", ipc::answer_conflict);
    op1!(r, service, "sftp:retry", ipc::retry);
    let s = service.clone();
    r.invoke("sftp:clearFinished", move |call| {
        let s = s.clone();
        async move { Ok(ipc::clear_finished(&s, call.arg(0)).await) }
    });
    op2!(r, service, "sftp:chmodCount", ipc::chmod_count);
    op1!(r, service, "sftp:chmod", ipc::chmod);
    op1!(r, service, "sftp:cancelOp", ipc::cancel_op);
    op1!(r, service, "sftp:statFile", ipc::stat_file);
    op1!(r, service, "sftp:readFile", ipc::read_file);
    op2!(r, service, "sftp:writeFile", ipc::write_file);
}
