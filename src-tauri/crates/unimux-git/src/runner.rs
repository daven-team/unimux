//! Running the system `git` (port of the runner half of src/main/git.ts): no shell, always inside a folder the caller resolved,
//! through unimux-exec (no console window, the whole tree in a Job Object / process group, killed on timeout), with the global
//! safety arguments, a scrubbed and quiet environment, output caps and timeouts:
//!
//! - reads: `GIT_OPTIONAL_LOCKS=0`, output capped at 4 MiB (diffs 1 MiB) and the command stopped when it prints more (an error
//!   `too-large` unless the caller copes with a cut-off result);
//! - writes: the output kept is capped at 64 MiB, the excess is dropped, the command is never stopped for it (that could leave
//!   a lock behind);
//! - timeouts: 10 s local reads, 60 s network and hook-running operations, 10 min clone; a write that had to be killed releases
//!   the `index.lock` it left behind ([`release_stale_lock`]).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

use regex::Regex;
use serde::Serialize;
use unimux_exec::{ExecError, ExecOptions, Program};

use crate::paths::is_inside_path;
use crate::text::trim_git_text_default;

pub const READ_TIMEOUT: Duration = Duration::from_secs(10);
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(60);
pub const CLONE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Cap of the output kept from one read.
pub const OUTPUT_CAP: usize = 4 * 1024 * 1024;
/// Cap of the output kept from one write.
pub const WRITE_OUTPUT_CAP: usize = 64 * 1024 * 1024;
/// Cap of a diff.
pub const DIFF_CAP: usize = 1024 * 1024;

pub const INSTALL_HINT: &str = "Nie znaleziono polecenia git. Zainstaluj Git (git-scm.com) i uruchom aplikację ponownie.";
pub const UNTRUSTED: &str =
    "To repozytorium ma w konfiguracji programy, które git może uruchomić. Zaufaj mu, aby użyć tej operacji.";
pub const NOT_REPO: &str = "To nie jest repozytorium git.";
pub const TOO_LARGE: &str = "Wynik polecenia git jest zbyt duży.";
pub const TIMED_OUT: &str = "Git nie odpowiedział w wyznaczonym czasie.";
pub const GONE: &str = "Folder już nie istnieje.";

/// `GitErrorCode` of src/shared/git.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitErrorCode {
    NotRepo,
    NoGit,
    Timeout,
    Busy,
    Invalid,
    Dirty,
    TooLarge,
    Gone,
    Untrusted,
    Parent,
    Failed,
}

impl GitErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRepo => "not-repo",
            Self::NoGit => "no-git",
            Self::Timeout => "timeout",
            Self::Busy => "busy",
            Self::Invalid => "invalid",
            Self::Dirty => "dirty",
            Self::TooLarge => "too-large",
            Self::Gone => "gone",
            Self::Untrusted => "untrusted",
            Self::Parent => "parent",
            Self::Failed => "failed",
        }
    }
}

/// `GitFailure` of git.ts: a code and the (Polish or git's own, trimmed) message the panel shows.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GitFailure {
    pub code: GitErrorCode,
    pub message: String,
}

