//! The window.mc IPC layer of unimux 1.2.0 (PLAN F2/F3), free of Tauri so it is tested with plain `cargo test`.
//!
//! - [`contract`]: the generated contract (`src-tauri/gen/ipc-contract.json`): every channel, its kind and its domain.
//! - [`router`]: channel -> async handler. A channel of the contract without a handler answers [`IpcError::NotYet`]; the
//!   sender guard runs centrally for every channel that is not in [`guard::OPEN_COMMANDS`], so no handler can forget it.
//! - [`send_queue`]: `ipcRenderer.send` ordering for fire-and-forget calls (Tauri invokes run concurrently).
//! - [`events`]: push events with scopes (broadcast, main, window, cell), the routed `send` and the "flush the state first" hook.
//! - [`route`]: `routeMessage` of 1.1.4 (which window hears which channel).
//! - [`binary`]: the frame of binary results (bytes inside a JSON value) on the raw path.
//! - [`ports`]: the three MessagePort replacements (pty, sftp, db) backed by Tauri channels; owners register later.
//!
//! How a domain adds a command: in `unimux-app/src/commands/<domain>.rs`, `r.invoke("git:status", move |call| async move
//! { ... })`. Nothing else is edited: the contract already lists the channel, the report counts it as implemented.

pub mod binary;
pub mod contract;
pub mod error;
pub mod events;
pub mod guard;
pub mod ports;
pub mod route;
pub mod router;
pub mod send_queue;

pub use contract::{ChannelKind, Contract};
pub use error::IpcError;
pub use events::{EventSink, Events, Scope};
pub use guard::{Caller, Guard, OPEN_COMMANDS, WindowGuard};
pub use ports::{PortOwner, PortSink, Ports};
pub use route::{BROADCAST_CHANNELS, CELL_CHANNELS, RouteTarget, route_message};
pub use router::{Call, Reply, Router, RouterBuilder};
pub use send_queue::SendQueue;
