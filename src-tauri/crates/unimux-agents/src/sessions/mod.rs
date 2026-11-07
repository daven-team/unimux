//! Index of past Claude Code / Codex conversations for a project folder: port of src/main/sessions.ts (`sessions:list`,
//! `findRecentCodexSession` for `codex:bind`, the worktree matcher, `claudeProjectDirName`).
//!
//! The TS module kept its caches in module globals; here one [`SessionIndex`] holds them (the app keeps one per run). Every
//! function is blocking (the app calls it on the blocking pool) and reads only the head and tail slices 1.1.4 read.
//!
//! JavaScript values: the fields the listing passes through are kept as JSON values where 1.1.4 accepted any truthy value
//! (a Codex `payload.id`, a Claude `cwd`), and a non-string cwd that 1.1.4 handed to `normalizeProjectPath` fails the listing
//! the way its TypeError rejected the IPC call.

use std::collections::{HashMap, HashSet};
use std::path::{MAIN_SEPARATOR, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::context::usage::js_number;
use crate::conv::date;
use crate::conv::indexer::pool;
use crate::conv::text::{collapse_space, is_space, js_less, len16, slice16, to_lower_str, trim};
use crate::fsstat::{self, FileStat, read_slice};
use crate::hooks::payload::js_parse;

pub mod state;

pub const HEAD_BYTES: usize = 256 * 1024;
pub const TAIL_BYTES: usize = 64 * 1024;
pub const MAX_CODEX_FILES: usize = 600;
const CONCURRENCY: usize = 4;
/// The newest rollout files are shared by every listing within this window (one refresh asks once per worktree).
const INDEX_TTL: Duration = Duration::from_millis(2000);
/// `findRecentCodexSession` reads only the newest files itself.
const RECENT_CODEX_FILES: usize = 80;

/// `claudeProjectDirName(path)`: Claude stores sessions under `projects/<path with every non-alphanumeric char -> '-'>`. The
/// TS regex runs over UTF-16 code units, so a character outside the BMP (a surrogate pair) becomes two dashes.
pub fn claude_project_dir_name(project_path: &str) -> String {
    let mut out = String::with_capacity(project_path.len());
    for c in project_path.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('-');
            }
        }
    }
    out
}

/// `normalizeProjectPath(path)` of src/shared/platform.ts: trailing separators dropped, backslashes as slashes, lower case
/// (JavaScript's full `toLowerCase`) for drive and UNC paths.
pub fn normalize_project_path(path: &str) -> String {
    let normalized = path.trim_end_matches(['\\', '/']).replace('\\', "/");
    let b = normalized.as_bytes();
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/';
    if drive || normalized.starts_with("//") { to_lower_str(&normalized) } else { normalized }
}

/// `normPath(v)` for a value read from a file: a string, else the TypeError of `v.replace`.
fn norm_value(v: &Value) -> Result<String, SessionsError> {
    match v {
        Value::String(s) => Ok(normalize_project_path(s)),
        _ => Err(SessionsError("path.replace is not a function".into())),
    }
}

/// A listing that failed the way the TS one threw (a non-string cwd in a session file).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionsError(pub String);

impl std::fmt::Display for SessionsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SessionsError {}

/// JavaScript truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(v)` as `Array.prototype.join` uses it (null becomes '').
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => unimux_core::js_json::number_text(n),
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `e?.[key]` for any parsed line.
fn get<'a>(e: &'a Value, key: &str) -> Option<&'a Value> {
    e.as_object()?.get(key)
}

fn get_str<'a>(e: &'a Value, key: &str) -> Option<&'a str> {
    get(e, key).and_then(Value::as_str)
}

/// `parseLines(text)`: every non-blank line JSON.parse accepts.
fn parse_lines(text: &str) -> Vec<Value> {
    text.split('\n').filter(|l| !trim(l).is_empty()).filter_map(js_parse).collect()
}

