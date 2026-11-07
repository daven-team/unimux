//! "Make main" killed mid-phase, then the next start (PLAN A2): a child process (this test binary again) runs the activation on
//! a fake HOME and is killed with TerminateProcess / SIGKILL right before one of its file renames, or at a random moment; the
//! parent then runs the start-up recovery like the app does (version-2 recovery, then the 0.9.0 one on `legacy`) and checks
//! that no login was lost and the files are either exactly as before or a finished swap.
//!
//! Claude Code's lock dirs the killed child held stay behind: the first recovery must answer `locked` and change nothing; once
//! they are stale (their mtime is set back, as 60 s would) it recovers.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};
use unimux_accounts::activate::{ActivateDeps, activate_account, recover_interrupted_activation};
use unimux_accounts::cswap::CswapRoster;
use unimux_accounts::identity::{AccountIdentity, Custody, TokenFamily, custody_of};
use unimux_accounts::legacy_swap::recover_interrupted_swap;
use unimux_accounts::locks::LockOptions;
use unimux_accounts::refresh::{ProfileLocks, RefreshOutcome};
use unimux_accounts::results::Recovery;
use unimux_accounts::slot::SwapSlot;
use unimux_accounts::store::{AccountsStore, LiveIdentity, ManagedAccount};
use unimux_accounts::swapfs::{FileStat, RealSwapFs, SwapFs};
use unimux_core::js_json;

const A: &str = "11111111-1111-4111-8111-111111111111";
const T: &str = "22222222-2222-4222-8222-222222222222";
const NOW: f64 = 1_792_152_000_000.0;
const CHILD_ENV: &str = "UNIMUX_A2_KILL_CHILD";

fn creds(n: &str) -> Value {
    json!({ "claudeAiOauth": { "accessToken": format!("acc-{n}"), "refreshToken": format!("ref-{n}"), "expiresAt": NOW + 3_600_000.0, "scopes": ["s"] }, "mcpOAuth": { "server": n } })
}
fn account(n: &str, email: &str) -> Value {
    json!({ "emailAddress": email, "organizationName": format!("Org {n}"), "accountUuid": format!("uuid-{n}"), "organizationUuid": format!("org-{n}") })
}
fn put(path: &Path, v: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, js_json::stringify(v)).unwrap();
}
/// `.claude.json` as Claude Code writes it (2-space indent), so a restored file is byte-identical.
fn put_pretty(path: &Path, v: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, js_json::stringify_pretty(v, 2)).unwrap();
}
fn ident(n: &str, email: &str) -> AccountIdentity {
    AccountIdentity {
        email: Some(email.into()),
        account_uuid: Some(format!("uuid-{n}")),
        organization_uuid: Some(format!("org-{n}")),
        org: None,
    }
}

struct Paths {
    root: PathBuf,
}

impl Paths {
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    fn live_creds(&self) -> PathBuf {
        self.home().join(".claude").join(".credentials.json")
    }
    fn live_json(&self) -> PathBuf {
        self.home().join(".claude.json")
    }
    fn accounts(&self) -> PathBuf {
        self.root.join("accounts")
    }
    fn backup(&self) -> PathBuf {
        self.accounts().join("swap-backup")
    }
    fn profile(&self, id: &str) -> PathBuf {
        self.accounts().join("claude").join(id)
    }
    fn lock_dirs(&self) -> [PathBuf; 3] {
        [
            self.home().join(".claude").join(".oauth_refresh.lock"),
            self.home().join(".claude.lock"),
            self.home().join(".claude.json.lock"),
        ]
    }
}

/// The fixture of accounts-activate.test.ts: A is live (with or without its own record), X is a saved app login.
fn fixture(p: &Paths, with_outgoing_record: bool) {
    put(&p.live_creds(), &creds("A"));
    put_pretty(&p.live_json(), &json!({ "oauthAccount": account("A", "a@x.com"), "projects": { "p": 1 }, "numStartups": 4 }));
    let store = AccountsStore::new(p.accounts());
    if with_outgoing_record {
        fs::create_dir_all(p.profile(A)).unwrap();
        store
            .commit(&ManagedAccount {
                id: A.into(),
                added_at: 1.0,
                identity: ident("A", "a@x.com"),
                custody: Some(Custody::Live),
                family: Some(TokenFamily::Live),
                ..Default::default()
            })
            .unwrap();
        put(&p.profile(A).join(".credentials.json"), &creds("A-old"));
    }
    store
        .commit(&ManagedAccount {
            id: T.into(),
            added_at: 2.0,
            identity: ident("X", "x@x.com"),
            custody: Some(Custody::App),
            family: Some(TokenFamily::Own),
            ..Default::default()
        })
        .unwrap();
    put(&p.profile(T).join(".credentials.json"), &creds("X"));
    put_pretty(&p.profile(T).join(".claude.json"), &json!({ "oauthAccount": account("X", "x@x.com"), "theme": "dark" }));
    let live = LiveIdentity { identity: ident("A", "a@x.com"), record_id: with_outgoing_record.then(|| A.to_string()) };
    store.set_live(Some(&live)).unwrap();
}

