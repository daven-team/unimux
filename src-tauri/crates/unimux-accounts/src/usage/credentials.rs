//! Where the usage reads find the logins (port of the read-only credential helpers of src/main/usage/credentials.ts that
//! the usage fetchers use; the identity readers are in [`crate::identity`] and [`crate::live`]). Nothing here writes, and no
//! token ever leaves the returned structs (they are not `Debug`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::Value;

use super::parse::decode_jwt_claims;
use crate::identity::{AccountIdentity, identity_from_oauth_account};
use crate::js;

/// How long a failed Keychain read (denied, missing, timed out) is remembered, so a regular poll never raises a prompt.
pub const KEYCHAIN_HOLD: Duration = Duration::from_secs(30 * 60);

/// Claude Code's Keychain secret (macOS).
pub trait Keychain: Send + Sync {
    fn read(&self) -> BoxFuture<'static, Option<String>>;
    /// Forgets a remembered failed read (a login flow needs fresh reads).
    fn reset(&self) {}
}

/// `withFailureCache`: remembers a `None` for `hold`, so a system prompt is not raised on every poll.
pub struct FailureCache {
    read: Arc<dyn Fn() -> BoxFuture<'static, Option<String>> + Send + Sync>,
    hold_ms: f64,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    hold_until: Arc<Mutex<f64>>,
}

impl FailureCache {
    pub fn new(
        read: Arc<dyn Fn() -> BoxFuture<'static, Option<String>> + Send + Sync>,
        hold: Duration,
        now: Arc<dyn Fn() -> f64 + Send + Sync>,
    ) -> Self {
        Self { read, hold_ms: hold.as_millis() as f64, now, hold_until: Arc::new(Mutex::new(0.0)) }
    }
}

impl Keychain for FailureCache {
    fn read(&self) -> BoxFuture<'static, Option<String>> {
        if (self.now)() < *self.hold_until.lock() {
            return async { None }.boxed();
        }
        let read = (self.read)();
        let (hold_until, now, hold) = (self.hold_until.clone(), self.now.clone(), self.hold_ms);
        async move {
            let value = read.await;
            if value.is_none() {
                *hold_until.lock() = now() + hold;
            }
            value
        }
        .boxed()
    }

    fn reset(&self) {
        *self.hold_until.lock() = 0.0;
    }
}

/// `security find-generic-password -s "Claude Code-credentials" -w` (5 s, 64 KiB), with the 30 minute failure cache.
pub fn system_keychain(now: Arc<dyn Fn() -> f64 + Send + Sync>) -> Arc<dyn Keychain> {
    let read: Arc<dyn Fn() -> BoxFuture<'static, Option<String>> + Send + Sync> = Arc::new(|| {
        async {
            let program = unimux_exec::Program::Args {
                program: PathBuf::from("/usr/bin/security"),
                args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"].iter().map(Into::into).collect(),
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
            let text = String::from_utf8_lossy(&out.stdout);
            let text = js::trim(&text);
            (!text.is_empty()).then(|| text.to_string())
        }
        .boxed()
    });
    Arc::new(FailureCache::new(read, KEYCHAIN_HOLD, now))
}

pub type ReadFile = Arc<dyn Fn(&Path) -> Option<String> + Send + Sync>;

/// `CredentialSource`: the environment, the home folder and the file reads (replaceable in tests). Read-only.
#[derive(Clone)]
pub struct CredentialSource {
    pub env: Arc<BTreeMap<String, String>>,
    pub home: PathBuf,
    pub darwin: bool,
    /// File contents, or `None` when missing or unreadable.
    pub read_file: ReadFile,
    pub keychain: Option<Arc<dyn Keychain>>,
}

impl CredentialSource {
    /// The real files of this machine (`readFile(path, 'utf8')`, failures as `None`).
    pub fn system(env: BTreeMap<String, String>, home: PathBuf, darwin: bool, keychain: Option<Arc<dyn Keychain>>) -> Self {
        Self { env: Arc::new(env), home, darwin, read_file: Arc::new(|p| js::read_text(p).ok()), keychain }
    }

    /// `env.NAME?.trim()` when not blank.
    pub fn env_trimmed(&self, name: &str) -> Option<String> {
        self.env.get(name).map(|v| js::trim(v).to_string()).filter(|v| !v.is_empty())
    }

