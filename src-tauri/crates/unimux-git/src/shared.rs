//! Port of src/shared/git.ts (G2): the result shapes, the limits, the request validation, the clone address checks, the output
//! parsers (status, refs, log, details, diff-tree, branches, worktrees, unified diff), the commit graph and the panel's path
//! helpers. Pure: nothing here runs a process or touches the disk. JavaScript semantics are kept where they decide a result:
//! lengths and `slice` count UTF-16 units, `/i` folds ASCII only, `\s` / `trim` use the ECMAScript white space set, `.` does
//! not match line terminators, `toLowerCase` is the full Unicode mapping. Checked against test/golden/git-shared.jsonl
//! (scripts/goldens-git.mjs) and the cases of test/git-shared.test.ts / git-trust-shared.test.ts (tests/shared.rs).

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::js::{self, JS_LINE_TERMINATORS, JsNum, first_unit, len as jlen, slice, slice_from};
use crate::text::js_trim;

fn is_false(b: &bool) -> bool {
    !*b
}

// ---------- limits ----------

pub const GIT_LOG_PAGE: u32 = 50;
pub const GIT_LOG_MAX_PAGE: u32 = 200;
pub const GIT_LOG_MAX_SKIP: u32 = 1_000_000;
pub const GIT_MAX_PATHS: usize = 2000;
pub const GIT_MAX_FILES: usize = 3000;
pub const GIT_COMMIT_FILE_LIMIT: usize = 500;
pub const GIT_MESSAGE_LIMIT: usize = 20_000;
pub const GIT_DIFF_LINES: usize = 4000;

/// `'Nieprawidłowe żądanie git.'` (the answer of every refused request).
pub const INVALID_REQUEST: &str = "Nieprawidłowe żądanie git.";
pub const INVALID_CLONE_URL: &str = "Podaj adres repozytorium: https://…, ssh://… albo git@host:ścieżka.";

// ---------- result shapes ----------

/// `GitFileChange`. `x` / `y` are None only where git.ts reads past the end of an empty status field (JS undefined: the key
/// is then missing from the JSON, like 1.1.4 sends it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflict: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RelationKind {
    InsideRoot,
    ContainsRoot,
}

/// `GitProjectRelation`: `inside-root` (the project is `prefix` below the root, '' = the root), `contains-root` (the root is
/// `prefix` below the project).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitProjectRelation {
    pub kind: RelationKind,
    pub prefix: String,
}

/// `GitPushTarget`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushTarget {
    pub remote: String,
    pub branch: String,
    pub set_upstream: bool,
    pub url: String,
    pub url_id: String,
}

/// `GitStatus` (built by G3's status from [`ParsedStatus`]; the keys in the order 1.1.4 sends them).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub head: String,
    pub initial: bool,
    pub upstream: Option<String>,
    pub ahead: JsNum,
    pub behind: JsNum,
    pub files: Vec<GitFileChange>,
    pub truncated: bool,
    pub root: String,
    pub push: Option<GitPushTarget>,
    pub parent: bool,
    pub project_relation: Option<GitProjectRelation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_remote: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Head,
    Branch,
    Remote,
    Tag,
}

/// `GitRef` (`current` only on HEAD and the checked out branch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitRef {
    pub name: String,
    pub kind: RefKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<bool>,
}

/// `GitCommit`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    /// Seconds since the epoch (`Number(text) || 0`).
    pub at: JsNum,
    pub refs: Vec<GitRef>,
    pub subject: String,
}

/// `GitLogPage`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogPage {
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
}

/// `GitCommitFile`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    pub path: String,
    pub added: Option<JsNum>,
    pub deleted: Option<JsNum>,
}

/// `GitCommitDetails`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub commit: GitCommit,
    pub email: String,
    pub message: String,
    pub files: Vec<GitCommitFile>,
    pub files_truncated: bool,
    pub added: JsNum,
    pub deleted: JsNum,
}

/// `GitBranch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitBranch {
    pub name: String,
    pub hash: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
    pub track: String,
}

/// `GitWorktree`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub main: bool,
    pub detached: bool,
    pub allowed: bool,
    pub is_project: bool,
    pub preferred: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrustState {
    Safe,
    Trusted,
    Untrusted,
}

/// `GitTrustInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitTrustInfo {
    pub state: TrustState,
    pub keys: Vec<String>,
    pub root: String,
    pub parent: bool,
}

/// `GitDiffResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitDiffResult {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

/// `GitOpResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitOpResult {
    pub message: String,
}

// ---------- requests ----------

/// `GitDiffSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitDiffSource {
    Working,
    Staged,
    Commit,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct GitBaseRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct GitTrustRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// Only present when true.
    #[serde(skip_serializing_if = "is_false")]
    pub cached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitLogRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub skip: u32,
    pub count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitShowRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub source: GitDiffSource,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

/// `GitMutation` (fetch, pull, trustGrant, trustRevoke).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMutation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub request_id: String,
    pub remote: String,
    pub branch: String,
    pub url_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPathsRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub request_id: String,
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub request_id: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub request_id: String,
    pub branch: String,
    #[serde(skip_serializing_if = "is_false")]
    pub remote: bool,
}

/// `GitChannel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GitChannel {
    Status,
    Log,
    Show,
    Diff,
    Branches,
    Fetch,
    Pull,
    Push,
    Stage,
    Unstage,
    Commit,
    Checkout,
    Trust,
    TrustGrant,
    TrustRevoke,
}

