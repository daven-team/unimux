//! H6: one prompt to several agent cells at once (1.1.1), the host half of src/shared/agentPrompt.ts: the request and answer
//! repairs `agents:prompt` uses. A window asks, main splits the cells by the window that holds their terminal, sends each window
//! its part (`agents:prompt:run`) and waits for the answers (`agents:prompt:done`); the window decides and sends.

use serde_json::{Map, Value, json};
use unimux_core::utf16;

/// At most this many cells in one request (a big workspace has a few dozen agents).
pub const AGENT_PROMPT_MAX_CELLS: usize = 200;
/// A window that did not answer within this time counts as unreachable for its cells.
pub const AGENT_PROMPT_TIMEOUT_MS: u64 = 5000;
/// `QUEUE_MAX_TEXT` of src/shared/promptQueue.ts (UTF-16 units).
pub const QUEUE_MAX_TEXT: usize = 20_000;

/// `TARGET_STATES`.
pub const TARGET_STATES: [&str; 11] =
    ["ready", "working", "permission", "question", "queued", "typing", "limit", "notStarted", "exited", "paste", "unreachable"];

/// One cell's prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptItem {
    pub cell_id: String,
    pub text: String,
}

impl PromptItem {
    pub fn to_json(&self) -> Value {
        json!({ "cellId": self.cell_id, "text": self.text })
    }
}

/// `AgentPromptRequest`: `probe` only reports each cell's state, `send` acts on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptRequest {
    pub send: bool,
    pub queue_busy: bool,
    pub items: Vec<PromptItem>,
}

impl PromptRequest {
    pub fn mode(&self) -> &'static str {
        if self.send { "send" } else { "probe" }
    }

    /// The `{mode, queueBusy, items}` a window gets for its cells.
    pub fn part_json(&self, items: &[PromptItem]) -> Value {
        json!({ "mode": self.mode(), "queueBusy": self.queue_busy, "items": items.iter().map(PromptItem::to_json).collect::<Vec<_>>() })
    }

    /// The outcome of a cell no window answered for.
    pub fn unreachable(&self) -> Value {
        if self.send { json!({ "state": "unreachable", "result": "skipped" }) } else { json!({ "state": "unreachable" }) }
    }
}

/// `cleanAgentPromptRequest`: known mode, valid ids each once, texts cut to the queue's limit; None when unusable.
pub fn clean_request(raw: &Value) -> Option<PromptRequest> {
    let raw = raw.as_object()?;
    let send = match raw.get("mode").and_then(Value::as_str) {
        Some("send") => true,
        Some("probe") => false,
        _ => return None,
    };
    let list = raw.get("items")?.as_array()?;
    let mut items: Vec<PromptItem> = Vec::new();
    for item in list {
        if items.len() >= AGENT_PROMPT_MAX_CELLS {
            break;
        }
        let Some(item) = item.as_object() else { continue };
        let Some(cell) = item.get("cellId").and_then(Value::as_str) else { continue };
        if cell.is_empty() || utf16::len(cell) > 128 || items.iter().any(|i| i.cell_id == cell) {
            continue;
        }
        let Some(text) = item.get("text").and_then(Value::as_str) else { continue };
        if send && utf16::js_trim(text).is_empty() {
            continue;
        }
        let text = if utf16::len(text) > QUEUE_MAX_TEXT { utf16::slice(text, 0, QUEUE_MAX_TEXT) } else { text.to_string() };
        items.push(PromptItem { cell_id: cell.to_string(), text });
    }
    Some(PromptRequest { send, queue_busy: raw.get("queueBusy") == Some(&Value::Bool(true)), items })
}

/// `cleanAgentPromptAnswer`: only the cells the window was asked about, known states and results.
pub fn clean_answer(raw: &Value, asked: &[String]) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(raw) = raw.as_object() else { return out };
    for id in asked {
        let Some(o) = raw.get(id).and_then(Value::as_object) else { continue };
        let Some(state) = o.get("state").and_then(Value::as_str).filter(|s| TARGET_STATES.contains(s)) else { continue };
        let result = o.get("result").and_then(Value::as_str).filter(|r| matches!(*r, "sent" | "queued" | "skipped"));
        out.insert(
            id.clone(),
            match result {
                Some(r) => json!({ "state": state, "result": r }),
                None => json!({ "state": state }),
            },
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// agent-prompt: repairs a request: known mode, ids once, texts cut, blank sends dropped.
    #[test]
    fn repairs_a_request() {
        for bad in [Value::Null, json!("x"), json!([]), json!({ "mode": "nope", "items": [] }), json!({ "mode": "send" })] {
            assert_eq!(clean_request(&bad), None, "{bad}");
        }
        let long = "x".repeat(QUEUE_MAX_TEXT + 50);
        let r = clean_request(&json!({
            "mode": "send",
            "queueBusy": true,
            "items": [
                { "cellId": "a", "text": "hi" },
                { "cellId": "a", "text": "again" },
                { "cellId": "", "text": "x" },
                { "cellId": "b", "text": "   " },
                { "cellId": "c", "text": long },
                { "cellId": "d" },
                { "cellId": "x".repeat(129), "text": "x" },
                "junk",
            ],
        }))
        .unwrap();
        assert!(r.send && r.queue_busy);
        assert_eq!(r.items.iter().map(|i| i.cell_id.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        assert_eq!(r.items[1].text.len(), QUEUE_MAX_TEXT);
        // A probe keeps blank texts; queueBusy only for a real true.
        let p =
            clean_request(&json!({ "mode": "probe", "queueBusy": "yes", "items": [{ "cellId": "b", "text": " " }] })).unwrap();
        assert!(!p.send && !p.queue_busy);
        assert_eq!(p.items.len(), 1);
        let many: Vec<Value> = (0..300).map(|i| json!({ "cellId": format!("c{i}"), "text": "t" })).collect();
        assert_eq!(clean_request(&json!({ "mode": "send", "items": many })).unwrap().items.len(), AGENT_PROMPT_MAX_CELLS);
    }

    /// agent-prompt: keeps only answers for the asked cells with known states.
    #[test]
    fn keeps_only_answers_for_the_asked_cells_with_known_states() {
        let asked = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let out = clean_answer(
            &json!({
                "a": { "state": "ready", "result": "sent" },
                "b": { "state": "bogus" },
                "c": { "state": "working", "result": "nope" },
                "z": { "state": "ready" },
            }),
            &asked,
        );
        assert_eq!(Value::Object(out), json!({ "a": { "state": "ready", "result": "sent" }, "c": { "state": "working" } }));
        assert!(clean_answer(&json!([1]), &asked).is_empty());
    }
}
