//! Ports of test/claude-locks.test.ts.

use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

struct Home {
    _dir: tempfile::TempDir,
    home: PathBuf,
    credentials: PathBuf,
    claude_json: PathBuf,
}

fn home() -> Home {
    let dir = tempfile::tempdir().unwrap();
    // realpath: Claude Code's legacy lock is `<realpath(config dir)>.lock`; a short (8.3) temp path would not match.
    let home = dunce::canonicalize(dir.path()).unwrap();
    fs::create_dir(home.join(".claude")).unwrap();
    Home { credentials: home.join(".claude").join(".credentials.json"), claude_json: home.join(".claude.json"), home, _dir: dir }
}

impl Home {
    fn primary(&self) -> PathBuf {
        self.home.join(".claude").join(".oauth_refresh.lock")
    }
    fn legacy(&self) -> PathBuf {
        self.home.join(".claude.lock")
    }
    fn config(&self) -> PathBuf {
        self.home.join(".claude.json.lock")
    }
    fn all(&self) -> [bool; 3] {
        [self.primary().exists(), self.legacy().exists(), self.config().exists()]
    }
    fn run<T>(&self, options: &LockOptions, f: impl FnOnce() -> T) -> Result<T, LockError> {
        with_claude_locks(&self.credentials, &self.claude_json, false, options, f)
    }
}

fn fast() -> LockOptions {
    LockOptions { timeout: Duration::from_millis(400), ..LockOptions::default() }
}

fn age(dir: &Path, ago: Duration) {
    let t = SystemTime::now() - ago;
    let mut open = fs::OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        open.access_mode(0x100).custom_flags(0x0200_0000);
    }
    #[cfg(not(windows))]
    open.read(true);
    open.open(dir).unwrap().set_times(fs::FileTimes::new().set_accessed(t).set_modified(t)).unwrap();
}

#[test]
fn uses_the_paths_claude_code_uses() {
    let h = home();
    assert_eq!(
        claude_lock_paths(&h.credentials, &h.claude_json),
        ClaudeLockPaths { primary: h.primary(), legacy: h.legacy(), config: h.config() }
    );
}

#[test]
fn holds_the_credential_locks_and_the_config_lock_while_fn_runs_and_releases_them() {
    let h = home();
    let mut seen = [false; 3];
    let out = h
        .run(&fast(), || {
            seen = h.all();
            7
        })
        .unwrap();
    assert_eq!(out, 7);
    assert_eq!(seen, [true, true, true]);
    assert_eq!(h.all(), [false, false, false]);
}

#[test]
fn credentials_only_skips_the_config_lock() {
    let h = home();
    let seen = with_claude_locks(&h.credentials, &h.claude_json, true, &fast(), || h.all()).unwrap();
    assert_eq!(seen, [true, true, false]);
    assert_eq!(h.all(), [false, false, false]);
}

#[test]
fn releases_on_throw() {
    let h = home();
    let out: Result<(), &str> = h.run(&fast(), || Err("boom")).unwrap();
    assert_eq!(out, Err("boom"));
    assert_eq!(h.all(), [false, false, false]);
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.run(&fast(), || panic!("boom"))));
    assert!(panicked.is_err());
    assert_eq!(h.all(), [false, false, false]);
}

#[test]
fn waits_for_a_holder_that_lets_go() {
    let h = home();
    fs::create_dir(h.legacy()).unwrap();
    let legacy = h.legacy();
    let letting_go = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        fs::remove_dir(legacy).unwrap();
    });
    let mut ran = false;
    h.run(&LockOptions { timeout: Duration::from_secs(3), ..LockOptions::default() }, || ran = true).unwrap();
    letting_go.join().unwrap();
    assert!(ran);
}

#[test]
fn gives_up_on_a_live_holder_without_running_fn_and_releases_what_it_took() {
    let h = home();
    fs::create_dir(h.legacy()).unwrap();
    let mut ran = false;
    let err = h.run(&fast(), || ran = true).unwrap_err();
    assert!(matches!(&err, LockError::Timeout(name) if name == ".claude.lock"), "{err:?}");
    assert_eq!(err.to_string(), "lock held: .claude.lock");
    assert!(!ran);
    assert!(!h.primary().exists());
    assert!(h.legacy().exists()); // somebody else's fresh lock is never removed
}

#[test]
fn takes_over_a_credential_lock_older_than_60_s_and_a_config_lock_older_than_10_s() {
    let h = home();
    fs::create_dir(h.primary()).unwrap();
    age(&h.primary(), Duration::from_secs(61));
    fs::create_dir(h.config()).unwrap();
    age(&h.config(), Duration::from_secs(11));
    h.run(&fast(), || ()).unwrap();
    assert!(!h.primary().exists());
}

