//! The credential reads of the logins (the parts of src/main/usage/credentials.ts `readClaudeCredentials`,
//! `readCodexCredentials` and `systemCredentialSource().keychain` a login needs). Read only. A login only ever sees a
//! fingerprint (SHA-256 hex of the access token) and the identity fields; the tokens never leave these functions.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::codex::{CodexIdentity, decode_jwt_claims};
use crate::js;

/// `readFile(path, 'utf8').catch(() => null)`.
fn read_or_none(path: &Path) -> Option<Zeroizing<String>> {
    js::read_text(path).ok().map(Zeroizing::new)
}

/// `<CLAUDE_CONFIG_DIR (trimmed) or ~/.claude>/.credentials.json`.
pub fn claude_credentials_path(config_dir: Option<&str>, home: &Path) -> PathBuf {
    match config_dir.map(js::trim).filter(|d| !d.is_empty()) {
        Some(dir) => Path::new(dir).join(".credentials.json"),
        None => home.join(".claude").join(".credentials.json"),
    }
}

/// The access token of a Claude credentials text (`claudeAiOauth.accessToken`, a non-empty string), as its fingerprint.
fn claude_fingerprint_of(raw: &str) -> Option<String> {
    let parsed = unimux_core::js_json::parse(raw).ok()?;
    let oauth = js::record(js::record(Some(&parsed))?.get("claudeAiOauth"))?;
    let token = js::string(oauth.get("accessToken")).filter(|t| !t.is_empty())?;
    Some(js::sha256_hex(token))
}

/// Where the Claude credentials of a login are read.
#[derive(Debug, Clone, Default)]
pub struct ClaudeSource {
    /// `CLAUDE_CODE_OAUTH_TOKEN` of the environment (a profile source blanks it).
    pub env_token: Option<String>,
    /// `CLAUDE_CONFIG_DIR` of the environment, or the profile dir.
    pub config_dir: Option<String>,
    pub home: PathBuf,
    /// The Keychain is read when the file has nothing (the live login on macOS; never for a profile).
    pub keychain: bool,
}

impl ClaudeSource {
    /// `profileSource(source, dir)`: its own config dir, no env token, never the Keychain.
    pub fn profile(dir: &Path) -> Self {
        Self { env_token: None, config_dir: Some(dir.to_string_lossy().into_owned()), home: PathBuf::new(), keychain: false }
    }
}

/// `sha256(readClaudeCredentials(source).accessToken)`: the fingerprint of the Claude login, `None` without one.
pub async fn claude_fingerprint(source: &ClaudeSource, keychain: &Keychain) -> Option<String> {
    if let Some(token) = source.env_token.as_deref().map(js::trim).filter(|t| !t.is_empty()) {
        return Some(js::sha256_hex(token));
    }
    let path = claude_credentials_path(source.config_dir.as_deref(), &source.home);
    let mut raw = read_or_none(&path).filter(|r| !r.is_empty());
    if raw.is_none() && source.keychain {
        raw = keychain.read().await;
    }
    claude_fingerprint_of(raw.as_deref()?)
}

/// `readCodexCredentials` without the token: the login mode, the fingerprint of the access token and who it belongs to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexCredentials {
    /// Signed in with ChatGPT (tokens); false: an API key.
    pub chatgpt: bool,
    /// SHA-256 hex of the access token (ChatGPT logins only).
    pub fingerprint: Option<String>,
    pub email: Option<String>,
    pub user_id: Option<String>,
    /// `tokens.account_id` when it is a string (also an empty one, as 1.1.4 kept it).
    pub account_id: Option<String>,
}

impl CodexCredentials {
    /// The identity of a ChatGPT login (`identity` of the Codex login manager), `None` for an API key.
    pub fn identity(&self) -> Option<CodexIdentity> {
        let truthy = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
        self.chatgpt.then(|| CodexIdentity {
            email: truthy(&self.email),
            user_id: truthy(&self.user_id),
            account_id: truthy(&self.account_id),
        })
    }
}

