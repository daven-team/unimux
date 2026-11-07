//! A fake tool layer for the server tests and the wire driver (examples/mcp_wire_server.rs). It serves the real 1.1.4 tool
//! lists and instructions (dumped from `toolsForRole` / `mcpInstructions` into tests/fixtures/mcp-tools.json) and
//! implements just enough behaviour for the wire checks: get_context, list_agents, update_task (always an error),
//! close_grid (asks the user through an elicitation when the grid has an open task), wait_for (progress, tasks,
//! cancellation). M2 ports the real tools.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_mcp::tools::BoxFuture;
use unimux_mcp::{CallCtx, CallError, ToolHost};

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// What the server asked the tool layer, for the tests and the driver script (ms since the Unix epoch).
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

struct EndGuard {
    fake: Arc<Fake>,
    tool: String,
    outcome: Option<&'static str>,
}

impl Drop for EndGuard {
    fn drop(&mut self) {
        let (outcome, how) = match self.outcome {
            Some(o) => (o, "returned"),
            None => ("aborted", "dropped"),
        };
        self.fake.events.push(json!({ "kind": "call-end", "tool": self.tool, "outcome": outcome, "how": how }));
    }
}

pub struct Fake {
    tools: Vec<Value>,
    worker_tools: Vec<Value>,
    pub instructions: String,
    pub events: EventLog,
    open_grids: Mutex<HashSet<String>>,
    /// Cells whose MCP role was taken away (toolsForRole(undefined) is empty).
    pub no_role: Mutex<HashSet<String>>,
}

impl Fake {
    pub fn new(fixture: &Value) -> Arc<Self> {
        let tools = fixture["tools"].as_array().cloned().unwrap_or_default();
        let worker_tools = fixture["workerTools"].as_array().cloned().unwrap_or_default();
        let instructions = fixture["instructions"].as_str().unwrap_or_default().to_string();
        let open_grids =
            Mutex::new(["grid-side", "grid-side2", "grid-side3", "grid-side4"].map(String::from).into_iter().collect());
        Arc::new(Self { tools, worker_tools, instructions, events: EventLog::default(), open_grids, no_role: Mutex::default() })
    }

    /// The fixture of the protocol tests and the wire driver: the real 1.1.4 lists.
    pub fn from_fixture_file() -> Arc<Self> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mcp-tools.json");
        let text = std::fs::read_to_string(path).expect("tests/fixtures/mcp-tools.json");
        Self::new(&serde_json::from_str(&text).expect("fixture json"))
    }

    pub fn role_of(cell: &str) -> &'static str {
        if cell == "cell-lead" { "coordinator" } else { "worker" }
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
            "panic" => panic!("tool exploded"),
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

    /// Ends with `{event: timeout}`, or (like 1.1.4's wait_for) with `{event: cancelled}` when its call is cancelled, so the
    /// server decides what the client sees (an expired token, no answer for a client cancel).
    async fn wait_for(&self, args: &Value, ctx: &CallCtx) -> Result<Value, CallError> {
        let total = args["timeoutSec"].as_f64().unwrap_or(60.0);
        let started = tokio::time::Instant::now();
        let deadline = started + Duration::from_secs_f64(total.max(0.0));
        let mut tick = tokio::time::interval_at(started + ctx.progress_every, ctx.progress_every);
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => return Ok(json!({ "event": "timeout" })),
                () = ctx.cancel.cancelled() => return Ok(json!({ "event": "cancelled" })),
                _ = tick.tick() => {
                    if let Some(progress) = &ctx.progress {
                        progress(started.elapsed().as_secs_f64().round(), total, "waiting".into());
                    }
                }
            }
        }
    }
}

impl ToolHost for Fake {
    fn instructions(&self, _cell: &str) -> String {
        self.instructions.clone()
    }

    fn tools(&self, cell: &str) -> Vec<Value> {
        if self.no_role.lock().contains(cell) {
            Vec::new()
        } else if Self::role_of(cell) == "coordinator" {
            self.tools.clone()
        } else {
            self.worker_tools.clone()
        }
    }

    fn supports_task(&self, name: &str) -> bool {
        name == "wait_for"
    }

    fn call(self: Arc<Self>, name: String, args: Option<Value>, ctx: CallCtx) -> BoxFuture<'static, Result<Value, CallError>> {
        Box::pin(async move {
            self.events.push(json!({ "kind": "call-start", "tool": name, "cell": ctx.cell, "task": ctx.task }));
            if self.no_role.lock().contains(&ctx.cell) {
                return Err(CallError::Tool("MCP is off for this agent.".into()));
            }
            // A call whose future is dropped (its request went away) counts as aborted, and says how: "dropped".
            let mut end = EndGuard { fake: self.clone(), tool: name.clone(), outcome: None };
            let args = args.unwrap_or_else(|| json!({}));
            let result = self.run(&name, &args, &ctx).await;
            // As the TS driver records it: a call whose signal fired is "aborted".
            end.outcome = Some(match &result {
                _ if ctx.cancel.is_cancelled() => "aborted",
                Ok(_) => "ok",
                Err(CallError::Aborted) => "aborted",
                Err(CallError::Tool(_)) => "error",
                Err(CallError::Unknown) => "unknown",
            });
            result
        })
    }
}
