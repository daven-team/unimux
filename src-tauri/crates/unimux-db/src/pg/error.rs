//! Connect errors of a Postgres session and their fixed codes (`mapConnectError` / `connectMessage` in src/dbhost/host.ts).

use std::io;

use crate::wire::pg::{PgServerError, PgWireError};
use crate::wire::value::{server_text, utf16_head};

/// Why a connect attempt (stream, TLS, startup, the first statements) failed.
#[derive(Debug)]
pub enum ConnectError {
    /// The server asks for a password and none is known (1.1.4: `NeedPassword`, mapped to `dbAuth` without a message).
    NeedPassword,
    /// The server's ErrorResponse (startup: wrong password, missing database, no pg_hba entry, too many connections).
    Server(PgServerError),
    /// SSLRequest answered with `N` (node-postgres: "The server does not support SSL connections").
    TlsUnsupported,
    /// The TCP connect was refused.
    Refused(String),
    /// The host name could not be resolved.
    Dns(String),
    /// The connect attempt took longer than its limit.
    Timeout,
    /// The TLS handshake or the certificate check failed (the reason is shown to the user).
    Tls(String),
    /// The connection ended or was reset before the startup finished.
    Closed(String),
    /// The SSH tunnel could not give a stream (1.1.4: `ETUNNEL`).
    Tunnel(String),
    /// Anything else (a protocol violation, an unsupported login method).
    Failed(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::NeedPassword => write!(f, "password needed"),
            ConnectError::Server(e) => write!(f, "server {}: {}", e.code(), e.message()),
            ConnectError::TlsUnsupported => write!(f, "The server does not support SSL connections"),
            ConnectError::Refused(m)
            | ConnectError::Dns(m)
            | ConnectError::Closed(m)
            | ConnectError::Tunnel(m)
            | ConnectError::Failed(m) => {
                write!(f, "{m}")
            }
            ConnectError::Tls(m) => write!(f, "TLS: {m}"),
            ConnectError::Timeout => write!(f, "timeout expired"),
        }
    }
}

impl std::error::Error for ConnectError {}

/// node-postgres' `/^[0-9A-Z]{5}$/` check of `serverError`: only such errors are the server's.
pub fn is_server_code(code: &str) -> bool {
    code.len() == 5 && code.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
}

impl ConnectError {
    /// An I/O error of the stream, classified like the Node error codes `mapConnectError` looks at.
    pub fn from_io(e: &io::Error) -> Self {
        match e.kind() {
            io::ErrorKind::ConnectionRefused => ConnectError::Refused(e.to_string()),
            io::ErrorKind::TimedOut => ConnectError::Timeout,
            io::ErrorKind::UnexpectedEof => ConnectError::Closed("Connection terminated unexpectedly".into()),
            io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::NotConnected => ConnectError::Closed(e.to_string()),
            _ => ConnectError::Failed(e.to_string()),
        }
    }

    /// A wire error during the startup or the first statements.
    pub fn from_wire(e: PgWireError) -> Self {
        match e {
            PgWireError::Io(e) => ConnectError::from_io(&e),
            PgWireError::Server(e) => ConnectError::Server(e),
            PgWireError::NeedPassword => ConnectError::NeedPassword,
            PgWireError::Protocol(m) => ConnectError::Failed(m),
        }
    }

    /// The server error, when it is one by `serverError`'s rule.
    pub fn server(&self) -> Option<&PgServerError> {
        match self {
            ConnectError::Server(e) if is_server_code(e.code()) => Some(e),
            _ => None,
        }
    }