/// `<CODEX_HOME>/auth.json`.
pub fn read_codex_credentials(codex_home: &Path) -> Option<CodexCredentials> {
    let raw = read_or_none(&codex_home.join("auth.json")).filter(|r| !r.is_empty())?;
    parse_codex_credentials(&raw)
}

/// `readCodexCredentials` over the text of an auth.json.
pub fn parse_codex_credentials(raw: &str) -> Option<CodexCredentials> {
    let auth = unimux_core::js_json::parse(raw).ok()?;
    let auth = js::record(Some(&auth))?;
    let tokens = js::record(auth.get("tokens"));
    let access = tokens.and_then(|t| js::string(t.get("access_token"))).filter(|s| !s.is_empty());
    let (Some(tokens), Some(access)) = (tokens, access) else {
        let api_key = js::string(auth.get("OPENAI_API_KEY")).is_some_and(|k| !k.is_empty());
        return api_key.then(CodexCredentials::default);
    };
    let id_claims = js::string(tokens.get("id_token")).and_then(decode_jwt_claims);
    let access_claims = decode_jwt_claims(access);
    const AUTH: &str = "https://api.openai.com/auth";
    // idClaims?.[AUTH] ?? accessClaims?.[AUTH]
    let claim = id_claims
        .as_ref()
        .and_then(|c| c.get(AUTH))
        .filter(|v| !v.is_null())
        .or_else(|| access_claims.as_ref().and_then(|c| c.get(AUTH)).filter(|v| !v.is_null()));
    let empty = Map::new();
    let auth_claim = js::record(claim).unwrap_or(&empty);
    let non_empty = |v: Option<&Value>| js::string(v).filter(|s| !s.is_empty()).map(str::to_string);
    let user_id = non_empty(auth_claim.get("chatgpt_user_id")).or_else(|| non_empty(auth_claim.get("user_id")));
    Some(CodexCredentials {
        chatgpt: true,
        fingerprint: Some(js::sha256_hex(access)),
        // typeof idClaims?.email === 'string': an empty e-mail is kept here and dropped by the callers' truthiness checks.
        email: id_claims.as_ref().and_then(|c| js::string(c.get("email"))).map(str::to_string),
        user_id,
        account_id: js::string(tokens.get("account_id")).map(str::to_string),
    })
}

/// How long a failed Keychain read is remembered (`KEYCHAIN_HOLD_MS`).
const KEYCHAIN_HOLD: Duration = Duration::from_secs(30 * 60);

type KeychainRead = Arc<dyn Fn() -> futures::future::BoxFuture<'static, Option<String>> + Send + Sync>;

/// Claude Code's Keychain secret on macOS (`security find-generic-password -s "Claude Code-credentials" -w`), with the
/// failure cache of `withFailureCache`: a null result is remembered for 30 minutes so a system prompt is not raised on every
/// poll; a login resets it before each read ([`Keychain::reset`]).
pub struct Keychain {
    read: KeychainRead,
    hold_until: Mutex<Option<std::time::Instant>>,
}

impl Keychain {
    /// The real Keychain (macOS); elsewhere it always answers `None`.
    pub fn system() -> Self {
        Self::with_reader(Arc::new(|| read_system_keychain().boxed()))
    }

    pub fn with_reader(read: KeychainRead) -> Self {
        Self { read, hold_until: Mutex::new(None) }
    }

    pub async fn read(&self) -> Option<Zeroizing<String>> {
        if self.hold_until.lock().is_some_and(|until| std::time::Instant::now() < until) {
            return None;
        }
        let value = (self.read)().await;
        if value.is_none() {
            *self.hold_until.lock() = Some(std::time::Instant::now() + KEYCHAIN_HOLD);
        }
        value.map(Zeroizing::new)
    }

    /// Forgets a remembered failed read.
    pub fn reset(&self) {
        *self.hold_until.lock() = None;
    }
}

impl std::fmt::Debug for Keychain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keychain").finish_non_exhaustive()
    }
}

