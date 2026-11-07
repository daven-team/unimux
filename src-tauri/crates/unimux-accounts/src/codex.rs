//! Several Codex accounts (1.1.2; port of src/shared/codexAccounts.ts and `parseCodexAuth` of
//! src/main/accounts/codexActivate.ts).
//!
//! Codex CLI keeps its one login in `$CODEX_HOME/auth.json`. The app keeps every other account in its own profile directory (a
//! CODEX_HOME of its own) and "make main" copies that profile's auth.json into the live CODEX_HOME. The family rule: the app
//! never renews a Codex token itself; a profile copied into the live file is a stale twin from then on (`liveFamily`), and one
//! switched out by anything else may be outdated (`outdated`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::identity::IdentityMatch;
use crate::js;

/// Who a Codex (ChatGPT) login belongs to: the user and the workspace (`chatgpt_account_id`), e-mail as the label.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

impl CodexIdentity {
    fn any(&self) -> bool {
        truthy(&self.email).is_some() || truthy(&self.user_id).is_some() || truthy(&self.account_id).is_some()
    }

    fn write_into(&self, out: &mut Map<String, Value>) {
        for (key, v) in [("email", &self.email), ("userId", &self.user_id), ("accountId", &self.account_id)] {
            if let Some(v) = v {
                out.insert(key.into(), Value::String(v.clone()));
            }
        }
    }
}

/// A saved Codex account.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccount {
    pub id: String,
    pub added_at: f64,
    #[serde(flatten)]
    pub identity: CodexIdentity,
    /// The profile's copy is the same login as the live auth.json (it was made main): a stale twin, never used.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub live_family: bool,
    /// Switched out of the live file by something else while it was main: the copy may be outdated.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub outdated: bool,
}

/// The identity last seen in the live auth.json and its record.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLive {
    #[serde(flatten)]
    pub identity: CodexIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
}

/// `codex-accounts/accounts.json` (`version` is always 1).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountsFile {
    pub accounts: Vec<CodexAccount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<CodexLive>,
}

impl CodexAccount {
    /// The object as the TS code holds it (every field, unfiltered; [`normalize_codex_accounts`] filters).
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(self.id.clone()));
        m.insert("addedAt".into(), js::num(self.added_at));
        self.identity.write_into(&mut m);
        if self.live_family {
            m.insert("liveFamily".into(), Value::Bool(true));
        }
        if self.outdated {
            m.insert("outdated".into(), Value::Bool(true));
        }
        Value::Object(m)
    }
}

impl CodexLive {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        self.identity.write_into(&mut m);
        if let Some(r) = &self.record_id {
            m.insert("recordId".into(), Value::String(r.clone()));
        }
        Value::Object(m)
    }
}

impl CodexAccountsFile {
    /// `{ version: 1, accounts, live? }` in the written key order.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("version".into(), Value::from(1));
        m.insert("accounts".into(), Value::Array(self.accounts.iter().map(CodexAccount::to_value).collect()));
        if let Some(live) = &self.live {
            m.insert("live".into(), live.to_value());
        }
        Value::Object(m)
    }
}

fn truthy(v: &Option<String>) -> Option<&str> {
    v.as_deref().filter(|s| !s.is_empty())
}

/// User and workspace decide when both sides know them; otherwise the e-mail (with the workspace when both know it).
pub fn compare_codex_identity(a: &CodexIdentity, b: &CodexIdentity) -> IdentityMatch {
    let verdict = |same: bool| if same { IdentityMatch::Same } else { IdentityMatch::Different };
    let workspace_differs = matches!((truthy(&a.account_id), truthy(&b.account_id)), (Some(x), Some(y)) if x != y);
    if let (Some(x), Some(y)) = (truthy(&a.user_id), truthy(&b.user_id)) {
        return verdict(x == y && !workspace_differs);
    }
    if let (Some(x), Some(y)) = (js::norm(a.email.as_deref()), js::norm(b.email.as_deref())) {
        return verdict(x == y && !workspace_differs);
    }
    if let (Some(x), Some(y)) = (truthy(&a.account_id), truthy(&b.account_id))
        && truthy(&a.email).is_none()
        && truthy(&b.email).is_none()
    {
        return verdict(x == y);
    }
    IdentityMatch::Unknown
}

