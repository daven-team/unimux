//! Port of src/main/dataDirMigration.ts: the one-time move of the data directory from the previous product name
//! (`ajzakomator`) to `unimux`, before anything touches the data directory. Nothing is ever deleted: the old directory is
//! renamed (atomic on one volume) and a link (a junction on Windows) is left at the old path, so update windows of older
//! versions, the NSIS installer and a downgraded build still reach the same files.
//!
//! Also the one-time copy of `MultiCoding/state.json` (the app's earliest name) into a data dir without a state.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::time::{file_stamp, now_ms};

pub const LEGACY_DATA_DIR_NAME: &str = "ajzakomator";
pub const DATA_DIR_NAME: &str = "unimux";
/// Written into the new directory after a successful rename; tells later starts that the link at the old path is ours.
pub const MIGRATION_MARKER: &str = "migrated-from.json";

/// What exists at a path (`lstat`): None when nothing does (a dangling link still exists).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lstat {
    pub is_dir: bool,
    pub is_link: bool,
}

/// The file operations of the migration (seams for tests).
pub trait MigrationFs {
    fn lstat(&self, path: &Path) -> Option<Lstat>;
    fn exists(&self, path: &Path) -> bool;
    fn realpath(&self, path: &Path) -> Option<PathBuf>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// Creates a directory link at `path` pointing to `target` (a junction on Windows: no admin rights or developer mode).
    fn symlink(&self, target: &Path, path: &Path) -> io::Result<()>;
    fn write_file(&self, path: &Path, data: &str) -> io::Result<()>;
}

/// The real file system.
#[derive(Debug, Default, Clone, Copy)]
pub struct RealFs;

