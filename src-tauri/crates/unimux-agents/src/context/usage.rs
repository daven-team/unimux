//! How full the context window of a cell's conversation is ("Kontekst 32%" in the card header): port of
//! src/shared/contextUsage.ts. Pure: the tracker reads the transcript (Claude, `<config>/projects/<dir>/<session>.jsonl`) or
//! the rollout (Codex, `<home>/sessions/.../rollout-*.jsonl`) and feeds the new lines here. Only token counts, model ids and
//! compaction markers are read, never any message text.

use serde_json::{Map, Value, json};

use crate::hooks::payload::js_parse;

/// `ContextCli`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContextCli {
    Claude,
    Codex,
}

impl ContextCli {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
}

/// `ContextUsage`: the tokens the current conversation takes in the window of its model.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextUsage {
    pub cli: ContextCli,
    pub tokens: f64,
    pub window: f64,
    /// 0-100, rounded down to a whole percent (100 = full).
    pub percent: f64,
    pub model: Option<String>,
}

/// A JavaScript number as JSON: whole numbers in the safe range as integers (what JSON.stringify writes), others as floats.
pub fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 { json!(n as i64) } else { json!(n) }
}

impl ContextUsage {
    /// The object the renderer gets (`{ cli, tokens, window, percent, model? }`, keys in the TS order).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("cli".into(), json!(self.cli.as_str()));
        m.insert("tokens".into(), js_number(self.tokens));
        m.insert("window".into(), js_number(self.window));
        m.insert("percent".into(), js_number(self.percent));
        if let Some(model) = &self.model {
            m.insert("model".into(), json!(model));
        }
        Value::Object(m)
    }
}

/// `ContextScan`: what the lines read so far say (a later line wins).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ContextScan {
    /// Tokens in the context after the latest model call; None when unknown (nothing yet, or a compaction without a count).
    pub tokens: Option<f64>,
    pub model: Option<String>,
    /// Codex states the window of its model itself (model_context_window).
    pub window: Option<f64>,
    /// A line that sets the tokens was seen (the backward read of a long file stops at the first chunk that has one).
    pub seen: bool,
}

impl ContextScan {
    /// `{ tokens, model?, window?, seen }` (keys in the order the TS spreads give them, for the goldens).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("tokens".into(), self.tokens.map_or(Value::Null, js_number));
        if let Some(model) = &self.model {
            m.insert("model".into(), json!(model));
        }
        if let Some(w) = self.window {
            m.insert("window".into(), js_number(w));
        }
        m.insert("seen".into(), json!(self.seen));
        Value::Object(m)
    }
}

pub const CLAUDE_DEFAULT_WINDOW: f64 = 200_000.0;
const MILLION: f64 = 1_000_000.0;

/// `/\[1m\]|-1m\b/i` (a non-unicode `i` regex folds ASCII letters only; `\b` is the ASCII word boundary).
fn asks_long_window(text: &str) -> bool {
    let b = text.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    for i in 0..b.len() {
        if b[i] == b'[' && b.len() >= i + 4 && b[i + 1] == b'1' && b[i + 2].eq_ignore_ascii_case(&b'm') && b[i + 3] == b']' {
            return true;
        }
        if b[i] == b'-'
            && b.len() >= i + 3
            && b[i + 1] == b'1'
            && b[i + 2].eq_ignore_ascii_case(&b'm')
            && b.get(i + 3).is_none_or(|&c| !word(c))
        {
            return true;
        }
    }
    false
}