/// Stable key for caches (never the slot): user and workspace, else e-mail; `None` when nothing identifies it.
pub fn codex_identity_key(i: &CodexIdentity) -> Option<String> {
    if let Some(user) = truthy(&i.user_id) {
        return Some(format!("codex-user:{user}:{}", i.account_id.as_deref().unwrap_or("-")));
    }
    let email = js::norm(i.email.as_deref())?;
    Some(format!("codex-email:{email}:{}", i.account_id.as_deref().unwrap_or("-")))
}

/// Lowercase UUIDs only (they become path segments).
pub fn is_codex_account_id(value: &str) -> bool {
    js::is_lower_uuid(value)
}

/// `text`: a string with something besides white space, at most 200 UTF-16 units.
fn text(v: Option<&Value>) -> Option<String> {
    js::string(v).filter(|s| !js::trim(s).is_empty() && js::len16(s) <= 200).map(str::to_string)
}

fn identity_of(raw: &Map<String, Value>) -> CodexIdentity {
    CodexIdentity { email: text(raw.get("email")), user_id: text(raw.get("userId")), account_id: text(raw.get("accountId")) }
}

/// Reads accounts.json of the Codex profiles; damaged records are dropped, duplicate ids keep the first, a live record id
/// that names no record is dropped.
pub fn normalize_codex_accounts(value: &Value) -> CodexAccountsFile {
    let empty = Map::new();
    let r = js::record(Some(value)).unwrap_or(&empty);
    let mut seen: Vec<String> = Vec::new();
    let mut accounts = Vec::new();
    if let Some(Value::Array(items)) = r.get("accounts") {
        for raw in items {
            let Some(raw) = js::record(Some(raw)) else { continue };
            let Some(id) = js::string(raw.get("id")).filter(|id| is_codex_account_id(id)) else { continue };
            if seen.iter().any(|s| s == id) {
                continue;
            }
            seen.push(id.to_string());
            accounts.push(CodexAccount {
                id: id.to_string(),
                added_at: js::finite(raw.get("addedAt")).unwrap_or(0.0),
                identity: identity_of(raw),
                live_family: raw.get("liveFamily") == Some(&Value::Bool(true)),
                outdated: raw.get("outdated") == Some(&Value::Bool(true)),
            });
        }
    }
    let live = js::record(r.get("live")).map(|raw| CodexLive {
        identity: identity_of(raw),
        record_id: js::string(raw.get("recordId"))
            .filter(|id| is_codex_account_id(id) && seen.iter().any(|s| s == id))
            .map(str::to_string),
    });
    CodexAccountsFile { accounts, live: live.filter(|l| l.identity.any()) }
}

/// The saved record of the account in the live auth.json, if any.
pub fn live_record_of<'a>(accounts: &'a [CodexAccount], live: Option<&CodexIdentity>) -> Option<&'a CodexAccount> {
    let live = live?;
    accounts.iter().find(|a| compare_codex_identity(&a.identity, live) == IdentityMatch::Same)
}

/// What `outsideSwitch` decided.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideSwitch {
    pub changed: bool,
    pub outdated: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<CodexLive>,
}

/// What the live auth.json changing to `now` means for the records (called on every poll, never during a swap of the app's
/// own): the record that was main and left without the app is marked `outdated` when its copy was the live login's twin.
pub fn outside_switch(file: &CodexAccountsFile, now: Option<&CodexIdentity>) -> OutsideSwitch {
    let before = file.live.as_ref();
    let record = live_record_of(&file.accounts, now);
    let live = now.filter(|n| n.any()).map(|n| CodexLive { identity: n.clone(), record_id: record.map(|r| r.id.clone()) });
    let same = match (before, now) {
        (Some(b), Some(n)) => compare_codex_identity(&b.identity, n) == IdentityMatch::Same,
        _ => false,
    };
    if same || (before.is_none() && now.is_none()) {
        let changed = before.and_then(|b| b.record_id.as_ref()) != live.as_ref().and_then(|l| l.record_id.as_ref());
        return OutsideSwitch { changed, outdated: Vec::new(), live };
    }
    let leaving = before.and_then(|b| match &b.record_id {
        Some(id) => file.accounts.iter().find(|a| &a.id == id),
        None => live_record_of(&file.accounts, Some(&b.identity)),
    });
    let outdated = leaving.filter(|l| l.live_family).map(|l| vec![l.id.clone()]).unwrap_or_default();
    OutsideSwitch { changed: true, outdated, live }
}

/// Why making a saved Codex account the main one is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexRefusal {
    NoTarget,
    Foreign,
    SameAccount,
}

