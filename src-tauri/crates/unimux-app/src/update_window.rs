//! `unimux-update.exe --update-window <config>`: the update window process (SP6; production polish in U2).
//!
//! The app copies its own exe to `%LOCALAPPDATA%\unimux-updater\runtime-<ver>\unimux-update.exe`, writes
//! `<data>/update/work/config.json` and starts the copy detached (unimux_update::window::hand_over), then exits. This mode:
//! - never touches the data dir's instance lock, state or crash.log (one lock of its own: `work/window.lock`);
//! - supervises the update from its first moment, independent of the window: the old app's exit, the NSIS installer
//!   `/S /UPDATE --updated /D=<installDir>` (ShellExecuteExW, `runas` for a folder this user cannot write, owned by the window),
//!   the start of the new `unimux.exe` once the files are in place, the 1.1.x file signals (`heartbeat`, `abort`,
//!   `installer-done`, `ready`) and the timeout. When WebView2 cannot start or the page never loads, the update still
//!   installs and the new app still starts; the window only shows the state;
//! - shows one frameless 440x200 window labelled `update-window` with its own WebView2 data folder, loading the unchanged
//!   `resources/update-splash` page (copied into the frontend by vite.config.tauri.ts) with the unchanged `window.updateSplash`
//!   contract (an initialization script maps it onto the three `update_splash_*` commands and the `update-splash:state` event).
//!   The window is never always-on-top and never takes the focus: shown inactive, the taskbar button flashes (PLAN.md U2);
//! - after the timeout card it keeps supervising the installer and still starts the new app (1.1.4's electron-updater ran the
//!   installer with `--force-run`, independent of the splash); closing that card while work is left only hides the window;
//! - on exit, starts `<installDir>\unimux.exe --update-cleanup <runtimeDir> <webviewDir>`, which removes the copy and the
//!   WebView2 folder a few seconds later (the copy cannot delete itself while it runs).
//!
//! Escape / X / Alt+F4 only hide the window while work is in flight and end it once done or failed (closeAction of 1.1.4).

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, UserAttentionType, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use unimux_core::crash_log::RollingLog;
use unimux_exec::Program;
use unimux_update::progress::{CloseAction, UpdateNote, UpdateProgressModel, UpdateSnapshot, UpdateStage, close_action};
use unimux_update::window::{
    UpdateSplashConfig, directory_bytes, is_runtime_dir, needs_elevation, remove_with_retries, remove_with_retries_guarded,
};

pub const LABEL: &str = "update-window";
const EVENT: &str = "update-splash:state";
const TICK: Duration = Duration::from_millis(250);
const SIZE_EVERY_MS: f64 = 1000.0;
const HEARTBEAT_EVERY_MS: f64 = 1000.0;
const FINISH_DELAY: Duration = Duration::from_millis(1100);
const HIDE_NOTE: Duration = Duration::from_millis(2200);
const CLEANUP_DELAY: Duration = Duration::from_secs(3);
/// How long the window keeps supervising behind the timeout card (HEARTBEAT_MAX_AGE_MS of updateRuntime.ts: past it even a
/// beating update window is no longer trusted).
const SUPERVISE_MAX_MS: f64 = 15.0 * 60.0 * 1000.0;
/// How long a starting window waits for `work/window.lock` (the cleanup of an earlier window holds it for one removal at most).
const LOCK_WAIT: Duration = Duration::from_secs(3);
/// How long `app.exit` may take before the process ends anyway.
const EXIT_WATCHDOG: Duration = Duration::from_secs(3);

/// `window.updateSplash` over Tauri (the Electron preload of src/updatesplash/preload.ts). Runs before the page's own script.
const BRIDGE: &str = r#"(() => {
  const internals = window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) => internals.invoke(cmd, args || {});
  const listeners = [];
  const handler = internals.transformCallback((event) => { for (const cb of listeners) cb(event.payload); });
  invoke('plugin:event|listen', { event: 'update-splash:state', target: { kind: 'Any' }, handler });
  Object.defineProperty(window, 'updateSplash', { value: Object.freeze({
    init: () => invoke('update_splash_init'),
    onState: (cb) => { listeners.push(cb); },
    close: () => { invoke('update_splash_close'); },
    open: () => { invoke('update_splash_open'); },
  }) });
})();"#;

/// `--update-window <config>` (also `--update-window=<config>`).
pub fn config_arg() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    for (i, arg) in args.iter().enumerate() {
        if arg == "--update-window" {
            return args.get(i + 1).map(PathBuf::from);
        }
        if let Some(path) = arg.strip_prefix("--update-window=") {
            return Some(PathBuf::from(path));
        }
    }
    None
}

