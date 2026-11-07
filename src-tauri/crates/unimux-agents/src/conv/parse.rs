//! Reading Claude Code and Codex transcripts (port of src/convsearch/parse.ts). A transcript is JSONL; most of its bytes are
//! tool calls, tool output, request blobs and reasoning, so every line is first checked on its raw bytes (memchr) and only
//! the few that can hold a user or assistant text (or a title, the cwd, the model) are decoded and parsed. Malformed lines
//! are skipped.

use std::io;

use memchr::memmem;
use serde_json::Value;

use super::date;
use super::text::trim;
use super::{ConvCli, ConvRole};

/// What a transcript says about itself.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConvMeta {
    pub id: Option<String>,
    pub cwd: String,
    pub first_ts: f64,
    pub last_ts: f64,
    pub model: Option<String>,
    /// A /rename title and a generated one (Claude), the latest of each kind.
    pub custom: Option<String>,
    pub ai: Option<String>,
    /// The first real prompt.
    pub prompt: Option<String>,
}

pub trait Sink {
    fn message(&mut self, role: ConvRole, text: &str, ts: f64);
    /// A tool call of the agent (Markdown export): its name and the raw input (Claude) or arguments (Codex).
    fn tool(&mut self, _name: &str, _input: Option<&Value>, _ts: f64) {}
    fn wants_tools(&self) -> bool {
        false
    }
}

fn has(line: &[u8], needle: &[u8]) -> bool {
    memmem::find(line, needle).is_some()
}

const C_USER: &[u8] = br#""type":"user""#;
const C_ASSISTANT: &[u8] = br#""type":"assistant""#;
const C_TOOL_RESULT: &[u8] = br#""type":"tool_result""#;
const C_TEXT: &[u8] = br#""type":"text""#;
const C_TITLE: &[u8] = br#"-title""#;
const C_TOOL_USE: &[u8] = br#""type":"tool_use""#;
const X_META: &[u8] = br#""type":"session_meta""#;
const X_TURN: &[u8] = br#""type":"turn_context""#;
const X_ITEM: &[u8] = br#""type":"response_item""#;
const X_MESSAGE: &[u8] = br#""type":"message""#;
const X_DEVELOPER: &[u8] = br#""role":"developer""#;
const X_SYSTEM: &[u8] = br#""role":"system""#;
const X_TOOL_CALLS: [&[u8]; 4] = [
    br#""type":"function_call""#,
    br#""type":"custom_tool_call""#,
    br#""type":"local_shell_call""#,
    br#""type":"web_search_call""#,
];

/// Can this raw Claude line hold something the index wants?
pub fn claude_wanted(line: &[u8]) -> bool {
    if line.len() < 20 {
        return false;
    }
    if has(line, C_ASSISTANT) {
        return has(line, C_TEXT);
    }
    if has(line, C_USER) {
        return !has(line, C_TOOL_RESULT);
    }
    has(line, C_TITLE)
}

pub fn codex_wanted(line: &[u8]) -> bool {
    if line.len() < 20 {
        return false;
    }
    if has(line, X_ITEM) {
        return has(line, X_MESSAGE) && !has(line, X_DEVELOPER) && !has(line, X_SYSTEM);
    }
    has(line, X_META) || has(line, X_TURN)
}

fn wanted_for(cli: ConvCli, line: &[u8]) -> bool {
    match cli {
        ConvCli::Claude => claude_wanted(line),
        ConvCli::Codex => codex_wanted(line),
    }
}

/// `/^\s*(<|# AGENTS\.md|\[Request interrupted)/`: text the CLI or the app injects as a "user" message.
pub fn is_injected(s: &str) -> bool {
    let t = s.trim_start_matches(super::text::is_space);
    t.starts_with('<') || t.starts_with("# AGENTS.md") || t.starts_with("[Request interrupted")
}

fn ts_of(e: &Value) -> f64 {
    let t = match e.get("timestamp") {
        Some(Value::String(s)) => date::parse(s),
        _ => f64::NAN,
    };
    if t.is_finite() { t } else { 0.0 }
}