impl GitFailure {
    pub fn new(code: GitErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// `GitResult<T>`: `Ok(data)` is `{ok: true, data}`, `Err(failure)` is `{ok: false, code, error}` ([`result_json`]).
pub type GitResult<T> = Result<T, GitFailure>;

/// The wire form of a [`GitResult`].
pub fn result_json<T: Serialize>(result: &GitResult<T>) -> serde_json::Value {
    match result {
        Ok(data) => serde_json::json!({ "ok": true, "data": data }),
        Err(f) => serde_json::json!({ "ok": false, "code": f.code.as_str(), "error": f.message }),
    }
}

/// The GitHub sign-in of unimux as seen by git's network operations (`remoteAuth` / `remoteAuthRefused` of `GitOptions` in
/// git.ts, plus the two refusal checks of src/main/github/gitEnv.ts, which live with the sign-in in unimux-accounts).
pub trait RemoteAuth: Send + Sync + std::fmt::Debug {
    /// The environment additions of fetch, pull and push (an `https://github.com/` header), None when there is no sign-in.
    /// Never on the command line.
    fn env(&self) -> Option<Vec<(String, String)>>;
    /// `githubAuthRefused(message)`: GitHub refused the credentials of a network operation.
    fn auth_refused(&self, message: &str) -> bool;
    /// `githubTokenRefused(message)`: GitHub no longer accepts the token at all (401).
    fn token_refused(&self, message: &str) -> bool;
    /// `remoteAuthRefused()`: GitHub refused the sign-in as a whole; its owner checks it and forgets it when it is dead.
    fn refused(&self);
}

/// `GitOptions` of git.ts.
#[derive(Debug, Clone)]
pub struct GitOptions {
    /// The executable (default "git"); tests point it at a stand-in.
    pub bin: PathBuf,
    /// Arguments that go before git's own (a stand-in script).
    pub prefix_args: Vec<OsString>,
    /// Replaces the process environment as the base of the child environment.
    pub env: Option<HashMap<OsString, OsString>>,
    pub read_timeout: Duration,
    pub network_timeout: Duration,
    pub clone_timeout: Duration,
    /// Cap of the output kept from one read (the command is stopped when it prints more).
    pub max_output_bytes: usize,
    /// Cap of the output kept from one write (the excess is discarded; the command is never stopped for it).
    pub write_output_bytes: usize,
    /// Where the trusted repositories are remembered (git-trust.json; memory only when None).
    pub trust_file: Option<PathBuf>,
    /// The GitHub sign-in fetch, pull and push use (G3); None: git's own credentials only.
    pub remote_auth: Option<std::sync::Arc<dyn RemoteAuth>>,
}

impl Default for GitOptions {
    fn default() -> Self {
        Self {
            bin: PathBuf::from("git"),
            prefix_args: Vec::new(),
            env: None,
            read_timeout: READ_TIMEOUT,
            network_timeout: NETWORK_TIMEOUT,
            clone_timeout: CLONE_TIMEOUT,
            max_output_bytes: OUTPUT_CAP,
            write_output_bytes: WRITE_OUTPUT_CAP,
            trust_file: None,
            remote_auth: None,
        }
    }
}

/// `RunOptions` of git.ts. `timeoutMs` is required there; here the default is a local read with [`READ_TIMEOUT`], so a
/// `..Default::default()` can never mean a zero timeout.
#[derive(Debug, Clone)]
pub struct RunOptions {
    pub timeout: Duration,
    /// The cap of a read (default [`GitOptions::max_output_bytes`]); writes always use the write cap.
    pub max_bytes: Option<usize>,
    /// Written to stdin (paths, commit messages); stdin is closed after it (an empty stdin otherwise).
    pub input: Option<String>,
    /// Local read: no optional locks; its output is capped (the command is stopped) and a truncated result is an error unless
    /// allowed.
    pub read: bool,
    /// A read whose caller copes with a cut-off result (it says so to the user).
    pub allow_truncate: bool,
    /// Exit codes besides 0 that are an answer, not a failure (diff --no-index exits 1 when there is a difference).
    pub ok_codes: Vec<i32>,
    /// Variables added to the quiet environment of this run (the credentials of a network operation).
    pub env: Vec<(String, String)>,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self::read(READ_TIMEOUT)
    }
}

impl RunOptions {
    /// A local read with the given timeout.
    pub fn read(timeout: Duration) -> Self {
        Self { timeout, max_bytes: None, input: None, read: true, allow_truncate: false, ok_codes: Vec::new(), env: Vec::new() }
    }
    /// A write with the given timeout.
    pub fn write(timeout: Duration) -> Self {
        Self { read: false, ..Self::read(timeout) }
    }
}

/// `RunOutput` of git.ts. Bytes are decoded like `Buffer.toString('utf8')` (invalid sequences become U+FFFD).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

/// Variables that would point git at another repository, index or configuration than the folder we run it in.
pub static SCRUBBED_ENV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i-u)^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE|GIT_PREFIX|GIT_CONFIG|GIT_CONFIG_SYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_[0-9]+|GIT_CONFIG_VALUE_[0-9]+|GIT_CONFIG_PARAMETERS|GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS)$",
    )
    .expect("scrubbed env regex")
});