impl GitChannel {
    pub const ALL: [GitChannel; 15] = [
        Self::Status,
        Self::Log,
        Self::Show,
        Self::Diff,
        Self::Branches,
        Self::Fetch,
        Self::Pull,
        Self::Push,
        Self::Stage,
        Self::Unstage,
        Self::Commit,
        Self::Checkout,
        Self::Trust,
        Self::TrustGrant,
        Self::TrustRevoke,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Log => "log",
            Self::Show => "show",
            Self::Diff => "diff",
            Self::Branches => "branches",
            Self::Fetch => "fetch",
            Self::Pull => "pull",
            Self::Push => "push",
            Self::Stage => "stage",
            Self::Unstage => "unstage",
            Self::Commit => "commit",
            Self::Checkout => "checkout",
            Self::Trust => "trust",
            Self::TrustGrant => "trustGrant",
            Self::TrustRevoke => "trustRevoke",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == name)
    }

    /// `MUTATING_CHANNELS`.
    pub fn is_mutating(self) -> bool {
        matches!(
            self,
            Self::Fetch
                | Self::Pull
                | Self::Push
                | Self::Stage
                | Self::Unstage
                | Self::Commit
                | Self::Checkout
                | Self::TrustGrant
                | Self::TrustRevoke
        )
    }
}

/// A checked request (`GitRequestMap[C]`); serializes to the object `validateGitRequest` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum GitRequest {
    /// status, branches
    Base(GitBaseRequest),
    Trust(GitTrustRequest),
    Log(GitLogRequest),
    Show(GitShowRequest),
    Diff(GitDiffRequest),
    /// fetch, pull, trustGrant, trustRevoke
    Mutation(GitMutation),
    Push(GitPushRequest),
    /// stage, unstage
    Paths(GitPathsRequest),
    Commit(GitCommitRequest),
    Checkout(GitCheckoutRequest),
}

impl GitRequest {
    /// The worktree the renderer named (main resolves it against the repository's own list).
    pub fn worktree(&self) -> Option<&str> {
        match self {
            Self::Base(r) => r.worktree.as_deref(),
            Self::Trust(r) => r.worktree.as_deref(),
            Self::Log(r) => r.worktree.as_deref(),
            Self::Show(r) => r.worktree.as_deref(),
            Self::Diff(r) => r.worktree.as_deref(),
            Self::Mutation(r) => r.worktree.as_deref(),
            Self::Push(r) => r.worktree.as_deref(),
            Self::Paths(r) => r.worktree.as_deref(),
            Self::Commit(r) => r.worktree.as_deref(),
            Self::Checkout(r) => r.worktree.as_deref(),
        }
    }

    /// The request id of a mutation.
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::Mutation(r) => Some(&r.request_id),
            Self::Push(r) => Some(&r.request_id),
            Self::Paths(r) => Some(&r.request_id),
            Self::Commit(r) => Some(&r.request_id),
            Self::Checkout(r) => Some(&r.request_id),
            _ => None,
        }
    }
}

// ---------- validation ----------

static HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-fA-F]{4,64}$").expect("hash regex"));
static REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._/@+\-]*$").expect("ref regex"));
static REMOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._\-]*$").expect("remote regex"));
static REQUEST_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_\-]{8,64}$").expect("request id regex"));
static URL_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{16}$").expect("url id regex"));

fn as_str(value: &Value) -> Option<&str> {
    value.as_str()
}

/// `isCommitHash`.
pub fn is_commit_hash(value: &Value) -> bool {
    as_str(value).is_some_and(is_commit_hash_str)
}

pub fn is_commit_hash_str(value: &str) -> bool {
    HASH.is_match(value)
}

/// `isSafeRef`: a branch or tag name that is safe on a git command line.
pub fn is_safe_ref(value: &Value) -> bool {
    as_str(value).is_some_and(is_safe_ref_str)
}

pub fn is_safe_ref_str(value: &str) -> bool {
    if value.is_empty() || jlen(value) > 200 || !REF.is_match(value) {
        return false;
    }
    if value.contains("..")
        || value.contains("@{")
        || value.contains("//")
        || value.ends_with('/')
        || value.ends_with('.')
        || value == "@"
    {
        return false;
    }
    value.split('/').all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

/// `isSafeRemote`.
pub fn is_safe_remote(value: &Value) -> bool {
    as_str(value).is_some_and(is_safe_remote_str)
}

pub fn is_safe_remote_str(value: &str) -> bool {
    jlen(value) <= 100 && REMOTE.is_match(value) && !value.contains("..")
}

/// `isRequestId`.
pub fn is_request_id(value: &Value) -> bool {
    as_str(value).is_some_and(|s| REQUEST_ID.is_match(s))
}

fn has_control(value: &str, del: bool) -> bool {
    value.chars().any(|c| (c as u32) < 0x20 || (del && c == '\x7f'))
}

/// `normalizeRepoPath(value, windows)`: a path inside the repository as git prints it, or None.
pub fn normalize_repo_path(value: &Value, windows: bool) -> Option<String> {
    normalize_repo_path_str(as_str(value)?, windows)
}

pub fn normalize_repo_path_str(value: &str, windows: bool) -> Option<String> {
    if value.is_empty() || jlen(value) > 1000 || has_control(value, true) {
        return None;
    }
    let path = if windows { value.replace('\\', "/") } else { value.to_string() };
    let b = path.as_bytes();
    if path.starts_with('/') || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    let last = parts.len() - 1;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() && i == last && i > 0 {
            continue; // the trailing "/" of a folder
        }
        if part.is_empty() || *part == "." || *part == ".." || part.to_lowercase() == ".git" {
            return None;
        }
        if windows {
            // NTFS: ".git." and ".git " name the .git folder, "GIT~1" is its 8.3 alias, "a:stream" is a data stream.
            if part.contains(':') || part.ends_with('.') || part.ends_with(' ') || tilde_digit(part) {
                return None;
            }
            if part.trim_end_matches(['.', ' ']).to_lowercase() == ".git" {
                return None;
            }
        }
    }
    Some(path)
}

