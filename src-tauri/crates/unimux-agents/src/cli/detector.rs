//! Port of src/main/cliDetect.ts: finds the Claude Code / Codex binaries without relying on the PATH the app was launched with
//! (known install folders, then the registry-refreshed PATH on Windows, then the user's own shell). All I/O goes through
//! [`CliDeps`], so the whole decision logic is tested with fakes (detector_tests.rs, the cases of test/cli-detect.test.ts).
//!
//! Every detection, probe and registry read runs as its own tokio task shared by all callers (like a JS promise): a caller
//! that stops waiting (`wait_ms`) does not stop the detection, and its result still lands in the cache.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;

use super::status::*;

pub const FOUND_TTL_MS: i64 = 10 * 60_000;
pub const MISSING_TTL_MS: i64 = 30_000;
pub const EXEC_TIMEOUT_MS: u64 = 5000;
/// The registry PATH changes only when something is installed: re-read after a minute, on a window focus, on "check again"
/// and after an install; a failed read is retried on the next spawn.
pub const REGISTRY_TTL_MS: i64 = 60_000;
const NODE_VERSIONS_TRIED: usize = 8;
const WINDOWS_PROBE_TIMEOUT_MS: u64 = 8000;
/// `versionFor`'s default wait.
pub const VERSION_FOR_WAIT_MS: u64 = 2000;

/// One program run (`exec(file, args, {timeout, env, verbatim})`).
#[derive(Debug, Clone, PartialEq)]
pub struct ExecRequest {
    pub file: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
    pub env: Env,
    /// Windows: the arguments joined by spaces and passed untouched (`cmd.exe /d /s /c "..."`).
    pub verbatim: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecResult {
    pub ok: bool,
    pub stdout: String,
    pub timed_out: bool,
}

/// The I/O of the detector (`CliDetectorDeps`).
pub trait CliDeps: Send + Sync + 'static {
    fn os(&self) -> Os;
    fn home(&self) -> String;
    fn env(&self) -> Env;
    fn now(&self) -> i64;
    fn is_file(&self, path: String) -> BoxFuture<'static, bool>;
    /// Directory entries; empty when it cannot be read.
    fn read_dir(&self, path: String) -> BoxFuture<'static, Vec<String>>;
    fn read_file(&self, path: String) -> BoxFuture<'static, Option<String>>;
    /// Never fails: a program that cannot start is `ok: false`.
    fn exec(&self, request: ExecRequest) -> BoxFuture<'static, ExecResult>;
    /// The registry is read at all (Windows, not `MC_CLI_NO_REGISTRY`).
    fn has_registry(&self) -> bool;
    /// Raw Machine / User PATH; None when unreadable. The only registry access.
    fn read_windows_path(&self) -> BoxFuture<'static, Option<RegistryPath>>;
    /// The shell kind cells run (settings.shell).
    fn shell(&self) -> Option<String>;
    /// Test hook (dev-overrides builds): a PowerShell script dot-sourced instead of the user's profile.
    fn probe_profile(&self) -> Option<String>;
}

#[derive(Debug, Clone, Default)]
struct ProbeResult {
    ok: bool,
    reason: Option<CliReason>,
    path: Vec<String>,
    found: BTreeMap<CliId, String>,
    aliased: BTreeSet<CliId>,
}

impl ProbeResult {
    fn failed(reason: CliReason) -> Self {
        Self { ok: false, reason: Some(reason), ..Default::default() }
    }
}

type Task<T> = Shared<BoxFuture<'static, T>>;

/// Starts `fut` now (a JS promise runs whether awaited or not) and shares its result; a panic gives `fallback`.
fn eager<T, F>(fut: F, fallback: T) -> Task<T>
where
    T: Clone + Send + Sync + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let handle = tokio::spawn(fut);
    async move { handle.await.unwrap_or(fallback) }.boxed().shared()
}

type Listener = Arc<dyn Fn(&CliStatusMap) + Send + Sync>;
/// The registry PATH entries (None = unreadable).
type RegistryTask = Task<Option<Vec<String>>>;