fn seen(meta: &mut ConvMeta, ts: f64) {
    if ts == 0.0 || ts.is_nan() {
        return;
    }
    if meta.first_ts == 0.0 || ts < meta.first_ts {
        meta.first_ts = ts;
    }
    if ts > meta.last_ts {
        meta.last_ts = ts;
    }
}

/// JavaScript truthiness of a JSON value (a missing key is undefined).
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// textParts(content, types).
fn text_parts<'a>(content: Option<&'a Value>, types: &[&str]) -> Vec<&'a str> {
    match content {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|p| p.is_object())
            .filter(|p| str_of(p, "type").is_some_and(|t| types.contains(&t)))
            .filter_map(|p| str_of(p, "text"))
            .collect(),
        _ => vec![],
    }
}

fn join_trim(parts: &[&str]) -> String {
    trim(&parts.join("\n\n")).to_string()
}

fn user_prompt(meta: &mut ConvMeta, text: &str) {
    if meta.prompt.as_deref().is_none_or(str::is_empty) {
        meta.prompt = Some(text.to_string());
    }
}

/// One parsed Claude line.
pub fn claude_entry(meta: &mut ConvMeta, e: &Value, sink: &mut dyn Sink) {
    if !e.is_object() {
        return;
    }
    if meta.id.as_deref().is_none_or(str::is_empty)
        && let Some(id) = str_of(e, "sessionId").filter(|s| !s.is_empty())
    {
        meta.id = Some(id.to_string());
    }
    if meta.cwd.is_empty()
        && let Some(cwd) = str_of(e, "cwd").filter(|s| !s.is_empty())
    {
        meta.cwd = cwd.to_string();
    }
    let ty = str_of(e, "type");
    if ty == Some("custom-title")
        && let Some(t) = str_of(e, "customTitle").filter(|t| !trim(t).is_empty())
    {
        meta.custom = Some(t.to_string());
        return;
    }
    if ty == Some("ai-title")
        && let Some(t) = str_of(e, "aiTitle").filter(|t| !trim(t).is_empty())
    {
        meta.ai = Some(t.to_string());
        return;
    }
    if ty != Some("user") && ty != Some("assistant") {
        return;
    }
    if truthy(e.get("isSidechain")) || truthy(e.get("isMeta")) || truthy(e.get("isApiErrorMessage")) {
        return;
    }
    let ts = ts_of(e);
    seen(meta, ts);
    let msg = e.get("message");
    if !truthy(msg) {
        return;
    }
    let msg = msg.unwrap_or(&Value::Null);
    let content = msg.get("content");
    if ty == Some("assistant") {
        if let Some(model) = str_of(msg, "model").filter(|m| !m.is_empty() && !m.starts_with('<')) {
            meta.model = Some(model.to_string());
        }
        let text = join_trim(&text_parts(content, &["text"]));
        if !text.is_empty() {
            sink.message(ConvRole::Assistant, &text, ts);
        }
        if sink.wants_tools()
            && let Some(Value::Array(parts)) = content
        {
            for part in parts {
                if part.is_object()
                    && str_of(part, "type") == Some("tool_use")
                    && let Some(name) = str_of(part, "name")
                {
                    sink.tool(name, part.get("input"), ts);
                }
            }
        }
        return;
    }
    let parts: Vec<&str> = text_parts(content, &["text"]).into_iter().filter(|t| !is_injected(t)).collect();
    let text = join_trim(&parts);
    if text.is_empty() || is_injected(&text) {
        return;
    }
    user_prompt(meta, &text);
    sink.message(ConvRole::User, &text, ts);
}

const CODEX_TOOL_TYPES: [&str; 4] = ["function_call", "custom_tool_call", "local_shell_call", "web_search_call"];

