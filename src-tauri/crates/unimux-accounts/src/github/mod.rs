//! GitHub sign-in of "Publish to GitHub" (A6): port of src/main/github/{tokenStore,auth,api,gitEnv}.ts and the pure parts of
//! src/shared/github.ts that main uses.
//!
//! - [`token_store`]: `github/token.json` (a safeStorage blob through B2's [`unimux_oscrypt::SafeCipher`], never in clear on
//!   the disk; in memory only without safeStorage; a newer or unreadable file is left alone).
//! - [`auth`]: where the token comes from (the stored one, then `gh auth token`), the status with its 10 minute login cache,
//!   the check of the stored token after a refused fetch / pull / push, and the OAuth device flow.
//! - [`api`]: GitHub's REST calls and the device flow requests over http_fetch (B3), with 1.1.4's error mapping.
//! - [`git_env`]: the environment that gives git the token as an `https://github.com/` header, and the refusal regexes.
//! - [`gh`]: running `gh` without a shell (PATH lookup like Node's libuv, no console window, 8 s, 64 KiB).
//!
//! - [`publish`] (G3): `github:publish` (createPublisher): checks the repository, creates it on GitHub and pushes the branch
//!   with the token in git's environment only.

pub mod api;
pub mod auth;
pub mod gh;
pub mod git_env;
pub mod publish;
pub mod service;
pub mod token_store;

use serde_json::{Map, Value};

use crate::js;

/// The client id of unimux's GitHub OAuth App (src/shared/github.ts GITHUB_OAUTH_CLIENT_ID). Empty in 1.1.4: the device flow is
/// hidden and the dialog asks for `gh auth login` instead.
pub const GITHUB_OAUTH_CLIENT_ID: &str = "";
/// The scope the device flow asks for (GITHUB_DEVICE_SCOPE): "repo" only.
pub const GITHUB_DEVICE_SCOPE: &str = "repo";
pub const GITHUB_DEVICE_PAGE: &str = "https://github.com/login/device";

/// A failed GitHub step (`{ ok: false, code, error, detail?, url? }` of GithubResult). `error` is a message key (the Polish
/// source text the renderer translates) or git's own text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhFail {
    pub code: &'static str,
    pub error: String,
    pub detail: Option<String>,
    pub url: Option<String>,
}

impl GhFail {
    pub fn new(code: &'static str, error: &str) -> Self {
        Self { code, error: error.to_string(), detail: None, url: None }
    }

    pub fn with_detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail;
        self
    }

    /// The JSON the renderer gets, keys in 1.1.4's order.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ok".into(), Value::Bool(false));
        m.insert("code".into(), Value::String(self.code.into()));
        m.insert("error".into(), Value::String(self.error.clone()));
        if let Some(d) = &self.detail {
            m.insert("detail".into(), Value::String(d.clone()));
        }
        if let Some(u) = &self.url {
            m.insert("url".into(), Value::String(u.clone()));
        }
        Value::Object(m)
    }
}

/// `GithubResult<T>`.
pub type GhResult<T> = Result<T, GhFail>;

/// `{ ok: true, data }` or the failure.
pub fn result_json(result: &GhResult<Value>) -> Value {
    match result {
        Ok(data) => {
            let mut m = Map::new();
            m.insert("ok".into(), Value::Bool(true));
            m.insert("data".into(), data.clone());
            Value::Object(m)
        }
        Err(fail) => fail.to_json(),
    }
}

/// `isTokenText`: printable ASCII without spaces, 10 to 1024 characters (it goes into an HTTP header).
pub fn is_token_text(value: &str) -> bool {
    (10..=1024).contains(&value.len()) && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// `isFlowId`: a device-flow id main handed out (`/^[0-9a-f-]{36}$/i`).
pub fn is_flow_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
}

/// `isGithubPage`: https, host github.com, no credentials and no explicit port (WHATWG URL, so `:443` counts as none).
pub fn is_github_page(value: &str) -> bool {
    if js::len16(value) > 300 {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else { return false };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// test/github-publish.test.ts "opens GitHub's own pages only".
    #[test]
    fn github_pages_only() {
        assert!(is_github_page("https://github.com/login/device"));
        assert!(is_github_page("https://github.com/a/b"));
        assert!(is_github_page("https://GitHub.com:443/a"));
        for bad in [
            "http://github.com/login/device",
            "https://github.com.evil.io/x",
            "https://evil.io/github.com",
            "https://user@github.com/x",
            "https://:p@github.com/x",
            "https://github.com:444/x",
            "javascript:alert(1)",
            "",
        ] {
            assert!(!is_github_page(bad), "{bad}");
        }
        assert!(!is_github_page(&format!("https://github.com/{}", "a".repeat(290))));
    }

    #[test]
    fn token_text_and_flow_ids() {
        assert!(is_token_text("gho_16C7e42F292c6912E7710c838347Ae178B4a"));
        for bad in ["short", "has space in it", "line\nbreak-token", "ąąąąąąąąąąąą"] {
            assert!(!is_token_text(bad), "{bad}");
        }
        assert!(is_token_text(&"x".repeat(1024)));
        assert!(!is_token_text(&"x".repeat(1025)));
        assert!(is_flow_id(&json!("00000000-0000-4000-8000-000000000000")));
        assert!(is_flow_id(&json!("ABCDEF00-0000-4000-8000-000000000000")));
        assert!(!is_flow_id(&json!("not-a-flow")));
        assert!(!is_flow_id(&json!(5)));
        assert!(!is_flow_id(&json!("g0000000-0000-4000-8000-000000000000")));
    }

    #[test]
    fn result_json_key_order() {
        let fail = GhFail { code: "push-failed", error: "e".into(), detail: Some("d".into()), url: Some("u".into()) };
        assert_eq!(
            serde_json::to_string(&fail.to_json()).unwrap(),
            r#"{"ok":false,"code":"push-failed","error":"e","detail":"d","url":"u"}"#
        );
        assert_eq!(
            serde_json::to_string(&result_json(&Ok(json!({"login": null})))).unwrap(),
            r#"{"ok":true,"data":{"login":null}}"#
        );
    }
}
