//! git runner, caches, parsers, trust, mutations, worktrees, GitHub publish (G1-G4)
//!
//! G1 (this part): the runner on unimux-exec ([`runner`]), the caches ([`cache`]), the canonical folder spelling ([`paths`]),
//! the text helpers of the error messages ([`text`]) and the core of the `Git` class of src/main/git.ts ([`Git`]): running git
//! with the stale-lock release, the repository root and git directory caches, the generation counter, the in-flight dedupe of
//! identical reads and `probe`. Parsers and trust (G2), reads and mutations (G3) and worktrees (G4) build on it; the commands
//! are registered in `unimux-app/src/commands/git.rs`.

pub mod cache;
pub mod paths;
pub mod runner;
pub mod text;

use std::future::Future;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

pub use cache::{CACHE_LIMIT, Generation, Inflight, Lru};
pub use runner::{GitErrorCode, GitFailure, GitOptions, GitResult, RunOptions, RunOutput, Runner, result_json};

/// How long the repository root of a folder is remembered.
pub const ROOT_TTL: Duration = Duration::from_millis(5000);
/// How long a configuration scan is reused for display (G2).
pub const SCAN_TTL: Duration = Duration::from_millis(3000);
/// How long a push target and the remote list are reused while the local configuration file is unchanged (G3).
pub const PUSH_TARGET_TTL: Duration = Duration::from_millis(30_000);
/// `EXISTS_TIMEOUT_MS` of src/main/fsProbe.ts.
pub const EXISTS_TIMEOUT: Duration = Duration::from_millis(4000);

/// The git directory of a checkout and the one it shares with its other worktrees (config, hooks and the write lock live there).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitDirs {
    pub git_dir: String,
    pub common_dir: String,
}

/// `GitProbe` of src/shared/git.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitProbe {
    Repo,
    NoGit,
    NoRepo,
}

/// `pathExists` of src/main/fsProbe.ts: false for an empty path or one with NUL, and after `timeout` (a folder on an offline
/// share can make the check hang for many seconds).
pub async fn path_exists(path: &str, timeout: Duration) -> bool {
    if path.is_empty() || path.contains('\0') {
        return false;
    }
    let owned = path.to_string();
    let check = tokio::task::spawn_blocking(move || access_exists(&owned));
    matches!(tokio::time::timeout(timeout, check).await, Ok(Ok(true)))
}

/// `fs.access(path)` (F_OK) of Node. On Windows libuv asks GetFileAttributesW, which looks at a junction or symbolic link
/// itself, so a link whose target is gone still exists (git then says it is no repository, like 1.1.4).
#[cfg(windows)]
fn access_exists(path: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{GetFileAttributesW, INVALID_FILE_ATTRIBUTES};
    use windows::core::PCWSTR;
    let wide: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that lives across the call.
    unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) != INVALID_FILE_ATTRIBUTES }
}

/// `fs.access(path)` (F_OK) of Node: access(2) follows links, like stat.
#[cfg(not(windows))]
fn access_exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

/// The core of the Git panel's engine (src/main/git.ts `class Git`, the parts below trust).
pub struct Git {
    runner: Runner,
    roots: Mutex<Lru<String, (String, Instant)>>,
    dirs: Mutex<Lru<String, GitDirs>>,
    generation: Generation,
    inflight: Inflight,
}

impl Default for Git {
    fn default() -> Self {
        Self::new(GitOptions::default())
    }
}

impl Git {
    pub fn new(options: GitOptions) -> Self {
        Self {
            runner: Runner::new(options),
            roots: Mutex::new(Lru::default()),
            dirs: Mutex::new(Lru::default()),
            generation: Generation::default(),
            inflight: Inflight::default(),
        }
    }

    pub fn options(&self) -> &GitOptions {
        &self.runner.options
    }

    pub fn runner(&self) -> &Runner {
        &self.runner
    }

    /// Runs git in `cwd` (see [`Runner::run`]); a killed write releases the stale `index.lock` of `cwd`'s known git directory.
    pub async fn run<S: AsRef<str>>(&self, cwd: &str, args: &[S], options: &RunOptions) -> GitResult<RunOutput> {
        self.runner.run(cwd, args, options, || self.dirs.lock().get(&cwd.to_string()).map(|d| PathBuf::from(&d.git_dir))).await
    }

