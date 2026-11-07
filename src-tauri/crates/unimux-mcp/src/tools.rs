//! The seam between the HTTP server (M1) and the tool layer (M2: mcpTools, M3: automation). The server owns the wire, the
//! tokens, sessions, tasks and cancellation; a [`ToolHost`] answers what the agent of a cell may see and runs the calls.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub use crate::elicit::ElicitAnswer;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Asks the user through the client on the stream of the calling tool call (message, requested schema). A failure, a
/// timeout (120 s) or an abort counts as `cancel`.
pub type Elicit = Arc<dyn Fn(String, Value) -> BoxFuture<'static, ElicitAnswer> + Send + Sync>;
/// Sends a `notifications/progress` for the call (progress, total, message).
pub type Progress = Arc<dyn Fn(f64, f64, String) + Send + Sync>;

/// What a running tool call gets from the server (1.1.4 McpToolContext minus the service, which the host owns).
pub struct CallCtx {
    /// The cell the token belongs to (the actor).
    pub cell: String,
    /// Cancelled when the call must end: the client went away or sent notifications/cancelled, the task was cancelled or
    /// expired, the session closed, the token was revoked, the server stopped.
    pub cancel: CancellationToken,
    /// Present only in a session whose client declared form elicitation.
    pub elicit: Option<Elicit>,
    /// Present only when the client asked for progress (`_meta.progressToken`) and the answer is a stream.
    pub progress: Option<Progress>,
    /// How often a waiting call sends progress (10 s; tests shorten it).
    pub progress_every: Duration,
    /// The call runs as an MCP task (no elicitation, no progress).
    pub task: bool,
}

/// A failed call.
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// The name is not a tool (callTool returned null): -32602 `MCP error -32602: Unknown tool: <name>`.
    Unknown,
    /// A tool error (describeError of the thrown error): `{isError: true, content: [{type: text, text}]}`.
    Tool(String),
    /// The call was aborted (its signal fired): reported as the AbortError's message.
    Aborted,
}

impl CallError {
    /// The text of the error result (`describeError`).
    pub fn text(&self, name: &str) -> String {
        match self {
            CallError::Unknown => format!("Unknown tool: {name}"),
            CallError::Tool(text) => text.clone(),
            CallError::Aborted => ABORTED.to_string(),
        }
    }
}

/// The message of the AbortError a fired AbortSignal throws.
pub const ABORTED: &str = "This operation was aborted";

/// The answer to a call whose token was revoked (or re-issued) before or while it ran.
pub const EXPIRED: &str = "Agent connection has expired.";

/// A tool error result: `{isError: true, content: [{type: 'text', text}]}`.
pub fn error_content(text: &str) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": text }] })
}

/// The tool layer. Implemented by M2 on top of the automation service; tests and the SP8 example use a fake.
pub trait ToolHost: Send + Sync + 'static {
    /// The `instructions` of the initialize answer for the cell (mcpInstructions of its role, name, project, delegation).
    fn instructions(&self, cell: &str) -> String;
    /// The verbatim tool list of the cell's current role (toolsForRole).
    fn tools(&self, cell: &str) -> Vec<Value>;
    /// The tool may run as an MCP task (`execution.taskSupport: optional`).
    fn supports_task(&self, name: &str) -> bool;
    /// Runs a tool. The value is sent as `JSON.stringify(value)` text, capped by [`cap_result`].
    fn call(self: Arc<Self>, name: String, args: Option<Value>, ctx: CallCtx) -> BoxFuture<'static, Result<Value, CallError>>;
}

/// A host without tools: the server before the tool layer exists (wave 1 app builds) and in unit tests.
pub struct NoTools;

impl ToolHost for NoTools {
    fn instructions(&self, _cell: &str) -> String {
        String::new()
    }
    fn tools(&self, _cell: &str) -> Vec<Value> {
        Vec::new()
    }
    fn supports_task(&self, _name: &str) -> bool {
        false
    }
    fn call(self: Arc<Self>, _name: String, _args: Option<Value>, _ctx: CallCtx) -> BoxFuture<'static, Result<Value, CallError>> {
        Box::pin(async { Err(CallError::Unknown) })
    }
}

/// Safety net for a single tool result (mcp.ts MAX_RESULT_CHARS).
pub const MAX_RESULT_CHARS: usize = 60_000;

/// 1.1.4 capResult: a result over the cap (UTF-16 units) stays valid JSON: the beginning travels as a string, with a hint
/// to narrow the request. `text.slice(0, room)` can end in half a surrogate pair, which JSON.stringify writes as `\udXXX`.
pub fn cap_result(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_string();
    }
    let hint = "narrow the request (filters, limit/offset paging, verbose:false)";
    let mut room = max as i64 - 200;
    while room > 0 {
        let out = envelope(hint, &units[..room as usize]);
        if out.encode_utf16().count() <= max {
            return out;
        }
        room = (room as f64 * 0.8).floor() as i64;
    }
    unimux_core::js_json::stringify(&json!({ "truncated": true, "hint": hint }))
}

/// `JSON.stringify({ truncated: true, hint, partial })` for a prefix of valid UTF-16 (only its last unit can be a lone
/// high surrogate).
fn envelope(hint: &str, partial: &[u16]) -> String {
    let (whole, lone) = match partial.last() {
        Some(&u) if (0xD800..=0xDBFF).contains(&u) => (&partial[..partial.len() - 1], Some(u)),
        _ => (partial, None),
    };
    let mut quoted = String::new();
    unimux_core::js_json::write_string(&mut quoted, &String::from_utf16_lossy(whole));
    if let Some(u) = lone {
        quoted.pop();
        quoted.push_str(&format!("\\u{u:04x}\""));
    }
    let mut hint_quoted = String::new();
    unimux_core::js_json::write_string(&mut hint_quoted, hint);
    format!("{{\"truncated\":true,\"hint\":{hint_quoted},\"partial\":{quoted}}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_result_keeps_valid_json_under_the_cap() {
        // test/mcp.test.ts 'cuts an oversized result into valid JSON with a hint'.
        let items: Vec<Value> =
            (0..5000).map(|i| json!({ "i": i, "text": format!("\"quoted\" \\ {}", "x".repeat(20)) })).collect();
        let text = unimux_core::js_json::stringify(&json!({ "items": items }));
        let cut = cap_result(&text, 60_000);
        assert!(cut.encode_utf16().count() <= 60_000);
        let parsed: Value = serde_json::from_str(&cut).unwrap();
        assert_eq!(parsed["truncated"], true);
        assert!(text.starts_with(parsed["partial"].as_str().unwrap()));
        assert_eq!(cap_result("{\"a\":1}", 60_000), "{\"a\":1}");
    }

    #[test]
    fn cap_result_writes_a_cut_surrogate_pair_like_json_stringify() {
        // 300 units of 'a', then emojis: the cut at room = 300 - 200 = 100 ... lands inside a pair when shifted by one.
        let text = format!("a{}", "\u{1F600}".repeat(200));
        let cut = cap_result(&text, 301);
        // room 101 = 'a' + 50 pairs: whole; JSON escaping does not grow emojis, so it fits.
        assert!(cut.ends_with("\"}"), "{cut}");
        let text = "\u{1F600}".repeat(200);
        let cut = cap_result(&text, 301);
        // room 101 = 50 pairs + one high surrogate.
        assert!(cut.ends_with("\\ud83d\"}"), "{cut}");
        assert!(cut.encode_utf16().count() <= 301);
    }
}