/// The first match of `/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/`: the family and the version.
/// `\d+` is greedy and the lookahead refuses a digit after it, so the major number is the whole digit run; the minor group
/// matches only a run of one or two digits (a longer run makes the group fail and the match ends after the major number).
fn claude_family(id: &str) -> Option<(&'static str, f64)> {
    const FAMILIES: [&str; 5] = ["opus", "sonnet", "haiku", "fable", "mythos"];
    let b = id.as_bytes();
    let digits = |from: usize| b[from.min(b.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
    for i in 0..b.len() {
        if !b[i..].starts_with(b"claude-") {
            continue;
        }
        for family in FAMILIES {
            let at = i + 7;
            if !b[at..].starts_with(family.as_bytes()) || b.get(at + family.len()) != Some(&b'-') {
                continue;
            }
            let major_at = at + family.len() + 1;
            let n = digits(major_at);
            if n == 0 {
                continue;
            }
            let major: f64 = id[major_at..major_at + n].parse().unwrap_or(f64::NAN);
            let after = major_at + n;
            let mut version = major;
            if b.get(after) == Some(&b'-') {
                let m = digits(after + 1);
                if m == 1 || m == 2 {
                    let minor: f64 = id[after + 1..after + 1 + m].parse().unwrap_or(0.0);
                    version = major + minor / 10.0;
                }
            }
            return Some((family, version));
        }
    }
    None
}

/// `claudeContextWindow(model, hint)`: Opus / Sonnet 4.6 and later, Haiku 5 and later, Fable and Mythos have 1M tokens;
/// older models 200k unless asked for with the `[1m]` suffix; unknown ids 200k (`context_usage` raises it to 1M once the
/// conversation is visibly larger).
pub fn claude_context_window(model: Option<&str>, hint: Option<&str>) -> f64 {
    if asks_long_window(&format!("{} {}", model.unwrap_or(""), hint.unwrap_or(""))) {
        return MILLION;
    }
    let id = crate::conv::text::to_lower_str(model.unwrap_or(""));
    let Some((family, version)) = claude_family(&id) else { return CLAUDE_DEFAULT_WINDOW };
    match family {
        "fable" | "mythos" => MILLION,
        "haiku" => {
            if version >= 5.0 {
                MILLION
            } else {
                CLAUDE_DEFAULT_WINDOW
            }
        }
        _ => {
            if version >= 4.6 {
                MILLION
            } else {
                CLAUDE_DEFAULT_WINDOW
            }
        }
    }
}

/// `num(v)`: a finite positive number, else 0.
fn num(v: Option<&Value>) -> f64 {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => n,
        _ => 0.0,
    }
}

/// `/^[\w.:@/[\]-]{1,100}$/` (ASCII `\w`).
fn clean_model(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    let ok = !s.is_empty() && s.len() <= 100 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.:@/[]-".contains(&c));
    ok.then(|| s.to_string())
}

/// `x?.[key]` where x may be any JSON value (only objects have keys).
fn field<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v?.as_object()?.get(key)
}

