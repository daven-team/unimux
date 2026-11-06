//! Commands of the `app` domain implemented in wave 0: the start claim, startup marks and renderer error reports.
//! The quit guard and its answer (`app:quitGuard`, `app:quitAnswer`) belong to W6.

use std::sync::Arc;

use serde_json::Value;
use unimux_core::crash_log::renderer_report;
use unimux_core::startup_timing::is_renderer_mark;
use unimux_core::time::now_ms;
use unimux_ipc::RouterBuilder;

use crate::context::AppContext;

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    // True only for the first renderer load of this run (SSH hosts that reconnect at start).
    let c = ctx.clone();
    r.invoke("app:claimStart", move |_| {
        let c = c.clone();
        async move { Ok(Value::Bool(c.claim_app_start())) }
    });

    let c = ctx.clone();
    r.send("app:startupMark", move |call| {
        let c = c.clone();
        async move {
            let Some(name) = call.arg(0).as_str() else { return };
            if !is_renderer_mark(name) {
                return;
            }
            c.mark(name);
            // The renderer booted: show the main window if the page-load event did not already.
            if name == "renderer-boot" && call.caller.is_main() {
                crate::windows::show_main(&c);
            }
        }
    });

    // Errors of the renderer for crash.log (rate-limited, cut; the renderer is not trusted).
    let c = ctx.clone();
    r.send("app:reportError", move |call| {
        let c = c.clone();
        async move {
            let Some(line) = renderer_report(call.arg(0), call.arg(1), call.args.get(2)) else { return };
            if c.report_limiter.lock().allow(now_ms()) {
                c.crash.error(&line);
            }
        }
    });
}