/// `s.replace(/\s+/g, ' ').trim().slice(0, 140)`.
fn clip(s: &str) -> String {
    slice16(trim(&collapse_space(s)), 140)
}

/// `/^\s*(<|# AGENTS\.md)/`.
fn is_injected(s: &str) -> bool {
    let t = s.trim_start_matches(is_space);
    t.starts_with('<') || t.starts_with("# AGENTS.md")
}

fn now_ms() -> f64 {
    fsstat::ms_of(SystemTime::now())
}

fn date_of(v: &Value) -> f64 {
    match v {
        Value::String(s) => date::parse(s),
        _ => f64::NAN,
    }
}

/// `SessionInfo` of src/shared/types.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionInfo {
    pub cli: &'static str,
    pub id: Value,
    pub cwd: Value,
    pub title: String,
    pub started_at: f64,
    pub updated_at: f64,
    pub worktree: Option<WorktreeLabel>,
}

/// Held in a worktree folder of the project: its branch (or folder name) and whether the folder still exists.
#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeLabel {
    pub path: String,
    pub label: String,
    pub exists: bool,
    pub branch: Option<String>,
}

impl SessionInfo {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("cli".into(), json!(self.cli));
        m.insert("id".into(), self.id.clone());
        m.insert("cwd".into(), self.cwd.clone());
        m.insert("title".into(), json!(self.title));
        m.insert("startedAt".into(), js_number(self.started_at));
        m.insert("updatedAt".into(), js_number(self.updated_at));
        if let Some(w) = &self.worktree {
            let mut wt = Map::new();
            wt.insert("path".into(), json!(w.path));
            wt.insert("label".into(), json!(w.label));
            wt.insert("exists".into(), json!(w.exists));
            if let Some(b) = w.branch.as_ref().filter(|b| !b.is_empty()) {
                wt.insert("branch".into(), json!(b));
            }
            m.insert("worktree".into(), Value::Object(wt));
        }
        Value::Object(m)
    }
}

pub fn to_json(list: &[SessionInfo]) -> Value {
    Value::Array(list.iter().map(SessionInfo::to_json).collect())
}

/// `byUpdated`: newest first, then by id.
fn by_updated(a: &SessionInfo, b: &SessionInfo) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    let d = b.updated_at - a.updated_at;
    if d > 0.0 {
        return Greater;
    }
    if d < 0.0 {
        return Less;
    }
    match (&a.id, &b.id) {
        (Value::String(x), Value::String(y)) if js_less(x, y) => Less,
        (Value::String(x), Value::String(y)) if js_less(y, x) => Greater,
        _ => Equal,
    }
}

fn sorted(mut list: Vec<SessionInfo>) -> Vec<SessionInfo> {
    list.sort_by(by_updated);
    list
}

// ── Claude ──────────────────────────────────────────────────────────────────

fn claude_text(entry: &Value) -> Option<String> {
    if get_str(entry, "type") != Some("user")
        || get(entry, "isMeta").is_some_and(truthy)
        || get(entry, "isSidechain").is_some_and(truthy)
    {
        return None;
    }
    let text = match get(entry, "message").and_then(|m| get(m, "content")) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|x| get_str(x, "type") == Some("text"))
            .map(|x| get(x, "text").map(js_string).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    (!text.is_empty() && !is_injected(&text)).then_some(text)
}

/// What the head of a transcript says; it never changes once the file is at least as long as the head slice.
#[derive(Debug, Clone)]
struct ClaudeHead {
    id: Option<String>,
    cwd: Value,
    first_ts: Option<Value>,
    prompt: Option<String>,
    /// The latest /rename and generated titles inside the head slice.
    custom: Option<String>,
    ai: Option<String>,
    /// The file was at least HEAD_BYTES long when the head was read, so later appends never touch it.
    complete: bool,
}

#[derive(Debug, Clone, Default)]
struct ClaudeTail {
    id: Option<String>,
    custom: Option<String>,
    ai: Option<String>,
}