/// `codexActivationRefusal`: why making `record` main is refused, or `None` (the caller checks it again with the files).
pub fn codex_activation_refusal(record: Option<&CodexAccount>, live: Option<&CodexIdentity>) -> Option<CodexRefusal> {
    let Some(record) = record else { return Some(CodexRefusal::NoTarget) };
    if let Some(live) = live
        && compare_codex_identity(&record.identity, live) == IdentityMatch::Same
    {
        return Some(CodexRefusal::SameAccount);
    }
    record.outdated.then_some(CodexRefusal::Foreign)
}

/// Indexes (char boundaries) where `^` of a JavaScript regular expression with the `m` flag matches.
fn line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(text.char_indices().filter(|(_, c)| js::is_line_terminator(*c)).map(|(i, c)| i + c.len_utf8()))
}

fn skip_space(text: &str, from: usize) -> usize {
    text[from..].char_indices().find(|(_, c)| !js::is_space(*c)).map_or(text.len(), |(i, _)| from + i)
}

/// The `cli_auth_credentials_store` of a config.toml that keeps the login outside auth.json (keyring, or auto on a system
/// with one): the regular expressions of the TS code, top-level keys only (everything before the first `[table]` header).
pub fn codex_stores_in_keyring(config_toml: Option<&str>) -> bool {
    let Some(config) = config_toml.filter(|c| !c.is_empty()) else { return false };
    // config.split(/^\s*\[/m)[0]
    let top_end = line_starts(config).find(|&p| config[skip_space(config, p)..].starts_with('[')).unwrap_or(config.len());
    let top = &config[..top_end];
    // /^\s*cli_auth_credentials_store\s*=\s*["']?([a-z]+)["']?/m
    const KEY: &str = "cli_auth_credentials_store";
    for p in line_starts(top) {
        let k = skip_space(top, p);
        if !top[k..].starts_with(KEY) {
            continue;
        }
        let e = skip_space(top, k + KEY.len());
        if !top[e..].starts_with('=') {
            continue;
        }
        let mut v = skip_space(top, e + 1);
        if top[v..].starts_with(['"', '\'']) && top[v + 1..].starts_with(|c: char| c.is_ascii_lowercase()) {
            v += 1;
        }
        let value: String = top[v..].chars().take_while(char::is_ascii_lowercase).collect();
        if value.is_empty() {
            continue;
        }
        return value == "keyring" || value == "auto";
    }
    false
}

/// The login command of a Codex profile: always into auth.json of that CODEX_HOME, whatever the user's config says.
pub const CODEX_PROFILE_LOGIN: &str = "codex login -c cli_auth_credentials_store=file";

/// Who an auth.json belongs to (`CodexLogin`). Never holds a token.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLogin {
    pub identity: CodexIdentity,
    /// Signed in with ChatGPT (tokens) rather than an API key.
    pub chatgpt: bool,
    /// SHA-256 of the refresh token (never the token), for comparing copies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_hash: Option<String>,
}

