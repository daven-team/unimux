//! H6: one prompt to several agent cells at once (`agents:prompt`, `agents:prompt:done`, the `agents:prompt:run` event; port of
//! src/main/agentPrompt.ts) and the native Codex delivery (`codex queue`, port of the delivery half of index.ts `deliver`).
//!
//! A window asks; the cells are split by the window that holds their terminal (a detached grid's window, else the main window);
//! each window gets its part and answers within 5 s, or its cells count as `unreachable`. Only the window that was asked may
//! answer, and only for the cells it was asked about.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use unimux_agents::cli::status::{CliId, CliState, Os, clean_env};
use unimux_agents::cli::system::process_env;
use unimux_agents::cli::{CLI_WAIT_MS, GetOptions};
use unimux_agents::delivery::{CodexLaunch, DELIVERY_FAILED, queue_codex_message, reaches_codex_without_cmd, run_call};
use unimux_agents::hooks::route::{cell_cli, find_cell};
use unimux_agents::prompt::{AGENT_PROMPT_TIMEOUT_MS, PromptItem, PromptRequest, clean_answer, clean_request};
use unimux_ipc::{RouterBuilder, Scope};

use crate::context::AppContext;

struct Pending {
    /// The label of the window that was asked.
    window: String,
    asked: Vec<String>,
    reply: oneshot::Sender<Map<String, Value>>,
}

type PendingMap = Arc<Mutex<HashMap<String, Pending>>>;

/// Sends a window its cells and waits for its answer (at most 5 s; a window that is gone answers nothing).
async fn ask(
    ctx: &AppContext,
    pending: &PendingMap,
    window: &str,
    req: &PromptRequest,
    items: &[PromptItem],
) -> Map<String, Value> {
    if !ctx.events.app_windows().iter().any(|w| w == window) {
        return Map::new();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    pending.lock().insert(
        id.clone(),
        Pending { window: window.to_string(), asked: items.iter().map(|i| i.cell_id.clone()).collect(), reply: tx },
    );
    ctx.events.emit(Scope::Window(window.to_string()), "agents:prompt:run", vec![json!(id), req.part_json(items)]);
    let answer = tokio::time::timeout(Duration::from_millis(AGENT_PROMPT_TIMEOUT_MS), rx).await;
    pending.lock().remove(&id);
    match answer {
        Ok(Ok(map)) => map,
        _ => Map::new(),
    }
}

/// `agents:prompt`: the outcome of every requested cell.
async fn run(ctx: &AppContext, pending: &PendingMap, raw: &Value) -> Value {
    let Some(req) = clean_request(raw) else { return json!({}) };
    // Groups by window, in the order of their first cell (a JS Map).
    let mut groups: Vec<(String, Vec<PromptItem>)> = Vec::new();
    for item in &req.items {
        let window = ctx.detached.cell_window(&item.cell_id);
        match groups.iter_mut().find(|(w, _)| *w == window) {
            Some((_, list)) => list.push(item.clone()),
            None => groups.push((window, vec![item.clone()])),
        }
    }
    let answers = futures::future::join_all(groups.iter().map(|(w, items)| ask(ctx, pending, w, &req, items))).await;
    let mut out = Map::new();
    for answer in answers {
        for (k, v) in answer {
            out.insert(k, v);
        }
    }
    for item in &req.items {
        if !out.contains_key(&item.cell_id) {
            out.insert(item.cell_id.clone(), req.unreachable());
        }
    }
    Value::Object(out)
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

    let (weak, p) = (Arc::downgrade(ctx), pending.clone());
    r.invoke("agents:prompt", move |call| {
        let (weak, p) = (weak.clone(), p.clone());
        async move {
            let Some(ctx) = weak.upgrade() else { return Ok(json!({})) };
            Ok(run(&ctx, &p, call.arg(0)).await)
        }
    });

    // Only the window that was asked may answer, and only for the cells it was asked about.
    let p = pending;
    r.send("agents:prompt:done", move |call| {
        let p = p.clone();
        async move {
            let Some(id) = call.arg(0).as_str() else { return };
            let mut map = p.lock();
            if map.get(id).is_none_or(|e| e.window != call.caller.label) {
                return;
            }
            if let Some(entry) = map.remove(id) {
                drop(map);
                let _ = entry.reply.send(clean_answer(call.arg(1), &entry.asked));
            }
        }
    });
}

/// `queueCodexMessage` with the detected Codex: the binary from where it was detected and a PATH that has its folder. On
/// Windows a Codex reached neither as codex.exe nor as node.exe + the npm package's codex.js is not called at all (a bare
/// `codex` lookup can hit codex.cmd, where cmd.exe would parse the message): the delivery fails and the prompt queue takes
/// the notice.
pub async fn queue_codex(ctx: &Arc<AppContext>, session_id: &str, text: &str) -> Result<(), &'static str> {
    let detector = super::cli_detector(ctx);
    let codex = detector.get(CliId::Codex, GetOptions { wait_ms: CLI_WAIT_MS, force: false }).await;
    let env = detector.apply_env(clean_env(&process_env()), Some(CliId::Codex)).await;
    let launch = CodexLaunch { command: if codex.state == CliState::Found { codex.path } else { None }, env, os: Os::current() };
    if !reaches_codex_without_cmd(&launch, |p| std::path::Path::new(p).is_file()) {
        return Err(DELIVERY_FAILED);
    }
    queue_codex_message(session_id, text, &launch, run_call).await
}

