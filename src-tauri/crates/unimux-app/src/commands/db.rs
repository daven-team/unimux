//! Commands of the `db` domain: D1-D12: database connections and sessions (db:*); the db port owner registers with ctx.ports.register("db", ...).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).

use std::sync::Arc;

use unimux_ipc::RouterBuilder;

use crate::context::AppContext;

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let _ = (r, ctx);
}