#[cfg(target_os = "macos")]
async fn read_system_keychain() -> Option<String> {
    use std::ffi::OsString;
    // An absolute path: a `security` earlier on the PATH must never receive the request.
    let program = unimux_exec::Program::Args {
        program: PathBuf::from("/usr/bin/security"),
        args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"].map(OsString::from).to_vec(),
    };
    let options = unimux_exec::ExecOptions {
        timeout: Duration::from_secs(5),
        max_output: 64 * 1024,
        ..unimux_exec::ExecOptions::default()
    };
    let out = unimux_exec::run_async(program, options).await.ok()?;
    if !out.ok() {
        return None;
    }
    let text = Zeroizing::new(String::from_utf8_lossy(&out.stdout).into_owned());
    let trimmed = js::trim(&text);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(not(target_os = "macos"))]
async fn read_system_keychain() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: &str) -> String {
        use base64::Engine;
        let b = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims);
        format!("h.{b}.s")
    }

    #[test]
    fn codex_credentials_like_1_1_4() {
        let id = jwt(r#"{"email":"a@x","https://api.openai.com/auth":{"chatgpt_user_id":"u1","chatgpt_account_id":"w9"}}"#);
        let raw = format!(r#"{{"tokens":{{"access_token":"tok","id_token":"{id}","account_id":"w1","refresh_token":"r"}}}}"#);
        let c = parse_codex_credentials(&raw).unwrap();
        assert!(c.chatgpt);
        assert_eq!(c.fingerprint.as_deref(), Some(js::sha256_hex("tok").as_str()));
        assert_eq!(c.email.as_deref(), Some("a@x"));
        assert_eq!(c.user_id.as_deref(), Some("u1"));
        // tokens.account_id only (no fallback to the claim, unlike parseCodexAuth).
        assert_eq!(c.account_id.as_deref(), Some("w1"));
        let raw = r#"{"tokens":{"access_token":"tok"}}"#;
        assert_eq!(parse_codex_credentials(raw).unwrap().account_id, None);
        assert_eq!(parse_codex_credentials(r#"{"OPENAI_API_KEY":"k"}"#), Some(CodexCredentials::default()));
        assert_eq!(parse_codex_credentials(r#"{"OPENAI_API_KEY":""}"#), None);
        assert_eq!(parse_codex_credentials("{half"), None);
        assert_eq!(parse_codex_credentials(r#"{"tokens":{"access_token":""}}"#), None);
    }

    #[tokio::test]
    async fn claude_fingerprint_reads_the_file_the_env_token_or_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let kc = Keychain::with_reader(Arc::new(|| async { Some(r#"{"claudeAiOauth":{"accessToken":"kc"}}"#.into()) }.boxed()));
        let profile = ClaudeSource::profile(dir.path());
        assert_eq!(claude_fingerprint(&profile, &kc).await, None);
        std::fs::write(dir.path().join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"t1"}}"#).unwrap();
        assert_eq!(claude_fingerprint(&profile, &kc).await, Some(js::sha256_hex("t1")));
        std::fs::write(dir.path().join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":""}}"#).unwrap();
        assert_eq!(claude_fingerprint(&profile, &kc).await, None);
        let env = ClaudeSource { env_token: Some(" e ".into()), ..ClaudeSource::profile(dir.path()) };
        assert_eq!(claude_fingerprint(&env, &kc).await, Some(js::sha256_hex("e")));
        let mac = ClaudeSource { home: dir.path().join("none"), keychain: true, ..ClaudeSource::default() };
        assert_eq!(claude_fingerprint(&mac, &kc).await, Some(js::sha256_hex("kc")));
    }

    #[tokio::test]
    async fn keychain_remembers_a_failure_until_reset() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = calls.clone();
        let kc = Keychain::with_reader(Arc::new(move || {
            c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { None }.boxed()
        }));
        assert!(kc.read().await.is_none());
        assert!(kc.read().await.is_none());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        kc.reset();
        assert!(kc.read().await.is_none());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
}