fn last_string(entries: &[Value], ty: &str, key: &str) -> Option<String> {
    entries.iter().rev().find_map(|e| {
        (get_str(e, "type") == Some(ty)).then(|| get_str(e, key).filter(|s| !s.is_empty()).map(str::to_string)).flatten()
    })
}

fn first_session_id(entries: &[Value]) -> Option<String> {
    entries.iter().find_map(|e| get_str(e, "sessionId").map(str::to_string))
}

fn parse_claude_head(text: &str, size: u64) -> ClaudeHead {
    let head = parse_lines(text);
    let first_truthy = |key: &str| head.iter().find_map(|e| get(e, key).filter(|v| truthy(v)).cloned());
    ClaudeHead {
        id: first_session_id(&head),
        cwd: first_truthy("cwd").unwrap_or_else(|| json!("")),
        first_ts: first_truthy("timestamp"),
        prompt: head.iter().find_map(claude_text),
        custom: last_string(&head, "custom-title", "customTitle"),
        ai: last_string(&head, "ai-title", "aiTitle"),
        complete: size >= HEAD_BYTES as u64,
    }
}

/// The tail is only read for titles (and an id the head lacked): every other line is skipped before JSON.parse.
fn parse_claude_tail(text: &str, need_id: bool) -> ClaudeTail {
    let wanted: Vec<Value> =
        text.split('\n').filter(|l| l.contains("-title") || (need_id && l.contains("sessionId"))).filter_map(js_parse).collect();
    ClaudeTail {
        id: if need_id { first_session_id(&wanted) } else { None },
        custom: last_string(&wanted, "custom-title", "customTitle"),
        ai: last_string(&wanted, "ai-title", "aiTitle"),
    }
}

fn claude_info(head: &ClaudeHead, tail: &ClaudeTail, st: &FileStat) -> Option<SessionInfo> {
    let id = head.id.clone().or_else(|| tail.id.clone())?;
    // A title the user gave with /rename wins over the generated one; the latest entry of either kind counts.
    let title =
        tail.custom.as_ref().or(head.custom.as_ref()).or(tail.ai.as_ref()).or(head.ai.as_ref()).or(head.prompt.as_ref())?;
    Some(SessionInfo {
        cli: "claude",
        id: json!(id),
        cwd: head.cwd.clone(),
        title: clip(title),
        started_at: head.first_ts.as_ref().map_or(st.birthtime_ms, date_of),
        updated_at: st.mtime_ms,
        worktree: None,
    })
}

/// `birthtimeMs` and `ino` tell a replaced transcript (same path, new file) from one that only grew.
#[derive(Debug, Clone)]
struct ClaudeEntry {
    mtime_ms: f64,
    size: u64,
    birthtime_ms: f64,
    ino: u64,
    info: Option<SessionInfo>,
    head: ClaudeHead,
}

/// A grown transcript whose head was complete only needs its tail again (a running agent appends all the time).
fn can_reuse_head(hit: Option<&ClaudeEntry>, st: &FileStat) -> bool {
    hit.is_some_and(|h| h.head.complete && st.size >= h.size && h.birthtime_ms == st.birthtime_ms && h.ino == st.ino)
}

/// What the caches hold; counted for the tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClaudeCacheStats {
    pub parses: usize,
    pub tail_reads: usize,
    pub cached: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CodexCacheStats {
    pub dir_reads: usize,
    pub cached_dirs: usize,
    pub cached_files: usize,
}

// ── Codex ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct CodexMeta {
    id: Value,
    cwd: Value,
    timestamp: Option<Value>,
}

#[derive(Debug)]
struct CodexEntry {
    file: PathBuf,
    mtime_ms: f64,
    meta: Option<CodexMeta>,
    /// None: not read yet; Some(None): no user prompt.
    title: Mutex<Option<Option<String>>>,
}

