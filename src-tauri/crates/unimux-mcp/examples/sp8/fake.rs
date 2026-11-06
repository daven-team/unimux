//! SP8 spike: a fake tool layer shared by both server candidates. It serves the real 1.1.4 tool list and instructions
//! (dumped from `toolsForRole` / `mcpInstructions` by scripts/spike-mcp-wire.mjs) and implements just enough behaviour for
//! the wire checks: get_context, list_agents, update_task (always an error), close_grid (asks the user through an
//! elicitation when the grid has an open task), wait_for (progress, tasks, cancellation). M2 ports the real tools.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The answer of an elicitation; a failure or a timeout counts as `cancel` (as in 1.1.4).
#[derive(Debug, Clone)]
pub struct ElicitAnswer {
    pub action: String,
    pub content: Option<Value>,
}

/// Asks the user through the client on the stream of the calling tool call.
pub type Elicit = Arc<dyn Fn(String, Value) -> BoxFuture<'static, ElicitAnswer> + Send + Sync>;
/// Sends a `notifications/progress` for the call (progress, total, message).
pub type Progress = Arc<dyn Fn(f64, f64, String) + Send + Sync>;

pub struct CallCtx {
    pub cell: String,
    pub cancel: CancellationToken,
    pub elicit: Option<Elicit>,
    pub progress: Option<Progress>,
    pub progress_every: Duration,
    pub task: bool,
}

#[derive(Debug)]
pub enum CallError {
    /// `Unknown tool: <name>` (the 1.1.4 server answers -32602).
    Unknown,
    /// A tool error: becomes `{isError: true, content: [{type: text, text}]}`.
    Tool(String),
    /// The call was cancelled (client went away, task cancelled, token revoked).
    Aborted,
}

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// What the servers saw, for the driver script (ms since the Unix epoch, comparable with Date.now()).
#[derive(Default)]
pub struct EventLog {
    events: Mutex<Vec<Value>>,
}

impl EventLog {
    pub fn push(&self, mut event: Value) {
        if let Value::Object(map) = &mut event {
            map.insert("at".into(), json!(now_ms() as u64));
        }
        self.events.lock().push(event);
    }
    pub fn all(&self) -> Vec<Value> {
        self.events.lock().clone()
    }
}

struct EndGuard<'a> {
    log: &'a EventLog,
    tool: &'a str,
    outcome: Option<&'static str>,
}

impl Drop for EndGuard<'_> {
    fn drop(&mut self) {
        let (outcome, how) = match self.outcome {
            Some(o) => (o, "returned"),
            None => ("aborted", "dropped"),
        };
        self.log.push(json!({ "kind": "call-end", "tool": self.tool, "outcome": outcome, "how": how }));
    }
}

pub struct Fake {
    tools: Vec<Value>,
    worker_tools: Vec<Value>,
    pub instructions: String,
    pub events: EventLog,
    open_grids: Mutex<HashSet<String>>,
}

impl Fake {
    pub fn new(fixture: &Value) -> Self {
        let tools = fixture["tools"].as_array().cloned().unwrap_or_default();
        let worker_tools = fixture["workerTools"].as_array().cloned().unwrap_or_default();
        let instructions = fixture["instructions"].as_str().unwrap_or_default().to_string();
        let open_grids =
            Mutex::new(["grid-side".to_string(), "grid-side2".to_string(), "grid-side3".to_string()].into_iter().collect());
        Self { tools, worker_tools, instructions, events: EventLog::default(), open_grids }
    }