/// One parsed Codex line. Messages come from response_item (the model's input and output); event_msg copies are skipped.
pub fn codex_entry(meta: &mut ConvMeta, e: &Value, sink: &mut dyn Sink) {
    if !e.is_object() {
        return;
    }
    // `typeof p !== 'object'`: an array passes too (it just has none of the keys).
    let Some(p) = e.get("payload").filter(|p| p.is_object() || p.is_array()) else { return };
    let ts = ts_of(e);
    let ty = str_of(e, "type");
    if ty == Some("session_meta") {
        // `p.id ?? p.session_id`
        let id = match p.get("id") {
            None | Some(Value::Null) => p.get("session_id"),
            some => some,
        };
        if meta.id.as_deref().is_none_or(str::is_empty)
            && let Some(Value::String(id)) = id
        {
            meta.id = Some(id.clone());
        }
        if let Some(cwd) = str_of(p, "cwd").filter(|s| !s.is_empty()) {
            meta.cwd = cwd.to_string();
        }
        let started = match p.get("timestamp") {
            Some(Value::String(s)) => date::parse(s),
            _ => f64::NAN,
        };
        seen(meta, if started.is_finite() { started } else { ts });
        if let Some(model) = str_of(p, "model").filter(|s| !s.is_empty()) {
            meta.model = Some(model.to_string());
        }
        return;
    }
    if ty == Some("turn_context") {
        if let Some(model) = str_of(p, "model").filter(|s| !s.is_empty()) {
            meta.model = Some(model.to_string());
        }
        if meta.cwd.is_empty()
            && let Some(cwd) = str_of(p, "cwd")
        {
            meta.cwd = cwd.to_string();
        }
        return;
    }
    let ptype = str_of(p, "type");
    if sink.wants_tools() && ty == Some("response_item") && ptype.is_some_and(|t| CODEX_TOOL_TYPES.contains(&t)) {
        seen(meta, ts);
        match ptype {
            Some("local_shell_call") => sink.tool("shell", p.get("action"), ts),
            Some("web_search_call") => sink.tool("web_search", p.get("action"), ts),
            _ => {
                if let Some(name) = str_of(p, "name") {
                    let input = if ptype == Some("custom_tool_call") { p.get("input") } else { p.get("arguments") };
                    sink.tool(name, input, ts);
                }
            }
        }
        return;
    }
    if ty != Some("response_item") || ptype != Some("message") {
        return;
    }
    let role = str_of(p, "role");
    if role != Some("user") && role != Some("assistant") {
        return;
    }
    seen(meta, ts);
    if role == Some("assistant") {
        let text = join_trim(&text_parts(p.get("content"), &["output_text", "text"]));
        if !text.is_empty() {
            sink.message(ConvRole::Assistant, &text, ts);
        }
        return;
    }
    let parts: Vec<&str> =
        text_parts(p.get("content"), &["input_text", "text"]).into_iter().filter(|t| !is_injected(t)).collect();
    let text = join_trim(&parts);
    if text.is_empty() {
        return;
    }
    user_prompt(meta, &text);
    sink.message(ConvRole::User, &text, ts);
}

/// `JSON.parse(buf.toString('utf8', start, end))`: invalid UTF-8 becomes U+FFFD, an escaped lone surrogate too.
fn parse_line(line: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(line);
    unimux_core::js_json::parse(&text).ok()
}

fn entry(cli: ConvCli, meta: &mut ConvMeta, e: &Value, sink: &mut dyn Sink) {
    match cli {
        ConvCli::Claude => claude_entry(meta, e, sink),
        ConvCli::Codex => codex_entry(meta, e, sink),
    }
}

/// Feeds one raw line: checked on its bytes, decoded and parsed only when it can matter. Returns whether it was a complete,
/// wanted JSON line (a trailing line without a newline counts as read only then).
pub fn feed_line(cli: ConvCli, meta: &mut ConvMeta, line: &[u8], sink: &mut dyn Sink) -> bool {
    // An assistant line without text still names the model while none is known (a session of tool calls only).
    let wanted =
        wanted_for(cli, line) || (cli == ConvCli::Claude && meta.model.is_none() && line.len() > 20 && has(line, C_ASSISTANT));
    if !wanted {
        return false;
    }
    let Some(e) = parse_line(line) else { return false };
    entry(cli, meta, &e, sink);
    true
}

