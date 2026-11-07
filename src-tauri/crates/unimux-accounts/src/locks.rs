//! Claude Code's own advisory locks (npm proper-lockfile; port of src/main/accounts/claudeLocks.ts).
//!
//! A lock is a DIRECTORY created with mkdir; its holder touches the mtime every few seconds and a lock older than `stale`
//! belongs to a dead holder. Claude Code refreshes its OAuth token holding `<config dir>/.oauth_refresh.lock` and then
//! `<realpath(config dir)>.lock` (stale 60 s), and writes its global config holding `<global config>.lock` (~/.claude.json.lock,
//! stale 10 s). claude-swap takes the same locks for every write to the live login, so holding them excludes both. Claude
//! Code's `.oauth_refresh.lock.owner` record is never touched here.
//!
//! Everything here blocks (mkdir retries with 250..500 ms jitter for up to 9 s per lock): call it from `spawn_blocking`. Hold
//! the locks for local file work only, never across a network request. A [`DirLock`] is released when dropped (also while a
//! panic unwinds); [`DirLock::release`] reports a release that failed.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

pub const CREDENTIALS_STALE: Duration = Duration::from_secs(60);
pub const CONFIG_STALE: Duration = Duration::from_secs(10);
pub const TOUCH: Duration = Duration::from_secs(3);
/// Per lock; Claude Code holds its credential lock for one token round trip.
pub const LOCK_TIMEOUT: Duration = Duration::from_secs(9);
/// Tries of the release: on Windows an antivirus or indexer may hold the empty lock dir for a moment (EPERM, EBUSY).
pub const RELEASE_TRIES: u32 = 5;
const RELEASE_GAP: Duration = Duration::from_millis(100);

type SleepFn = Arc<dyn Fn(Duration) + Send + Sync>;
type RemoveFn = Arc<dyn Fn(&Path) -> io::Result<()> + Send + Sync>;

/// Timeouts and test seams (`LockDeps`).
#[derive(Clone)]
pub struct LockOptions {
    pub timeout: Duration,
    pub touch: Duration,
    pub sleep: SleepFn,
    /// Removes a lock directory (tests replace it to simulate a busy one).
    pub remove_dir: RemoveFn,
}

impl Default for LockOptions {
    fn default() -> Self {
        Self {
            timeout: LOCK_TIMEOUT,
            touch: TOUCH,
            sleep: Arc::new(std::thread::sleep),
            remove_dir: Arc::new(|p: &Path| fs::remove_dir(p)),
        }
    }
}

impl std::fmt::Debug for LockOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LockOptions").field("timeout", &self.timeout).field("touch", &self.touch).finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    /// `LockTimeout`: somebody else holds the lock (its file name).
    #[error("lock held: {0}")]
    Timeout(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// EPERM / EBUSY as libuv reports them (ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_BUSY).
fn is_busy(error: &io::Error) -> bool {
    match error.raw_os_error() {
        #[cfg(windows)]
        Some(code) => matches!(code, 5 | 32 | 33 | 170),
        #[cfg(not(windows))]
        Some(code) => matches!(code, 1 | 16),
        None => matches!(error.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy),
    }
}

fn jitter() -> Duration {
    let mut b = [0u8; 2];
    let r = if getrandom::fill(&mut b).is_ok() { u16::from_le_bytes(b) % 250 } else { 125 };
    Duration::from_millis(250 + u64::from(r))
}

/// Sets the access and modification time of a directory to now (`utimes(path, now, now)`).
pub fn touch_dir(path: &Path) -> io::Result<()> {
    let mut open = fs::OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_WRITE_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS (needed to open a directory).
        open.access_mode(0x100).custom_flags(0x0200_0000);
    }
    #[cfg(not(windows))]
    open.read(true);
    let dir = open.open(path)?;
    let now = SystemTime::now();
    dir.set_times(fs::FileTimes::new().set_accessed(now).set_modified(now))
}

/// One held directory lock. Touched every [`LockOptions::touch`] until released; released on drop.
pub struct DirLock {
    path: PathBuf,
    stop: Option<mpsc::Sender<()>>,
    toucher: Option<JoinHandle<()>>,
    released: bool,
    options: LockOptions,
}

impl std::fmt::Debug for DirLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DirLock").field("path", &self.path).field("released", &self.released).finish()
    }
}

impl DirLock {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Stops touching and removes the lock directory, retrying a briefly busy one; a lock that is already gone is fine.
    pub fn release(mut self) -> io::Result<()> {
        self.release_inner()
    }

