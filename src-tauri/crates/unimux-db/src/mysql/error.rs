//! Errors of the MySQL client and the 1.1.4 mappings on top of them: `mapMysqlConnectError` and `mysqlConnectMessage`
//! (src/dbhost/host.ts) for a login, `mysqlServerError` and `errnoOf` (src/dbhost/mysqlSession.ts) for a statement.

use std::fmt;
use std::io;

use unimux_core::js_json::write_string;

use crate::sql::mysql::mysql_error_text;
use crate::wire::value::{Head, server_text, utf16_head, write_head};

pub use crate::wire::mysql::MyServerError;

/// ER_ACCESS_DENIED_ERROR: the wrong password (the only login error that asks for a password again).
pub const ER_ACCESS_DENIED: u16 = 1045;

/// What went wrong. `Server` is the server's ERR packet (a statement error leaves the connection usable); everything
/// else is fatal for the connection except `Encoding` and `Busy`, which are refused before anything is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MyError {
    /// A network error (mysql2: an Error with a Node `code`, fatal).
    Io { kind: io::ErrorKind, message: String },
    /// The server closed the connection (PROTOCOL_CONNECTION_LOST).
    Closed,
    /// The server's ERR packet.
    Server(MyServerError),
    /// TLS asked for, the server has none (HANDSHAKE_NO_SSL_SUPPORT).
    TlsUnsupported,
    /// The TLS handshake or the certificate check failed (HANDSHAKE_SSL_ERROR); the TLS library's reason.
    Tls(String),
    /// The login cannot go on on the client side (AUTH_SWITCH_PLUGIN_ERROR, the clear password plugin, an unknown plugin).
    Auth(String),
    /// The server answered something the protocol does not allow (HANDSHAKE_UNKNOWN_ERROR, a malformed packet).
    Protocol(String),
    /// The query text cannot be written in the session charset (iconv-lite's error); nothing was sent.
    Encoding(String),
    /// LOAD DATA LOCAL INFILE refused like mysql2 without `infileStreamFactory` (an Error without errno); the
    /// connection stays usable.
    Client(String),
    /// A command while another one has not been read to its end (a caller bug); nothing was sent.
    Busy,
    /// The connect timeout ran out (mysql2 `connectTimeout`: "connect ETIMEDOUT").
    Timeout,
    /// The host name could not be resolved (ENOTFOUND / EAI_AGAIN).
    Dns(String),
    /// The SSH tunnel could not give a stream (ETUNNEL).
    Tunnel(String),
}

impl From<io::Error> for MyError {
    fn from(e: io::Error) -> Self {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            return MyError::Closed;
        }
        MyError::Io { kind: e.kind(), message: e.to_string() }
    }
}

impl fmt::Display for MyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MyError::Io { message, .. } => write!(f, "{message}"),
            MyError::Closed => write!(f, "Connection lost: The server closed the connection."),
            MyError::Server(e) => write!(f, "{}", e.message),
            MyError::TlsUnsupported => write!(f, "Server does not support secure connection"),
            MyError::Tls(m) | MyError::Auth(m) | MyError::Protocol(m) | MyError::Encoding(m) | MyError::Client(m) => {
                write!(f, "{m}")
            }
            MyError::Busy => write!(f, "another command is still running on this connection"),
            MyError::Timeout => write!(f, "connect ETIMEDOUT"),
            MyError::Dns(m) => write!(f, "getaddrinfo ENOTFOUND {m}"),
            MyError::Tunnel(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for MyError {}

impl MyError {
    /// `errnoOf`: the server's error number of a non-fatal error.
    pub fn errno(&self) -> Option<u16> {
        match self {
            MyError::Server(e) => Some(e.code),
            _ => None,
        }
    }

    /// The connection cannot be used any more.
    pub fn is_fatal(&self) -> bool {
        !matches!(self, MyError::Server(_) | MyError::Encoding(_) | MyError::Client(_) | MyError::Busy)
    }
}

/// `mapMysqlConnectError`: a login error as the fixed code the UI shows.
pub fn map_connect_error(e: &MyError, via_tunnel: bool) -> &'static str {
    let lost = if via_tunnel { "tunnel" } else { "dbClosed" };
    match e {
        // 1045 wrong password; 1044 no access to the database; 1698 (auth_socket and the like) and 1130 (host not
        // allowed) refuse the login.
        MyError::Server(s) => match s.code {
            1045 | 1044 | 1698 => "dbAuth",
            1049 => "dbNoDatabase",
            1130 => "dbRefused",
            _ => "dbFailed",
        },
        MyError::Tunnel(_) => "tunnel",
        MyError::TlsUnsupported => "dbTlsUnsupported",
        MyError::Tls(_) => "dbTls",
        MyError::Io { kind, .. } => match kind {
            io::ErrorKind::ConnectionRefused => {
                if via_tunnel {
                    "tunnel"
                } else {
                    "dbRefused"
                }
            }
            io::ErrorKind::TimedOut => "dbTimeout",
            io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted | io::ErrorKind::BrokenPipe => lost,
            _ => "dbFailed",
        },
        MyError::Closed => lost,
        MyError::Dns(_) => "dbDns",
        MyError::Timeout => "dbTimeout",
        MyError::Auth(_) | MyError::Protocol(_) | MyError::Encoding(_) | MyError::Client(_) | MyError::Busy => "dbFailed",
    }
}