/// `/~\d/` (ASCII digits).
fn tilde_digit(part: &str) -> bool {
    part.as_bytes().windows(2).any(|w| w[0] == b'~' && w[1].is_ascii_digit())
}

/// What `text(value, max)` of validateGitRequest gives: undefined, null (refused) or the string.
enum Text {
    Undefined,
    Bad,
    Ok(String),
}

fn text(value: Option<&Value>, max: usize) -> Text {
    match value {
        None => Text::Undefined,
        Some(Value::String(s)) if jlen(s) <= max && !s.contains('\0') => Text::Ok(s.clone()),
        Some(_) => Text::Bad,
    }
}

/// `typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max`, as an integer.
fn whole(value: &Value, min: f64, max: f64) -> Option<u32> {
    let n = value.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n >= min && n <= max).then_some(n as u32)
}

/// `input.x ?? fallback` (null counts as missing).
fn or_default<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    input.get(key).filter(|v| !v.is_null())
}

/// `x !== undefined && typeof x !== 'boolean'`: a present non-boolean.
fn bad_flag(input: &Map<String, Value>, key: &str) -> bool {
    input.get(key).is_some_and(|v| !v.is_boolean())
}

fn flag(input: &Map<String, Value>, key: &str) -> bool {
    input.get(key) == Some(&Value::Bool(true))
}

/// `validateGitRequest(channel, input, windows)`: checks (and normalizes) what the renderer sent for a channel; unknown
/// fields are dropped, every value is bounds-checked. The error is always [`INVALID_REQUEST`].
pub fn validate_git_request(channel: GitChannel, input: &Value, windows: bool) -> Result<GitRequest, String> {
    let invalid = || Err(INVALID_REQUEST.to_string());
    let Value::Object(input) = input else { return invalid() };
    let worktree = match text(input.get("worktree"), 1000) {
        Text::Bad => return invalid(),
        Text::Undefined => None,
        Text::Ok(s) if s.is_empty() => None,
        Text::Ok(s) => Some(s),
    };
    let request_id = || input.get("requestId").filter(|v| is_request_id(v)).and_then(Value::as_str).map(str::to_string);
    match channel {
        GitChannel::Status | GitChannel::Branches => Ok(GitRequest::Base(GitBaseRequest { worktree })),
        GitChannel::Trust => {
            if bad_flag(input, "cached") {
                return invalid();
            }
            Ok(GitRequest::Trust(GitTrustRequest { worktree, cached: flag(input, "cached") }))
        }
        GitChannel::Log => {
            let skip = match or_default(input, "skip") {
                None => 0,
                Some(v) => match whole(v, 0.0, f64::from(GIT_LOG_MAX_SKIP)) {
                    Some(n) => n,
                    None => return invalid(),
                },
            };
            let count = match or_default(input, "count") {
                None => GIT_LOG_PAGE,
                Some(v) => match whole(v, 1.0, f64::from(GIT_LOG_MAX_PAGE)) {
                    Some(n) => n,
                    None => return invalid(),
                },
            };
            let search = match text(input.get("search"), 200) {
                Text::Bad => return invalid(),
                Text::Undefined => None,
                Text::Ok(s) => Some(s).filter(|s| !s.is_empty()),
            };
            let author = match text(input.get("author"), 100) {
                Text::Bad => return invalid(),
                Text::Undefined => None,
                Text::Ok(s) => Some(s).filter(|s| !s.is_empty()),
            };
            let path = match input.get("path") {
                None => None,
                Some(Value::String(s)) if s.is_empty() => None,
                Some(v) => match normalize_repo_path(v, windows) {
                    Some(p) => Some(p),
                    None => return invalid(),
                },
            };
            if bad_flag(input, "all") {
                return invalid();
            }
            Ok(GitRequest::Log(GitLogRequest { worktree, skip, count, search, author, path, all: flag(input, "all") }))
        }
        GitChannel::Show => match input.get("hash") {
            Some(Value::String(h)) if is_commit_hash_str(h) => Ok(GitRequest::Show(GitShowRequest { worktree, hash: h.clone() })),
            _ => invalid(),
        },
        GitChannel::Diff => {
            let source = match input.get("source").and_then(Value::as_str) {
                Some("working") => GitDiffSource::Working,
                Some("staged") => GitDiffSource::Staged,
                Some("commit") => GitDiffSource::Commit,
                Some("untracked") => GitDiffSource::Untracked,
                _ => return invalid(),
            };
            let Some(path) = input.get("path").and_then(|v| normalize_repo_path(v, windows)) else { return invalid() };
            let old_path = match input.get("oldPath") {
                None => None,
                Some(v) => match normalize_repo_path(v, windows) {
                    Some(p) => Some(p),
                    None => return invalid(),
                },
            };
            let hash = if source == GitDiffSource::Commit {
                match input.get("hash") {
                    Some(Value::String(h)) if is_commit_hash_str(h) => Some(h.clone()),
                    _ => return invalid(),
                }
            } else {
                None
            };
            Ok(GitRequest::Diff(GitDiffRequest { worktree, source, path, old_path, hash }))
        }
        GitChannel::Fetch | GitChannel::Pull | GitChannel::TrustGrant | GitChannel::TrustRevoke => match request_id() {
            Some(request_id) => Ok(GitRequest::Mutation(GitMutation { worktree, request_id })),
            None => invalid(),
        },
        GitChannel::Push => {
            let Some(request_id) = request_id() else { return invalid() };
            let (Some(remote), Some(branch), Some(url_id)) = (
                input.get("remote").and_then(Value::as_str).filter(|s| is_safe_remote_str(s)),
                input.get("branch").and_then(Value::as_str).filter(|s| is_safe_ref_str(s)),
                input.get("urlId").and_then(Value::as_str).filter(|s| URL_ID.is_match(s)),
            ) else {
                return invalid();
            };
            Ok(GitRequest::Push(GitPushRequest {
                worktree,
                request_id,
                remote: remote.into(),
                branch: branch.into(),
                url_id: url_id.into(),
            }))
        }
        GitChannel::Stage | GitChannel::Unstage => {
            let Some(request_id) = request_id() else { return invalid() };
            let all = flag(input, "all");
            if bad_flag(input, "all") {
                return invalid();
            }
            let empty = Vec::new();
            let list = match input.get("paths") {
                Some(Value::Array(items)) => items,
                None if all => &empty,
                _ => return invalid(),
            };
            if list.len() > GIT_MAX_PATHS || (!all && list.is_empty()) {
                return invalid();
            }
            let mut paths = Vec::with_capacity(list.len());
            for entry in list {
                match normalize_repo_path(entry, windows) {
                    Some(p) => paths.push(p),
                    None => return invalid(),
                }
            }
            Ok(GitRequest::Paths(GitPathsRequest { worktree, request_id, paths, all }))
        }
        GitChannel::Commit => {
            let id = request_id();
            let message = match text(input.get("message"), GIT_MESSAGE_LIMIT) {
                Text::Ok(m) => m,
                _ => return invalid(),
            };
            match id {
                Some(request_id) if !js_trim(&message).is_empty() => {
                    Ok(GitRequest::Commit(GitCommitRequest { worktree, request_id, message }))
                }
                _ => invalid(),
            }
        }
        GitChannel::Checkout => {
            let Some(request_id) = request_id() else { return invalid() };
            let Some(branch) = input.get("branch").and_then(Value::as_str).filter(|s| is_safe_ref_str(s)) else {
                return invalid();
            };
            if bad_flag(input, "remote") {
                return invalid();
            }
            Ok(GitRequest::Checkout(GitCheckoutRequest {
                worktree,
                request_id,
                branch: branch.into(),
                remote: flag(input, "remote"),
            }))
        }
    }
}

