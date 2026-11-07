//! S3: the SshCoordinator in the app ([`SshLink`] in `ctx.ssh_link`) with its owner slots (`owners`: the SSH cells P5,
//! SFTP sessions T1 and DB tunnels D2 plug in there) and its event routes (cells to the windows as `ssh:session` /
//! `ssh:prompt`, `sftp:` ids to the SFTP service T1, `db:` ids to the DB service D1), the channels `ssh:connect`,
//! `ssh:sessions` and `ssh:prompt:answer` with 1.1.4's zod schemas (src/main/ssh/ipc.ts `S.connect`, `S.answer`), the prune
//! after every state change, the cell's `resume` mark (noteSshResume) and the DB service's coordinator ([`DbTunnels`]).

use std::sync::{Arc, OnceLock, Weak};

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use unimux_ipc::RouterBuilder;
use unimux_ssh::coordinator::{
    ConnectCellRequest, CoordinatorDeps, CoordinatorEvents, CoordinatorState, HostRouter, PROMPT_TIMEOUT, SshCoordinator,
};
use unimux_ssh::protocol::{HostKeyChoice, HostMessage, PromptAnswer};
use unimux_ssh::session::{
    SessionHostKind, SessionState, find_cell, find_host, is_db_session_id, is_sftp_session_id, patch_ssh_cell_resume,
    resume_for_phase,
};
use zeroize::Zeroizing;

use crate::context::AppContext;

/// Where the coordinator's events of non-cell sessions go (the SFTP service T1, the DB service D1).
pub trait SessionSink: Send + Sync {
    fn session(&self, state: &Value);
    fn prompt(&self, session_id: &str, prompt: Option<&Value>);
}

/// The coordinator and what the domains plug into it.
pub struct SshLink {
    pub coordinator: Arc<SshCoordinator>,
    /// The owners of the connections (P5 cells, T1 SFTP, D2 DB tunnels).
    #[allow(dead_code, reason = "P5 / T1 / D2 fill the owner slots")]
    pub owners: Arc<HostRouter>,
    pub events: Arc<AppSshEvents>,
}

/// The routes of the coordinator's events (1.1.4 startSsh `events`).
pub struct AppSshEvents {
    ctx: Weak<AppContext>,
    pub sftp: OnceLock<Arc<dyn SessionSink>>,
    pub db: OnceLock<Arc<dyn SessionSink>>,
}

impl CoordinatorEvents for AppSshEvents {
    fn session(&self, s: &SessionState) {
        if is_sftp_session_id(&s.cell_id) {
            if let Some(sink) = self.sftp.get() {
                sink.session(&s.to_json());
            }
        } else if is_db_session_id(&s.cell_id) {
            if let Some(sink) = self.db.get() {
                sink.session(&s.to_json());
            }
        } else if let Some(ctx) = self.ctx.upgrade() {
            note_ssh_resume(&ctx, s);
            ctx.events.send("ssh:session", vec![s.to_json()]);
        }
    }

    fn prompt(&self, cell_id: &str, prompt: Option<&Value>) {
        if is_sftp_session_id(cell_id) {
            if let Some(sink) = self.sftp.get() {
                sink.prompt(cell_id, prompt);
            }
        } else if is_db_session_id(cell_id) {
            if let Some(sink) = self.db.get() {
                sink.prompt(cell_id, prompt);
            }
        } else if let Some(ctx) = self.ctx.upgrade() {
            ctx.events.send("ssh:prompt", vec![json!(cell_id), prompt.cloned().unwrap_or(Value::Null)]);
        }
    }

    fn vault_changed(&self) {
        let Some(ctx) = self.ctx.upgrade() else { return };
        tauri::async_runtime::spawn(async move {
            let vault = ctx.ssh.vault().await;
            let info = vault.lock().info();
            ctx.events.send("ssh:vault:changed", vec![info]);
        });
    }
}

