//! Test helpers of the A2 ports: a hookable [`SwapFs`], JSON file helpers and the fixtures of accounts-activate.test.ts and
//! accounts-swap*.test.ts.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;
use unimux_core::js_json;

use crate::activate::ActivateDeps;
use crate::cswap::CswapRoster;
use crate::identity::AccountIdentity;
use crate::locks::LockOptions;
use crate::refresh::{ProfileLocks, RefreshOutcome};
use crate::slot::SwapSlot;
use crate::store::AccountsStore;
use crate::swapfs::{FileStat, RealSwapFs, SwapFs};

type Hook<A, R> = Box<dyn Fn(A) -> R + Send + Sync>;
type RefreshFn = Arc<dyn Fn(&Path) -> RefreshOutcome + Send + Sync>;

/// [`RealSwapFs`] with optional replacements (the `{ ...nodeSwapFs, rename: ... }` objects of the TS tests). A hook does the
/// real operation itself when it wants it (through [`RealSwapFs`]).
#[derive(Default)]
pub struct HookFs {
    pub rename: Option<Hook<(PathBuf, PathBuf), io::Result<()>>>,
    pub read_file: Option<Hook<PathBuf, io::Result<Option<String>>>>,
    pub stat: Option<Hook<PathBuf, io::Result<Option<FileStat>>>>,
    pub rm: Option<Hook<PathBuf, io::Result<()>>>,
    pub mkdir: Option<Hook<PathBuf, io::Result<()>>>,
}

impl SwapFs for HookFs {
    fn read_file(&self, path: &Path) -> io::Result<Option<String>> {
        match &self.read_file {
            Some(h) => h(path.to_path_buf()),
            None => RealSwapFs.read_file(path),
        }
    }
    fn stat(&self, path: &Path) -> io::Result<Option<FileStat>> {
        match &self.stat {
            Some(h) => h(path.to_path_buf()),
            None => RealSwapFs.stat(path),
        }
    }
    fn write_file(&self, path: &Path, data: &str, mode: u32) -> io::Result<()> {
        RealSwapFs.write_file(path, data, mode)
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        match &self.rename {
            Some(h) => h((from.to_path_buf(), to.to_path_buf())),
            None => RealSwapFs.rename(from, to),
        }
    }
    fn rm(&self, path: &Path) -> io::Result<()> {
        match &self.rm {
            Some(h) => h(path.to_path_buf()),
            None => RealSwapFs.rm(path),
        }
    }
    fn mkdir(&self, path: &Path) -> io::Result<()> {
        match &self.mkdir {
            Some(h) => h(path.to_path_buf()),
            None => RealSwapFs.mkdir(path),
        }
    }
    fn readdir(&self, path: &Path) -> io::Result<Vec<String>> {
        RealSwapFs.readdir(path)
    }
    fn rmdir(&self, path: &Path) -> io::Result<()> {
        RealSwapFs.rmdir(path)
    }
}

/// An error without a retry code (`{ code: 'EIO' }`).
pub fn eio() -> io::Error {
    io::Error::other("boom")
}

/// `{ code: 'EPERM' }` / `{ code: 'EBUSY' }`.
pub fn eperm() -> io::Error {
    io::Error::from(io::ErrorKind::PermissionDenied)
}
pub fn ebusy() -> io::Error {
    io::Error::from(io::ErrorKind::ResourceBusy)
}

/// `put`: writes `JSON.stringify(data)`, creating the parent.
pub fn put(path: &Path, data: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, js_json::stringify(data)).unwrap();
}

