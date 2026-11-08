//! DB service, vault, history, PG / MySQL / Redis / SQLite sessions, tunnels, result routing (D1-D12)
//!
//! Its commands are registered in `unimux-app/src/commands/db.rs`, which calls into this crate.
//!
//! - D1: [`service`] (connections, sessions, prompts, idle disconnect, pins, tests), [`vault`] (db/vault.json),
//!   [`history`] (db/query_history.json), [`sqlite_files`], [`ipc`] (the validation in front of every `db:*` channel with
//!   the fixed answers of 1.1.4), [`host`] (the link to the sessions: op timeouts, Redis deadlines, pending requests).
//! - D3: [`sql`], [`redis_shared`]; SP9: [`wire`].
//! - D4: [`pg`] (the Postgres client: connect, TLS, logins, simple query, cancel).
//! - D7: [`mysql`] (the MySQL / MariaDB client core).
//! - D9: [`redis`] (Redis sessions and browsing on the own RESP2 client).
//! - D11: [`sqlite`] (SQLite sessions: engine thread, catalog, port messages).
//! - D2: [`tunnel`] (the shared SSH tunnels of the sessions: owner / riders / hand-over, direct-tcpip channels, no local
//!   port).

pub mod files;
pub mod history;
pub mod host;
pub mod ipc;
pub mod model;
pub mod mysql;
pub mod pg;
pub mod redis;
pub mod redis_shared;
pub mod service;
pub mod sql;
pub mod sqlite;
pub mod sqlite_files;
pub mod timers;
pub mod tunnel;
pub mod vault;
pub mod wire;
