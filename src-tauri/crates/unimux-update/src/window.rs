//! The update window hand-over (SP6, production in U2): the config file of the 1.1.x protocol, the runtime copy, the start of
//! `unimux-update.exe --update-window <config>` and the file signals in `<data>/update/`.
//!
//! Protocol (unchanged from 1.1.x, so the NSIS `installer-done` hook and `signalUpdateReady` serve both the Electron and the
//! Tauri path): `work/config.json` (this [`UpdateSplashConfig`]), `work/shown` (window visible), `work/heartbeat` (rewritten every
//! second while the window supervises), `work/abort` (the app gave up the hand-over), `installer-done` (files in place),
//! `ready` (the new app's window is up).
//!
//! Tauri -> Tauri adds three optional fields: `installer` + `installerArgs` (the window runs the NSIS installer itself,
//! 1.1.x left that to electron-updater) and `webviewDir` (the window's own WebView2 data folder).

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use unimux_core::i18n::translate;

/// File name of the runtime copy. Not `unimux.exe`: Task Manager and the taskbar then show what 1.1.4 showed
/// (`unimux-update.exe`), and nothing that looks for the app by image name (an installer, a script) can mistake the update
/// window for the app it replaces. The NSIS template's running-app check is by full path (Restart Manager on
/// `$INSTDIR\unimux.exe`), so a copy outside the install dir is never killed whatever its name; SP6 measured both.
pub const RUNTIME_EXE: &str = "unimux-update.exe";

/// How long the app waits for `work/shown` before it exits anyway (SHOWN_WAIT_MS of updateSplash.ts).
pub const SHOWN_WAIT: Duration = Duration::from_secs(4);
/// INSTALL_TIMEOUT_MS of updateSplash.ts.
pub const INSTALL_TIMEOUT_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageStrings {
    pub preparing: String,
    pub closing: String,
    pub installing: String,
    pub launching: String,
}

/// `UpdateStrings` of src/shared/updateProgress.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStrings {
    pub title: String,
    pub hint: String,
    pub stages: StageStrings,
    pub done: String,
    pub slow: String,
    pub slow_hint: String,
    pub open: String,
    pub close: String,
    pub waiting_close: String,
    pub waiting_installer: String,
    pub installing_long: String,
    pub background: String,
    /// Tauri -> Tauri only (the 1.1.x window never ran the installer): the error stage when the installer did not start, ended
    /// with an error or the new app did not start. Absent in a 1.1.x config: `slow` is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<String>,
}

impl UpdateStrings {
    /// The texts of `updateStrings()` in src/main/index.ts, translated.
    pub fn translated(language: &str, version: &str) -> Self {
        let t = |key: &str| translate(language, key, &[]);
        Self {
            title: translate(language, "Aktualizacja do wersji {version}", &[("version", version)]),
            hint: t("Nie wyłączaj komputera. unimux uruchomi się automatycznie."),
            stages: StageStrings {
                preparing: t("Przygotowanie aktualizacji…"),
                closing: t("Zamykanie unimux…"),
                installing: t("Instalowanie nowej wersji…"),
                launching: t("Uruchamianie unimux…"),
            },
            done: t("Gotowe - uruchamiam nową wersję"),
            slow: t("Aktualizacja trwa dłużej niż zwykle"),
            slow_hint: t("Możesz uruchomić unimux ręcznie."),
            open: t("Uruchom unimux"),
            close: t("Zamknij"),
            waiting_close: t("Czekam na zamknięcie unimux…"),
            waiting_installer: t("Czekam na instalator. Jeśli Windows poprosi o zgodę, potwierdź ją."),
            installing_long: t("Instalacja trwa dłużej niż zwykle - to może jeszcze chwilę potrwać…"),
            background: t("Aktualizacja trwa dalej w tle"),
            failed: Some(t("Nie udało się zainstalować aktualizacji.")),
        }
    }

    /// The message of the error stage after a failed install (`slow` is for the timeout only).
    pub fn failed_text(&self) -> &str {
        self.failed.as_deref().unwrap_or(&self.slow)
    }
}

/// `UpdateSplashConfig` of src/shared/updateProgress.ts plus the Tauri -> Tauri fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSplashConfig {
    // The key order of 1.1.4's showUpdateWindow (src/main/updateSplash.ts): `version` first.
    pub version: String,
    pub from_version: String,
    pub old_pid: u32,
    pub install_dir: PathBuf,
    pub app_exe: PathBuf,
    pub installed_flag: PathBuf,
    pub ready_flag: PathBuf,
    pub shown_flag: PathBuf,
    pub abort_flag: PathBuf,
    pub heartbeat_flag: PathBuf,
    pub runtime_dir: PathBuf,
    pub work_dir: PathBuf,
    pub timeout_ms: u64,
    pub strings: UpdateStrings,
    /// The installer the window runs once the old app has exited (absent: someone else runs it, as in 1.1.x).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installer: Option<PathBuf>,
    /// The installer's command line after the program, verbatim (NSIS wants `/D=<dir>` last and unquoted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installer_args: Option<String>,
    /// The window's own WebView2 user data folder, one per hand-over (`<updater root>/webview2-<id>`), so the cleanup of an
    /// earlier window can never remove the profile of a live one (default for a config without it: `<runtimeDir>/../webview2`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webview_dir: Option<PathBuf>,
    /// macOS (U5): the bundle swap the window runs once the old app has exited, instead of an installer. `installDir` is then
    /// the installed `.app` and `appExe` the executable inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swap: Option<crate::mac::BundleSwapPlan>,
}

