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
        }
    }
}

/// `UpdateSplashConfig` of src/shared/updateProgress.ts plus the Tauri -> Tauri fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSplashConfig {
    pub from_version: String,
    pub version: String,
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
    /// The window's own WebView2 user data folder (default: `<runtimeDir>/../webview2`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webview_dir: Option<PathBuf>,
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
/// No `/R` (or the 1.1.x `--force-run`): the window starts the new app itself, after the files are in place.
pub fn installer_args(install_dir: &Path) -> String {
    format!("/S /UPDATE --updated /D={}", install_dir.display())
}

/// Paths of one hand-over.
#[derive(Debug, Clone)]
pub struct HandOver {
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

/// Copies `exe` to `<runtime_dir>/unimux-update.exe` through a `.partial` folder (an interrupted copy never looks complete).
/// A copy with the same size and modification time is reused.
pub fn stage_runtime(exe: &Path, runtime_dir: &Path) -> io::Result<PathBuf> {
    let target = runtime_dir.join(RUNTIME_EXE);
    let source = fs::metadata(exe)?;
    if let Ok(existing) = fs::metadata(&target)
        && existing.len() == source.len()
        && existing.modified().ok() == source.modified().ok()
    {
        return Ok(target);
    }
    let partial = runtime_dir.with_extension("partial");
    let _ = fs::remove_dir_all(&partial);
    let _ = fs::remove_dir_all(runtime_dir);
    fs::create_dir_all(&partial)?;
    fs::copy(exe, partial.join(RUNTIME_EXE))?;
    // fs::copy keeps the content, not the time stamp: set it so the reuse check above works.
    if let Ok(modified) = source.modified() {
        let file = fs::File::options().write(true).open(partial.join(RUNTIME_EXE))?;
        let _ = file.set_modified(modified);
    }
    if let Some(parent) = runtime_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&partial, runtime_dir)?;
    Ok(target)
}

pub fn update_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("update")
}

/// Builds the config of a hand-over (no I/O).
pub fn build_config(h: &HandOver, runtime_dir: &Path) -> UpdateSplashConfig {
    let update = update_dir(&h.data_dir);
    let work = update.join("work");
    let install_dir = h.app_exe.parent().map(Path::to_path_buf).unwrap_or_default();
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
        installer: Some(h.installer.clone()),
        installer_args: Some(installer_args(&install_dir)),
        webview_dir: Some(h.updater_root.join("webview2")),
        install_dir,
    }
}

/// Stages the runtime, writes `work/config.json`, starts the update window detached (breakaway from any job, no console) and
/// waits until it is visible. The caller then winds down and exits; the window waits for this process to end.
pub fn hand_over(h: &HandOver) -> io::Result<HandOverResult> {
    let started = Instant::now();
    let runtime_dir = h.updater_root.join(format!("runtime-{}", h.version));
    let exe = stage_runtime(&h.app_exe, &runtime_dir)?;
    let copy_ms = started.elapsed().as_millis() as u64;
    let config = build_config(h, &runtime_dir);
    fs::create_dir_all(&config.work_dir)?;
    for stale in [&config.installed_flag, &config.ready_flag, &config.shown_flag, &config.abort_flag, &config.heartbeat_flag] {
        let _ = fs::remove_file(stale);
    }
    let config_path = config.work_dir.join("config.json");
    let json = serde_json::to_string(&config).map_err(io::Error::other)?;
    unimux_core::atomic_write::atomic_write(&config_path, json.as_bytes(), &Default::default())?;

    let spawn_at = Instant::now();
    let program =
        unimux_exec::Program::Args { program: exe.clone(), args: vec!["--update-window".into(), config_path.clone().into()] };
    let env = h.env.as_ref().map(|extra| {
        let mut env = unimux_exec::clean_process_env();
        env.extend(extra.iter().cloned());
        env
    });
    let pid = unimux_exec::spawn_detached(&program, env, Some(runtime_dir.clone())).map_err(io::Error::other)?;
    let spawn_ms = spawn_at.elapsed().as_millis() as u64;
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

/// The folders `--update-cleanup` may remove: `runtime-*` and `webview2` directly inside a folder named `unimux-updater`. Any
/// other path is refused, so a wrong argument can never delete user data.
pub fn cleanup_allowed(dir: &Path) -> bool {
    let name = dir.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let parent = dir.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    parent == "unimux-updater" && (name.starts_with("runtime-") || name == "webview2")
}

/// Removes the allowed folders with retries (the window's process and its WebView2 processes need a moment to end).
pub fn remove_with_retries(dir: &Path, attempts: u32, delay: Duration) -> bool {
    if !cleanup_allowed(dir) {
        return false;
    }
    for _ in 0..attempts {
        match fs::remove_dir_all(dir) {
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
        }
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
                "fromVersion",
                "version",
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
        let path = tmp.path().join("config.json");
        fs::write(&path, value.to_string()).unwrap();
        let config = UpdateSplashConfig::read(&path).unwrap();
        assert_eq!(config.installer, None);
        assert_eq!(config.webview_dir(), h.updater_root.join("webview2"));
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
        assert!(!runtime.with_extension("partial").exists());
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
        assert!(!cleanup_allowed(&root));
        assert!(!cleanup_allowed(&tmp.path().join("runtime-1.2.1")));
        assert!(!cleanup_allowed(&tmp.path().join("unimux").join("webview2")));
        let other = tmp.path().join("keep");
        fs::create_dir_all(&other).unwrap();
        assert!(!remove_with_retries(&other, 1, Duration::from_millis(1)));
        assert!(other.exists());
        assert!(remove_with_retries(&runtime, 3, Duration::from_millis(1)));
        assert!(!runtime.exists());
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
