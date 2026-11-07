//! Who a Claude login belongs to (port of the identity part of src/shared/accounts.ts, src/main/accounts/identity.ts and the
//! `.claude.json` readers of src/main/usage/credentials.ts).
//!
//! accountUuid (with organizationUuid) identifies an account; e-mail and organisation name are labels and the fallback.

use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::js;

/// The four identity fields, in the order `identityFields` builds them (and accounts.json holds them).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_uuid: Option<String>,
}

/// The identity keys in their written order.
pub const IDENTITY_KEYS: [&str; 4] = ["email", "org", "accountUuid", "organizationUuid"];

impl AccountIdentity {
    pub fn is_empty(&self) -> bool {
        self.email.is_none() && self.org.is_none() && self.account_uuid.is_none() && self.organization_uuid.is_none()
    }

    pub(crate) fn field(&self, key: &str) -> Option<&str> {
        match key {
            "email" => self.email.as_deref(),
            "org" => self.org.as_deref(),
            "accountUuid" => self.account_uuid.as_deref(),
            "organizationUuid" => self.organization_uuid.as_deref(),
            _ => None,
        }
    }

    fn field_mut(&mut self, key: &str) -> &mut Option<String> {
        match key {
            "email" => &mut self.email,
            "org" => &mut self.org,
            "accountUuid" => &mut self.account_uuid,
            _ => &mut self.organization_uuid,
        }
    }

    /// Appends the present fields to a JSON object in the written order.
    pub(crate) fn write_into(&self, out: &mut Map<String, Value>) {
        for key in IDENTITY_KEYS {
            if let Some(v) = self.field(key) {
                out.insert(key.into(), Value::String(v.into()));
            }
        }
    }
}

/// `'same' | 'different' | 'unknown'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IdentityMatch {
    Same,
    Different,
    Unknown,
}

/// Role of a saved account (0.9.1): `app` - the app holds the only copy and may renew it; `live` - the account signed in to
/// Claude Code; `foreign` - it left the live login through another tool; `quarantined` - a duplicate set aside.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Custody {
    App,
    Live,
    Foreign,
    Quarantined,
}

impl Custody {
    pub fn as_str(self) -> &'static str {
        match self {
            Custody::App => "app",
            Custody::Live => "live",
            Custody::Foreign => "foreign",
            Custody::Quarantined => "quarantined",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "app" => Custody::App,
            "live" => Custody::Live,
            "foreign" => Custody::Foreign,
            "quarantined" => Custody::Quarantined,
            _ => return None,
        })
    }
}

/// Where the tokens in a profile dir came from: an app login (`own`) or a copy of the live login (`live`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenFamily {
    Own,
    Live,
}

impl TokenFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenFamily::Own => "own",
            TokenFamily::Live => "live",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "own" => TokenFamily::Own,
            "live" => TokenFamily::Live,
            _ => return None,
        })
    }
}

/// `custodyOf`: absent in 0.9.0 records means `app`.
pub fn custody_of(custody: Option<Custody>) -> Custody {
    custody.unwrap_or(Custody::App)
}

/// `familyOf`: absent in 0.9.0 records means `live` (unknown provenance, the conservative reading).
pub fn family_of(family: Option<TokenFamily>) -> TokenFamily {
    family.unwrap_or(TokenFamily::Live)
}

/// Account ids arrive over IPC and become path segments, so only lowercase UUIDs are accepted (`isAccountId`).
pub fn is_account_id(value: &str) -> bool {
    js::is_lower_uuid(value)
}

/// `isAccountId(value)` for any JSON value.
pub fn is_account_id_value(value: Option<&Value>) -> bool {
    js::string(value).is_some_and(is_account_id)
}

/// A truthy string (`!!value`).
fn truthy(v: &Option<String>) -> Option<&str> {
    v.as_deref().filter(|s| !s.is_empty())
}

/// `nonEmpty`: a string with something besides white space.
fn non_empty(v: Option<&Value>) -> Option<String> {
    js::string(v).filter(|s| !js::trim(s).is_empty()).map(str::to_string)
}

