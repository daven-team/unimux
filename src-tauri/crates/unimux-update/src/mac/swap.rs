//! The bundle swap of the macOS update window (port of the /bin/sh install script of src/main/macUpdate/script.ts).
//!
//! 1.1.4 handed the swap to a detached shell script because nothing could show progress once the app had quit. In 1.2.0 the
//! update window (a copy of the app's binary outside the bundle, PLAN U5) runs the same steps itself, with the same rules:
//! every failure path leaves the old app in place or puts it back, starts it and writes the `rolled-back` flag with the target
//! version (the next start reports the failed update through `finish_previous`). A removal is always checked, because a
//! removal that stopped halfway leaves a directory behind and a later rename would fail or (with `mv`) nest the source in it.
//!
//! The steps are split so the window can show its stages: [`swap`] (old app aside, new one in place, quarantine cleared),
//! [`launch_new`] (start the new app; a failure restores the old one) and, once the new app reported ready, [`complete`]
//! (backup and downloaded files removed). File operations go through [`SwapOps`] so the failure cases of the script tests
//! (a failing move, a move that copies, a removal that stops halfway, `open` failing) run on any platform.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What the update window needs for the swap; part of `work/config.json` (`swap`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSwapPlan {
    /// The installed `.app`.
    pub bundle: PathBuf,
    /// The verified new `.app`, staged next to `bundle` (`<bundle>.new-<version>`: same directory, so the swap is two renames).
    pub new_bundle: PathBuf,
    /// Where the old bundle is parked during the swap (`<bundle>.old-<from>`).
    pub backup: PathBuf,
    /// Name of the executable inside `Contents/MacOS` of the new bundle.
    pub executable: String,
    /// `updates/mac/update.log`.
    pub log: PathBuf,
    /// `updates/mac/ready`: the new app's markReady writes it (removed before the new app starts).
    pub ready_flag: PathBuf,
    /// `updates/mac/rolled-back`: written with the target version when the update failed and the old app stayed or came back.
    pub failed_flag: PathBuf,
    /// Removed after a confirmed start (the downloaded archive, the extraction folder).
    pub cleanup: Vec<PathBuf>,
    pub from_version: String,
    pub to_version: String,
}

impl BundleSwapPlan {
    fn new_exe(&self) -> PathBuf {
        self.new_bundle.join("Contents").join("MacOS").join(&self.executable)
    }
    fn installed_exe(&self) -> PathBuf {
        self.bundle.join("Contents").join("MacOS").join(&self.executable)
    }
}

/// The file system and process steps of the swap.
pub trait SwapOps {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// `rm -rf`: a missing path is fine.
    fn remove_all(&self, path: &Path) -> io::Result<()>;
    /// `[ -e p ] || [ -L p ]`.
    fn exists(&self, path: &Path) -> bool {
        path.symlink_metadata().is_ok()
    }
    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
    /// `xattr -cr <bundle>` (failures ignored).
    fn clear_quarantine(&self, bundle: &Path);
    /// `open <bundle>`: Ok when the app was started.
    fn open(&self, bundle: &Path) -> io::Result<()>;
}

/// The real steps: renames and removals of std, `/usr/bin/xattr` and `/usr/bin/open` on macOS (elsewhere the executable is
/// started directly; only tests and the Windows build ever get there).
pub struct RealSwapOps;

/// The environment of the system tools: never whatever the app was started with (`SCRIPT_ENV` of runtime.ts).
pub fn tool_env() -> std::collections::HashMap<std::ffi::OsString, std::ffi::OsString> {
    let mut env = std::collections::HashMap::new();
    env.insert("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into());
    env.insert("HOME".into(), std::env::var_os("HOME").unwrap_or_default());
    env.insert("LANG".into(), "en_US.UTF-8".into());
    env
}

impl SwapOps for RealSwapOps {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)
    }

    fn remove_all(&self, path: &Path) -> io::Result<()> {
        match path.symlink_metadata() {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
            Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
            Ok(_) => std::fs::remove_file(path),
        }
    }

    fn clear_quarantine(&self, bundle: &Path) {
        if cfg!(target_os = "macos") {
            let _ = std::process::Command::new("/usr/bin/xattr")
                .arg("-cr")
                .arg(bundle)
                .env_clear()
                .envs(tool_env())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }

    fn open(&self, bundle: &Path) -> io::Result<()> {
        if cfg!(target_os = "macos") {
            let status = std::process::Command::new("/usr/bin/open")
                .arg(bundle)
                .env_clear()
                .envs(tool_env())
                .current_dir("/")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()?;
            return if status.success() { Ok(()) } else { Err(io::Error::other(format!("open exited with {status}"))) };
        }
        // Not macOS: start the executable of the bundle directly (the swap is only ever used on macOS).
        let macos = bundle.join("Contents").join("MacOS");
        let exe = std::fs::read_dir(&macos)?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.is_file())
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        let program = unimux_exec::Program::Args { program: exe, args: vec![] };
        unimux_exec::spawn_detached(&program, None, Some(macos)).map(|_| ()).map_err(io::Error::other)
    }
}

