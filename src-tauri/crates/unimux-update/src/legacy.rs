//! Electron 1.1.x -> 1.2.0 (PLAN U3, ARCHITECTURE section 8): what the new app does for the 1.1.x update machinery.
//!
//! - The 1.1.x update window ends with `<appExe> -e <script>` and `ELECTRON_RUN_AS_NODE=1`: a node one-liner that waits 3 s
//!   and removes the window's private Electron runtime (`<data>/update/runtime`). After the update `appExe` is this exe, so
//!   `main()` answers the call itself: it removes that folder (only that folder, see [`eval_cleanup_target`]) and exits 0
//!   without a window, without the instance lock and without touching anything else.
//! - `scheduleUpdateCleanup`: `<data>/update` (signals and the 1.1.x runtime of a finished update) goes 30 s after the start
//!   unless an install is still running ([`update_dir_cleanup_allowed`]).
//! - electron-updater's cache `%LOCALAPPDATA%\unimux-updater` (the folder the Tauri updater shares): the installer copy
//!   electron-builder stored there and the downloaded 1.2.x setup it ran ([`electron_updater_leftovers`]).

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::version::compare_versions;
use crate::window::{INSTALL_TIMEOUT_MS, install_in_progress, update_dir};

/// The 1.1.x window's one-liner waited this long before it removed its runtime (the window process must be gone first).
pub const EVAL_CLEANUP_DELAY: Duration = Duration::from_secs(3);
/// `rmSync(..., {maxRetries: 10, retryDelay: 500})` of the one-liner.
pub const EVAL_CLEANUP_RETRIES: u32 = 10;
pub const EVAL_CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(500);
/// CLEANUP_DELAY_MS of updateSplash.ts.
pub const UPDATE_CLEANUP_DELAY: Duration = Duration::from_secs(30);

/// True for the call the 1.1.x update window makes: `ELECTRON_RUN_AS_NODE` set (Electron's rule: any value but empty) and a
/// `-e` / `--eval` argument. Returns the script that follows it (empty when none follows).
pub fn eval_call(run_as_node: Option<&str>, args: &[String]) -> Option<String> {
    let as_node = run_as_node.is_some_and(|v| !v.is_empty());
    if !as_node {
        return None;
    }
    let at = args.iter().position(|a| a == "-e" || a == "--eval")?;
    Some(args.get(at + 1).cloned().unwrap_or_default())
}

/// The folder the 1.1.x one-liner removes: the first JSON string literal after `rmSync(` (the window wrote it with
/// `JSON.stringify(config.runtimeDir)`).
pub fn parse_eval_runtime_dir(script: &str) -> Option<PathBuf> {
    let after = &script[script.find("rmSync(")? + "rmSync(".len()..];
    let after = after.trim_start();
    if !after.starts_with('"') {
        return None;
    }
    // The end of the literal: the first quote that is not escaped.
    let bytes = after.as_bytes();
    let mut i = 1;
    let mut end = None;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => {
                end = Some(i);
                break;
            }
            _ => i += 1,
        }
    }
    let literal = &after[..=end?];
    let text: String = serde_json::from_str(literal).ok()?;
    (!text.is_empty()).then(|| PathBuf::from(text))
}

/// The runtime folders a 1.1.x update window can have used: `<data>/update/runtime` of the data dir (the current one, the
/// legacy `ajzakomator` one, and a development data dir when one is set).
pub fn runtime_dir_candidates(app_data: &Path, dev_data_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> =
        ["unimux", "ajzakomator"].iter().map(|name| update_dir(&app_data.join(name)).join("runtime")).collect();
    if let Some(dev) = dev_data_dir {
        dirs.push(update_dir(dev).join("runtime"));
    }
    dirs
}

fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/').to_string();
    if cfg!(any(windows, target_os = "macos")) { text.to_lowercase() } else { text }
}

/// Whether two paths name the same folder as text (separators, a trailing separator and, on the case-insensitive file
/// systems of Windows and macOS, case ignored). `..` segments are never resolved: a path with them simply matches nothing.
pub fn same_path(a: &Path, b: &Path) -> bool {
    normalized(a) == normalized(b)
}