    /// A local read with the read timeout.
    pub fn read_options(&self) -> RunOptions {
        RunOptions::read(self.runner.options.read_timeout)
    }

    /// The current generation (part of the key of shared reads).
    pub fn generation(&self) -> u64 {
        self.generation.get()
    }

    /// Every write and trust change bumps it: reads that started before never answer a request made after.
    pub fn bump_generation(&self) -> u64 {
        self.generation.bump()
    }

    /// `shared(key, work)`: one run for every caller asking for the same key while it still runs. A panic of the work is a
    /// `failed` answer for the callers of that run (a rejected promise in git.ts); the next call runs afresh.
    pub fn shared<T, F>(&self, key: &str, work: F) -> impl Future<Output = GitResult<T>> + Send + 'static
    where
        T: Clone + Send + Sync + 'static,
        F: Future<Output = GitResult<T>> + Send + 'static,
    {
        let run = self.inflight.shared(key, work);
        async move { run.await.unwrap_or_else(|e| Err(GitFailure::new(GitErrorCode::Failed, e.0))) }
    }

    /// The repository root of a folder (git's spelling); cached for [`ROOT_TTL`]. Fails with gone / not-repo / no-git.
    pub async fn root(&self, dir: &str) -> GitResult<String> {
        if let Some((root, at)) = self.roots.lock().get(&dir.to_string())
            && at.elapsed() < ROOT_TTL
        {
            return Ok(root.clone());
        }
        if !path_exists(dir, EXISTS_TIMEOUT).await {
            return Err(GitFailure::new(GitErrorCode::Gone, runner::GONE));
        }
        let out = match self.run(dir, &["rev-parse", "--show-toplevel"], &self.read_options()).await {
            Ok(out) => out,
            Err(e) if e.code == GitErrorCode::Failed && !e.message.to_ascii_lowercase().contains("dubious ownership") => {
                return Err(GitFailure::new(GitErrorCode::NotRepo, runner::NOT_REPO));
            }
            Err(e) => return Err(e),
        };
        let root = text::js_trim(&out.stdout).to_string();
        if root.is_empty() {
            return Err(GitFailure::new(GitErrorCode::NotRepo, runner::NOT_REPO));
        }
        self.roots.lock().remember(dir.to_string(), (root.clone(), Instant::now()));
        Ok(root)
    }

    /// The git directory of this checkout and the common one (remembered without a time limit, like git.ts).
    pub async fn git_dirs(&self, root: &str) -> GitResult<GitDirs> {
        if let Some(known) = self.dirs.lock().get(&root.to_string()) {
            return Ok(known.clone());
        }
        let out = self.run(root, &["rev-parse", "--absolute-git-dir", "--git-common-dir"], &self.read_options()).await?;
        let mut lines = out.stdout.split('\n').map(text::js_trim);
        let git_dir = lines.next().unwrap_or("").to_string();
        let common = lines.next().unwrap_or("").to_string();
        if git_dir.is_empty() {
            return Err(GitFailure::new(GitErrorCode::NotRepo, runner::NOT_REPO));
        }
        let common_dir = paths::resolve(root, if common.is_empty() { &git_dir } else { &common });
        let dirs = GitDirs { git_dir, common_dir };
        self.dirs.lock().remember(root.to_string(), dirs.clone());
        Ok(dirs)
    }

    /// Forgets the cached root of a folder (after a write, a clone or an init).
    pub fn forget_root(&self, dir: &str) {
        self.roots.lock().remove(&dir.to_string());
    }

    /// `probe(dir)`: is it a repository, is git missing, or neither.
    pub async fn probe(&self, dir: &str) -> GitProbe {
        match self.root(dir).await {
            Ok(_) => GitProbe::Repo,
            Err(e) if e.code == GitErrorCode::NoGit => GitProbe::NoGit,
            Err(_) => GitProbe::NoRepo,
        }
    }
}
