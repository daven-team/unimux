//! hook server, Claude/Codex settings, CLI detector, context, sessions, conversation search, delivery (H1-H6)
//!
//! Filled in by the owning packages (see docs/tauri/PLAN.md); its commands are registered in
//! `unimux-app/src/commands/agents.rs`, which calls into this crate.
//!
//! - [`hooks`] (H1): the local hook server and the meaning of hook payloads.
//! - [`cli`] (H3): the Claude Code / Codex CLI detector.
//! - [`conv`] (H5): conversation search and the Markdown export data.

pub mod cli;
pub mod conv;
pub mod hooks;