/// How a failed step ended (the window shows its failure text for both; the log says which).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapFailure {
    /// The log line of the step that failed.
    pub reason: String,
    /// The old app is in place (never moved, or put back) and was started again.
    pub old_app_in_place: bool,
}

struct Run<'a> {
    plan: &'a BundleSwapPlan,
    ops: &'a dyn SwapOps,
    log: &'a dyn Fn(&str),
}

impl Run<'_> {
    /// `remove_path`: removes and checks that nothing is left.
    fn remove_path(&self, path: &Path) -> bool {
        let _ = self.ops.remove_all(path);
        !self.ops.exists(path)
    }

    fn launch_old(&self) {
        if self.ops.open(&self.plan.bundle).is_err() {
            (self.log)(&format!("could not start {}", self.plan.bundle.display()));
        }
    }

    fn mark_failed(&self) {
        let _ = std::fs::write(&self.plan.failed_flag, format!("{}\n", self.plan.to_version));
    }

    fn restore_old(&self) -> bool {
        let p = self.plan;
        if !self.remove_path(&p.bundle) {
            (self.log)(&format!(
                "ROLLBACK FAILED: {} could not be removed, the previous version is at {}",
                p.bundle.display(),
                p.backup.display()
            ));
            return false;
        }
        if self.ops.rename(&p.backup, &p.bundle).is_err() || self.ops.exists(&p.backup) || !self.ops.is_dir(&p.bundle) {
            (self.log)(&format!("ROLLBACK FAILED: the previous version is at {}", p.backup.display()));
            return false;
        }
        (self.log)("the previous version was restored");
        true
    }

    /// After the old app was moved aside: say why, put it back, start it, remember the failure.
    fn fail_and_restore(&self, why: &str) -> SwapFailure {
        (self.log)(why);
        let restored = self.restore_old();
        if restored {
            self.launch_old();
        }
        self.mark_failed();
        SwapFailure { reason: why.to_string(), old_app_in_place: restored }
    }

    /// Before anything was changed: the old app is still in place.
    fn fail_unchanged(&self, why: &str) -> SwapFailure {
        (self.log)(&format!("{why}, nothing was changed"));
        self.launch_old();
        self.mark_failed();
        SwapFailure { reason: why.to_string(), old_app_in_place: true }
    }
}

/// Puts the new bundle in place of the old one (the old app must have exited). On failure the old app is in place (or the
/// log says where it is), it was started again and `rolled-back` names the target version.
pub fn swap(plan: &BundleSwapPlan, ops: &dyn SwapOps, log: &dyn Fn(&str)) -> Result<(), SwapFailure> {
    let run = Run { plan, ops, log };
    let p = plan;
    log(&format!("update {} -> {}: the app has exited, replacing {}", p.from_version, p.to_version, p.bundle.display()));
    if !ops.is_file(&p.new_exe()) {
        return Err(run.fail_unchanged("the staged app is missing"));
    }
    if !run.remove_path(&p.backup) {
        return Err(run.fail_unchanged("an earlier backup could not be removed"));
    }
    if ops.rename(&p.bundle, &p.backup).is_err() {
        return Err(run.fail_unchanged("the old app could not be moved aside"));
    }
    if ops.exists(&p.bundle) {
        return Err(run.fail_and_restore("the old app is still in place after moving it aside"));
    }
    if ops.rename(&p.new_bundle, &p.bundle).is_err() {
        return Err(run.fail_and_restore("the new app could not be moved into place, restoring the previous version"));
    }
    if !ops.is_file(&p.installed_exe()) || ops.exists(&p.new_bundle) {
        return Err(run.fail_and_restore("the new app is not in place, restoring the previous version"));
    }
    ops.clear_quarantine(&p.bundle);
    log("the new app is in place");
    Ok(())
}

/// Starts the new app (after [`swap`]). `ready_flags` are removed first, so only the new app's own report counts. A start that
/// fails restores the old app.
pub fn launch_new(
    plan: &BundleSwapPlan,
    ready_flags: &[&Path],
    ops: &dyn SwapOps,
    log: &dyn Fn(&str),
) -> Result<(), SwapFailure> {
    let run = Run { plan, ops, log };
    let _ = std::fs::remove_file(&plan.ready_flag);
    for flag in ready_flags {
        let _ = std::fs::remove_file(flag);
    }
    if ops.open(&plan.bundle).is_err() {
        return Err(run.fail_and_restore("the new app could not be opened, restoring the previous version"));
    }
    log(&format!("started {}", plan.bundle.display()));
    Ok(())
}