/// `SCRUBBED_ENV.test(name)`.
pub fn is_scrubbed_var(name: &str) -> bool {
    SCRUBBED_ENV.is_match(name)
}

/// The variables that keep git quiet: nothing may wait for a terminal, an editor or a pager.
pub const QUIET_ENV: [(&str, &str); 6] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GCM_INTERACTIVE", "never"),
    ("GIT_EDITOR", "true"),
    ("GIT_SEQUENCE_EDITOR", "true"),
    ("GIT_MERGE_AUTOEDIT", "no"),
    ("GIT_PAGER", "cat"),
];

/// The arguments that go before every command. fsmonitor names a program in the repository's config that even `status` would
/// start; showSignature would call gpg for log; ext:: could run any program as a transport.
pub const GLOBAL_ARGS: [&str; 12] = [
    "--no-pager",
    "--literal-pathspecs",
    "-c",
    "core.quotepath=false",
    "-c",
    "color.ui=false",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "log.showSignature=false",
];

/// Sets `key` in an environment map, dropping every other spelling of it on Windows (variable names are case-insensitive
/// there; a Rust map with two spellings would hand the child either one).
fn set_var(env: &mut HashMap<OsString, OsString>, key: &str, value: &str) {
    if cfg!(windows) {
        env.retain(|k, _| !k.to_string_lossy().eq_ignore_ascii_case(key));
    }
    env.insert(key.into(), value.into());
}

/// Runs git: the configuration of one `Git` (bin, base environment, timeouts, caps).
#[derive(Debug, Clone)]
pub struct Runner {
    pub options: GitOptions,
}

impl Runner {
    pub fn new(options: GitOptions) -> Self {
        Self { options }
    }

    /// The child environment (`env(read, cwd)` of git.ts): the base environment without the session variables, without the
    /// variables that would redirect git, without a GIT_CONFIG_GLOBAL inside the repository folder, plus the quiet variables.
    pub fn env(&self, read: bool, cwd: &str) -> HashMap<OsString, OsString> {
        let base = match &self.options.env {
            Some(env) => unimux_exec::clean_env(env.clone()),
            None => unimux_exec::clean_process_env(),
        };
        let mut env: HashMap<OsString, OsString> =
            base.into_iter().filter(|(k, _)| !is_scrubbed_var(&k.to_string_lossy())).collect();
        // The user's own global configuration stays; one that lives inside the repository folder would be repository content.
        env.retain(|k, v| {
            !(k.to_string_lossy().eq_ignore_ascii_case("GIT_CONFIG_GLOBAL") && is_inside_path(cwd, &v.to_string_lossy()))
        });
        for (k, v) in QUIET_ENV {
            set_var(&mut env, k, v);
        }
        if read {
            set_var(&mut env, "GIT_OPTIONAL_LOCKS", "0");
        }
        env
    }

    /// `args(args)` of git.ts: the stand-in prefix, the global safety arguments, then git's own.
    pub fn args<S: AsRef<str>>(&self, args: &[S]) -> Vec<OsString> {
        let mut out: Vec<OsString> = self.options.prefix_args.clone();
        out.extend(GLOBAL_ARGS.iter().map(OsString::from));
        out.extend(args.iter().map(|a| OsString::from(a.as_ref())));
        out
    }