/// `--update-cleanup [--wait=<pid>,<pid>] [--lock=<work/window.lock>] <dir>...`: the processes to outlive, the lock a newer
/// window holds, and the folders to remove after the window ended.
pub struct Cleanup {
    pub wait: Vec<u32>,
    pub lock: Option<PathBuf>,
    pub dirs: Vec<PathBuf>,
}

pub fn cleanup_arg() -> Option<Cleanup> {
    parse_cleanup(std::env::args().skip(1))
}

fn parse_cleanup(args: impl Iterator<Item = String>) -> Option<Cleanup> {
    let mut args = args.skip_while(|a| a != "--update-cleanup");
    args.next()?;
    let mut cleanup = Cleanup { wait: vec![], lock: None, dirs: vec![] };
    for arg in args {
        if let Some(list) = arg.strip_prefix("--wait=") {
            cleanup.wait.extend(list.split(',').filter_map(|p| p.trim().parse::<u32>().ok()));
        } else if let Some(lock) = arg.strip_prefix("--lock=") {
            cleanup.lock = Some(PathBuf::from(lock));
        } else {
            cleanup.dirs.push(PathBuf::from(arg));
        }
    }
    Some(cleanup)
}

/// Waits until the window process and its WebView2 browser process are gone (at most 30 s; a WebView2 under load can take
/// many seconds to end after its host), then removes the runtime copy and the WebView2 folder. Only `runtime-*`, `webview2`
/// and `webview2-*` inside a `unimux-updater` folder are ever removed (cleanup_allowed). The WebView2 folder is the ended
/// window's own; the runtime copy may already serve a newer window of the same version, so it is removed only while
/// `work/window.lock` is free (taken for each attempt, so a window starting meanwhile waits a moment, never fails).
pub fn run_cleanup(cleanup: &Cleanup) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(30);
    if cleanup.wait.is_empty() {
        std::thread::sleep(CLEANUP_DELAY);
    }
    while Instant::now() < deadline && cleanup.wait.iter().any(|pid| unimux_exec::process_alive(*pid)) {
        std::thread::sleep(Duration::from_millis(100));
    }
    // The browser's child processes (renderer, utility) end right after it.
    std::thread::sleep(Duration::from_millis(500));
    for dir in &cleanup.dirs {
        match &cleanup.lock {
            Some(lock) if is_runtime_dir(dir) => {
                remove_with_retries_guarded(dir, 20, Duration::from_millis(500), || take_lock(lock));
            }
            _ => {
                remove_with_retries(dir, 20, Duration::from_millis(500));
            }
        }
    }
    0
}

/// The NSIS installer the window started, waited on for its exit code.
mod installer {
    use std::path::Path;

    #[cfg(windows)]
    pub struct Running {
        handle: windows::Win32::Foundation::HANDLE,
        pub pid: u32,
    }

    // SAFETY: a process handle may be waited on and closed from any thread.
    #[cfg(windows)]
    unsafe impl Send for Running {}

    #[cfg(windows)]
    impl Running {
        /// The exit code once the installer ended.
        pub fn try_wait(&mut self) -> Option<i64> {
            use windows::Win32::Foundation::WAIT_OBJECT_0;
            use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
            // SAFETY: the handle is ours until Drop.
            unsafe {
                if WaitForSingleObject(self.handle, 0) != WAIT_OBJECT_0 {
                    return None;
                }
                let mut code = 0u32;
                Some(if GetExitCodeProcess(self.handle, &mut code).is_ok() { i64::from(code) } else { -1 })
            }
        }
    }

    #[cfg(windows)]
    impl Drop for Running {
        fn drop(&mut self) {
            // SAFETY: closes our own handle once; the installer keeps running.
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }

    /// ShellExecuteExW as PLAN.md U2 requires: `runas` when `elevate` (the UAC prompt), the update window as the owner (so the
    /// prompt belongs to it), AllowSetForegroundWindow(ASFW_ANY) first (so the consent and the installer may come to the
    /// front instead of blinking in the taskbar). Nothing else of the update ever takes the foreground.
    #[cfg(windows)]
    pub fn start(program: &Path, args: &str, dir: &Path, owner: Option<isize>, elevate: bool) -> Result<Running, String> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx};
        use windows::Win32::System::Threading::GetProcessId;
        use windows::Win32::UI::Shell::{
            SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
        };
        use windows::Win32::UI::WindowsAndMessaging::{ASFW_ANY, AllowSetForegroundWindow, SW_SHOWNORMAL};
        use windows::core::{HSTRING, PCWSTR, w};