/// The new app reported ready: the previous version and the downloaded files go.
pub fn complete(plan: &BundleSwapPlan, ops: &dyn SwapOps, log: &dyn Fn(&str)) {
    log(&format!("the new app is running, update {} -> {} complete", plan.from_version, plan.to_version));
    let _ = ops.remove_all(&plan.backup);
    for path in &plan.cleanup {
        let _ = ops.remove_all(path);
    }
}

/// The new app did not report ready in time: the previous version stays as the backup (the new app's markReady removes it
/// once it comes up).
pub fn ready_timed_out(plan: &BundleSwapPlan, seconds: u64, log: &dyn Fn(&str)) {
    log(&format!(
        "the new app did not report ready within {seconds} seconds; the previous version stays at {}",
        plan.backup.display()
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;

    /// The stubs of test/mac-update-script.test.ts's sandbox.
    #[derive(Default)]
    struct Stubs {
        fail_move_new: bool,
        fail_open: bool,
        /// Removing the installed bundle stops halfway (the executable goes, the folder stays) and fails.
        rm_fails_on_bundle: bool,
        /// Removing a backup does nothing and fails.
        rm_fails_on_backup: bool,
        /// Moving the installed bundle copies it (the source stays behind).
        mv_copies_bundle: bool,
        /// Plays the new app: writes this file when opened (it reports ready).
        make_ready: Option<PathBuf>,
        calls: RefCell<Vec<String>>,
    }

    fn name(p: &Path) -> String {
        p.file_name().unwrap().to_string_lossy().into_owned()
    }

    fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
        fs::create_dir_all(to)?;
        for e in fs::read_dir(from)? {
            let e = e?;
            if e.file_type()?.is_dir() {
                copy_dir(&e.path(), &to.join(e.file_name()))?;
            } else {
                fs::copy(e.path(), to.join(e.file_name()))?;
            }
        }
        Ok(())
    }

    impl SwapOps for Stubs {
        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.calls.borrow_mut().push(format!("mv {} {}", name(from), name(to)));
            if self.fail_move_new && name(from).contains(".new-") {
                return Err(io::Error::other("mv refused"));
            }
            if self.mv_copies_bundle && name(from) == "unimux.app" {
                return copy_dir(from, to);
            }
            fs::rename(from, to)
        }
        fn remove_all(&self, path: &Path) -> io::Result<()> {
            self.calls.borrow_mut().push(format!("rm {}", name(path)));
            if self.rm_fails_on_bundle && name(path) == "unimux.app" {
                let _ = fs::remove_file(path.join("Contents").join("MacOS").join("unimux"));
                return Err(io::Error::other("rm stopped"));
            }
            if self.rm_fails_on_backup && name(path).contains(".old-") {
                return Err(io::Error::other("rm refused"));
            }
            RealSwapOps.remove_all(path)
        }
        fn clear_quarantine(&self, bundle: &Path) {
            self.calls.borrow_mut().push(format!("xattr -cr {}", name(bundle)));
        }
        fn open(&self, bundle: &Path) -> io::Result<()> {
            self.calls.borrow_mut().push(format!("open {}", name(bundle)));
            if self.fail_open {
                return Err(io::Error::other("open failed"));
            }
            if let Some(ready) = &self.make_ready {
                fs::write(ready, "").unwrap();
            }
            Ok(())
        }
    }

    struct Box_ {
        _tmp: tempfile::TempDir,
        plan: BundleSwapPlan,
        lines: RefCell<Vec<String>>,
    }

    impl Box_ {
        fn log(&self) -> impl Fn(&str) + '_ {
            |line: &str| self.lines.borrow_mut().push(line.to_string())
        }
        fn logged(&self) -> String {
            self.lines.borrow().join("\n")
        }
        fn exe(&self, bundle: &Path) -> String {
            fs::read_to_string(bundle.join("Contents").join("MacOS").join("unimux")).unwrap_or_default()
        }
        fn failed(&self) -> String {
            fs::read_to_string(&self.plan.failed_flag).unwrap_or_default().trim().to_string()
        }
    }

    /// An installed app, a staged update next to it (in a folder whose name a shell would interpret), the staging files.
    fn sandbox() -> Box_ {
        let tmp = tempfile::tempdir().unwrap();
        let apps = tmp.path().join("Apps it's $(touch pwned); `id` & (x)");
        let stage = tmp.path().join("stage dir");
        let bundle = apps.join("unimux.app");
        let new_bundle = apps.join("unimux.app.new-0.7.0");
        for dir in [bundle.join("Contents/MacOS"), new_bundle.join("Contents/MacOS"), stage.join("extracted-0.7.0")] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(bundle.join("Contents/MacOS/unimux"), "old").unwrap();
        fs::write(new_bundle.join("Contents/MacOS/unimux"), "new").unwrap();
        fs::write(stage.join("unimux-0.7.0-mac-arm64.app.tar.gz"), "tgz").unwrap();
        let plan = BundleSwapPlan {
            backup: apps.join("unimux.app.old-0.6.5"),
            bundle,
            new_bundle,
            executable: "unimux".into(),
            log: stage.join("update.log"),
            ready_flag: stage.join("ready"),
            failed_flag: stage.join("rolled-back"),
            cleanup: vec![stage.join("extracted-0.7.0"), stage.join("unimux-0.7.0-mac-arm64.app.tar.gz")],
            from_version: "0.6.5".into(),
            to_version: "0.7.0".into(),
        };
        Box_ { _tmp: tmp, plan, lines: RefCell::new(vec![]) }
    }

    #[test]
    fn swaps_the_app_clears_the_quarantine_starts_it_and_cleans_up_once_ready() {
        let b = sandbox();
        let ops = Stubs { make_ready: Some(b.plan.ready_flag.clone()), ..Default::default() };
        let other_ready = b.plan.failed_flag.with_file_name("update-ready");
        fs::write(&other_ready, "stale").unwrap();
        swap(&b.plan, &ops, &b.log()).unwrap();
        assert_eq!(b.exe(&b.plan.bundle), "new");
        assert!(!b.plan.new_bundle.exists());
        assert_eq!(b.exe(&b.plan.backup), "old");
        launch_new(&b.plan, &[&other_ready], &ops, &b.log()).unwrap();
        assert!(!other_ready.exists(), "a stale ready flag is removed before the start");
        assert!(b.plan.ready_flag.exists());
        complete(&b.plan, &ops, &b.log());
        assert!(!b.plan.backup.exists());
        assert!(b.plan.cleanup.iter().all(|p| !p.exists()));
        assert!(!b.plan.failed_flag.exists());
        assert!(!b._tmp.path().join("pwned").exists());
        let calls = ops.calls.borrow().join("\n");
        assert!(calls.contains("xattr -cr unimux.app") && calls.contains("open unimux.app"), "{calls}");
        assert!(b.logged().contains("update 0.6.5 -> 0.7.0 complete"));
    }

    #[test]
    fn keeps_the_previous_version_when_the_new_app_never_reports_ready() {
        let b = sandbox();
        let ops = Stubs::default();
        swap(&b.plan, &ops, &b.log()).unwrap();
        launch_new(&b.plan, &[], &ops, &b.log()).unwrap();
        ready_timed_out(&b.plan, 30, &b.log());
        assert_eq!(b.exe(&b.plan.bundle), "new");
        assert_eq!(b.exe(&b.plan.backup), "old");
        assert!(b.logged().contains("did not report ready"));
    }

    #[test]
    fn restores_starts_and_flags_when_the_new_app_cannot_be_moved_into_place() {
        let b = sandbox();
        let ops = Stubs { fail_move_new: true, ..Default::default() };
        let failure = swap(&b.plan, &ops, &b.log()).unwrap_err();
        assert!(failure.old_app_in_place);
        assert_eq!(b.exe(&b.plan.bundle), "old");
        assert!(!b.plan.backup.exists());
        assert!(!b.plan.bundle.join("unimux.app.old-0.6.5").exists());
        assert!(b.logged().contains("restoring the previous version"));
        assert!(b.logged().contains("previous version was restored"));
        assert!(ops.calls.borrow().iter().any(|c| c == "open unimux.app"));
        assert_eq!(b.failed(), "0.7.0");
        // The staged files stay for a later attempt.
        assert!(b.plan.new_bundle.exists());
    }

    #[test]
    fn restores_the_old_app_when_the_new_one_cannot_be_opened() {
        let b = sandbox();
        let ops = Stubs { fail_open: true, ..Default::default() };
        swap(&b.plan, &ops, &b.log()).unwrap();
        let failure = launch_new(&b.plan, &[], &ops, &b.log()).unwrap_err();
        assert!(failure.old_app_in_place);
        assert_eq!(b.exe(&b.plan.bundle), "old");
        assert!(!b.plan.backup.exists());
        assert!(b.logged().contains("could not be opened"));
        assert_eq!(b.failed(), "0.7.0");
    }

    #[test]
    fn changes_nothing_relaunches_and_flags_when_the_staged_bundle_is_missing() {
        let b = sandbox();
        fs::remove_dir_all(&b.plan.new_bundle).unwrap();
        let ops = Stubs::default();
        let failure = swap(&b.plan, &ops, &b.log()).unwrap_err();
        assert!(failure.old_app_in_place);
        assert_eq!(b.exe(&b.plan.bundle), "old");
        assert!(!b.plan.backup.exists());
        assert!(b.logged().contains("staged app is missing, nothing was changed"));
        assert_eq!(b.failed(), "0.7.0");
        assert_eq!(ops.calls.borrow().iter().filter(|c| c.starts_with("open")).count(), 1);
    }

    #[test]
    fn reports_a_failed_rollback_and_never_nests_the_old_app() {
        // The new app is in place but cannot be opened; removing it for the rollback stops halfway and fails.
        let b = sandbox();
        let ops = Stubs { fail_open: true, rm_fails_on_bundle: true, ..Default::default() };
        swap(&b.plan, &ops, &b.log()).unwrap();
        let failure = launch_new(&b.plan, &[], &ops, &b.log()).unwrap_err();
        assert!(!failure.old_app_in_place);
        let log = b.logged();
        assert!(log.contains("ROLLBACK FAILED") && log.contains("the previous version is at"), "{log}");
        assert!(!log.contains("previous version was restored"));
        assert_eq!(b.exe(&b.plan.backup), "old");
        assert!(!b.plan.bundle.join("unimux.app.old-0.6.5").exists());
        assert!(!b.plan.bundle.join("unimux.app").exists());
        // Only the failed start of the new app; the old one is not started from a broken place.
        assert_eq!(ops.calls.borrow().iter().filter(|c| c.starts_with("open")).count(), 1);
        assert_eq!(b.failed(), "0.7.0");
    }

    #[test]
    fn refuses_when_an_older_backup_cannot_be_removed() {
        let b = sandbox();
        fs::create_dir_all(b.plan.backup.join("Contents")).unwrap();
        fs::write(b.plan.backup.join("Contents").join("stale"), "x").unwrap();
        let ops = Stubs { rm_fails_on_backup: true, ..Default::default() };
        let failure = swap(&b.plan, &ops, &b.log()).unwrap_err();
        assert!(failure.old_app_in_place);
        assert_eq!(b.exe(&b.plan.bundle), "old");
        assert!(!b.plan.backup.join("unimux.app").exists());
        assert!(b.plan.new_bundle.exists());
        assert!(b.logged().contains("earlier backup could not be removed"));
        assert_eq!(b.failed(), "0.7.0");
    }

    #[test]
    fn rolls_back_when_the_old_app_is_still_in_place_after_being_moved_aside() {
        let b = sandbox();
        let ops = Stubs { mv_copies_bundle: true, ..Default::default() };
        let failure = swap(&b.plan, &ops, &b.log()).unwrap_err();
        assert!(failure.old_app_in_place);
        assert_eq!(b.exe(&b.plan.bundle), "old");
        assert!(!b.plan.backup.exists());
        assert!(!b.plan.bundle.join("unimux.app.old-0.6.5").exists());
        assert!(!b.plan.bundle.join("unimux.app.new-0.7.0").exists());
        assert!(b.logged().contains("still in place"));
        assert_eq!(b.failed(), "0.7.0");
    }

    #[test]
    fn the_plan_travels_in_the_config_with_camel_case_keys() {
        let b = sandbox();
        let value = serde_json::to_value(&b.plan).unwrap();
        let keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "bundle",
                "newBundle",
                "backup",
                "executable",
                "log",
                "readyFlag",
                "failedFlag",
                "cleanup",
                "fromVersion",
                "toVersion"
            ]
        );
        let back: BundleSwapPlan = serde_json::from_value(value).unwrap();
        assert_eq!(back, b.plan);
    }

    #[test]
    fn the_real_ops_swap_a_scratch_bundle() {
        let b = sandbox();
        // RealSwapOps.open on this platform starts the bundle's executable; only the swap itself is exercised here.
        swap(&b.plan, &RealSwapOps, &b.log()).unwrap();
        assert_eq!(b.exe(&b.plan.bundle), "new");
        complete(&b.plan, &RealSwapOps, &b.log());
        assert!(!b.plan.backup.exists());
        assert!(RealSwapOps.remove_all(&b.plan.backup).is_ok(), "a missing path is fine");
    }
}
