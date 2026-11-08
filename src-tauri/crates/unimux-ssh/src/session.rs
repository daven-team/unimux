//! The session vocabulary of 1.1.4's src/shared/ssh.ts that main and the login core share (S3): phases, the fixed error
//! codes the UI shows, the session state the renderer keeps per cell, and the small text helpers around a login
//! (server text sanitizing, endpoints, the startup input, the restore `cd`, which login a host uses).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::keys::js::{js_trim, utf16_len};

/// `SSH_LIMITS.serverText`.
pub const SERVER_TEXT_MAX: usize = 2048;
/// `SSH_LIMITS.startup` (UTF-16 units).
pub const STARTUP_MAX: usize = 8 * 1024;
/// `SFTP_LIMITS.path` (UTF-16 units).
pub const REMOTE_PATH_MAX: usize = 4096;

/// `SshPhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SshPhase {
    Idle,
    Connecting,
    Verifying,
    Authenticating,
    Connected,
    Closed,
    Error,
}

impl SshPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            SshPhase::Idle => "idle",
            SshPhase::Connecting => "connecting",
            SshPhase::Verifying => "verifying",
            SshPhase::Authenticating => "authenticating",
            SshPhase::Connected => "connected",
            SshPhase::Closed => "closed",
            SshPhase::Error => "error",
        }
    }

    pub fn parse(s: &str) -> Option<SshPhase> {
        Some(match s {
            "idle" => SshPhase::Idle,
            "connecting" => SshPhase::Connecting,
            "verifying" => SshPhase::Verifying,
            "authenticating" => SshPhase::Authenticating,
            "connected" => SshPhase::Connected,
            "closed" => SshPhase::Closed,
            "error" => SshPhase::Error,
            _ => return None,
        })
    }

    /// `isLivePhase`: connecting, verifying, authenticating, connected.
    pub fn is_live(self) -> bool {
        matches!(self, SshPhase::Connecting | SshPhase::Verifying | SshPhase::Authenticating | SshPhase::Connected)
    }
}

/// `resumeForPhase`: connected sets the cell's `resume`, an end (or a session never started) clears it.
pub fn resume_for_phase(phase: SshPhase) -> Option<bool> {
    match phase {
        SshPhase::Connected => Some(true),
        SshPhase::Closed | SshPhase::Error | SshPhase::Idle => Some(false),
        _ => None,
    }
}

macro_rules! error_codes {
    ($($variant:ident => $name:literal,)*) => {
        /// `SshErrorCode`: the fixed codes the UI shows (raw messages never leave the login core).
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum SshErrorCode { $($variant,)* }

        impl SshErrorCode {
            pub const ALL: &'static [SshErrorCode] = &[$(SshErrorCode::$variant,)*];

            pub fn as_str(self) -> &'static str {
                match self { $(SshErrorCode::$variant => $name,)* }
            }

            pub fn parse(s: &str) -> Option<SshErrorCode> {
                match s { $($name => Some(SshErrorCode::$variant),)* _ => None }
            }
        }
    };
}

error_codes! {
    Dns => "dns",
    Refused => "refused",
    Timeout => "timeout",
    Unreachable => "unreachable",
    Reset => "reset",
    Protocol => "protocol",
    Auth => "auth",
    HostKeyRejected => "hostKeyRejected",
    HostKeyChanged => "hostKeyChanged",
    Passphrase => "passphrase",
    KeyLocked => "keyLocked",
    KeyMissing => "keyMissing",
    HostMissing => "hostMissing",
    ShellDenied => "shellDenied",
    PtyHostCrashed => "ptyHostCrashed",
    Cancelled => "cancelled",
    Unknown => "unknown",
    SftpDenied => "sftpDenied",
    SftpHostCrashed => "sftpHostCrashed",
    DbHostCrashed => "dbHostCrashed",
    SudoPassword => "sudoPassword",
    SudoTty => "sudoTty",
    SudoDenied => "sudoDenied",
    SudoNoServer => "sudoNoServer",
    SudoFailed => "sudoFailed",
    SudoMissing => "sudoMissing",
    BadRequest => "badRequest",
}

