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
//! D8 adds the session on top (1.1.4 src/dbhost/mysqlSession.ts, mysqlMeta.ts and the MySQL half of host.ts):
//!
//! - [`session`]: [`session::MysqlSession`] (operations one at a time on a task that owns the connection, KILL QUERY on a
//!   side connection, the open "load more" result with its idle timer, CALL result sets with caps, SHOW WARNINGS notices,
//!   USE tracking, the read-only override and statement timeouts restored afterwards, table pages, staged edits, whole
//!   cells, the idle close watch).
//! - [`meta`]: the catalog reads (databases, objects, table info, DDL).
//! - [`port`]: the DB port messages, written like `JSON.stringify`.
//! - [`host`]: [`host::MysqlHost`], the [`crate::host::DbHostLink`] that opens MySQL sessions (password prompts, TLS
//!   modes, tunnels, the session settings) and hands every other kind to the next link.
//!
//! The column parser, the charset tables and the LOAD DATA LOCAL answer are shared with the SP9 code in [`crate::wire`].

pub mod conn;
pub mod error;
pub mod host;
pub mod meta;
pub mod open;
pub mod packet;
pub mod port;
pub mod session;
pub mod stream;
pub mod tls;

pub use crate::wire::mysql::{MyColumn, MyResult};
pub use conn::{MyConn, MyEvent, MyExec, MyLogin, MyOk};
pub use error::{DbServerError, MyError, MyServerError, connect_message, map_connect_error, server_error};
pub use host::{MysqlHost, MysqlHostDeps};
pub use open::{MyOpenParams, MyTlsMode, connect_tcp, open, open_once};
pub use packet::RawRow;
pub use port::MyPortMessage;
pub use session::{MysqlOptions, MysqlOut, MysqlSession};
pub use stream::MyStream;
pub use tls::{MyTlsParams, MyTlsVerify};
