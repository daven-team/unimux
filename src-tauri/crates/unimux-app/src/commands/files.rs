//! Commands of the `files` domain: G5-G8: project files, file ops, search, notes, fs probes, monitor, changelog, local pane (fs:*, local:*, notes:*, monitor:*, changelog:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).

use std::sync::Arc;

use unimux_ipc::RouterBuilder;

use crate::context::AppContext;

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let _ = (r, ctx);
}
