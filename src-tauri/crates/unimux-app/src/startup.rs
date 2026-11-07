//! Process start before `tauri::Builder` (PLAN F5): legacy entry points, the data dir, crash.log and the panic hook, the
//! translated "could not start" dialog.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use unimux_core::PACKAGED;
use unimux_core::crash_log::{RollingLog, describe_error};
use unimux_core::data_dir::{DATA_DIR_NAME, MigrationOptions, copy_multicoding_state, migrate_data_dir};
use unimux_core::dev_overrides::DevOverrides;
use unimux_core::home::app_data_dir;
use unimux_core::i18n::{detect_language, translate};
use unimux_update::legacy;

/// The crash log of this process, once the data dir is known (one writer: everything logs through here).
static CRASH: OnceLock<Arc<RollingLog>> = OnceLock::new();
/// False until the app runs: a panic before that is a failed start (dialog, exit 1).
static STARTED: AtomicBool = AtomicBool::new(false);
static DIALOGS: AtomicU32 = AtomicU32::new(0);
/// An unattended run (MC_OFFSCREEN, the real-app harness): errors are logged, no dialog waits for a click.
static QUIET: AtomicBool = AtomicBool::new(false);

pub fn set_quiet() {
    QUIET.store(true, Ordering::SeqCst);
}

/// The app winds down (W6): an error is only logged from now on. A blocking dialog would keep the process alive while an
/// installer waits for it (safeWindow.ts `decideUncaught`, phase 'quiet').
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

pub fn set_shutting_down() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
}
static LAST_DIALOG: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// What `main()` does before anything else for calls of the 1.1.x update machinery (U3): the 1.1.x update window ends with
/// `<appExe> -e <script>` and ELECTRON_RUN_AS_NODE=1 (a node one-liner removing its private runtime 3 s later). After the
/// update `appExe` is this exe: the call removes that folder (only a known `<data>/update/runtime`) and exits 0, with no
/// window, no instance lock, no crash.log and no single-instance forwarding.
pub fn legacy_entry() -> Option<i32> {
    let args: Vec<String> = std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect();
    let run_as_node = std::env::var_os("ELECTRON_RUN_AS_NODE").map(|v| v.to_string_lossy().into_owned());
    let script = legacy::eval_call(run_as_node.as_deref(), &args)?;
    let dev_data_dir = DevOverrides::from_env().data_dir;
    let candidates = legacy::runtime_dir_candidates(&app_data_dir(), dev_data_dir.as_deref());
    Some(legacy::run_eval_cleanup(&script, &candidates, legacy::EVAL_CLEANUP_DELAY))
}

/// `updateInstalling(START_BLOCK_MS)` at start (1.1.4 index.ts, right after the single-instance lock): the installer an
/// update window started is replacing this build's files right now, so the installed Windows app does not start.
pub fn install_in_progress_at_start(data_dir: &std::path::Path) -> bool {
    cfg!(windows)
        && PACKAGED
        && unimux_update::window::install_in_progress(
            data_dir,
            unimux_core::VERSION,
            unimux_update::window::START_BLOCK_MS,
            unimux_core::time::now_ms() as f64,
        )
}

/// The OS language for texts shown before the state is read.
pub fn os_language() -> String {
    let locale = unimux_platform::os_locale().unwrap_or_default();
    detect_language(&[locale]).to_string()
}

/// Decides the data dir: `MC_DATA_DIR` (dev-overrides builds only) or `<appData>/unimux`, moving `ajzakomator` once.
pub fn data_dir(overrides: &DevOverrides, log: &dyn Fn(&str)) -> PathBuf {
    let app_data = app_data_dir();
    let busy = |legacy: &std::path::Path| update_window_alive(&legacy.join("update"));
    let options = MigrationOptions {
        app_data: app_data.clone(),
        override_dir: overrides.data_dir.clone(),
        packaged: PACKAGED,
        fs: &unimux_core::data_dir::RealFs,
        now: unimux_core::time::now_ms(),
        busy: &busy,
        log,
    };
    let result = migrate_data_dir(&options);
    let _ = copy_multicoding_state(&app_data, &result.data_dir, overrides.data_dir.is_some()).map_err(|e| log(&e));
    debug_assert!(
        result.data_dir.ends_with(DATA_DIR_NAME)
            || overrides.data_dir.is_some()
            || !PACKAGED
            || result.data_dir.ends_with("ajzakomator")
    );
    result.data_dir
}