/// `!!v && typeof v === 'object'` (arrays included).
fn is_object_like(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

/// One Claude transcript entry: the main chain's assistant messages carry the usage of their API call.
pub fn apply_claude_entry(scan: &ContextScan, e: &Value) -> ContextScan {
    if !is_object_like(Some(e)) {
        return scan.clone();
    }
    let ty = field(Some(e), "type").and_then(Value::as_str);
    // /compact and auto-compaction: the window starts again with the summary (postTokens, when the version records it).
    if ty == Some("system") && field(Some(e), "subtype").and_then(Value::as_str) == Some("compact_boundary") {
        let post = num(field(field(Some(e), "compactMetadata"), "postTokens"));
        return ContextScan { tokens: (post != 0.0).then_some(post), seen: true, ..scan.clone() };
    }
    if ty != Some("assistant") || field(Some(e), "isSidechain") == Some(&Value::Bool(true)) {
        return scan.clone();
    }
    let msg = field(Some(e), "message");
    let usage = field(msg, "usage");
    if !is_object_like(usage) {
        return scan.clone();
    }
    let model = clean_model(field(msg, "model"));
    // API errors are written as "<synthetic>" messages with zero usage: they say nothing about the context.
    if field(msg, "model").and_then(Value::as_str) == Some("<synthetic>") {
        return scan.clone();
    }
    let tokens = num(field(usage, "input_tokens"))
        + num(field(usage, "cache_creation_input_tokens"))
        + num(field(usage, "cache_read_input_tokens"))
        + num(field(usage, "output_tokens"));
    if tokens == 0.0 {
        return scan.clone();
    }
    ContextScan { tokens: Some(tokens), model: model.or_else(|| scan.model.clone()), window: scan.window, seen: true }
}

/// One Codex rollout line: token_count events (last call's usage and the model's window), the turn's model, compactions.
pub fn apply_codex_entry(scan: &ContextScan, e: &Value) -> ContextScan {
    if !is_object_like(Some(e)) {
        return scan.clone();
    }
    let ty = field(Some(e), "type").and_then(Value::as_str);
    let p = field(Some(e), "payload");
    if ty == Some("turn_context") {
        return match clean_model(field(p, "model")) {
            Some(model) => ContextScan { model: Some(model), ..scan.clone() },
            None => scan.clone(),
        };
    }
    if ty == Some("compacted") {
        return ContextScan { tokens: None, seen: true, ..scan.clone() };
    }
    if ty != Some("event_msg") || field(p, "type").and_then(Value::as_str) != Some("token_count") {
        return scan.clone();
    }
    let info = field(p, "info");
    if !is_object_like(info) {
        return scan.clone(); // rate-limit-only events
    }
    let last = field(info, "last_token_usage");
    if !is_object_like(last) {
        return scan.clone();
    }
    // Codex's own "context left" counts the last call: its input (cached part included) plus its output.
    let total = num(field(last, "total_tokens"));
    let tokens = if total != 0.0 { total } else { num(field(last, "input_tokens")) + num(field(last, "output_tokens")) };
    let window = num(field(info, "model_context_window"));
    ContextScan {
        tokens: (tokens != 0.0).then_some(tokens),
        model: scan.model.clone(),
        window: if window != 0.0 { Some(window) } else { scan.window },
        seen: true,
    }
}

/// Cheap test before JSON.parse: most lines (messages, tool output) can never change the result.
fn relevant(cli: ContextCli, line: &str) -> bool {
    match cli {
        ContextCli::Claude => line.contains("\"usage\"") || line.contains("compact_boundary"),
        ContextCli::Codex => line.contains("token_count") || line.contains("\"turn_context\"") || line.contains("\"compacted\""),
    }
}

/// Applies every complete line of `text` (a chunk of the file that starts and ends at line boundaries).
pub fn scan_lines(cli: ContextCli, scan: &ContextScan, text: &str) -> ContextScan {
    let mut out = scan.clone();
    for line in text.split('\n') {
        if line.is_empty() || !relevant(cli, line) {
            continue;
        }
        let Some(entry) = js_parse(line) else { continue }; // garbage or a half-written line
        out = match cli {
            ContextCli::Claude => apply_claude_entry(&out, &entry),
            ContextCli::Codex => apply_codex_entry(&out, &entry),
        };
    }
    out
}

/// The usage to show; None while the tokens or the window are unknown. `model_hint` is the cell's model setting.
pub fn context_usage(cli: ContextCli, scan: &ContextScan, model_hint: Option<&str>) -> Option<ContextUsage> {
    let tokens = scan.tokens.filter(|t| *t > 0.0)?;
    let mut window = match cli {
        ContextCli::Codex => scan.window.unwrap_or(0.0),
        ContextCli::Claude => claude_context_window(scan.model.as_deref(), model_hint),
    };
    if window == 0.0 || window.is_nan() {
        return None;
    }
    // A conversation larger than the table's window runs on a bigger one (a 1M model under an unknown or proxied id).
    if cli == ContextCli::Claude && tokens > window && window < MILLION {
        window = MILLION;
    }
    let percent = ((tokens / window) * 100.0).floor().clamp(0.0, 100.0);
    Some(ContextUsage { cli, tokens, window, percent, model: scan.model.clone() })
}

/// `sameUsage(a, b)`.
pub fn same_usage(a: Option<&ContextUsage>, b: Option<&ContextUsage>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.tokens == b.tokens && a.window == b.window && a.model == b.model && a.cli == b.cli,
        _ => false,
    }
}

/// `contextLevel(percent)`: amber above 70%, red above 90% (the renderer keeps its own copy; here for automation).
pub fn context_level(percent: f64) -> &'static str {
    if percent > 90.0 {
        "high"
    } else if percent > 70.0 {
        "warn"
    } else {
        "ok"
    }
}

/// `groupDigits(n)`: "64 312".
pub fn group_digits(n: f64) -> String {
    let rounded = js_round(n);
    let s = match js_number(rounded) {
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    // /\B(?=(\d{3})+(?!\d))/g over the text: a space before every group of three digits that ends a digit run.
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, &c) in b.iter().enumerate() {
        if i > 0 && c.is_ascii_digit() && b[i - 1].is_ascii_digit() {
            let run = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
            if run % 3 == 0 && run > 0 {
                out.push(' ');
            }
        }
        out.push(c as char);
    }
    out
}

