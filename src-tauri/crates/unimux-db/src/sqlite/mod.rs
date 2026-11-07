//! D11: SQLite sessions (1.1.4 src/dbhost/sqliteSession.ts, sqliteWorker.ts, sqliteMeta.ts and the SQLite part of
//! host.ts). The bundled SQLite (rusqlite, column metadata) runs in one thread per session ([`engine`]); [`session`] keeps
//! the session's rules (runs, cursors, read-only guard, edits, cancel); [`meta`] reads the catalog; [`port`] writes the DB
//! port messages. D12 routes the port messages to the windows and plugs [`SqliteSession`] into the DB host.

pub mod engine;
pub mod meta;
pub mod port;
pub mod session;

pub use engine::{ConnSetup, EngineError};
pub use port::{PortColumn, PortMessage, ServerError};
pub use session::{OpenError, SqliteOptions, SqliteOut, SqliteSession, sqlite_error_code, sqlite_server_error};

use crate::sql::DbSqlError;

/// Why an operation failed: an engine error, a SQL builder refusal, or something else (`dbFailed`).
#[derive(Debug, Clone, PartialEq)]
pub enum Fail {
    Engine(EngineError),
    Sql(DbSqlError),
    Other(String),
}
