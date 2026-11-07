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
            // The first one wins (a reloaded window reports renderer-boot again); startup.log is rewritten only for a new mark.
            if !c.timer.has(name) {
                c.mark(name);
            }
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

#[cfg(test)]
mod tests {
    //! W7: the renderer's error reports and startup marks through the registered handlers (index.ts app:reportError /
    //! app:startupMark).
    use serde_json::json;
    use unimux_ipc::{Call, Caller};

    use crate::cells::test_ctx;

    fn send(router: &unimux_ipc::Router, command: &str, args: Vec<serde_json::Value>) {
        let caller = Caller::new("main", "http://tauri.localhost/index.html");
        tauri::async_runtime::block_on(router.run_send(Call::new(command, caller, args)));
    }

    #[test]
    fn renderer_reports_reach_crash_log_well_formed_and_at_most_twenty_a_minute() {
        let (_dir, ctx, router) = test_ctx(json!({ "version": 1, "projects": [] }));
        send(&router, "app:reportError", vec![json!("boundary"), json!("cell: boom"), json!("at x")]);
        send(&router, "app:reportError", vec![json!("Bad Kind!"), json!("x")]);
        send(&router, "app:reportError", vec![json!("boot"), json!({ "message": "x" })]);
        for i in 0..30 {
            send(&router, "app:reportError", vec![json!("loop"), json!(format!("n{i}"))]);
        }
        let log = std::fs::read_to_string(ctx.crash.path()).unwrap();
        let lines: Vec<&str> = log.lines().filter(|l| l.contains(" error renderer ")).collect();
        assert!(lines[0].ends_with(" error renderer boundary: cell: boom"), "{log}");
        assert!(log.contains("\nat x\n"), "{log}");
        assert_eq!(lines.len(), 20, "the limiter keeps 20 a minute: {log}");
        assert!(!log.contains("Bad Kind") && !log.contains("[object"), "{log}");
        assert!(!log.contains("n19") && log.contains("n18"), "{log}");
        ctx.saver.stop();
    }

    #[test]
    fn startup_marks_are_the_fixed_renderer_marks_and_the_first_one_wins() {
        let (_dir, ctx, router) = test_ctx(json!({ "version": 1, "projects": [] }));
        send(&router, "app:startupMark", vec![json!("window-created")]);
        send(&router, "app:startupMark", vec![json!(1)]);
        send(&router, "app:startupMark", vec![json!("first-output")]);
        let first = ctx.timer.line();
        std::thread::sleep(std::time::Duration::from_millis(20));
        send(&router, "app:startupMark", vec![json!("first-output")]);
        assert_eq!(ctx.timer.line(), first);
        assert!(first.contains("first-output=") && !first.contains("window-created"), "{first}");
        let log = std::fs::read_to_string(ctx.startup_log.path()).unwrap();
        assert_eq!(log, format!("header {first}\n"), "one line for this launch, written for the new mark");
        ctx.saver.stop();
    }
}
