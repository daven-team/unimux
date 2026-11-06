//! `unimux-update.exe --update-window <config>`: the update window process (SP6; production polish in U2).
//!
//! The app copies its own exe to `%LOCALAPPDATA%\unimux-updater\runtime-<ver>\unimux-update.exe`, writes
//! `<data>/update/work/config.json` and starts the copy detached (unimux_update::window::hand_over), then exits. This mode:
//! - never touches the data dir's instance lock, state or crash.log (one lock of its own: `work/window.lock`);
//! - shows one frameless 440x200 window labelled `update-window` with its own WebView2 data folder, loading the unchanged
//!   `resources/update-splash` page (copied into the frontend by vite.config.tauri.ts) with the unchanged `window.updateSplash`
//!   contract (an initialization script maps it onto the three `update_splash_*` commands and the `update-splash:state` event);
//! - drives the stages from the 1.1.x file signals (`heartbeat`, `abort`, `installer-done`, `ready`) and the old app's pid;
//! - runs the NSIS installer `/S /UPDATE --updated /D=<installDir>` once the old app has exited, starts the new `unimux.exe`
//!   once the files are in place and closes when the new app writes `update/ready`;
//! - on exit, starts `<installDir>\unimux.exe --update-cleanup <runtimeDir> <webviewDir>`, which removes the copy and the
//!   WebView2 folder a few seconds later (the copy cannot delete itself while it runs).
//!
//! Escape / X / Alt+F4 only hide the window while work is in flight and end it once done or failed (closeAction of 1.1.4).

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use unimux_core::crash_log::RollingLog;
use unimux_exec::Program;
use unimux_update::progress::{CloseAction, UpdateNote, UpdateProgressModel, UpdateSnapshot, UpdateStage, close_action};
use unimux_update::window::{UpdateSplashConfig, directory_bytes, remove_with_retries};

pub const LABEL: &str = "update-window";
const EVENT: &str = "update-splash:state";
const TICK: Duration = Duration::from_millis(250);
const SIZE_EVERY_MS: f64 = 1000.0;
const HEARTBEAT_EVERY_MS: f64 = 1000.0;
const FINISH_DELAY: Duration = Duration::from_millis(1100);
const HIDE_NOTE: Duration = Duration::from_millis(2200);
const CLEANUP_DELAY: Duration = Duration::from_secs(3);

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

/// `--update-cleanup [--wait=<pid>,<pid>] <dir>...`: the processes to outlive and the folders to remove after the window ended.
pub struct Cleanup {
    pub wait: Vec<u32>,
    pub dirs: Vec<PathBuf>,
}

pub fn cleanup_arg() -> Option<Cleanup> {
    parse_cleanup(std::env::args().skip(1))
}

fn parse_cleanup(args: impl Iterator<Item = String>) -> Option<Cleanup> {
    let mut args = args.skip_while(|a| a != "--update-cleanup");
    args.next()?;
    let mut cleanup = Cleanup { wait: vec![], dirs: vec![] };
    for arg in args {
        match arg.strip_prefix("--wait=") {
            Some(list) => cleanup.wait.extend(list.split(',').filter_map(|p| p.trim().parse::<u32>().ok())),
            None => cleanup.dirs.push(PathBuf::from(arg)),
        }
    }
    Some(cleanup)
}

/// Waits until the window process and its WebView2 browser process are gone (at most 30 s; a WebView2 under load can take
/// many seconds to end after its host), then removes the runtime copy and the WebView2 folder. Only `runtime-*` and `webview2`
/// inside a `unimux-updater` folder are ever removed (cleanup_allowed).
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
        remove_with_retries(dir, 20, Duration::from_millis(500));
    }
    0
}

struct Ui {
    stage: UpdateStage,
    percent: f64,
    hiding: bool,
}