impl MigrationFs for RealFs {
    fn lstat(&self, path: &Path) -> Option<Lstat> {
        let meta = fs::symlink_metadata(path).ok()?;
        let ft = meta.file_type();
        #[cfg(windows)]
        let is_link = ft.is_symlink() || junction::exists(path).unwrap_or(false);
        #[cfg(not(windows))]
        let is_link = ft.is_symlink();
        Some(Lstat { is_dir: ft.is_dir() && !is_link, is_link })
    }
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn realpath(&self, path: &Path) -> Option<PathBuf> {
        dunce::canonicalize(path).ok()
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }
    fn symlink(&self, target: &Path, path: &Path) -> io::Result<()> {
        #[cfg(windows)]
        {
            junction::create(target, path)
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, path)
        }
    }
    fn write_file(&self, path: &Path, data: &str) -> io::Result<()> {
        fs::write(path, data)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationAction {
    /// `MC_DATA_DIR` is set (dev-overrides builds only): no migration.
    Override,
    /// Nothing to move (fresh install, already migrated, or the old path is our link).
    Current,
    /// Moved and linked.
    Migrated,
    /// Moved, but the link at the old path could not be created (retried on the next start).
    MigratedWithoutLink,
    /// A run from the repository found the old directory: it uses it and never moves it.
    NotPackaged,
    /// The old path is a link the user made to another place: it stays the data directory.
    UserLink,
    /// The old directory is in use (an update window still supervises an install).
    Deferred,
    /// A rename failed (locked files): the old directory is used for this run.
    RenameFailed,
    /// Both directories hold a state: the new one is used, the old one is left alone.
    BothExist,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationResult {
    pub data_dir: PathBuf,
    pub action: MigrationAction,
}

pub struct MigrationOptions<'a> {
    pub app_data: PathBuf,
    /// `MC_DATA_DIR` (already None in builds without dev-overrides).
    pub override_dir: Option<PathBuf>,
    /// Only the installed app moves the directory; a run from the repository never does.
    pub packaged: bool,
    pub fs: &'a dyn MigrationFs,
    pub now: i64,
    /// True while something still works inside the old directory (the update window of the previous version).
    pub busy: &'a dyn Fn(&Path) -> bool,
    pub log: &'a dyn Fn(&str),
}

impl<'a> MigrationOptions<'a> {
    /// Real file system, current time, no busy check, no log.
    pub fn new(app_data: PathBuf, override_dir: Option<PathBuf>, packaged: bool) -> Self {
        Self { app_data, override_dir, packaged, fs: &RealFs, now: now_ms(), busy: &|_| false, log: &|_| {} }
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    let a = a.to_string_lossy();
    let b = b.to_string_lossy();
    if cfg!(windows) || cfg!(target_os = "macos") { a.to_lowercase() == b.to_lowercase() } else { a == b }
}

/// Decides the data directory for this run and moves the old one when it is safe to.
pub fn migrate_data_dir(o: &MigrationOptions<'_>) -> MigrationResult {
    if !o.packaged
        && let Some(dir) = &o.override_dir
    {
        return MigrationResult { data_dir: dir.clone(), action: MigrationAction::Override };
    }
    let fs = o.fs;
    let log = o.log;
    let legacy = o.app_data.join(LEGACY_DATA_DIR_NAME);
    let current = o.app_data.join(DATA_DIR_NAME);
    let link = || -> bool {
        match fs.symlink(&current, &legacy) {
            Ok(()) => true,
            Err(e) => {
                log(&format!(
                    "data directory: the link {} -> {} could not be created ({e}), retrying on the next start",
                    legacy.display(),
                    current.display()
                ));
                false
            }
        }
    };
    let done = |dir: &Path, action| MigrationResult { data_dir: dir.to_path_buf(), action };

    let Some(old) = fs.lstat(&legacy) else {
        if fs.exists(&current.join(MIGRATION_MARKER)) {
            link();
        }
        return done(&current, MigrationAction::Current);
    };
    if old.is_link {
        let target = fs.realpath(&legacy);
        let ours = match &target {
            None => true,
            Some(t) => same_path(t, &fs.realpath(&current).unwrap_or_else(|| current.clone())),
        };
        if !ours {
            log(&format!(
                "data directory: {} links to {}, kept as the data directory",
                legacy.display(),
                target.as_ref().map(|t| t.display().to_string()).unwrap_or_default()
            ));
            return done(&legacy, MigrationAction::UserLink);
        }
        return done(&current, MigrationAction::Current);
    }
    if !old.is_dir {
        return done(&current, MigrationAction::Current);
    }
    if !o.packaged {
        return done(&legacy, MigrationAction::NotPackaged);
    }
    if (o.busy)(&legacy) {
        log(&format!("data directory: {} is still in use by an update, it is moved on a later start", legacy.display()));
        return done(&legacy, MigrationAction::Deferred);
    }

    if fs.lstat(&current).is_some() {
        let old_has_state = fs.exists(&legacy.join("state.json"));
        if fs.exists(&current.join("state.json")) || !old_has_state {
            log(&format!(
                "data directory: both {} and {} exist, using {} and leaving {} untouched",
                legacy.display(),
                current.display(),
                current.display(),
                legacy.display()
            ));
            return done(&current, MigrationAction::BothExist);
        }
        let aside = o.app_data.join(format!("{DATA_DIR_NAME}.pre-migration-{}", file_stamp(o.now)));
        if let Err(e) = fs.rename(&current, &aside) {
            log(&format!(
                "data directory: {} could not be moved aside ({e}), using {} for now",
                current.display(),
                legacy.display()
            ));
            return done(&legacy, MigrationAction::RenameFailed);
        }
        log(&format!("data directory: the previous {} (no state) was moved to {}", current.display(), aside.display()));
    }

    if let Err(e) = fs.rename(&legacy, &current) {
        if fs.lstat(&legacy).is_none() && fs.lstat(&current).is_some() {
            return done(&current, MigrationAction::Current);
        }
        log(&format!("data directory: {} could not be moved to {} ({e}), using it for now", legacy.display(), current.display()));
        return done(&legacy, MigrationAction::RenameFailed);
    }
    let marker = format!("{{\"from\":{},\"at\":{}}}", serde_json::Value::String(legacy.to_string_lossy().into_owned()), o.now);
    if let Err(e) = fs.write_file(&current.join(MIGRATION_MARKER), &marker) {
        log(&format!("data directory: the migration marker could not be written ({e})"));
    }
    if !link() {
        return done(&current, MigrationAction::MigratedWithoutLink);
    }
    log(&format!("data directory: moved {} to {}", legacy.display(), current.display()));
    done(&current, MigrationAction::Migrated)
}

/// Copies `<appData>/MultiCoding/state.json` into `data_dir` once (no override, no state there yet). Returns what happened
/// as a log line on failure.
pub fn copy_multicoding_state(app_data: &Path, data_dir: &Path, has_override: bool) -> Result<bool, String> {
    let legacy = app_data.join("MultiCoding").join("state.json");
    if has_override || data_dir.join("state.json").exists() || !legacy.exists() {
        return Ok(false);
    }
    fs::create_dir_all(data_dir).map_err(|e| format!("legacy state not copied: {e}"))?;
    fs::copy(&legacy, data_dir.join("state.json")).map_err(|e| format!("legacy state not copied: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    //! Ported from test/data-dir-migration.test.ts (PORTING.md rows data-dir-migration/*).
    use super::*;
    use std::cell::{Cell, RefCell};

    const NOW: i64 = 1_792_067_400_000; // Date.UTC(2026, 9, 15, 12, 30, 0)

    struct Env {
        _tmp: tempfile::TempDir,
        app_data: PathBuf,
        old: PathBuf,
        new: PathBuf,
    }

    fn env() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = dunce::canonicalize(tmp.path()).unwrap();
        Env { old: app_data.join("ajzakomator"), new: app_data.join("unimux"), app_data, _tmp: tmp }
    }

    fn put(file: &Path, body: &str) {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, body).unwrap();
    }
    fn read(file: &Path) -> String {
        fs::read_to_string(file).unwrap()
    }
    fn is_link(path: &Path) -> bool {
        RealFs.lstat(path).is_some_and(|l| l.is_link)
    }

    type RenameFn = Box<dyn Fn(&Path, &Path) -> io::Result<()>>;

    /// Real operations with selected ones replaced.
    #[derive(Default)]
    struct Faulty {
        rename: Option<RenameFn>,
        symlink_fails: bool,
        write_fails: bool,
    }
    impl MigrationFs for Faulty {
        fn lstat(&self, path: &Path) -> Option<Lstat> {
            RealFs.lstat(path)
        }
        fn exists(&self, path: &Path) -> bool {
            RealFs.exists(path)
        }
        fn realpath(&self, path: &Path) -> Option<PathBuf> {
            RealFs.realpath(path)
        }
        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            match &self.rename {
                Some(f) => f(from, to),
                None => RealFs.rename(from, to),
            }
        }
        fn symlink(&self, target: &Path, path: &Path) -> io::Result<()> {
            if self.symlink_fails {
                Err(io::Error::other("EPERM: operation not permitted"))
            } else {
                RealFs.symlink(target, path)
            }
        }
        fn write_file(&self, path: &Path, data: &str) -> io::Result<()> {
            if self.write_fails { Err(io::Error::other("EACCES")) } else { RealFs.write_file(path, data) }
        }
    }

    fn eperm(_: &Path, _: &Path) -> io::Result<()> {
        Err(io::Error::other("EPERM: operation not permitted"))
    }

    fn run_with(
        e: &Env,
        packaged: bool,
        override_dir: Option<PathBuf>,
        fs: &dyn MigrationFs,
        busy: &dyn Fn(&Path) -> bool,
        logs: &RefCell<Vec<String>>,
    ) -> MigrationResult {
        let log = |l: &str| logs.borrow_mut().push(l.to_string());
        migrate_data_dir(&MigrationOptions {
            app_data: e.app_data.clone(),
            override_dir,
            packaged,
            fs,
            now: NOW,
            busy,
            log: &log,
        })
    }
    fn run(e: &Env) -> MigrationResult {
        run_with(e, true, None, &RealFs, &|_| false, &RefCell::new(vec![]))
    }
    fn res(dir: &Path, action: MigrationAction) -> MigrationResult {
        MigrationResult { data_dir: dir.to_path_buf(), action }
    }

    #[test]
    fn uses_mc_data_dir_as_is_and_touches_nothing() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        let custom = e.app_data.join("custom");
        assert_eq!(
            run_with(&e, false, Some(custom.clone()), &RealFs, &|_| false, &RefCell::new(vec![])),
            res(&custom, MigrationAction::Override)
        );
        assert!(!is_link(&e.old));
        assert!(!e.new.exists());
    }

    #[test]
    fn ignores_mc_data_dir_in_the_installed_app() {
        let e = env();
        let custom = e.app_data.join("custom");
        assert_ne!(run_with(&e, true, Some(custom.clone()), &RealFs, &|_| false, &RefCell::new(vec![])).data_dir, custom);
    }

    #[test]
    fn never_moves_from_a_run_outside_the_installed_app() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        assert_eq!(
            run_with(&e, false, None, &RealFs, &|_| false, &RefCell::new(vec![])),
            res(&e.old, MigrationAction::NotPackaged)
        );
        assert!(!e.new.exists());
    }

    #[test]
    fn moves_and_leaves_a_link() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        put(&e.old.join("accounts").join("accounts.json"), "[]");
        assert_eq!(run(&e), res(&e.new, MigrationAction::Migrated));
        assert_eq!(read(&e.new.join("state.json")), "old");
        assert_eq!(read(&e.new.join("accounts").join("accounts.json")), "[]");
        assert!(is_link(&e.old));
        assert_eq!(read(&e.old.join("state.json")), "old");
        fs::write(e.old.join("ready"), "0.8.5").unwrap();
        assert_eq!(read(&e.new.join("ready")), "0.8.5");
        let marker: serde_json::Value = serde_json::from_str(&read(&e.new.join(MIGRATION_MARKER))).unwrap();
        assert_eq!(marker["from"], serde_json::Value::String(e.old.to_string_lossy().into_owned()));
        assert_eq!(marker["at"], NOW);
    }

    #[test]
    fn runs_only_once() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        run(&e);
        assert_eq!(run(&e), res(&e.new, MigrationAction::Current));
        assert!(is_link(&e.old));
        let mut names: Vec<String> =
            fs::read_dir(&e.app_data).unwrap().map(|d| d.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec!["ajzakomator", "unimux"]);
    }

    #[test]
    fn fresh_install_creates_nothing() {
        let e = env();
        assert_eq!(run(&e), res(&e.new, MigrationAction::Current));
        assert!(!e.old.exists());
        assert!(!e.new.exists());
    }

    #[test]
    fn moves_an_empty_new_directory_aside() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        put(&e.new.join("update").join("installer-done"), "0.8.5");
        assert_eq!(run(&e), res(&e.new, MigrationAction::Migrated));
        assert_eq!(read(&e.new.join("state.json")), "old");
        let aside = e.app_data.join("unimux.pre-migration-2026-10-15T12-30-00-000Z");
        assert_eq!(read(&aside.join("update").join("installer-done")), "0.8.5");
        assert!(is_link(&e.old));
    }

    #[test]
    fn leaves_both_alone_when_the_new_one_has_a_state() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        put(&e.new.join("state.json"), "new");
        assert_eq!(run(&e), res(&e.new, MigrationAction::BothExist));
        assert!(!is_link(&e.old));
        assert_eq!(read(&e.old.join("state.json")), "old");
        assert_eq!(read(&e.new.join("state.json")), "new");
    }

    #[test]
    fn rename_failure_keeps_the_old_directory_and_a_later_start_migrates() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        let logs = RefCell::new(vec![]);
        let faulty = Faulty { rename: Some(Box::new(eperm)), ..Default::default() };
        assert_eq!(run_with(&e, true, None, &faulty, &|_| false, &logs), res(&e.old, MigrationAction::RenameFailed));
        assert!(!is_link(&e.old));
        assert!(!e.new.exists());
        assert!(logs.borrow().join("\n").contains("EPERM"));
        assert_eq!(run(&e), res(&e.new, MigrationAction::Migrated));
        assert_eq!(read(&e.new.join("state.json")), "old");
    }

    #[test]
    fn empty_new_directory_that_cannot_be_moved_aside() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        fs::create_dir(&e.new).unwrap();
        let faulty = Faulty { rename: Some(Box::new(eperm)), ..Default::default() };
        assert_eq!(
            run_with(&e, true, None, &faulty, &|_| false, &RefCell::new(vec![])),
            res(&e.old, MigrationAction::RenameFailed)
        );
        assert!(e.new.exists());
    }

    #[test]
    fn only_the_second_rename_fails() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        fs::create_dir(&e.new).unwrap();
        let calls = std::rc::Rc::new(Cell::new(0));
        let c = calls.clone();
        let faulty = Faulty {
            rename: Some(Box::new(move |from: &Path, to: &Path| {
                c.set(c.get() + 1);
                if c.get() == 2 { Err(io::Error::other("EPERM")) } else { fs::rename(from, to) }
            })),
            ..Default::default()
        };
        assert_eq!(
            run_with(&e, true, None, &faulty, &|_| false, &RefCell::new(vec![])),
            res(&e.old, MigrationAction::RenameFailed)
        );
        assert!(!e.new.exists());
        assert!(e.app_data.join("unimux.pre-migration-2026-10-15T12-30-00-000Z").exists());
        assert_eq!(run(&e), res(&e.new, MigrationAction::Migrated));
    }

    #[test]
    fn link_failure_is_repaired_on_the_next_start() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        let logs = RefCell::new(vec![]);
        let faulty = Faulty { symlink_fails: true, ..Default::default() };
        assert_eq!(run_with(&e, true, None, &faulty, &|_| false, &logs), res(&e.new, MigrationAction::MigratedWithoutLink));
        assert!(!e.old.exists());
        assert!(logs.borrow().join("\n").contains("could not be created"));
        assert_eq!(run(&e), res(&e.new, MigrationAction::Current));
        assert!(is_link(&e.old));
        assert_eq!(read(&e.old.join("state.json")), "old");
    }

    #[test]
    fn keeps_a_user_link_as_the_data_directory() {
        let e = env();
        let elsewhere = e.app_data.join("elsewhere");
        put(&elsewhere.join("state.json"), "mine");
        RealFs.symlink(&elsewhere, &e.old).unwrap();
        assert_eq!(run(&e), res(&e.old, MigrationAction::UserLink));
        assert!(!e.new.exists());
        assert_eq!(read(&e.old.join("state.json")), "mine");
    }

    #[test]
    fn follows_another_instance_that_moved_first() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        let faulty = Faulty {
            rename: Some(Box::new(|from: &Path, to: &Path| {
                fs::rename(from, to)?;
                Err(io::Error::other("ENOENT: already moved"))
            })),
            ..Default::default()
        };
        assert_eq!(run_with(&e, true, None, &faulty, &|_| false, &RefCell::new(vec![])), res(&e.new, MigrationAction::Current));
        assert!(!e.old.exists());
        assert_eq!(read(&e.new.join("state.json")), "old");
    }

    #[test]
    fn still_migrates_when_the_marker_cannot_be_written() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        let faulty = Faulty { write_fails: true, ..Default::default() };
        assert_eq!(run_with(&e, true, None, &faulty, &|_| false, &RefCell::new(vec![])), res(&e.new, MigrationAction::Migrated));
        assert!(is_link(&e.old));
    }

    #[test]
    fn waits_while_an_update_window_works_in_the_old_directory() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        let seen = RefCell::new(vec![]);
        let busy = |d: &Path| {
            seen.borrow_mut().push(d.to_path_buf());
            true
        };
        assert_eq!(run_with(&e, true, None, &RealFs, &busy, &RefCell::new(vec![])), res(&e.old, MigrationAction::Deferred));
        assert_eq!(*seen.borrow(), vec![e.old.clone()]);
        assert!(!e.new.exists());
        assert_eq!(run(&e), res(&e.new, MigrationAction::Migrated));
    }

    #[test]
    fn never_moves_a_link_or_a_file() {
        let e = env();
        fs::create_dir(e.app_data.join("elsewhere")).unwrap();
        RealFs.symlink(&e.app_data.join("elsewhere"), &e.old).unwrap();
        assert_eq!(run(&e), res(&e.old, MigrationAction::UserLink));
        #[cfg(windows)]
        fs::remove_dir(&e.old).unwrap();
        #[cfg(not(windows))]
        fs::remove_file(&e.old).unwrap();
        fs::write(&e.old, "not a directory").unwrap();
        assert_eq!(run(&e), res(&e.new, MigrationAction::Current));
        assert_eq!(read(&e.old), "not a directory");
        assert!(!e.new.exists());
    }

    #[test]
    fn never_deletes_on_failure() {
        let e = env();
        put(&e.old.join("state.json"), "old");
        put(&e.old.join("sessions").join("a.json"), "a");
        let faulty = Faulty { rename: Some(Box::new(eperm)), symlink_fails: true, write_fails: true };
        run_with(&e, true, None, &faulty, &|_| false, &RefCell::new(vec![]));
        let mut names: Vec<String> =
            fs::read_dir(&e.old).unwrap().map(|d| d.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec!["sessions", "state.json"]);
    }

    #[test]
    fn multicoding_state_is_copied_once() {
        let e = env();
        put(&e.app_data.join("MultiCoding").join("state.json"), "{\"v\":1}");
        assert_eq!(copy_multicoding_state(&e.app_data, &e.new, true), Ok(false));
        assert_eq!(copy_multicoding_state(&e.app_data, &e.new, false), Ok(true));
        assert_eq!(read(&e.new.join("state.json")), "{\"v\":1}");
        assert_eq!(copy_multicoding_state(&e.app_data, &e.new, false), Ok(false));
    }
}
