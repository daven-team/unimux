//! Running the GitHub CLI for its token (`execNoShell` of src/main/github/service.ts): no shell, no console window, a hard
//! timeout, 64 KiB of output, the given environment. A program that does not exist is `NotFound` (Node's ENOENT), so the next
//! usual place is tried; anything else (signed out, too old, slow, too much output) is `Failed`.
//!
//! The bare name `gh` is looked up on the PATH of the environment it runs in, like Node's libuv does: on Windows each entry
//! (sliced like libuv's `search_path`: an entry that starts with `"` or `'` runs to its closing quote, so a `;` inside belongs
//! to the folder, and the outer quote characters are dropped) with `.com` then `.exe` appended (a name with an extension is
//! tried as it is first), elsewhere an executable file of that name. libuv also tries the current directory first on Windows
//! (and for an empty or quotes-only PATH entry); that is left out on purpose (the app's working directory is not a place a
//! program should be picked up from).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::future::BoxFuture;
use unimux_exec::{ExecError, ExecOptions, Program};

pub type Env = Vec<(String, String)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecFailure {
    /// The program is not there (ENOENT).
    NotFound,
    /// It ran and failed, timed out, or could not be started for another reason.
    Failed,
}

/// Runs a program without a shell and answers its stdout (`ExecFile` of auth.ts).
pub trait GhExec: Send + Sync {
    fn run(&self, file: &str, args: &[&str], timeout: Duration, env: &Env) -> BoxFuture<'static, Result<String, ExecFailure>>;
}

/// Which usual places `gh` is looked for in (`process.platform`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GhPlatform {
    Windows,
    Mac,
    Linux,
    Other,
}

impl GhPlatform {
    pub fn current() -> Self {
        if cfg!(windows) {
            GhPlatform::Windows
        } else if cfg!(target_os = "macos") {
            GhPlatform::Mac
        } else if cfg!(target_os = "linux") {
            GhPlatform::Linux
        } else {
            GhPlatform::Other
        }
    }

    /// `GH_FALLBACKS`: where gh usually lives when the app's PATH does not have it.
    pub fn fallbacks(self) -> &'static [&'static str] {
        match self {
            GhPlatform::Mac => &["/opt/homebrew/bin/gh", "/usr/local/bin/gh"],
            GhPlatform::Windows => &["C:\\Program Files\\GitHub CLI\\gh.exe"],
            GhPlatform::Linux => &["/usr/bin/gh", "/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"],
            GhPlatform::Other => &[],
        }
    }
}

/// The output cap of execNoShell (`maxBuffer: 64 * 1024`, per stream).
pub const GH_MAX_OUTPUT: usize = 64 * 1024;

/// The real `execFile`.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemGhExec;

fn env_value<'a>(env: &'a Env, name: &str) -> Option<&'a str> {
    // Windows names are case-insensitive (the first match, like libuv's PATH lookup in the environment block).
    env.iter().find(|(k, _)| if cfg!(windows) { k.eq_ignore_ascii_case(name) } else { k == name }).map(|(_, v)| v.as_str())
}

fn is_file(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.is_file())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    is_file(path)
}

/// Windows: the name as given when it has an extension, then with `.com` and `.exe`.
fn windows_candidates(base: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if base.extension().is_some_and(|e| !e.is_empty()) {
        out.push(base.to_path_buf());
    }
    for ext in [".com", ".exe"] {
        let mut name = base.as_os_str().to_owned();
        name.push(ext);
        out.push(PathBuf::from(name));
    }
    out
}