// ---------- clone ----------

static SCP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9_][A-Za-z0-9._\-]*)@([A-Za-z0-9][A-Za-z0-9.\-]*):([^\\:]+)$").expect("scp regex"));

/// `isCloneUrl`: https://host/path, ssh://[user@]host[:port]/path or the scp form user@host:path; nothing else. The URL is
/// parsed with the WHATWG URL parser (the `url` crate), like `new URL()`.
pub fn is_clone_url(value: &Value) -> bool {
    as_str(value).is_some_and(is_clone_url_str)
}

pub fn is_clone_url_str(value: &str) -> bool {
    let n = jlen(value);
    if !(8..=2000).contains(&n) {
        return false;
    }
    if value.chars().any(|c| (c as u32) < 0x20 || c == '\x7f' || crate::text::is_js_space(c))
        || value.starts_with('-')
        || value.contains("::")
    {
        return false;
    }
    if let Some(m) = SCP.captures(value) {
        let path = &m[3];
        return !path.starts_with('-') && !path.contains("..");
    }
    let Ok(url) = url::Url::parse(value) else { return false };
    let hostname = url.host_str().unwrap_or("");
    let search = url.query().unwrap_or("");
    let hash = url.fragment().unwrap_or("");
    if hostname.is_empty() || hostname.starts_with('-') || jlen(url.path()) < 2 || !search.is_empty() || !hash.is_empty() {
        return false;
    }
    let password = url.password().unwrap_or("");
    match url.scheme() {
        "https" => url.username().is_empty() && password.is_empty(),
        "ssh" => password.is_empty() && !url.username().starts_with('-'),
        _ => false,
    }
}

static QUERY_TAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"[?#][^{JS_LINE_TERMINATORS}]*$")).expect("query regex"));
static TRAILING_SEPARATORS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/]+$").expect("separators regex"));
static FORBIDDEN_NAME_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1f]"#).expect("forbidden regex"));
static TRAILING_DOTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[. ]+$").expect("dots regex"));
static LEADING_DOTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[.\-]+").expect("leading regex"));
static RESERVED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)^(con|prn|aux|nul|com[0-9]|lpt[0-9])$").expect("reserved regex"));
static RESERVED_EXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^(?i-u:con|prn|aux|nul|com[0-9]|lpt[0-9])(\.[^{JS_LINE_TERMINATORS}]*)?$")).expect("reserved regex")
});
static GIT_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)\.git$").expect("suffix regex"));

/// `cloneFolderName`: the folder name `git clone` would choose, made safe for every file system.
pub fn clone_folder_name(url: &str) -> String {
    let path = QUERY_TAIL.replace(url, "");
    let path = TRAILING_SEPARATORS.replace(&path, "");
    let last = path.split(['/', ':']).next_back().unwrap_or("");
    let name = GIT_SUFFIX.replace(last, "");
    let name = FORBIDDEN_NAME_CHARS.replace_all(&name, "-");
    let name = TRAILING_DOTS.replace(&name, "");
    let name = LEADING_DOTS.replace(&name, "").into_owned();
    if name.is_empty() {
        return "repo".into();
    }
    if RESERVED.is_match(&name) { format!("{name}-repo") } else { slice(&name, 0, 100) }
}

