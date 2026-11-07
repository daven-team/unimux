//! The Rust directory locks against the real npm proper-lockfile (4.1.2, what Claude Code and claude-swap use), both
//! directions: each side waits for a live holder of the other (whose touches keep the lock fresh) and takes over a dead one.
//!
//! Needs `node` and the repo's node_modules (proper-lockfile is a dependency of the Electron app). Without them the cases are
//! skipped with a note, unless `UNIMUX_REQUIRE_LOCK_INTEROP=1` (CI), where a missing tool fails.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use unimux_accounts::locks::{LockError, LockOptions, acquire_dir_lock};

/// The helper: `hold <path> <ms>` takes the lock, prints `held`, keeps it (touched every second) for `ms` and releases it;
/// `take <path>` waits for it (100 ms retries, 30 s) and prints `took <ms waited>`; `check <path>` prints `locked` / `free`.
/// stale 2000 ms (proper-lockfile's minimum), update 1000 ms.
const HELPER: &str = r#"
const lockfile = require(process.argv[1]);
const [mode, path, ms] = process.argv.slice(2);
const options = { lockfilePath: path, realpath: false, stale: 2000, update: 1000 };
(async () => {
  if (mode === 'hold') {
    const release = await lockfile.lock(path, options);
    console.log('held');
    await new Promise((r) => setTimeout(r, Number(ms)));
    await release();
    console.log('released');
  } else if (mode === 'take') {
    const start = Date.now();
    const release = await lockfile.lock(path, { ...options, retries: { retries: 300, factor: 1, minTimeout: 100, maxTimeout: 100 } });
    console.log(`took ${Date.now() - start}`);
    await release();
  } else {
    console.log((await lockfile.check(path, options)) ? 'locked' : 'free');
  }
})().catch((e) => { console.log(`error ${e.code || e.message}`); process.exit(1); });
"#;

fn proper_lockfile() -> Option<PathBuf> {
    let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../node_modules/proper-lockfile");
    let node = Command::new("node").arg("--version").stdout(Stdio::null()).status().is_ok_and(|s| s.success());
    if node && module.join("index.js").exists() {
        return Some(dunce::canonicalize(module).unwrap());
    }
    assert!(std::env::var("UNIMUX_REQUIRE_LOCK_INTEROP").as_deref() != Ok("1"), "node or node_modules/proper-lockfile missing");
    eprintln!("skipped: node or node_modules/proper-lockfile missing");
    None
}

fn node(module: &Path, args: &[&str]) -> Child {
    Command::new("node")
        .arg("-e")
        .arg(HELPER)
        .arg(module)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap()
}

fn line(reader: &mut impl BufRead) -> String {
    let mut s = String::new();
    reader.read_line(&mut s).unwrap();
    s.trim().to_string()
}

fn options(touch_ms: u64) -> LockOptions {
    LockOptions { touch: Duration::from_millis(touch_ms), sleep: Arc::new(std::thread::sleep), ..LockOptions::default() }
}

fn path_str(p: &Path) -> &str {
    p.to_str().unwrap()
}

#[test]
fn rust_waits_for_a_live_proper_lockfile_holder_and_does_not_take_its_touched_lock_over() {
    let Some(module) = proper_lockfile() else { return };
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join(".oauth_refresh.lock");
    let mut holder = node(&module, &["hold", path_str(&lock), "4000"]);
    let mut out = BufReader::new(holder.stdout.take().unwrap());
    assert_eq!(line(&mut out), "held");
    let start = Instant::now();
    // Stale after 2.5 s: only proper-lockfile's touches (every second) keep the 4 s hold from looking dead.
    let held = acquire_dir_lock(&lock, Duration::from_millis(2500), &options(3000)).unwrap();
    let waited = start.elapsed();
    assert_eq!(line(&mut out), "released", "the holder's release must come first (no takeover)");
    assert!(waited >= Duration::from_millis(3000), "took a live holder's lock after {waited:?}");
    held.release().unwrap();
    assert!(holder.wait().unwrap().success());
    assert!(!lock.exists());
}

