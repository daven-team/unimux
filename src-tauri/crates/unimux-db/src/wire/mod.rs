//! SP9 (DB wire fidelity) spike code: the value form of the DB port and minimal Postgres / MySQL / Redis wire clients over
//! any stream, measured against the 1.1.4 drivers (node-postgres, mysql2, ioredis) by `tests/wire_servers.rs` and the
//! goldens in test/golden/db-wire/. D4, D7 and D9 build the production clients from these findings
//! (docs/tauri/spikes/SP9.md).

pub mod mysql;
pub mod pg;
pub mod redis;
pub mod tap;
pub mod value;
