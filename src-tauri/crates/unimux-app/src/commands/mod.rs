//! The one registration point of window.mc commands. Every domain has its own file, created in wave 0 so later packages
//! (each in its own worktree) only edit their file. The order does not matter: the router rejects a channel registered twice.

use std::sync::Arc;

use unimux_ipc::RouterBuilder;

use crate::context::AppContext;

pub mod accounts;
pub mod agents;
pub mod app;
pub mod automation;
pub mod cells;
pub mod db;
pub mod fallbacks;
pub mod files;
pub mod git;
pub mod github;
pub mod mcp;
pub mod os;
pub mod pty;
pub mod sftp;
pub mod ssh;
pub mod state;
pub mod update;
pub mod window;

/// Tests that register a domain run one at a time: `register` replaces process-wide handles (agents' conversation search).
#[cfg(test)]
pub(crate) static REGISTER_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

pub fn register_all(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    fallbacks::register(r, ctx);
    app::register(r, ctx);
    cells::register(r, ctx);
    state::register(r, ctx);
    window::register(r, ctx);
    os::register(r, ctx);
    pty::register(r, ctx);
    agents::register(r, ctx);
    mcp::register(r, ctx);
    files::register(r, ctx);
    git::register(r, ctx);
    github::register(r, ctx);
    ssh::register(r, ctx);
    sftp::register(r, ctx);
    db::register(r, ctx);
    accounts::register(r, ctx);
    update::register(r, ctx);
}

#[cfg(test)]
mod tests {
    //! The contract test of the app (PLAN F3): every registration matches the contract, and the wave 0 channels are in.
    use super::*;
    use std::time::Instant;
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};
    use unimux_ipc::Contract;
    use unimux_ipc::router::Status;

    #[test]
    fn every_registration_matches_the_contract() {
        let _one = REGISTER_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        let ctx = AppContext::new(
            dir.path().to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir.path())),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.path().join("startup.log"), "")),
            serde_json::json!({"version": 1, "projects": []}),
        );
        let mut builder = RouterBuilder::new(Contract::embedded());
        register_all(&mut builder, &ctx);
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        let router = builder.build(ctx.guard.clone());
        let report = router.report();
        assert_eq!(report.len(), 224);
        for channel in [
            "state:load",
            "state:snapshot",
            "state:edit",
            "app:claimStart",
            "app:startupMark",
            "app:reportError",
            // W1: the caption buttons the page draws.
            "window:minimize",
            "window:toggleMaximize",
            "window:close",
            "window:isMaximized",
            "window:captionArea",
        ] {
            assert_eq!(report[channel], Status::Implemented, "{channel}");
        }
        // P3: the pty service answers which cells run.
        for channel in ["cell:alive", "cell:kill", "cell:killAndWait"] {
            assert_eq!(report[channel], Status::Implemented, "{channel}");
        }
        // W7: the status reports of the windows (relay, taskbar, observers).
        assert_eq!(report["cell:runtime"], Status::Implemented);
        for channel in ["mcp:info", "mcp:retry"] {
            assert_eq!(report[channel], Status::Implemented, "{channel}");
        }
        ctx.saver.stop();
    }
}