/// `noteSshResume`: a cell's `resume` follows its session (connected sets it, an end clears it), except while the app
/// winds down, the startup gate decides, another instance took over or the OS session ends. The edit runs on its own task:
/// a session event can come from inside a state change hook.
fn note_ssh_resume(ctx: &Arc<AppContext>, s: &SessionState) {
    let lc = &ctx.lifecycle;
    if lc.is_quitting() || lc.is_gating() || lc.is_superseded() || lc.session_ending() {
        return;
    }
    let Some(resume) = resume_for_phase(s.phase) else { return };
    let (ctx, cell) = (ctx.clone(), s.cell_id.clone());
    tauri::async_runtime::spawn(async move {
        if patch_ssh_cell_resume(&ctx.state.get(), &cell, resume).is_none() {
            return;
        }
        let _ = ctx.state.change(|st| Ok(patch_ssh_cell_resume(st, &cell, resume).unwrap_or_else(|| st.clone())), None, false);
    });
}

struct AppState(Weak<AppContext>);

impl CoordinatorState for AppState {
    fn state(&self) -> Arc<Value> {
        self.0.upgrade().map(|c| c.state.get()).unwrap_or_else(|| Arc::new(json!({})))
    }
}

/// The coordinator of `ctx`, created on first use (ssh::register runs before the domains that use it).
pub fn link(ctx: &Arc<AppContext>) -> Arc<SshLink> {
    ctx.ssh_link
        .get_or_init(|| {
            let owners = HostRouter::new();
            let events = Arc::new(AppSshEvents { ctx: Arc::downgrade(ctx), sftp: OnceLock::new(), db: OnceLock::new() });
            let coordinator = SshCoordinator::new(CoordinatorDeps {
                state: Arc::new(AppState(Arc::downgrade(ctx))),
                stores: ctx.ssh.clone(),
                host: owners.clone(),
                events: events.clone(),
                spawn: Arc::new(|f| {
                    tauri::async_runtime::spawn(f);
                }),
                now: Arc::new(unimux_core::time::now_ms),
                new_id: Arc::new(|| uuid::Uuid::new_v4().to_string()),
                debug: ctx.overrides.ssh_debug,
                prompt_timeout: PROMPT_TIMEOUT,
                check_passphrase: Arc::new(unimux_ssh::keys::check_passphrase),
            });
            Arc::new(SshLink { coordinator, owners, events })
        })
        .clone()
}

/// `z.guid()`: 8-4-4-4-12 hex digits, any version.
fn is_guid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let b = s.as_bytes();
        b.len() == 36
            && b.iter().enumerate().all(|(i, c)| match i {
                8 | 13 | 18 | 23 => *c == b'-',
                _ => c.is_ascii_hexdigit(),
            })
    })
}

/// `z.number().int().min(lo).max(hi)`.
fn int_in(v: &Value, lo: f64, hi: f64) -> Option<u32> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && n >= lo && n <= hi).then_some(n as u32)
}

/// `.strict()`: only these keys.
fn only_keys(o: &Map<String, Value>, keys: &[&str]) -> bool {
    o.keys().all(|k| keys.contains(&k.as_str()))
}

/// `z.boolean().optional()`.
fn opt_bool(o: &Map<String, Value>, key: &str) -> Option<bool> {
    match o.get(key) {
        None => Some(false),
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => None,
    }
}

/// `S.connect` of src/main/ssh/ipc.ts.
pub fn parse_connect(raw: &Value) -> Option<ConnectCellRequest> {
    let o = raw.as_object()?;
    if !only_keys(o, &["cellId", "hostId", "cols", "rows", "restoreCwd"]) {
        return None;
    }
    let (cell, host) = (o.get("cellId")?, o.get("hostId")?);
    if !is_guid(cell) || !is_guid(host) {
        return None;
    }
    let cols = int_in(o.get("cols")?, 2.0, 2000.0)?;
    let rows = int_in(o.get("rows")?, 1.0, 1000.0)?;
    let restore_cwd = opt_bool(o, "restoreCwd")?;
    Some(ConnectCellRequest { cell_id: cell.as_str()?.to_string(), host_id: host.as_str()?.to_string(), cols, rows, restore_cwd })
}

