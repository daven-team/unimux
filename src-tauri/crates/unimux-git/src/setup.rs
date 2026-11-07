//! "This is not a repository yet" and "Git is missing" (G4, the `git:init` and `git:installGit` handlers of src/main/gitIpc.ts).
//!
//! `git init -b main` (falling back to `git init` for a git older than 2.28) runs in the project folder only when it really is
//! no repository. Installing Git uses a package manager we can drive without a shell: winget on Windows (fixed arguments,
//! the Git.Git package from the winget source only), `xcode-select --install` on macOS (Apple's own installer dialog);
//! elsewhere the caller opens the download page. Nothing here takes a program or an argument from the renderer.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use unimux_exec::{ExecError, ExecOptions, Program};

use crate::Git;

/// Timeout of `git init`.
pub const INIT_TIMEOUT: Duration = Duration::from_secs(20);
/// Timeout of the winget install.
pub const WINGET_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Timeout of `xcode-select --install` (it only starts Apple's installer).
pub const XCODE_TIMEOUT: Duration = Duration::from_secs(30);
pub const GIT_DOWNLOAD: &str = "https://git-scm.com/downloads";
pub const ALREADY_REPO: &str = "Ten folder jest już repozytorium git lub git nie jest zainstalowany.";
pub const INSTALLED: &str = "Git zainstalowany.";
pub const XCODE_STARTED: &str = "Instalator narzędzi Xcode (z Gitem) został uruchomiony.";
pub const DOWNLOAD_OPENED: &str = "Otwarto stronę pobierania Gita.";

/// The winget arguments of 1.1.4.
pub const WINGET_ARGS: [&str; 9] = [
    "install",
    "--id",
    "Git.Git",
    "-e",
    "--source",
    "winget",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--silent",
];

/// How Git gets installed on this system.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallPlan {
    /// Run `program args` (with `timeout`); on success answer `message` with `restart: true`.
    Run { program: &'static str, args: Vec<&'static str>, timeout: Duration, message: &'static str, open_on_failure: bool },
    /// Open the download page and answer that it was opened (`restart: false`).
    OpenDownload,
}

/// The plan for `os` (`"windows"`, `"macos"`, anything else).
pub fn install_plan(os: &str) -> InstallPlan {
    match os {
        "windows" => InstallPlan::Run {
            program: "winget",
            args: WINGET_ARGS.to_vec(),
            timeout: WINGET_TIMEOUT,
            message: INSTALLED,
            open_on_failure: true,
        },
        "macos" => InstallPlan::Run {
            program: "xcode-select",
            args: vec!["--install"],
            timeout: XCODE_TIMEOUT,
            message: XCODE_STARTED,
            open_on_failure: false,
        },
        _ => InstallPlan::OpenDownload,
    }
}

/// The `run()` helper of gitIpc.ts: a program without a shell or console window, the app's environment (session variables
/// dropped) with `GIT_TERMINAL_PROMPT=0`. Ok(stdout) or Err(the last three lines of stderr / stdout / the error, joined with
/// spaces).
pub async fn run_plain(
    program: PathBuf,
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    timeout: Duration,
    env: Option<HashMap<OsString, OsString>>,
) -> Result<String, String> {
    let name = program.to_string_lossy().into_owned();
    let mut env = env.unwrap_or_else(unimux_exec::clean_process_env);
    if cfg!(windows) {
        env.retain(|k, _| !k.to_string_lossy().eq_ignore_ascii_case("GIT_TERMINAL_PROMPT"));
    }
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    let options =
        ExecOptions { env: Some(env), cwd, timeout, max_output: 1024 * 1024, stop_at_cap: false, stdin: Some(Vec::new()) };
    let out = match unimux_exec::run_async(Program::Args { program, args }, options).await {
        Ok(out) => out,
        Err(error) => {
            let source = match &error {
                ExecError::Spawn { source, .. } | ExecError::Io(source) => source,
            };
            let message = if source.kind() == std::io::ErrorKind::NotFound {
                format!("spawn {name} ENOENT")
            } else {
                format!("spawn {name} {source}")
            };
            return Err(message);
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.timed_out && out.code == Some(0) {
        return Ok(stdout);
    }
    let message = if out.timed_out { format!("Command failed: {name} (timed out)") } else { format!("Command failed: {name}") };
    Err(error_tail(&stderr, &stdout, &message))
}

/// `(stderr || stdout || error.message).toString().trim().split('\n').slice(-3).join(' ') || error.message`.
pub fn error_tail(stderr: &str, stdout: &str, message: &str) -> String {
    let source = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        message
    };
    let lines: Vec<&str> = crate::text::js_trim(source).split('\n').collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" ");
    if tail.is_empty() { message.to_string() } else { tail }
}

impl Git {
    /// `git init -b main` in `path`, `git init` when that fails. Ok(git's message, trimmed) or Err(the error text). The caller
    /// checked that `path` is no repository ([`Git::probe`]).
    pub async fn init_repo(&self, path: &str) -> Result<String, String> {
        let runner = self.runner();
        let bin = runner.options.bin.clone();
        let env = runner.env(false, path);
        let cwd = Some(PathBuf::from(path));
        let mut result =
            run_plain(bin.clone(), runner.args(&["init", "-b", "main"]), cwd.clone(), INIT_TIMEOUT, Some(env.clone())).await;
        if result.is_err() {
            result = run_plain(bin, runner.args(&["init"]), cwd, INIT_TIMEOUT, Some(env)).await;
        }
        self.forget_root(path);
        result.map(|out| crate::text::js_trim(&out).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_plans() {
        match install_plan("windows") {
            InstallPlan::Run { program, args, timeout, open_on_failure, .. } => {
                assert_eq!(program, "winget");
                assert_eq!(
                    args.join(" "),
                    "install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements --silent"
                );
                assert_eq!(timeout, Duration::from_secs(900));
                assert!(open_on_failure);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(install_plan("macos"), InstallPlan::Run { program: "xcode-select", .. }));
        assert_eq!(install_plan("linux"), InstallPlan::OpenDownload);
    }

    #[test]
    fn error_tail_like_the_reference() {
        assert_eq!(error_tail("a\nb\nc\nd\n", "x", "m"), "b c d");
        assert_eq!(error_tail("", " out ", "m"), "out");
        assert_eq!(error_tail("", "", "Command failed: git"), "Command failed: git");
        assert_eq!(error_tail("  \n ", "", "m"), "m");
    }
}