pub fn json(path: &Path) -> Value {
    js_json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn text(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// File names in a directory, sorted (empty when it does not exist).
pub fn names(dir: &Path) -> Vec<String> {
    RealSwapFs.readdir(dir).unwrap()
}

/// The swappable parts of a fixture's [`ActivateDeps`].
pub struct Knobs {
    pub fs: Mutex<Arc<dyn SwapFs>>,
    pub refresh: Mutex<RefreshFn>,
    pub refresh_calls: Mutex<Vec<PathBuf>>,
    pub roster: Mutex<CswapRoster>,
    pub wrote_since: Mutex<Option<Arc<dyn Fn() -> bool + Send + Sync>>>,
    pub delay: Mutex<Arc<dyn Fn(Duration) + Send + Sync>>,
    pub env: Mutex<std::collections::BTreeMap<String, String>>,
    pub darwin: Mutex<bool>,
    pub now: Mutex<f64>,
}

/// A temp root with `home/` and `accounts/` (the `beforeEach` of the TS suites).
pub struct Fx {
    _tmp: tempfile::TempDir,
    pub root: PathBuf,
    pub home: PathBuf,
    pub store: Arc<AccountsStore>,
    pub slot: Arc<SwapSlot>,
    pub profiles: Arc<ProfileLocks>,
    pub knobs: Arc<Knobs>,
    pub lock_timeout: Duration,
}

impl Fx {
    pub fn new(now: f64) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        // The legacy lock path is realpath-based.
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let home = root.join("home");
        let store = Arc::new(AccountsStore::new(root.join("accounts")));
        let knobs = Arc::new(Knobs {
            fs: Mutex::new(Arc::new(RealSwapFs)),
            refresh: Mutex::new(Arc::new(|_: &Path| RefreshOutcome::Ok)),
            refresh_calls: Mutex::new(Vec::new()),
            roster: Mutex::new(CswapRoster::Absent),
            wrote_since: Mutex::new(None),
            delay: Mutex::new(Arc::new(|_| {})),
            env: Mutex::new(Default::default()),
            darwin: Mutex::new(false),
            now: Mutex::new(now),
        });
        Self {
            _tmp: tmp,
            root,
            home,
            store,
            slot: Arc::new(SwapSlot::new()),
            profiles: Arc::new(ProfileLocks::new()),
            knobs,
            lock_timeout: Duration::from_millis(300),
        }
    }

    pub fn set_fs(&self, fs: impl SwapFs + 'static) {
        *self.knobs.fs.lock() = Arc::new(fs);
    }
    pub fn real_fs(&self) {
        *self.knobs.fs.lock() = Arc::new(RealSwapFs);
    }
    pub fn set_refresh(&self, f: impl Fn(&Path) -> RefreshOutcome + Send + Sync + 'static) {
        *self.knobs.refresh.lock() = Arc::new(f);
    }
    pub fn set_roster(&self, r: CswapRoster) {
        *self.knobs.roster.lock() = r;
    }
    pub fn set_wrote_since(&self, f: Option<Arc<dyn Fn() -> bool + Send + Sync>>) {
        *self.knobs.wrote_since.lock() = f;
    }
    pub fn set_delay(&self, f: impl Fn(Duration) + Send + Sync + 'static) {
        *self.knobs.delay.lock() = Arc::new(f);
    }
    pub fn set_env(&self, pairs: &[(&str, &str)]) {
        *self.knobs.env.lock() = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    }
    pub fn refresh_calls(&self) -> Vec<PathBuf> {
        self.knobs.refresh_calls.lock().clone()
    }

    pub fn live_creds(&self) -> PathBuf {
        self.home.join(".claude").join(".credentials.json")
    }
    pub fn live_json(&self) -> PathBuf {
        self.home.join(".claude.json")
    }
    pub fn backup_dir(&self) -> PathBuf {
        self.root.join("accounts").join("swap-backup")
    }
    pub fn dir(&self, id: &str) -> PathBuf {
        self.store.dir_of(id).unwrap()
    }
    pub fn lock_dirs(&self) -> [PathBuf; 3] {
        [
            self.home.join(".claude").join(".oauth_refresh.lock"),
            self.home.join(".claude.lock"),
            self.home.join(".claude.json.lock"),
        ]
    }
    pub fn locks_present(&self) -> [bool; 3] {
        self.lock_dirs().map(|p| p.exists())
    }

    /// `deps()`: the current knobs bound into an [`ActivateDeps`].
    pub fn deps(&self) -> ActivateDeps {
        let knobs = self.knobs.clone();
        let refresh_knobs = self.knobs.clone();
        let roster_knobs = self.knobs.clone();
        let delay_knobs = self.knobs.clone();
        let wrote = self.knobs.wrote_since.lock().clone();
        ActivateDeps {
            home: self.home.clone(),
            env: Arc::new(self.knobs.env.lock().clone()),
            darwin: *self.knobs.darwin.lock(),
            store: self.store.clone(),
            backup_dir: self.backup_dir(),
            now: Arc::new(move || *knobs.now.lock()),
            refresh: Arc::new(move |dir: &Path| {
                refresh_knobs.refresh_calls.lock().push(dir.to_path_buf());
                let f = refresh_knobs.refresh.lock().clone();
                f(dir)
            }),
            delay: Arc::new(move |d| {
                let f = delay_knobs.delay.lock().clone();
                f(d)
            }),
            cswap: Arc::new(move || Ok(roster_knobs.roster.lock().clone())),
            cswap_wrote_since: wrote.map(|f| {
                let w: crate::activate::WroteSince = Arc::new(move |_: &AccountIdentity, _: &CswapRoster, _: f64| Ok(f()));
                w
            }),
            fs: self.knobs.fs.lock().clone(),
            locks: LockOptions { timeout: self.lock_timeout, ..LockOptions::default() },
            slot: self.slot.clone(),
            profiles: self.profiles.clone(),
        }
    }
}