impl UpdateSplashConfig {
    pub fn read(path: &Path) -> io::Result<Self> {
        let text = fs::read_to_string(path)?;
        serde_json::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    pub fn webview_dir(&self) -> PathBuf {
        self.webview_dir.clone().unwrap_or_else(|| {
            self.runtime_dir.parent().map(|p| p.join("webview2")).unwrap_or_else(|| self.runtime_dir.join("webview2"))
        })
    }

    /// The log of the update window (`<data>/update/updater.log`, next to the work dir).
    pub fn log_path(&self) -> PathBuf {
        self.work_dir.parent().unwrap_or(&self.work_dir).join("updater.log")
    }
}

/// The `/S` command line of the Tauri NSIS installer for an update into `install_dir`:
/// - `/S` silent; `/UPDATE` keeps the user's shortcuts and pins as they are (no new desktop shortcut on every update), skips the
///   WebView2 step and the uninstall-first path; `--updated` tells the unimux hooks (U3) to write `installer-done`;
/// - `/D=` last and unquoted (NSIS rule), so the files land where the running app is, not where the registry says.
///
/// No `/R` (or the 1.1.x `--force-run`): the window starts the new app itself, after the files are in place (non-elevated
/// even when the installer ran elevated). It keeps supervising the installer after the timeout card and after the user closed
/// that card, so a slow installer still ends with a running app, as `--force-run` did in 1.1.4.
pub fn installer_args(install_dir: &Path) -> String {
    format!("/S /UPDATE --updated /D={}", install_dir.display())
}

/// Whether this user cannot write into `install_dir` (a per-machine install, e.g. under Program Files): the installer then runs
/// elevated (`runas`, the UAC prompt). Probes the nearest existing folder with a temporary file.
pub fn needs_elevation(install_dir: &Path) -> bool {
    let mut dir = install_dir;
    while !dir.is_dir() {
        match dir.parent() {
            Some(parent) => dir = parent,
            None => return false,
        }
    }
    let probe = dir.join(format!(".unimux-write-probe-{}", std::process::id()));
    match fs::File::options().write(true).create_new(true).open(&probe) {
        Ok(file) => {
            drop(file);
            let _ = fs::remove_file(&probe);
            false
        }
        Err(e) => e.kind() == io::ErrorKind::PermissionDenied,
    }
}

/// Paths of one hand-over.
#[derive(Debug, Clone)]
pub struct HandOver {
    /// The installer (Windows); unused when [`HandOver::swap`] is set.
    pub installer: PathBuf,
    pub version: String,
    pub from_version: String,
    /// The app's data dir; the protocol files live in `<data>/update/`.
    pub data_dir: PathBuf,
    /// `%LOCALAPPDATA%\unimux-updater` in production (a scratch folder named `unimux-updater` in tests).
    pub updater_root: PathBuf,
    /// The running app's executable (copied) and its folder (the install dir the installer replaces).
    pub app_exe: PathBuf,
    pub language: String,
    pub timeout_ms: u64,
    /// Extra environment for the window (None: this process's cleaned environment).
    pub env: Option<Vec<(OsString, OsString)>>,
    /// The window's WebView2 folder (None: a new `webview2-<id>` inside `updater_root`).
    pub webview_dir: Option<PathBuf>,
    /// macOS (U5): the verified bundle swap of `MacUpdater::install`; the window swaps the bundle instead of running an
    /// installer.
    pub swap: Option<crate::mac::BundleSwapPlan>,
}

/// What the hand-over measured (SP6 numbers).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandOverResult {
    pub pid: u32,
    pub config: PathBuf,
    pub runtime_exe: PathBuf,
    pub copy_ms: u64,
    pub spawn_ms: u64,
    /// Time from the spawn to `work/shown` (None: not shown within [`SHOWN_WAIT`]).
    pub shown_ms: Option<u64>,
}

/// The staging folder of one copy: `<runtime dir name>.partial-<pid>` next to the runtime dir. The full folder name is kept
/// (`Path::with_extension` would cut the version at its last dot, so every patch of a minor line would share one folder) and
/// the pid keeps two stagings at once (the pre-stage when the download is verified and a hand-over) apart.
pub fn partial_dir(runtime_dir: &Path, pid: u32) -> PathBuf {
    let name = runtime_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "runtime".into());
    runtime_dir.with_file_name(format!("{name}.partial-{pid}"))
}

