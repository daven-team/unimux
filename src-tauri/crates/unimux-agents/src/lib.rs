//! hook server, Claude/Codex settings, CLI detector, context, sessions, conversation search, delivery (H1-H6)
//!
//! Filled in by the owning packages (see docs/tauri/PLAN.md); its commands are registered in
//! `unimux-app/src/commands/agents.rs`, which calls into this crate.
//!
//! - [`hooks`] (H1): the local hook server and the meaning of hook payloads.
//! - [`cli`] (H3): the Claude Code / Codex CLI detector.
//! - [`conv`] (H5): conversation search and the Markdown export data.
//! - [`context`] (H4): the context meter of each agent cell (transcript usage, read incrementally).
//! - [`sessions`] (H4): past conversations of a project and its worktrees (`sessions:list`), the Codex session guess of
//!   `codex:bind`.

pub mod cli;
pub mod context;
pub mod conv;
pub mod fsstat;
pub mod hooks;
pub mod sessions;
