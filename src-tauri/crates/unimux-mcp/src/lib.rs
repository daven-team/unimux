//! MCP HTTP server, tools, automation, wait_for, team prompts (M1-M4).
//!
//! M1: the HTTP server of 1.1.4's mcp.ts ([`server`]), the JSON-RPC wire pieces ([`jsonrpc`]), the elicitation answer
//! checks ([`elicit`]) and the seam to the tool layer ([`tools::ToolHost`], filled in by M2 / M3). The app's commands
//! (`mcp:info`, `mcp:retry`) are in `unimux-app/src/commands/mcp.rs`.

pub mod elicit;
pub mod jsonrpc;
pub mod server;
mod surrogate_ids;
pub mod tools;

pub use server::{Config, Connection, McpServer, in_request};
pub use tools::{CallCtx, CallError, ToolHost};