/// Renames pass through; the one numbered `stop_at` first tells the parent and then blocks until the process is killed.
/// `pause` slows every rename down (for the kills at a random moment).
struct ChildFs {
    renames: AtomicUsize,
    stop_at: Option<usize>,
    pause: Duration,
    marker: PathBuf,
}

impl SwapFs for ChildFs {
    fn read_file(&self, p: &Path) -> io::Result<Option<String>> {
        RealSwapFs.read_file(p)
    }
    fn stat(&self, p: &Path) -> io::Result<Option<FileStat>> {
        RealSwapFs.stat(p)
    }
    fn write_file(&self, p: &Path, d: &str, m: u32) -> io::Result<()> {
        RealSwapFs.write_file(p, d, m)
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let n = self.renames.fetch_add(1, Ordering::SeqCst);
        if Some(n) == self.stop_at {
            fs::write(&self.marker, to.to_string_lossy().as_bytes()).unwrap();
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        std::thread::sleep(self.pause);
        RealSwapFs.rename(from, to)
    }
    fn rm(&self, p: &Path) -> io::Result<()> {
        RealSwapFs.rm(p)
    }
    fn mkdir(&self, p: &Path) -> io::Result<()> {
        RealSwapFs.mkdir(p)
    }
    fn readdir(&self, p: &Path) -> io::Result<Vec<String>> {
        RealSwapFs.readdir(p)
    }
    fn rmdir(&self, p: &Path) -> io::Result<()> {
        RealSwapFs.rmdir(p)
    }
}

fn deps(p: &Paths, fs: Arc<dyn SwapFs>, lock_timeout: Duration) -> ActivateDeps {
    ActivateDeps {
        home: p.home(),
        env: Arc::new(Default::default()),
        darwin: false,
        store: Arc::new(AccountsStore::new(p.accounts())),
        backup_dir: p.backup(),
        now: Arc::new(|| NOW),
        refresh: Arc::new(|_: &Path| RefreshOutcome::Ok),
        delay: Arc::new(std::thread::sleep),
        cswap: Arc::new(|| Ok(CswapRoster::Absent)),
        cswap_wrote_since: None,
        fs,
        locks: LockOptions { timeout: lock_timeout, ..LockOptions::default() },
        slot: Arc::new(SwapSlot::new()),
        profiles: Arc::new(ProfileLocks::new()),
    }
}

/// The child: runs one activation under [`ChildFs`] (only when started by the parent).
#[test]
fn child_entry() {
    let Ok(spec) = std::env::var(CHILD_ENV) else { return };
    let spec: Value = serde_json::from_str(&spec).unwrap();
    let p = Paths { root: PathBuf::from(spec["root"].as_str().unwrap()) };
    let fs = Arc::new(ChildFs {
        renames: AtomicUsize::new(0),
        stop_at: spec["stopAt"].as_u64().map(|n| n as usize),
        pause: Duration::from_millis(spec["pauseMs"].as_u64().unwrap_or(0)),
        marker: p.root.join("stopped"),
    });
    let result = activate_account(&deps(&p, fs, Duration::from_secs(9)), T);
    fs::write(p.root.join("finished"), result.to_value().to_string()).unwrap();
}

fn spawn_child(p: &Paths, stop_at: Option<usize>, pause_ms: u64) -> std::process::Child {
    let spec = json!({ "root": p.root.to_string_lossy(), "stopAt": stop_at, "pauseMs": pause_ms });
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    // Never a console window on the desktop, also when the tests run without one.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.args(["--exact", "child_entry", "--nocapture", "--test-threads=1"])
        .env(CHILD_ENV, spec.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

/// Sets the mtime of a lock dir back by `ago` (what 60 s without its holder's touch would do).
fn age(dir: &Path, ago: Duration) {
    let mut open = fs::OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        open.access_mode(0x100).custom_flags(0x0200_0000); // FILE_WRITE_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS
    }
    #[cfg(not(windows))]
    open.read(true);
    let t = SystemTime::now() - ago;
    open.open(dir).unwrap().set_times(fs::FileTimes::new().set_accessed(t).set_modified(t)).unwrap();
}

fn refresh_token(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let v = js_json::parse(&text).ok()?;
    v["claudeAiOauth"]["refreshToken"].as_str().map(str::to_string)
}

/// Every refresh token in a file under `root` (live files, profiles, backups).
fn tokens_anywhere(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).unwrap().flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(t) = refresh_token(&path) {
                out.push(t);
            }
        }
    }
    out
}