/// Like feed_line, for the Markdown export: the agent's tool calls are wanted too (their output never is).
pub fn feed_export_line(cli: ConvCli, meta: &mut ConvMeta, line: &[u8], sink: &mut dyn Sink) -> bool {
    let mut wanted = wanted_for(cli, line);
    if !wanted && line.len() > 20 {
        wanted = match cli {
            ConvCli::Claude => has(line, C_ASSISTANT) && (meta.model.is_none() || has(line, C_TOOL_USE)),
            ConvCli::Codex => has(line, X_ITEM) && X_TOOL_CALLS.iter().any(|n| has(line, n)),
        };
    }
    if !wanted {
        return false;
    }
    let Some(e) = parse_line(line) else { return false };
    entry(cli, meta, &e, sink);
    true
}

/// The longest line the reader keeps (longer ones are huge tool output or pasted images; they are skipped).
pub const MAX_LINE: usize = 8 * 1024 * 1024;
const CHUNK: usize = 1024 * 1024;

/// A positional reader (a file, or a test double that returns short reads).
pub trait ReadAt {
    fn read_at(&mut self, buf: &mut [u8], pos: u64) -> io::Result<usize>;
}

impl ReadAt for std::fs::File {
    fn read_at(&mut self, buf: &mut [u8], pos: u64) -> io::Result<usize> {
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileExt;
            match self.seek_read(buf, pos) {
                // Reading at or past the end of a file is an EOF on Windows, not an error.
                Err(e) if e.raw_os_error() == Some(38) => Ok(0),
                r => r,
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::FileExt::read_at(self, buf, pos)
        }
    }
}

