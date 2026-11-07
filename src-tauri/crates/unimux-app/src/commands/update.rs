//! Commands of the `update` domain (U1): update state, check, install (update:*), and the `update:state` event. The service
//! itself is crate::update.
//!
//! Registered by `register` only; the update service is made here, once per context.

use std::sync::Arc;

use serde_json::Value;
use unimux_ipc::RouterBuilder;
use unimux_update::coordinator::CheckReason;

use crate::context::AppContext;
use crate::update::UpdateService;

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let svc = ctx.update.get_or_init(|| UpdateService::new(ctx)).clone();

    // A check changes the update state (and may start a download); a foreign sender gets nothing done (the guard).
    let s = svc.clone();
    r.invoke("update:check", move |_| {
        let s = s.clone();
        async move {
            s.check_for_updates(CheckReason::Manual).await;
            Ok(Value::Null)
        }
    });

    let s = svc.clone();
    r.invoke("update:get", move |_| {
        let s = s.clone();
        async move { Ok(s.get()) }
    });

    let c = ctx.clone();
    r.send("update:install", move |_| {
        let c = c.clone();
        async move { crate::update::open_install_window(&c) }
    });

    // 1.1.2: what main knows of the work an update would interrupt (an account swap or login in progress).
    let s = svc.clone();
    r.invoke("update:busy", move |_| {
        let s = s.clone();
        async move { Ok(s.busy()) }
    });

    r.send("update:open", move |_| async move {
        unimux_platform::open_url(unimux_update::RELEASES_URL);
    });
}