impl std::fmt::Display for SshErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `SshSessionState`; serialized in the key order of the TS object (`cellId, hostId, phase, since, error?, exitCode?,
/// serverBanner?`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionState {
    pub cell_id: String,
    pub host_id: String,
    pub phase: SshPhase,
    pub since: i64,
    pub error: Option<SshErrorCode>,
    pub exit_code: Option<i64>,
    pub server_banner: Option<String>,
}

impl SessionState {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("cellId".into(), json!(self.cell_id));
        m.insert("hostId".into(), json!(self.host_id));
        m.insert("phase".into(), json!(self.phase.as_str()));
        m.insert("since".into(), json!(self.since));
        if let Some(e) = self.error {
            m.insert("error".into(), json!(e.as_str()));
        }
        if let Some(c) = self.exit_code {
            m.insert("exitCode".into(), json!(c));
        }
        if let Some(b) = &self.server_banner {
            m.insert("serverBanner".into(), json!(b));
        }
        Value::Object(m)
    }
}

static CSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").expect("regex"));
static OSC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?").expect("regex"));
static ESC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b[@-_]").expect("regex"));
static CRLF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r\n?").expect("regex"));
static CONTROLS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f\x7f-\u{9f}]").expect("regex"));

/// `text.slice(0, max)` in UTF-16 units; a surrogate pair cut in half ends in U+FFFD (JS keeps a lone surrogate, which
/// a Rust string cannot hold and JSON.stringify would escape anyway).
pub fn utf16_prefix(text: &str, max: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max * 3));
    let mut units = 0;
    for c in text.chars() {
        let n = c.len_utf16();
        if units + n > max {
            if units < max {
                out.push('\u{FFFD}');
            }
            break;
        }
        units += n;
        out.push(c);
    }
    out
}

/// `sanitizeServerText`: server-provided text (banner, keyboard-interactive name, instructions, prompts) as plain, short
/// text: escape sequences and C0 / C1 controls (except LF and TAB) removed, CR LF and CR made LF, at most `max` UTF-16 units.
pub fn sanitize_server_text(text: &str, max: usize) -> String {
    let t = CSI.replace_all(text, "");
    let t = OSC.replace_all(&t, "");
    let t = ESC.replace_all(&t, "");
    let t = CRLF.replace_all(&t, "\n");
    let t = CONTROLS.replace_all(&t, "");
    if utf16_len(&t) > max { utf16_prefix(&t, max) } else { t.into_owned() }
}

/// `hostEndpoint`: `host`, `host:2222`, `::1`, `[::1]:2222`.
pub fn host_endpoint(address: &str, port: u16) -> String {
    if port == 22 {
        address.to_string()
    } else if address.contains(':') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    }
}

static STARTUP_CONTROL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]").expect("regex"));

/// `startupInput`: what the session types after login (one write, lines joined by CR, ending with CR); None for nothing to
/// type or a text `startupProblem` refuses (too long, a control other than TAB / LF / CR).
pub fn startup_input(text: Option<&str>) -> Option<String> {
    let text = text.filter(|t| !t.is_empty())?;
    if utf16_len(text) > STARTUP_MAX || STARTUP_CONTROL.is_match(text) {
        return None;
    }
    let unified = CRLF.replace_all(text, "\n");
    let mut lines: Vec<&str> = unified.split('\n').collect();
    while lines.last().is_some_and(|l| js_trim(l).is_empty()) {
        lines.pop();
    }
    if lines.is_empty() { None } else { Some(format!("{}\r", lines.join("\r"))) }
}

/// `validRemotePath` of shared/sftp.ts.
pub fn valid_remote_path(path: &str) -> bool {
    path.starts_with('/') && utf16_len(path) <= REMOTE_PATH_MAX && !path.contains(['\0', '\r', '\n', '\\'])
}

/// `shQuote`: single quotes for sh, bash, zsh and fish.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `restoreCwdInput`: ` cd '<folder>'` + CR for an app-start restore (the leading space keeps it out of the shell's
/// history); None for anything that is not an absolute folder of a sane length.
pub fn restore_cwd_input(cwd: Option<&Value>) -> Option<String> {
    let cwd = cwd?.as_str()?;
    if !valid_remote_path(cwd) || utf16_len(cwd) > 1024 || cwd.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return None;
    }
    Some(format!(" cd {}\r", sh_quote(cwd)))
}

fn is_uuid_ci(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `isSftpSessionId`: `sftp:<uuid>` (case-insensitive).
pub fn is_sftp_session_id(id: &str) -> bool {
    id.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("sftp:")) && is_uuid_ci(&id[5..])
}

/// `isDbSessionId`: `db:<uuid>` (case-insensitive).
pub fn is_db_session_id(id: &str) -> bool {
    id.get(..3).is_some_and(|p| p.eq_ignore_ascii_case("db:")) && is_uuid_ci(&id[3..])
}

/// `SessionHostKind`: the non-cell sessions by id prefix (SFTP sessions and DB tunnels).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SessionHostKind {
    Sftp,
    Db,
}