/// `decodeJwtClaims`: the claims object of a JWT's payload, or `None`.
pub fn decode_jwt_claims(token: &str) -> Option<Map<String, Value>> {
    let part = token.split('.').nth(1).filter(|p| !p.is_empty())?;
    let bytes = js::base64url_decode(part);
    let text = String::from_utf8_lossy(&bytes);
    match unimux_core::js_json::parse(&text).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// `parseCodexAuth`: who an auth.json belongs to, or `None` when it holds no usable login.
pub fn parse_codex_auth(raw: Option<&str>) -> Option<CodexLogin> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let auth = unimux_core::js_json::parse(raw).ok()?;
    let auth = js::record(Some(&auth))?;
    let tokens = js::record(auth.get("tokens"));
    let access = tokens.and_then(|t| js::string(t.get("access_token"))).filter(|s| !s.is_empty());
    let (Some(tokens), Some(access)) = (tokens, access) else {
        let api_key = js::string(auth.get("OPENAI_API_KEY")).is_some_and(|k| !k.is_empty());
        return api_key.then(CodexLogin::default);
    };
    let id_claims = js::string(tokens.get("id_token")).and_then(decode_jwt_claims);
    let access_claims = decode_jwt_claims(access);
    const AUTH: &str = "https://api.openai.com/auth";
    // idClaims?.[AUTH] ?? accessClaims?.[AUTH]: `??` skips only undefined and null.
    let claim = id_claims
        .as_ref()
        .and_then(|c| c.get(AUTH))
        .filter(|v| !v.is_null())
        .or_else(|| access_claims.as_ref().and_then(|c| c.get(AUTH)).filter(|v| !v.is_null()));
    let empty = Map::new();
    let auth_claim = js::record(claim).unwrap_or(&empty);
    let non_empty = |v: Option<&Value>| js::string(v).filter(|s| !s.is_empty()).map(str::to_string);
    let email = id_claims.as_ref().and_then(|c| non_empty(c.get("email")));
    let user_id = non_empty(auth_claim.get("chatgpt_user_id")).or_else(|| non_empty(auth_claim.get("user_id")));
    let account_id = match non_empty(tokens.get("account_id")) {
        Some(id) => Some(id),
        None => js::string(auth_claim.get("chatgpt_account_id")).filter(|s| !s.is_empty()).map(str::to_string),
    };
    let refresh_hash = js::string(tokens.get("refresh_token")).filter(|s| !s.is_empty()).map(js::sha256_hex);
    Some(CodexLogin { identity: CodexIdentity { email, user_id, account_id }, chatgpt: true, refresh_hash })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    fn ci(v: Value) -> CodexIdentity {
        serde_json::from_value(v).unwrap()
    }

    // test/codex-accounts.test.ts, "Codex identities and the family rule (pure)"
    #[test]
    fn compares_by_user_and_workspace_else_by_e_mail() {
        let c = |a, b| compare_codex_identity(&ci(a), &ci(b));
        assert_eq!(
            c(json!({"userId": "u1", "accountId": "w1", "email": "a@x"}), json!({"userId": "u1", "accountId": "w1"})),
            IdentityMatch::Same
        );
        assert_eq!(
            c(json!({"userId": "u1", "accountId": "w1"}), json!({"userId": "u1", "accountId": "w2"})),
            IdentityMatch::Different
        );
        assert_eq!(c(json!({"email": "A@x"}), json!({"email": "a@x"})), IdentityMatch::Same);
        assert_eq!(c(json!({}), json!({"email": "a@x"})), IdentityMatch::Unknown);
        assert_eq!(c(json!({"accountId": "w1"}), json!({"accountId": "w1"})), IdentityMatch::Same);
        assert_eq!(c(json!({"accountId": "w1"}), json!({"accountId": "w2"})), IdentityMatch::Different);
        assert_eq!(codex_identity_key(&ci(json!({"userId": "u1", "accountId": "w1"}))).as_deref(), Some("codex-user:u1:w1"));
        assert_eq!(codex_identity_key(&ci(json!({"email": "A@x"}))).as_deref(), Some("codex-email:a@x:-"));
    }

    #[test]
    fn reads_accounts_json_safely() {
        let id = "11111111-1111-4111-8111-111111111111";
        let got = normalize_codex_accounts(&json!({
            "accounts": [{"id": id, "addedAt": 1, "email": "a@x", "liveFamily": true}, {"id": id}, {"id": "../x"}],
            "live": {"email": "a@x", "recordId": "22222222-2222-4222-8222-222222222222"}
        }));
        assert_eq!(
            got.to_value(),
            json!({"version": 1, "accounts": [{"id": id, "addedAt": 1, "email": "a@x", "liveFamily": true}], "live": {"email": "a@x"}})
        );
    }

    #[test]
    fn marks_the_twin_of_an_account_switched_out_by_something_else_as_outdated_never_an_independent_copy() {
        let twin = CodexAccount {
            id: "r1".into(),
            added_at: 1.0,
            identity: ci(json!({"userId": "u1"})),
            live_family: true,
            outdated: false,
        };
        let own = CodexAccount { id: "r2".into(), added_at: 1.0, identity: ci(json!({"userId": "u2"})), ..Default::default() };
        let live = |u: &str, r: &str| CodexLive { identity: ci(json!({"userId": u})), record_id: Some(r.into()) };
        let file = CodexAccountsFile { accounts: vec![twin, own], live: Some(live("u1", "r1")) };
        assert_eq!(
            outside_switch(&file, Some(&ci(json!({"userId": "u3"})))),
            OutsideSwitch {
                changed: true,
                outdated: vec!["r1".into()],
                live: Some(CodexLive { identity: ci(json!({"userId": "u3"})), record_id: None })
            }
        );
        let other = CodexAccountsFile { live: Some(live("u2", "r2")), ..file.clone() };
        assert_eq!(
            outside_switch(&other, Some(&ci(json!({"userId": "u1"})))),
            OutsideSwitch { changed: true, outdated: vec![], live: Some(live("u1", "r1")) }
        );
        assert!(!outside_switch(&file, Some(&ci(json!({"userId": "u1"})))).changed);
    }

    #[test]
    fn refuses_the_live_account_an_outdated_copy_and_a_missing_record_detects_the_keyring_store() {
        let rec =
            |v: Value, outdated| CodexAccount { id: "r".into(), added_at: 0.0, identity: ci(v), live_family: false, outdated };
        assert_eq!(codex_activation_refusal(None, None), Some(CodexRefusal::NoTarget));
        assert_eq!(
            codex_activation_refusal(Some(&rec(json!({"userId": "u1"}), false)), Some(&ci(json!({"userId": "u1"})))),
            Some(CodexRefusal::SameAccount)
        );
        assert_eq!(
            codex_activation_refusal(Some(&rec(json!({"userId": "u1"}), true)), Some(&ci(json!({"userId": "u2"})))),
            Some(CodexRefusal::Foreign)
        );
        assert_eq!(
            codex_activation_refusal(Some(&rec(json!({"userId": "u1"}), false)), Some(&ci(json!({"userId": "u2"})))),
            None
        );
        assert!(codex_stores_in_keyring(Some("model = \"o3\"\ncli_auth_credentials_store = \"keyring\"\n")));
        assert!(codex_stores_in_keyring(Some("cli_auth_credentials_store = \"auto\"")));
        assert!(!codex_stores_in_keyring(Some("cli_auth_credentials_store = \"file\"")));
        assert!(!codex_stores_in_keyring(Some("[mcp_servers.x]\ncli_auth_credentials_store = \"keyring\"")));
        assert!(!codex_stores_in_keyring(None));
        // Edge cases of the two regular expressions (expected values from the JS engine).
        assert!(codex_stores_in_keyring(Some("cli_auth_credentials_store\n=\n'keyring'")));
        assert!(!codex_stores_in_keyring(Some("cli_auth_credentials_store = \"keyrings\"")));
        assert!(!codex_stores_in_keyring(Some("x = 1\n  [t]\ncli_auth_credentials_store = \"auto\"")));
        assert!(codex_stores_in_keyring(Some("x = 1\rcli_auth_credentials_store=keyring")));
        assert!(!codex_stores_in_keyring(Some("# cli_auth_credentials_store = \"keyring\"")));
    }

    fn b64(v: Value) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let bytes = v.to_string().into_bytes();
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
            for i in 0..=chunk.len() {
                out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out
    }

    pub(crate) fn auth(name: &str) -> String {
        let claim = json!({"chatgpt_user_id": format!("user-{name}"), "chatgpt_account_id": format!("ws-{name}"), "chatgpt_plan_type": "plus"});
        let jwt = |mut claims: Value| {
            claims["https://api.openai.com/auth"] = claim.clone();
            format!("h.{}.s", b64(claims))
        };
        json!({
            "auth_mode": "chatgpt", "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": jwt(json!({"email": format!("{name}@example.com")})),
                "access_token": jwt(json!({"exp": 4_102_444_800u64})),
                "refresh_token": format!("fake-refresh-{name}"),
                "account_id": format!("ws-{name}")
            },
            "last_refresh": "2026-11-06T00:00:00.000Z"
        })
        .to_string()
    }

    #[test]
    fn reads_who_an_auth_json_belongs_to_without_returning_a_token() {
        let login = parse_codex_auth(Some(&auth("alice"))).unwrap();
        assert!(login.chatgpt);
        assert_eq!(login.identity, ci(json!({"email": "alice@example.com", "userId": "user-alice", "accountId": "ws-alice"})));
        assert_eq!(login.refresh_hash.as_deref(), Some(js::sha256_hex("fake-refresh-alice").as_str()));
        assert!(!serde_json::to_string(&login).unwrap().contains("fake-refresh"));
        assert_eq!(parse_codex_auth(Some(r#"{"OPENAI_API_KEY":"sk-fake"}"#)), Some(CodexLogin::default()));
        assert_eq!(parse_codex_auth(Some("{")), None);
        assert_eq!(parse_codex_auth(None), None);
        assert_eq!(parse_codex_auth(Some(r#"{"tokens":{"access_token":""}}"#)), None);
    }
}
