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

/// `update-gate.json` of the data dir: the update gate's record of an attempt or failure (`{version, at}`, 1.1.4's
/// `writeGateRecord`). The gate reads it to apply its failure cooldown to that version.
pub const GATE_FILE: &str = "update-gate.json";

/// What `previous_update_at_start` found on this start (None before it ran or when updates are not active), for U1's status
/// bar text (`messages::ROLLED_BACK`) and its in-memory block of the failed version (1.1.4's `blockUpdateVersion`).
static AT_START: std::sync::OnceLock<MacPreviousOutcome> = std::sync::OnceLock::new();

/// 1.1.4's `recordUpdateFailure` minus the in-memory block: the gate's record of the failed version, so its 6 h cooldown
/// applies from this start on.
pub fn record_gate_failure(data_dir: &Path, version: &str, now_ms: i64) -> std::io::Result<()> {
    let record = serde_json::json!({ "version": version, "at": now_ms });
    unimux_core::atomic_write::atomic_write(
        &data_dir.join(GATE_FILE),
        record.to_string().as_bytes(),
        &unimux_core::atomic_write::AtomicWriteOptions::default(),
    )
}

/// The start-up step of 1.1.4 (`previousMacUpdate` before `runUpdateGate`): only when updates are active (`updates_active`
/// = a packaged build or a development feed, 1.1.4's `updatesActive()`), so a dev build on the real profile never consumes
/// the installed app's evidence. A failure is recorded for the gate before it runs and kept for [`outcome_at_start`].
pub fn previous_update_at_start(
    data_dir: &Path,
    version: &str,
    packaged: bool,
    updates_active: bool,
    log: impl Fn(&str) + Send + Sync + 'static,
) -> MacPreviousOutcome {
    if !updates_active {
        return MacPreviousOutcome::None;
    }
    let outcome = previous_update(data_dir, version, packaged, log);
    if let MacPreviousOutcome::Failed { version } = &outcome {
        let _ = record_gate_failure(data_dir, version, unimux_core::time::now_ms());
    }
    let _ = AT_START.set(outcome.clone());
    outcome
}

/// How the previous macOS update ended, as found by [`previous_update_at_start`] on this start.
pub fn outcome_at_start() -> MacPreviousOutcome {
    AT_START.get().cloned().unwrap_or(MacPreviousOutcome::None)
}

/// The main window of this version is up: releases a waiting 1.1.4 swap script (`updates/mac/ready`) and cleans up.
pub fn signal_ready(data_dir: &Path, version: &str, packaged: bool) {
    MacUpdater::new(MacUpdaterDeps::for_app(data_dir, version, packaged, vec![])).mark_ready();
}
