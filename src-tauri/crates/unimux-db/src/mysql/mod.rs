//! D7: the MySQL / MariaDB client core over any `AsyncRead + AsyncWrite` stream (TCP, or an SSH channel from D2), built
//! on the SP9 findings (docs/tauri/spikes/SP9.md) and replacing mysql2 3.24 as 1.1.4 used it (`typeCast: false`, every
//! value as the server's text, bytes kept for binary columns).
//!
//! - [`conn`]: login (mysql2's client flags, SSL request + TLS upgrade, native / caching_sha2 with RSA / sha256 /
//!   ed25519, auth switch, multi-factor next factor), COM_QUERY with the query-attribute prefix in the session charset,
//!   results as pulled events (fields, rows, set ends, OK packets, errors) across multi-results, status flags, the idle
//!   close watch and COM_QUIT.
//! - [`stream`]: mysqlSession's `MyStream` (first result set's rows taken in batches, more, drain with a deadline) with
//!   back-pressure from pulling.
//! - [`open`]: `openMysqlOnce` / `openMysqlTls` (connect timeout, prefer fallback) and the direct TCP connection.
//! - [`tls`]: rustls configurations for prefer / require (no check) and verify-full (CA file, host name incl. IP).
//! - [`error`]: the client's errors, `mapMysqlConnectError`, `mysqlConnectMessage`, `mysqlServerError`.
//! - [`packet`]: framing and raw rows.
//!
//! The session on top (KILL QUERY side connection, the open result, CALL sets, SHOW WARNINGS, USE, timeouts, metadata,
//! edits) is D8; the column parser, the charset tables and the LOAD DATA LOCAL answer are shared with the SP9 code in
//! [`crate::wire`].

pub mod conn;
pub mod error;
pub mod open;
pub mod packet;
pub mod stream;
pub mod tls;

pub use crate::wire::mysql::{MyColumn, MyResult};
pub use conn::{MyConn, MyEvent, MyExec, MyLogin, MyOk};
pub use error::{DbServerError, MyError, MyServerError, connect_message, map_connect_error, server_error};
pub use open::{MyOpenParams, MyTlsMode, connect_tcp, open, open_once};
pub use packet::RawRow;
pub use stream::MyStream;
pub use tls::{MyTlsParams, MyTlsVerify};
