//! What a hook payload means (ports of src/main/hooks.ts and src/shared/codexHooks.ts `parseCodexNotify`): the status
//! event and its details, the conversation of a SessionStart, the transcript a payload names, the StopFailure code, and the
//! opt-in diagnostics lines. Everything works on the JSON text with JavaScript semantics: `JSON.parse` (an escaped lone
//! surrogate reads as U+FFFD, see unimux_core::js_json), lengths and slices in UTF-16 code units, JS `trim` / `toLowerCase`,
//! and object key order as JSON.parse gives it.
//!
//! The `info` objects are built in the key order of the TS object literals, so the renderer gets the same objects.

use serde_json::{Map, Value, json};

use unimux_core::js_json;
use unimux_core::time::iso_from_ms;

/// Notification types that do not mean "the agent needs you now"; idle_prompt is its own (quiet) event.
const IGNORED_NOTIFICATIONS: [&str; 6] = [
    "auth_success",
    "elicitation_complete",
    "elicitation_response",
    "agent_completed",
    "plugin_notification",
    "quota_auto_resume_disabled",
];

/// Notification types that are a question for the user, and what kind of question.
fn attention_need(kind: &str) -> Option<&'static str> {
    match kind {
        "permission_prompt" => Some("permission"),
        "elicitation_dialog" | "elicitation_url_dialog" => Some("elicitation"),
        "agent_needs_input" | "quota_auto_resume_stale" => Some("input"),
        _ => None,
    }
}

const MAX_STATUS_STRINGS: usize = 8;
const FINISHED_TASK: [&str; 12] = [
    "completed",
    "complete",
    "done",
    "finished",
    "failed",
    "error",
    "killed",
    "stopped",
    "cancelled",
    "canceled",
    "exited",
    "timeout",
];
/// Documented StopFailure error codes.
const FAILURE_CODES: [&str; 12] = [
    "rate_limit",
    "overloaded",
    "authentication_failed",
    "oauth_org_not_allowed",
    "account_on_hold",
    "billing_error",
    "invalid_request",
    "model_not_found",
    "server_error",
    "max_output_tokens",
    "cloud_credential_error",
    "unknown",
];
const SESSION_SOURCES: [&str; 5] = ["startup", "resume", "clear", "compact", "fork"];
/// Tools that always open a question for the user before they run.
const QUESTION_TOOLS: [&str; 1] = ["AskUserQuestion"];

// ---------------------------------------------------------------------------------------------------------------------
// JavaScript string helpers