/// Where `file` is, or None (ENOENT). `windows` picks libuv's Windows rules (a parameter so both are tested on one OS).
pub fn resolve_program(file: &str, env: &Env, windows: bool) -> Option<PathBuf> {
    let has_dir = file.contains('/') || (windows && (file.contains('\\') || file.contains(':')));
    let found = |base: &Path| -> Option<PathBuf> {
        if windows { windows_candidates(base).into_iter().find(|p| is_file(p)) } else { is_executable(base).then(|| base.into()) }
    };
    if has_dir {
        return found(Path::new(file));
    }
    let path = env_value(env, "PATH")?;
    let dirs = if windows { windows_path_entries(path) } else { path.split(':').map(str::to_string).collect() };
    dirs.into_iter().filter(|entry| !entry.is_empty()).find_map(|dir| found(&Path::new(&dir).join(file)))
}

fn is_quote(c: char) -> bool {
    c == '"' || c == '\''
}

/// The folders of a Windows PATH the way libuv's `search_path` slices it: an entry that starts with `"` or `'` runs to the
/// matching closing quote (a `;` inside is part of the folder) and from there to the next `;`; any other entry runs to the
/// next `;`. One leading and one trailing quote character (`"` or `'`) are dropped; quotes elsewhere stay. Entries that end
/// up empty are dropped (libuv would try them as the current directory, see the module doc).
pub fn windows_path_entries(path: &str) -> Vec<String> {
    let chars: Vec<char> = path.chars().collect();
    let next = |from: usize, c: char| chars[from..].iter().position(|x| *x == c).map_or(chars.len(), |i| from + i);
    let mut out = Vec::new();
    let mut start = 0;
    while start <= chars.len() {
        let quote_end = match chars.get(start) {
            Some(&q) if is_quote(q) => next(start + 1, q),
            _ => start,
        };
        let end = next(quote_end, ';');
        let mut slice = &chars[start..end];
        if let [first, rest @ ..] = slice
            && is_quote(*first)
        {
            slice = rest;
        }
        if let [rest @ .., last] = slice
            && is_quote(*last)
        {
            slice = rest;
        }
        if !slice.is_empty() {
            out.push(slice.iter().collect());
        }
        start = end + 1;
    }
    out
}