#[derive(Debug, Clone)]
struct DirListing {
    mtime_ms: f64,
    dirs: Vec<String>,
    files: Vec<String>,
}

fn descending(names: &mut [String]) {
    names.sort_by(|a, b| {
        if js_less(a, b) {
            std::cmp::Ordering::Greater
        } else if js_less(b, a) {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    });
}

fn codex_meta(file: &Path) -> std::io::Result<Option<CodexMeta>> {
    // The first line (session_meta) carries the id and cwd; it can be tens of KB.
    let mut size = 64 * 1024;
    while size <= 1024 * 1024 {
        let text = read_slice(file, 0, size)?;
        let nl = text.find('\n');
        // `text.length === size` compares UTF-16 units with bytes, as 1.1.4 did.
        if nl.is_none() && len16(&text) == size {
            size *= 4;
            continue;
        }
        let first = match js_parse(match nl {
            Some(i) => &text[..i],
            None => &text,
        }) {
            Some(v) => v,
            None => return Ok(None),
        };
        if get_str(&first, "type") != Some("session_meta") {
            return Ok(None);
        }
        let empty = json!({});
        let p = get(&first, "payload").filter(|v| !v.is_null()).unwrap_or(&empty);
        let id = get(p, "id").filter(|v| !v.is_null()).or_else(|| get(p, "session_id")).cloned().unwrap_or(Value::Null);
        if !truthy(&id) {
            return Ok(None);
        }
        let cwd = get(p, "cwd").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!(""));
        return Ok(Some(CodexMeta { id, cwd, timestamp: get(p, "timestamp").cloned() }));
    }
    Ok(None)
}

fn codex_title(file: &Path) -> std::io::Result<Option<String>> {
    for e in parse_lines(&read_slice(file, 0, HEAD_BYTES)?) {
        let p = get(&e, "payload");
        let ty = get_str(&e, "type");
        if ty == Some("event_msg")
            && p.and_then(|p| get_str(p, "type")) == Some("user_message")
            && let Some(message) = p.and_then(|p| get_str(p, "message"))
            && !is_injected(message)
        {
            return Ok(Some(message.to_string()));
        }
        if ty == Some("response_item")
            && let Some(p) = p
            && get_str(p, "type") == Some("message")
            && get_str(p, "role") == Some("user")
            && let Some(Value::Array(content)) = get(p, "content")
        {
            let text = content.iter().map(|c| get_str(c, "text").unwrap_or("")).find(|t| !t.is_empty() && !is_injected(t));
            if let Some(text) = text {
                return Ok(Some(text.to_string()));
            }
        }
    }
    Ok(None)
}

/// A worktree of the project main knows from its cells (open or in closed grids).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeHint {
    pub path: String,
    pub branch: String,
}

/// `splitPath(path)`: the parent and the last name (trailing separators ignored).
fn split_path(path: &str) -> (String, String) {
    let trimmed = path.trim_end_matches(['\\', '/']);
    match trimmed.rfind(['/', '\\']) {
        Some(cut) => (trimmed[..cut].to_string(), trimmed[cut + 1..].to_string()),
        None => (String::new(), trimmed.to_string()),
    }
}

/// `worktreeMatcher(projectPath, known)`: whether a (normalized) cwd is a worktree folder of the project: one of the known
/// worktrees, or a sibling named `<project folder>-wt-<name>` the way createWorktree names them, so removed ones count too.
pub fn worktree_matcher(project_path: &str, known: &[WorktreeHint]) -> impl Fn(&str) -> bool + Send + Sync + 'static {
    let (parent, name) = split_path(project_path);
    let prefix = normalize_project_path(&format!("{parent}/{name}-wt-"));
    let exact: HashSet<String> = known.iter().map(|w| normalize_project_path(&w.path)).collect();
    let me = normalize_project_path(project_path);
    move |cwd: &str| {
        cwd != me
            && (exact.contains(cwd)
                || (cwd.starts_with(&prefix) && cwd.len() > prefix.len() && !cwd[prefix.len()..].contains(['\\', '/'])))
    }
}