/// Streams the lines of a file from byte `from` (a line start) to its end. Returns the offset after the last line that was
/// read whole: the next read of a grown (append-only) file starts there.
pub fn read_lines(
    file: &mut dyn ReadAt,
    from: u64,
    on_line: &mut dyn FnMut(&[u8]) -> bool,
    max_line: usize,
    size_hint: Option<u64>,
) -> io::Result<u64> {
    // A small file gets a buffer of its size (most transcripts are far below a chunk).
    let size = match size_hint {
        None => CHUNK,
        Some(hint) => {
            let want = hint as i128 - from as i128 + 1;
            want.clamp(4096, CHUNK as i128) as usize
        }
    };
    let mut buf = vec![0u8; size];
    let mut pos = from;
    let mut consumed = from;
    let mut carry: Option<Vec<u8>> = None;
    let mut skipping = false;
    loop {
        let read = file.read_at(&mut buf, pos)?;
        if read == 0 {
            break;
        }
        let data = &buf[..read];
        let base = pos;
        pos += read as u64;
        let mut s = 0;
        while let Some(i) = memchr::memchr(b'\n', &data[s..]) {
            let nl = s + i;
            if skipping {
                skipping = false;
            } else if let Some(mut line) = carry.take() {
                line.extend_from_slice(&data[s..nl]);
                if line.len() <= max_line {
                    on_line(&line);
                }
            } else {
                on_line(&data[s..nl]);
            }
            s = nl + 1;
            consumed = base + s as u64;
        }
        if s < data.len() && !skipping {
            let rest = &data[s..];
            if carry.as_ref().map_or(0, Vec::len) + rest.len() > max_line {
                carry = None;
                skipping = true;
            } else {
                carry.get_or_insert_with(Vec::new).extend_from_slice(rest);
            }
        }
    }
    // The last line has no newline yet: it counts only when it is already a whole line.
    if let Some(line) = carry
        && !skipping
        && on_line(&line)
    {
        consumed = pos;
    }
    Ok(consumed)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Collect(Vec<(ConvRole, String)>);
    impl Sink for Collect {
        fn message(&mut self, role: ConvRole, text: &str, _ts: f64) {
            self.0.push((role, text.to_string()));
        }
    }

    fn feed(cli: ConvCli, lines: &[String]) -> (ConvMeta, Vec<(ConvRole, String)>) {
        let mut meta = ConvMeta::default();
        let mut out = Collect(vec![]);
        for line in lines {
            feed_line(cli, &mut meta, line.as_bytes(), &mut out);
        }
        (meta, out.0)
    }

    // conv-search.test.ts: "skips tool output, thinking, injected and sidechain lines on Claude"
    #[test]
    fn skips_tool_output_thinking_injected_and_sidechain_lines_on_claude() {
        let lines: Vec<String> = [
            serde_json::json!({"type":"user","message":{"role":"user","content":"hello there"},"sessionId":"s","cwd":"C:\\x","timestamp":"2026-01-01T00:00:00Z"}),
            serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"tool output"}]},"sessionId":"s"}),
            serde_json::json!({"type":"assistant","message":{"model":"claude-x","content":[{"type":"thinking","thinking":"hidden"}]},"sessionId":"s"}),
            serde_json::json!({"type":"assistant","message":{"model":"claude-x","content":[{"type":"text","text":"answer"},{"type":"tool_use","name":"Bash","input":{}}]}}),
            serde_json::json!({"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}),
            serde_json::json!({"type":"user","message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}),
        ]
        .iter()
        .map(|v| v.to_string())
        .chain(std::iter::once(r#"{"type":"user", broken"#.to_string()))
        .collect();
        let (meta, out) = feed(ConvCli::Claude, &lines);
        assert_eq!(out, vec![(ConvRole::User, "hello there".to_string()), (ConvRole::Assistant, "answer".to_string())]);
        assert_eq!(meta.id.as_deref(), Some("s"));
        assert_eq!(meta.cwd, "C:\\x");
        assert_eq!(meta.model.as_deref(), Some("claude-x"));
        assert_eq!(meta.prompt.as_deref(), Some("hello there"));
        assert_eq!(meta.first_ts, date::parse("2026-01-01T00:00:00Z"));
    }

    // conv-search.test.ts: "prefilters lines on their bytes"
    #[test]
    fn prefilters_lines_on_their_bytes() {
        assert!(!claude_wanted(br#"{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}"#));
        assert!(!claude_wanted(br#"{"type":"user","message":{"content":[{"type":"tool_result"}]}}"#));
        assert!(claude_wanted(br#"{"type":"ai-title","aiTitle":"x","sessionId":"s"}"#));
        assert!(!claude_wanted(br#"{"type":"api-request-blob","message":{"role":"user"}}"#));
        assert!(!codex_wanted(br#"{"type":"response_item","payload":{"type":"function_call_output","output":"x"}}"#));
        assert!(!codex_wanted(br#"{"type":"response_item","payload":{"type":"message","role":"developer"}}"#));
        assert!(codex_wanted(br#"{"type":"turn_context","payload":{"model":"m"}}"#));
    }

    struct Short(Vec<u8>);
    impl ReadAt for Short {
        fn read_at(&mut self, buf: &mut [u8], pos: u64) -> io::Result<usize> {
            // 7-byte reads force lines across chunks.
            let pos = pos as usize;
            let n = buf.len().min(7).min(self.0.len().saturating_sub(pos));
            buf[..n].copy_from_slice(&self.0[pos..pos + n]);
            Ok(n)
        }
    }

    // conv-search.test.ts: "reads lines across chunk borders, skips huge lines and keeps the offset of the last whole line"
    #[test]
    fn reads_lines_across_chunk_borders_skips_huge_lines_and_keeps_the_offset_of_the_last_whole_line() {
        let x50 = "x".repeat(50);
        let lines = [r#"{"a":1}"#, x50.as_str(), r#"{"b":2}"#, r#"{"c":3"#];
        let data = lines.join("\n").into_bytes();
        let len = data.len() as u64;
        let mut seen: Vec<String> = vec![];
        let end = read_lines(
            &mut Short(data),
            0,
            &mut |line| {
                let t = String::from_utf8_lossy(line).to_string();
                let ok = serde_json::from_str::<Value>(&t).is_ok();
                seen.push(t);
                ok
            },
            20,
            None,
        )
        .unwrap();
        assert_eq!(seen, vec![r#"{"a":1}"#, r#"{"b":2}"#, r#"{"c":3"#]);
        // The incomplete last line is not consumed.
        assert_eq!(end, len - r#"{"c":3"#.len() as u64);
    }
}