/// Removes the staging folders of staging processes that are gone (`runtime-*.partial-<pid>` with a dead pid, and the
/// `runtime-*.partial` of the SP6 builds) from the updater root.
fn remove_stale_partials(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("runtime-") {
            continue;
        }
        let stale = match name.rsplit_once(".partial-") {
            Some((_, pid)) => {
                pid.parse::<u32>().ok().is_none_or(|pid| pid != std::process::id() && !unimux_exec::process_alive(pid))
            }
            None => name.ends_with(".partial"),
        };
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn same_copy(target: &Path, source: &fs::Metadata) -> bool {
    fs::metadata(target)
        .is_ok_and(|existing| existing.len() == source.len() && existing.modified().ok() == source.modified().ok())
}

/// Copies `exe` to `<runtime_dir>/unimux-update.exe` through a staging folder of its own (an interrupted copy never looks
/// complete, see [`partial_dir`]). A copy with the same size and modification time is reused.
pub fn stage_runtime(exe: &Path, runtime_dir: &Path) -> io::Result<PathBuf> {
    let target = runtime_dir.join(RUNTIME_EXE);
    let source = fs::metadata(exe)?;
    if same_copy(&target, &source) {
        return Ok(target);
    }
    if let Some(parent) = runtime_dir.parent() {
        fs::create_dir_all(parent)?;
        remove_stale_partials(parent);
        sweep_stale_webviews(parent, &temp_webview_root(), unimux_core::time::now_ms());
    }
    let partial = partial_dir(runtime_dir, std::process::id());
    let _ = fs::remove_dir_all(&partial);
    let _ = fs::remove_dir_all(runtime_dir);
    let staged = (|| {
        fs::create_dir_all(&partial)?;
        fs::copy(exe, partial.join(RUNTIME_EXE))?;
        // fs::copy keeps the content, not the time stamp: set it so the reuse check above works.
        if let Ok(modified) = source.modified() {
            let file = fs::File::options().write(true).open(partial.join(RUNTIME_EXE))?;
            let _ = file.set_modified(modified);
        }
        fs::rename(&partial, runtime_dir)
    })();
    if let Err(e) = staged {
        let _ = fs::remove_dir_all(&partial);
        // Another staging of the same exe won the rename: its copy is as good.
        return if same_copy(&target, &source) { Ok(target) } else { Err(e) };
    }
    Ok(target)
}

/// `%LOCALAPPDATA%\unimux-updater`: where the runtime copies and the update windows' WebView2 folders live (the same folder
/// 1.1.4 staged its Electron runtime in; ARCHITECTURE section 8). Elsewhere (macOS, U5) a folder of the same name in the temp
/// dir.
pub fn updater_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(UPDATER_DIR)
}

/// `%TEMP%\unimux-updater`: where an update window puts its WebView2 folder (`webview2-<ms>`) when the configured one fails
/// the pre-check. Swept like the updater root by [`stage_runtime`] and [`prestage`].
pub fn temp_webview_root() -> PathBuf {
    std::env::temp_dir().join(UPDATER_DIR)
}

/// Sweeps stale `webview2-<ms>` folders of killed windows from the updater `root` and from `temp_root` (the callers pass
/// [`temp_webview_root`]; once when they are the same folder).
fn sweep_stale_webviews(root: &Path, temp_root: &Path, now_ms: i64) {
    remove_stale_webviews(root, now_ms);
    if temp_root != root {
        remove_stale_webviews(temp_root, now_ms);
    }
}

/// The folder name the cleanup insists on ([`cleanup_allowed`]).
pub const UPDATER_DIR: &str = "unimux-updater";

/// A WebView2 folder of an update window older than this is left over by a window that was killed (no cleanup ran); the
/// next staging removes it. A window supervises for 15 min at most.
pub const STALE_WEBVIEW_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Removes `webview2-<ms>` folders whose id (the hand-over time) is older than [`STALE_WEBVIEW_AGE`] from the updater root.
fn remove_stale_webviews(root: &Path, now_ms: i64) {
    let now_ms = u64::try_from(now_ms).unwrap_or(0);
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_prefix("webview2-").and_then(|id| id.parse::<u64>().ok()) else { continue };
        if now_ms.saturating_sub(id) > STALE_WEBVIEW_AGE.as_millis() as u64 && entry.path().is_dir() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// What [`prestage`] measured.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prestaged {
    pub runtime_exe: PathBuf,
    pub copy_ms: u64,
    /// The warm-up start (`--update-cleanup` without folders, a no-op) until it exited; None when it did not start.
    pub warm_ms: Option<u64>,
}

