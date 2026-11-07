//! git runner, caches, parsers, trust, mutations, worktrees, GitHub publish (G1-G4)
//!
//! G1: the runner on unimux-exec ([`runner`]), the caches ([`cache`]), the canonical folder spelling ([`paths`]), the text
//! helpers of the error messages ([`text`]) and the core of the `Git` class of src/main/git.ts ([`Git`]): running git with the
//! stale-lock release, the repository root and git directory caches, the generation counter, the in-flight dedupe of identical
//! reads and `probe`.
//!
//! G2: src/shared/git.ts ([`shared`]: types, request validation, clone checks, output parsers, commit graph, panel paths),
//! src/shared/gitTrust.ts and `GitTrustStore` ([`trust`]), the trust part of `Git` (scan, trust state, trust info, grant,
//! revoke, the one-use request ids), the worktree list with `resolveDir`, and the request pipeline of src/main/gitHandler.ts
//! ([`handler`]). Reads and mutations (G3) and worktree creation / removal (G4) build on it; the commands are registered in
//! `unimux-app/src/commands/git.rs`.

pub mod cache;
pub mod handler;
pub mod js;
pub mod paths;
pub mod runner;
pub mod shared;
pub mod text;
pub mod trust;

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

pub use cache::{CACHE_LIMIT, Generation, Inflight, Lru};
pub use runner::{GitErrorCode, GitFailure, GitOptions, GitResult, RunOptions, RunOutput, Runner, result_json};
pub use shared::{GitTrustInfo, GitWorktree, TrustState};
pub use trust::{RepoScan, TrustStore};