impl GhExec for SystemGhExec {
    fn run(&self, file: &str, args: &[&str], timeout: Duration, env: &Env) -> BoxFuture<'static, Result<String, ExecFailure>> {
        let resolved = resolve_program(file, env, cfg!(windows));
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        let env = env.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect();
        Box::pin(async move {
            let program = resolved.ok_or(ExecFailure::NotFound)?;
            let options =
                ExecOptions { env: Some(env), timeout, max_output: GH_MAX_OUTPUT, stop_at_cap: true, ..ExecOptions::default() };
            match unimux_exec::run_async(Program::Args { program, args }, options).await {
                Ok(out) if out.ok() => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
                Ok(_) => Err(ExecFailure::Failed),
                Err(ExecError::Spawn { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                    Err(ExecFailure::NotFound)
                }
                Err(_) => Err(ExecFailure::Failed),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(path: &str) -> Env {
        vec![("PATH".to_string(), path.to_string())]
    }

    #[test]
    fn windows_lookup_like_libuv() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("gh.exe"), b"").unwrap();
        // A bare `gh` file (no extension) is never taken on Windows; .com before .exe; quotes in PATH entries dropped.
        std::fs::write(a.join("gh"), b"").unwrap();
        let path = format!("\"{}\";;{}", a.display(), b.display());
        assert_eq!(resolve_program("gh", &env(&path), true), Some(b.join("gh.exe")));
        std::fs::write(a.join("gh.com"), b"").unwrap();
        assert_eq!(resolve_program("gh", &env(&path), true), Some(a.join("gh.com")));
        // A name with an extension is tried as given first.
        assert_eq!(resolve_program("gh.exe", &env(&path), true), Some(b.join("gh.exe")));
        // An absolute path: that file only; a directory is not a program.
        let abs = b.join("gh.exe");
        assert_eq!(resolve_program(&abs.to_string_lossy(), &env(""), true), Some(abs.clone()));
        assert_eq!(resolve_program(&b.join("nope.exe").to_string_lossy(), &env(&path), true), None);
        std::fs::create_dir_all(dir.path().join("c").join("gh.exe")).unwrap();
        assert_eq!(resolve_program("gh", &env(&dir.path().join("c").to_string_lossy()), true), None);
        // No PATH at all: not found.
        assert_eq!(resolve_program("gh", &vec![], true), None);
        // A single-quoted entry, and a double-quoted folder whose name contains ';' (libuv finds gh in both).
        let q = dir.path().join("q");
        let semi = dir.path().join("a;b");
        std::fs::create_dir_all(&q).unwrap();
        std::fs::create_dir_all(&semi).unwrap();
        std::fs::write(q.join("gh.exe"), b"").unwrap();
        std::fs::write(semi.join("gh.exe"), b"").unwrap();
        let single = format!("'{}';{}", q.display(), b.display());
        assert_eq!(resolve_program("gh", &env(&single), true), Some(q.join("gh.exe")));
        let quoted_semi = format!("\"{}\";{}", semi.display(), b.display());
        assert_eq!(resolve_program("gh", &env(&quoted_semi), true), Some(semi.join("gh.exe")));
    }

    #[test]
    fn windows_path_entries_like_libuv_search_path() {
        let e = windows_path_entries;
        assert_eq!(e(r"C:\a;C:\b"), vec![r"C:\a", r"C:\b"]);
        assert_eq!(e(r#""C:\a;b";C:\c"#), vec![r"C:\a;b", r"C:\c"]);
        assert_eq!(e(r"'C:\a;b';C:\c"), vec![r"C:\a;b", r"C:\c"]);
        // Zero-length and quotes-only entries are dropped.
        assert_eq!(e(r#";;C:\a;;"";''"#), vec![r"C:\a"]);
        assert_eq!(e(""), Vec::<String>::new());
        // An unclosed quote runs to the end of PATH.
        assert_eq!(e(r#""C:\a;b"#), vec![r"C:\a;b"]);
        // Text after the closing quote stays up to the next ';'; one trailing quote of either kind is dropped.
        assert_eq!(e(r#""C:\a"x;C:\b'"#), vec![r#"C:\a"x"#, r"C:\b"]);
        // Quotes inside an entry stay (only the outer ones go), and the two quote kinds do not close each other.
        assert_eq!(e(r#"C:\a"b\c"#), vec![r#"C:\a"b\c"#]);
        assert_eq!(e(r#""C:\a';b";C:\c"#), vec![r"C:\a';b", r"C:\c"]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_lookup_needs_an_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let gh = dir.path().join("gh");
        std::fs::write(&gh, b"#!/bin/sh\n").unwrap();
        let path = dir.path().to_string_lossy().to_string();
        assert_eq!(resolve_program("gh", &env(&path), false), None);
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(resolve_program("gh", &env(&path), false), Some(gh));
    }

    #[test]
    fn fallbacks_per_platform() {
        assert_eq!(GhPlatform::Windows.fallbacks(), ["C:\\Program Files\\GitHub CLI\\gh.exe"]);
        assert_eq!(GhPlatform::Mac.fallbacks(), ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);
        assert_eq!(GhPlatform::Linux.fallbacks().len(), 3);
    }

    /// A program that is not there is NotFound; one that exits non-zero is Failed; stdout comes back.
    #[cfg(windows)]
    #[tokio::test]
    async fn runs_without_a_shell() {
        let env: Env = std::env::vars().collect();
        let exec = SystemGhExec;
        assert_eq!(exec.run("gh-not-installed-anywhere", &[], Duration::from_secs(5), &env).await, Err(ExecFailure::NotFound));
        let host = exec.run("hostname", &[], Duration::from_secs(10), &env).await.unwrap();
        assert!(!host.trim().is_empty());
        assert_eq!(exec.run("hostname", &["-s", "x"], Duration::from_secs(10), &env).await, Err(ExecFailure::Failed));
    }
}