/// `isSafeFolderName`: a single folder name (no separator, no "..", nothing Windows refuses).
pub fn is_safe_folder_name(value: &Value) -> bool {
    as_str(value).is_some_and(is_safe_folder_name_str)
}

pub fn is_safe_folder_name_str(value: &str) -> bool {
    if value.is_empty() || jlen(value) > 100 || value == "." || value == ".." {
        return false;
    }
    !FORBIDDEN_NAME_CHARS.is_match(value)
        && !value.ends_with('.')
        && !value.ends_with(' ')
        && !value.starts_with('-')
        && !RESERVED_EXT.is_match(value)
}

/// `GitCloneRequest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum GitCloneRequest {
    #[serde(rename_all = "camelCase")]
    Project {
        url: String,
        project_id: String,
    },
    Folder {
        url: String,
        parent: String,
        name: String,
    },
}

/// `validateCloneRequest`: `parent` must be an absolute path.
pub fn validate_clone_request(input: &Value) -> Result<GitCloneRequest, String> {
    let invalid = || Err(INVALID_REQUEST.to_string());
    let Value::Object(input) = input else { return invalid() };
    let url = match input.get("url").and_then(Value::as_str) {
        Some(u) if is_clone_url_str(u) => u.to_string(),
        _ => return Err(INVALID_CLONE_URL.to_string()),
    };
    if let Some(Value::String(id)) = input.get("projectId")
        && !id.is_empty()
        && jlen(id) <= 200
    {
        return Ok(GitCloneRequest::Project { url, project_id: id.clone() });
    }
    let parent = match text(input.get("parent"), 1000) {
        Text::Ok(p) if !p.is_empty() => p,
        _ => return invalid(),
    };
    let b = parent.as_bytes();
    let absolute = parent.starts_with('/')
        || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || (b.len() >= 3 && b[0] == b'\\' && b[1] == b'\\' && b[2] != b'\\');
    if has_control(&parent, false) || !absolute {
        return invalid();
    }
    match input.get("name").and_then(Value::as_str) {
        Some(name) if is_safe_folder_name_str(name) => Ok(GitCloneRequest::Folder { url, parent, name: name.into() }),
        _ => invalid(),
    }
}

// ---------- parsers ----------

/// Splits `n` space separated fields off the start of a record; the rest (a path that may hold spaces) is the last element.
fn fields(record: &str, n: usize) -> Vec<&str> {
    let mut out = Vec::with_capacity(n + 1);
    let mut rest = record;
    for _ in 0..n {
        let Some(space) = rest.find(' ') else { return Vec::new() };
        out.push(&rest[..space]);
        rest = &rest[space + 1..];
    }
    out.push(rest);
    out
}

/// `ParsedStatus`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParsedStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub head: String,
    pub initial: bool,
    pub upstream: Option<String>,
    pub ahead: JsNum,
    pub behind: JsNum,
    pub files: Vec<GitFileChange>,
    pub truncated: bool,
}

static BRANCH_AB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\+([0-9]+) -([0-9]+)$").expect("ab regex"));

fn change(path: &str, xy: &str) -> GitFileChange {
    let dot = |c: Option<String>| c.map(|c| if c == "." { " ".to_string() } else { c });
    let x = dot(js::unit_at(xy, 0));
    let y = dot(js::unit_at(xy, 1));
    GitFileChange {
        path: path.into(),
        staged: x.as_deref() != Some(" "),
        unstaged: y.as_deref() != Some(" "),
        x,
        y,
        untracked: false,
        conflict: false,
        orig_path: None,
    }
}

/// `parseStatusV2(stdout, limit = GIT_MAX_FILES)`: `git status --porcelain=v2 --branch -z`.
pub fn parse_status_v2(stdout: &str, limit: usize) -> ParsedStatus {
    let mut out = ParsedStatus {
        branch: None,
        detached: false,
        head: String::new(),
        initial: false,
        upstream: None,
        ahead: JsNum(0.0),
        behind: JsNum(0.0),
        files: Vec::new(),
        truncated: false,
    };
    let records: Vec<&str> = stdout.split('\0').collect();
    let add = |out: &mut ParsedStatus, file: GitFileChange| {
        if out.files.len() >= limit {
            out.truncated = true;
        } else {
            out.files.push(file);
        }
    };
    let mut i = 0;
    while i < records.len() {
        let record = records[i];
        if record.is_empty() {
            i += 1;
            continue;
        }
        if let Some(rest) = record.strip_prefix("# ") {
            let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
            match key {
                "branch.oid" => {
                    out.initial = value == "(initial)";
                    out.head = if out.initial { String::new() } else { slice(value, 0, 7) };
                }
                "branch.head" => {
                    out.detached = value == "(detached)";
                    out.branch = if out.detached { None } else { Some(value.into()) };
                }
                "branch.upstream" => out.upstream = Some(value.into()),
                "branch.ab" => {
                    if let Some(m) = BRANCH_AB.captures(value) {
                        out.ahead = JsNum(js::js_number(&m[1]));
                        out.behind = JsNum(js::js_number(&m[2]));
                    }
                }
                _ => {}
            }
            i += 1;
            continue;
        }
        match record.chars().next() {
            Some('1') => {
                let f = fields(record, 8);
                if f.len() == 9 {
                    add(&mut out, change(f[8], f[1]));
                }
            }
            Some('2') => {
                let f = fields(record, 9);
                i += 1;
                let orig = records.get(i).copied().unwrap_or("");
                if f.len() == 10 {
                    add(&mut out, GitFileChange { orig_path: Some(orig.into()), ..change(f[9], f[1]) });
                }
            }
            Some('u') => {
                let f = fields(record, 10);
                if f.len() == 11 {
                    let x = js::unit_at(f[1], 0).unwrap_or_else(|| "U".into());
                    let y = js::unit_at(f[1], 1).unwrap_or_else(|| "U".into());
                    add(
                        &mut out,
                        GitFileChange {
                            path: f[10].into(),
                            x: Some(x),
                            y: Some(y),
                            staged: false,
                            unstaged: false,
                            untracked: false,
                            conflict: true,
                            orig_path: None,
                        },
                    );
                }
            }
            Some('?') => add(
                &mut out,
                GitFileChange {
                    path: slice_from(record, 2),
                    x: Some("?".into()),
                    y: Some("?".into()),
                    staged: false,
                    unstaged: false,
                    untracked: true,
                    conflict: false,
                    orig_path: None,
                },
            ),
            // "!" (ignored) is not requested; anything else is a record of a newer git that this panel does not know
            _ => {}
        }
        i += 1;
    }
    out
}

