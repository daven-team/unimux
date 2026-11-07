//! macOS updates (PLAN U5): the engine (feed entry, signed download, unpack, bundle checks, staging next to the app, the
//! `updates/mac` bookkeeping shared with 1.1.4) and the bundle swap the update window runs once the app has quit.
//!
//! Only the swap and `finish_previous` / `mark_ready` touch the installed app; everything is plain Rust plus the macOS system
//! tools (`ditto`, `xattr`, `plutil`, `codesign`, `open`), so the module builds and its tests run on every platform.

pub mod engine;
pub mod plist;
pub mod swap;
pub mod target;

pub use engine::{
    DOWNLOAD_CANCELLED, MacCheckResult, MacInstall, MacOffer, MacPreviousOutcome, MacProgress, MacStaged, MacUpdater,
    MacUpdaterDeps, append_update_log, messages,
};
pub use swap::BundleSwapPlan;
pub use target::MacRefusal;

use std::path::Path;

/// At start (macOS, updates active): how the previous update ended. `Failed` is for the caller to record (the update gate's
/// failure cooldown, U1) and to show `messages::ROLLED_BACK` in the status bar.
pub fn previous_update(
    data_dir: &Path,
    version: &str,
    packaged: bool,
    log: impl Fn(&str) + Send + Sync + 'static,
) -> MacPreviousOutcome {
    let mut deps = MacUpdaterDeps::for_app(data_dir, version, packaged, vec![]);
    deps.log = Some(std::sync::Arc::new(log));
    MacUpdater::new(deps).finish_previous()
}

/// The main window of this version is up: releases a waiting 1.1.4 swap script (`updates/mac/ready`) and cleans up.
pub fn signal_ready(data_dir: &Path, version: &str, packaged: bool) {
    MacUpdater::new(MacUpdaterDeps::for_app(data_dir, version, packaged, vec![])).mark_ready();
}