    /// `mapConnectError(error, viaTunnel)`: the fixed code the UI shows.
    pub fn code(&self, via_tunnel: bool) -> &'static str {
        if let Some(server) = self.server() {
            return match server.code() {
                "28P01" | "28000" => "dbAuth",
                "3D000" => "dbNoDatabase",
                _ => "dbFailed",
            };
        }
        match self {
            ConnectError::NeedPassword => "dbAuth",
            ConnectError::Tunnel(_) => "tunnel",
            ConnectError::TlsUnsupported => "dbTlsUnsupported",
            ConnectError::Refused(_) => {
                if via_tunnel {
                    "tunnel"
                } else {
                    "dbRefused"
                }
            }
            ConnectError::Dns(_) => "dbDns",
            ConnectError::Timeout => "dbTimeout",
            ConnectError::Tls(_) => "dbTls",
            ConnectError::Closed(_) => {
                if via_tunnel {
                    "tunnel"
                } else {
                    "dbClosed"
                }
            }
            // a server error with a code that is not the server's form
            ConnectError::Server(_) | ConnectError::Failed(_) => "dbFailed",
        }
    }

    /// `connectMessage`: the server's own text (cut to DB_LIMITS.serverText), or the TLS library's reason (500 units).
    /// A cut that splits a surrogate pair drops the lone half (the status message is not a DB port text).
    pub fn message(&self) -> Option<String> {
        if let Some(server) = self.server() {
            return Some(server_text(server.message()).text);
        }
        match self {
            ConnectError::Tls(m) => Some(utf16_head(&format!("TLS: {m}"), 500).text),
            _ => None,
        }
    }

    /// The server refused the password (`28P01`): with a password that was tried, the user is asked again.
    pub fn wrong_password(&self) -> bool {
        self.server().is_some_and(|e| e.code() == "28P01")
    }
}

/// A failed open: the session's error code and the message shown with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenError {
    pub code: &'static str,
    pub message: Option<String>,
}

impl OpenError {
    pub fn new(code: &'static str) -> Self {
        OpenError { code, message: None }
    }

    pub fn from_connect(e: &ConnectError, via_tunnel: bool) -> Self {
        OpenError { code: e.code(via_tunnel), message: e.message() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(code: &str, message: &str) -> ConnectError {
        ConnectError::Server(PgServerError { fields: vec![(b'C', code.into()), (b'M', message.into())] })
    }

    #[test]
    fn codes_follow_map_connect_error() {
        assert_eq!(server("28P01", "x").code(false), "dbAuth");
        assert_eq!(server("28000", "x").code(false), "dbAuth");
        assert_eq!(server("3D000", "x").code(false), "dbNoDatabase");
        assert_eq!(server("53300", "x").code(true), "dbFailed");
        assert_eq!(server("bad", "x").code(false), "dbFailed");
        assert_eq!(ConnectError::NeedPassword.code(false), "dbAuth");
        assert_eq!(ConnectError::TlsUnsupported.code(true), "dbTlsUnsupported");
        assert_eq!(ConnectError::Refused("x".into()).code(false), "dbRefused");
        assert_eq!(ConnectError::Refused("x".into()).code(true), "tunnel");
        assert_eq!(ConnectError::Closed("x".into()).code(false), "dbClosed");
        assert_eq!(ConnectError::Closed("x".into()).code(true), "tunnel");
        assert_eq!(ConnectError::Dns("x".into()).code(false), "dbDns");
        assert_eq!(ConnectError::Timeout.code(false), "dbTimeout");
        assert_eq!(ConnectError::Tls("bad cert".into()).code(false), "dbTls");
        assert_eq!(ConnectError::Tunnel("x".into()).code(false), "tunnel");
        assert_eq!(ConnectError::Failed("x".into()).code(false), "dbFailed");
    }

    #[test]
    fn messages_are_the_server_text_or_the_tls_reason() {
        assert_eq!(
            server("28P01", "password authentication failed").message().as_deref(),
            Some("password authentication failed")
        );
        assert_eq!(ConnectError::Tls("unknown issuer".into()).message().as_deref(), Some("TLS: unknown issuer"));
        assert_eq!(ConnectError::Timeout.message(), None);
        assert_eq!(ConnectError::NeedPassword.message(), None);
        let long = "x".repeat(5000);
        assert_eq!(server("XX000", &long).message().unwrap().len(), 4000);
        assert!(server("28P01", "x").wrong_password());
        assert!(!server("28000", "x").wrong_password());
    }
}
