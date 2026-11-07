//! hook server, Claude/Codex settings, CLI detector, context, sessions, conversation search, delivery (H1-H6)
//!
//! Filled in by the owning packages (see docs/tauri/PLAN.md); its commands are registered in
//! `unimux-app/src/commands/agents.rs`, which calls into this crate.
//!
//! - [`hooks`] (H1): the local hook server and the meaning of hook payloads.
//! - [`cli`] (H3): the Claude Code / Codex CLI detector.

pub mod cli;
pub mod hooks;