/// `parseRefs`: the ref list of `%D` printed with `--decorate=full`.
pub fn parse_refs(value: &str) -> Vec<GitRef> {
    let mut refs = Vec::new();
    for raw in value.split(", ") {
        let item = js_trim(raw);
        if item.is_empty() {
            continue;
        }
        if item == "HEAD" {
            refs.push(GitRef { name: "HEAD".into(), kind: RefKind::Head, current: Some(true) });
            continue;
        }
        let current = item.starts_with("HEAD -> ");
        let full = if current { &item[8..] } else { item };
        if let Some(name) = full.strip_prefix("tag: refs/tags/") {
            refs.push(GitRef { name: name.into(), kind: RefKind::Tag, current: None });
        } else if let Some(name) = full.strip_prefix("refs/heads/") {
            refs.push(GitRef { name: name.into(), kind: RefKind::Branch, current: current.then_some(true) });
        } else if let Some(name) = full.strip_prefix("refs/remotes/")
            && !name.ends_with("/HEAD")
        {
            refs.push(GitRef { name: name.into(), kind: RefKind::Remote, current: None });
        }
        // refs/stash, refs/notes ... stay out of the list
    }
    refs
}

/// The `--format` the log and the details use; parsed by [`parse_commit`].
pub const LOG_FORMAT: &str = "%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s";
/// `git show -s --format=DETAILS_FORMAT`: the commit line fields, the e-mail and the full message.
pub const DETAILS_FORMAT: &str = "%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1f%ae%x1f%B";
/// `git for-each-ref` with this format is what [`parse_branches`] reads.
pub const BRANCH_FORMAT: &str =
    "%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)";

/// `Number(text) || 0`.
fn number_or_zero(text: &str) -> f64 {
    let n = js::js_number(text);
    if n.is_nan() || n == 0.0 { 0.0 } else { n }
}

/// `parseCommit(record)`.
pub fn parse_commit(record: &str) -> Option<GitCommit> {
    let f: Vec<&str> = record.split('\x1f').collect();
    if f.len() < 7 || !is_commit_hash_str(f[0]) {
        return None;
    }
    Some(GitCommit {
        hash: f[0].into(),
        short: f[1].into(),
        parents: if f[2].is_empty() {
            Vec::new()
        } else {
            f[2].split(' ').filter(|p| !p.is_empty()).map(str::to_string).collect()
        },
        author: f[3].into(),
        at: JsNum(number_or_zero(f[4])),
        refs: parse_refs(f[5]),
        subject: f[6..].join("\x1f"),
    })
}

/// `parseLog(stdout)`: `git log -z --format=LOG_FORMAT`; commits are terminated by NUL.
pub fn parse_log(stdout: &str) -> Vec<GitCommit> {
    stdout
        .split('\0')
        .filter(|record| !js_trim(record).is_empty())
        .filter_map(|record| parse_commit(record.trim_start_matches('\n')))
        .collect()
}

/// What [`parse_details`] reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParsedDetails {
    pub commit: GitCommit,
    pub email: String,
    pub message: String,
}

/// `parseDetails(stdout)`.
pub fn parse_details(stdout: &str) -> Option<ParsedDetails> {
    let f: Vec<&str> = stdout.split('\x1f').collect();
    if f.len() < 9 {
        return None;
    }
    let commit = parse_commit(&f[..7].join("\x1f"))?;
    let message = f[8..].join("\x1f");
    let message = message.trim_end_matches(crate::text::is_js_space).replace("\r\n", "\n");
    Some(ParsedDetails { commit, email: f[7].into(), message })
}

static NUMSTAT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^([0-9]+|-)\t([0-9]+|-)\t(.*)$").expect("numstat regex"));