/// `mysqlConnectMessage`: the detail of a login error: the server's own text, or the TLS library's reason (500 units).
pub fn connect_message(e: &MyError) -> Option<Head> {
    if let Some(s) = server_error(e) {
        return Some(s.message);
    }
    match e {
        MyError::Tls(m) => Some(utf16_head(m, 500)),
        _ => None,
    }
}

/// The server error the port carries (`DbServerError` of src/shared/db.ts as mysqlSession fills it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbServerError {
    /// "ERROR 1146 (42S02): ..." cut to DB_LIMITS.serverText UTF-16 units.
    pub message: Head,
    /// The SQLSTATE when it looks like one.
    pub code: Option<String>,
    pub severity: &'static str,
    /// Set by the session for a syntax error's place ("near '...' at line N"), 1-based.
    pub position: Option<usize>,
}

impl DbServerError {
    /// `JSON.stringify` of the object (keys in the order mysqlSession creates them).
    pub fn write_json(&self, out: &mut String) {
        out.push_str("{\"message\":");
        write_head(out, &self.message);
        if let Some(code) = &self.code {
            out.push_str(",\"code\":");
            write_string(out, code);
        }
        out.push_str(",\"severity\":");
        write_string(out, self.severity);
        if let Some(p) = self.position {
            out.push_str(&format!(",\"position\":{p}"));
        }
        out.push('}');
    }

    pub fn to_json(&self) -> String {
        let mut s = String::new();
        self.write_json(&mut s);
        s
    }
}

fn is_sql_state(s: &str) -> bool {
    s.len() == 5 && s.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
}

/// `mysqlServerError`: the server's error (capped); None for errors that are not the server's.
pub fn server_error(e: &MyError) -> Option<DbServerError> {
    let MyError::Server(s) = e else { return None };
    let state = Some(s.state.as_str()).filter(|st| is_sql_state(st));
    Some(DbServerError {
        message: server_text(&mysql_error_text(Some(f64::from(s.code)), state, &s.message)),
        code: state.map(str::to_owned),
        severity: "ERROR",
        position: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(code: u16, state: &str, message: &str) -> MyError {
        MyError::Server(MyServerError { code, state: state.into(), message: message.into() })
    }

    #[test]
    fn connect_errors_like_1_1_4() {
        assert_eq!(map_connect_error(&server(1045, "28000", "Access denied"), false), "dbAuth");
        assert_eq!(map_connect_error(&server(1049, "42000", "Unknown database 'x'"), false), "dbNoDatabase");
        assert_eq!(map_connect_error(&server(1130, "HY000", "Host not allowed"), false), "dbRefused");
        assert_eq!(map_connect_error(&server(1040, "08004", "Too many connections"), false), "dbFailed");
        let refused = MyError::from(io::Error::from(io::ErrorKind::ConnectionRefused));
        assert_eq!(map_connect_error(&refused, false), "dbRefused");
        assert_eq!(map_connect_error(&refused, true), "tunnel");
        assert_eq!(map_connect_error(&MyError::TlsUnsupported, false), "dbTlsUnsupported");
        assert_eq!(map_connect_error(&MyError::Tls("bad cert".into()), false), "dbTls");
        assert_eq!(map_connect_error(&MyError::Closed, false), "dbClosed");
        assert_eq!(map_connect_error(&MyError::Closed, true), "tunnel");
        assert_eq!(map_connect_error(&MyError::Timeout, false), "dbTimeout");
        assert_eq!(map_connect_error(&MyError::Dns("x".into()), false), "dbDns");
        assert_eq!(map_connect_error(&MyError::Auth("plugin".into()), false), "dbFailed");
    }

    #[test]
    fn server_errors_like_mysql_server_error() {
        let e = server_error(&server(1049, "42000", "Unknown database 'missing'")).unwrap();
        assert_eq!(
            e.to_json(),
            r#"{"message":"ERROR 1049 (42000): Unknown database 'missing'","code":"42000","severity":"ERROR"}"#
        );
        // a state that is not a SQLSTATE is left out (also from the text)
        let e = server_error(&server(1, "#bad", "x")).unwrap();
        assert_eq!(e.to_json(), r#"{"message":"ERROR 1: x","severity":"ERROR"}"#);
        assert!(server_error(&MyError::Closed).is_none());
        assert_eq!(connect_message(&MyError::Tls("x".repeat(600))).unwrap().text.len(), 500);
        assert_eq!(connect_message(&MyError::Closed), None);
    }
}
