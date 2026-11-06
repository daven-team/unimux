//! Which shell a terminal starts (port of `resolveShell` in src/ptyhost/manager.ts) and the environment it gets (the
//! `{ ...env, TERM, COLORTERM, TERM_PROGRAM }` of PtyManager.spawn plus MC_CELL_ID).
//!
//! Environments are ordered `(key, value)` lists with JavaScript object semantics: keys compare case-sensitively, setting an
//! existing key keeps its position, a new key goes to the end (node-pty builds the environment block in that order).

use std::path::{Path, PathBuf};

/// `ShellKind` of src/shared/types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShellKind {
    Pwsh,
    Powershell,
    Cmd,
    Zsh,
    Bash,
}

impl ShellKind {
    /// The wire name ('pwsh', 'powershell', 'cmd', 'zsh', 'bash').
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "pwsh" => Self::Pwsh,
            "powershell" => Self::Powershell,
            "cmd" => Self::Cmd,
            "zsh" => Self::Zsh,
            "bash" => Self::Bash,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pwsh => "pwsh",
            Self::Powershell => "powershell",
            Self::Cmd => "cmd",
            Self::Zsh => "zsh",
            Self::Bash => "bash",
        }
    }
}

/// `process.platform` for the shell choice ('win32', 'darwin', anything else).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}

/// The program a terminal runs and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub file: String,
    pub args: Vec<String>,
}

impl Launch {
    pub fn new(file: impl Into<String>, args: &[&str]) -> Self {
        Self { file: file.into(), args: args.iter().map(|a| a.to_string()).collect() }
    }
}

/// The value of `key` (exact case, like a JavaScript object).
pub fn env_get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// Sets `key` like `obj[key] = value`: in place when present (exact case), else appended.
pub fn env_set(env: &mut Vec<(String, String)>, key: &str, value: &str) {
    match env.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value.to_string(),
        None => env.push((key.to_string(), value.to_string())),
    }
}

/// `path.join(dir, file)` for the PATH lookup.
fn join(dir: &str, file: &str) -> PathBuf {
    Path::new(dir).join(file)
}