        let file = HSTRING::from(program);
        let params = HSTRING::from(args);
        let directory = HSTRING::from(dir);
        // SAFETY: every pointer in the struct outlives the call; the returned process handle is owned by Running.
        unsafe {
            // ShellExecuteEx may hand the start to shell extensions, which want COM on the calling thread (S_FALSE: already up).
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            let _ = AllowSetForegroundWindow(ASFW_ANY);
            let mut info = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                hwnd: HWND(owner.unwrap_or(0) as *mut core::ffi::c_void),
                lpVerb: if elevate { w!("runas") } else { w!("open") },
                lpFile: PCWSTR(file.as_ptr()),
                lpParameters: PCWSTR(params.as_ptr()),
                lpDirectory: PCWSTR(directory.as_ptr()),
                nShow: SW_SHOWNORMAL.0,
                ..Default::default()
            };
            ShellExecuteExW(&mut info).map_err(|e| e.message())?;
            if info.hProcess.is_invalid() {
                return Err("no process handle".into());
            }
            Ok(Running { pid: GetProcessId(info.hProcess), handle: info.hProcess })
        }
    }

    #[cfg(not(windows))]
    pub struct Running {
        child: std::process::Child,
        pub pid: u32,
    }

    #[cfg(not(windows))]
    impl Running {
        pub fn try_wait(&mut self) -> Option<i64> {
            match self.child.try_wait() {
                Ok(Some(status)) => Some(status.code().map_or(-1, i64::from)),
                _ => None,
            }
        }
    }

    /// macOS installs through U5 (bundle swap); this only keeps the window mode building there.
    #[cfg(not(windows))]
    pub fn start(program: &Path, args: &str, dir: &Path, _owner: Option<isize>, _elevate: bool) -> Result<Running, String> {
        let program = unimux_exec::Program::Raw { program: program.to_path_buf(), raw: args.to_string() };
        let child = unimux_exec::spawn_detached_child(&program, None, Some(dir.to_path_buf())).map_err(|e| e.to_string())?;
        Ok(Running { pid: child.id(), child })
    }
}

struct Ui {
    stage: UpdateStage,
    percent: f64,
    hiding: bool,
    /// The last state pushed (handed to the page in `init`, so a page that loads late starts where the update is).
    last: Option<Value>,
}

pub struct UpdateWindow {
    config: UpdateSplashConfig,
    log: RollingLog,
    ui: Mutex<Ui>,
    finished: AtomicBool,
    exiting: AtomicBool,
    /// The page finished loading and the window was shown (and `work/shown` written).
    shown: AtomicBool,
    /// The loop still has work: true until done, a failure, or nothing is left to wait for behind the timeout card.
    supervising: AtomicBool,
    /// The user closed the error card (or opened the app from it) while work was left: the window is hidden and the process
    /// ends once the supervision does.
    lingering: AtomicBool,
    /// The app started by hand from the error card ("Open unimux"); 0: none.
    opened_pid: AtomicU32,
    app: OnceLock<AppHandle>,
    offscreen: bool,
    /// When this process entered `run` (the start-up timings in updater.log are relative to it).
    born: Instant,
    /// The window's WebView2 browser process (the cleanup waits for it before removing the WebView2 folder).
    browser_pid: AtomicU32,
}

impl UpdateWindow {
    fn push(&self, stage: UpdateStage, percent: f64, message: &str, extra: &[(&str, Value)]) {
        let mut state = Map::new();
        state.insert("stage".into(), json!(stage.as_str()));
        state.insert("percent".into(), json!(percent));
        state.insert("message".into(), json!(message));
        for (key, value) in extra {
            state.insert((*key).into(), value.clone());
        }
        let state = Value::Object(state);
        self.ui.lock().last = Some(state.clone());
        if let Some(app) = self.app.get() {
            let _ = app.emit(EVENT, state);
        }
    }

    fn window(&self) -> Option<tauri::WebviewWindow> {
        self.app.get().and_then(|a| a.get_webview_window(LABEL))
    }

