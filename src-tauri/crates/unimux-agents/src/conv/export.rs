//! The Markdown export of a conversation (1.1.1; port of src/convsearch/exporter.ts and toolDetail of src/shared/convExport.ts):
//! finds the transcript of a session (or takes an indexed file) and reads it whole into ConvExportData, streaming its lines
//! and stopping at the export limits. The renderer turns that into Markdown (src/shared/convExport.ts stays in TS).

use std::fs;
use std::path::Path;

use serde_json::{Map, Value, json};

use super::parse::{self, ConvMeta, ReadAt, Sink};
use super::paths::join;
use super::text::{collapse_space, len16, slice16, trim};
use super::{ConvCli, ConvRole, Roots, clip_title, node_error, num};

/// `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`
pub fn is_session_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
}

#[derive(Debug, Clone, Copy)]
pub struct ExportLimits {
    pub doc_chars: usize,
    pub message_chars: usize,
    pub items: usize,
}

/// A long conversation is cut (the save dialog takes up to 4 MB, a note 200k characters).
pub const EXPORT_LIMITS: ExportLimits = ExportLimits { doc_chars: 3_000_000, message_chars: 200_000, items: 50_000 };
const DETAIL_CHARS: usize = 160;

fn one_line(s: &str) -> String {
    trim(&collapse_space(s)).to_string()
}

fn clip_detail(s: &str) -> String {
    let line = one_line(s);
    if len16(&line) > DETAIL_CHARS { format!("{}…", slice16(&line, DETAIL_CHARS - 1)) } else { line }
}

/// parseArgs: a string that holds a JSON object or array is parsed.
fn parse_args(value: Option<&Value>) -> Option<Value> {
    let v = value?;
    if let Value::String(s) = v {
        let t = trim(s);
        if !t.starts_with('{') && !t.starts_with('[') {
            return Some(v.clone());
        }
        return Some(unimux_core::js_json::parse(t).unwrap_or_else(|_| v.clone()));
    }
    Some(v.clone())
}

/// `/^(ba|z|)sh$|bash\.exe$|^pwsh$|^powershell(\.exe)?$|^cmd(\.exe)?$/i`
fn is_shell(s: &str) -> bool {
    // Non-ASCII letters never match an ASCII pattern under /i without /u.
    let ascii_eq = |a: &str| s.len() == a.len() && s.eq_ignore_ascii_case(a);
    ascii_eq("sh")
        || ascii_eq("bash")
        || ascii_eq("zsh")
        || (s.len() >= 8 && s.is_char_boundary(s.len() - 8) && s[s.len() - 8..].eq_ignore_ascii_case("bash.exe"))
        || ascii_eq("pwsh")
        || ascii_eq("powershell")
        || ascii_eq("powershell.exe")
        || ascii_eq("cmd")
        || ascii_eq("cmd.exe")
}

/// `/^(-l?c|-Command|\/c)$/i`
fn is_shell_flag(s: &str) -> bool {
    ["-c", "-lc", "-command", "/c"].iter().any(|f| s.eq_ignore_ascii_case(f))
}

/// A shell command as one string: Codex passes ["bash", "-lc", "npm test"] or ["rg", "x"].
fn command_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
            let parts: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            if parts.len() >= 3 && is_shell(parts[0]) && is_shell_flag(parts[1]) { parts[2..].join(" ") } else { parts.join(" ") }
        }
        _ => String::new(),
    }
}

/// The files an apply_patch input touches (`/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm`).
fn patch_files(text: &str) -> String {
    let mut files = Vec::new();
    for line in text.split(['\n', '\r', '\u{2028}', '\u{2029}']) {
        for head in ["*** Add File: ", "*** Update File: ", "*** Delete File: "] {
            if let Some(rest) = line.strip_prefix(head)
                && !rest.is_empty()
            {
                files.push(trim(rest).to_string());
            }
        }
    }
    files.join(", ")
}

const KEY_ORDER: [&str; 12] =
    ["command", "cmd", "file_path", "notebook_path", "pattern", "path", "query", "url", "description", "prompt", "skill", "name"];