/// `parseDiffTree(stdout, limit = GIT_COMMIT_FILE_LIMIT)`: `git diff-tree -r -z --raw --numstat`.
pub fn parse_diff_tree(stdout: &str, limit: usize) -> (Vec<GitCommitFile>, bool) {
    let tokens: Vec<&str> = stdout.split('\0').collect();
    let mut raw: Vec<(String, String, Option<String>)> = Vec::new();
    let mut stats: Vec<(Option<JsNum>, Option<JsNum>)> = Vec::new();
    let token_at = |i: usize| tokens.get(i).copied().unwrap_or("").to_string();
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];
        if token.is_empty() {
            i += 1;
            continue;
        }
        if token.starts_with(':') {
            let status = match token.rfind(' ') {
                Some(space) => &token[space + 1..],
                None => token,
            };
            let letter = first_unit(status).unwrap_or_else(|| "M".into());
            if letter == "R" || letter == "C" {
                i += 1;
                let orig = token_at(i);
                i += 1;
                raw.push((letter, token_at(i), Some(orig)));
            } else {
                i += 1;
                raw.push((letter, token_at(i), None));
            }
            i += 1;
            continue;
        }
        if let Some(m) = NUMSTAT.captures(token) {
            let num = |s: &str| if s == "-" { None } else { Some(JsNum(js::js_number(s))) };
            stats.push((num(&m[1]), num(&m[2])));
            if m[3].is_empty() {
                i += 2; // a rename: the old and the new path follow as separate records
            }
        }
        i += 1;
    }
    let total = raw.len();
    let files = raw
        .into_iter()
        .enumerate()
        .take(limit)
        .map(|(index, (status, path, orig_path))| {
            let (added, deleted) = stats.get(index).cloned().unwrap_or((None, None));
            GitCommitFile { status, orig_path, path, added, deleted }
        })
        .collect();
    (files, total > limit)
}

/// `parseBranches(stdout)`: `git for-each-ref` with [`BRANCH_FORMAT`].
pub fn parse_branches(stdout: &str) -> Vec<GitBranch> {
    let mut branches = Vec::new();
    for line in stdout.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 6 {
            continue;
        }
        let remote = f[0].starts_with("refs/remotes/");
        if !remote && !f[0].starts_with("refs/heads/") {
            continue;
        }
        if remote && (f[1].ends_with("/HEAD") || !f[1].contains('/')) {
            continue; // origin/HEAD, or the bare remote name git prints for it
        }
        branches.push(GitBranch {
            name: f[1].into(),
            hash: f[2].into(),
            current: f[5] == "*",
            remote,
            upstream: Some(f[3]).filter(|u| !u.is_empty()).map(str::to_string),
            track: f[4].into(),
        });
    }
    branches
}

/// `parseWorktrees(stdout)`: `git worktree list --porcelain`.
pub fn parse_worktrees(stdout: &str) -> Vec<GitWorktree> {
    let mut list: Vec<GitWorktree> = Vec::new();
    for line in stdout.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(path) = line.strip_prefix("worktree ") {
            let main = list.is_empty();
            list.push(GitWorktree {
                path: path.into(),
                branch: None,
                head: String::new(),
                main,
                detached: false,
                allowed: true,
                is_project: false,
                preferred: false,
            });
        } else if let Some(current) = list.last_mut() {
            if line.starts_with("HEAD ") {
                current.head = slice(line, 5, 12);
            } else if let Some(branch) = line.strip_prefix("branch ") {
                current.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).into());
            } else if line == "detached" {
                current.detached = true;
            }
        }
    }
    list.retain(|w| !w.path.is_empty());
    list
}

// ---------- unified diff ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Meta,
    Hunk,
    Add,
    Del,
    Ctx,
    Note,
}

/// `DiffLine`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_no: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_no: Option<JsNum>,
}

/// What [`parse_unified_diff`] answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParsedDiff {
    pub lines: Vec<DiffLine>,
    pub header: Vec<String>,
    pub binary: bool,
    pub cut: bool,
}

static HUNK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@").expect("hunk regex"));
static BINARY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^Binary files [^{JS_LINE_TERMINATORS}]* differ$|^GIT binary patch")).expect("binary regex")
});
const HEADER_PREFIXES: [&str; 12] = [
    "diff --git",
    "index ",
    "--- ",
    "+++ ",
    "new file",
    "deleted file",
    "old mode",
    "new mode",
    "similarity",
    "rename ",
    "copy ",
    "dissimilarity",
];

/// `parseUnifiedDiff(value, maxLines = GIT_DIFF_LINES)`: lines of a unified diff with their kind and line numbers; the header
/// lines are folded into `header`.
pub fn parse_unified_diff(value: &str, max_lines: usize) -> ParsedDiff {
    let mut out = ParsedDiff { lines: Vec::new(), header: Vec::new(), binary: false, cut: false };
    let mut old_no = 0.0f64;
    let mut new_no = 0.0f64;
    let mut in_hunk = false;
    let mut all: Vec<&str> = value.split('\n').collect();
    if all.last() == Some(&"") {
        all.pop();
    }
    let line_of = |kind: DiffLineKind, text: String| DiffLine { kind, text, old_no: None, new_no: None };
    for raw in all {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if out.lines.len() >= max_lines {
            out.cut = true;
            break;
        }
        if line.starts_with("@@") {
            if let Some(m) = HUNK.captures(line) {
                old_no = js::js_number(&m[1]);
                new_no = js::js_number(&m[2]);
                in_hunk = true;
            }
            out.lines.push(line_of(DiffLineKind::Hunk, line.into()));
        } else if !in_hunk && HEADER_PREFIXES.iter().any(|p| line.starts_with(p)) {
            out.header.push(line.into());
        } else if BINARY.is_match(line) {
            out.binary = true;
            out.lines.push(line_of(DiffLineKind::Note, line.into()));
        } else if !in_hunk {
            out.lines.push(line_of(DiffLineKind::Meta, line.into()));
        } else if let Some(rest) = line.strip_prefix('+') {
            out.lines.push(DiffLine { new_no: Some(JsNum(new_no)), ..line_of(DiffLineKind::Add, rest.into()) });
            new_no += 1.0;
        } else if let Some(rest) = line.strip_prefix('-') {
            out.lines.push(DiffLine { old_no: Some(JsNum(old_no)), ..line_of(DiffLineKind::Del, rest.into()) });
            old_no += 1.0;
        } else if line.starts_with('\\') {
            out.lines.push(line_of(DiffLineKind::Note, slice_from(line, 2)));
        } else if line.starts_with("diff --git") {
            in_hunk = false;
            out.header.push(line.into());
        } else {
            out.lines.push(DiffLine {
                old_no: Some(JsNum(old_no)),
                new_no: Some(JsNum(new_no)),
                ..line_of(DiffLineKind::Ctx, slice_from(line, 1))
            });
            old_no += 1.0;
            new_no += 1.0;
        }
    }
    out
}