/// `\s` of a JavaScript regular expression (WhiteSpace + LineTerminator), also what `String.prototype.trim` removes.
pub(crate) fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// `s.length` (UTF-16 code units).
pub(crate) fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` written out as UTF-8 (a pair cut in half leaves a lone surrogate, which a UTF-8 write turns into U+FFFD).
fn js_slice_lossy(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n {
            if used < n {
                out.push('\u{fffd}');
            }
            break;
        }
        out.push(c);
        used += w;
    }
    out
}

/// `[\w]` of a JavaScript regular expression (ASCII only without the `u` flag).
fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `/^[\w-]{1,64}$/`: a cell id.
pub fn is_cell_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.chars().all(|c| word(c) || c == '-')
}

/// `/^[\w.:@/-]{1,80}$/`: a tool or agent type name.
fn is_tool_name(s: &str) -> bool {
    (1..=80).contains(&s.len()) && s.chars().all(|c| word(c) || matches!(c, '.' | ':' | '@' | '/' | '-'))
}

/// `/^[\w-]{1,100}$/`: a tool_use_id.
fn is_tool_use_id(s: &str) -> bool {
    (1..=100).contains(&s.len()) && s.chars().all(|c| word(c) || c == '-')
}

/// `/^[\w.:-]{1,128}$/`: a Codex turn id.
fn is_turn_id(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.chars().all(|c| word(c) || matches!(c, '.' | ':' | '-'))
}

/// SESSION_ID of src/shared/sessionTrack.ts: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
pub fn is_session_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// `JSON.parse(body)` with JavaScript's answers where serde_json differs: a lone surrogate escape is U+FFFD (js_json); a
/// number beyond f64 (`1e400`, Infinity in JS) and nesting deeper than serde_json's 128 levels (V8 parses without a limit)
/// are accepted. The hook helpers never read a number's value nor anything below the third level, so such a number reads
/// as 0 and a container below level 64 as null.
pub fn js_parse(body: &str) -> Option<Value> {
    match js_json::parse(body) {
        Ok(v) => Some(v),
        Err(_) => js_json::parse(&super::jsontext::simplified(body, 64)?).ok(),
    }
}

/// `JSON.parse(body)` when it gives a plain object (`parseObject` of hooks.ts).
pub fn parse_object(body: &str) -> Option<Map<String, Value>> {
    match js_parse(body) {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn str_field<'a>(o: &'a Value, key: &str) -> Option<&'a str> {
    o.as_object().and_then(|m| m.get(key)).and_then(Value::as_str)
}

/// `p[key] !== undefined && p[key] !== null`.
fn present(p: &Map<String, Value>, key: &str) -> bool {
    p.get(key).is_some_and(|v| !v.is_null())
}

// ---------------------------------------------------------------------------------------------------------------------
// Stop

/// Long-lived plumbing (a dev server started with run_in_background...) never means "the agent is still working":
/// `/shell|bash|command|monitor|process|server/i` (ASCII case-insensitive: no non-ASCII character folds onto these letters
/// in a non-unicode JS regex).
fn plumbing(kind: &str) -> bool {
    let lower = kind.to_ascii_lowercase();
    ["shell", "bash", "command", "monitor", "process", "server"].iter().any(|w| lower.contains(w))
}

fn is_running(t: &Value) -> bool {
    match str_field(t, "status") {
        Some(status) => !FINISHED_TASK.contains(&js_trim(status).to_lowercase().as_str()),
        None => true,
    }
}

/// A running task holds the cell "working" unless its type says shell-like plumbing; unknown or missing types hold.
fn holds_cell(t: &Value) -> bool {
    is_running(t) && str_field(t, "type").is_none_or(|kind| !plumbing(kind))
}

/// Task types that keep a session busy for a long time (`/workflow/i`).
fn is_workflow(t: &Value) -> bool {
    is_running(t) && str_field(t, "type").is_some_and(|kind| kind.to_ascii_lowercase().contains("workflow"))
}

/// True when a Stop payload lists a running background task of agent-like (or unknown) type.
pub fn has_active_background_work(p: Option<&Map<String, Value>>) -> bool {
    match p.and_then(|p| p.get("background_tasks")) {
        Some(Value::Array(tasks)) => tasks.iter().any(holds_cell),
        _ => false,
    }
}

/// Diagnostics for a Stop payload: task counts and the distinct status strings (never ids, names, commands or text).
pub fn stop_info(p: Option<&Map<String, Value>>) -> Value {
    let continuation = p.and_then(|p| p.get("stop_hook_active")) == Some(&Value::Bool(true));
    let Some(Value::Array(tasks)) = p.and_then(|p| p.get("background_tasks")) else {
        return json!({ "tasks": 0, "active": 0, "statuses": [], "types": [], "continuation": continuation, "workflows": 0, "tasksUnknown": true });
    };
    // trim, toLowerCase, keep [\w.-], 24 characters (all ASCII by then), or "?".
    let clean = |v: Option<&str>| -> String {
        let Some(s) = v else { return "?".into() };
        let kept: String = js_trim(s).to_lowercase().chars().filter(|c| word(*c) || matches!(c, '.' | '-')).take(24).collect();
        if kept.is_empty() { "?".into() } else { kept }
    };
    let mut statuses: Vec<String> = Vec::new();
    let mut types: Vec<String> = Vec::new();
    for t in tasks {
        let s = clean(str_field(t, "status"));
        if !statuses.contains(&s) {
            statuses.push(s);
        }
        let k = clean(str_field(t, "type"));
        if !types.contains(&k) {
            types.push(k);
        }
    }
    statuses.truncate(MAX_STATUS_STRINGS);
    types.truncate(MAX_STATUS_STRINGS);
    json!({
        "tasks": tasks.len(),
        "active": tasks.iter().filter(|t| holds_cell(t)).count(),
        "statuses": statuses,
        "types": types,
        "continuation": continuation,
        "workflows": tasks.iter().filter(|t| is_workflow(t)).count(),
    })
}

/// The StopFailure error code; anything not on the documented list (or malformed) is reported as "unknown".
pub fn parse_failure(body: &str) -> &'static str {
    let parsed = parse_object(body);
    let error = parsed.as_ref().and_then(|p| p.get("error")).and_then(Value::as_str);
    error.and_then(|e| FAILURE_CODES.iter().find(|c| **c == e).copied()).unwrap_or("unknown")
}

// ---------------------------------------------------------------------------------------------------------------------
// Diagnostics lines (MC_HOOK_DEBUG)

fn keys_of(p: &Map<String, Value>) -> String {
    p.keys().map(String::as_str).collect::<Vec<_>>().join(",")
}

/// Diagnostics line for a Stop payload: key names plus each task's type and status only, never any text.
pub fn stop_debug_line(cell_id: &str, body: &str, now_ms: i64) -> String {
    let now = iso_from_ms(now_ms);
    let Some(p) = parse_object(body) else { return format!("{now} {cell_id} unparsable\n") };
    let tasks = match p.get("background_tasks") {
        Some(Value::Array(list)) => {
            let items: Vec<String> = list
                .iter()
                .map(|t| {
                    let named = if str_field(t, "name").is_some_and(|n| !n.is_empty()) { "/named" } else { "" };
                    let kind = str_field(t, "type").map_or_else(|| "?".to_string(), |s| js_slice_lossy(s, 40));
                    let status = str_field(t, "status").map_or_else(|| "?".to_string(), |s| js_slice_lossy(s, 40));
                    format!("{kind}/{status}{named}")
                })
                .collect();
            format!("[{}]", items.join(" "))
        }
        _ => "?".to_string(),
    };
    let active = p.get("stop_hook_active") == Some(&Value::Bool(true));
    format!("{now} {cell_id} keys={} tasks={tasks} stop_hook_active={active}\n", keys_of(&p))
}

/// The two other diagnostics kinds (`hookDebugLine`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugKind {
    Fail,
    Session,
}

/// Diagnostics line for StopFailure / SessionStart: the error code or the source, plus the payload's key names only.
pub fn hook_debug_line(kind: DebugKind, cell_id: &str, body: &str, now_ms: i64) -> String {
    let now = iso_from_ms(now_ms);
    let name = match kind {
        DebugKind::Fail => "fail",
        DebugKind::Session => "session",
    };
    let Some(p) = parse_object(body) else { return format!("{now} {cell_id} {name} unparsable\n") };
    let detail = match kind {
        DebugKind::Fail => format!("error={}", parse_failure(body)),
        DebugKind::Session => {
            let source = p.get("source").and_then(Value::as_str).filter(|s| SESSION_SOURCES.contains(s)).unwrap_or("?");
            format!("source={source}")
        }
    };
    format!("{now} {cell_id} {name} {detail} keys={}\n", keys_of(&p))
}

// ---------------------------------------------------------------------------------------------------------------------
// Transcript, SessionStart, Notification

/// The transcript a Claude hook payload names (`transcript_path` with its `session_id`); only the main conversation's (a
/// subagent's payload carries agent_id), and the path must be a `<session id>.jsonl` file of at most 1,024 UTF-16 units.
pub fn transcript_of(p: Option<&Map<String, Value>>) -> Option<(String, String)> {
    let p = p?;
    if present(p, "agent_id") {
        return None;
    }
    let session_id = p.get("session_id")?.as_str()?;
    let path = p.get("transcript_path")?.as_str()?;
    if !is_session_id(session_id) || utf16_len(path) > 1024 {
        return None;
    }
    let suffix = format!("/{}.jsonl", session_id.to_lowercase());
    path.replace('\\', "/").to_lowercase().ends_with(&suffix).then(|| (session_id.to_string(), path.to_string()))
}

/// A SessionStart payload: the conversation id and the source (None for an unknown source).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStart {
    pub session_id: String,
    pub source: Option<String>,
}

/// Extracts the conversation id from a SessionStart payload; None for anything malformed.
pub fn parse_session_start(body: &str) -> Option<SessionStart> {
    let p = js_parse(body)?;
    let p = p.as_object()?;
    if present(p, "agent_id") {
        return None; // subagent / teammate context, not the cell's conversation
    }
    let session_id = p.get("session_id")?.as_str()?;
    if !is_session_id(session_id) {
        return None;
    }
    let source = p.get("source").and_then(Value::as_str).filter(|s| SESSION_SOURCES.contains(s)).map(str::to_string);
    Some(SessionStart { session_id: session_id.to_string(), source })
}

/// `JSON.parse(body).notification_type`: Err when that throws (not JSON, or `null`).
fn notification_type(body: &str) -> Result<Option<Value>, ()> {
    match js_parse(body) {
        Some(Value::Null) | None => Err(()),
        Some(Value::Object(m)) => Ok(m.get("notification_type").cloned()),
        Some(_) => Ok(None),
    }
}

/// True when a Notification hook payload is a real request for the user.
pub fn is_attention_notification(body: &str) -> bool {
    match notification_type(body) {
        Ok(Some(Value::String(t))) => !IGNORED_NOTIFICATIONS.contains(&t.as_str()),
        _ => true,
    }
}

/// A status event with its optional details (`{event, info}` of hooks.ts).
#[derive(Debug, Clone, PartialEq)]
pub struct Mapped {
    pub event: &'static str,
    pub info: Option<Value>,
}

impl Mapped {
    fn new(event: &'static str, info: Option<Value>) -> Self {
        Self { event, info }
    }
}

/// What a Notification hook means for the status (None: nothing). Unknown types stay a question for the user.
pub fn notification_event(body: &str) -> Option<Mapped> {
    let kind = match notification_type(body) {
        Err(()) => return Some(Mapped::new("notify", None)),
        Ok(Some(Value::String(t))) => t,
        Ok(_) => return Some(Mapped::new("notify", None)),
    };
    if IGNORED_NOTIFICATIONS.contains(&kind.as_str()) {
        return None;
    }
    if kind == "idle_prompt" {
        return Some(Mapped::new("idle", None));
    }
    if kind == "quota_auto_resume_fired" {
        return Some(Mapped::new("prompt", None));
    }
    let info = match attention_need(&kind) {
        Some(need) => json!({ "need": need }),
        None => json!({}),
    };
    Some(Mapped::new("notify", Some(info)))
}

// ---------------------------------------------------------------------------------------------------------------------
// Tool hooks (Claude Code 2.1.78+): only the head and the tail of the payload are kept, as UTF-16 code units

fn units_space(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(js_space)
}

/// `rawField`: a string field of the payload's top level read from raw text with
/// `/[{,]\s*"<key>"\s*:\s*"([^"\\]{1,100})"/g`, the first match or (`last`) the last one.
fn raw_field(text: &[u16], key: &str, last: bool) -> Option<Vec<u16>> {
    let quote = u16::from(b'"');
    let backslash = u16::from(b'\\');
    let key_units: Vec<u16> = format!("\"{key}\"").encode_utf16().collect();
    let skip_space = |mut i: usize| {
        while i < text.len() && units_space(text[i]) {
            i += 1;
        }
        i
    };
    let try_at = |start: usize| -> Option<(usize, std::ops::Range<usize>)> {
        let mut i = skip_space(start + 1);
        if !text[i..].starts_with(&key_units) {
            return None;
        }
        i = skip_space(i + key_units.len());
        if text.get(i) != Some(&u16::from(b':')) {
            return None;
        }
        i = skip_space(i + 1);
        if text.get(i) != Some(&quote) {
            return None;
        }
        let from = i + 1;
        let mut j = from;
        while j < text.len() && text[j] != quote && text[j] != backslash {
            j += 1;
        }
        let len = j - from;
        ((1..=100).contains(&len) && text.get(j) == Some(&quote)).then_some((j + 1, from..j))
    };
    let mut found = None;
    let mut pos = 0;
    while pos < text.len() {
        let u = text[pos];
        if (u == u16::from(b'{') || u == u16::from(b','))
            && let Some((end, range)) = try_at(pos)
        {
            found = Some(text[range].to_vec());
            if !last {
                break;
            }
            pos = end;
            continue;
        }
        pos += 1;
    }
    found
}

