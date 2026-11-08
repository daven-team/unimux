//! `SftpErrorCode` and `SftpResult<T>` of src/shared/sftp.ts: the fixed codes every SFTP answer uses (`{ok: true, value}` or
//! `{ok: false, error}`).

use serde_json::{Value, json};

macro_rules! sftp_codes {
    ($($variant:ident => $name:literal,)*) => {
        /// `SftpErrorCode`.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum SftpErrorCode { $($variant,)* }

        impl SftpErrorCode {
            pub const ALL: &'static [SftpErrorCode] = &[$(SftpErrorCode::$variant,)*];

            pub fn as_str(self) -> &'static str {
                match self { $(SftpErrorCode::$variant => $name,)* }
            }

            pub fn parse(s: &str) -> Option<SftpErrorCode> {
                match s { $($name => Some(SftpErrorCode::$variant),)* _ => None }
            }
        }
    };
}

sftp_codes! {
    NotFound => "notFound",
    Exists => "exists",
    Permission => "permission",
    NotEmpty => "notEmpty",
    NotADirectory => "notADirectory",
    IsADirectory => "isADirectory",
    NoSpace => "noSpace",
    Invalid => "invalid",
    NoSession => "noSession",
    NotConnected => "notConnected",
    Changed => "changed",
    Cancelled => "cancelled",
    ConnectionLost => "connectionLost",
    SftpHostCrashed => "sftpHostCrashed",
    Unsupported => "unsupported",
    TooMany => "tooMany",
    InvalidName => "invalidName",
    LinkOutside => "linkOutside",
    LinkFolder => "linkFolder",
    Failed => "failed",
    IntoItself => "intoItself",
    CrossDevice => "crossDevice",
    LinkSkipped => "linkSkipped",
    UnsafeChmod => "unsafeChmod",
    PartDenied => "partDenied",
}

impl std::fmt::Display for SftpErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `SftpResult<unknown>`.
pub type SftpResult = Result<Value, SftpErrorCode>;

/// The wire shape of a result.
pub fn result_json(r: &SftpResult) -> Value {
    match r {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(code) => json!({ "ok": false, "error": code.as_str() }),
    }
}

/// `{ ok: false, error: 'invalid' }`.
pub fn invalid() -> Value {
    result_json(&Err(SftpErrorCode::Invalid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip_and_results_have_the_ts_shape() {
        for c in SftpErrorCode::ALL {
            assert_eq!(SftpErrorCode::parse(c.as_str()), Some(*c));
        }
        assert_eq!(result_json(&Ok(json!(true))).to_string(), r#"{"ok":true,"value":true}"#);
        assert_eq!(invalid().to_string(), r#"{"ok":false,"error":"invalid"}"#);
    }
}