#[test]
fn does_not_take_over_a_credential_lock_that_is_only_15_s_old() {
    let h = home();
    fs::create_dir(h.primary()).unwrap();
    age(&h.primary(), Duration::from_secs(15));
    assert!(matches!(h.run(&fast(), || ()), Err(LockError::Timeout(_))));
}

#[test]
fn touches_its_locks_while_holding_them() {
    let h = home();
    let options = LockOptions { touch: Duration::from_millis(50), ..fast() };
    h.run(&options, || {
        age(&h.primary(), Duration::from_secs(30));
        std::thread::sleep(Duration::from_millis(200));
        let mtime = fs::metadata(h.primary()).unwrap().modified().unwrap();
        assert!(SystemTime::now().duration_since(mtime).unwrap_or_default() < Duration::from_secs(5));
    })
    .unwrap();
}

#[test]
fn never_creates_reads_or_removes_claude_codes_owner_record() {
    let h = home();
    let owner = h.home.join(".claude").join(".oauth_refresh.lock.owner");
    h.run(&fast(), || ()).unwrap();
    assert!(!owner.exists());
    fs::write(&owner, r#"{"pid":1}"#).unwrap();
    h.run(&fast(), || ()).unwrap();
    assert!(owner.exists());
}

#[test]
fn never_creates_claude_codes_directories() {
    let h = home();
    fs::remove_dir_all(h.home.join(".claude")).unwrap();
    assert!(matches!(h.run(&fast(), || ()), Err(LockError::Io(_))));
    assert!(!h.home.join(".claude").exists());
}

#[test]
fn retries_the_release_while_the_lock_dir_is_briefly_busy_so_no_lock_is_left_behind() {
    let h = home();
    let failures = Arc::new(AtomicU32::new(0));
    let seen = failures.clone();
    let options = LockOptions {
        remove_dir: Arc::new(move |dir: &Path| {
            let n = seen.load(Ordering::SeqCst);
            if n < 2 {
                seen.store(n + 1, Ordering::SeqCst);
                // EPERM, then EBUSY (ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION on Windows).
                #[cfg(windows)]
                return Err(io::Error::from_raw_os_error(if n == 0 { 5 } else { 32 }));
                #[cfg(not(windows))]
                return Err(io::Error::from_raw_os_error(if n == 0 { 1 } else { 16 }));
            }
            fs::remove_dir(dir)
        }),
        sleep: Arc::new(|_| ()),
        ..fast()
    };
    let lock = acquire_dir_lock(&h.primary(), CREDENTIALS_STALE, &options).unwrap();
    lock.release().unwrap();
    assert_eq!(failures.load(Ordering::SeqCst), 2);
    assert!(!h.primary().exists());
}

#[test]
fn gives_up_after_a_few_tries_and_reports_it() {
    let h = home();
    let calls = Arc::new(AtomicU32::new(0));
    let seen = calls.clone();
    let options = LockOptions {
        remove_dir: Arc::new(move |_: &Path| {
            seen.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "busy"))
        }),
        sleep: Arc::new(|_| ()),
        ..fast()
    };
    let lock = acquire_dir_lock(&h.primary(), CREDENTIALS_STALE, &options).unwrap();
    let err = lock.release().unwrap_err();
    assert_eq!(err.to_string(), "busy");
    assert_eq!(calls.load(Ordering::SeqCst), RELEASE_TRIES);
    fs::remove_dir(h.primary()).unwrap();
}

// ── beyond the TS cases ─────────────────────────────────────────────────────

#[test]
fn touch_dir_sets_the_mtime() {
    let h = home();
    fs::create_dir(h.primary()).unwrap();
    age(&h.primary(), Duration::from_secs(30));
    touch_dir(&h.primary()).unwrap();
    let mtime = fs::metadata(h.primary()).unwrap().modified().unwrap();
    assert!(SystemTime::now().duration_since(mtime).unwrap_or_default() < Duration::from_secs(5));
}

#[test]
fn a_dropped_lock_is_released() {
    let h = home();
    let lock = acquire_dir_lock(&h.primary(), CREDENTIALS_STALE, &fast()).unwrap();
    assert!(h.primary().is_dir());
    drop(lock);
    assert!(!h.primary().exists());
}

#[test]
fn a_lock_removed_by_someone_else_releases_fine() {
    let h = home();
    let lock = acquire_dir_lock(&h.primary(), CREDENTIALS_STALE, &fast()).unwrap();
    fs::remove_dir(h.primary()).unwrap();
    lock.release().unwrap();
}