/// The native half of index.ts `deliver(cellId, text)`: a Codex session the user chose (verified) takes the notice through
/// `codex queue`. None when the cell does not qualify (not a Codex cell, no verified session, or another session now); M4 then
/// uses the prompt queue, as it does after a failed delivery (`Some(Err)`).
pub async fn deliver_native(ctx: &Arc<AppContext>, cell_id: &str, text: &str) -> Option<Result<(), &'static str>> {
    let session = crate::commands::pty::host().verified_codex(cell_id)?;
    {
        let snapshot = ctx.state.snapshot();
        let cell = find_cell(&snapshot.state, cell_id)?;
        let current = cell.get("session").and_then(|s| s.get("id")).and_then(Value::as_str);
        if cell_cli(&snapshot.state, cell) != Some("codex") || current != Some(session.as_str()) {
            return None;
        }
    }
    Some(queue_codex(ctx, &session, text).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};
    use unimux_ipc::router::Status;
    use unimux_ipc::{Call, Caller, Contract, Guard, Reply};

    struct Open;
    impl Guard for Open {
        fn allowed(&self, _: &Caller) -> bool {
            true
        }
    }

    /// No window is open in a unit test: every cell is unreachable at once (a window that is gone never holds the request), and
    /// a stray answer is ignored.
    #[test]
    fn cells_of_a_window_that_is_gone_are_unreachable() {
        let _one = crate::commands::REGISTER_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        let ctx = AppContext::new(
            dir.path().to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir.path())),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.path().join("startup.log"), "")),
            json!({"version": 1, "projects": []}),
        );
        let mut builder = RouterBuilder::new(Contract::embedded());
        register(&mut builder, &ctx);
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        let router = builder.build(Arc::new(Open));
        assert_eq!(router.status("agents:prompt"), Status::Implemented);
        assert_eq!(router.status("agents:prompt:done"), Status::Implemented);
        let ask = |args: Vec<Value>| match tauri::async_runtime::block_on(router.invoke(Call::new(
            "agents:prompt",
            Caller::new("main", "http://tauri.localhost/"),
            args,
        ))) {
            Ok(Reply::Json(v)) => v,
            _ => panic!("no JSON answer"),
        };
        assert_eq!(ask(vec![json!("junk")]), json!({}));
        let send = json!({ "mode": "send", "items": [{ "cellId": "a", "text": "hi" }, { "cellId": "b", "text": "yo" }] });
        assert_eq!(
            ask(vec![send]),
            json!({ "a": { "state": "unreachable", "result": "skipped" }, "b": { "state": "unreachable", "result": "skipped" } })
        );
        let probe = json!({ "mode": "probe", "items": [{ "cellId": "a", "text": "" }] });
        assert_eq!(ask(vec![probe]), json!({ "a": { "state": "unreachable" } }));
        ctx.saver.stop();
    }
}