    /// Shown without taking the focus, the taskbar button flashes (`showInactive()` + `flashFrame(true)` of 1.1.4): a game or a
    /// full-screen app the user is in stays in front and is not minimized.
    fn show_inactive(&self) {
        if let Some(w) = self.window() {
            show_without_focus(&w);
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
    }

    fn drop_heartbeat(&self) {
        let _ = std::fs::remove_file(&self.config.heartbeat_flag);
    }

    /// X, Escape and Alt+F4: while work is in flight only a note and then hide (the installer runs on its own); once done or
    /// failed, exit, except behind the timeout card while the installer or the new app's start is still to come: then hide.
    pub fn request_close(self: &Arc<Self>) {
        let (stage, percent) = {
            let ui = self.ui.lock();
            (ui.stage, ui.percent)
        };
        if close_action(stage) == CloseAction::Exit {
            if stage == UpdateStage::Error && !self.finished.load(Ordering::SeqCst) {
                self.linger();
            } else {
                self.cleanup_and_exit();
            }
            return;
        }
        {
            let mut ui = self.ui.lock();
            if ui.hiding {
                return;
            }
            ui.hiding = true;
        }
        self.push(stage, percent, &self.config.strings.background, &[("closable", json!(false))]);
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(HIDE_NOTE);
            let hide = {
                let mut ui = me.ui.lock();
                let hide = ui.hiding && !me.finished.load(Ordering::SeqCst) && ui.stage != UpdateStage::Error;
                ui.hiding = false;
                hide
            };
            // Outside the lock: the window call goes through the main thread, which may be waiting for it.
            if hide && let Some(w) = me.window() {
                hide_window(&w);
                me.log.info("window hidden; the update goes on");
            }
        });
    }

    /// The error card was closed: hide and stay while the loop still supervises, else end now.
    fn linger(&self) {
        if !self.lingering.swap(true, Ordering::SeqCst)
            && let Some(w) = self.window()
        {
            hide_window(&w);
        }
        // The loop ends with cleanup_and_exit when it sees `lingering`; if it already stopped, end here.
        if self.supervising.load(Ordering::SeqCst) {
            self.log.info("error card closed: the update is still supervised in the background");
        } else {
            self.cleanup_and_exit();
        }
    }

    fn cleanup_and_exit(&self) {
        if self.exiting.swap(true, Ordering::SeqCst) {
            return;
        }
        self.drop_heartbeat();
        let mut dirs = vec![self.config.runtime_dir.clone()];
        dirs.push(self.config.webview_dir());
        let mut args: Vec<std::ffi::OsString> = vec!["--update-cleanup".into()];
        let mut wait = vec![std::process::id()];
        let browser = self.browser_pid.load(Ordering::SeqCst);
        if browser != 0 {
            wait.push(browser);
        }
        args.push(format!("--wait={}", wait.iter().map(u32::to_string).collect::<Vec<_>>().join(",")).into());
        let mut lock = std::ffi::OsString::from("--lock=");
        lock.push(self.config.work_dir.join("window.lock"));
        args.push(lock);
        args.extend(dirs.into_iter().map(Into::into));
        // From the installed exe (the copy cannot delete itself), started outside the copy (a working directory inside it
        // would keep the folder locked).
        let program = Program::Args { program: self.config.app_exe.clone(), args };
        match unimux_exec::spawn_detached(&program, None, Some(std::env::temp_dir())) {
            Ok(pid) => self.log.info(&format!("cleanup started (pid {pid})")),
            Err(e) => self.log.warn(&format!("cleanup not started: {e}")),
        }
        self.log.info("update window exits");
        match self.app.get() {
            Some(app) => {
                // The event loop may be stuck in a WebView2 start that never completes (a broken WebView2 can take a
                // minute to fail): the cleanup waits for this pid, so do not let it outlive the update.
                std::thread::spawn(|| {
                    std::thread::sleep(EXIT_WATCHDOG);
                    std::process::exit(0);
                });
                app.exit(0);
            }
            None => std::process::exit(0),
        }
    }

    fn launch_app(&self) -> Option<u32> {
        let program = Program::Args { program: self.config.app_exe.clone(), args: vec![] };
        match unimux_exec::spawn_detached(&program, None, Some(self.config.install_dir.clone())) {
            Ok(pid) => {
                self.log.info(&format!("started {} (pid {pid})", self.config.app_exe.display()));
                Some(pid)
            }
            Err(e) => {
                self.log.error(&format!("could not start {}: {e}", self.config.app_exe.display()));
                None
            }
        }
    }

    fn start_installer(&self) -> Result<installer::Running, String> {
        let program = self.config.installer.clone().ok_or_else(|| "no installer".to_string())?;
        let args = self.config.installer_args.clone().unwrap_or_default();
        let elevate = needs_elevation(&self.config.install_dir);
        let owner = self.window().and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
        // Outside the install dir and outside the copy, like the cleanup.
        match installer::start(&program, &args, &std::env::temp_dir(), owner, elevate) {
            Ok(run) => {
                self.log.info(&format!(
                    "installer {} {args} started (pid {}, {}, owner window {})",
                    program.display(),
                    run.pid,
                    if elevate { "runas" } else { "as this user" },
                    if owner.is_some() { "yes" } else { "none" }
                ));
                Ok(run)
            }
            Err(e) => Err(format!("installer {} did not start: {e}", program.display())),
        }
    }

    /// The 250 ms loop of updatesplash/index.ts run(), started with the process (not when the page has loaded).
    fn supervise(self: Arc<Self>) {
        let config = &self.config;
        let strings = &config.strings;
        let started = Instant::now();
        let baseline = directory_bytes(&config.install_dir) as f64;
        let mut model = UpdateProgressModel::new(baseline);
        let mut dir_bytes = None;
        let mut last_sample = f64::NEG_INFINITY;
        let mut last_beat = f64::NEG_INFINITY;
        let mut installer: Option<installer::Running> = None;
        let mut installer_started = false;
        let mut failure: Option<String> = None;
        let mut failure_shown = false;
        let mut error_at: Option<f64> = None;
        let mut launched = false;
        let mut logged = (false, false, false);
        self.log.info(&format!(
            "update window {} -> {} (old pid {}, install dir {}, baseline {} bytes)",
            config.from_version,
            config.version,
            config.old_pid,
            config.install_dir.display(),
            baseline
        ));
        loop {
            std::thread::sleep(TICK);
            if self.finished.load(Ordering::SeqCst) || self.exiting.load(Ordering::SeqCst) {
                return;
            }
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            let closed = !unimux_exec::process_alive(config.old_pid);
            if closed && !logged.0 {
                logged.0 = true;
                self.log.info(&format!("old app exited after {elapsed:.0} ms"));
            }
            if closed && elapsed - last_sample >= SIZE_EVERY_MS {
                last_sample = elapsed;
                dir_bytes = Some(directory_bytes(&config.install_dir) as f64);
            }
            // The heartbeat ends with the error card, as in 1.1.4.
            if error_at.is_none() && elapsed - last_beat >= HEARTBEAT_EVERY_MS {
                last_beat = elapsed;
                let _ = std::fs::write(&config.heartbeat_flag, unimux_core::time::now_ms().to_string());
            }
            if config.abort_flag.exists() {
                self.log.info("abort flag: the app kept running");
                self.finished.store(true, Ordering::SeqCst);
                self.cleanup_and_exit();
                return;
            }
            // The installer only starts once the old app is gone: it replaces the exe the old app runs from.
            if closed && !installer_started && config.installer.is_some() && failure.is_none() {
                installer_started = true;
                match self.start_installer() {
                    Ok(run) => installer = Some(run),
                    Err(reason) => failure = Some(reason),
                }
            }
            if let Some(run) = installer.as_mut()
                && let Some(code) = run.try_wait()
            {
                installer = None;
                self.log.info(&format!("installer exited with Some({code}) after {elapsed:.0} ms"));
                if code == 0 {
                    // The unimux NSIS hook (U3) writes it; without the hook the exit code is the signal.
                    if !config.installed_flag.exists() {
                        let _ = std::fs::write(&config.installed_flag, &config.version);
                    }
                } else {
                    failure = Some(format!("installer exit code {code}"));
                }
            }
            let installed = config.installed_flag.exists();
            if installed && !logged.1 {
                logged.1 = true;
                self.log.info(&format!("files in place after {elapsed:.0} ms"));
            }
            // The new app, once; an app the user already started from the error card counts while it runs.
            if installed && !launched && config.installer.is_some() && failure.is_none() {
                launched = true;
                let opened = self.opened_pid.load(Ordering::SeqCst);
                if (opened == 0 || !unimux_exec::process_alive(opened)) && self.launch_app().is_none() {
                    failure = Some("new app did not start".into());
                }
            }
            let ready = config.ready_flag.exists();
            if ready && !logged.2 {
                logged.2 = true;
                self.log.info(&format!("new app ready after {elapsed:.0} ms"));
            }
            let progress = model.update(UpdateSnapshot {
                elapsed_ms: elapsed,
                closed,
                installed,
                ready,
                dir_bytes: dir_bytes.filter(|_| closed),
            });
            if error_at.is_none() {
                let mut ui = self.ui.lock();
                ui.stage = progress.stage;
                ui.percent = progress.percent;
            }
            if progress.stage == UpdateStage::Done || (error_at.is_some() && ready && failure.is_none()) {
                self.finished.store(true, Ordering::SeqCst);
                self.ui.lock().stage = UpdateStage::Done;
                self.push(UpdateStage::Done, 100.0, &strings.done, &[]);
                std::thread::sleep(FINISH_DELAY);
                self.cleanup_and_exit();
                return;
            }
            // The error card: a failed install (its own text) or the timeout (`slow`; the supervision goes on behind it).
            let timed_out = elapsed > config.timeout_ms as f64;
            if (failure.is_some() && !failure_shown) || (timed_out && error_at.is_none()) {
                let first = error_at.is_none();
                if first {
                    error_at = Some(elapsed);
                    self.drop_heartbeat();
                    let mut ui = self.ui.lock();
                    ui.stage = UpdateStage::Error;
                    ui.hiding = false;
                }
                let message = match &failure {
                    Some(reason) => {
                        failure_shown = true;
                        self.log.error(reason);
                        strings.failed_text()
                    }
                    None => {
                        self.log.error(&format!("timed out after {elapsed:.0} ms; the installer is still supervised"));
                        strings.slow.as_str()
                    }
                };
                let percent = self.ui.lock().percent;
                self.push(UpdateStage::Error, percent, message, &[("detail", json!(strings.slow_hint))]);
                // A page that has not loaded yet is shown by on_shown (with this state from init).
                if first && !self.lingering.load(Ordering::SeqCst) && self.shown.load(Ordering::SeqCst) {
                    self.show_inactive();
                }
            }
            if error_at.is_some() {
                // Left behind the timeout card: the old app's exit, the installer and the new app's start (then its `ready`
                // turns the visible card into done). Nothing after a failure.
                let lingering = self.lingering.load(Ordering::SeqCst);
                let pending = failure.is_none() && config.installer.is_some() && (!launched || !lingering);
                if !pending || elapsed > SUPERVISE_MAX_MS {
                    self.supervising.store(false, Ordering::SeqCst);
                    self.log.info(&format!("supervision ended after {elapsed:.0} ms"));
                    // Nobody can see or close a hidden or never shown window.
                    if self.lingering.load(Ordering::SeqCst) || !self.shown.load(Ordering::SeqCst) {
                        self.cleanup_and_exit();
                    }
                    return;
                }
                continue;
            }
            if self.ui.lock().hiding {
                continue;
            }
            let message = match progress.note {
                Some(UpdateNote::WaitingClose) => &strings.waiting_close,
                Some(UpdateNote::WaitingInstaller) => &strings.waiting_installer,
                Some(UpdateNote::InstallingLong) => &strings.installing_long,
                None => match progress.stage {
                    UpdateStage::Preparing => &strings.stages.preparing,
                    UpdateStage::Closing => &strings.stages.closing,
                    UpdateStage::Installing => &strings.stages.installing,
                    UpdateStage::Launching => &strings.stages.launching,
                    _ => &strings.done,
                },
            };
            self.push(progress.stage, progress.percent, message, &[]);
        }
    }

    fn on_shown(&self) {
        if self.shown.swap(true, Ordering::SeqCst) {
            return;
        }
        // A card the user already closed stays hidden.
        if !self.lingering.load(Ordering::SeqCst) {
            self.show_inactive();
        }
        let _ = std::fs::write(&self.config.shown_flag, unimux_core::time::now_ms().to_string());
        self.log.info(&format!("window shown +{} ms", self.born.elapsed().as_millis()));
    }
}