/// `Math.round(n)`: half up.
fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

#[cfg(test)]
pub(crate) mod tests {
    //! The pure cases of test/context-usage.test.ts.
    use super::*;
    use serde_json::json;

    pub(crate) const SESSION: &str = "3f2b9c1e-7a4d-4e21-9b0a-5c6d7e8f9a01";

    pub(crate) fn jsonl(rows: &[Value]) -> String {
        rows.iter().map(|r| format!("{}\n", serde_json::to_string(r).unwrap())).collect()
    }

    pub(crate) fn claude_user(text: &str) -> Value {
        json!({ "parentUuid": null, "isSidechain": false, "type": "user", "message": { "role": "user", "content": text }, "uuid": "u1",
            "timestamp": "2026-10-20T10:00:00.000Z", "cwd": "D:\\Projekty\\demo", "sessionId": SESSION, "version": "2.1.300", "gitBranch": "main" })
    }

    pub(crate) fn claude_assistant(usage: Value, model: Option<&str>, sidechain: bool) -> Value {
        let model = model.unwrap_or("claude-opus-5-5");
        let mut u = json!({ "cache_creation": { "ephemeral_5m_input_tokens": 0 }, "service_tier": "standard", "output_tokens_details": {} });
        for (k, v) in usage.as_object().unwrap() {
            u[k] = v.clone();
        }
        json!({ "parentUuid": "u1", "isSidechain": sidechain, "type": "assistant", "requestId": "req_1", "requestedModel": model,
            "message": { "id": "msg_1", "type": "message", "role": "assistant", "model": model,
                "content": [{ "type": "text", "text": "Done." }], "stop_reason": "end_turn", "usage": u },
            "uuid": "a1", "timestamp": "2026-10-20T10:00:05.000Z", "cwd": "D:\\Projekty\\demo", "sessionId": SESSION, "version": "2.1.300" })
    }

    pub(crate) fn compact_boundary(post: Option<u64>) -> Value {
        let mut meta = json!({ "trigger": "manual", "preTokens": 180_000 });
        if let Some(p) = post {
            meta["postTokens"] = json!(p);
        }
        json!({ "parentUuid": null, "logicalParentUuid": "a1", "isSidechain": false, "type": "system", "subtype": "compact_boundary",
            "content": "Conversation compacted", "level": "info", "compactMetadata": meta, "uuid": "c1", "sessionId": SESSION })
    }

    pub(crate) fn usage(input: u64, creation: u64, read: u64, output: u64) -> Value {
        json!({ "input_tokens": input, "cache_creation_input_tokens": creation, "cache_read_input_tokens": read, "output_tokens": output })
    }

    pub(crate) const CODEX_ID: &str = "01a13797-c84e-7c32-bc48-1da925af91e6";

    pub(crate) fn codex_meta() -> Value {
        json!({ "timestamp": "2026-10-14T01:27:36.000Z", "type": "session_meta", "payload": { "id": CODEX_ID, "cwd": "D:\\Projekty\\demo", "originator": "codex_cli_rs" } })
    }

    pub(crate) fn turn_context(model: &str) -> Value {
        json!({ "timestamp": "2026-10-14T01:27:40.000Z", "type": "turn_context", "payload": { "turn_id": "t1", "cwd": "D:\\Projekty\\demo", "model": model, "effort": "medium" } })
    }

    pub(crate) fn token_count(last_total: u64, window: Option<u64>) -> Value {
        let mut info = json!({
            "total_token_usage": { "input_tokens": last_total * 10, "cached_input_tokens": last_total * 9, "output_tokens": 900, "reasoning_output_tokens": 400, "total_tokens": last_total * 10 + 900 },
            "last_token_usage": { "input_tokens": last_total - 300, "cached_input_tokens": last_total - 1000, "output_tokens": 300, "reasoning_output_tokens": 120, "total_tokens": last_total },
        });
        if let Some(w) = window {
            info["model_context_window"] = json!(w);
        }
        json!({ "timestamp": "2026-10-14T01:28:00.000Z", "type": "event_msg", "payload": { "type": "token_count", "info": info,
            "rate_limits": { "primary": { "used_percent": 12, "window_minutes": 300 } } } })
    }

