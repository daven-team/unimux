//! SSH vault, known hosts, keys, russh login core, coordinator, command history (S1-S4)
//!
//! Skeleton created by wave 0 (F1). The owning packages fill it in (see docs/tauri/PLAN.md); its commands are registered in
//! `unimux-app/src/commands/<domain>.rs`, which calls into this crate.

pub mod algorithms;
pub mod command_history;
pub mod coordinator;
pub mod errors;
pub mod history_rules;
pub mod host;
pub mod ipc;
pub mod js_value;
pub mod keys;
pub mod known_hosts;
pub mod login;
pub mod protocol;
pub mod session;
pub mod stores;
#[cfg(any(test, feature = "test-server"))]
pub mod test_server;
pub mod vault;