/// `SSH_LIMITS.password` (zod 4.6 counts code points in `z.string().max`).
const PASSWORD_MAX: usize = 1024;

/// `S.answer`: the union of cancel / values / hostKey, each strict (no `useSaved` from a cell's prompt).
pub fn parse_answer(raw: &Value) -> Option<PromptAnswer> {
    let o = raw.as_object()?;
    let (cell, prompt) = (o.get("cellId")?, o.get("promptId")?);
    if !is_guid(cell) || !is_guid(prompt) {
        return None;
    }
    let (cell_id, prompt_id) = (cell.as_str()?.to_string(), prompt.as_str()?.to_string());
    if only_keys(o, &["cellId", "promptId", "cancel"]) && o.get("cancel") == Some(&Value::Bool(true)) {
        return Some(PromptAnswer::Cancel { cell_id, prompt_id });
    }
    if only_keys(o, &["cellId", "promptId", "values", "remember"])
        && let Some(list) = o.get("values").and_then(Value::as_array)
        && list.len() <= 10
        && let Some(remember) = opt_bool(o, "remember")
        && let Some(values) = list
            .iter()
            .map(|v| v.as_str().filter(|s| s.chars().count() <= PASSWORD_MAX).map(|s| Zeroizing::new(s.to_string())))
            .collect::<Option<Vec<_>>>()
    {
        return Some(PromptAnswer::Values { cell_id, prompt_id, values, remember, use_saved: false });
    }
    if only_keys(o, &["cellId", "promptId", "hostKey"])
        && let Some(choice) = o.get("hostKey").and_then(Value::as_str).and_then(HostKeyChoice::parse)
    {
        return Some(PromptAnswer::HostKey { cell_id, prompt_id, choice });
    }
    None
}

pub(super) fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let link = link(ctx);

    // After every state change: passwords of deleted hosts and identities go, ended sessions of removed cells are forgotten.
    let coordinator = link.coordinator.clone();
    ctx.state.on_change(move |change| coordinator.state_changed(&change.snapshot.state));

    let (c, l) = (ctx.clone(), link.clone());
    r.invoke("ssh:connect", move |call| {
        let (c, l) = (c.clone(), l.clone());
        async move {
            // A request of the wrong shape is named as such (not "unknown"): nothing was sent to the server.
            let Some(req) = parse_connect(call.arg(0)) else { return Ok(json!({ "ok": false, "error": "badRequest" })) };
            let state = c.state.get();
            let bound = find_cell(&state, &req.cell_id)
                .and_then(|cell| cell.get("ssh"))
                .and_then(|s| s.get("hostId"))
                .and_then(Value::as_str)
                == Some(req.host_id.as_str());
            if !bound || find_host(&state, &req.host_id).is_none() {
                return Ok(json!({ "ok": false, "error": "hostMissing" }));
            }
            Ok(match l.coordinator.connect(req).await {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e.as_str() }),
            })
        }
    });

    let l = link.clone();
    r.invoke("ssh:sessions", move |_call| {
        let l = l.clone();
        async move { Ok(l.coordinator.sessions()) }
    });

    let l = link.clone();
    r.invoke("ssh:prompt:answer", move |call| {
        let l = l.clone();
        async move {
            let ok = parse_answer(call.arg(0)).is_some_and(|a| l.coordinator.answer(a));
            Ok(json!({ "ok": ok }))
        }
    });
}

/// The DB service's view of the coordinator (1.1.4 passes the coordinator itself): tunnel logins of `db:` sessions.
pub struct DbTunnels(pub Arc<SshLink>);