/// One line that says what a tool call did ("npm test", "src/a.ts"), from its name and input; '' when nothing short says it.
pub fn tool_detail(name: &str, input: Option<&Value>) -> String {
    let value = parse_args(input);
    let o = match &value {
        Some(Value::String(s)) => {
            if name == "apply_patch" {
                let files = patch_files(s);
                return clip_detail(if files.is_empty() { s } else { &files });
            }
            return clip_detail(s);
        }
        Some(Value::Object(o)) => Some(o),
        Some(Value::Array(_)) => None,
        _ => return String::new(),
    };
    let get = |k: &str| o.and_then(|o| o.get(k));
    if get("command").is_some() || get("cmd").is_some() {
        // `o.command ?? o.cmd`
        let pick = match get("command") {
            None | Some(Value::Null) => get("cmd"),
            some => some,
        };
        let cmd = command_text(pick);
        if !cmd.is_empty() {
            return clip_detail(&cmd);
        }
    }
    if name == "apply_patch"
        && let Some(Value::String(input)) = get("input")
    {
        return clip_detail(&patch_files(input));
    }
    // A web search (Codex) names its query in an action.
    if let Some(Value::String(q)) = get("query") {
        return clip_detail(q);
    }
    for key in KEY_ORDER {
        if let Some(Value::String(s)) = get(key)
            && !trim(s).is_empty()
        {
            return clip_detail(s);
        }
    }
    String::new()
}

/// The newest transcript file of a session in the CLI folders (Claude: projects/<folder>/<id>.jsonl, Codex: rollout-...-<id>.jsonl).
pub fn locate_session(cli: ConvCli, id: &str, roots: &Roots) -> Option<String> {
    if !is_session_id(id) {
        return None;
    }
    let mut found: Vec<(String, f64)> = Vec::new();
    let consider = |file: String, found: &mut Vec<(String, f64)>| {
        if let Ok(st) = fs::metadata(&file)
            && st.is_file()
        {
            found.push((file, super::indexer::mtime_ms(&st)));
        }
    };
    match cli {
        ConvCli::Claude => {
            for root in &roots.claude {
                let base = join(root, &["projects"]);
                let Ok(items) = fs::read_dir(&base) else { continue };
                for d in items.flatten() {
                    if d.file_type().is_ok_and(|t| t.is_dir()) {
                        let name = d.file_name().to_string_lossy().to_string();
                        consider(join(&base, &[&name, &format!("{id}.jsonl")]), &mut found);
                    }
                }
            }
        }
        ConvCli::Codex => {
            let suffix = format!("-{id}.jsonl");
            fn walk(dir: &str, depth: u32, suffix: &str, found: &mut Vec<String>) {
                let Ok(items) = fs::read_dir(dir) else { return };
                for it in items.flatten() {
                    let Ok(t) = it.file_type() else { continue };
                    let name = it.file_name().to_string_lossy().to_string();
                    if t.is_dir() && depth < 4 {
                        walk(&join(dir, &[&name]), depth + 1, suffix, found);
                    } else if t.is_file() && name.starts_with("rollout-") && name.ends_with(suffix) {
                        found.push(join(dir, &[&name]));
                    }
                }
            }
            for root in &roots.codex {
                let mut files = Vec::new();
                walk(&join(root, &["sessions"]), 0, &suffix, &mut files);
                for f in files {
                    consider(f, &mut found);
                }
            }
        }
    }
    // found.sort((a, b) => b.mtimeMs - a.mtimeMs): stable, newest first.
    found.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    found.into_iter().next().map(|f| f.0)
}

enum Item {
    Msg { role: ConvRole, text: String, ts: f64, cut: bool },
    Tool { name: String, detail: String, ts: f64 },
}

struct ExportSink {
    limits: ExportLimits,
    items: Vec<Item>,
    total: usize,
    capped: bool,
}

impl ExportSink {
    fn room(&mut self, n: usize) -> bool {
        if self.capped {
            return false;
        }
        if self.total + n > self.limits.doc_chars || self.items.len() >= self.limits.items {
            self.capped = true;
            return false;
        }
        self.total += n;
        true
    }
}