// ---------- commit graph ----------

/// `GraphRow`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub col: usize,
    pub top: Vec<Option<String>>,
    pub bottom: Vec<Option<String>>,
    pub from_dot: Vec<usize>,
    pub to_dot: Vec<usize>,
}

/// `layoutGraph(commits)`: one row per commit, lanes carried from row to row; tolerant of a cut-off history.
pub fn layout_graph<'a>(commits: impl IntoIterator<Item = (&'a str, &'a [String])>) -> Vec<GraphRow> {
    let mut rows = Vec::new();
    let mut lanes: Vec<Option<String>> = Vec::new();
    let index_of = |lanes: &[Option<String>], hash: Option<&str>| lanes.iter().position(|l| l.as_deref() == hash);
    for (hash, parents) in commits {
        let top = lanes.clone();
        let waiting: Vec<usize> = lanes.iter().enumerate().filter(|(_, l)| l.as_deref() == Some(hash)).map(|(i, _)| i).collect();
        let col = waiting.first().copied().or_else(|| index_of(&lanes, None)).unwrap_or(lanes.len());
        let mut next = lanes.clone();
        while next.len() <= col {
            next.push(None);
        }
        for &i in &waiting {
            next[i] = None;
        }
        let mut from_dot: Vec<usize> = Vec::new();
        if let Some(first) = parents.first() {
            match index_of(&next, Some(first)) {
                Some(existing) if existing != col => from_dot.push(existing),
                _ => {
                    next[col] = Some(first.clone());
                    from_dot.push(col);
                }
            }
        }
        for parent in parents.iter().skip(1) {
            let lane = match index_of(&next, Some(parent)) {
                Some(lane) => lane,
                None => {
                    let lane = index_of(&next, None).unwrap_or(next.len());
                    if lane == next.len() {
                        next.push(None);
                    }
                    next[lane] = Some(parent.clone());
                    lane
                }
            };
            if !from_dot.contains(&lane) {
                from_dot.push(lane);
            }
        }
        while next.last() == Some(&None) {
            next.pop();
        }
        rows.push(GraphRow { col, top, bottom: next.clone(), from_dot, to_dot: waiting });
        lanes = next;
    }
    rows
}

// ---------- paths shown in the panel ----------

/// `projectRelativePath(relation, file, windows)`: the path of a repository file relative to the project folder, or None.
pub fn project_relative_path(relation: Option<&GitProjectRelation>, file: &str, windows: bool) -> Option<String> {
    let relation = relation?;
    let clean = file.trim_end_matches('/');
    if relation.kind == RelationKind::ContainsRoot {
        return Some(if relation.prefix.is_empty() { clean.into() } else { format!("{}/{clean}", relation.prefix) });
    }
    if relation.prefix.is_empty() {
        return Some(clean.into());
    }
    let prefix = format!("{}/", relation.prefix);
    let n = jlen(&prefix);
    let head = slice(clean, 0, n);
    let same = if windows { head.to_lowercase() == prefix.to_lowercase() } else { head == prefix };
    (jlen(clean) > n && same).then(|| slice_from(clean, n))
}

/// `normalizeProjectPath` of src/shared/platform.ts: no trailing separators, forward slashes, lower case for a drive or UNC
/// path.
pub fn normalize_project_path(path: &str) -> String {
    let normalized = TRAILING_SEPARATORS.replace(path, "").replace('\\', "/");
    let b = normalized.as_bytes();
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/';
    if drive || normalized.starts_with("//") { normalized.to_lowercase() } else { normalized }
}

/// `worktreeAllowed(projectPath, worktreePath, extra)`: inside the project folder, an app-made sibling
/// (`<project>-wt-<name>`) or one of the worktrees the project's cells use.
pub fn worktree_allowed(project_path: &str, worktree_path: &str, extra: &[String]) -> bool {
    let base = normalize_project_path(project_path);
    let wt = normalize_project_path(worktree_path);
    if wt == base || wt.starts_with(&format!("{base}/")) {
        return true;
    }
    if extra.iter().any(|p| normalize_project_path(p) == wt) {
        return true;
    }
    let units = crate::js::len(&base);
    let (parent, name) = match base.rfind('/') {
        Some(slash) => (base[..slash].to_string(), base[slash + 1..].to_string()),
        // JS: lastIndexOf -1, so slice(0, -1) drops the last unit and slice(0) is the whole name
        None => (slice(&base, 0, units.saturating_sub(1)), base.clone()),
    };
    wt.starts_with(&format!("{parent}/{name}-wt-")) && !slice_from(&wt, jlen(&parent) + 1).contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn file_change_keys_like_the_reference() {
        let f = change("a", "");
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            json!({"path": "a", "staged": true, "unstaged": true, "untracked": false, "conflict": false})
        );
    }

    #[test]
    fn worktree_allowed_without_a_slash() {
        assert!(worktree_allowed("app", "ap/app-wt-x", &[]));
        assert!(!worktree_allowed("app", "ap/app-wt-x/y", &[]));
    }
}