impl unimux_db::service::DbCoordinator for DbTunnels {
    fn connect_session(&self, session_id: &str, host_id: &str) -> BoxFuture<'static, Result<(), String>> {
        let (c, id, host) = (self.0.coordinator.clone(), session_id.to_string(), host_id.to_string());
        Box::pin(async move { c.connect_session(&id, &host, false).await.map_err(|e| e.as_str().to_string()) })
    }
    fn end_session(&self, session_id: &str) {
        self.0.coordinator.end_session(session_id);
    }
    fn answer(&self, answer: Value) -> bool {
        PromptAnswer::from_json(&answer).is_some_and(|a| self.0.coordinator.answer(a))
    }
    fn prompts(&self) -> Vec<(String, Value)> {
        self.0.coordinator.session_prompts(SessionHostKind::Db)
    }
    fn on_host_message(&self, m: &Value) {
        if let Some(m) = HostMessage::from_json(m) {
            self.0.coordinator.on_host_message(m);
        }
    }
    fn session_host_crashed(&self) {
        self.0.coordinator.session_host_crashed(SessionHostKind::Db);
    }
}

/// The coordinator's `db:` events to the DB service.
pub struct DbSink(pub Weak<unimux_db::service::DbService>);

impl SessionSink for DbSink {
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

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";

    #[test]
    fn connect_requests_follow_the_zod_schema() {
        let ok = json!({ "cellId": A, "hostId": B, "cols": 80, "rows": 24 });
        assert_eq!(parse_connect(&ok).map(|r| (r.cols, r.rows, r.restore_cwd)), Some((80, 24, false)));
        assert!(
            parse_connect(&json!({ "cellId": A, "hostId": B, "cols": 80, "rows": 24, "restoreCwd": true })).unwrap().restore_cwd
        );
        for bad in [
            json!({ "cellId": A, "hostId": B, "cols": 1, "rows": 24 }),
            json!({ "cellId": A, "hostId": B, "cols": 80.5, "rows": 24 }),
            json!({ "cellId": A, "hostId": B, "cols": 80, "rows": 1001 }),
            json!({ "cellId": "x", "hostId": B, "cols": 80, "rows": 24 }),
            json!({ "cellId": A, "hostId": B, "cols": 80, "rows": 24, "extra": 1 }),
            json!({ "cellId": A, "hostId": B, "cols": 80, "rows": 24, "restoreCwd": null }),
            json!([A]),
        ] {
            assert!(parse_connect(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn answers_follow_the_zod_union() {
        assert!(matches!(
            parse_answer(&json!({ "cellId": A, "promptId": B, "cancel": true })),
            Some(PromptAnswer::Cancel { .. })
        ));
        assert!(matches!(
            parse_answer(&json!({ "cellId": A, "promptId": B, "values": ["x"], "remember": true })),
            Some(PromptAnswer::Values { remember: true, use_saved: false, .. })
        ));
        assert!(matches!(
            parse_answer(&json!({ "cellId": A, "promptId": B, "hostKey": "save" })),
            Some(PromptAnswer::HostKey { choice: HostKeyChoice::Save, .. })
        ));
        // 1024 code points pass, 1025 do not (an emoji counts once).
        assert!(parse_answer(&json!({ "cellId": A, "promptId": B, "values": ["\u{1F600}".repeat(1024)] })).is_some());
        for bad in [
            json!({ "cellId": A, "promptId": B, "cancel": false }),
            json!({ "cellId": A, "promptId": B, "values": ["x"], "useSaved": true }),
            json!({ "cellId": A, "promptId": B, "values": vec!["x"; 11] }),
            json!({ "cellId": A, "promptId": B, "values": ["a".repeat(1025)] }),
            json!({ "cellId": A, "promptId": B, "hostKey": "always" }),
            json!({ "cellId": A, "promptId": B, "cancel": true, "values": [] }),
            json!({ "cellId": A, "promptId": "p", "cancel": true }),
        ] {
            assert!(parse_answer(&bad).is_none(), "{bad}");
        }
    }
}
