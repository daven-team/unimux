//! The answers of "make main", its recovery and the account guards, in the JSON shapes of src/shared/accounts.ts
//! (`SwapError`, `SwapResult`, `SwapRecovery`, `AdoptCopyResult`). They never hold a path, a token or a system message.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `SWAP_ERRORS`: why a swap or "make main" did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SwapError {
    Unsupported,
    Invalid,
    Busy,
    EnvToken,
    NoMain,
    NoTarget,
    SameAccount,
    Duplicate,
    Dead,
    Transient,
    Write,
    Manual,
    Pending,
    Locked,
    Foreign,
}

impl SwapError {
    pub const ALL: [SwapError; 15] = [
        SwapError::Unsupported,
        SwapError::Invalid,
        SwapError::Busy,
        SwapError::EnvToken,
        SwapError::NoMain,
        SwapError::NoTarget,
        SwapError::SameAccount,
        SwapError::Duplicate,
        SwapError::Dead,
        SwapError::Transient,
        SwapError::Write,
        SwapError::Manual,
        SwapError::Pending,
        SwapError::Locked,
        SwapError::Foreign,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SwapError::Unsupported => "unsupported",
            SwapError::Invalid => "invalid",
            SwapError::Busy => "busy",
            SwapError::EnvToken => "envToken",
            SwapError::NoMain => "noMain",
            SwapError::NoTarget => "noTarget",
            SwapError::SameAccount => "sameAccount",
            SwapError::Duplicate => "duplicate",
            SwapError::Dead => "dead",
            SwapError::Transient => "transient",
            SwapError::Write => "write",
            SwapError::Manual => "manual",
            SwapError::Pending => "pending",
            SwapError::Locked => "locked",
            SwapError::Foreign => "foreign",
        }
    }
}

/// `SwapResult`: `{ ok: true, email? }` or `{ ok: false, error, email? }` (keys in that order).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapResult {
    pub ok: bool,
    pub error: Option<SwapError>,
    pub email: Option<String>,
}

impl SwapResult {
    pub fn ok(email: Option<String>) -> Self {
        Self { ok: true, error: None, email }
    }

    pub fn fail(error: SwapError) -> Self {
        Self { ok: false, error: Some(error), email: None }
    }

    pub fn fail_named(error: SwapError, email: Option<String>) -> Self {
        Self { ok: false, error: Some(error), email }
    }

    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("ok".into(), Value::Bool(self.ok));
        if let Some(e) = self.error {
            m.insert("error".into(), Value::String(e.as_str().into()));
        }
        if let Some(email) = &self.email {
            m.insert("email".into(), Value::String(email.clone()));
        }
        Value::Object(m)
    }
}

impl Serialize for SwapResult {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(s)
    }
}

/// `SwapRecovery` plus the two answers of the version-2 recovery (`ActivationRecovery`): `legacy` (no version-2 journal,
/// the 0.9.0 recovery decides) and `locked` (Claude Code's locks were busy, retried later).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Recovery {
    None,
    Recovered,
    Manual,
    Legacy,
    Locked,
}

impl Recovery {
    pub fn as_str(self) -> &'static str {
        match self {
            Recovery::None => "none",
            Recovery::Recovered => "recovered",
            Recovery::Manual => "manual",
            Recovery::Legacy => "legacy",
            Recovery::Locked => "locked",
        }
    }
}

/// `AdoptCopyError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdoptCopyError {
    Invalid,
    Live,
    ReadOnly,
    Busy,
    Pending,
    Write,
}

/// `AdoptCopyResult`: `{ ok: true }` or `{ ok: false, error }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdoptCopyResult {
    pub error: Option<AdoptCopyError>,
}

impl AdoptCopyResult {
    pub const OK: AdoptCopyResult = AdoptCopyResult { error: None };

    pub fn fail(error: AdoptCopyError) -> Self {
        Self { error: Some(error) }
    }

    pub fn to_value(&self) -> Value {
        match self.error {
            None => serde_json::json!({ "ok": true }),
            Some(e) => serde_json::json!({ "ok": false, "error": e }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_match_the_ts_objects() {
        let named = SwapResult::fail_named(SwapError::Foreign, Some("x@x.com".into()));
        assert_eq!(serde_json::to_string(&named).unwrap(), r#"{"ok":false,"error":"foreign","email":"x@x.com"}"#);
        assert_eq!(serde_json::to_string(&SwapResult::ok(None)).unwrap(), r#"{"ok":true}"#);
        for e in SwapError::ALL {
            assert_eq!(serde_json::to_value(e).unwrap(), Value::String(e.as_str().into()));
        }
        assert_eq!(AdoptCopyResult::fail(AdoptCopyError::ReadOnly).to_value().to_string(), r#"{"ok":false,"error":"readOnly"}"#);
        assert_eq!(serde_json::to_value(Recovery::Recovered).unwrap(), "recovered");
    }
}