/// Run as soon as the downloaded installer is verified (1.1.4's `stageSplashRuntime` when the update was found): copies the
/// running exe to `<root>/runtime-<version>/unimux-update.exe` and starts the copy once with `--update-cleanup` (a no-op that
/// exits at once), so the antivirus scan of a never-seen file happens now and not while the user waits for the window
/// (SP6: CreateProcess 904 ms cold, 212 ms staged and warmed). Also sweeps WebView2 folders left by killed windows.
pub fn prestage(app_exe: &Path, root: &Path, version: &str) -> io::Result<Prestaged> {
    let started = Instant::now();
    let runtime_dir = root.join(format!("runtime-{version}"));
    let runtime_exe = stage_runtime(app_exe, &runtime_dir)?;
    let copy_ms = started.elapsed().as_millis() as u64;
    sweep_stale_webviews(root, &temp_webview_root(), unimux_core::time::now_ms());
    let warm = Instant::now();
    let program = unimux_exec::Program::Args { program: runtime_exe.clone(), args: vec!["--update-cleanup".into()] };
    // Outside the copy (a working directory inside it would hold the folder), detached like the real start.
    let warm_ms = unimux_exec::spawn_detached(&program, None, Some(std::env::temp_dir())).ok().map(|pid| {
        let deadline = Instant::now() + Duration::from_secs(30);
        while unimux_exec::process_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        warm.elapsed().as_millis() as u64
    });
    Ok(Prestaged { runtime_exe, copy_ms, warm_ms })
}

pub fn update_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("update")
}

/// Builds the config of a hand-over (no I/O).
pub fn build_config(h: &HandOver, runtime_dir: &Path) -> UpdateSplashConfig {
    let update = update_dir(&h.data_dir);
    let work = update.join("work");
    // A bundle swap replaces the whole `.app` (its size is what the progress measures); an installer the exe's folder.
    let install_dir = match &h.swap {
        Some(plan) => plan.bundle.clone(),
        None => h.app_exe.parent().map(Path::to_path_buf).unwrap_or_default(),
    };
    let installer = h.swap.is_none().then(|| h.installer.clone());
    UpdateSplashConfig {
        from_version: h.from_version.clone(),
        version: h.version.clone(),
        old_pid: std::process::id(),
        app_exe: h.app_exe.clone(),
        installed_flag: update.join("installer-done"),
        ready_flag: update.join("ready"),
        shown_flag: work.join("shown"),
        abort_flag: work.join("abort"),
        heartbeat_flag: work.join("heartbeat"),
        runtime_dir: runtime_dir.to_path_buf(),
        work_dir: work,
        timeout_ms: h.timeout_ms,
        strings: UpdateStrings::translated(&h.language, &h.version),
        installer_args: installer.as_ref().map(|_| installer_args(&install_dir)),
        installer,
        swap: h.swap.clone(),
        webview_dir: Some(
            h.webview_dir.clone().unwrap_or_else(|| h.updater_root.join(format!("webview2-{}", unimux_core::time::now_ms()))),
        ),
        install_dir,
    }
}

/// Stages the runtime, writes `work/config.json`, starts the update window detached (breakaway from any job, no console) and
/// waits until it is visible. The caller then winds down and exits; the window waits for this process to end.
pub fn hand_over(h: &HandOver) -> io::Result<HandOverResult> {
    let started = Instant::now();
    let runtime_dir = h.updater_root.join(format!("runtime-{}", h.version));
    let mut exe = stage_runtime(&h.app_exe, &runtime_dir)?;
    let mut copy_ms = started.elapsed().as_millis() as u64;
    let config = build_config(h, &runtime_dir);
    fs::create_dir_all(&config.work_dir)?;
    for stale in [&config.installed_flag, &config.ready_flag, &config.shown_flag, &config.abort_flag, &config.heartbeat_flag] {
        let _ = fs::remove_file(stale);
    }
    let config_path = config.work_dir.join("config.json");
    let json = serde_json::to_string(&config).map_err(io::Error::other)?;
    unimux_core::atomic_write::atomic_write(&config_path, json.as_bytes(), &Default::default())?;

    let env = h.env.as_ref().map(|extra| {
        let mut env = unimux_exec::clean_process_env();
        env.extend(extra.iter().cloned());
        env
    });
    let mut spawn_at = Instant::now();
    let mut spawn = |exe: &Path| {
        spawn_at = Instant::now();
        let program = unimux_exec::Program::Args {
            program: exe.to_path_buf(),
            args: vec!["--update-window".into(), config_path.clone().into()],
        };
        unimux_exec::spawn_detached(&program, env.clone(), Some(runtime_dir.clone()))
    };
    let pid = match spawn(&exe) {
        Ok(pid) => pid,
        // The cleanup of an earlier window of the same version may have removed the reused copy right before the start:
        // stage it again, once.
        Err(_) if !exe.exists() => {
            let again = Instant::now();
            exe = stage_runtime(&h.app_exe, &runtime_dir)?;
            copy_ms += again.elapsed().as_millis() as u64;
            spawn(&exe).map_err(io::Error::other)?
        }
        Err(e) => return Err(io::Error::other(e)),
    };
    let spawn_ms = spawn_at.elapsed().as_millis() as u64;
    // The user just clicked "install" in this app, so it may set the foreground window; the right goes on to the window
    // process, which passes it to the installer (ASFW_ANY) so a UAC prompt can come to the front. The window itself never
    // takes the focus.
    unimux_platform::allow_set_foreground(pid);
    let shown_ms = wait_for_file(&config.shown_flag, SHOWN_WAIT).then(|| spawn_at.elapsed().as_millis() as u64);
    Ok(HandOverResult { pid, config: config_path, runtime_exe: exe, copy_ms, spawn_ms, shown_ms })
}