/// The update window of 1.1.x writes `update/work/heartbeat` every second while it supervises an install.
fn update_window_alive(update_dir: &std::path::Path) -> bool {
    let beat = update_dir.join("work").join("heartbeat");
    std::fs::metadata(beat).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() < 5)
}

/// Opens crash.log and installs the panic hook. Before [`mark_started`], a panic is a failed start.
pub fn install_crash_handling(log: Arc<RollingLog>) {
    let _ = CRASH.set(log);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A panic its caller catches and reports as a plain failure (a damaged Parquet file): not a crash.
        if unimux_core::panic_guard::panic_expected() {
            return;
        }
        // A panic inside an MCP request is caught by the MCP server, which logs the one cut `MCP request failed` line of
        // 1.1.4 (handle().catch, no dialog); the whole panic text could hold tool arguments.
        if unimux_mcp::in_request() {
            if cfg!(debug_assertions) {
                previous(info);
            }
            return;
        }
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let location = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let detail = describe_error(&format!("{message}{location} (thread {thread})"), 4000);
        if !STARTED.load(Ordering::SeqCst) {
            startup_failed(&detail, None);
        }
        if let Some(log) = CRASH.get() {
            log.error(&format!("panic: {detail}"));
        }
        if cfg!(debug_assertions) {
            previous(info);
        }
        runtime_error_dialog(&detail);
    }));
}

pub fn mark_started() {
    STARTED.store(true, Ordering::SeqCst);
}

/// At most 3 dialogs, 10 s apart (createDialogLimiter of 1.1.4); shown off the panicking thread.
fn runtime_error_dialog(detail: &str) {
    if QUIET.load(Ordering::SeqCst) || SHUTTING_DOWN.load(Ordering::SeqCst) {
        return;
    }
    let now = std::time::Instant::now();
    {
        let mut last = LAST_DIALOG.lock();
        if DIALOGS.load(Ordering::SeqCst) >= 3 || last.is_some_and(|l| now.duration_since(l).as_secs() < 10) {
            return;
        }
        *last = Some(now);
        DIALOGS.fetch_add(1, Ordering::SeqCst);
    }
    let text = format!("{}\n\n{detail}", translate(&os_language(), "Wystąpił nieoczekiwany błąd w głównym procesie", &[]));
    std::thread::spawn(move || unimux_platform::error_box("unimux", &text));
}

/// A line in crash.log (once it is open); the macOS update bookkeeping logs through it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn log_info(line: &str) {
    if let Some(log) = CRASH.get() {
        log.info(line);
    }
}

/// 1.1.4's `updatesActive()`: a packaged build, or a development feed (MC_UPDATE_FEED, dev-overrides builds only).
pub fn updates_active(overrides: &DevOverrides) -> bool {
    unimux_core::PACKAGED || overrides.update_feed.is_some()
}

/// macOS, at start before the update gate (1.1.4: `previousMacUpdate()` then `recordUpdateFailure` ahead of `runUpdateGate`):
/// how the previous update ended. A failure goes into `update-gate.json` right away, so the gate's cooldown applies to this
/// start; U1 reads `mac::outcome_at_start()` for the status bar text. Nothing happens unless updates are active.
#[cfg(target_os = "macos")]
pub fn previous_mac_update(data_dir: &std::path::Path, overrides: &DevOverrides) {
    let outcome = unimux_update::mac::previous_update_at_start(
        data_dir,
        unimux_core::VERSION,
        unimux_core::PACKAGED,
        updates_active(overrides),
        log_info,
    );
    if outcome != unimux_update::mac::MacPreviousOutcome::None {
        log_info(&format!("previous macOS update: {outcome:?}"));
    }
}

/// The start failed: say so (translated; the special text for a state.json another program holds) and end the process
/// instead of keeping the instance lock with no window.
pub fn startup_failed(detail: &str, unreadable_path: Option<&std::path::Path>) -> ! {
    if let Some(log) = CRASH.get() {
        log.error(&format!("startup failed: {detail}"));
    }
    let language = os_language();
    let text = match unreadable_path {
        Some(path) => translate(
            &language,
            "Nie można odczytać pliku {path}. Inny program (antywirus, OneDrive, kopia zapasowa) może go blokować. Zamknij go i uruchom unimux ponownie.",
            &[("path", &path.display().to_string())],
        ),
        None => translate(&language, "Nie udało się uruchomić unimux.", &[]),
    };
    if !QUIET.load(Ordering::SeqCst) {
        unimux_platform::error_box("unimux", &format!("{text}\n\n{detail}"));
    }
    std::process::exit(1);
}
