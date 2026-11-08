//! hook server, Claude/Codex settings, CLI detector, context, sessions, conversation search, delivery (H1-H6)
//!
//! Filled in by the owning packages (see docs/tauri/PLAN.md); its commands are registered in
//! `unimux-app/src/commands/agents.rs`, which calls into this crate.
//!
//! - [`hooks`] (H1): the local hook server and the meaning of hook payloads; H2: the per-cell Claude settings
//!   ([`hooks::claude`]), the Codex notify overrides ([`hooks::codex`]) and the http hook fallback ([`hooks::fallback`]).
//! - [`cell_files`] (H2): the per-cell hook / MCP / prompt files and their cleanup.
//! - [`cli`] (H3): the Claude Code / Codex CLI detector.
//! - [`conv`] (H5): conversation search and the Markdown export data.
//! - [`context`] (H4): the context meter of each agent cell (transcript usage, read incrementally).
//! - [`sessions`] (H4): past conversations of a project and its worktrees (`sessions:list`), the Codex session guess of
//!   `codex:bind`.

//! - [`install`] (H6): the guided install of the CLIs in an `install:` terminal.
//! - [`delivery`] (H6): `codex queue` delivery to a running Codex session.
//! - [`prompt`] (H6): the request / answer repairs of `agents:prompt`.

pub mod cell_files;
pub mod cli;
pub mod context;
pub mod conv;
pub mod delivery;
pub mod fsstat;
pub mod hooks;
pub mod install;
pub mod prompt;
pub mod sessions;
