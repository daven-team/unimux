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
pub mod js_value;
pub mod keys;
pub mod known_hosts;
pub mod login;
pub mod protocol;
pub mod remote;
pub mod session;
pub mod shell;
pub mod stores;
pub mod vault;