/// What the `-e` call may remove: the script's folder when it is one of `candidates`, nothing otherwise. A crafted call can
/// never point the removal anywhere else.
pub fn eval_cleanup_target(script: &str, candidates: &[PathBuf]) -> Option<PathBuf> {
    let dir = parse_eval_runtime_dir(script)?;
    if dir.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    candidates.iter().find(|c| same_path(c, &dir)).cloned()
}

/// Removes `dir` like the one-liner did (`force`: a missing folder is fine), retrying while the window's files are still
/// held. A symlink or junction in its place is removed as a link, never followed.
pub fn remove_runtime_dir(dir: &Path, retries: u32, delay: Duration) -> bool {
    for attempt in 0..=retries {
        let Ok(meta) = fs::symlink_metadata(dir) else { return true };
        let result =
            if meta.file_type().is_symlink() || !meta.is_dir() { remove_link_or_file(dir) } else { fs::remove_dir_all(dir) };
        match result {
            Ok(()) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) if attempt < retries => std::thread::sleep(delay),
            Err(_) => return false,
        }
    }
    false
}

fn remove_link_or_file(path: &Path) -> std::io::Result<()> {
    // A directory symlink / junction on Windows goes with remove_dir, a file symlink (or a file) with remove_file.
    fs::remove_file(path).or_else(|_| fs::remove_dir(path))
}

/// The whole `-e` call: wait, then remove the allowed runtime folder. Returns the exit code (always 0, like the one-liner,
/// whose errors were swallowed).
pub fn run_eval_cleanup(script: &str, candidates: &[PathBuf], delay: Duration) -> i32 {
    std::thread::sleep(delay);
    if let Some(dir) = eval_cleanup_target(script, candidates) {
        remove_runtime_dir(&dir, EVAL_CLEANUP_RETRIES, EVAL_CLEANUP_RETRY_DELAY);
    }
    0
}

/// `scheduleUpdateCleanup`'s check when its timer fires: `<data>/update` goes unless this process is handing over (or
/// staging for it) or an installer started by an update window may still be running (the 5 min install timeout).
pub fn update_dir_cleanup_allowed(data_dir: &Path, current_version: &str, busy_here: bool, now_ms: f64) -> bool {
    !busy_here && !install_in_progress(data_dir, current_version, INSTALL_TIMEOUT_MS as f64, now_ms)
}

/// Removes `<data>/update` (best effort; the next start retries). A junction in its place is removed as a link.
pub fn remove_update_dir(data_dir: &Path) -> bool {
    let dir = update_dir(data_dir);
    match fs::symlink_metadata(&dir) {
        Err(_) => true,
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => remove_link_or_file(&dir).is_ok(),
        Ok(_) => fs::remove_dir_all(&dir).is_ok(),
    }
}

/// The installer copy electron-builder's NSIS installer stores for differential updates (`APP_INSTALLER_STORE_FILE`).
const ELECTRON_INSTALLER_COPY: &str = "installer.exe";
/// electron-updater's record of the downloaded update (`pending/update-info.json`: `{fileName, sha512, ...}`).
const ELECTRON_UPDATE_INFO: &str = "update-info.json";

fn plain_file_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':']) && !name.starts_with('.')
}

/// The version in an electron-builder setup name (`unimux-Setup-1.2.0.exe`).
fn setup_version(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".exe").or_else(|| name.strip_suffix(".EXE"))?;
    let version = stem.rsplit_once("-Setup-")?.1;
    let first = version.chars().next()?;
    (first.is_ascii_digit() && version.split('.').count() >= 3).then(|| version.to_string())
}

/// What electron-updater left in `root` (`%LOCALAPPDATA%\unimux-updater`) that 1.2.x never uses: the stored installer copy,
/// `pending/update-info.json`, the setup it names and its `temp-` download. The setup goes only when it is the running
/// version or an older one (never a newer download of the Tauri updater, which shares `pending/` and never writes
/// `update-info.json`). Only plain files directly in those two folders are ever listed.
pub fn electron_updater_leftovers(root: &Path, running_version: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let copy = root.join(ELECTRON_INSTALLER_COPY);
    if is_plain_file(&copy) {
        out.push(copy);
    }
    let pending = root.join("pending");
    let info_path = pending.join(ELECTRON_UPDATE_INFO);
    if !is_plain_file(&info_path) {
        return out;
    }
    let named = fs::read_to_string(&info_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("fileName").and_then(|f| f.as_str()).map(str::to_string))
        .filter(|name| plain_file_name(name));
    if let Some(name) = named
        && setup_version(&name).is_some_and(|v| compare_versions(running_version, &v) != Ordering::Less)
    {
        for candidate in [pending.join(&name), pending.join(format!("temp-{name}"))] {
            if is_plain_file(&candidate) {
                out.push(candidate);
            }
        }
    }
    out.push(info_path);
    out
}

