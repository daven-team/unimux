//! Commands of the `git` domain: G1-G4: git reads, mutations, worktrees (git:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).

use std::sync::Arc;

use unimux_ipc::RouterBuilder;

use crate::context::AppContext;

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let _ = (r, ctx);
}
