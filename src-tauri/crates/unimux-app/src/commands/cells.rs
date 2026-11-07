//! W7 commands and wiring of the core cell bookkeeping: `cell:runtime` (a window's StatusTracker reports a cell's status) and
//! the taskbar view's inputs (index.ts `createTaskbar` deps and its callers). The bookkeeping itself is in crate::cells.
//!
//! `cell:runtime(cellId, status, reason?, hooked?, cliEnded?, exitCode?)`, as the 1.1.4 handler:
//! 1. a detached window's report reaches the main window as `detach:status` (relayCellStatus);
//! 2. a known status counts for the taskbar (the reason only when it is one of the known reasons), keyed by the reporting
//!    window so a reload of that window forgets it;
//! 3. for a cell that exists in a grid and runs, the observers hear it (hookWatch H2, CLI ends P3 / M3, automation M3).

use std::sync::Arc;

use serde_json::Value;
use unimux_agents::hooks::route::find_cell;
use unimux_ipc::RouterBuilder;
use unimux_platform::taskbar::{CellRuntime, Taskbar, is_cell_status, is_status_reason};

use crate::cells::parse_runtime;
use crate::context::AppContext;

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let c = ctx.clone();
    r.send("cell:runtime", move |call| {
        let c = c.clone();
        async move { runtime(&c, &call.caller.label, &call.args) }
    });
}

/// One `cell:runtime` report from the window `label`.
pub fn runtime(ctx: &AppContext, label: &str, args: &[Value]) {
    report(ctx, ctx.os.get().map(|os| &os.taskbar), label, args);
}

fn report(ctx: &AppContext, taskbar: Option<&Arc<Taskbar>>, label: &str, args: &[Value]) {
    let null = Value::Null;
    ctx.detached.relay_cell_status(label, args.first().unwrap_or(&null), args.get(1).unwrap_or(&null));
    let Some(report) = parse_runtime(args) else { return };
    if is_cell_status(&report.status)
        && let Some(taskbar) = taskbar
    {
        let reason = report.reason.as_deref().filter(|r| is_status_reason(r));
        taskbar.status(&report.cell, CellRuntime::new(&report.status, reason), Some(&ctx.detached.sender_window(label)));
    }
    if find_cell(&ctx.state.get(), &report.cell).is_none() || !ctx.cells.is_alive(&report.cell) {
        return;
    }
    ctx.cells.runtime_report(&report);
}