/// The facts of a tool hook payload (`ToolHookFacts`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolHookFacts {
    pub tool: Option<String>,
    pub tool_use_id: Option<String>,
    pub agent_type: Option<String>,
    pub in_subagent: bool,
    pub trigger: Option<&'static str>,
}

impl ToolHookFacts {
    /// The JSON shape of the TS object (absent keys left out).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        if let Some(t) = &self.tool {
            m.insert("tool".into(), json!(t));
        }
        if let Some(t) = &self.tool_use_id {
            m.insert("toolUseId".into(), json!(t));
        }
        if let Some(t) = &self.agent_type {
            m.insert("agentType".into(), json!(t));
        }
        if self.in_subagent {
            m.insert("inSubagent".into(), json!(true));
        }
        if let Some(t) = self.trigger {
            m.insert("trigger".into(), json!(t));
        }
        Value::Object(m)
    }
}

/// A field as a string (None for any other type), from the parsed whole payload or from the raw text.
enum Field {
    Str(String),
    Other,
}

/// `toolHookFacts(head, tail)` on UTF-16 code units (the server keeps the payload as JS would, a pair cut by the head limit
/// included). The whole payload is parsed only when nothing was cut off (no tail).
pub fn tool_hook_facts_units(head: &[u16], tail: &[u16]) -> ToolHookFacts {
    let whole = if tail.is_empty() { parse_object(&String::from_utf16_lossy(head)) } else { None };
    // rawField reads `${head}${tail}` only for `last`.
    let joined: Vec<u16> = if whole.is_none() { [head, tail].concat() } else { Vec::new() };
    let field = |key: &str, last: bool| -> Field {
        if let Some(w) = &whole {
            return match w.get(key) {
                Some(Value::String(s)) => Field::Str(s.clone()),
                _ => Field::Other,
            };
        }
        let text: &[u16] = if last { &joined } else { head };
        match raw_field(text, key, last) {
            Some(units) => Field::Str(String::from_utf16_lossy(&units)),
            None => Field::Other,
        }
    };
    let as_valid = |f: Field, ok: fn(&str) -> bool| match f {
        Field::Str(s) if ok(&s) => Some(s),
        _ => None,
    };
    ToolHookFacts {
        tool: as_valid(field("tool_name", false), is_tool_name),
        tool_use_id: as_valid(field("tool_use_id", true), is_tool_use_id),
        agent_type: as_valid(field("agent_type", false), is_tool_name),
        in_subagent: matches!(field("agent_id", false), Field::Str(s) if !s.is_empty()),
        trigger: match field("trigger", false) {
            Field::Str(s) if s == "manual" => Some("manual"),
            Field::Str(s) if s == "auto" => Some("auto"),
            _ => None,
        },
    }
}