/// The current branch of an existing worktree folder (for a resumed cell); None when git cannot tell.
pub type BranchOf<'a> = &'a (dyn Fn(&str) -> Option<String> + Sync);

/// The shared Codex index: the home it lists, when it was built, its entries.
type SharedIndex = (PathBuf, Instant, Arc<Vec<Arc<CodexEntry>>>);

/// The caches of the session listing (the module globals of sessions.ts).
#[derive(Default)]
pub struct SessionIndex {
    /// Parsed sessions keyed by file; reused while mtime and size are unchanged. Pruned per listed folder.
    claude: Mutex<HashMap<String, ClaudeEntry>>,
    claude_parses: std::sync::atomic::AtomicUsize,
    claude_tail_reads: std::sync::atomic::AtomicUsize,
    /// Parsed heads keyed by path; reused while the file's mtime is unchanged. Pruned to the files of the latest full listing.
    meta: Mutex<HashMap<String, Arc<CodexEntry>>>,
    /// Listings of session folders keyed by path, reused while the folder's mtime is unchanged.
    dirs: Mutex<HashMap<String, DirListing>>,
    dir_reads: std::sync::atomic::AtomicUsize,
    /// The newest rollout files with their heads, shared by every listing within INDEX_TTL; the lock is held while it is
    /// built, so concurrent callers share one build.
    index: Mutex<Option<SharedIndex>>,
}