    fn rate_only() -> Value {
        json!({ "timestamp": "2026-10-14T01:28:01.000Z", "type": "event_msg", "payload": { "type": "token_count", "info": null, "rate_limits": {} } })
    }

    fn codex_message() -> Value {
        json!({ "timestamp": "2026-10-14T01:28:02.000Z", "type": "response_item", "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "token_count is a word here" }] } })
    }

    #[test]
    fn knows_the_1m_and_the_200k_models() {
        let w = |m: &str| claude_context_window(Some(m), None);
        assert_eq!(w("claude-opus-5-5"), 1_000_000.0);
        assert_eq!(w("claude-sonnet-5-5"), 1_000_000.0);
        assert_eq!(w("claude-opus-4-6"), 1_000_000.0);
        assert_eq!(w("claude-sonnet-4-6"), 1_000_000.0);
        assert_eq!(w("claude-fable-5-1"), 1_000_000.0);
        assert_eq!(w("claude-haiku-5-5"), 1_000_000.0);
        assert_eq!(w("claude-haiku-4-5-20251001"), 200_000.0);
        assert_eq!(w("claude-sonnet-4-5-20250929"), 200_000.0);
        assert_eq!(w("claude-opus-4-1-20250805"), 200_000.0);
        assert_eq!(w("claude-sonnet-4-20250514"), 200_000.0);
        assert_eq!(w("claude-3-5-sonnet-20241022"), 200_000.0);
    }

    #[test]
    fn takes_the_long_window_from_a_1m_model_setting_and_200k_for_unknown_ids() {
        assert_eq!(claude_context_window(Some("claude-sonnet-4-5-20250929"), Some("sonnet[1m]")), 1_000_000.0);
        assert_eq!(claude_context_window(Some("my-proxy-model"), None), 200_000.0);
        assert_eq!(claude_context_window(None, None), 200_000.0);
    }

    #[test]
    fn counts_the_last_main_chain_call_input_cache_writes_and_reads_output() {
        let text = jsonl(&[
            claude_user("hi"),
            claude_assistant(usage(10, 2000, 30_000, 500), None, false),
            claude_user("more"),
            claude_assistant(usage(4, 1200, 62_808, 300), None, false),
        ]);
        let scan = scan_lines(ContextCli::Claude, &ContextScan::default(), &text);
        assert_eq!(scan.tokens, Some(64_312.0));
        assert_eq!(
            context_usage(ContextCli::Claude, &scan, None).unwrap().to_json(),
            json!({ "cli": "claude", "tokens": 64_312, "window": 1_000_000, "percent": 6, "model": "claude-opus-5-5" })
        );
        let old = scan_lines(
            ContextCli::Claude,
            &ContextScan::default(),
            &jsonl(&[claude_assistant(usage(4, 1200, 62_808, 300), Some("claude-sonnet-4-5-20250929"), false)]),
        );
        assert_eq!(context_usage(ContextCli::Claude, &old, None).unwrap().percent, 32.0);
    }

    #[test]
    fn ignores_subagent_sidechain_calls_and_synthetic_error_messages() {
        let mut scan = scan_lines(
            ContextCli::Claude,
            &ContextScan::default(),
            &jsonl(&[claude_assistant(usage(1, 0, 50_000, 10), None, false)]),
        );
        scan = apply_claude_entry(&scan, &claude_assistant(usage(1, 0, 150_000, 10), None, true));
        scan = apply_claude_entry(&scan, &claude_assistant(usage(0, 0, 0, 0), Some("<synthetic>"), false));
        assert_eq!(scan.tokens, Some(50_011.0));
        assert_eq!(scan.model.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn starts_again_after_compact_the_summary_size_when_recorded_else_unknown_until_the_next_call() {
        let before = scan_lines(
            ContextCli::Claude,
            &ContextScan::default(),
            &jsonl(&[claude_assistant(usage(1, 0, 180_000, 10), None, false)]),
        );
        assert_eq!(apply_claude_entry(&before, &compact_boundary(Some(35_797))).tokens, Some(35_797.0));
        let unknown = apply_claude_entry(&before, &compact_boundary(None));
        assert_eq!(unknown.tokens, None);
        assert_eq!(context_usage(ContextCli::Claude, &unknown, None), None);
        assert_eq!(
            apply_claude_entry(&unknown, &claude_assistant(usage(3, 500, 40_000, 200), None, false)).tokens,
            Some(40_703.0)
        );
    }

    #[test]
    fn raises_the_window_when_the_conversation_is_visibly_larger_than_the_table_says() {
        let scan = scan_lines(
            ContextCli::Claude,
            &ContextScan::default(),
            &jsonl(&[claude_assistant(usage(1, 0, 450_000, 10), Some("proxy-large"), false)]),
        );
        let u = context_usage(ContextCli::Claude, &scan, None).unwrap();
        assert_eq!((u.window, u.percent), (1_000_000.0, 45.0));
    }

    #[test]
    fn skips_half_written_and_foreign_lines() {
        let text = format!(
            "{}\n{{\"type\":\"assistant\",\"message\":{{\"usage\":{{\"input_tok\nnot json \"usage\"\n",
            serde_json::to_string(&claude_assistant(usage(1, 0, 1000, 1), None, false)).unwrap()
        );
        assert_eq!(scan_lines(ContextCli::Claude, &ContextScan::default(), &text).tokens, Some(1002.0));
    }

    #[test]
    fn reads_the_last_call_and_the_window_from_token_count_the_model_from_the_turn_context() {
        let scan = scan_lines(
            ContextCli::Codex,
            &ContextScan::default(),
            &jsonl(&[
                codex_meta(),
                turn_context("gpt-6.1-sol"),
                codex_message(),
                token_count(215_365, Some(475_000)),
                rate_only(),
            ]),
        );
        assert_eq!(
            context_usage(ContextCli::Codex, &scan, None).unwrap().to_json(),
            json!({ "cli": "codex", "tokens": 215_365, "window": 475_000, "percent": 45, "model": "gpt-6.1-sol" })
        );
    }

    #[test]
    fn is_unknown_without_a_window_and_after_a_compaction_until_the_next_count() {
        let none = scan_lines(ContextCli::Codex, &ContextScan::default(), &jsonl(&[token_count(10_000, None)]));
        assert_eq!(context_usage(ContextCli::Codex, &none, None), None);
        let scan = scan_lines(ContextCli::Codex, &ContextScan::default(), &jsonl(&[token_count(400_000, Some(475_000))]));
        let compacted = apply_codex_entry(&scan, &json!({ "timestamp": "x", "type": "compacted", "payload": { "message": "" } }));
        assert_eq!(context_usage(ContextCli::Codex, &compacted, None), None);
        let next = apply_codex_entry(&compacted, &token_count(30_000, Some(475_000)));
        assert_eq!(context_usage(ContextCli::Codex, &next, None).unwrap().percent, 6.0);
    }

    #[test]
    fn turns_amber_above_70_and_red_above_90() {
        assert_eq!([70.0, 71.0, 90.0, 91.0].map(context_level), ["ok", "warn", "warn", "high"]);
    }

    #[test]
    fn groups_digits_with_spaces() {
        assert_eq!(group_digits(64_312.0), "64 312");
        assert_eq!(group_digits(1_000_000.0), "1 000 000");
        assert_eq!(group_digits(950.0), "950");
    }

    #[test]
    fn model_family_matching_follows_the_regex_backtracking() {
        // The minor group needs one or two digits; a longer run leaves the major version alone.
        assert_eq!(claude_family("claude-opus-4-123"), Some(("opus", 4.0)));
        assert_eq!(claude_family("x claude-sonnet-4-6"), Some(("sonnet", 4.6)));
        assert_eq!(claude_family("claude-sonnet-"), None);
        assert_eq!(claude_family("claude-claude-haiku-5"), Some(("haiku", 5.0)));
        assert!(asks_long_window("sonnet[1M]"));
        assert!(asks_long_window("x-1m"));
        assert!(!asks_long_window("x-1mb"));
        assert!(asks_long_window("x-1m-y"));
    }
}