/// [`tool_hook_facts_units`] for text.
pub fn tool_hook_facts(head: &str, tail: &str) -> ToolHookFacts {
    let h: Vec<u16> = head.encode_utf16().collect();
    let t: Vec<u16> = tail.encode_utf16().collect();
    tool_hook_facts_units(&h, &t)
}

/// The status event of one of the precise Claude hooks; None when it says nothing (an unknown event name).
pub fn tool_hook_event_units(event: &str, head: &[u16], tail: &[u16]) -> Option<Mapped> {
    let f = tool_hook_facts_units(head, tail);
    let mut info = Map::new();
    let put = |m: &mut Map<String, Value>, k: &str, v: Value| {
        m.insert(k.to_string(), v);
    };
    let tool_and_id = |m: &mut Map<String, Value>| {
        if let Some(t) = &f.tool {
            put(m, "tool", json!(t));
        }
        if let Some(id) = &f.tool_use_id {
            put(m, "toolUseId", json!(id));
        }
    };
    let trigger = |m: &mut Map<String, Value>| {
        if let Some(t) = f.trigger {
            put(m, "trigger", json!(t));
        }
    };
    let event = match event {
        "pre" => {
            if f.tool.as_deref().is_some_and(|t| QUESTION_TOOLS.contains(&t)) {
                put(&mut info, "need", json!("question"));
                put(&mut info, "immediate", json!(true));
                tool_and_id(&mut info);
                "notify"
            } else {
                tool_and_id(&mut info);
                "busy"
            }
        }
        "post" => {
            tool_and_id(&mut info);
            put(&mut info, "toolEnd", json!(true));
            "busy"
        }
        "permission" => {
            put(&mut info, "need", json!("permission"));
            put(&mut info, "immediate", json!(true));
            if let Some(t) = &f.tool {
                put(&mut info, "tool", json!(t));
            }
            "notify"
        }
        "subagentstart" => {
            put(&mut info, "subagent", json!(true));
            put(&mut info, "subagentStart", json!(true));
            if let Some(a) = &f.agent_type {
                put(&mut info, "agentType", json!(a));
            }
            "busy"
        }
        "compact" => {
            trigger(&mut info);
            "compact"
        }
        "compacted" => {
            trigger(&mut info);
            "compacted"
        }
        "elicit" => {
            put(&mut info, "need", json!("elicitation"));
            put(&mut info, "immediate", json!(true));
            "notify"
        }
        "elicited" => {
            put(&mut info, "answered", json!(true));
            "busy"
        }
        _ => return None,
    };
    Some(Mapped::new(event, Some(Value::Object(info))))
}