    fn with_env(&self, set: &[(&str, &str)], darwin: bool) -> Self {
        let mut env = (*self.env).clone();
        for (k, v) in set {
            env.insert((*k).into(), (*v).into());
        }
        Self {
            env: Arc::new(env),
            home: self.home.clone(),
            darwin,
            read_file: self.read_file.clone(),
            keychain: self.keychain.clone(),
        }
    }

    /// `profileSource`: an isolated Claude profile: its own config dir, no env token, never the Keychain.
    pub fn profile(&self, config_dir: &Path) -> Self {
        let dir = config_dir.to_string_lossy();
        self.with_env(&[("CLAUDE_CONFIG_DIR", &dir), ("CLAUDE_CODE_OAUTH_TOKEN", "")], false)
    }

    /// `codexProfileSource`: a Codex profile directory (its own CODEX_HOME).
    pub fn codex_profile(&self, dir: &Path) -> Self {
        let dir = dir.to_string_lossy();
        self.with_env(&[("CODEX_HOME", &dir)], self.darwin)
    }

    /// CLAUDE_CONFIG_DIR, else `~/.claude`.
    pub fn claude_dir(&self) -> PathBuf {
        self.env_trimmed("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| self.home.join(".claude"))
    }

    /// CODEX_HOME, else `~/.codex`.
    pub fn codex_home(&self) -> PathBuf {
        self.env_trimmed("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| self.home.join(".codex"))
    }

    fn read(&self, path: &Path) -> Option<String> {
        (self.read_file)(path).filter(|s| !s.is_empty())
    }

    /// `.credentials.json`, else (macOS) the Keychain.
    async fn claude_login_text(&self) -> Option<String> {
        if let Some(raw) = self.read(&self.claude_dir().join(".credentials.json")) {
            return Some(raw);
        }
        match (&self.keychain, self.darwin) {
            (Some(k), true) => k.read().await.filter(|s| !s.is_empty()),
            _ => None,
        }
    }

    pub fn reset_keychain_cache(&self) {
        if let Some(k) = &self.keychain {
            k.reset();
        }
    }
}

/// `readClaudeIdentity`: who a Claude login belongs to, from the `.claude.json` next to it.
pub fn read_claude_identity(source: &CredentialSource) -> AccountIdentity {
    let path = match source.env_trimmed("CLAUDE_CONFIG_DIR") {
        Some(dir) => Path::new(&dir).join(".claude.json"),
        None => source.home.join(".claude.json"),
    };
    let Some(raw) = source.read(&path) else { return AccountIdentity::default() };
    match unimux_core::js_json::parse(&raw) {
        Ok(Value::Object(m)) => identity_from_oauth_account(m.get("oauthAccount")),
        _ => AccountIdentity::default(),
    }
}

/// `ClaudeCredentials` (the token stays inside; no `Debug`).
#[derive(Clone)]
pub struct ClaudeCredentials {
    pub access_token: String,
    pub expires_at: Option<f64>,
    pub plan: Option<String>,
    /// A refresh token is stored (Claude Code renews an expired access token by itself).
    pub has_refresh: bool,
    /// SHA-256 of the refresh token.
    pub refresh_hash: Option<String>,
}

/// `claudePlanLabel`: "Max 20x", "Pro".
pub fn claude_plan_label(subscription: Option<&Value>, tier: Option<&Value>) -> Option<String> {
    let sub = subscription.and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let mut chars = sub.chars();
    let first = chars.next()?;
    let name: String = first.to_uppercase().chain(chars.as_str().to_lowercase().chars()).collect();
    // /(\d+)x/i: the first run of digits followed by an x.
    let multiplier = tier.and_then(Value::as_str).and_then(|t| {
        let b = t.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i].is_ascii_digit() {
                let start = i;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
                if i < b.len() && (b[i] == b'x' || b[i] == b'X') {
                    // The regex backtracks to the shortest suffix that still ends in digits before the x: the whole run.
                    return Some(t[start..i].to_string());
                }
            } else {
                i += 1;
            }
        }
        None
    });
    Some(match multiplier {
        Some(m) => format!("{name} {m}x"),
        None => name,
    })
}

