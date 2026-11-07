//! MCP HTTP server, tools, automation, wait_for, team prompts (M1-M4).
//!
//! M1: the HTTP server of 1.1.4's mcp.ts ([`server`]), the JSON-RPC wire pieces ([`jsonrpc`]), the elicitation answer
//! checks ([`elicit`]) and the seam to the tool layer ([`tools::ToolHost`]). The app's commands (`mcp:info`, `mcp:retry`)
//! are in `unimux-app/src/commands/mcp.rs`.
//!
//! M2: the tool layer of 1.1.4's mcpTools.ts: the tool definitions, help texts and instructions ([`catalog`]), the zod 4
//! checks ([`zod`]) with the automation and tool argument schemas ([`schemas`]), and [`host::McpTools`], the
//! [`ToolHost`] over an [`automation::Automation`] (the automation service, M3).

pub mod automation;
pub mod catalog;
pub mod elicit;
#[cfg(feature = "fake-automation")]
pub mod fake;
pub mod host;
mod js;
pub mod jsonrpc;
pub mod schemas;
pub mod server;
mod surrogate_ids;
pub mod tools;
pub mod zod;

pub use automation::{Automation, OpError};
pub use catalog::Role;
pub use host::McpTools;
pub use server::{Config, Connection, McpServer, in_request};
pub use tools::{CallCtx, CallError, ToolHost};