    /// Runs git in `cwd`. `lock_dir` names the git directory of `cwd` (from the cache of git directories) for the release of a
    /// stale `index.lock` after a write had to be killed.
    pub async fn run<S: AsRef<str>>(
        &self,
        cwd: &str,
        args: &[S],
        options: &RunOptions,
        lock_dir: impl FnOnce() -> Option<PathBuf>,
    ) -> GitResult<RunOutput> {
        let read = options.read;
        let cap = if read { options.max_bytes.unwrap_or(self.options.max_output_bytes) } else { self.options.write_output_bytes };
        let mut env = self.env(read, cwd);
        for (k, v) in &options.env {
            set_var(&mut env, k, v);
        }
        let program = Program::Args { program: self.options.bin.clone(), args: self.args(args) };
        let exec = ExecOptions {
            env: Some(env),
            cwd: Some(PathBuf::from(cwd)),
            timeout: options.timeout,
            max_output: cap,
            // A read is stopped when it prints more than it may; a write is never stopped for its output.
            stop_at_cap: read,
            stdin: Some(options.input.clone().unwrap_or_default().into_bytes()),
        };
        let started = SystemTime::now();
        let out = match unimux_exec::run_async(program, exec).await {
            Ok(out) => out,
            Err(error) => return Err(spawn_failure(&self.options.bin, &error)),
        };
        if out.timed_out {
            if !read && let Some(dir) = lock_dir() {
                release_stale_lock(&dir, started);
            }
            return Err(GitFailure::new(GitErrorCode::Timeout, TIMED_OUT));
        }
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        if read && out.truncated {
            return if options.allow_truncate {
                Ok(RunOutput { code: 0, stdout, stderr, truncated: true })
            } else {
                Err(GitFailure::new(GitErrorCode::TooLarge, TOO_LARGE))
            };
        }
        let exit = out.code.unwrap_or(-1);
        if exit == 0 || options.ok_codes.contains(&exit) {
            return Ok(RunOutput { code: exit, stdout, stderr, truncated: out.truncated });
        }
        let text = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git: {exit}")
        };
        Err(GitFailure::new(GitErrorCode::Failed, trim_git_text_default(&text)))
    }
}

/// A program that could not start: a missing git (or a missing folder, which Node reports the same way: `spawn git ENOENT`)
/// is `no-git` with the install hint.
fn spawn_failure(bin: &Path, error: &ExecError) -> GitFailure {
    let source = match error {
        ExecError::Spawn { source, .. } => source,
        ExecError::Io(source) => source,
    };
    // ERROR_DIRECTORY (267): CreateProcess with a working folder that is not there.
    if source.kind() == std::io::ErrorKind::NotFound || (cfg!(windows) && source.raw_os_error() == Some(267)) {
        return GitFailure::new(GitErrorCode::NoGit, INSTALL_HINT);
    }
    GitFailure::new(GitErrorCode::Failed, trim_git_text_default(&format!("spawn {} {source}", bin.display())))
}