fn claude_oauth(raw: &str) -> Option<serde_json::Map<String, Value>> {
    match unimux_core::js_json::parse(raw) {
        Ok(Value::Object(mut m)) => match m.remove("claudeAiOauth") {
            Some(Value::Object(o)) => Some(o),
            _ => None,
        },
        _ => None,
    }
}

/// `readClaudeCredentials`.
pub async fn read_claude_credentials(source: &CredentialSource) -> Option<ClaudeCredentials> {
    if let Some(token) = source.env_trimmed("CLAUDE_CODE_OAUTH_TOKEN") {
        return Some(ClaudeCredentials {
            access_token: token,
            expires_at: None,
            plan: None,
            has_refresh: false,
            refresh_hash: None,
        });
    }
    let raw = source.claude_login_text().await?;
    let oauth = claude_oauth(&raw)?;
    let token = oauth.get("accessToken").and_then(Value::as_str).filter(|t| !t.is_empty())?;
    let refresh = oauth.get("refreshToken").and_then(Value::as_str).filter(|t| !t.is_empty());
    Some(ClaudeCredentials {
        access_token: token.to_string(),
        expires_at: oauth.get("expiresAt").and_then(Value::as_f64),
        has_refresh: refresh.is_some(),
        refresh_hash: refresh.map(js::sha256_hex),
        plan: claude_plan_label(oauth.get("subscriptionType"), oauth.get("rateLimitTier")),
    })
}

/// `readClearedClaudeLogin`: a login Claude Code cleared after its renewal was rejected for good (both tokens are empty
/// strings); `Some(plan)` then.
pub async fn read_cleared_claude_login(source: &CredentialSource) -> Option<Option<String>> {
    if source.env_trimmed("CLAUDE_CODE_OAUTH_TOKEN").is_some() {
        return None;
    }
    let raw = source.claude_login_text().await?;
    let oauth = claude_oauth(&raw)?;
    let empty = |k: &str| oauth.get(k).and_then(Value::as_str) == Some("");
    (empty("accessToken") && empty("refreshToken"))
        .then(|| claude_plan_label(oauth.get("subscriptionType"), oauth.get("rateLimitTier")))
}

/// `claudeCredentialsStamp`: a cheap change marker (mtime and size) of the live Claude credentials file.
pub fn claude_credentials_stamp(source: &CredentialSource) -> Option<String> {
    let meta = std::fs::metadata(source.claude_dir().join(".credentials.json")).ok()?;
    let mtime = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(format!("{}:{}", mtime.as_nanos(), meta.len()))
}

/// `CodexCredentials['mode']`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CodexMode {
    Chatgpt,
    ApiKey,
}

/// `CodexCredentials` (no `Debug`: it holds the token).
#[derive(Clone)]
pub struct CodexCredentials {
    pub mode: CodexMode,
    pub access_token: Option<String>,
    pub account_id: Option<String>,
    pub expires_at: Option<f64>,
    pub plan: Option<String>,
    pub email: Option<String>,
    pub user_id: Option<String>,
    pub has_refresh: bool,
}

