//! The login managers (A4; ports of src/main/auth/{login,codexLogin,profileSnapshot}.ts and the credential readers the
//! logins use from src/main/usage/credentials.ts).
//!
//! - [`claude::LoginManager`]: "Add account", "Sign in again" of a saved Claude card and the main re-login (`claude auth login
//!   --claudeai` with `CLAUDE_CONFIG_DIR` = the card's profile), plus the main Codex login (`codex login`). The card's two
//!   login files are snapshotted before a re-login and put back when it signed in another account; a restore that fails sets
//!   the card aside (quarantined) and is tried again before every usage poll.
//! - [`codex::CodexLoginManager`]: "Add Codex account" and signing a saved Codex card in again (`codex login` with
//!   `CODEX_HOME` = the card's profile).
//!
//! Both start the command in an `auth:<uuid>` terminal, look at the credentials every 1.5 s (a fingerprint, never the token),
//! settle, read the identity and decide; a login gives up after 10 minutes. Nothing here ever logs or sends a token; the
//! snapshots stay in memory and are wiped when dropped.

pub mod claude;
pub mod codex;
pub mod creds;
pub mod snapshot;

use std::time::Duration;

use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::identity::AccountIdentity;

/// A boxed future of the deps seams.
pub type Fut<T> = BoxFuture<'static, T>;

/// `'claude' | 'codex'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn parse(value: Option<&Value>) -> Option<Self> {
        match value.and_then(Value::as_str) {
            Some("claude") => Some(Self::Claude),
            Some("codex") => Some(Self::Codex),
            _ => None,
        }
    }
}

/// `LoginTarget`: the live login, a new saved account, or a saved account by id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginTarget {
    Main,
    New,
    Account(String),
}

/// `loginCommand`: `--claudeai` is not in the public CLI reference but is what the login flow has used and verified; plain
/// `claude auth login` shows an interactive method menu on some versions.
pub fn login_command(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "claude auth login --claudeai",
        Provider::Codex => "codex login",
    }
}

/// `LoginStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginStatus {
    Waiting,
    Success,
    Failed,
    Duplicate,
    Mismatch,
}

/// `LoginState['error']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginError {
    Timeout,
    Spawn,
    Identity,
    Restore,
}

/// `LoginState['duplicateOf']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DuplicateOf {
    Main,
    Saved,
}

/// `LoginState` (the `auth:state` event). The keys are written in the order 1.1.4's object literals used them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginState {
    pub session_id: String,
    pub status: LoginStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<LoginError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<DuplicateOf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub offer_main: bool,
}

impl LoginState {
    pub fn new(session_id: &str, status: LoginStatus) -> Self {
        Self {
            session_id: session_id.to_string(),
            status,
            error: None,
            email: None,
            expected: None,
            duplicate_of: None,
            record_id: None,
            offer_main: false,
        }
    }

    pub fn failed(session_id: &str, error: LoginError) -> Self {
        Self { error: Some(error), ..Self::new(session_id, LoginStatus::Failed) }
    }

    fn email(mut self, email: Option<&str>) -> Self {
        self.email = email.filter(|e| !e.is_empty()).map(str::to_string);
        self
    }

    fn expected(mut self, expected: Option<&str>) -> Self {
        self.expected = expected.filter(|e| !e.is_empty()).map(str::to_string);
        self
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// The answer of `auth:start`: `{ ok: true, sessionId, ptyId } | { ok: false, error, email? }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginStartResult {
    Started { session_id: String, pty_id: String },
    Refused { error: &'static str, email: Option<String> },
}

impl LoginStartResult {
    pub fn refused(error: &'static str) -> Self {
        Self::Refused { error, email: None }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::Started { session_id, pty_id } => json!({"ok": true, "sessionId": session_id, "ptyId": pty_id}),
            Self::Refused { error, email } => {
                let mut m = Map::new();
                m.insert("ok".into(), Value::Bool(false));
                m.insert("error".into(), Value::String((*error).into()));
                if let Some(email) = email {
                    m.insert("email".into(), Value::String(email.clone()));
                }
                Value::Object(m)
            }
        }
    }
}

/// `KnownIdentity`: an account the app knows, the live login (`live`, also a record holding it) or a saved record. `empty`: a
/// record whose profile holds no Claude login at all and that is not the live login; it never blocks a login as a duplicate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KnownIdentity {
    pub identity: AccountIdentity,
    pub record_id: Option<String>,
    pub live: bool,
    pub empty: bool,
}

/// `LoginChange`: what a finished login changed, so the usage panel reads exactly that account at once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginChange {
    pub provider: Provider,
    pub record_id: Option<String>,
    pub own_change: bool,
}

impl LoginChange {
    /// The usage subject read at once (`codex:main`, `claude:<record>`, `claude:main`).
    pub fn subject(&self) -> String {
        match (self.provider, &self.record_id) {
            (Provider::Codex, _) => "codex:main".into(),
            (Provider::Claude, Some(id)) => format!("claude:{id}"),
            (Provider::Claude, None) => "claude:main".into(),
        }
    }
}

/// The terminal a login runs in (`spawnPty(spec)`); `env` holds only the extra variables.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtySpec {
    pub id: String,
    pub env: Vec<(String, String)>,
    pub command: String,
}

/// The timings of a login (1.1.4 defaults).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoginTimings {
    pub poll: Duration,
    pub settle: Duration,
    pub timeout: Duration,
    /// Gap between the tries of a restore (3 tries).
    pub restore_gap: Duration,
    /// Gap between the identity reads of a settled login (5 reads).
    pub identity_gap: Duration,
}

impl LoginTimings {
    pub const CLAUDE: Self = Self {
        poll: Duration::from_millis(1500),
        settle: Duration::from_millis(1500),
        timeout: Duration::from_millis(600_000),
        restore_gap: Duration::from_millis(2000),
        identity_gap: Duration::from_millis(1000),
    };
    /// Codex writes auth.json once: a shorter settle.
    pub const CODEX: Self = Self { settle: Duration::from_millis(1000), ..Self::CLAUDE };
}

/// The `auth:<uuid>` terminal id of a session.
pub(crate) fn new_session_ids() -> (String, String) {
    let id = uuid::Uuid::new_v4().to_string();
    let pty = format!("auth:{id}");
    (id, pty)
}

/// A profile directory as a path segment of the env (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
pub(crate) fn dir_text(dir: &std::path::Path) -> String {
    dir.to_string_lossy().into_owned()
}

/// `path.resolve(dir)` for comparing profile directories.
pub(crate) fn same_dir(a: &std::path::Path, b: &std::path::Path) -> bool {
    crate::refresh::key_of(a) == crate::refresh::key_of(b)
}

#[cfg(test)]
mod tests;