#[cfg(windows)]
fn show_without_focus(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWNOACTIVATE, ShowWindow};
    if let Ok(hwnd) = window.hwnd() {
        // SAFETY: the window's own handle; SW_SHOWNOACTIVATE never activates it.
        unsafe {
            let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd.0), SW_SHOWNOACTIVATE);
        }
    }
}

#[cfg(not(windows))]
fn show_without_focus(window: &tauri::WebviewWindow) {
    let _ = window.show();
}

/// The counterpart of show_without_focus: tao does not know about the SW_SHOWNOACTIVATE above (its visible flag stays
/// false), so its own hide() would see no change and do nothing.
#[cfg(windows)]
fn hide_window(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};
    if let Ok(hwnd) = window.hwnd() {
        // SAFETY: the window's own handle.
        unsafe {
            let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd.0), SW_HIDE);
        }
    }
}

#[cfg(not(windows))]
fn hide_window(window: &tauri::WebviewWindow) {
    let _ = window.hide();
}

impl UpdateWindow {
    /// `update-splash:init` (the commands live in ipc.rs, shared with the startup gate window of U1).
    pub fn init_info(&self) -> Value {
        let c = &self.config;
        json!({
            "title": c.strings.title,
            "hint": c.strings.hint,
            "fromVersion": c.from_version,
            "version": c.version,
            "open": c.strings.open,
            "close": c.strings.close,
            "state": self.ui.lock().last.clone(),
        })
    }