/// `sessionHostOf`.
pub fn session_host_of(id: &str) -> Option<SessionHostKind> {
    if is_sftp_session_id(id) {
        Some(SessionHostKind::Sftp)
    } else if is_db_session_id(id) {
        Some(SessionHostKind::Db)
    } else {
        None
    }
}

/// Whose vault entry holds the saved password of a login.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretOwner {
    Host(String),
    Identity(String),
}

/// `HostLogin`: who signs in to a host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostLogin {
    pub username: String,
    pub key_id: Option<String>,
    pub secret: SecretOwner,
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `hostLogin(host, identities)`: an identity replaces every credential of the host; a host whose identity is gone signs in
/// with its own fields.
pub fn host_login(host: &Value, identities: Option<&Value>) -> HostLogin {
    let identity_id = str_of(host, "identityId");
    let identity = (!identity_id.is_empty())
        .then(|| identities.and_then(Value::as_array).and_then(|l| l.iter().find(|i| str_of(i, "id") == identity_id)))
        .flatten();
    let key = |v: &Value| Some(str_of(v, "keyId")).filter(|k| !k.is_empty()).map(str::to_string);
    match identity {
        Some(i) => HostLogin {
            username: str_of(i, "username").to_string(),
            key_id: key(i),
            secret: SecretOwner::Identity(str_of(i, "id").to_string()),
        },
        None => HostLogin {
            username: str_of(host, "username").to_string(),
            key_id: key(host),
            secret: SecretOwner::Host(str_of(host, "id").to_string()),
        },
    }
}

/// `findCell(state, cellId)?.cell`.
pub fn find_cell<'a>(state: &'a Value, cell_id: &str) -> Option<&'a Value> {
    state.get("projects")?.as_array()?.iter().find_map(|p| {
        p.get("tabs")?
            .as_array()?
            .iter()
            .find_map(|t| t.get("cells")?.as_array()?.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(cell_id)))
    })
}

/// `state.sshHosts.find((h) => h.id === id)`.
pub fn find_host<'a>(state: &'a Value, host_id: &str) -> Option<&'a Value> {
    state.get("sshHosts")?.as_array()?.iter().find(|h| h.get("id").and_then(Value::as_str) == Some(host_id))
}