/// `readCodexCredentials`.
pub fn read_codex_credentials(source: &CredentialSource) -> Option<CodexCredentials> {
    let raw = source.read(&source.codex_home().join("auth.json"))?;
    let Ok(Value::Object(auth)) = unimux_core::js_json::parse(&raw) else { return None };
    let tokens = js::record(auth.get("tokens"));
    let access = tokens.and_then(|t| t.get("access_token")).and_then(Value::as_str).filter(|t| !t.is_empty());
    let (Some(tokens), Some(access)) = (tokens, access) else {
        let key = auth.get("OPENAI_API_KEY").and_then(Value::as_str).is_some_and(|k| !k.is_empty());
        return key.then_some(CodexCredentials {
            mode: CodexMode::ApiKey,
            access_token: None,
            account_id: None,
            expires_at: None,
            plan: None,
            email: None,
            user_id: None,
            has_refresh: false,
        });
    };
    let id_claims = tokens.get("id_token").and_then(Value::as_str).and_then(decode_jwt_claims);
    let access_claims = decode_jwt_claims(access);
    const AUTH: &str = "https://api.openai.com/auth";
    let auth_claim = match id_claims.as_ref().and_then(|c| c.get(AUTH)) {
        Some(Value::Null) | None => access_claims.as_ref().and_then(|c| c.get(AUTH)),
        v => v,
    };
    let auth_claim = js::record(auth_claim);
    let plan = auth_claim.and_then(|a| a.get("chatgpt_plan_type")).and_then(Value::as_str).map(str::to_string);
    let user_id = auth_claim.and_then(|a| {
        [a.get("chatgpt_user_id"), a.get("user_id")]
            .into_iter()
            .flatten()
            .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
            .map(str::to_string)
    });
    Some(CodexCredentials {
        mode: CodexMode::Chatgpt,
        access_token: Some(access.to_string()),
        account_id: tokens.get("account_id").and_then(Value::as_str).map(str::to_string),
        expires_at: access_claims.as_ref().and_then(|c| c.get("exp")).and_then(Value::as_f64).map(|e| e * 1000.0),
        plan,
        email: id_claims.as_ref().and_then(|c| c.get("email")).and_then(Value::as_str).map(str::to_string),
        user_id,
        has_refresh: tokens.get("refresh_token").and_then(Value::as_str).is_some_and(|t| !t.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn source(files: Vec<(&str, String)>) -> CredentialSource {
        let files: Vec<(PathBuf, String)> = files.into_iter().map(|(p, s)| (PathBuf::from(p), s)).collect();
        CredentialSource {
            env: Arc::new(BTreeMap::new()),
            home: PathBuf::from("/home/u"),
            darwin: false,
            read_file: Arc::new(move |p| files.iter().find(|(f, _)| f == p).map(|(_, s)| s.clone())),
            keychain: None,
        }
    }

    #[test]
    fn plan_labels() {
        assert_eq!(claude_plan_label(Some(&json!("max")), Some(&json!("default_claude_max_20x"))).as_deref(), Some("Max 20x"));
        assert_eq!(claude_plan_label(Some(&json!("PRO")), None).as_deref(), Some("Pro"));
        assert_eq!(claude_plan_label(Some(&json!("")), None), None);
    }

    #[tokio::test]
    async fn claude_credentials_cleared_logins_and_profiles() {
        let creds =
            json!({ "claudeAiOauth": { "accessToken": "at", "refreshToken": "rt", "expiresAt": 5, "subscriptionType": "pro" } });
        let s = source(vec![("/home/u/.claude/.credentials.json", creds.to_string())]);
        let c = read_claude_credentials(&s).await.unwrap();
        assert_eq!((c.access_token.as_str(), c.expires_at, c.has_refresh), ("at", Some(5.0), true));
        assert_eq!(c.refresh_hash.as_deref(), Some(js::sha256_hex("rt").as_str()));
        assert_eq!(c.plan.as_deref(), Some("Pro"));
        assert!(read_cleared_claude_login(&s).await.is_none());
        // A profile never reads the live file.
        assert!(read_claude_credentials(&s.profile(Path::new("/p/1"))).await.is_none());
        let cleared = json!({ "claudeAiOauth": { "accessToken": "", "refreshToken": "", "subscriptionType": "max" } });
        let p = source(vec![("/p/1/.credentials.json", cleared.to_string())]).profile(Path::new("/p/1"));
        assert!(read_claude_credentials(&p).await.is_none());
        assert_eq!(read_cleared_claude_login(&p).await, Some(Some("Max".into())));
    }

    #[test]
    fn codex_credentials_from_jwt_claims() {
        // id token claims: {"email":"c@x.io","https://api.openai.com/auth":{"chatgpt_plan_type":"plus","chatgpt_user_id":"u1"}}
        let id = format!(
            "h.{}.s",
            base64_url(r#"{"email":"c@x.io","https://api.openai.com/auth":{"chatgpt_plan_type":"plus","chatgpt_user_id":"u1"}}"#)
        );
        let access = format!("h.{}.s", base64_url(r#"{"exp":100}"#));
        let auth = json!({ "tokens": { "access_token": access, "id_token": id, "account_id": "acc", "refresh_token": "r" } });
        let s = source(vec![("/home/u/.codex/auth.json", auth.to_string())]);
        let c = read_codex_credentials(&s).unwrap();
        assert!(c.mode == CodexMode::Chatgpt);
        assert_eq!((c.email.as_deref(), c.plan.as_deref(), c.user_id.as_deref()), (Some("c@x.io"), Some("plus"), Some("u1")));
        assert_eq!((c.expires_at, c.account_id.as_deref(), c.has_refresh), (Some(100_000.0), Some("acc"), true));
        let key = source(vec![("/home/u/.codex/auth.json", json!({ "OPENAI_API_KEY": "sk" }).to_string())]);
        assert!(read_codex_credentials(&key).unwrap().mode == CodexMode::ApiKey);
        assert!(read_codex_credentials(&source(vec![])).is_none());
    }

    fn base64_url(text: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text)
    }

    // ---- case-by-case ports of test/usage-credentials.test.ts --------------------------------------------------------

    struct CountingKeychain(Arc<std::sync::atomic::AtomicUsize>, Option<String>);

    impl Keychain for CountingKeychain {
        fn read(&self) -> BoxFuture<'static, Option<String>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let v = self.1.clone();
            async move { v }.boxed()
        }
    }

    fn with_env(mut s: CredentialSource, env: &[(&str, &str)]) -> CredentialSource {
        s.env = Arc::new(env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        s
    }

    fn live(raw: &str) -> CredentialSource {
        source(vec![("/home/u/.claude/.credentials.json", raw.to_string())])
    }

    /// "reads the token, expiry and plan from the credentials file", "labels plans with and without a multiplier", "prefers
    /// the environment token and honours CLAUDE_CONFIG_DIR", "treats missing, corrupt or incomplete files as signed out"
    #[tokio::test]
    async fn ts_claude_credentials_file_env_token_config_dir_and_bad_files() {
        let raw = json!({ "claudeAiOauth": { "accessToken": "tok-1", "expiresAt": 1781010642000u64, "subscriptionType": "max", "rateLimitTier": "default_claude_max_5x" } });
        let c = read_claude_credentials(&live(&raw.to_string())).await.unwrap();
        assert_eq!(
            (c.access_token.as_str(), c.expires_at, c.plan.as_deref(), c.has_refresh),
            ("tok-1", Some(1_781_010_642_000.0), Some("Max 5x"), false)
        );
        assert_eq!(claude_plan_label(Some(&json!("pro")), Some(&json!("default_claude_pro"))).as_deref(), Some("Pro"));
        assert_eq!(claude_plan_label(Some(&json!("MAX")), Some(&json!("x_20x"))).as_deref(), Some("Max 20x"));
        assert_eq!(claude_plan_label(None, None), None);
        assert_eq!(claude_plan_label(Some(&json!(5)), None), None);

        let env = with_env(source(vec![]), &[("CLAUDE_CODE_OAUTH_TOKEN", " env-token ")]);
        let c = read_claude_credentials(&env).await.unwrap();
        assert_eq!((c.access_token.as_str(), c.expires_at, c.plan, c.has_refresh), ("env-token", None, None, false));
        let other = with_env(
            source(vec![("/o/.credentials.json", json!({ "claudeAiOauth": { "accessToken": "tok-2" } }).to_string())]),
            &[("CLAUDE_CONFIG_DIR", "/o")],
        );
        assert_eq!(read_claude_credentials(&other).await.unwrap().access_token, "tok-2");

        assert!(read_claude_credentials(&source(vec![])).await.is_none());
        for bad in ["{not json", r#"{"claudeAiOauth":{"accessToken":""}}"#, r#"{"somethingElse":true}"#, "[]"] {
            assert!(read_claude_credentials(&live(bad)).await.is_none(), "{bad}");
        }
    }

    /// "falls back to the macOS Keychain only on macOS and only without a file"
    #[tokio::test]
    async fn ts_the_keychain_only_on_macos_and_only_without_a_file() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let kc: Arc<dyn Keychain> =
            Arc::new(CountingKeychain(calls.clone(), Some(json!({ "claudeAiOauth": { "accessToken": "tok-kc" } }).to_string())));
        let mut win = source(vec![]);
        win.keychain = Some(kc.clone());
        assert!(read_claude_credentials(&win).await.is_none());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        let mac = CredentialSource { darwin: true, ..win.clone() };
        let c = read_claude_credentials(&mac).await.unwrap();
        assert_eq!((c.access_token.as_str(), c.expires_at, c.plan, c.has_refresh), ("tok-kc", None, None, false));
        let mut file = live(&json!({ "claudeAiOauth": { "accessToken": "tok-file" } }).to_string());
        file.darwin = true;
        file.keychain = Some(kc);
        assert_eq!(read_claude_credentials(&file).await.unwrap().access_token, "tok-file");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// "works when the tokens carry no readable claims", "recognises API key logins, which have no limits", "honours CODEX_HOME
    /// and treats missing or corrupt files as signed out"
    #[test]
    fn ts_codex_credentials_opaque_tokens_api_keys_codex_home_and_bad_files() {
        let chatgpt = |access: &str, id: &str| {
            json!({ "auth_mode": "chatgpt", "OPENAI_API_KEY": null, "tokens": { "id_token": id, "access_token": access, "refresh_token": "r", "account_id": "acc-1" } }).to_string()
        };
        let c = read_codex_credentials(&source(vec![("/home/u/.codex/auth.json", chatgpt("opaque", "opaque"))])).unwrap();
        assert!(c.mode == CodexMode::Chatgpt);
        assert_eq!((c.access_token.as_deref(), c.account_id.as_deref(), c.expires_at), (Some("opaque"), Some("acc-1"), None));
        assert_eq!((c.plan, c.email, c.has_refresh), (None, None, true));
        let key = json!({ "auth_mode": "apikey", "OPENAI_API_KEY": "sk-test", "tokens": null }).to_string();
        let c = read_codex_credentials(&source(vec![("/home/u/.codex/auth.json", key)])).unwrap();
        assert!(c.mode == CodexMode::ApiKey && c.access_token.is_none() && c.account_id.is_none());
        assert!(read_codex_credentials(&source(vec![])).is_none());
        assert!(read_codex_credentials(&source(vec![("/home/u/.codex/auth.json", "{broken".into())])).is_none());
        let empty = json!({ "auth_mode": "chatgpt", "tokens": { "access_token": "" } }).to_string();
        assert!(read_codex_credentials(&source(vec![("/home/u/.codex/auth.json", empty)])).is_none());
        let elsewhere = with_env(source(vec![("/e/auth.json", chatgpt("opaque", "opaque"))]), &[("CODEX_HOME", "/e")]);
        assert!(read_codex_credentials(&elsewhere).unwrap().mode == CodexMode::Chatgpt);
    }

    /// "holds a null result for the hold time and then asks again", "forgets a remembered failure on reset (a login must see
    /// fresh credentials)", "does not cache a successful read"
    #[tokio::test]
    async fn ts_the_failure_cache_holds_a_failure_until_the_hold_ends_or_a_reset() {
        let clock = Arc::new(Mutex::new(1000.0));
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let answers = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
        let (c, a) = (calls.clone(), answers.clone());
        let read: Arc<dyn Fn() -> BoxFuture<'static, Option<String>> + Send + Sync> = Arc::new(move || {
            c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let v = a.lock().pop().flatten();
            async move { v }.boxed()
        });
        let k = clock.clone();
        let cached = FailureCache::new(read, Duration::from_millis(500), Arc::new(move || *k.lock()));
        let n = || calls.load(std::sync::atomic::Ordering::SeqCst);
        assert!(cached.read().await.is_none());
        *clock.lock() += 499.0;
        assert!(cached.read().await.is_none());
        assert_eq!(n(), 1);
        *clock.lock() += 2.0;
        cached.read().await;
        assert_eq!(n(), 2);
        // Reset: the next read asks again and sees the fresh login.
        *answers.lock() = vec![Some("secret".into())];
        assert!(cached.read().await.is_none());
        assert_eq!(n(), 2);
        cached.reset();
        assert_eq!(cached.read().await.as_deref(), Some("secret"));
        // A success is not cached.
        *answers.lock() = vec![Some("secret".into()), Some("secret".into())];
        assert_eq!(cached.read().await.as_deref(), Some("secret"));
        assert_eq!(cached.read().await.as_deref(), Some("secret"));
        assert_eq!(n(), 5);
    }

    /// "points at the profile directory, drops the env token and never reaches the Keychain"
    #[tokio::test]
    async fn ts_a_profile_source_uses_its_directory_without_the_env_token_or_the_keychain() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let kc: Arc<dyn Keychain> = Arc::new(CountingKeychain(
            calls.clone(),
            Some(json!({ "claudeAiOauth": { "accessToken": "keychain-token" } }).to_string()),
        ));
        let mut base =
            with_env(source(vec![]), &[("CLAUDE_CODE_OAUTH_TOKEN", "env-token"), ("CLAUDE_CONFIG_DIR", "/main"), ("KEEP", "1")]);
        base.darwin = true;
        base.keychain = Some(kc);
        let p = base.profile(Path::new("/profile"));
        assert_eq!(p.env.get("CLAUDE_CONFIG_DIR").map(String::as_str), Some("/profile"));
        assert_eq!(
            (p.env.get("CLAUDE_CODE_OAUTH_TOKEN").map(String::as_str), p.env.get("KEEP").map(String::as_str)),
            (Some(""), Some("1"))
        );
        assert!(!p.darwin);
        assert!(read_claude_credentials(&p).await.is_none());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        let files = source(vec![(
            "/profile/.credentials.json",
            json!({ "claudeAiOauth": { "accessToken": "tok-profile" } }).to_string(),
        )]);
        let p = CredentialSource { read_file: files.read_file, ..p };
        assert_eq!(read_claude_credentials(&p).await.unwrap().access_token, "tok-profile");
    }

    /// "reads the email and organization from .claude.json in the home directory", "reads .claude.json from CLAUDE_CONFIG_DIR
    /// when it is set", "returns nothing for a missing, corrupt or non-object file"
    #[test]
    fn ts_read_claude_identity_from_home_or_config_dir() {
        let account = json!({ "oauthAccount": { "emailAddress": "me@example.com", "organizationName": "Acme" } }).to_string();
        let id = read_claude_identity(&source(vec![("/home/u/.claude.json", account.clone())]));
        assert_eq!((id.email.as_deref(), id.org.as_deref()), (Some("me@example.com"), Some("Acme")));
        let other = json!({ "oauthAccount": { "emailAddress": "other@example.com" } }).to_string();
        let s = with_env(
            source(vec![("/home/u/.claude.json", account), ("/profile/.claude.json", other)]),
            &[("CLAUDE_CONFIG_DIR", "/profile")],
        );
        let id = read_claude_identity(&s);
        assert_eq!((id.email.as_deref(), id.org), (Some("other@example.com"), None));
        assert_eq!(read_claude_identity(&source(vec![])), AccountIdentity::default());
        for bad in ["{broken", "[1,2]", r#"{"oauthAccount":"x"}"#] {
            assert_eq!(
                read_claude_identity(&source(vec![("/home/u/.claude.json", bad.into())])),
                AccountIdentity::default(),
                "{bad}"
            );
        }
    }

    /// "reports a refresh token without exposing it and stamps the file"
    #[tokio::test]
    async fn ts_a_refresh_token_is_reported_only_as_a_hash_and_the_file_is_stamped() {
        let home = tempfile::tempdir().unwrap();
        let s = CredentialSource::system(BTreeMap::new(), home.path().to_path_buf(), false, None);
        assert!(claude_credentials_stamp(&s).is_none());
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        let file = home.path().join(".claude").join(".credentials.json");
        std::fs::write(&file, json!({ "claudeAiOauth": { "accessToken": "at", "refreshToken": "rt" } }).to_string()).unwrap();
        let c = read_claude_credentials(&s).await.unwrap();
        assert_eq!((c.access_token.as_str(), c.has_refresh), ("at", true));
        assert_ne!(c.refresh_hash.as_deref(), Some("rt"));
        let before = claude_credentials_stamp(&s);
        std::fs::write(&file, json!({ "claudeAiOauth": { "accessToken": "at2", "refreshToken": "rt2" } }).to_string()).unwrap();
        assert!(before.is_some() && claude_credentials_stamp(&s).is_some());
        assert_ne!(before, claude_credentials_stamp(&s), "a longer file changes the stamp");
    }
}