/// `identityFields` of a JSON object: the four fields that are non-empty strings.
pub fn identity_fields_of(value: &Map<String, Value>) -> AccountIdentity {
    let mut out = AccountIdentity::default();
    for key in IDENTITY_KEYS {
        *out.field_mut(key) = non_empty(value.get(key));
    }
    out
}

/// `identityFields` of a typed identity (drops empty and white-space-only values).
pub fn identity_fields(i: &AccountIdentity) -> AccountIdentity {
    let keep = |v: &Option<String>| v.clone().filter(|s| !js::trim(s).is_empty());
    AccountIdentity {
        email: keep(&i.email),
        org: keep(&i.org),
        account_uuid: keep(&i.account_uuid),
        organization_uuid: keep(&i.organization_uuid),
    }
}

/// Identity of an `oauthAccount` object as Claude Code writes it into `.claude.json`.
pub fn identity_from_oauth_account(value: Option<&Value>) -> AccountIdentity {
    let empty = Map::new();
    let a = js::record(value).unwrap_or(&empty);
    AccountIdentity {
        email: non_empty(a.get("emailAddress")),
        org: non_empty(a.get("organizationName")),
        account_uuid: non_empty(a.get("accountUuid")),
        organization_uuid: non_empty(a.get("organizationUuid")),
    }
}

/// accountUuid decides when both sides know it; otherwise the e-mail; the organisation (uuid, else name) tells two orgs of one
/// person apart.
pub fn compare_identity(a: &AccountIdentity, b: &AccountIdentity) -> IdentityMatch {
    let org_differs = || {
        if let (Some(x), Some(y)) = (truthy(&a.organization_uuid), truthy(&b.organization_uuid)) {
            return x != y;
        }
        match (js::norm(a.org.as_deref()), js::norm(b.org.as_deref())) {
            (Some(x), Some(y)) => x != y,
            _ => false,
        }
    };
    let verdict = |same: bool| if same && !org_differs() { IdentityMatch::Same } else { IdentityMatch::Different };
    if let (Some(x), Some(y)) = (truthy(&a.account_uuid), truthy(&b.account_uuid)) {
        return verdict(x == y);
    }
    if let (Some(x), Some(y)) = (js::norm(a.email.as_deref()), js::norm(b.email.as_deref())) {
        return verdict(x == y);
    }
    IdentityMatch::Unknown
}

/// Stable key of an account for caches and backoff (never the slot it sits in); `None` when nothing identifies it.
pub fn identity_key(i: &AccountIdentity) -> Option<String> {
    if let Some(uuid) = truthy(&i.account_uuid) {
        return Some(format!("uuid:{uuid}:{}", i.organization_uuid.as_deref().unwrap_or("-")));
    }
    let email = js::norm(i.email.as_deref())?;
    let org = match &i.organization_uuid {
        Some(o) => o.clone(),
        None => js::norm(i.org.as_deref()).unwrap_or_else(|| "-".into()),
    };
    Some(format!("email:{email}:{org}"))
}

/// The identity fields `found` knows and `record` lacks (a known value is never overwritten).
pub fn fill_missing_identity(record: &AccountIdentity, found: &AccountIdentity) -> AccountIdentity {
    let mut patch = AccountIdentity::default();
    for key in ["accountUuid", "organizationUuid", "email", "org"] {
        let known = record.field(key).is_some_and(|s| !s.is_empty());
        if let Some(v) = found.field(key).filter(|s| !s.is_empty())
            && !known
        {
            *patch.field_mut(key) = Some(v.to_string());
        }
    }
    patch
}

/// `<CLAUDE_CONFIG_DIR>/.claude.json` when the variable is set (trimmed, non-empty), else `<home>/.claude.json`.
pub fn claude_json_path(config_dir: Option<&str>, home: &Path) -> PathBuf {
    match config_dir.map(js::trim).filter(|d| !d.is_empty()) {
        Some(dir) => Path::new(dir).join(".claude.json"),
        None => home.join(".claude.json"),
    }
}