#[derive(Default)]
struct Inner {
    cache: CliStatusMap,
    /// Last status handed to listeners; survives invalidation so an unchanged recheck is not announced again.
    announced: CliStatusMap,
    inflight: HashMap<CliId, (u64, Task<CliStatus>)>,
    generation: u64,
    next_id: u64,
    listeners: Vec<(u64, Listener)>,
    probe: Option<(i64, Task<ProbeResult>)>,
    /// (read at, id, task) of the registry PATH read.
    registry: Option<(i64, u64, RegistryTask)>,
    win_probe: Option<(i64, Task<ProbeResult>)>,
    path_versions: HashMap<String, (Option<String>, i64)>,
}

/// Options of [`CliDetector::get`].
#[derive(Debug, Clone, Copy, Default)]
pub struct GetOptions {
    /// A slower detection answers `unknown` / `timeout` instead of making the caller wait (0 = wait for it).
    pub wait_ms: u64,
    pub force: bool,
}

pub struct CliDetector {
    deps: Arc<dyn CliDeps>,
    inner: Mutex<Inner>,
}

impl CliDetector {
    pub fn new(deps: Arc<dyn CliDeps>) -> Arc<Self> {
        Arc::new(Self { deps, inner: Mutex::new(Inner::default()) })
    }

    fn os(&self) -> Os {
        self.deps.os()
    }

    /// Cached status, stale or not; None = never checked.
    pub fn peek(&self, cli: CliId) -> Option<CliStatus> {
        self.inner.lock().cache.get(&cli).cloned()
    }

    pub fn snapshot(&self) -> CliStatusMap {
        self.inner.lock().cache.clone()
    }

    /// Called with the whole map after every announced change; the returned id removes it ([`Self::off_change`]).
    pub fn on_change(&self, listener: impl Fn(&CliStatusMap) + Send + Sync + 'static) -> u64 {
        let mut g = self.inner.lock();
        g.next_id += 1;
        let id = g.next_id;
        g.listeners.push((id, Arc::new(listener)));
        id
    }

    pub fn off_change(&self, id: u64) {
        self.inner.lock().listeners.retain(|(i, _)| *i != id);
    }

    /// Status with caching: `found` 10 min (a stale one is returned at once and re-verified in the background),
    /// `missing` / `unknown` 30 s, concurrent calls share one detection.
    pub async fn get(self: &Arc<Self>, cli: CliId, options: GetOptions) -> CliStatus {
        if !options.force {
            let cached = self.peek(cli);
            if let Some(cached) = cached {
                let age = self.deps.now() - cached.checked_at;
                if cached.state == CliState::Found {
                    if age > FOUND_TTL_MS {
                        drop(self.refresh(cli));
                    }
                    return cached;
                }
                if age <= MISSING_TTL_MS {
                    return cached;
                }
            }
        }
        let run = self.refresh(cli);
        if options.wait_ms == 0 {
            return run.await;
        }
        tokio::select! {
            status = run => status,
            _ = tokio::time::sleep(Duration::from_millis(options.wait_ms)) => {
                CliStatus::new(cli, CliState::Unknown, Some(CliReason::Timeout), self.deps.now())
            }
        }
    }

    /// Forgets cached results (and the shell / registry snapshots); the next `get` detects again.
    pub fn invalidate(&self, cli: Option<CliId>) {
        let mut g = self.inner.lock();
        g.generation += 1;
        g.probe = None;
        g.win_probe = None;
        g.registry = None;
        for id in cli.map(|c| vec![c]).unwrap_or_else(|| CliId::ALL.to_vec()) {
            g.cache.remove(&id);
            g.inflight.remove(&id);
        }
    }

    /// Explicit "check again": invalidates and detects the given CLI (or both).
    pub async fn recheck(self: &Arc<Self>, cli: Option<CliId>) -> CliStatusMap {
        self.invalidate(cli);
        let ids = cli.map(|c| vec![c]).unwrap_or_else(|| CliId::ALL.to_vec());
        futures::future::join_all(ids.into_iter().map(|id| self.get(id, GetOptions { wait_ms: 0, force: true }))).await;
        self.snapshot()
    }

    /// Startup scan: never fails.
    pub async fn refresh_all(self: &Arc<Self>) -> CliStatusMap {
        self.recheck(None).await
    }

    /// The next spawn reads the registry PATH again (window focus: the user may come back from an installer).
    pub fn invalidate_registry(&self) {
        self.inner.lock().registry = None;
    }