/// A write we had to kill may leave `index.lock` behind, which blocks every later git command of the user. The caller holds
/// the repository's write lock, so no other process of ours can own it: a lock created since this operation started (2 s of
/// clock slack) is ours and goes away.
pub fn release_stale_lock(git_dir: &Path, started: SystemTime) {
    let lock = git_dir.join("index.lock");
    let Ok(meta) = std::fs::metadata(&lock) else { return };
    let Ok(modified) = meta.modified() else { return };
    let since = started.checked_sub(Duration::from_secs(2)).unwrap_or(started);
    if modified >= since {
        let _ = std::fs::remove_file(&lock);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_run_options_are_a_read_with_the_read_timeout_never_zero() {
        let d = RunOptions { input: Some("x".into()), ..Default::default() };
        assert_eq!(d.timeout, READ_TIMEOUT);
        assert!(d.read);
        let w = RunOptions::write(NETWORK_TIMEOUT);
        assert!(!w.read);
        assert_eq!(w.timeout, NETWORK_TIMEOUT);
    }

    #[test]
    fn scrubbed_names_match_the_reference_regex() {
        for name in
            ["GIT_DIR", "git_dir", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_12", "GIT_EXTERNAL_DIFF", "Git_Config_Parameters"]
        {
            assert!(is_scrubbed_var(name), "{name}");
        }
        for name in
            ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_KEY_", "GIT_CONFIG_KEY_x", "XGIT_DIR", "GIT_DIR_X", "PATH"]
        {
            assert!(!is_scrubbed_var(name), "{name}");
        }
    }

    #[test]
    fn the_wire_form_of_a_result() {
        let ok: GitResult<u32> = Ok(3);
        assert_eq!(result_json(&ok), serde_json::json!({"ok": true, "data": 3}));
        let bad: GitResult<u32> = Err(GitFailure::new(GitErrorCode::TooLarge, TOO_LARGE));
        assert_eq!(result_json(&bad), serde_json::json!({"ok": false, "code": "too-large", "error": TOO_LARGE}));
        assert_eq!(serde_json::to_value(GitErrorCode::NotRepo).unwrap(), "not-repo");
    }

    #[test]
    fn the_environment_is_scrubbed_and_quiet() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_string_lossy().into_owned();
        let inside = dir.path().join("cfg").to_string_lossy().into_owned();
        let base: HashMap<OsString, OsString> = [
            ("PATH", "/bin".to_string()),
            ("GIT_DIR", "/elsewhere".into()),
            ("git_index_file", "/x".into()),
            ("GIT_CONFIG_KEY_3", "core.editor".into()),
            ("GIT_CONFIG_GLOBAL", inside),
            ("CLAUDECODE", "1".into()),
            ("git_pager", "less".into()),
            ("HOME", "/h".into()),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        let runner = Runner::new(GitOptions { env: Some(base.clone()), ..Default::default() });
        let env = runner.env(true, &repo);
        let get = |k: &str| env.get(&OsString::from(k)).map(|v| v.to_string_lossy().into_owned());
        assert_eq!(get("PATH").as_deref(), Some("/bin"));
        assert_eq!(get("HOME").as_deref(), Some("/h"));
        for gone in ["GIT_DIR", "git_index_file", "GIT_CONFIG_KEY_3", "GIT_CONFIG_GLOBAL", "CLAUDECODE"] {
            assert_eq!(get(gone), None, "{gone}");
        }
        assert_eq!(get("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert_eq!(get("GCM_INTERACTIVE").as_deref(), Some("never"));
        assert_eq!(get("GIT_EDITOR").as_deref(), Some("true"));
        assert_eq!(get("GIT_SEQUENCE_EDITOR").as_deref(), Some("true"));
        assert_eq!(get("GIT_MERGE_AUTOEDIT").as_deref(), Some("no"));
        assert_eq!(get("GIT_PAGER").as_deref(), Some("cat"));
        assert_eq!(get("GIT_OPTIONAL_LOCKS").as_deref(), Some("0"));
        if cfg!(windows) {
            assert_eq!(get("git_pager"), None, "one spelling of a variable on Windows");
        }
        // a write takes optional locks; a global configuration outside the repository stays
        let mut outside = base;
        outside.insert("GIT_CONFIG_GLOBAL".into(), std::env::temp_dir().join("g.gitconfig").into_os_string());
        let runner = Runner::new(GitOptions { env: Some(outside), ..Default::default() });
        let env = runner.env(false, &repo);
        assert!(!env.contains_key(&OsString::from("GIT_OPTIONAL_LOCKS")));
        assert!(env.contains_key(&OsString::from("GIT_CONFIG_GLOBAL")));
    }

    #[test]
    fn global_arguments_come_first() {
        let runner = Runner::new(GitOptions { prefix_args: vec!["stand-in.js".into()], ..Default::default() });
        let args: Vec<String> = runner.args(&["status"]).into_iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(
            args,
            [
                "stand-in.js",
                "--no-pager",
                "--literal-pathspecs",
                "-c",
                "core.quotepath=false",
                "-c",
                "color.ui=false",
                "-c",
                "protocol.ext.allow=never",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "log.showSignature=false",
                "status"
            ]
        );
    }

    #[test]
    fn a_stale_lock_is_released_only_when_it_is_new() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("index.lock");
        std::fs::write(&lock, "").unwrap();
        // a lock that was there long before the operation started is not ours
        release_stale_lock(dir.path(), SystemTime::now() + Duration::from_secs(60));
        assert!(lock.exists());
        release_stale_lock(dir.path(), SystemTime::now());
        assert!(!lock.exists());
        // no lock: nothing happens
        release_stale_lock(dir.path(), SystemTime::now());
    }
}