/// True as soon as `file` exists, false after `timeout` (waitForFile of updateRuntime.ts).
pub fn wait_for_file(file: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !file.exists() {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// `readUpdateAttempt`: the version the last update window was started for.
pub fn attempt_version(data_dir: &Path) -> Option<String> {
    let text = fs::read_to_string(update_dir(data_dir).join("work").join("config.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// `signalUpdateReady`: the new version writes `update/ready` once its window is up, which completes the window's last step.
/// An old build started while the installer runs must not report the update as finished, hence the version check.
pub fn signal_update_ready(data_dir: &Path, running_version: &str) -> bool {
    if attempt_version(data_dir).as_deref() != Some(running_version) {
        return false;
    }
    let dir = update_dir(data_dir);
    fs::create_dir_all(&dir).is_ok() && fs::write(dir.join("ready"), running_version).is_ok()
}

/// HEARTBEAT_FRESH_MS of updateRuntime.ts: a heartbeat this young means the update window still supervises.
pub const HEARTBEAT_FRESH_MS: f64 = 15.0 * 1000.0;
/// HEARTBEAT_MAX_AGE_MS: past this age even a beating update window is no longer trusted.
pub const HEARTBEAT_MAX_AGE_MS: f64 = 15.0 * 60.0 * 1000.0;
/// START_BLOCK_MS of updateSplash.ts: a normal install takes well under this.
pub const START_BLOCK_MS: f64 = 90.0 * 1000.0;

fn modified_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_secs_f64() * 1000.0)
}

fn heartbeat_fresh(file: &Path, now: f64) -> bool {
    modified_ms(file).is_some_and(|m| {
        let age = now - m;
        (-HEARTBEAT_FRESH_MS..=HEARTBEAT_FRESH_MS).contains(&age)
    })
}

/// `updateWindowAlive`: the update window of an update writes its heartbeat every second while it supervises.
pub fn update_window_alive(data_dir: &Path, now: f64) -> bool {
    heartbeat_fresh(&update_dir(data_dir).join("work").join("heartbeat"), now)
}

/// `installInProgress`: an installer started by an update window may still be replacing the app files (the attempt targets
/// another version, is younger than `max_age_ms` and has signalled neither completion nor abort; a slow installer is still
/// trusted while the window's heartbeat is fresh, up to 15 minutes).
pub fn install_in_progress(data_dir: &Path, current_version: &str, max_age_ms: f64, now: f64) -> bool {
    let update = update_dir(data_dir);
    let config = update.join("work").join("config.json");
    let Some(version) = attempt_version(data_dir) else { return false };
    if version == current_version {
        return false;
    }
    if ["installer-done", "ready"].iter().any(|n| update.join(n).exists()) || update.join("work").join("abort").exists() {
        return false;
    }
    let Some(started) = modified_ms(&config) else { return false };
    let age = now - started;
    if age <= max_age_ms {
        return true;
    }
    age <= HEARTBEAT_MAX_AGE_MS && heartbeat_fresh(&update.join("work").join("heartbeat"), now)
}

/// `abortUpdateWindow`: the hand-over failed and the app keeps running; the window closes on this signal.
pub fn abort_update_window(data_dir: &Path) {
    let work = update_dir(data_dir).join("work");
    let _ = fs::create_dir_all(&work);
    let _ = fs::write(work.join("abort"), unimux_core::time::now_ms().to_string());
}

/// `directoryBytes`: the size of a tree; unreadable entries are skipped (the installer is rewriting it). Only metadata is read,
/// never a file handle kept: the installer must be able to replace every file while this runs.
pub fn directory_bytes(root: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

/// The folders `--update-cleanup` may remove: `runtime-*`, `webview2` and `webview2-*` directly inside a folder named
/// `unimux-updater`. Any other path is refused, so a wrong argument can never delete user data.
pub fn cleanup_allowed(dir: &Path) -> bool {
    let name = dir.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let parent = dir.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    parent == UPDATER_DIR && (name.starts_with("runtime-") || name == "webview2" || name.starts_with("webview2-"))
}

/// Whether `dir` is a runtime copy folder (`runtime-*`): the one folder a newer update window may share with an older one (same
/// version), so the cleanup leaves it while a window holds `work/window.lock`.
pub fn is_runtime_dir(dir: &Path) -> bool {
    dir.file_name().is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().starts_with("runtime-"))
}

/// Removes the allowed folders with retries (the window's process and its WebView2 processes need a moment to end).
pub fn remove_with_retries(dir: &Path, attempts: u32, delay: Duration) -> bool {
    remove_with_retries_guarded(dir, attempts, delay, || Some(()))
}

/// [`remove_with_retries`] that takes a guard before every attempt (held during the attempt, not during the pause) and stops,
/// leaving the folder, once `guard` returns None (the cleanup's `work/window.lock`: a newer window runs).
pub fn remove_with_retries_guarded<G>(dir: &Path, attempts: u32, delay: Duration, mut guard: impl FnMut() -> Option<G>) -> bool {
    if !cleanup_allowed(dir) {
        return false;
    }
    // Only folders: a file under an allowed name is not ours.
    if fs::symlink_metadata(dir).is_ok_and(|m| !m.is_dir()) {
        return false;
    }
    for _ in 0..attempts {
        let attempt = {
            let Some(_held) = guard() else { return false };
            fs::remove_dir_all(dir)
        };
        match attempt {
            Ok(()) => return true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return true,
            Err(_) => std::thread::sleep(delay),
        }
    }
    !dir.exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(data: &Path, root: &Path) -> HandOver {
        HandOver {
            installer: root.join("setup.exe"),
            version: "1.2.1".into(),
            from_version: "1.2.0".into(),
            data_dir: data.to_path_buf(),
            updater_root: root.join("unimux-updater"),
            app_exe: root.join("Install Dir").join("unimux.exe"),
            language: "en".into(),
            timeout_ms: INSTALL_TIMEOUT_MS,
            env: None,
            webview_dir: None,
            swap: None,
        }
    }

    fn swap_plan(root: &Path) -> crate::mac::BundleSwapPlan {
        let apps = root.join("Applications");
        let mac = root.join("data").join("updates").join("mac");
        crate::mac::BundleSwapPlan {
            bundle: apps.join("unimux.app"),
            new_bundle: apps.join("unimux.app.new-1.2.1"),
            backup: apps.join("unimux.app.old-1.2.0"),
            executable: "unimux".into(),
            log: mac.join("update.log"),
            ready_flag: mac.join("ready"),
            failed_flag: mac.join("rolled-back"),
            cleanup: vec![mac.join("unimux-1.2.1-mac-arm64.app.tar.gz")],
            from_version: "1.2.0".into(),
            to_version: "1.2.1".into(),
        }
    }

    #[test]
    fn a_swap_hand_over_carries_the_plan_and_no_installer() {
        let tmp = tempfile::tempdir().unwrap();
        let mut h = sample(&tmp.path().join("data"), tmp.path());
        let plan = swap_plan(tmp.path());
        h.app_exe = plan.bundle.join("Contents").join("MacOS").join("unimux");
        h.swap = Some(plan.clone());
        let config = build_config(&h, &h.updater_root.join("runtime-1.2.1"));
        assert_eq!(config.install_dir, plan.bundle);
        assert_eq!(config.installer, None);
        assert_eq!(config.installer_args, None);
        let value = serde_json::to_value(&config).unwrap();
        assert!(value.get("installer").is_none() && value.get("installerArgs").is_none());
        assert_eq!(value["swap"]["newBundle"], serde_json::json!(plan.new_bundle));
        assert_eq!(value["swap"]["toVersion"], "1.2.1");
        // Through work/config.json and back.
        let back: UpdateSplashConfig = serde_json::from_value(value).unwrap();
        assert_eq!(back.swap, Some(plan));
        // An installer hand-over has no `swap` key (the 1.1.x shape is unchanged).
        h.swap = None;
        let value = serde_json::to_value(build_config(&h, &h.updater_root.join("runtime-1.2.1"))).unwrap();
        assert!(value.get("swap").is_none());
    }

    #[test]
    fn config_has_the_1_1_x_shape_plus_the_tauri_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let h = sample(&tmp.path().join("data"), tmp.path());
        let config = build_config(&h, &h.updater_root.join("runtime-1.2.1"));
        let value = serde_json::to_value(&config).unwrap();
        let keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "version",
                "fromVersion",
                "oldPid",
                "installDir",
                "appExe",
                "installedFlag",
                "readyFlag",
                "shownFlag",
                "abortFlag",
                "heartbeatFlag",
                "runtimeDir",
                "workDir",
                "timeoutMs",
                "strings",
                "installer",
                "installerArgs",
                "webviewDir"
            ]
        );
        assert_eq!(value["strings"]["stages"]["installing"], "Installing the new version…");
        assert_eq!(value["strings"]["slowHint"], "You can start unimux manually.");
        assert_eq!(value["strings"]["title"], "Updating to version 1.2.1");
        assert_eq!(value["strings"]["failed"], "Could not install the update.");
        assert_eq!(value["strings"]["slow"], "The update is taking longer than usual");
        let webview = config.webview_dir.clone().unwrap();
        assert_eq!(webview.parent(), Some(h.updater_root.as_path()));
        assert!(webview.file_name().unwrap().to_string_lossy().starts_with("webview2-"), "{}", webview.display());
        assert!(cleanup_allowed(&webview));
        assert!(config.installed_flag.ends_with("update/installer-done"));
        assert!(config.heartbeat_flag.ends_with("update/work/heartbeat"));
        let args = config.installer_args.unwrap();
        assert!(args.starts_with("/S /UPDATE --updated /D="));
        assert!(args.ends_with("Install Dir"), "/D= last and unquoted: {args}");
        assert!(!args.contains("--force-run") && !args.contains(" /R"));
    }

    #[test]
    fn a_1_1_x_config_without_the_tauri_fields_still_reads() {
        let tmp = tempfile::tempdir().unwrap();
        let h = sample(&tmp.path().join("data"), tmp.path());
        let mut value = serde_json::to_value(build_config(&h, &h.updater_root.join("runtime-1.2.1"))).unwrap();
        for key in ["installer", "installerArgs", "webviewDir"] {
            value.as_object_mut().unwrap().remove(key);
        }
        value["strings"].as_object_mut().unwrap().remove("failed");
        let path = tmp.path().join("config.json");
        fs::write(&path, value.to_string()).unwrap();
        let config = UpdateSplashConfig::read(&path).unwrap();
        assert_eq!(config.installer, None);
        assert_eq!(config.webview_dir(), h.updater_root.join("webview2"));
        assert_eq!(config.strings.failed, None);
        assert_eq!(config.strings.failed_text(), "The update is taking longer than usual");
    }

    #[test]
    fn staging_copies_once_and_reuses_an_identical_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("unimux.exe");
        fs::write(&exe, b"MZ fake").unwrap();
        let runtime = tmp.path().join("unimux-updater").join("runtime-1.2.1");
        let target = stage_runtime(&exe, &runtime).unwrap();
        assert_eq!(target, runtime.join(RUNTIME_EXE));
        assert_eq!(fs::read(&target).unwrap(), b"MZ fake");
        let first = fs::metadata(&target).unwrap().modified().unwrap();
        assert_eq!(stage_runtime(&exe, &runtime).unwrap(), target);
        assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), first);
        let names: Vec<String> =
            fs::read_dir(runtime.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        assert_eq!(names, ["runtime-1.2.1"]);
    }

    #[test]
    fn every_version_stages_in_its_own_folder_and_stale_ones_go() {
        // Built with join, so the path has the same components on every platform (macOS CI runs this too).
        let root = Path::new("C:\\u").join("unimux-updater");
        // with_extension("partial") made runtime-1.2.1 and runtime-1.2.2 share runtime-1.2.partial.
        assert_eq!(partial_dir(&root.join("runtime-1.2.1"), 7), root.join("runtime-1.2.1.partial-7"));
        assert_ne!(partial_dir(&root.join("runtime-1.2.1"), 7), partial_dir(&root.join("runtime-1.2.2"), 7));
        assert!(cleanup_allowed(&partial_dir(&root.join("runtime-1.2.1"), 7)));

        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("unimux.exe");
        fs::write(&exe, b"MZ fake").unwrap();
        let root = tmp.path().join("unimux-updater");
        // Left by a staging process that is gone (a pid that never exists), by an SP6 build, and one of a live process.
        let dead = root.join(format!("runtime-1.2.0.partial-{}", u32::MAX - 1));
        let old_style = root.join("runtime-1.2.partial");
        let live = partial_dir(&root.join("runtime-1.3.0"), std::process::id());
        for dir in [&dead, &old_style, &live] {
            fs::create_dir_all(dir).unwrap();
        }
        stage_runtime(&exe, &root.join("runtime-1.2.1")).unwrap();
        stage_runtime(&exe, &root.join("runtime-1.2.2")).unwrap();
        assert!(!dead.exists() && !old_style.exists());
        assert!(live.exists(), "a staging folder of a running process stays");
        for v in ["1.2.1", "1.2.2"] {
            assert!(root.join(format!("runtime-{v}")).join(RUNTIME_EXE).exists());
            assert!(!partial_dir(&root.join(format!("runtime-{v}")), std::process::id()).exists());
        }
    }

    #[test]
    fn webview_folders_of_killed_windows_go_after_a_day_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(UPDATER_DIR);
        let now = 1_762_444_800_000u64;
        let day = STALE_WEBVIEW_AGE.as_millis() as u64;
        let stale = root.join(format!("webview2-{}", now - day - 1));
        let fresh = root.join(format!("webview2-{}", now - 60_000));
        let shared = root.join("webview2");
        let odd = root.join("webview2-x");
        let file = root.join(format!("webview2-{}", now - 2 * day));
        for dir in [&stale, &fresh, &shared, &odd] {
            fs::create_dir_all(dir.join("EBWebView")).unwrap();
        }
        fs::write(&file, b"x").unwrap();
        remove_stale_webviews(&root, now as i64);
        assert!(!stale.exists());
        assert!(fresh.exists() && shared.exists() && odd.exists() && file.exists());
    }

    #[test]
    fn the_temp_fallback_folders_of_killed_windows_are_swept_too() {
        // The update window's fallback lives under %TEMP%\unimux-updater, not under the updater root.
        assert_eq!(temp_webview_root(), std::env::temp_dir().join(UPDATER_DIR));
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("local").join(UPDATER_DIR);
        let temp = tmp.path().join("temp").join(UPDATER_DIR);
        let now = 1_762_444_800_000i64;
        let day = STALE_WEBVIEW_AGE.as_millis() as i64;
        let stale = [root.join(format!("webview2-{}", now - 2 * day)), temp.join(format!("webview2-{}", now - 2 * day))];
        let fresh = [root.join(format!("webview2-{}", now - 1000)), temp.join(format!("webview2-{}", now - 1000))];
        for dir in stale.iter().chain(&fresh) {
            fs::create_dir_all(dir.join("EBWebView")).unwrap();
        }
        sweep_stale_webviews(&root, &temp, now);
        assert!(stale.iter().all(|d| !d.exists()));
        assert!(fresh.iter().all(|d| d.exists()));
        // The same folder twice is swept once, without harm.
        sweep_stale_webviews(&root, &root, now);
        assert!(fresh[0].exists());
    }

    #[test]
    fn prestage_copies_the_runtime_and_reports_a_warm_start_only_when_it_ran() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("unimux.exe");
        fs::write(&exe, b"MZ not a real program").unwrap();
        let root = tmp.path().join(UPDATER_DIR);
        let p = prestage(&exe, &root, "1.2.1").unwrap();
        assert_eq!(p.runtime_exe, root.join("runtime-1.2.1").join(RUNTIME_EXE));
        assert_eq!(fs::read(&p.runtime_exe).unwrap(), b"MZ not a real program");
        assert_eq!(p.warm_ms, None, "a file that is no program does not start");
        assert!(updater_root().ends_with(UPDATER_DIR));
    }

    #[test]
    fn ready_is_written_only_by_the_version_the_window_waits_for() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        assert!(!signal_update_ready(&data, "1.2.1"));
        let work = data.join("update").join("work");
        fs::create_dir_all(&work).unwrap();
        fs::write(work.join("config.json"), r#"{"version":"1.2.1"}"#).unwrap();
        assert!(!signal_update_ready(&data, "1.2.0"));
        assert!(!data.join("update").join("ready").exists());
        assert!(signal_update_ready(&data, "1.2.1"));
        assert_eq!(fs::read_to_string(data.join("update").join("ready")).unwrap(), "1.2.1");
    }

    #[test]
    fn cleanup_refuses_anything_but_the_updater_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("unimux-updater");
        let runtime = root.join("runtime-1.2.1");
        fs::create_dir_all(runtime.join("x")).unwrap();
        assert!(cleanup_allowed(&runtime));
        assert!(cleanup_allowed(&root.join("webview2")));
        assert!(cleanup_allowed(&root.join("webview2-1762444800000")));
        assert!(is_runtime_dir(&runtime) && !is_runtime_dir(&root.join("webview2-1")));
        assert!(!cleanup_allowed(&root));
        assert!(!cleanup_allowed(&tmp.path().join("runtime-1.2.1")));
        assert!(!cleanup_allowed(&tmp.path().join("unimux").join("webview2")));
        let other = tmp.path().join("keep");
        fs::create_dir_all(&other).unwrap();
        assert!(!remove_with_retries(&other, 1, Duration::from_millis(1)));
        assert!(other.exists());
        // A file under an allowed name is left alone; a guard that refuses stops before the first attempt.
        let file = root.join("webview2-file");
        fs::write(&file, b"x").unwrap();
        assert!(!remove_with_retries(&file, 3, Duration::from_millis(1)));
        assert!(file.exists());
        assert!(!remove_with_retries_guarded(&runtime, 3, Duration::from_millis(1), || None::<()>));
        assert!(runtime.exists());
        assert!(remove_with_retries(&runtime, 3, Duration::from_millis(1)));
        assert!(!runtime.exists());
    }

    #[test]
    fn elevation_is_needed_only_for_a_folder_this_user_cannot_write() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Install Dir");
        // Not there yet: the parent decides.
        assert!(!needs_elevation(&dir));
        fs::create_dir_all(&dir).unwrap();
        assert!(!needs_elevation(&dir));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "the probe file is removed");
        #[cfg(windows)]
        {
            // A per-machine install dir: writing is denied to this user (Everyone, so it covers the token's groups).
            let icacls = |args: &[&str]| std::process::Command::new("icacls").arg(&dir).args(args).output().unwrap().status;
            assert!(icacls(&["/deny", "*S-1-1-0:(W)"]).success());
            let denied = needs_elevation(&dir);
            assert!(icacls(&["/remove:d", "*S-1-1-0"]).success());
            assert!(denied);
            assert!(!needs_elevation(&dir));
        }
    }

    #[test]
    fn directory_bytes_counts_files_in_subfolders() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("a").join("b")).unwrap();
        fs::write(tmp.path().join("one"), [0u8; 10]).unwrap();
        fs::write(tmp.path().join("a").join("b").join("two"), [0u8; 5]).unwrap();
        assert_eq!(directory_bytes(tmp.path()), 15);
        assert_eq!(directory_bytes(&tmp.path().join("missing")), 0);
    }
}