/// [`tool_hook_event_units`] for text.
pub fn tool_hook_event(event: &str, head: &str, tail: &str) -> Option<Mapped> {
    let h: Vec<u16> = head.encode_utf16().collect();
    let t: Vec<u16> = tail.encode_utf16().collect();
    tool_hook_event_units(event, &h, &t)
}

// ---------------------------------------------------------------------------------------------------------------------
// Codex notify

/// A Codex turn end (`CodexNotice`): the thread and the turn, when the payload carried ones we trust.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexNotice {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
}

impl CodexNotice {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        if let Some(t) = &self.thread_id {
            m.insert("threadId".into(), json!(t));
        }
        if let Some(t) = &self.turn_id {
            m.insert("turnId".into(), json!(t));
        }
        Value::Object(m)
    }
}

/// Whitelisting parser of the notify payload: a successful turn end, or None. Message texts and paths are never read.
pub fn parse_codex_notify(body: &str) -> Option<CodexNotice> {
    let p = parse_object(body)?;
    if p.get("type").and_then(Value::as_str) != Some("agent-turn-complete") {
        return None;
    }
    let thread_id = p.get("thread-id").and_then(Value::as_str).filter(|s| is_session_id(s)).map(|s| s.to_ascii_lowercase());
    let turn_id = p.get("turn-id").and_then(Value::as_str).filter(|s| is_turn_id(s)).map(str::to_string);
    Some(CodexNotice { thread_id, turn_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_field_takes_the_first_or_the_last_top_level_like_match() {
        let t: Vec<u16> = r#"{"tool_name":"Bash","x":{"tool_name":"Edit"} , "tool_name" : "Read"}"#.encode_utf16().collect();
        assert_eq!(raw_field(&t, "tool_name", false).map(|u| String::from_utf16_lossy(&u)).as_deref(), Some("Bash"));
        assert_eq!(raw_field(&t, "tool_name", true).map(|u| String::from_utf16_lossy(&u)).as_deref(), Some("Read"));
        let long: Vec<u16> = format!(r#"{{"tool_name":"{}"}}"#, "a".repeat(101)).encode_utf16().collect();
        assert_eq!(raw_field(&long, "tool_name", false), None);
        let escaped: Vec<u16> = r#"{"tool_name":"a\"b"}"#.encode_utf16().collect();
        assert_eq!(raw_field(&escaped, "tool_name", false), None);
    }

    #[test]
    fn session_ids_and_cell_ids() {
        assert!(is_session_id("3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091"));
        assert!(is_session_id("3F2B8C1E-0D4A-4B7E-9C11-2A5D6E7F8091"));
        assert!(!is_session_id("-f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091"));
        assert!(is_cell_id("abc_1-x"));
        assert!(!is_cell_id("a b"));
        assert!(!is_cell_id(&"a".repeat(65)));
    }

    #[test]
    fn slices_like_js_with_a_cut_pair_as_replacement() {
        assert_eq!(js_slice_lossy("ab\u{1F600}c", 3), "ab\u{fffd}");
        assert_eq!(js_slice_lossy("ab\u{1F600}c", 4), "ab\u{1F600}");
    }
}