pub struct UpdateWindow {
    config: UpdateSplashConfig,
    log: RollingLog,
    ui: Mutex<Ui>,
    finished: AtomicBool,
    exiting: AtomicBool,
    ticking: AtomicBool,
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
        if let Some(app) = self.app.get() {
            let _ = app.emit(EVENT, Value::Object(state));
        }
    }

    fn window(&self) -> Option<tauri::WebviewWindow> {
        self.app.get().and_then(|a| a.get_webview_window(LABEL))
    }

    fn drop_heartbeat(&self) {
        let _ = std::fs::remove_file(&self.config.heartbeat_flag);
    }

    /// X, Escape and Alt+F4: while work is in flight only a note and then hide (the installer runs on its own); once done or
    /// failed, exit.
    pub fn request_close(self: &Arc<Self>) {
        let (stage, percent) = {
            let ui = self.ui.lock();
            (ui.stage, ui.percent)
        };
        if close_action(stage) == CloseAction::Exit {
            self.cleanup_and_exit();
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
                let _ = w.hide();
            }
        });
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
            Some(app) => app.exit(0),
            None => std::process::exit(0),
        }
    }

    fn launch_app(&self) -> bool {
        let program = Program::Args { program: self.config.app_exe.clone(), args: vec![] };
        match unimux_exec::spawn_detached(&program, None, Some(self.config.install_dir.clone())) {
            Ok(pid) => {
                self.log.info(&format!("started {} (pid {pid})", self.config.app_exe.display()));
                true
            }
            Err(e) => {
                self.log.error(&format!("could not start {}: {e}", self.config.app_exe.display()));
                false
            }
        }
    }

    fn start_installer(&self) -> Option<Child> {
        let installer = self.config.installer.clone()?;
        let raw = self.config.installer_args.clone().unwrap_or_default();
        let program = Program::Raw { program: installer.clone(), raw: raw.clone() };
        // Outside the install dir and outside the copy, like the cleanup.
        match unimux_exec::spawn_detached_child(&program, None, Some(std::env::temp_dir())) {
            Ok(child) => {
                self.log.info(&format!("installer {} {raw} started (pid {})", installer.display(), child.id()));
                Some(child)
            }
            Err(e) => {
                self.log.error(&format!("installer {} did not start: {e}", installer.display()));
                None
            }
        }
    }

    /// The 250 ms loop of updatesplash/index.ts run().
    fn run(self: Arc<Self>) {
        let config = &self.config;
        let strings = &config.strings;
        let started = Instant::now();
        let baseline = directory_bytes(&config.install_dir) as f64;
        let mut model = UpdateProgressModel::new(baseline);
        let mut dir_bytes = None;
        let mut last_sample = f64::NEG_INFINITY;
        let mut last_beat = f64::NEG_INFINITY;
        let mut installer: Option<Child> = None;
        let mut installer_started = false;
        let mut installer_failed: Option<String> = None;
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
            if elapsed - last_beat >= HEARTBEAT_EVERY_MS {
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
            if closed && !installer_started && config.installer.is_some() {
                installer_started = true;
                installer = self.start_installer();
                if installer.is_none() {
                    installer_failed = Some("installer did not start".into());
                }
            }
            if let Some(child) = installer.as_mut()
                && let Ok(Some(status)) = child.try_wait()
            {
                installer = None;
                self.log.info(&format!("installer exited with {:?} after {elapsed:.0} ms", status.code()));
                if status.success() {
                    // The unimux NSIS hook (U3) writes it; without the hook the exit code is the signal.
                    if !config.installed_flag.exists() {
                        let _ = std::fs::write(&config.installed_flag, &config.version);
                    }
                } else {
                    installer_failed = Some(format!("installer exit code {:?}", status.code()));
                }
            }
            let installed = config.installed_flag.exists();
            if installed && !logged.1 {
                logged.1 = true;
                self.log.info(&format!("files in place after {elapsed:.0} ms"));
            }
            if installed && !launched && config.installer.is_some() {
                launched = true;
                if !self.launch_app() {
                    installer_failed = Some("new app did not start".into());
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
            {
                let mut ui = self.ui.lock();
                ui.stage = progress.stage;
                ui.percent = progress.percent;
            }
            if progress.stage == UpdateStage::Done {
                self.finished.store(true, Ordering::SeqCst);
                self.push(UpdateStage::Done, 100.0, &strings.done, &[]);
                std::thread::sleep(FINISH_DELAY);
                self.cleanup_and_exit();
                return;
            }
            if installer_failed.is_some() || elapsed > config.timeout_ms as f64 {
                if let Some(reason) = &installer_failed {
                    self.log.error(reason);
                } else {
                    self.log.error(&format!("timed out after {elapsed:.0} ms"));
                }
                self.drop_heartbeat();
                {
                    let mut ui = self.ui.lock();
                    ui.stage = UpdateStage::Error;
                    ui.hiding = false;
                }
                if let Some(w) = self.window() {
                    let _ = w.show();
                }
                self.push(UpdateStage::Error, progress.percent, &strings.slow, &[("detail", json!(strings.slow_hint))]);
                return;
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

    fn on_shown(self: &Arc<Self>) {
        if self.ticking.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(w) = self.window() {
            if self.offscreen {
                show_without_focus(&w);
            } else {
                let _ = w.show();
            }
        }
        let _ = std::fs::write(&self.config.shown_flag, unimux_core::time::now_ms().to_string());
        self.log.info(&format!("window shown +{} ms", self.born.elapsed().as_millis()));
        let me = self.clone();
        std::thread::Builder::new().name("update-window".into()).spawn(move || me.run()).ok();
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
        })
    }

    /// `update-splash:open`: start unimux by hand (offered at the error stage) and end.
    pub fn open_app(&self) {
        self.drop_heartbeat();
        self.launch_app();
        self.cleanup_and_exit();
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

fn offscreen() -> bool {
    cfg!(dev_overrides) && unimux_core::dev_overrides::DevOverrides::from_env().offscreen
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
        .always_on_top(true)
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
        builder = builder.position(-6000.0, 0.0).skip_taskbar(true).focused(false).focusable(false);
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
            if !events.finished.load(Ordering::SeqCst) && close_action(stage) == CloseAction::Hide {
                api.prevent_close();
                events.request_close();
            }
        }
        WindowEvent::Destroyed => events.cleanup_and_exit(),
        _ => {}
    });
    Ok(())
}

/// Takes `work/window.lock` (one update window per data dir); None when another window holds it.
fn lock(work_dir: &Path) -> Option<File> {
    std::fs::create_dir_all(work_dir).ok()?;
    let file = File::options().create(true).truncate(false).write(true).open(work_dir.join("window.lock")).ok()?;
    file.try_lock().ok()?;
    Some(file)
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
        ui: Mutex::new(Ui { stage: UpdateStage::Preparing, percent: 0.0, hiding: false }),
        finished: AtomicBool::new(false),
        exiting: AtomicBool::new(false),
        ticking: AtomicBool::new(false),
        app: OnceLock::new(),
        offscreen: offscreen(),
        born,
        browser_pid: AtomicU32::new(0),
    });
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
            create_window(app.handle(), &setup)?;
            Ok(())
        })
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            win.log.error(&format!("update window could not start: {e}"));
            return 1;
        }
    };
    let exit = win.clone();
    app.run(move |_app, event| {
        if let RunEvent::ExitRequested { code: None, .. } = event {
            // The last window went away without cleanup_and_exit (window-all-closed of 1.1.4).
            exit.cleanup_and_exit();
        }
    });
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> impl Iterator<Item = String> {
        list.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn cleanup_arguments_carry_the_pids_and_the_folders() {
        let c =
            parse_cleanup(args(&["--update-cleanup", "--wait=12,34", "C:\\u\\unimux-updater\\runtime-1.2.1", "D:\\w"])).unwrap();
        assert_eq!(c.wait, [12, 34]);
        assert_eq!(c.dirs, [PathBuf::from("C:\\u\\unimux-updater\\runtime-1.2.1"), PathBuf::from("D:\\w")]);
        let none = parse_cleanup(args(&["--update-cleanup"])).unwrap();
        assert!(none.wait.is_empty() && none.dirs.is_empty());
        assert!(parse_cleanup(args(&["--update-window", "x"])).is_none());
    }

    #[test]
    fn the_bridge_defines_the_1_1_4_contract() {
        for name in ["init:", "onState:", "close:", "open:", "update_splash_init", "update_splash_close", "update_splash_open"] {
            assert!(BRIDGE.contains(name), "{name}");
        }
        assert!(BRIDGE.contains(EVENT));
    }
}