    fn release_inner(&mut self) -> io::Result<()> {
        if self.released {
            return Ok(());
        }
        self.released = true;
        drop(self.stop.take());
        if let Some(t) = self.toucher.take() {
            let _ = t.join();
        }
        // A lock left behind would make Claude Code wait for it to go stale (60 s) before it can renew its login.
        let mut attempt = 1;
        loop {
            match (self.options.remove_dir)(&self.path) {
                Ok(()) => return Ok(()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(e) if !is_busy(&e) || attempt >= RELEASE_TRIES => return Err(e),
                Err(_) => {}
            }
            (self.options.sleep)(RELEASE_GAP);
            attempt += 1;
        }
    }
}

impl Drop for DirLock {
    fn drop(&mut self) {
        let _ = self.release_inner();
    }
}

/// Takes one directory lock (never creating its parent). A lock older than `stale` is a dead holder's: removed and retaken.
pub fn acquire_dir_lock(path: &Path, stale: Duration, options: &LockOptions) -> Result<DirLock, LockError> {
    let start = Instant::now();
    loop {
        // On Windows a lock directory another holder has just removed stays "delete pending" while a handle to it is open
        // (its toucher, an indexer): mkdir and stat then fail with ERROR_ACCESS_DENIED. That is a lock on its way out, not
        // a real error, so it is waited for like a held lock (within the timeout).
        let mut pending = false;
        match fs::create_dir(path) {
            Ok(()) => break,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) if cfg!(windows) && is_busy(&e) => pending = true,
            Err(e) => return Err(e.into()),
        }
        if start.elapsed() > options.timeout {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            return Err(LockError::Timeout(name));
        }
        if pending {
            (options.sleep)(Duration::from_millis(10));
            continue;
        }
        let mtime = match fs::metadata(path).and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) if cfg!(windows) && is_busy(&e) => {
                (options.sleep)(Duration::from_millis(10));
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        if SystemTime::now().duration_since(mtime).unwrap_or_default() > stale {
            // A dead holder (the protocol's rule): remove and retake; losing the race to another waiter just loops again.
            if (options.remove_dir)(path).is_err() {
                (options.sleep)(Duration::from_millis(50));
            }
            continue;
        }
        (options.sleep)(jitter());
    }
    let (stop, stopped) = mpsc::channel::<()>();
    let touched = path.to_path_buf();
    let every = options.touch;
    let toucher = std::thread::Builder::new()
        .name("claude-lock-touch".into())
        .spawn(move || {
            while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(every) {
                let _ = touch_dir(&touched);
            }
        })
        .ok();
    Ok(DirLock { path: path.to_path_buf(), stop: Some(stop), toucher, released: false, options: options.clone() })
}

/// The three lock directories of a Claude Code login.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeLockPaths {
    pub primary: PathBuf,
    pub legacy: PathBuf,
    pub config: PathBuf,
}

/// `credentials` is `<config dir>/.credentials.json`, `claude_json` the global config (`~/.claude.json` or
/// `<CLAUDE_CONFIG_DIR>/.claude.json`). Claude Code appends `.lock` to the resolved config dir (symlinks and junctions
/// followed, no `\\?\` prefix).
pub fn claude_lock_paths(credentials: &Path, claude_json: &Path) -> ClaudeLockPaths {
    let config_dir = credentials.parent().unwrap_or(Path::new("."));
    let real = dunce::canonicalize(config_dir).unwrap_or_else(|_| config_dir.to_path_buf());
    let with_suffix = |p: &Path| {
        let mut s = p.as_os_str().to_owned();
        s.push(".lock");
        PathBuf::from(s)
    };
    ClaudeLockPaths {
        primary: config_dir.join(".oauth_refresh.lock"),
        legacy: with_suffix(&real),
        config: with_suffix(claude_json),
    }
}

/// Runs `f` holding the credential locks (primary, then legacy) and, unless `credentials_only`, the config lock; they are
/// always released (in reverse order), also when `f` fails or panics. A lock that cannot be taken releases the ones taken.
pub fn with_claude_locks<T>(
    credentials: &Path,
    claude_json: &Path,
    credentials_only: bool,
    options: &LockOptions,
    f: impl FnOnce() -> T,
) -> Result<T, LockError> {
    let paths = claude_lock_paths(credentials, claude_json);
    let mut held: Vec<DirLock> = Vec::with_capacity(3);
    let mut wanted = vec![(paths.primary, CREDENTIALS_STALE), (paths.legacy, CREDENTIALS_STALE)];
    if !credentials_only {
        wanted.push((paths.config, CONFIG_STALE));
    }
    let mut failure = None;
    for (path, stale) in wanted {
        match acquire_dir_lock(&path, stale, options) {
            Ok(lock) => held.push(lock),
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    let result = match failure {
        Some(e) => Err(e),
        None => {
            // Released in reverse order also when `f` panics.
            struct Reverse(Vec<DirLock>);
            impl Drop for Reverse {
                fn drop(&mut self) {
                    while let Some(lock) = self.0.pop() {
                        let _ = lock.release();
                    }
                }
            }
            let _guard = Reverse(std::mem::take(&mut held));
            Ok(f())
        }
    };
    while let Some(lock) = held.pop() {
        let _ = lock.release();
    }
    result
}

#[cfg(test)]
mod tests;