fn is_plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

/// Removes [`electron_updater_leftovers`]; a file still in use stays for the next start. Returns how many went.
pub fn remove_electron_updater_leftovers(root: &Path, running_version: &str) -> usize {
    electron_updater_leftovers(root, running_version).iter().filter(|f| fs::remove_file(f).is_ok()).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(dir: &str) -> String {
        // The exact one-liner of src/updatesplash/index.ts (1.1.4).
        format!(
            "setTimeout(()=>{{try{{require('fs').rmSync({},{{recursive:true,force:true,maxRetries:10,retryDelay:500}})}}catch{{}}}},3000)",
            serde_json::to_string(dir).unwrap()
        )
    }

    #[test]
    fn eval_call_needs_run_as_node_and_e() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(eval_call(Some("1"), &args(&["unimux.exe", "-e", "x"])), Some("x".into()));
        assert_eq!(eval_call(Some("true"), &args(&["unimux.exe", "--eval", "y"])), Some("y".into()));
        assert_eq!(eval_call(Some("1"), &args(&["unimux.exe", "-e"])), Some(String::new()));
        assert_eq!(eval_call(Some(""), &args(&["unimux.exe", "-e", "x"])), None);
        assert_eq!(eval_call(None, &args(&["unimux.exe", "-e", "x"])), None);
        assert_eq!(eval_call(Some("1"), &args(&["unimux.exe"])), None);
    }

    #[test]
    fn parses_the_1_1_4_one_liner() {
        let dir = r#"C:\Users\Zoë "x"\AppData\Roaming\unimux\update\runtime"#;
        assert_eq!(parse_eval_runtime_dir(&script(dir)), Some(PathBuf::from(dir)));
        assert_eq!(parse_eval_runtime_dir("console.log(1)"), None);
        assert_eq!(parse_eval_runtime_dir("require('fs').rmSync(dir)"), None);
        assert_eq!(parse_eval_runtime_dir("rmSync(\"unterminated"), None);
        assert_eq!(parse_eval_runtime_dir("rmSync(\"\")"), None);
    }

    #[test]
    fn only_a_known_runtime_dir_is_removed() {
        let app_data = PathBuf::from(r"C:\Users\u\AppData\Roaming");
        let candidates = runtime_dir_candidates(&app_data, None);
        let ok = r"C:\Users\u\AppData\Roaming\unimux\update\runtime";
        assert_eq!(eval_cleanup_target(&script(ok), &candidates), Some(candidates[0].clone()));
        let legacy = r"C:\Users\u\AppData\Roaming\ajzakomator\update\runtime";
        assert_eq!(eval_cleanup_target(&script(legacy), &candidates), Some(candidates[1].clone()));
        for bad in [
            r"C:\Users\u\AppData\Roaming\unimux",
            r"C:\Users\u\AppData\Roaming\unimux\update",
            r"C:\Users\u\AppData\Roaming\unimux\update\runtime\..\..",
            r"C:\Windows",
            r"D:\elsewhere\update\runtime",
        ] {
            assert_eq!(eval_cleanup_target(&script(bad), &candidates), None, "{bad}");
        }
        let dev = PathBuf::from(r"D:\scratch\data");
        let with_dev = runtime_dir_candidates(&app_data, Some(&dev));
        assert!(eval_cleanup_target(&script(r"D:\scratch\data\update\runtime"), &with_dev).is_some());
        assert!(eval_cleanup_target(&script(r"D:\scratch\data\update\runtime"), &candidates).is_none());
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn same_path_ignores_case_and_separators() {
        assert!(same_path(Path::new(r"C:\A\Update\Runtime\"), Path::new("c:/a/update/runtime")));
    }

    #[test]
    fn eval_cleanup_removes_the_runtime_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("unimux");
        let runtime = update_dir(&data).join("runtime");
        fs::create_dir_all(runtime.join("resources")).unwrap();
        fs::write(runtime.join("unimux-update.exe"), b"x").unwrap();
        fs::write(data.join("state.json"), b"{}").unwrap();
        let candidates = runtime_dir_candidates(tmp.path(), None);
        assert_eq!(run_eval_cleanup(&script(&runtime.to_string_lossy()), &candidates, Duration::ZERO), 0);
        assert!(!runtime.exists());
        assert!(data.join("state.json").exists());
        assert!(update_dir(&data).exists());
        // A call naming the data dir itself removes nothing.
        assert_eq!(run_eval_cleanup(&script(&data.to_string_lossy()), &candidates, Duration::ZERO), 0);
        assert!(data.join("state.json").exists());
    }

    #[test]
    fn update_dir_cleanup_waits_for_a_running_install() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let work = update_dir(data).join("work");
        fs::create_dir_all(&work).unwrap();
        fs::write(work.join("config.json"), r#"{"version":"1.2.1"}"#).unwrap();
        let now = unimux_core::time::now_ms() as f64;
        // A fresh attempt for another version: the installer may still run.
        assert!(!update_dir_cleanup_allowed(data, "1.2.0", false, now));
        // The attempt targeted this version: it is done.
        assert!(update_dir_cleanup_allowed(data, "1.2.1", false, now));
        // This process hands over: never.
        assert!(!update_dir_cleanup_allowed(data, "1.2.1", true, now));
        // Older than the install timeout and no heartbeat: done.
        assert!(update_dir_cleanup_allowed(data, "1.2.0", false, now + INSTALL_TIMEOUT_MS as f64 + 1000.0));
        assert!(remove_update_dir(data));
        assert!(!update_dir(data).exists());
        assert!(remove_update_dir(data));
    }

    #[test]
    fn electron_updater_leftovers_spare_the_tauri_download() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("unimux-updater");
        let pending = root.join("pending");
        fs::create_dir_all(&pending).unwrap();
        fs::create_dir_all(root.join("runtime-1.2.1")).unwrap();
        fs::write(root.join("installer.exe"), b"x").unwrap();
        fs::write(pending.join("unimux-Setup-1.2.0.exe"), b"x").unwrap();
        fs::write(pending.join("temp-unimux-Setup-1.2.0.exe"), b"x").unwrap();
        fs::write(pending.join("unimux-Setup-1.2.1.exe"), b"tauri download").unwrap();
        fs::write(pending.join("update-info.json"), r#"{"fileName":"unimux-Setup-1.2.0.exe","sha512":"x"}"#).unwrap();
        let mut found = electron_updater_leftovers(&root, "1.2.0");
        found.sort();
        let mut expected = vec![
            root.join("installer.exe"),
            pending.join("temp-unimux-Setup-1.2.0.exe"),
            pending.join("unimux-Setup-1.2.0.exe"),
            pending.join("update-info.json"),
        ];
        expected.sort();
        assert_eq!(found, expected);
        assert_eq!(remove_electron_updater_leftovers(&root, "1.2.0"), 4);
        assert!(pending.join("unimux-Setup-1.2.1.exe").exists());
        assert!(root.join("runtime-1.2.1").exists());
        // Nothing left to do; the Tauri download stays.
        assert!(electron_updater_leftovers(&root, "1.2.0").is_empty());
    }

    #[test]
    fn electron_updater_leftovers_refuse_odd_names_and_newer_setups() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("unimux-updater");
        let pending = root.join("pending");
        fs::create_dir_all(&pending).unwrap();
        for name in [r"..\..\state.json", "unimux-Setup-1.3.0.exe", "notes.txt"] {
            fs::write(pending.join("update-info.json"), serde_json::json!({ "fileName": name }).to_string()).unwrap();
            assert_eq!(electron_updater_leftovers(&root, "1.2.0"), vec![pending.join("update-info.json")], "{name}");
        }
        assert_eq!(setup_version("unimux-Setup-1.2.0.exe").as_deref(), Some("1.2.0"));
        assert_eq!(setup_version("unimux-Setup-x.exe"), None);
    }
}