    /// `update-splash:open`: start unimux by hand (offered at the error stage) and end (or, while the installer may still
    /// run, hide and let the loop finish).
    pub fn open_app(&self) {
        self.drop_heartbeat();
        if let Some(pid) = self.launch_app() {
            self.opened_pid.store(pid, Ordering::SeqCst);
        }
        if self.finished.load(Ordering::SeqCst) {
            self.cleanup_and_exit();
        } else {
            self.linger();
        }
    }
}

/// Navigation stays on the splash page.
fn allow_navigation(url: &tauri::Url) -> bool {
    let origin = unimux_ipc::guard::origin_of(url.as_str());
    crate::context::app_origins().iter().any(|o| o.eq_ignore_ascii_case(origin))
}

/// The browser arguments of the window's own WebView2 (its data folder is not shared, so they may differ from the app's):
/// software rendering like 1.1.4's `disableHardwareAcceleration()`.
fn browser_args() -> String {
    let args = String::from("--disable-gpu --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    #[cfg(dev_overrides)]
    if let Some(port) = std::env::var("MC_UPDATE_DEBUG_PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
        return format!("{args} --remote-debugging-port={port}");
    }
    args
}

/// MC_OFFSCREEN (dev-overrides) moves the window off screen; `MC_UPDATE_VISIBLE=1` keeps it on screen in a harness run that
/// checks the production show path (the new app the window starts still inherits MC_OFFSCREEN).
fn offscreen() -> bool {
    cfg!(dev_overrides)
        && unimux_core::dev_overrides::DevOverrides::from_env().offscreen
        && !std::env::var("MC_UPDATE_VISIBLE").is_ok_and(|v| v == "1")
}

fn create_window(app: &AppHandle, win: &Arc<UpdateWindow>) -> tauri::Result<()> {
    let page = win.clone();
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("update-splash/index.html".into()))
        .title("unimux")
        .inner_size(440.0, 200.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(true)
        .decorations(false)
        // A normal window that others may cover (PLAN.md U2); shown inactive in on_shown.
        .always_on_top(false)
        .focused(false)
        .visible(false)
        .background_color(tauri::window::Color(0x0d, 0x0d, 0x0d, 0xff))
        .initialization_script(BRIDGE)
        .on_navigation(allow_navigation)
        .on_page_load(move |_w, payload| {
            if payload.event() == PageLoadEvent::Finished {
                page.on_shown();
            }
        })
        .devtools(cfg!(dev_overrides))
        .zoom_hotkeys_enabled(false)
        .browser_extensions_enabled(false);
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(&browser_args()).data_directory(win.config.webview_dir());
    }
    #[cfg(not(windows))]
    let _ = browser_args();
    if win.offscreen {
        builder = builder.position(-6000.0, 0.0).skip_taskbar(true).focusable(false);
    } else {
        builder = builder.center();
    }
    let window = builder.build()?;
    win.log.info(&format!("window created +{} ms", win.born.elapsed().as_millis()));
    #[cfg(windows)]
    {
        let me = win.clone();
        let _ = window.with_webview(move |webview| {
            // SAFETY: a COM getter on the live controller, on the thread Tauri runs this closure on.
            unsafe {
                if let Ok(core) = webview.controller().CoreWebView2() {
                    let mut pid = 0u32;
                    if core.BrowserProcessId(&mut pid).is_ok() {
                        me.browser_pid.store(pid, Ordering::SeqCst);
                        me.log.info(&format!("WebView2 browser process {pid}"));
                    }
                }
            }
        });
    }
    let events = win.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            let stage = events.ui.lock().stage;
            // Alt+F4 behind the timeout card hides like Escape and X (request_close decides).
            let hide = close_action(stage) == CloseAction::Hide || stage == UpdateStage::Error;
            if !events.finished.load(Ordering::SeqCst) && hide {
                api.prevent_close();
                events.request_close();
            }
        }
        WindowEvent::Destroyed => events.cleanup_and_exit(),
        _ => {}
    });
    Ok(())
}