/// The taskbar's inputs besides the statuses (index.ts): a cell that is forgotten no longer counts (`taskbar.forget` in
/// forgetCell), a change of the grids, mutes, profiles or alert settings recomputes the view (`taskbar.invalidate`), a
/// reload of the main page forgets what it reported (`did-start-loading` -> `forgetWindow('main')`), a detached window's
/// page going away forgets that window's reports (`rendererGone(window)`), and showing the main window shows the view again
/// (`win.on('show')` -> `reapply`). Called by commands::os::register once the taskbar exists.
pub fn wire_taskbar(ctx: &Arc<AppContext>, taskbar: &Arc<Taskbar>) {
    let t = Arc::downgrade(taskbar);
    ctx.cells.on_forget_unless_alive("taskbar", move |cell| {
        if let Some(t) = t.upgrade() {
            t.forget(cell);
        }
    });
    let t = Arc::downgrade(taskbar);
    ctx.cells.on_state_changed("taskbar", move |previous, next| {
        let changed = |key: &str| previous.get(key) != next.get(key);
        fn alerts(v: &Value) -> Option<&Value> {
            v.get("settings").and_then(|s| s.get("alerts"))
        }
        if (changed("projects") || changed("profiles") || alerts(previous) != alerts(next))
            && let Some(t) = t.upgrade()
        {
            t.invalidate();
        }
    });
    let t = Arc::downgrade(taskbar);
    ctx.on_main_page_started(move || {
        if let Some(t) = t.upgrade() {
            t.forget_window("main");
        }
    });
    let t = Arc::downgrade(taskbar);
    ctx.detached.hooks().on_page_gone.push(Arc::new(move |window: &str, _closed: bool| {
        if let Some(t) = t.upgrade() {
            t.forget_window(window);
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cells::{CellReport, test_ctx};
    use parking_lot::Mutex;
    use serde_json::json;
    use unimux_platform::taskbar::TaskbarDeps;
    use unimux_platform::timers::ManualScheduler;

    fn grid(cells: Value, archive: Value) -> Value {
        json!({
            "version": 1,
            "profiles": [{ "id": "cl", "cli": "claude" }, { "id": "sh", "cli": "shell" }],
            "settings": { "alerts": { "taskbarBadge": true } },
            "projects": [{ "id": "p1", "tabs": [{ "id": "t1", "cells": cells }], "archive": archive }],
        })
    }

    /// Replaces the first tab's cells (and the archive) the way a renderer edit or MCP would.
    fn set_cells(ctx: &AppContext, cells: Value, archive: Value) {
        ctx.state
            .change(
                |s| {
                    let mut next = s.clone();
                    next["projects"][0]["tabs"][0]["cells"] = cells;
                    next["projects"][0]["archive"] = archive;
                    Ok(next)
                },
                None,
                false,
            )
            .unwrap();
    }

    #[test]
    fn a_closed_cell_loses_its_codex_mark_always_and_its_hook_nonce_only_without_a_process() {
        let (_dir, ctx, _router) =
            test_ctx(grid(json!([{ "id": "w7-run", "profileId": "cl" }, { "id": "w7-gone", "profileId": "cl" }]), json!([])));
        for cell in ["w7-run", "w7-gone"] {
            ctx.hooks.server.renew_nonce(cell);
        }
        ctx.cells.set_alive("w7-run", true);
        assert!(ctx.hooks.is_alive("w7-run"), "the hook routing reads the alive cells");
        set_cells(&ctx, json!([]), json!([]));
        assert!(ctx.hooks.server.nonce("w7-run").is_some(), "a process that still runs keeps its hook settings");
        assert_eq!(ctx.hooks.server.nonce("w7-gone"), None);
        ctx.saver.stop();
    }

    #[test]
    fn the_mcp_token_of_a_team_cell_ends_when_it_leaves_the_grids() {
        let (_dir, ctx, _router) = test_ctx(grid(
            json!([{ "id": "w7-lead", "profileId": "cl", "role": "lead" }, { "id": "w7-dev", "profileId": "cl", "role": "dev" }]),
            json!([]),
        ));
        let server = crate::commands::mcp::server().unwrap();
        server.issue_token("w7-lead");
        server.issue_token("w7-dev");
        // The lead is archived (it stays in the state), the developer stays.
        set_cells(
            &ctx,
            json!([{ "id": "w7-dev", "profileId": "cl", "role": "dev" }]),
            json!([{ "id": "t0", "cells": [{ "id": "w7-lead", "profileId": "cl", "role": "lead" }] }]),
        );
        assert_eq!(server.connection("w7-lead"), unimux_mcp::server::Connection::Off);
        assert_eq!(server.connection("w7-dev"), unimux_mcp::server::Connection::Waiting);
        ctx.saver.stop();
    }

    /// A darwin taskbar wired to the app: runtime reports count for running agent cells, a reload of the main page forgets
    /// what it reported, an unknown reason is no attention, a mute recomputes the badge, a forgotten cell no longer counts,
    /// and a change of `settings.alerts` or of the profiles recomputes it too (index.ts:806).
    #[test]
    fn the_taskbar_follows_reports_reloads_removals_and_mutes() {
        let cells = json!([
            { "id": "w7-a", "profileId": "cl" },
            { "id": "w7-b", "profileId": "cl" },
            { "id": "w7-sh", "profileId": "sh" },
        ]);
        let (_dir, ctx, _router) = test_ctx(grid(cells, json!([])));
        let calls: Arc<Mutex<Vec<String>>> = Arc::default();
        let sched = Arc::new(ManualScheduler::default());
        let (c, s1, s2, a) = (calls.clone(), ctx.clone(), ctx.clone(), ctx.clone());
        let taskbar = Taskbar::new(TaskbarDeps {
            platform: "darwin".into(),
            // The app's own reading of the grids: a cell is an agent unless its profile's CLI is the shell.
            cells: Box::new(move || crate::commands::os::taskbar_cells(&s1.state.get())),
            alive: Box::new(move || a.cells.alive_set()),
            taskbar_badge: Box::new(move || s2.state.get()["settings"]["alerts"]["taskbarBadge"] == true),
            set_dock_badge: Box::new(move |t| c.lock().push(t.to_string())),
            scheduler: sched.clone(),
        });
        wire_taskbar(&ctx, &taskbar);
        let attention = |cell: &str| vec![json!(cell), json!("waiting"), json!("attention")];
        for cell in ["w7-a", "w7-b", "w7-sh"] {
            ctx.cells.set_alive(cell, true);
            report(&ctx, Some(&taskbar), "main", &attention(cell));
        }
        sched.fire();
        assert_eq!(taskbar.view(), "2", "two agents wait for the user, the shell never counts");
        // A reload of the main page forgets its reports until it reports again.
        ctx.main_page_started();
        sched.fire();
        assert_eq!(taskbar.view(), "");
        report(&ctx, Some(&taskbar), "main", &attention("w7-b"));
        report(&ctx, Some(&taskbar), "main", &[json!("w7-a"), json!("waiting"), json!("bogus")]);
        sched.fire();
        assert_eq!(taskbar.view(), "1", "an unknown reason is not attention");
        // A mute recomputes the view (a state change of the projects).
        set_cells(
            &ctx,
            json!([{ "id": "w7-a", "profileId": "cl" }, { "id": "w7-b", "profileId": "cl", "muted": true }]),
            json!([]),
        );
        sched.fire();
        assert_eq!(taskbar.view(), "");
        report(&ctx, Some(&taskbar), "main", &attention("w7-a"));
        sched.fire();
        assert_eq!(taskbar.view(), "1");
        // The cell closed for good after its process ended: forgotten, it no longer counts.
        ctx.cells.set_alive("w7-a", false);
        set_cells(&ctx, json!([{ "id": "w7-b", "profileId": "cl", "muted": true }]), json!([]));
        sched.fire();
        assert_eq!(taskbar.view(), "");
        assert_eq!(*calls.lock(), vec!["2", "", "1", "", "1", ""]);
        // One agent waits again.
        ctx.cells.set_alive("w7-a", true);
        set_cells(
            &ctx,
            json!([{ "id": "w7-a", "profileId": "cl" }, { "id": "w7-b", "profileId": "cl", "muted": true }]),
            json!([]),
        );
        report(&ctx, Some(&taskbar), "main", &attention("w7-a"));
        sched.fire();
        assert_eq!(taskbar.view(), "1");
        // Turning the setting off recomputes the view (only `settings.alerts` changes), turning it on shows the badge again.
        let set_state = |edit: &dyn Fn(&mut Value)| {
            ctx.state
                .change(
                    |s| {
                        let mut next = s.clone();
                        edit(&mut next);
                        Ok(next)
                    },
                    None,
                    false,
                )
                .unwrap();
        };
        set_state(&|s| s["settings"]["alerts"]["taskbarBadge"] = json!(false));
        sched.fire();
        assert_eq!(taskbar.view(), "", "the badge setting is off");
        set_state(&|s| s["settings"]["alerts"]["taskbarBadge"] = json!(true));
        sched.fire();
        assert_eq!(taskbar.view(), "1");
        // A profile change alone (its CLI becomes the shell) recomputes it: the cell is no agent any more.
        set_state(&|s| s["profiles"][0]["cli"] = json!("shell"));
        sched.fire();
        assert_eq!(taskbar.view(), "", "a shell cell never counts");
        set_state(&|s| s["profiles"][0]["cli"] = json!("claude"));
        sched.fire();
        assert_eq!(taskbar.view(), "1");
        assert_eq!(*calls.lock(), vec!["2", "", "1", "", "1", "", "1", "", "1", "", "1"]);
        ctx.saver.stop();
    }

    #[test]
    fn runtime_observers_hear_cells_that_exist_and_run_only() {
        let (_dir, ctx, router) = test_ctx(grid(json!([{ "id": "w7-r", "profileId": "cl" }]), json!([])));
        let heard: Arc<Mutex<Vec<CellReport>>> = Arc::default();
        let h = heard.clone();
        ctx.cells.on_runtime("test", move |r| h.lock().push(r.clone()));
        let caller = unimux_ipc::Caller::new("main", "http://tauri.localhost/index.html");
        let send = |args: Vec<Value>| {
            let call = unimux_ipc::Call::new("cell:runtime", caller.clone(), args);
            tauri::async_runtime::block_on(router.run_send(call));
        };
        send(vec![json!("w7-r"), json!("working"), Value::Null, json!(true)]);
        assert!(heard.lock().is_empty(), "no process runs");
        ctx.cells.set_alive("w7-r", true);
        ctx.cells.set_alive("w7-other", true);
        send(vec![json!("w7-other"), json!("working")]);
        send(vec![json!("w7-r"), json!("exited"), Value::Null, json!(true), json!(true), json!(0)]);
        send(vec![json!(5), json!("working")]);
        assert_eq!(heard.lock().len(), 1, "a cell outside the grids is not heard");
        let r = heard.lock()[0].clone();
        assert!(r.hooked && r.cli_ended && r.exit_code == Some(0) && r.status == "exited");
        ctx.saver.stop();
    }
}
