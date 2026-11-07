//! DB service, vault, history, PG / MySQL / Redis / SQLite sessions, tunnels, result routing (D1-D12)
//!
//! Skeleton created by wave 0 (F1). The owning packages fill it in (see docs/tauri/PLAN.md); its commands are registered in
//! `unimux-app/src/commands/<domain>.rs`, which calls into this crate.

pub mod redis_shared;
pub mod sql;
pub mod wire;