fn take_lock(path: &Path) -> Option<File> {
    let file = File::options().create(true).truncate(false).write(true).open(path).ok()?;
    file.try_lock().ok()?;
    Some(file)
}

/// Takes `work/window.lock` (one update window per data dir); None when another window holds it. Waits a moment: the cleanup
/// of an earlier window takes it for each removal attempt of the shared runtime copy.
fn lock(work_dir: &Path) -> Option<File> {
    std::fs::create_dir_all(work_dir).ok()?;
    let path = work_dir.join("window.lock");
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        if let Some(file) = take_lock(&path) {
            return Some(file);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The whole update window process. Returns the exit code.
pub fn run(config_path: &Path, context: tauri::Context<tauri::Wry>) -> i32 {
    let born = Instant::now();
    let config = match UpdateSplashConfig::read(config_path) {
        Ok(c) => c,
        Err(_) => return 2,
    };
    let log = RollingLog::new(config.log_path(), None);
    log.info(&format!("update window process {} started", std::process::id()));
    let Some(_lock) = lock(&config.work_dir) else {
        log.info("another update window runs; exiting");
        return 0;
    };
    unimux_platform::set_app_user_model_id(if unimux_core::PACKAGED { "com.unimux.app" } else { "com.unimux.app.dev" });
    let win = Arc::new(UpdateWindow {
        config,
        log,
        ui: Mutex::new(Ui { stage: UpdateStage::Preparing, percent: 0.0, hiding: false, last: None }),
        finished: AtomicBool::new(false),
        exiting: AtomicBool::new(false),
        shown: AtomicBool::new(false),
        supervising: AtomicBool::new(true),
        lingering: AtomicBool::new(false),
        opened_pid: AtomicU32::new(0),
        app: OnceLock::new(),
        offscreen: offscreen(),
        born,
        browser_pid: AtomicU32::new(0),
    });
    // The supervision first: the update must not depend on WebView2 starting or the page loading.
    let supervisor = {
        let me = win.clone();
        std::thread::Builder::new().name("update-window".into()).spawn(move || me.supervise())
    };
    let supervisor = match supervisor {
        Ok(handle) => handle,
        Err(e) => {
            win.log.error(&format!("update supervision could not start: {e}"));
            return 1;
        }
    };
    let setup = win.clone();
    let app = tauri::Builder::default()
        .manage(win.clone())
        .invoke_handler(tauri::generate_handler![
            crate::ipc::update_splash_init,
            crate::ipc::update_splash_close,
            crate::ipc::update_splash_open
        ])
        .setup(move |app| {
            let _ = setup.app.set(app.handle().clone());
            if let Err(e) = create_window(app.handle(), &setup) {
                setup.log.error(&format!("update window could not be created ({e}); the update goes on without it"));
            }
            Ok(())
        })
        .build(context);
    match app {
        Ok(app) => {
            let exit = win.clone();
            app.run(move |_app, event| {
                if let RunEvent::ExitRequested { code: None, .. } = event {
                    // The last window went away without cleanup_and_exit (window-all-closed of 1.1.4).
                    exit.cleanup_and_exit();
                }
            });
        }
        Err(e) => {
            win.log.error(&format!("update window runtime could not start ({e}); the update goes on without a window"));
            let _ = supervisor.join();
            win.cleanup_and_exit();
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> impl Iterator<Item = String> {
        list.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn cleanup_arguments_carry_the_pids_the_lock_and_the_folders() {
        let c = parse_cleanup(args(&[
            "--update-cleanup",
            "--wait=12,34",
            "--lock=D:\\data\\update\\work\\window.lock",
            "C:\\u\\unimux-updater\\runtime-1.2.1",
            "D:\\w",
        ]))
        .unwrap();
        assert_eq!(c.wait, [12, 34]);
        assert_eq!(c.lock, Some(PathBuf::from("D:\\data\\update\\work\\window.lock")));
        assert_eq!(c.dirs, [PathBuf::from("C:\\u\\unimux-updater\\runtime-1.2.1"), PathBuf::from("D:\\w")]);
        let none = parse_cleanup(args(&["--update-cleanup"])).unwrap();
        assert!(none.wait.is_empty() && none.dirs.is_empty() && none.lock.is_none());
        assert!(parse_cleanup(args(&["--update-window", "x"])).is_none());
    }

    #[test]
    fn the_cleanup_leaves_a_runtime_copy_a_newer_window_holds_the_lock_for() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        let root = tmp.path().join("unimux-updater");
        let runtime = root.join("runtime-1.2.1");
        let webview = root.join("webview2-1");
        for dir in [&runtime, &webview] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let held = lock(&work).unwrap();
        let cleanup = Cleanup {
            wait: vec![u32::MAX - 1],
            lock: Some(work.join("window.lock")),
            dirs: vec![runtime.clone(), webview.clone()],
        };
        run_cleanup(&cleanup);
        assert!(runtime.exists(), "a window holds the lock: its copy stays");
        assert!(!webview.exists(), "the ended window's own WebView2 folder goes");
        drop(held);
        run_cleanup(&cleanup);
        assert!(!runtime.exists());
    }

    #[test]
    fn the_bridge_defines_the_1_1_4_contract() {
        for name in ["init:", "onState:", "close:", "open:", "update_splash_init", "update_splash_close", "update_splash_open"] {
            assert!(BRIDGE.contains(name), "{name}");
        }
        assert!(BRIDGE.contains(EVENT));
    }
}