    /// Environment for a spawned process: on Windows the PATH is refreshed from the registry, and the folder of the detected
    /// CLI goes in front when the PATH lacks it.
    pub async fn apply_env(self: &Arc<Self>, env: Env, cli: Option<CliId>) -> Env {
        let os = self.os();
        let mut entries = split_path(get_env(&env, "PATH", os), os);
        if os.is_windows()
            && let Some(registry) = self.registry_entries().await
        {
            entries = merge_paths(&entries, &registry, os);
        }
        let status = cli.and_then(|c| self.peek(c));
        if let Some(path) = status.as_ref().filter(|s| s.state == CliState::Found).and_then(|s| s.path.as_deref()) {
            entries = prepend_dir(&entries, &dirname(os, path), os);
        }
        if entries.is_empty() { env } else { with_path(&env, &join_path(&entries, os), os) }
    }

    /// Version of the binary a cell started with `env` really runs (the first one on its PATH may be an older install than the
    /// detected one). None when unknown or slower than `wait_ms`. A command the user's shell resolves itself keeps the detected
    /// version.
    pub async fn version_for(self: &Arc<Self>, cli: CliId, env: &Env, wait_ms: u64) -> Option<String> {
        let os = self.os();
        let detected = self.peek(cli);
        if let Some(d) = &detected
            && d.state == CliState::Found
            && d.source == Some(CliSource::Shell)
        {
            return d.version.clone();
        }
        let names = executable_names(cli, os, get_env(env, "PATHEXT", os));
        let mut first: Option<String> = None;
        'dirs: for dir in split_path(get_env(env, "PATH", os), os) {
            for name in &names {
                let full = join(os, &[&dir, name]);
                if self.deps.is_file(full.clone()).await {
                    first = Some(full);
                    break 'dirs;
                }
            }
        }
        let same = |a: &str, b: &str| if os.is_windows() { a.to_lowercase() == b.to_lowercase() } else { a == b };
        let detected_version = detected.as_ref().and_then(|d| d.version.clone());
        let Some(first) = first else { return detected_version };
        if let Some(dp) = detected.as_ref().and_then(|d| d.path.as_deref())
            && same(&dirname(os, &first), &dirname(os, dp))
        {
            return detected_version;
        }
        if let Some((version, at)) = self.inner.lock().path_versions.get(&first).cloned()
            && self.deps.now() - at <= FOUND_TTL_MS
        {
            return version;
        }
        let me = self.clone();
        let path = first.clone();
        let run = eager(
            async move {
                let status = me.verify(cli, path.clone(), CliSource::Path).await;
                let now = me.deps.now();
                me.inner.lock().path_versions.insert(path, (status.version.clone(), now));
                status.version
            },
            None,
        );
        tokio::select! {
            v = run => v,
            _ = tokio::time::sleep(Duration::from_millis(wait_ms)) => None,
        }
    }

    fn refresh(self: &Arc<Self>, cli: CliId) -> Task<CliStatus> {
        let mut g = self.inner.lock();
        if let Some((_, task)) = g.inflight.get(&cli) {
            return task.clone();
        }
        let generation = g.generation;
        g.next_id += 1;
        let id = g.next_id;
        let me = self.clone();
        let fallback = CliStatus::new(cli, CliState::Unknown, Some(CliReason::ProbeFailed), self.deps.now());
        let task = eager(
            async move {
                let status = me.detect(cli).await;
                // A recheck that started meanwhile owns the cache; this older result only goes to its own callers.
                if me.inner.lock().generation == generation {
                    me.store(status.clone());
                }
                let mut g = me.inner.lock();
                if g.inflight.get(&cli).is_some_and(|(i, _)| *i == id) {
                    g.inflight.remove(&cli);
                }
                status
            },
            fallback,
        );
        g.inflight.insert(cli, (id, task.clone()));
        task
    }

    fn store(&self, status: CliStatus) {
        let notify = {
            let mut g = self.inner.lock();
            let previous = g.announced.get(&status.cli).cloned();
            g.cache.insert(status.cli, status.clone());
            g.announced.insert(status.cli, status.clone());
            if previous.is_none() || !same_status(previous.as_ref(), Some(&status)) {
                Some((g.cache.clone(), g.listeners.iter().map(|(_, l)| l.clone()).collect::<Vec<_>>()))
            } else {
                None
            }
        };
        if let Some((map, listeners)) = notify {
            for l in listeners {
                l(&map);
            }
        }
    }

    async fn in_dir(&self, dir: &str, names: &[String]) -> Option<String> {
        for name in names {
            let full = join(self.os(), &[dir, name]);
            if self.deps.is_file(full.clone()).await {
                return Some(full);
            }
        }
        None
    }

    async fn detect(self: &Arc<Self>, cli: CliId) -> CliStatus {
        let os = self.os();
        let env = self.deps.env();
        let names = executable_names(cli, os, get_env(&env, "PATHEXT", os));

        for dir in self.known_dirs(&env).await {
            if let Some(hit) = self.in_dir(&dir, &names).await {
                return self.verify(cli, hit, CliSource::Known).await;
            }
        }

        let (entries, complete) = self.path_entries(&env).await;
        for dir in &entries {
            if let Some(hit) = self.in_dir(dir, &names).await {
                return self.verify(cli, hit, CliSource::Path).await;
            }
        }

        let mut probe_reason: Option<CliReason> = None;
        if !os.is_windows() {
            let probe = self.shell_probe(&env).await;
            if probe.ok {
                if let Some(direct) = probe.found.get(&cli)
                    && self.deps.is_file(direct.clone()).await
                {
                    return self.verify(cli, direct.clone(), CliSource::Shell).await;
                }
                for dir in &probe.path {
                    if let Some(hit) = self.in_dir(dir, &names).await {
                        return self.verify(cli, hit, CliSource::Shell).await;
                    }
                }
                // An alias or function is not a file, but a cell (login shell) can run it: never a "missing" verdict.
                if probe.aliased.contains(&cli) {
                    probe_reason = Some(CliReason::ShellAlias);
                }
            } else {
                probe_reason = Some(probe.reason.unwrap_or(CliReason::ProbeFailed));
            }
        } else if self.windows_probe_shell().is_some() {
            // The user's PowerShell (profile loaded, like a cell) may know the command by a PATH the profile builds, or as an alias.
            let probe = self.windows_shell_probe(&env, &entries).await;
            if probe.ok {
                let direct = probe.found.get(&cli).cloned();
                if let Some(direct) = &direct
                    && self.deps.is_file(direct.clone()).await
                {
                    return self.verify(cli, direct.clone(), CliSource::Shell).await;
                }
                if direct.is_some() || probe.aliased.contains(&cli) {
                    probe_reason = Some(CliReason::ShellAlias);
                }
            } else {
                probe_reason = Some(probe.reason.unwrap_or(CliReason::ProbeFailed));
            }
        }

        let checked_at = self.deps.now();
        // Not finding it is only a verdict when every place was really searched.
        if let Some(reason) = probe_reason {
            return CliStatus::new(cli, CliState::Unknown, Some(reason), checked_at);
        }
        if !complete {
            return CliStatus::new(cli, CliState::Unknown, Some(CliReason::RegistryFailed), checked_at);
        }
        CliStatus::new(cli, CliState::Missing, Some(CliReason::NotOnPath), checked_at)
    }

    async fn known_dirs(&self, env: &Env) -> Vec<String> {
        let os = self.os();
        let home = self.deps.home();
        let mut dirs = known_cli_dirs(os, env, &home);
        let from_env = |dirs: &mut Vec<String>, name: &str, sub: Option<&str>| {
            if let Some(value) = get_env(env, name, os).filter(|v| !v.is_empty()) {
                dirs.push(match sub {
                    Some(sub) => join(os, &[value, sub]),
                    None => value.to_string(),
                });
            }
        };
        from_env(&mut dirs, "NVM_BIN", None);
        from_env(&mut dirs, "VOLTA_HOME", Some("bin"));
        from_env(&mut dirs, "BUN_INSTALL", Some("bin"));
        from_env(&mut dirs, "PNPM_HOME", None);
        let prefix = get_env(env, "npm_config_prefix", os).or_else(|| get_env(env, "NPM_CONFIG_PREFIX", os));
        if let Some(prefix) = prefix.filter(|p| !p.is_empty()) {
            dirs.push(if os.is_windows() { prefix.to_string() } else { join(os, &[prefix, "bin"]) });
        }
        if let Some(npmrc) = self.deps.read_file(join(os, &[&home, ".npmrc"])).await
            && let Some(dir) = npm_prefix_bin_dir(&npmrc, os, &home)
        {
            dirs.push(dir);
        }
        for (root, suffix) in versioned_cli_dirs(os, &home) {
            let versions = sort_versions_desc(&self.deps.read_dir(root.clone()).await);
            for version in versions.into_iter().take(NODE_VERSIONS_TRIED) {
                let mut parts: Vec<&str> = vec![&root, &version];
                if !suffix.is_empty() {
                    parts.extend(suffix.split('/'));
                }
                dirs.push(join(os, &parts));
            }
        }
        let mut seen = std::collections::HashSet::new();
        dirs.retain(|d| seen.insert(d.clone()));
        dirs
    }

    async fn path_entries(self: &Arc<Self>, env: &Env) -> (Vec<String>, bool) {
        let os = self.os();
        let base = split_path(get_env(env, "PATH", os), os);
        if !os.is_windows() || !self.deps.has_registry() {
            return (base, true);
        }
        let registry = self.registry_entries().await;
        let complete = registry.is_some();
        (merge_paths(&base, &registry.unwrap_or_default(), os), complete)
    }

    async fn registry_entries(self: &Arc<Self>) -> Option<Vec<String>> {
        if !self.deps.has_registry() {
            return None;
        }
        let task = {
            let mut g = self.inner.lock();
            match &g.registry {
                Some((at, _, task)) if self.deps.now() - *at <= REGISTRY_TTL_MS => task.clone(),
                _ => {
                    g.next_id += 1;
                    let id = g.next_id;
                    let me = self.clone();
                    let task = eager(
                        async move {
                            let raw = me.deps.read_windows_path().await;
                            let entries = raw.map(|r| registry_path_entries(&r, &me.deps.env()));
                            if entries.is_none() {
                                let mut g = me.inner.lock();
                                if g.registry.as_ref().is_some_and(|(_, i, _)| *i == id) {
                                    g.registry = None;
                                }
                            }
                            entries
                        },
                        None,
                    );
                    g.registry = Some((self.deps.now(), id, task.clone()));
                    task
                }
            }
        };
        task.await
    }

    /// Cells use PowerShell kinds with their profile; cmd.exe has no profile worth asking.
    fn windows_probe_shell(&self) -> Option<&'static str> {
        match self.deps.shell().as_deref() {
            Some("cmd") => None,
            Some("pwsh") => Some("pwsh"),
            _ => Some("powershell"),
        }
    }

    fn shell_probe(self: &Arc<Self>, env: &Env) -> Task<ProbeResult> {
        let mut g = self.inner.lock();
        if let Some((at, task)) = &g.probe
            && self.deps.now() - *at <= MISSING_TTL_MS
        {
            return task.clone();
        }
        let me = self.clone();
        let env = env.clone();
        let task = eager(async move { me.run_probe(env).await }, ProbeResult::failed(CliReason::ProbeFailed));
        g.probe = Some((self.deps.now(), task.clone()));
        task
    }

    fn windows_shell_probe(self: &Arc<Self>, env: &Env, entries: &[String]) -> Task<ProbeResult> {
        let mut g = self.inner.lock();
        if let Some((at, task)) = &g.win_probe
            && self.deps.now() - *at <= MISSING_TTL_MS
        {
            return task.clone();
        }
        let me = self.clone();
        let env = env.clone();
        let entries = entries.to_vec();
        let task = eager(async move { me.run_windows_probe(env, entries).await }, ProbeResult::failed(CliReason::ProbeFailed));
        g.win_probe = Some((self.deps.now(), task.clone()));
        task
    }

    /// `powershell -Command Get-Command ...` with the profile loaded; stdin closed, time and output capped.
    async fn run_windows_probe(&self, env: Env, entries: Vec<String>) -> ProbeResult {
        let os = self.os();
        let script = windows_command_probe_script();
        let args: Vec<String> = match self.deps.probe_profile() {
            Some(profile) => vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                format!(". '{}'; {script}", profile.replace('\'', "''")),
            ],
            None => vec!["-NoLogo".into(), "-NonInteractive".into(), "-Command".into(), script],
        };
        let run_env = with_path(&clean_env(&env), &join_path(&entries, os), os);
        let files: &[&str] =
            if self.windows_probe_shell() == Some("pwsh") { &["pwsh.exe", "powershell.exe"] } else { &["powershell.exe"] };
        let mut timed_out = false;
        for file in files {
            let result = self
                .deps
                .exec(ExecRequest {
                    file: file.to_string(),
                    args: args.clone(),
                    timeout_ms: WINDOWS_PROBE_TIMEOUT_MS,
                    env: run_env.clone(),
                    verbatim: false,
                })
                .await;
            let parsed = parse_windows_command_probe(&result.stdout);
            if parsed.ran {
                return ProbeResult { ok: true, reason: None, path: vec![], found: parsed.found, aliased: parsed.aliased };
            }
            timed_out = timed_out || result.timed_out;
        }
        ProbeResult::failed(if timed_out { CliReason::Timeout } else { CliReason::ProbeFailed })
    }

    /// The shell cells run does the login probe; `$SHELL` only when that one is not there.
    async fn probe_shell_file(&self, env: &Env) -> String {
        let os = self.os();
        if let Some(configured) = self.deps.shell() {
            let file = posix_shell_file(Some(&configured), os);
            if self.deps.is_file(file.to_string()).await {
                return file.to_string();
            }
        }
        match get_env(env, "SHELL", os).filter(|s| !s.is_empty()) {
            Some(s) => s.to_string(),
            None => if os == Os::Mac { "/bin/zsh" } else { "/bin/bash" }.to_string(),
        }
    }

    /// The login shell prints marker lines (rc files may print anything else); this also harvests the user's real PATH.
    async fn run_probe(&self, env: Env) -> ProbeResult {
        let shell = self.probe_shell_file(&env).await;
        let script = if shell.starts_with('/') { shell_probe_script(&shell) } else { None };
        let Some(script) = script else { return ProbeResult::failed(CliReason::ProbeFailed) };
        let mut run_env = clean_env(&env);
        run_env.push(("Unimux_PROBE".into(), "1".into()));
        let result = self
            .deps
            .exec(ExecRequest {
                file: shell,
                args: vec!["-ilc".into(), script.into()],
                timeout_ms: EXEC_TIMEOUT_MS,
                env: run_env,
                verbatim: false,
            })
            .await;
        let parsed = parse_shell_probe(&result.stdout);
        if parsed.path.is_empty() {
            return ProbeResult::failed(if result.timed_out { CliReason::Timeout } else { CliReason::ProbeFailed });
        }
        ProbeResult { ok: true, reason: None, path: parsed.path, found: parsed.found, aliased: parsed.aliased }
    }

    /// `<bin> --version`; the file existing is what makes it `found`, the version is a bonus (fail open).
    async fn verify(&self, cli: CliId, path: String, source: CliSource) -> CliStatus {
        let os = self.os();
        let base = |reason: Option<CliReason>, version: Option<String>, now: i64| CliStatus {
            cli,
            state: CliState::Found,
            path: Some(path.clone()),
            version,
            source: Some(source),
            reason,
            checked_at: now,
        };
        let checked_at = self.deps.now();
        let env = clean_env(&self.deps.env());
        // Shims (npm, nvm) start `node` from the PATH, which usually sits next to them.
        let entries = prepend_dir(&split_path(get_env(&env, "PATH", os), os), &dirname(os, &path), os);
        let exec_env = with_path(&env, &join_path(&entries, os), os);
        let mut file = path.clone();
        let mut args = vec!["--version".to_string()];
        let mut verbatim = false;
        // Windows: through cmd.exe, also for an .exe (CreateProcess of a 300 MB codex.exe takes ~0.8 s; started by cmd.exe that
        // wait is cmd's). An .exe whose path cannot be quoted is run directly.
        let lower = path.to_lowercase();
        let shim = lower.ends_with(".cmd") || lower.ends_with(".bat");
        let quoted = quote_for_cmd(&path);
        if os.is_windows() && (shim || quoted.is_some()) {
            // Inside quotes `& | < > ^` are literal (`C:\Users\R&D` works); only `"`, `%` and line breaks cannot be quoted.
            let Some(quoted) = quoted else { return base(Some(CliReason::VersionFailed), None, checked_at) };
            file = get_env(&env, "ComSpec", os).filter(|c| !c.is_empty()).unwrap_or("cmd.exe").to_string();
            args = vec!["/d".into(), "/s".into(), "/c".into(), format!("\"{quoted} --version\"")];
            verbatim = true;
        }
        let result = self.deps.exec(ExecRequest { file, args, timeout_ms: EXEC_TIMEOUT_MS, env: exec_env, verbatim }).await;
        match parse_version(&result.stdout) {
            Some(version) => base(None, Some(version), checked_at),
            None => base(Some(if result.timed_out { CliReason::Timeout } else { CliReason::VersionFailed }), None, checked_at),
        }
    }
}

#[cfg(test)]
#[path = "detector_tests.rs"]
mod tests;