/// Full path of `exe` in the PATH of `env` (the cell's PATH, which may be newer than this process's own); None when absent.
/// `env.PATH ?? env.Path`, split on ';' (the lookup only runs for Windows).
fn find_on_path(exe: &str, env: &[(String, String)]) -> Option<String> {
    let path = env_get(env, "PATH").or_else(|| env_get(env, "Path")).unwrap_or("");
    path.split(';')
        .filter(|dir| !dir.is_empty())
        .map(|dir| join(dir, exe))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

/// The shell for `kind` on `platform`: Windows pwsh by its absolute path on the cell PATH, else Windows PowerShell (on the
/// PATH, else its System32 path, else the bare name), cmd as `cmd.exe`; macOS zsh unless bash was asked; Linux bash unless
/// zsh was asked; Unix shells as login shells (`-il`, they load the PATH of Homebrew and user-installed agent CLIs).
pub fn resolve_shell(kind: ShellKind, env: &[(String, String)], platform: Platform) -> Launch {
    if platform != Platform::Windows {
        let bash = kind == ShellKind::Bash || (platform != Platform::MacOs && kind != ShellKind::Zsh);
        let shell = if bash { "bash" } else { "zsh" };
        return Launch::new(format!("/bin/{shell}"), &["-il"]);
    }
    if kind == ShellKind::Cmd {
        return Launch::new("cmd.exe", &[]);
    }
    if kind == ShellKind::Pwsh
        && let Some(pwsh) = find_on_path("pwsh.exe", env)
    {
        return Launch::new(pwsh, &["-NoLogo"]);
    }
    let windows_power_shell = find_on_path("powershell.exe", env).or_else(|| {
        let root = env_get(env, "SystemRoot").or_else(|| env_get(env, "SYSTEMROOT")).unwrap_or("C:\\Windows");
        let file = join(root, "System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        file.exists().then(|| file.to_string_lossy().into_owned())
    });
    Launch::new(windows_power_shell.unwrap_or_else(|| "powershell.exe".into()), &["-NoLogo"])
}

/// What node-pty calls the terminal type (TERM).
pub const TERM_NAME: &str = "xterm-256color";

/// The terminal's environment: the cell environment, MC_CELL_ID when the terminal belongs to a cell, then TERM, COLORTERM and
/// TERM_PROGRAM (PtyManager.spawn's `{ ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'unimux' }`).
pub fn terminal_env(env: &[(String, String)], cell_id: Option<&str>) -> Vec<(String, String)> {
    let mut out = env.to_vec();
    if let Some(cell) = cell_id {
        env_set(&mut out, "MC_CELL_ID", cell);
    }
    env_set(&mut out, "TERM", TERM_NAME);
    env_set(&mut out, "COLORTERM", "truecolor");
    env_set(&mut out, "TERM_PROGRAM", "unimux");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn temp(prefix: &str) -> tempfile::TempDir {
        tempfile::Builder::new().prefix(prefix).tempdir().unwrap()
    }

    fn s(p: PathBuf) -> String {
        p.to_string_lossy().into_owned()
    }

    // test/pty-shell-path.test.ts
    #[test]
    fn pwsh_found_on_the_cell_path_by_its_absolute_path() {
        let dir = temp("mc-pwsh-");
        std::fs::write(dir.path().join("pwsh.exe"), "").unwrap();
        let path = s(dir.path().to_path_buf());
        assert_eq!(
            resolve_shell(ShellKind::Pwsh, &env(&[("PATH", &path)]), Platform::Windows),
            Launch::new(s(dir.path().join("pwsh.exe")), &["-NoLogo"])
        );
    }

    // test/pty-shell-path.test.ts
    #[test]
    fn windows_powershell_when_pwsh_is_missing_and_the_lookup_only_for_pwsh() {
        let dir = temp("mc-nopwsh-");
        let path = s(dir.path().to_path_buf());
        let system = Path::new("C:\\Windows").join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let expected = if system.exists() { s(system) } else { "powershell.exe".into() };
        assert_eq!(
            resolve_shell(ShellKind::Pwsh, &env(&[("PATH", &path)]), Platform::Windows),
            Launch::new(expected.clone(), &["-NoLogo"])
        );
        assert_eq!(
            resolve_shell(ShellKind::Powershell, &env(&[("PATH", &path)]), Platform::Windows),
            Launch::new(expected, &["-NoLogo"])
        );
        let ps = temp("mc-ps-");
        std::fs::write(ps.path().join("powershell.exe"), "").unwrap();
        let ps_path = s(ps.path().to_path_buf());
        assert_eq!(
            resolve_shell(ShellKind::Pwsh, &env(&[("PATH", &ps_path)]), Platform::Windows),
            Launch::new(s(ps.path().join("powershell.exe")), &["-NoLogo"])
        );
    }

    #[test]
    fn path_key_order_and_system_root() {
        let a = temp("mc-a-");
        let b = temp("mc-b-");
        std::fs::write(a.path().join("pwsh.exe"), "").unwrap();
        std::fs::write(b.path().join("pwsh.exe"), "").unwrap();
        let (pa, pb) = (s(a.path().to_path_buf()), s(b.path().to_path_buf()));
        // `env.PATH ?? env.Path`: PATH wins; empty entries are skipped; the first hit wins.
        let e = env(&[("Path", &pb), ("PATH", &format!(";{pa};{pb}"))]);
        assert_eq!(resolve_shell(ShellKind::Pwsh, &e, Platform::Windows).file, s(a.path().join("pwsh.exe")));
        assert_eq!(resolve_shell(ShellKind::Pwsh, &env(&[("Path", &pb)]), Platform::Windows).file, s(b.path().join("pwsh.exe")));
        // Keys are case-sensitive like a JavaScript object: "path" is not looked at.
        let empty = temp("mc-empty-");
        let e = env(&[("path", &pa), ("PATH", &s(empty.path().to_path_buf())), ("SystemRoot", &s(empty.path().to_path_buf()))]);
        assert_eq!(resolve_shell(ShellKind::Pwsh, &e, Platform::Windows), Launch::new("powershell.exe", &["-NoLogo"]));
        // SystemRoot's System32 copy when it exists.
        let root = temp("mc-root-");
        let ps = root.path().join("System32").join("WindowsPowerShell").join("v1.0");
        std::fs::create_dir_all(&ps).unwrap();
        std::fs::write(ps.join("powershell.exe"), "").unwrap();
        let e = env(&[("PATH", &s(empty.path().to_path_buf())), ("SYSTEMROOT", &s(root.path().to_path_buf()))]);
        assert_eq!(resolve_shell(ShellKind::Powershell, &e, Platform::Windows).file, s(ps.join("powershell.exe")));
    }

    #[test]
    fn cmd_and_unix_shells() {
        let none = env(&[]);
        assert_eq!(resolve_shell(ShellKind::Cmd, &none, Platform::Windows), Launch::new("cmd.exe", &[]));
        let cases = [
            (ShellKind::Bash, Platform::MacOs, "/bin/bash"),
            (ShellKind::Zsh, Platform::MacOs, "/bin/zsh"),
            (ShellKind::Pwsh, Platform::MacOs, "/bin/zsh"),
            (ShellKind::Cmd, Platform::MacOs, "/bin/zsh"),
            (ShellKind::Powershell, Platform::MacOs, "/bin/zsh"),
            (ShellKind::Bash, Platform::Linux, "/bin/bash"),
            (ShellKind::Zsh, Platform::Linux, "/bin/zsh"),
            (ShellKind::Pwsh, Platform::Linux, "/bin/bash"),
            (ShellKind::Cmd, Platform::Linux, "/bin/bash"),
        ];
        for (kind, platform, file) in cases {
            assert_eq!(resolve_shell(kind, &none, platform), Launch::new(file, &["-il"]), "{kind:?} on {platform:?}");
        }
    }

    #[test]
    fn kinds_round_trip() {
        for k in [ShellKind::Pwsh, ShellKind::Powershell, ShellKind::Cmd, ShellKind::Zsh, ShellKind::Bash] {
            assert_eq!(ShellKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(ShellKind::parse("fish"), None);
    }

    #[test]
    fn terminal_env_overrides_in_place_and_appends() {
        let e = env(&[("A", "1"), ("TERM", "dumb"), ("Term", "x"), ("MC_CELL_ID", "old"), ("B", "2")]);
        let out = terminal_env(&e, Some("cell-7"));
        assert_eq!(
            out,
            env(&[
                ("A", "1"),
                ("TERM", "xterm-256color"),
                ("Term", "x"),
                ("MC_CELL_ID", "cell-7"),
                ("B", "2"),
                ("COLORTERM", "truecolor"),
                ("TERM_PROGRAM", "unimux"),
            ])
        );
        // No cell: a MC_CELL_ID of the given environment stays as it is.
        let out = terminal_env(&env(&[("MC_CELL_ID", "kept")]), None);
        assert_eq!(env_get(&out, "MC_CELL_ID"), Some("kept"));
        assert_eq!(out.len(), 4);
    }
}