    pub fn role_of(cell: &str) -> &'static str {
        if cell == "cell-lead" { "coordinator" } else { "worker" }
    }

    /// The verbatim 1.1.4 tool list of the cell's role.
    pub fn tools_for(&self, cell: &str) -> Vec<Value> {
        if Self::role_of(cell) == "coordinator" { self.tools.clone() } else { self.worker_tools.clone() }
    }

    pub fn supports_task(name: &str) -> bool {
        name == "wait_for"
    }

    pub async fn call(&self, name: &str, args: &Value, ctx: CallCtx) -> Result<Value, CallError> {
        self.events.push(json!({ "kind": "call-start", "tool": name, "cell": ctx.cell, "task": ctx.task }));
        // A call whose future is dropped (its request went away) counts as aborted, and says how: "dropped".
        let mut end = EndGuard { log: &self.events, tool: name, outcome: None };
        let result = self.run(name, args, &ctx).await;
        end.outcome = Some(match &result {
            Ok(_) => "ok",
            Err(CallError::Aborted) => "aborted",
            Err(CallError::Tool(_)) => "error",
            Err(CallError::Unknown) => "unknown",
        });
        result
    }

    async fn run(&self, name: &str, args: &Value, ctx: &CallCtx) -> Result<Value, CallError> {
        match name {
            "get_context" => {
                Ok(json!({ "cellId": ctx.cell, "role": Self::role_of(&ctx.cell), "project": "Project", "paused": false }))
            }
            "list_agents" => Ok(json!({ "agents": [
                { "id": "cell-lead", "name": "Lead", "role": "coordinator", "status": "running" },
                { "id": "cell-worker", "name": "Backend", "role": "worker", "status": "running" },
            ] })),
            "update_task" => Err(CallError::Tool(format!("Unknown task: {}", args["taskId"].as_str().unwrap_or("")))),
            "close_grid" => self.close_grid(args, ctx).await,
            "wait_for" => self.wait_for(args, ctx).await,
            _ => Err(CallError::Unknown),
        }
    }

    async fn close_grid(&self, args: &Value, ctx: &CallCtx) -> Result<Value, CallError> {
        let grid = args["gridId"].as_str().unwrap_or_default().to_string();
        if !self.open_grids.lock().contains(&grid) {
            return Err(CallError::Tool(format!("Unknown grid: {grid}")));
        }
        if args["cancelTasks"] != json!(true) {
            let Some(elicit) = &ctx.elicit else {
                return Err(CallError::Tool("The grid has 1 unfinished tasks; pass cancelTasks:true to cancel them.".into()));
            };
            let schema = json!({ "type": "object", "required": ["confirm"], "properties": {
                "confirm": { "type": "boolean", "title": "Close the grid and cancel the tasks", "default": false } } });
            let message = "Lead wants to close the grid \"Side\" and cancel its unfinished tasks (1). Allow?".to_string();
            let answer = tokio::select! {
                a = elicit(message, schema) => a,
                () = ctx.cancel.cancelled() => return Err(CallError::Aborted),
            };
            self.events.push(json!({ "kind": "elicit", "action": answer.action, "content": answer.content }));
            let confirmed = answer.action == "accept" && answer.content.as_ref().is_some_and(|c| c["confirm"] == json!(true));
            if !confirmed {
                return Err(CallError::Tool(
                    "The user did not confirm closing the grid (1 unfinished tasks stay). Do not retry with cancelTasks:true unless the user asks.".into(),
                ));
            }
        }
        self.open_grids.lock().remove(&grid);
        Ok(json!({ "archived": grid, "stopped": 1 }))
    }

    async fn wait_for(&self, args: &Value, ctx: &CallCtx) -> Result<Value, CallError> {
        let total = args["timeoutSec"].as_f64().unwrap_or(60.0);
        let started = tokio::time::Instant::now();
        let deadline = started + Duration::from_secs_f64(total.max(0.0));
        let mut tick = tokio::time::interval_at(started + ctx.progress_every, ctx.progress_every);
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => return Ok(json!({ "event": "timeout" })),
                () = ctx.cancel.cancelled() => return Err(CallError::Aborted),
                _ = tick.tick() => {
                    if let Some(progress) = &ctx.progress {
                        progress(started.elapsed().as_secs_f64().round(), total, "waiting".into());
                    }
                }
            }
        }
    }
}

/// 1.1.4 capResult: a result over the cap stays valid JSON (the start travels as a string with a hint). UTF-16 units.
pub fn cap_result(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_string();
    }
    let hint = "narrow the request (filters, limit/offset paging, verbose:false)";
    let mut room = max.saturating_sub(200);
    while room > 0 {
        let partial = String::from_utf16_lossy(&units[..room]);
        let out = json!({ "truncated": true, "hint": hint, "partial": partial }).to_string();
        if out.encode_utf16().count() <= max {
            return out;
        }
        room = (room as f64 * 0.8).floor() as usize;
    }
    json!({ "truncated": true, "hint": hint }).to_string()
}
