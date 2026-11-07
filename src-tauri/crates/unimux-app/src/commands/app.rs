//! Commands of the `app` domain: the start claim, startup marks and renderer error reports (wave 0), the quit guard and its
//! answer (`app:quitGuard`, `app:quitAnswer`, W6).

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
            #[cfg(feature = "test-bridge")]
            c.test_marks.lock().push((call.caller.label.clone(), name.to_string(), crate::channel_bench::epoch_ms()));
            // The renderer booted: show the main window if the page-load event did not already.
            if name == "renderer-boot" && call.caller.is_main() {
                crate::windows::show_main(&c);
            }
        }
    });

    // Whether quitting must ask first (some agent works, transfers run, unsaved database work); only `true` holds a quit.
    let c = ctx.clone();
    r.send("app:quitGuard", move |call| {
        let c = c.clone();
        async move { crate::lifecycle::set_quit_guard(&c, call.arg(0) == &Value::Bool(true)) }
    });

    // The answer to `app:confirm-quit`: 'asking' at once, then 'quit' or 'cancel'; anything else is ignored.
    let c = ctx.clone();
    r.send("app:quitAnswer", move |call| {
        let c = c.clone();
        async move {
            if let Some(answer) = crate::lifecycle::quit_confirm::QuitAnswer::parse(call.arg(0)) {
                crate::lifecycle::quit_answer(&c, answer);
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