#[test]
fn the_legacy_lock_follows_a_junction_to_the_real_config_dir() {
    let h = home();
    let real = h.home.join("real-claude");
    fs::create_dir(&real).unwrap();
    let link = h.home.join("linked");
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let paths = claude_lock_paths(&link.join(".credentials.json"), &h.claude_json);
    assert_eq!(paths.legacy, h.home.join("real-claude.lock"));
    assert_eq!(paths.primary, link.join(".oauth_refresh.lock"));
    // Removing the junction itself, never its target's contents.
    fs::remove_dir(&link).unwrap();
    assert!(real.exists());
}

#[test]
fn many_threads_never_hold_one_lock_at_once() {
    let h = home();
    let path = Arc::new(h.primary());
    let inside = Arc::new(AtomicU32::new(0));
    let overlaps = Arc::new(AtomicU32::new(0));
    let threads: Vec<_> = (0..6)
        .map(|_| {
            let (path, inside, overlaps) = (path.clone(), inside.clone(), overlaps.clone());
            std::thread::spawn(move || {
                let options = LockOptions {
                    timeout: Duration::from_secs(30),
                    sleep: Arc::new(|_| std::thread::sleep(Duration::from_millis(5))),
                    ..LockOptions::default()
                };
                for _ in 0..10 {
                    let lock = acquire_dir_lock(&path, CREDENTIALS_STALE, &options).unwrap();
                    if inside.fetch_add(1, Ordering::SeqCst) != 0 {
                        overlaps.fetch_add(1, Ordering::SeqCst);
                    }
                    std::thread::sleep(Duration::from_millis(2));
                    inside.fetch_sub(1, Ordering::SeqCst);
                    lock.release().unwrap();
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(overlaps.load(Ordering::SeqCst), 0);
    assert!(!h.primary().exists());
}

/// A parent dir the user may not create folders in: mkdir fails with access denied and no lock is in the way. That is a real
/// error, thrown at once (1.1.4 rethrows EPERM, the callers report 'write' / 'manual'), never a 9 s wait reported as a held lock.
#[cfg(windows)]
#[test]
fn a_real_permission_error_fails_at_once_instead_of_waiting_for_the_timeout() {
    use std::process::{Command, Stdio};
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("denied");
    fs::create_dir(&parent).unwrap();
    let out = Command::new("whoami").args(["/user", "/fo", "csv", "/nh"]).output().unwrap();
    let line = String::from_utf8_lossy(&out.stdout).into_owned();
    let sid = line.trim().rsplit(',').next().unwrap().trim_matches('"').to_string();
    assert!(sid.starts_with("S-1-"), "whoami: {line}");
    let icacls = |args: &[&str]| {
        let status = Command::new("icacls").arg(&parent).args(args).stdout(Stdio::null()).status().unwrap();
        assert!(status.success(), "icacls {args:?}");
    };
    // (AD): append data, which on a directory is "create subfolders".
    icacls(&["/deny", &format!("*{sid}:(AD)")]);
    struct Restore<'a>(&'a Path, String);
    impl Drop for Restore<'_> {
        fn drop(&mut self) {
            let _ = std::process::Command::new("icacls")
                .arg(self.0)
                .args(["/remove:d", &format!("*{}", self.1)])
                .stdout(std::process::Stdio::null())
                .status();
        }
    }
    let _restore = Restore(&parent, sid.clone());
    assert_eq!(fs::create_dir(parent.join("probe")).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    let options = LockOptions { timeout: Duration::from_secs(5), ..LockOptions::default() };
    let start = Instant::now();
    let result = acquire_dir_lock(&parent.join("x.lock"), CREDENTIALS_STALE, &options);
    let took = start.elapsed();
    match result {
        Err(LockError::Io(e)) => assert_eq!(e.kind(), io::ErrorKind::PermissionDenied),
        other => panic!("expected an io error, got {other:?} after {took:?}"),
    }
    assert!(took < Duration::from_secs(1), "took {took:?}");
    // with_claude_locks reports the same error (not a held lock) and runs nothing.
    let credentials = parent.join(".credentials.json");
    let ran = std::cell::Cell::new(false);
    let result = with_claude_locks(&credentials, &dir.path().join(".claude.json"), false, &options, || ran.set(true));
    assert!(matches!(result, Err(LockError::Io(_))), "{result:?}");
    assert!(!ran.get());
    assert!(!dir.path().join(".claude.json.lock").exists());
}