fn email_of(path: &Path) -> Option<String> {
    let v = js_json::parse(&fs::read_to_string(path).ok()?).ok()?;
    v["oauthAccount"]["emailAddress"].as_str().map(str::to_string)
}

/// The two states a restart may leave: exactly the state before the swap, or a finished swap.
fn check_outcome(p: &Paths, with_outgoing_record: bool, before: &[(PathBuf, Option<String>)], label: &str) {
    let store = AccountsStore::new(p.accounts());
    let live_token = refresh_token(&p.live_creds());
    match live_token.as_deref() {
        Some("ref-A") => {
            // Rolled back (or never started): every file exactly as before, the roles too.
            for (path, text) in before {
                assert_eq!(&fs::read_to_string(path).ok(), text, "{label}: {path:?} differs from before");
            }
            assert_eq!(store.live().unwrap().identity.email.as_deref(), Some("a@x.com"), "{label}");
            assert_eq!(custody_of(store.get(T).unwrap().custody), Custody::App, "{label}");
            assert_eq!(store.list().len(), if with_outgoing_record { 2 } else { 1 }, "{label}: a created record stayed");
        }
        Some("ref-X") => {
            // Finished: X is signed in, A's login is in A's record, the roles moved.
            assert_eq!(email_of(&p.live_json()).as_deref(), Some("x@x.com"), "{label}");
            let outgoing: Vec<ManagedAccount> = store.list().into_iter().filter(|r| r.id != T).collect();
            assert_eq!(outgoing.len(), 1, "{label}");
            assert_eq!(refresh_token(&p.profile(&outgoing[0].id).join(".credentials.json")).as_deref(), Some("ref-A"), "{label}");
            assert_eq!(custody_of(store.get(T).unwrap().custody), Custody::Live, "{label}");
            assert_eq!(custody_of(outgoing[0].custody), Custody::App, "{label}");
            assert_eq!(store.live().unwrap().record_id.as_deref(), Some(T), "{label}");
        }
        other => panic!("{label}: live login is {other:?}"),
    }
    assert!(RealSwapFs.readdir(&p.backup()).unwrap().is_empty(), "{label}: backups left");
    // A lock dir of the killed child may stay when the recovery did not need Claude Code's locks; it is stale (no holder
    // touches it), so Claude Code and cswap take it over as proper-lockfile does.
    for l in p.lock_dirs() {
        if let Ok(m) = fs::metadata(&l) {
            let idle = SystemTime::now().duration_since(m.modified().unwrap()).unwrap_or_default();
            assert!(idle > Duration::from_secs(60), "{label}: lock {l:?} left with a fresh mtime");
        }
    }
}

/// Every file under `root` whose name ends in `.tmp`.
fn temps(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).unwrap().flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.to_string_lossy().ends_with(".tmp") {
                out.push(path);
            }
        }
    }
    out
}