/// `patchSshCell(state, cellId, { resume })`: None when nothing changes (no such SSH cell, or `resume` already as asked).
pub fn patch_ssh_cell_resume(state: &Value, cell_id: &str, resume: bool) -> Option<Value> {
    let ssh = find_cell(state, cell_id)?.get("ssh").filter(|s| s.is_object())?;
    let cwd = ssh.get("cwd").and_then(Value::as_str);
    if (ssh.get("resume") == Some(&Value::Bool(true))) == resume {
        return None;
    }
    let mut next = Map::new();
    next.insert("hostId".into(), ssh.get("hostId").cloned().unwrap_or(Value::Null));
    // patchSshCellRef keeps `ref.cwd` as it is when the patch does not name one.
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        next.insert("cwd".into(), json!(c));
    }
    if resume {
        next.insert("resume".into(), json!(true));
    }
    let mut state = state.clone();
    for p in state.get_mut("projects").and_then(Value::as_array_mut).into_iter().flatten() {
        for t in p.get_mut("tabs").and_then(Value::as_array_mut).into_iter().flatten() {
            for c in t.get_mut("cells").and_then(Value::as_array_mut).into_iter().flatten() {
                if c.get("id").and_then(Value::as_str) == Some(cell_id)
                    && let Some(o) = c.as_object_mut()
                {
                    o.insert("ssh".into(), Value::Object(next));
                    return Some(state);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_server_text_like_1_1_4() {
        assert_eq!(sanitize_server_text("a\x1b[31mred\x1b[0m\r\nb\rc", SERVER_TEXT_MAX), "ared\nb\nc");
        assert_eq!(sanitize_server_text("x\x1b]0;title\x07y\x1b]2;t\x1b\\z", SERVER_TEXT_MAX), "xyz");
        assert_eq!(sanitize_server_text("a\x1bMb\x00\x07\x7f\u{85}\u{9f}c\td", SERVER_TEXT_MAX), "abc\td");
        assert_eq!(sanitize_server_text("abcdef", 3), "abc");
        assert_eq!(sanitize_server_text("a\u{1F600}b", 2), "a\u{FFFD}");
        assert_eq!(sanitize_server_text("é\u{a0}", 10), "é\u{a0}");
    }

    #[test]
    fn endpoints_and_session_ids() {
        assert_eq!(host_endpoint("web", 22), "web");
        assert_eq!(host_endpoint("web", 2222), "web:2222");
        assert_eq!(host_endpoint("::1", 2222), "[::1]:2222");
        assert_eq!(host_endpoint("::1", 22), "::1");
        assert!(is_sftp_session_id("sftp:0000000A-0000-4000-8000-000000000001"));
        assert!(is_db_session_id("DB:00000000-0000-4000-8000-000000000001"));
        assert!(!is_db_session_id("db:00000000-0000-4000-8000-00000000000"));
        assert!(!is_sftp_session_id("00000000-0000-4000-8000-000000000001"));
        assert_eq!(session_host_of("db:00000000-0000-4000-8000-000000000001"), Some(SessionHostKind::Db));
    }

    #[test]
    fn startup_input_joins_lines_with_cr() {
        assert_eq!(startup_input(Some("cd /srv\r\nls\n\n  \n")).as_deref(), Some("cd /srv\rls\r"));
        assert_eq!(startup_input(Some("a\tb")).as_deref(), Some("a\tb\r"));
        assert_eq!(startup_input(Some("\x1b[A")), None);
        assert_eq!(startup_input(Some(" \n ")), None);
        assert_eq!(startup_input(Some("")), None);
        assert_eq!(startup_input(None), None);
        assert_eq!(startup_input(Some(&"a".repeat(STARTUP_MAX + 1))), None);
    }

    #[test]
    fn restore_cd_quotes_the_folder() {
        assert_eq!(restore_cwd_input(Some(&json!("/srv/it's"))).as_deref(), Some(" cd '/srv/it'\\''s'\r"));
        assert_eq!(restore_cwd_input(Some(&json!("relative"))), None);
        assert_eq!(restore_cwd_input(Some(&json!("/a\tb"))), None);
        assert_eq!(restore_cwd_input(Some(&json!("/a\\b"))), None);
        assert_eq!(restore_cwd_input(Some(&json!(5))), None);
        assert_eq!(restore_cwd_input(None), None);
    }

    #[test]
    fn host_login_prefers_the_identity() {
        let host = json!({"id": "h", "username": "deploy", "keyId": "k1", "identityId": "i"});
        let ids = json!([{"id": "i", "username": "ops", "keyId": "k2"}]);
        assert_eq!(
            host_login(&host, Some(&ids)),
            HostLogin { username: "ops".into(), key_id: Some("k2".into()), secret: SecretOwner::Identity("i".into()) }
        );
        let ids = json!([{"id": "other", "username": "ops"}]);
        assert_eq!(
            host_login(&host, Some(&ids)),
            HostLogin { username: "deploy".into(), key_id: Some("k1".into()), secret: SecretOwner::Host("h".into()) }
        );
        let ids = json!([{"id": "i", "username": "ops"}]);
        assert_eq!(host_login(&host, Some(&ids)).key_id, None);
        // A host without an identity signs in with its own fields, with or without identities in the state.
        let plain = json!({"id": "h", "username": "deploy", "keyId": "k1"});
        let own = HostLogin { username: "deploy".into(), key_id: Some("k1".into()), secret: SecretOwner::Host("h".into()) };
        assert_eq!(host_login(&plain, Some(&ids)), own);
        assert_eq!(host_login(&plain, None), own);
        let keyless = json!({"id": "h", "username": "deploy"});
        assert_eq!(host_login(&keyless, None).key_id, None);
    }

    #[test]
    fn resume_patch_changes_only_what_differs() {
        let state = json!({"projects": [{"tabs": [{"cells": [{"id": "c", "ssh": {"hostId": "h", "cwd": "/srv"}}]}]}]});
        let next = patch_ssh_cell_resume(&state, "c", true).unwrap();
        assert_eq!(find_cell(&next, "c").unwrap()["ssh"], json!({"hostId": "h", "cwd": "/srv", "resume": true}));
        assert_eq!(patch_ssh_cell_resume(&next, "c", true), None);
        assert_eq!(patch_ssh_cell_resume(&state, "c", false), None);
        let back = patch_ssh_cell_resume(&next, "c", false).unwrap();
        assert_eq!(find_cell(&back, "c").unwrap()["ssh"], json!({"hostId": "h", "cwd": "/srv"}));
        assert_eq!(patch_ssh_cell_resume(&state, "missing", true), None);
    }

    #[test]
    fn phases_and_codes_round_trip() {
        for code in SshErrorCode::ALL {
            assert_eq!(SshErrorCode::parse(code.as_str()), Some(*code));
        }
        assert!(SshPhase::Verifying.is_live());
        assert!(!SshPhase::Error.is_live());
        assert_eq!(resume_for_phase(SshPhase::Authenticating), None);
    }
}