/// How long a request id is remembered as used (`consume` of git.ts).
pub const REQUEST_ID_TTL: Duration = Duration::from_secs(10 * 60);
/// `'To żądanie zostało już wykonane.'`
pub const ALREADY_DONE: &str = "To żądanie zostało już wykonane.";
/// `'To nie jest worktree tego repozytorium.'`
pub const NOT_A_WORKTREE: &str = "To nie jest worktree tego repozytorium.";

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
    scans: Mutex<Lru<String, (RepoScan, Instant)>>,
    seen: Mutex<HashMap<String, Instant>>,
    trust: TrustStore,
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
        let trust = TrustStore::new(options.trust_file.clone());
        Self {
            runner: Runner::new(options),
            roots: Mutex::new(Lru::default()),
            dirs: Mutex::new(Lru::default()),
            scans: Mutex::new(Lru::default()),
            seen: Mutex::new(HashMap::new()),
            trust,
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
    pub fn shared<T, F>(&self, key: &str, work: F) -> impl Future<Output = GitResult<T>> + Send + 'static + use<T, F>
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

    // ---------- trust (G2) ----------

    /// The trusted repositories (`git.trust` of git.ts).
    pub fn trust_store(&self) -> &TrustStore {
        &self.trust
    }

    /// Forgets the scan of a root (after a write changed its configuration).
    pub fn forget_scan(&self, root: &str) {
        self.scans.lock().remove(&root.to_string());
    }

    /// `scan(root, fresh)`: reads (and starts) nothing from the repository: its local and per-worktree configuration, the
    /// attributes files and the hooks, as the list of risky keys and the fingerprint of exactly that configuration. A scan of
    /// the last [`SCAN_TTL`] is reused unless `fresh`.
    pub async fn scan(&self, root: &str, fresh: bool) -> GitResult<RepoScan> {
        if !fresh
            && let Some((scan, at)) = self.scans.lock().get(&root.to_string())
            && at.elapsed() < SCAN_TTL
        {
            return Ok(scan.clone());
        }
        let dirs = self.git_dirs(root).await?;
        let options = RunOptions { allow_truncate: true, ..self.read_options() };
        let mut fingerprint: Vec<String> = Vec::new();
        let mut keys: Vec<String> = Vec::new();
        let add_key = |keys: &mut Vec<String>, key: String| {
            if !keys.contains(&key) {
                keys.push(key);
            }
        };

        let mut local = trust::parse_config_list(&self.run(root, &["config", "--local", "--list", "-z"], &options).await?.stdout);
        if let Ok(out) = self.run(root, &["config", "--worktree", "--list", "-z"], &options).await {
            local.extend(trust::parse_config_list(&out.stdout));
        }
        let risky = trust::dangerous_config_keys(&local);
        for key in &risky {
            add_key(&mut keys, key.clone());
        }
        for entry in &local {
            if risky.contains(&text::redact_secrets(&entry.key)) {
                fingerprint.push(format!("config:{}={}", entry.key, entry.value));
            }
        }

        // Attributes naming a driver that some configuration defines with a program (a hostile .gitattributes can use a
        // global driver). Files are read off the async threads (a folder can sit on a slow or scanned drive).
        let (r, c) = (root.to_string(), dirs.common_dir.clone());
        let attributes = tokio::task::spawn_blocking(move || trust::attribute_files(&r, &c)).await.unwrap_or_default();
        if !attributes.is_empty() {
            let everything = trust::parse_config_list(&self.run(root, &["config", "--list", "-z"], &options).await?.stdout);
            for key in trust::configured_attribute_drivers(&attributes, &everything) {
                fingerprint.push(format!("attr:{key}"));
                add_key(&mut keys, key);
            }
        }

        // Hooks git would run: any file that is not a ".sample".
        let common = PathBuf::from(&dirs.common_dir);
        let (hook_keys, hook_prints) =
            tokio::task::spawn_blocking(move || trust::hook_fingerprints(&common)).await.unwrap_or_default();
        for key in hook_keys {
            add_key(&mut keys, key);
        }
        fingerprint.extend(hook_prints);

        js::js_sort(&mut keys);
        let scan = RepoScan { keys, hash: trust::fingerprint_hash(&mut fingerprint) };
        self.scans.lock().remember(root.to_string(), (scan.clone(), Instant::now()));
        Ok(scan)
    }

    /// `stateOf(root, fresh)`: safe (nothing to start), trusted (the user trusted exactly this configuration) or untrusted.
    pub async fn state_of(&self, root: &str, fresh: bool) -> GitResult<(TrustState, RepoScan)> {
        let scan = self.scan(root, fresh).await?;
        if scan.keys.is_empty() {
            return Ok((TrustState::Safe, scan));
        }
        let trusted = self.trust.get(root).is_some_and(|hash| hash == scan.hash);
        Ok((if trusted { TrustState::Trusted } else { TrustState::Untrusted }, scan))
    }

    /// `requireTrust(root, fresh)`: fails with `untrusted` unless git may start the repository's programs.
    pub async fn require_trust(&self, root: &str, fresh: bool) -> GitResult<()> {
        match self.state_of(root, fresh).await?.0 {
            TrustState::Untrusted => Err(GitFailure::new(GitErrorCode::Untrusted, runner::UNTRUSTED)),
            _ => Ok(()),
        }
    }

    /// `withinScope(scope, root)`: is the repository's root the project folder or inside it?
    pub fn within_scope(scope: &str, root: &str) -> bool {
        paths::is_inside_path(scope, root)
    }

    /// `trustInfo(dir, scope, cached)`: the trust state for the panel and the Files tree; `cached` (display only) accepts a
    /// scan of the last [`SCAN_TTL`]. Identical calls share one run.
    pub fn trust_info(
        self: &Arc<Self>,
        dir: &str,
        scope: Option<&str>,
        cached: bool,
    ) -> impl Future<Output = GitResult<GitTrustInfo>> + Send + 'static + use<> {
        let key = format!("trust\0{}\0{dir}\0{}\0{cached}", self.generation(), scope.unwrap_or(""));
        let (me, dir, scope) = (self.clone(), dir.to_string(), scope.map(str::to_string));
        self.shared(&key, async move { me.read_trust(&dir, scope.as_deref(), !cached).await })
    }

    /// `readTrust(dir, scope, fresh)`.
    pub async fn read_trust(&self, dir: &str, scope: Option<&str>, fresh: bool) -> GitResult<GitTrustInfo> {
        let root = self.root(dir).await?;
        let (state, scan) = self.state_of(&root, fresh).await?;
        let parent = match scope {
            Some(scope) if !scope.is_empty() => !Self::within_scope(scope, &root),
            _ => false,
        };
        Ok(GitTrustInfo { state, keys: scan.keys, root, parent })
    }

    /// `grantTrust(dir, requestId, scope)`: "Trust this repository": scans again right now and remembers that exact
    /// configuration. Only the dedicated request calls this.
    pub async fn grant_trust(&self, dir: &str, request_id: &str, scope: Option<&str>) -> GitResult<GitTrustInfo> {
        self.consume(request_id)?;
        let root = self.root(dir).await?;
        let (_, scan) = self.state_of(&root, true).await?;
        if !scan.keys.is_empty() {
            self.trust.set(&root, &scan.hash);
        }
        self.bump_generation();
        self.read_trust(dir, scope, true).await
    }

    /// `revokeTrust(dir, requestId, scope)`.
    pub async fn revoke_trust(&self, dir: &str, request_id: &str, scope: Option<&str>) -> GitResult<GitTrustInfo> {
        self.consume(request_id)?;
        let root = self.root(dir).await?;
        self.trust.delete(&root);
        self.bump_generation();
        self.read_trust(dir, scope, true).await
    }

    /// `consume(requestId)`: every mutation id works once; ids older than [`REQUEST_ID_TTL`] are forgotten.
    pub fn consume(&self, request_id: &str) -> GitResult<()> {
        let mut seen = self.seen.lock();
        seen.retain(|_, at| at.elapsed() <= REQUEST_ID_TTL);
        if seen.contains_key(request_id) {
            return Err(GitFailure::new(GitErrorCode::Invalid, ALREADY_DONE));
        }
        seen.insert(request_id.to_string(), Instant::now());
        Ok(())
    }

    // ---------- worktree list (G2; creation and removal are G4) ----------

    /// `worktrees(dir, projectPath, extra, prefer)`: git's own list, with what the project may pick (see
    /// [`shared::worktree_allowed`]) and which one is the project's folder and the preferred one (canonical paths).
    pub async fn worktrees(
        &self,
        dir: &str,
        project_path: Option<&str>,
        extra: &[String],
        prefer: Option<&str>,
    ) -> GitResult<Vec<GitWorktree>> {
        let root = self.root(dir).await?;
        let options = RunOptions { allow_truncate: true, ..self.read_options() };
        let out = self.run(&root, &["worktree", "list", "--porcelain"], &options).await?;
        let project = project_path.map(paths::canonical_path);
        let extras: Vec<String> = extra.iter().map(|p| paths::canonical_path(p)).collect();
        let wanted = prefer.map(paths::canonical_path);
        Ok(shared::parse_worktrees(&out.stdout)
            .into_iter()
            .map(|w| {
                let real = paths::canonical_path(&w.path);
                GitWorktree {
                    allowed: project.as_deref().is_none_or(|p| shared::worktree_allowed(p, &real, &extras)),
                    is_project: project.as_deref() == Some(real.as_str()),
                    preferred: wanted.as_deref() == Some(real.as_str()),
                    ..w
                }
            })
            .collect())
    }

    /// `resolveDir(projectPath, worktree, extra)`: the folder to run in: the project folder, or one of the repository's
    /// worktrees named by the renderer (matched against git's own list and limited to the ones the project may use).
    pub async fn resolve_dir(&self, project_path: &str, worktree: Option<&str>, extra: &[String]) -> GitResult<String> {
        let Some(worktree) = worktree.filter(|w| !w.is_empty()) else { return Ok(project_path.to_string()) };
        let list = self.worktrees(project_path, Some(project_path), extra, None).await?;
        match list.into_iter().find(|w| paths::same_path(&w.path, worktree)) {
            Some(found) if found.allowed => Ok(found.path),
            _ => Err(GitFailure::new(GitErrorCode::Invalid, NOT_A_WORKTREE)),
        }
    }
}