/// `readClaudeIdentity`: who a Claude login belongs to, from the config file Claude Code keeps next to it (read only). A
/// missing, unreadable or unparsable file gives an empty identity.
pub fn read_claude_identity(config_dir: Option<&str>, home: &Path) -> AccountIdentity {
    let Ok(raw) = js::read_text(&claude_json_path(config_dir, home)) else { return AccountIdentity::default() };
    if raw.is_empty() {
        return AccountIdentity::default();
    }
    match unimux_core::js_json::parse(&raw) {
        Ok(parsed) => identity_from_oauth_account(js::record(Some(&parsed)).and_then(|m| m.get("oauthAccount"))),
        Err(_) => AccountIdentity::default(),
    }
}

/// The live Claude Code config exists but cannot be read or parsed (locked, a directory, half written): who is signed in is
/// unknown. Never includes a path or system message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("live Claude config unreadable")]
pub struct LiveIdentityUnknown;

/// `readLiveClaudeIdentity`: who is signed in to Claude Code. `Ok(None)` only when nobody is (no config file, or a config that
/// parses and has no account); any other read error or a file that does not parse is [`LiveIdentityUnknown`], so a busy file is
/// never taken for a sign-out.
pub fn read_live_claude_identity(config_dir: Option<&str>, home: &Path) -> Result<Option<AccountIdentity>, LiveIdentityUnknown> {
    read_live_claude_identity_with(config_dir, home, &mut |p| js::read_text(p))
}

/// [`read_live_claude_identity`] with a read seam (tests).
pub fn read_live_claude_identity_with(
    config_dir: Option<&str>,
    home: &Path,
    read: &mut dyn FnMut(&Path) -> io::Result<String>,
) -> Result<Option<AccountIdentity>, LiveIdentityUnknown> {
    let raw = match read(&claude_json_path(config_dir, home)) {
        Ok(raw) => raw,
        Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) => return Ok(None),
        Err(_) => return Err(LiveIdentityUnknown),
    };
    let parsed = unimux_core::js_json::parse(&raw).map_err(|_| LiveIdentityUnknown)?;
    let map = js::record(Some(&parsed)).ok_or(LiveIdentityUnknown)?;
    let identity = identity_from_oauth_account(map.get("oauthAccount"));
    Ok((identity.email.is_some() || identity.account_uuid.is_some()).then_some(identity))
}

/// What `readManagedIdentity` found: the identity and, from `claude auth status`, the plan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedIdentity {
    #[serde(flatten)]
    pub identity: AccountIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