#[test]
fn rust_gives_up_on_a_live_proper_lockfile_holder_after_its_timeout() {
    let Some(module) = proper_lockfile() else { return };
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("claude.lock");
    let mut holder = node(&module, &["hold", path_str(&lock), "3500"]);
    let mut out = BufReader::new(holder.stdout.take().unwrap());
    assert_eq!(line(&mut out), "held");
    let opts = LockOptions { timeout: Duration::from_millis(1200), ..options(3000) };
    assert!(
        matches!(acquire_dir_lock(&lock, Duration::from_secs(60), &opts), Err(LockError::Timeout(name)) if name == "claude.lock")
    );
    assert!(lock.exists(), "the holder's lock stays");
    assert!(holder.wait().unwrap().success());
}

#[test]
fn proper_lockfile_waits_for_a_live_rust_holder_that_touches_its_lock() {
    let Some(module) = proper_lockfile() else { return };
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join(".claude.json.lock");
    // Touched every 500 ms and held 3.5 s, past proper-lockfile's 2 s stale limit.
    let held = acquire_dir_lock(&lock, Duration::from_secs(10), &options(500)).unwrap();
    let mut check = node(&module, &["check", path_str(&lock)]);
    assert_eq!(line(&mut BufReader::new(check.stdout.take().unwrap())), "locked");
    assert!(check.wait().unwrap().success());
    let mut taker = node(&module, &["take", path_str(&lock)]);
    let mut out = BufReader::new(taker.stdout.take().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || tx.send(line(&mut out)).unwrap());
    // Nothing may come before the release: proper-lockfile must not take the touched lock over.
    if let Ok(took) = rx.recv_timeout(Duration::from_millis(3500)) {
        panic!("proper-lockfile took a live Rust lock: {took}");
    }
    let released_at = Instant::now();
    held.release().unwrap();
    let took = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(took.starts_with("took "), "{took}");
    assert!(released_at.elapsed() < Duration::from_secs(2), "proper-lockfile saw the release late");
    assert!(taker.wait().unwrap().success());
    assert!(!lock.exists());
}

#[test]
fn rust_takes_over_the_lock_of_a_killed_proper_lockfile_holder() {
    let Some(module) = proper_lockfile() else { return };
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join(".oauth_refresh.lock");
    let mut holder = node(&module, &["hold", path_str(&lock), "60000"]);
    assert_eq!(line(&mut BufReader::new(holder.stdout.take().unwrap())), "held");
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(lock.exists(), "a killed holder leaves its lock");
    let start = Instant::now();
    let held = acquire_dir_lock(&lock, Duration::from_secs(2), &options(3000)).unwrap();
    assert!(start.elapsed() < Duration::from_secs(6), "takeover took {:?}", start.elapsed());
    held.release().unwrap();
}

#[test]
fn proper_lockfile_takes_over_a_lock_rust_left_behind() {
    let Some(module) = proper_lockfile() else { return };
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join(".claude.json.lock");
    let held = acquire_dir_lock(&lock, Duration::from_secs(10), &options(60_000)).unwrap();
    // A Rust holder that died: the dir stays, its mtime ages.
    std::mem::forget(held);
    let old = SystemTime::now() - Duration::from_secs(5);
    let f = std::fs::OpenOptions::new();
    #[cfg(windows)]
    let f = {
        use std::os::windows::fs::OpenOptionsExt;
        let mut f = f;
        f.access_mode(0x100).custom_flags(0x0200_0000);
        f
    };
    #[cfg(not(windows))]
    let f = {
        let mut f = f;
        f.read(true);
        f
    };
    f.open(&lock).unwrap().set_times(std::fs::FileTimes::new().set_modified(old).set_accessed(old)).unwrap();
    let mut taker = node(&module, &["take", path_str(&lock)]);
    let took = line(&mut BufReader::new(taker.stdout.take().unwrap()));
    let waited: u64 = took.strip_prefix("took ").unwrap_or_else(|| panic!("{took}")).parse().unwrap();
    assert!(waited < 1500, "proper-lockfile waited {waited} ms for a stale lock");
    assert!(taker.wait().unwrap().success());
}
