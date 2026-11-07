//! Search across every Claude Code and Codex conversation (H5; port of src/convsearch, src/shared/convSearch.ts and
//! src/main/convSearchClient.ts of 1.1.4).
//!
//! - [`text`]: UTF-16 strings, `toLowerCase`, the same-length `fold()`, `indexOf` with memchr.
//! - [`search`]: query terms, matches with snippets, `searchDocs`.
//! - [`parse`]: byte prefilters and the Claude / Codex line readers, `readLines`.
//! - [`date`]: `Date.parse` for transcript timestamps.
//! - [`indexer`]: the index (incremental passes, concurrency 24 / 6, transcript preview), saved to
//!   `conversation-index-v2.bin` ([`cache`]); 1.1.4's v8-serialized `conversation-index.bin` is never read or written.
//! - [`export`]: the Markdown export data and `locateSession`.
//! - [`service`]: what replaces the eval'd worker: started on the first request, stopped after 10 minutes without one (after
//!   saving), 60 s / 120 s timeouts, and the IPC sanitizers.

pub mod cache;
pub mod date;
pub mod export;
pub mod indexer;
pub mod parse;
pub mod paths;
pub mod search;
pub mod service;
pub mod text;

use std::io;

use serde_json::Value;

pub use indexer::{Indexer, IndexerOptions};
pub use search::{ConvDoc, ConvQuery};
pub use service::ConvSearchService;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub enum ConvCli {
    #[default]
    Claude,
    Codex,
}

impl ConvCli {
    pub fn as_str(self) -> &'static str {
        match self {
            ConvCli::Claude => "claude",
            ConvCli::Codex => "codex",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(ConvCli::Claude),
            "codex" => Some(ConvCli::Codex),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvRole {
    User,
    Assistant,
}

impl ConvRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ConvRole::User => "user",
            ConvRole::Assistant => "assistant",
        }
    }
}

/// The CLI folders: Claude config folders (their `projects` subfolder is read) and Codex homes (their `sessions`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Roots {
    pub claude: Vec<String>,
    pub codex: Vec<String>,
}

impl Roots {
    /// What 1.1.4's main passed the worker: `CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')` and the same with
    /// CODEX_HOME / `.codex`.
    pub fn from_env() -> Self {
        let home = unimux_core::home::home_dir().to_string_lossy().to_string();
        let pick = |var: &str, dot: &str| match std::env::var(var) {
            Ok(v) if !text::trim(&v).is_empty() => text::trim(&v).to_string(),
            _ => paths::join(&home, &[dot]),
        };
        Self { claude: vec![pick("CLAUDE_CONFIG_DIR", ".claude")], codex: vec![pick("CODEX_HOME", ".codex")] }
    }
}

/// Limits of the index (the transcript preview reads the file again with its own, larger ones).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub message_chars: usize,
    pub doc_chars: usize,
}

pub const INDEX_LIMITS: Limits = Limits { message_chars: 4000, doc_chars: 600_000 };
pub const TRANSCRIPT_LIMITS: Limits = Limits { message_chars: 40_000, doc_chars: 4_000_000 };

/// A JavaScript number as JSON: whole values as integers (as JSON.stringify writes them), NaN / Infinity as null.
pub fn num(v: f64) -> Value {
    if !v.is_finite() {
        return Value::Null;
    }
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        return Value::from(v as i64);
    }
    serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
}

/// `clip(meta.custom ?? meta.ai ?? meta.prompt ?? '')`: whitespace runs to one space, trimmed, 160 code units.
pub fn clip_title(meta: &parse::ConvMeta) -> String {
    let src = meta.custom.as_deref().or(meta.ai.as_deref()).or(meta.prompt.as_deref()).unwrap_or("");
    text::slice16(text::trim(&text::collapse_space(src)), 160)
}

/// An fs error as Node words it (`ENOENT: no such file or directory, open 'C:\x'`).
pub fn node_error(e: &io::Error, syscall: &str, path: &str) -> String {
    let (code, text) = node_code(e);
    format!("{code}: {text}, {syscall} '{path}'")
}

fn node_code(e: &io::Error) -> (&'static str, &'static str) {
    #[cfg(windows)]
    let code = match e.raw_os_error() {
        Some(2 | 3 | 15 | 123 | 161) => Some(("ENOENT", "no such file or directory")),
        Some(5) => Some(("EPERM", "operation not permitted")),
        Some(32 | 33) => Some(("EBUSY", "resource busy or locked")),
        Some(4) => Some(("EMFILE", "too many open files")),
        Some(267) => Some(("ENOTDIR", "not a directory")),
        _ => None,
    };
    #[cfg(not(windows))]
    let code = match e.raw_os_error() {
        Some(2) => Some(("ENOENT", "no such file or directory")),
        Some(13) => Some(("EACCES", "permission denied")),
        Some(1) => Some(("EPERM", "operation not permitted")),
        Some(21) => Some(("EISDIR", "illegal operation on a directory")),
        Some(20) => Some(("ENOTDIR", "not a directory")),
        Some(16) => Some(("EBUSY", "resource busy or locked")),
        Some(24) => Some(("EMFILE", "too many open files")),
        _ => None,
    };
    code.unwrap_or(match e.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        _ => ("EIO", "i/o error"),
    })
}