impl Sink for ExportSink {
    fn message(&mut self, role: ConvRole, text: &str, ts: f64) {
        let n = len16(text);
        let cut = n > self.limits.message_chars;
        let kept = if cut { slice16(text, self.limits.message_chars) } else { text.to_string() };
        if !self.room(len16(&kept)) {
            return;
        }
        self.items.push(Item::Msg { role, text: kept, ts, cut });
    }
    fn tool(&mut self, name: &str, input: Option<&Value>, ts: f64) {
        let detail = tool_detail(name, input);
        if !self.room(len16(name) + len16(&detail)) {
            return;
        }
        self.items.push(Item::Tool { name: slice16(name, 80), detail, ts });
    }
    fn wants_tools(&self) -> bool {
        true
    }
}

/// The failed answer of conv:export.
pub fn failed(error: &str, cli: ConvCli) -> Value {
    json!({
        "ok": false, "error": error, "cli": cli.as_str(), "id": "", "title": "", "cwd": "", "startedAt": 0, "updatedAt": 0,
        "items": [], "capped": false,
    })
}

/// Reads a whole transcript for the export (tool calls as one-line summaries, no tool output, no reasoning).
pub fn read_export(file: &str, cli: ConvCli, limits: ExportLimits) -> Result<Value, String> {
    let mut fh = fs::File::open(Path::new(file)).map_err(|e| node_error(&e, "open", file))?;
    let size = fh.metadata().map_err(|e| node_error(&e, "fstat", file))?.len();
    let mut meta = ConvMeta::default();
    let mut sink = ExportSink { limits, items: Vec::new(), total: 0, capped: false };
    parse::read_lines(
        &mut fh as &mut dyn ReadAt,
        0,
        &mut |line| parse::feed_export_line(cli, &mut meta, line, &mut sink),
        parse::MAX_LINE,
        Some(size),
    )
    .map_err(|e| node_error(&e, "read", file))?;
    let mut out = Map::new();
    out.insert("ok".into(), json!(true));
    out.insert("cli".into(), json!(cli.as_str()));
    out.insert("id".into(), json!(meta.id.clone().unwrap_or_default()));
    out.insert("cwd".into(), json!(meta.cwd));
    out.insert("title".into(), json!(clip_title(&meta)));
    if let Some(model) = meta.model.as_deref().filter(|m| !m.is_empty()) {
        out.insert("model".into(), json!(model));
    }
    out.insert("startedAt".into(), num(meta.first_ts));
    out.insert("updatedAt".into(), num(meta.last_ts));
    out.insert(
        "items".into(),
        Value::Array(
            sink.items
                .iter()
                .map(|item| match item {
                    Item::Msg { role, text, ts, cut } => {
                        let mut m = Map::new();
                        m.insert("kind".into(), json!("msg"));
                        m.insert("role".into(), json!(role.as_str()));
                        m.insert("text".into(), json!(text));
                        m.insert("ts".into(), num(*ts));
                        if *cut {
                            m.insert("cut".into(), json!(true));
                        }
                        Value::Object(m)
                    }
                    Item::Tool { name, detail, ts } => json!({"kind": "tool", "name": name, "detail": detail, "ts": num(*ts)}),
                })
                .collect(),
        ),
    );
    out.insert("capped".into(), json!(sink.capped));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    // conv-export.test.ts: "summarises tool inputs in one line"
    #[test]
    fn summarises_tool_inputs_in_one_line() {
        let d = |name: &str, v: Value| tool_detail(name, Some(&v));
        assert_eq!(d("Bash", json!({"command": "npm test\n  --run", "description": "x"})), "npm test --run");
        assert_eq!(d("Read", json!({"file_path": "src/a.ts"})), "src/a.ts");
        assert_eq!(d("Grep", json!({"pattern": "TODO", "path": "src"})), "TODO");
        assert_eq!(d("WebFetch", json!({"url": "https://x.dev", "prompt": "p"})), "https://x.dev");
        assert_eq!(d("TodoWrite", json!({"todos": []})), "");
        assert_eq!(d("shell", json!("{\"command\":[\"pwsh\",\"-Command\",\"Get-ChildItem\"]}")), "Get-ChildItem");
        assert_eq!(d("shell", json!({"command": ["rg", "-n", "x"]})), "rg -n x");
        assert_eq!(d("web_search", json!({"type": "search", "query": "vitest docs"})), "vitest docs");
        assert_eq!(len16(&d("Bash", json!({"command": "x".repeat(500)}))), 160);
    }
}
