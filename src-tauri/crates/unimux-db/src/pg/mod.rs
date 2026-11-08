//! D4: the Postgres client of the DB sessions (1.1.4: node-postgres in src/dbhost, driven by host.ts and pgSession.ts).
//!
//! - [`connect`]: streams from a [`connect::Connector`] (TCP or the SSH tunnel), SSLRequest / TLS modes with the prefer
//!   fallback, the login with password questions, the session settings and the server version.
//! - [`tls`]: rustls (ring) configurations for disable / prefer / require / verify-full (CA text, IP SANs).
//! - [`client`]: one connection: startup 3.0, cleartext / MD5 / SCRAM-SHA-256, simple query with several results,
//!   one extended statement with text parameters, notices, the ReadyForQuery transaction state, COPY refused and drained.
//! - [`cancel`]: `pg_cancel_backend` on a side connection, the protocol CancelRequest as the fallback.
//! - [`port`]: server errors and notices as DB port JSON (lone-surrogate safe) and the statement error codes.
//! - [`error`]: connect errors and their fixed codes (`mapConnectError`).
//!
//! - [`session`] (D5): PgSession: runs, cursors (portals read in adaptive batches, one open result), fetchMore /
//!   closeResult, read-only enforcement with the readWrite override, statement timeouts, cancel, transaction ops.
//! - [`messages`] (D5): the DB port messages of a session.
//!
//! - [`meta`] (D6): catalog reads (databases, schemas, objects, tableInfo, DDL); the session adds table pages, edits and
//!   cellValue.

pub mod cancel;
pub mod client;
pub mod connect;
pub mod error;
pub mod messages;
pub mod meta;
pub mod port;
pub mod session;
pub mod tls;