fn key_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl SessionIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn claude_cache_stats(&self) -> ClaudeCacheStats {
        use std::sync::atomic::Ordering::SeqCst;
        ClaudeCacheStats {
            parses: self.claude_parses.load(SeqCst),
            tail_reads: self.claude_tail_reads.load(SeqCst),
            cached: self.claude.lock().len(),
        }
    }

    pub fn clear_claude_cache(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        self.claude.lock().clear();
        self.claude_parses.store(0, SeqCst);
        self.claude_tail_reads.store(0, SeqCst);
    }

    pub fn codex_cache_stats(&self) -> CodexCacheStats {
        CodexCacheStats {
            dir_reads: self.dir_reads.load(std::sync::atomic::Ordering::SeqCst),
            cached_dirs: self.dirs.lock().len(),
            cached_files: self.meta.lock().len(),
        }
    }

    pub fn clear_codex_cache(&self) {
        self.meta.lock().clear();
        self.dirs.lock().clear();
        *self.index.lock() = None;
        self.dir_reads.store(0, std::sync::atomic::Ordering::SeqCst);
    }

    // ── Claude ──

    fn read_claude_session(&self, file: &Path, st: &FileStat, hit: Option<&ClaudeEntry>) -> std::io::Result<ClaudeEntry> {
        use std::sync::atomic::Ordering::SeqCst;
        let reuse = can_reuse_head(hit, st);
        let head = match hit {
            Some(h) if reuse => h.head.clone(),
            _ => parse_claude_head(&read_slice(file, 0, HEAD_BYTES)?, st.size),
        };
        let tail = if st.size > HEAD_BYTES as u64 {
            parse_claude_tail(&read_slice(file, st.size.saturating_sub(TAIL_BYTES as u64), TAIL_BYTES)?, head.id.is_none())
        } else {
            ClaudeTail::default()
        };
        if reuse {
            self.claude_tail_reads.fetch_add(1, SeqCst);
        } else {
            self.claude_parses.fetch_add(1, SeqCst);
        }
        let info = claude_info(&head, &tail, st);
        Ok(ClaudeEntry { mtime_ms: st.mtime_ms, size: st.size, birthtime_ms: st.birthtime_ms, ino: st.ino, info, head })
    }

    /// Drops cache entries of `dir` whose files were not seen in the latest listing.
    fn prune_claude(&self, dir: &Path, seen: &HashSet<String>) {
        let prefix = format!("{}{MAIN_SEPARATOR}", key_of(dir));
        self.claude.lock().retain(|k, _| !k.starts_with(&prefix) || seen.contains(k));
    }

    fn list_claude_dir(&self, dir: &Path) -> Vec<SessionInfo> {
        let names: Vec<String> = match std::fs::read_dir(dir) {
            Ok(read) => read
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|f| f.ends_with(".jsonl"))
                .collect(),
            Err(_) => {
                self.prune_claude(dir, &HashSet::new());
                return Vec::new();
            }
        };
        let results = pool(None, &names, CONCURRENCY, |name| {
            let file = dir.join(name);
            let key = key_of(&file);
            let st = fsstat::stat(&file).ok()?;
            let hit = self.claude.lock().get(&key).cloned();
            let entry = match hit {
                Some(h) if h.mtime_ms == st.mtime_ms && h.size == st.size => h,
                hit => match self.read_claude_session(&file, &st, hit.as_ref()) {
                    Ok(entry) => {
                        self.claude.lock().insert(key.clone(), entry.clone());
                        entry
                    }
                    Err(_) => return Some((key, None)), // unreadable file - skip
                },
            };
            Some((key, entry.info))
        });
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (key, info) in results.into_iter().flatten() {
            seen.insert(key);
            out.extend(info);
        }
        self.prune_claude(dir, &seen);
        sorted(out)
    }

    /// `listClaudeSessionsAsync(home, projectPath)`.
    pub fn list_claude_sessions(&self, home: &Path, project_path: &str) -> Vec<SessionInfo> {
        self.list_claude_dir(&home.join(".claude").join("projects").join(claude_project_dir_name(project_path)))
    }

    /// Claude sessions of the worktree folders: the session folders whose encoded name can belong to one, checked by their cwd.
    fn list_claude_worktrees(
        &self,
        home: &Path,
        project_path: &str,
        worktrees: &[WorktreeHint],
        is_worktree: &dyn Fn(&str) -> bool,
    ) -> Result<Vec<SessionInfo>, SessionsError> {
        let root = home.join(".claude").join("projects");
        let (parent, name) = split_path(project_path);
        let prefix = claude_project_dir_name(&format!("{parent}/{name}-wt-"));
        let exact: HashSet<String> = worktrees.iter().map(|w| claude_project_dir_name(&w.path)).collect();
        let own = claude_project_dir_name(project_path);
        let Ok(read) = std::fs::read_dir(&root) else { return Ok(Vec::new()) };
        let dirs: Vec<String> = read
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| *n != own && (exact.contains(n) || (n.starts_with(&prefix) && len16(n) > len16(&prefix))))
            .collect();
        let mut out = Vec::new();
        for info in dirs.iter().flat_map(|d| self.list_claude_dir(&root.join(d))) {
            // The encoding is lossy (every non-alphanumeric character becomes '-'): the cwd recorded in the session decides.
            if truthy(&info.cwd) && is_worktree(&norm_value(&info.cwd)?) {
                out.push(info);
            }
        }
        Ok(out)
    }

    // ── Codex ──

    fn list_dir(&self, dir: &Path) -> std::io::Result<DirListing> {
        let key = key_of(dir);
        let mtime_ms = fsstat::stat(dir)?.mtime_ms;
        if let Some(hit) = self.dirs.lock().get(&key).filter(|h| h.mtime_ms == mtime_ms) {
            return Ok(hit.clone());
        }
        self.dir_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                dirs.push(name);
            } else if name.ends_with(".jsonl") {
                files.push(name);
            }
        }
        descending(&mut dirs);
        descending(&mut files);
        let listing = DirListing { mtime_ms, dirs, files };
        self.dirs.lock().insert(key, listing.clone());
        Ok(listing)
    }

    /// The newest `limit` rollout files. Paths are YYYY/MM/DD/rollout-<timestamp>-..., so walking every level in descending
    /// name order yields them newest first, and the walk stops as soon as it has enough (old day folders are not listed).
    fn codex_files(&self, home: &Path, limit: usize) -> Vec<PathBuf> {
        fn walk(me: &SessionIndex, dir: &Path, limit: usize, out: &mut Vec<PathBuf>) {
            let listing = match me.list_dir(dir) {
                Ok(l) => l,
                Err(_) => {
                    me.dirs.lock().remove(&key_of(dir));
                    return;
                }
            };
            for name in &listing.files {
                if out.len() >= limit {
                    return;
                }
                out.push(dir.join(name));
            }
            for name in &listing.dirs {
                if out.len() >= limit {
                    return;
                }
                walk(me, &dir.join(name), limit, out);
            }
        }
        let mut out = Vec::new();
        walk(self, &home.join(".codex").join("sessions"), limit, &mut out);
        out
    }

    fn codex_entry(&self, file: &Path) -> Option<Arc<CodexEntry>> {
        let key = key_of(file);
        let read = || -> std::io::Result<Arc<CodexEntry>> {
            let mtime_ms = fsstat::stat(file)?.mtime_ms;
            if let Some(hit) = self.meta.lock().get(&key).filter(|h| h.mtime_ms == mtime_ms) {
                return Ok(hit.clone());
            }
            let entry =
                Arc::new(CodexEntry { file: file.to_path_buf(), mtime_ms, meta: codex_meta(file)?, title: Mutex::new(None) });
            self.meta.lock().insert(key.clone(), entry.clone());
            Ok(entry)
        };
        match read() {
            Ok(e) => Some(e),
            Err(_) => {
                self.meta.lock().remove(&key);
                None
            }
        }
    }

    fn read_codex_entries(&self, home: &Path, limit: usize) -> Vec<Arc<CodexEntry>> {
        let files = self.codex_files(home, limit);
        let entries = pool(None, &files, CONCURRENCY, |f| self.codex_entry(f));
        if limit >= MAX_CODEX_FILES {
            let seen: HashSet<String> = files.iter().map(|f| key_of(f)).collect();
            self.meta.lock().retain(|k, _| seen.contains(k));
        }
        entries.into_iter().flatten().collect()
    }

    /// The shared index of the newest MAX_CODEX_FILES sessions (rebuilt at most every INDEX_TTL; concurrent callers share it).
    fn codex_index(&self, home: &Path) -> Arc<Vec<Arc<CodexEntry>>> {
        let mut slot = self.index.lock();
        if let Some((h, at, entries)) = slot.as_ref()
            && h == home
            && at.elapsed() < INDEX_TTL
        {
            return entries.clone();
        }
        let at = Instant::now();
        let entries = Arc::new(self.read_codex_entries(home, MAX_CODEX_FILES));
        *slot = Some((home.to_path_buf(), at, entries.clone()));
        entries
    }

    /// Codex sessions whose normalized cwd passes `wanted`.
    fn list_codex_where(&self, home: &Path, wanted: &dyn Fn(&str) -> bool) -> Result<Vec<SessionInfo>, SessionsError> {
        let mut out = Vec::new();
        for entry in self.codex_index(home).iter() {
            let Some(meta) = &entry.meta else { continue };
            if !wanted(&norm_value(&meta.cwd)?) {
                continue;
            }
            let title = {
                let mut t = entry.title.lock();
                if t.is_none() {
                    match codex_title(&entry.file) {
                        Ok(title) => *t = Some(title),
                        Err(_) => continue,
                    }
                }
                t.clone().flatten()
            };
            let Some(title) = title.filter(|t| !t.is_empty()) else { continue };
            out.push(SessionInfo {
                cli: "codex",
                id: meta.id.clone(),
                cwd: meta.cwd.clone(),
                title: clip(&title),
                started_at: match &meta.timestamp {
                    Some(ts) if truthy(ts) => date_of(ts),
                    _ => entry.mtime_ms,
                },
                updated_at: entry.mtime_ms,
                worktree: None,
            });
        }
        Ok(sorted(out))
    }

    /// `listCodexSessionsAsync(home, projectPath)`.
    pub fn list_codex_sessions(&self, home: &Path, project_path: &str) -> Result<Vec<SessionInfo>, SessionsError> {
        let want = normalize_project_path(project_path);
        self.list_codex_where(home, &|cwd| cwd == want)
    }

    /// `findRecentCodexSession(home, cwd, windowMs, exclude)`: the Codex session for `cwd` written within the last
    /// `window` and not bound elsewhere. Called right after a Codex cell finished a turn, when its rollout file was just
    /// appended to (so it reads the newest files itself, never the shared index).
    pub fn find_recent_codex_session(
        &self,
        home: &Path,
        cwd: &str,
        window: Duration,
        exclude: &HashSet<String>,
    ) -> Result<Option<Value>, SessionsError> {
        let want = normalize_project_path(cwd);
        let since = now_ms() - window.as_millis() as f64;
        let mut best: Option<(&Value, f64)> = None;
        let entries = self.read_codex_entries(home, RECENT_CODEX_FILES);
        for entry in &entries {
            let Some(meta) = &entry.meta else { continue };
            if entry.mtime_ms < since || meta.id.as_str().is_some_and(|id| exclude.contains(id)) {
                continue;
            }
            if norm_value(&meta.cwd)? != want {
                continue;
            }
            if best.is_none_or(|(_, m)| entry.mtime_ms > m) {
                best = Some((&meta.id, entry.mtime_ms));
            }
        }
        Ok(best.map(|(id, _)| id.clone()))
    }

    /// `listSessionsAsync(home, projectPath, worktrees, branchOf)`: the project's own conversations and those held in its
    /// worktree folders (labelled with the worktree branch or folder name, with `exists` false for a removed folder).
    pub fn list_sessions(
        &self,
        home: &Path,
        project_path: &str,
        worktrees: &[WorktreeHint],
        branch_of: Option<BranchOf<'_>>,
    ) -> Result<Vec<SessionInfo>, SessionsError> {
        let is_worktree = worktree_matcher(project_path, worktrees);
        let claude = self.list_claude_sessions(home, project_path);
        let codex = self.list_codex_sessions(home, project_path)?;
        let claude_wt = self.list_claude_worktrees(home, project_path, worktrees, &is_worktree)?;
        let codex_wt = self.list_codex_where(home, &is_worktree)?;
        let mut known: HashMap<String, String> = HashMap::new();
        for w in worktrees {
            known.insert(normalize_project_path(&w.path), w.branch.clone());
        }
        let mut branches: HashMap<String, Option<String>> = HashMap::new();
        let mut out = claude;
        out.extend(codex);
        for mut info in claude_wt.into_iter().chain(codex_wt) {
            let cwd = info.cwd.as_str().unwrap_or_default().to_string();
            let key = normalize_project_path(&cwd);
            let exists = Path::new(&cwd).exists();
            let mut branch = known.get(&key).cloned();
            if branch.as_deref().is_none_or(str::is_empty)
                && exists
                && let Some(branch_of) = branch_of
            {
                branch = branches.entry(key).or_insert_with(|| branch_of(&cwd)).clone();
            }
            let label = branch.clone().unwrap_or_else(|| split_path(&cwd).1);
            info.worktree = Some(WorktreeLabel { path: cwd, label, exists, branch });
            out.push(info);
        }
        Ok(sorted(out))
    }
}

/// Milliseconds since the epoch of a `SystemTime` (tests set file times with it).
pub fn system_time_of_ms(ms: f64) -> SystemTime {
    let whole = ms.floor();
    UNIX_EPOCH + Duration::from_millis(whole as u64) + Duration::from_nanos(((ms - whole) * 1e6).round() as u64)
}

#[cfg(test)]
mod tests;