/// One kill: start the child, wait for it to stop at rename `stop_at` (or kill it after `after`), kill it, restart.
fn kill_and_restart(with_outgoing_record: bool, stop_at: Option<usize>, after: Option<Duration>, label: &str) -> Option<String> {
    let tmp = tempfile::tempdir().unwrap();
    let p = Paths { root: dunce::canonicalize(tmp.path()).unwrap() };
    fixture(&p, with_outgoing_record);
    let watched = [
        p.live_creds(),
        p.live_json(),
        p.profile(A).join(".credentials.json"),
        p.profile(A).join(".claude.json"),
        p.profile(T).join(".credentials.json"),
        p.accounts().join("accounts.json"),
    ];
    let before: Vec<(PathBuf, Option<String>)> = watched.iter().map(|w| (w.clone(), fs::read_to_string(w).ok())).collect();
    let mut child = spawn_child(&p, stop_at, if after.is_some() { 25 } else { 0 });
    let start = Instant::now();
    let stopped_at = loop {
        if let Some(t) = after {
            if start.elapsed() >= t {
                break None;
            }
        } else if let Ok(to) = fs::read_to_string(p.root.join("stopped")) {
            break Some(to);
        }
        if p.root.join("finished").exists() || child.try_wait().unwrap().is_some() {
            break None;
        }
        assert!(start.elapsed() < Duration::from_secs(60), "{label}: child never reached its stop");
        std::thread::sleep(Duration::from_millis(5));
    };
    child.kill().ok();
    child.wait().unwrap();
    // No login is ever in no file, even right after the kill.
    let tokens = tokens_anywhere(&p.root);
    for t in ["ref-A", "ref-X"] {
        assert!(tokens.iter().any(|x| x == t), "{label}: {t} lost after the kill ({tokens:?})");
    }
    // The next start: Claude Code's locks the child held are still fresh. A journal whose phase may have touched Claude Code's
    // files needs them: the recovery answers `locked` and changes nothing.
    let locks_left = p.lock_dirs().iter().any(|l| l.exists());
    if locks_left {
        let phase = fs::read_to_string(p.backup().join("swap-journal.json"))
            .ok()
            .and_then(|j| js_json::parse(&j).ok())
            .and_then(|j| j["phase"].as_str().map(str::to_string));
        let needs_locks = matches!(phase.as_deref(), Some("outgoing-saved" | "live-creds-written" | "live-json-written"));
        let files_before = tokens_anywhere(&p.root);
        let d = deps(&p, Arc::new(RealSwapFs), Duration::from_millis(200));
        let first = recover_interrupted_activation(&d);
        if needs_locks {
            assert_eq!(first, Recovery::Locked, "{label}");
            assert!(d.slot.is_recovery_pending() && !d.slot.is_unresolved(), "{label}");
            assert_eq!(tokens_anywhere(&p.root), files_before, "{label}: the locked recovery changed files");
        }
        for l in p.lock_dirs() {
            if l.exists() {
                age(&l, Duration::from_secs(120));
            }
        }
    }
    let d = deps(&p, Arc::new(RealSwapFs), Duration::from_secs(2));
    let v2 = recover_interrupted_activation(&d);
    assert!(matches!(v2, Recovery::Recovered | Recovery::None | Recovery::Legacy), "{label}: version-2 recovery answered {v2:?}");
    if v2 == Recovery::Legacy {
        assert_eq!(recover_interrupted_swap(&d), Recovery::None, "{label}");
    }
    assert!(!d.slot.is_unresolved(), "{label}");
    check_outcome(&p, with_outgoing_record, &before, label);
    // A restart after that finds nothing to do, and the 0.9.0 recovery it hands over to sweeps the temp file of the rename
    // the kill interrupted.
    assert_eq!(recover_interrupted_activation(&d), Recovery::Legacy, "{label}");
    assert_eq!(recover_interrupted_swap(&d), Recovery::None, "{label}");
    assert_eq!(temps(&p.root), Vec::<PathBuf>::new(), "{label}");
    stopped_at
}

/// How many renames a clean activation of the fixture makes (all of them go through the swap fs).
fn renames_of_a_clean_run(with_outgoing_record: bool) -> usize {
    let tmp = tempfile::tempdir().unwrap();
    let p = Paths { root: dunce::canonicalize(tmp.path()).unwrap() };
    fixture(&p, with_outgoing_record);
    let fs = Arc::new(ChildFs { renames: AtomicUsize::new(0), stop_at: None, pause: Duration::ZERO, marker: p.root.join("x") });
    let r = activate_account(&deps(&p, fs.clone(), Duration::from_secs(2)), T);
    assert!(r.ok, "{r:?}");
    fs.renames.load(Ordering::SeqCst)
}

#[test]
fn killed_before_any_rename_of_the_swap_the_next_start_restores_or_finishes_it() {
    for with_record in [true, false] {
        let total = renames_of_a_clean_run(with_record);
        assert!(total >= 10, "{total}");
        let mut seen = Vec::new();
        for k in 0..total {
            let label = format!("record {with_record}, killed before rename {k} of {total}");
            let to = kill_and_restart(with_record, Some(k), None, &label).unwrap_or_else(|| panic!("{label}: never stopped"));
            seen.push(Path::new(&to).file_name().unwrap().to_string_lossy().into_owned());
        }
        // Every phase of the journal was a kill point.
        assert_eq!(seen.iter().filter(|n| *n == "swap-journal.json").count(), 5, "{seen:?}");
    }
}

#[test]
fn killed_at_a_random_moment_the_next_start_restores_or_finishes_it() {
    let mut seed = 0x2545_f491_u64;
    for i in 0..12 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let after = Duration::from_millis(20 + seed % 600);
        kill_and_restart(i % 2 == 0, None, Some(after), &format!("killed after {after:?}"));
    }
}