/// `readManagedIdentity`: who is logged in to a managed profile, the profile's `.claude.json` first, then
/// `claude auth status --json` run by `exec` with `CLAUDE_CONFIG_DIR` set to the profile and the token variables blanked.
/// `exec` gives the command's stdout, or `None` when it failed (both read as "unknown": an empty identity).
pub async fn read_managed_identity<F, Fut>(dir: &Path, env: &BTreeMap<String, String>, exec: F) -> ManagedIdentity
where
    F: FnOnce(String, Vec<String>, BTreeMap<String, String>) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    let dir_text = dir.to_string_lossy();
    let from_file = read_claude_identity(Some(&dir_text), Path::new(""));
    if from_file.email.is_some() {
        return ManagedIdentity { identity: from_file, plan: None };
    }
    let mut env = env.clone();
    env.insert("CLAUDE_CONFIG_DIR".into(), dir_text.into_owned());
    env.insert("CLAUDE_CODE_OAUTH_TOKEN".into(), String::new());
    env.insert("ANTHROPIC_API_KEY".into(), String::new());
    let args = ["auth", "status", "--json"].map(String::from).to_vec();
    let Some(raw) = exec("claude".into(), args, env).await else { return ManagedIdentity::default() };
    let Ok(parsed) = unimux_core::js_json::parse(&raw) else { return ManagedIdentity::default() };
    let Some(status) = js::record(Some(&parsed)) else { return ManagedIdentity::default() };
    if status.get("loggedIn") != Some(&Value::Bool(true)) {
        return ManagedIdentity::default();
    }
    let text = |key: &str| js::string(status.get(key)).filter(|s| !s.is_empty()).map(str::to_string);
    ManagedIdentity {
        identity: AccountIdentity { email: text("email"), org: text("orgName"), ..Default::default() },
        plan: text("subscriptionType"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id(v: Value) -> AccountIdentity {
        identity_fields_of(v.as_object().unwrap())
    }

    // test/accounts-identity-model.test.ts
    #[test]
    fn compares_by_account_uuid_and_organization_uuid_first() {
        let c = |a: Value, b: Value| compare_identity(&id(a), &id(b));
        assert_eq!(
            c(json!({"accountUuid": "u1", "email": "a@x.com"}), json!({"accountUuid": "u1", "email": "other@x.com"})),
            IdentityMatch::Same
        );
        assert_eq!(c(json!({"accountUuid": "u1"}), json!({"accountUuid": "u2"})), IdentityMatch::Different);
        assert_eq!(
            c(json!({"accountUuid": "u1", "organizationUuid": "o1"}), json!({"accountUuid": "u1", "organizationUuid": "o2"})),
            IdentityMatch::Different
        );
        assert_eq!(c(json!({"accountUuid": "u1", "organizationUuid": "o1"}), json!({"accountUuid": "u1"})), IdentityMatch::Same);
    }

    #[test]
    fn falls_back_to_the_email_with_the_organisation_never_to_the_organisation_name_alone() {
        let c = |a: Value, b: Value| compare_identity(&id(a), &id(b));
        assert_eq!(c(json!({"email": "A@x.com"}), json!({"email": "a@X.com "})), IdentityMatch::Same);
        assert_eq!(
            c(json!({"email": "a@x.com", "org": "Acme"}), json!({"email": "a@x.com", "org": "Other"})),
            IdentityMatch::Different
        );
        assert_eq!(
            c(json!({"email": "a@x.com", "organizationUuid": "o1"}), json!({"email": "a@x.com", "organizationUuid": "o2"})),
            IdentityMatch::Different
        );
        assert_eq!(c(json!({"email": "a@x.com"}), json!({"email": "b@x.com"})), IdentityMatch::Different);
        assert_eq!(c(json!({"org": "Acme"}), json!({"org": "Acme"})), IdentityMatch::Unknown);
        assert_eq!(c(json!({}), json!({"email": "a@x.com"})), IdentityMatch::Unknown);
    }

    #[test]
    fn keys_cache_entries_by_identity() {
        let k = |v: Value| identity_key(&id(v));
        assert_eq!(k(json!({"accountUuid": "u1", "organizationUuid": "o1", "email": "a@x.com"})).as_deref(), Some("uuid:u1:o1"));
        assert_eq!(k(json!({"accountUuid": "u1"})).as_deref(), Some("uuid:u1:-"));
        assert_eq!(k(json!({"email": "A@x.com", "org": "Acme"})).as_deref(), Some("email:a@x.com:acme"));
        assert_eq!(k(json!({"org": "Acme"})), None);
    }

    #[test]
    fn reads_oauth_account_of_a_claude_json_and_keeps_only_non_empty_strings() {
        let got = identity_from_oauth_account(Some(&json!({
            "emailAddress": "a@x.com", "organizationName": "Acme", "accountUuid": "u1", "organizationUuid": "o1", "displayName": "A"
        })));
        assert_eq!(
            serde_json::to_value(&got).unwrap(),
            json!({"email": "a@x.com", "org": "Acme", "accountUuid": "u1", "organizationUuid": "o1"})
        );
        assert_eq!(identity_from_oauth_account(Some(&Value::Null)), AccountIdentity::default());
        assert_eq!(serde_json::to_value(id(json!({"email": "", "org": "x", "accountUuid": 7}))).unwrap(), json!({"org": "x"}));
    }

    #[test]
    fn fills_only_the_identity_fields_a_record_lacks() {
        let got = fill_missing_identity(
            &id(json!({"email": "a@x.com", "org": "Acme"})),
            &id(json!({"email": "b@x.com", "org": "Other", "accountUuid": "u1", "organizationUuid": "o1"})),
        );
        assert_eq!(serde_json::to_value(got).unwrap(), json!({"accountUuid": "u1", "organizationUuid": "o1"}));
        assert!(fill_missing_identity(&id(json!({"accountUuid": "u1"})), &AccountIdentity::default()).is_empty());
    }

    #[test]
    fn defaults_custody_app_family_live() {
        assert_eq!(custody_of(None), Custody::App);
        assert_eq!(family_of(None), TokenFamily::Live);
    }

    // test/accounts-identity.test.ts
    fn exec_never() -> impl FnOnce(String, Vec<String>, BTreeMap<String, String>) -> std::future::Ready<Option<String>> {
        |_, _, _| panic!("the CLI must not run")
    }

    #[test]
    fn prefers_claude_json_and_skips_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"a@x.com","organizationName":"Org"}}"#,
        )
        .unwrap();
        let got = futures::executor::block_on(read_managed_identity(dir.path(), &BTreeMap::new(), exec_never()));
        assert_eq!(serde_json::to_value(got).unwrap(), json!({"email": "a@x.com", "org": "Org"}));
    }

    #[test]
    fn falls_back_to_the_cli_with_claude_config_dir_set_to_the_profile() {
        let dir = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([("PATH".to_string(), "p".to_string())]);
        let mut seen = None;
        let got = futures::executor::block_on(read_managed_identity(dir.path(), &env, |c, a, e| {
            seen = Some((c, a, e));
            std::future::ready(Some(r#"{"loggedIn":true,"email":"c@x.com","orgName":"O","subscriptionType":"max"}"#.to_string()))
        }));
        assert_eq!(serde_json::to_value(got).unwrap(), json!({"email": "c@x.com", "org": "O", "plan": "max"}));
        let (command, args, env) = seen.unwrap();
        assert_eq!(command, "claude");
        assert_eq!(args, ["auth", "status", "--json"]);
        assert_eq!(env["CLAUDE_CONFIG_DIR"], dir.path().to_string_lossy());
        assert_eq!(env["PATH"], "p");
        assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "");
        assert_eq!(env["ANTHROPIC_API_KEY"], "");
    }

    #[test]
    fn gives_empty_for_logged_out_bad_json_null_and_throwing_exec() {
        let dir = tempfile::tempdir().unwrap();
        for out in [Some(r#"{"loggedIn":false,"email":"x@x.com"}"#), Some("nope"), None] {
            let got = futures::executor::block_on(read_managed_identity(dir.path(), &BTreeMap::new(), |_, _, _| {
                std::future::ready(out.map(str::to_string))
            }));
            assert_eq!(got, ManagedIdentity::default());
        }
    }

    #[test]
    fn live_identity_tells_signed_out_from_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        assert_eq!(read_live_claude_identity(None, home), Ok(None));
        std::fs::write(home.join(".claude.json"), "{half").unwrap();
        assert_eq!(read_live_claude_identity(None, home), Err(LiveIdentityUnknown));
        std::fs::write(home.join(".claude.json"), "[]").unwrap();
        assert_eq!(read_live_claude_identity(None, home), Err(LiveIdentityUnknown));
        std::fs::write(home.join(".claude.json"), r#"{"oauthAccount":{"organizationName":"Acme"}}"#).unwrap();
        assert_eq!(read_live_claude_identity(None, home), Ok(None));
        std::fs::write(home.join(".claude.json"), r#"{"oauthAccount":{"accountUuid":"u1"}}"#).unwrap();
        assert_eq!(read_live_claude_identity(None, home).unwrap().unwrap().account_uuid.as_deref(), Some("u1"));
        // CLAUDE_CONFIG_DIR (trimmed) wins over the home directory; a directory in place of the file is "unknown".
        let config = home.join("cfg");
        std::fs::create_dir_all(config.join(".claude.json")).unwrap();
        let padded = format!("  {}  ", config.display());
        assert_eq!(read_live_claude_identity(Some(&padded), home), Err(LiveIdentityUnknown));
        assert_eq!(read_claude_identity(Some(&padded), home), AccountIdentity::default());
    }
}
