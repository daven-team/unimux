//! Port of src/shared/cliStatus.ts (the parts the host uses): types, official install data, PATH arithmetic, known install
//! folders, the probe scripts and their parsers, and the "may this cell start?" decision. No I/O; every function is
//! unit-tested against the cases of test/cli-status-shared.test.ts.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The operating system the rules are evaluated for (`process.platform`: win32, darwin, anything else = linux).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
    pub fn is_windows(self) -> bool {
        self == Os::Windows
    }
    fn delimiter(self) -> char {
        if self.is_windows() { ';' } else { ':' }
    }
    pub fn sep(self) -> char {
        if self.is_windows() { '\\' } else { '/' }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliId {
    Claude,
    Codex,
}

impl CliId {
    /// `CLI_IDS`, in this order.
    pub const ALL: [CliId; 2] = [CliId::Claude, CliId::Codex];

    pub fn as_str(self) -> &'static str {
        match self {
            CliId::Claude => "claude",
            CliId::Codex => "codex",
        }
    }

    /// `isCliId`: only the exact strings.
    pub fn parse(value: &str) -> Option<CliId> {
        match value {
            "claude" => Some(CliId::Claude),
            "codex" => Some(CliId::Codex),
            _ => None,
        }
    }

    /// `isCliId` over an IPC argument (anything that is not exactly one of the two strings is refused).
    pub fn from_value(value: &Value) -> Option<CliId> {
        value.as_str().and_then(CliId::parse)
    }

    /// Display name (`CLI_NAMES`, never translated).
    pub fn name(self) -> &'static str {
        match self {
            CliId::Claude => "Claude Code",
            CliId::Codex => "Codex",
        }
    }

    fn upper(self) -> &'static str {
        match self {
            CliId::Claude => "CLAUDE",
            CliId::Codex => "CODEX",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliState {
    Found,
    Missing,
    /// Detection failed or timed out; it never blocks a spawn.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliReason {
    NotOnPath,
    VersionFailed,
    Timeout,
    ProbeFailed,
    RegistryFailed,
    ShellAlias,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliSource {
    Known,
    Path,
    Shell,
}

/// `CliStatus` (same JSON: camelCase keys, absent optional keys left out, `checkedAt` in epoch milliseconds).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub cli: CliId,
    pub state: CliState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<CliSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<CliReason>,
    pub checked_at: i64,
}

impl CliStatus {
    pub fn new(cli: CliId, state: CliState, reason: Option<CliReason>, checked_at: i64) -> Self {
        Self { cli, state, path: None, version: None, source: None, reason, checked_at }
    }
}

/// `CliStatusMap` (`Partial<Record<CliId, CliStatus>>`); serializes as `{"claude": ..., "codex": ...}` in CLI_IDS order.
pub type CliStatusMap = BTreeMap<CliId, CliStatus>;

/// `sameStatus`: what makes a change worth announcing.
pub fn same_status(a: Option<&CliStatus>, b: Option<&CliStatus>) -> bool {
    a.map(|s| s.state) == b.map(|s| s.state)
        && a.and_then(|s| s.path.as_deref()) == b.and_then(|s| s.path.as_deref())
        && a.and_then(|s| s.version.as_deref()) == b.and_then(|s| s.version.as_deref())
}

// ── official documentation and install commands ─────────────────────────────

/// `CLI_DOCS`: the only addresses `cli:openDocs` ever opens.
pub fn docs_url(cli: CliId) -> &'static str {
    match cli {
        CliId::Claude => "https://code.claude.com/docs/en/setup",
        CliId::Codex => "https://github.com/openai/codex",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMethod {
    Native,
    Npm,
    Brew,
    Winget,
}

impl InstallMethod {
    pub const ALL: [InstallMethod; 4] = [InstallMethod::Native, InstallMethod::Npm, InstallMethod::Brew, InstallMethod::Winget];
}

/// Exact official commands (`installCommand`); None = not offered on that platform.
pub fn install_command(cli: CliId, os: Os, method: InstallMethod) -> Option<&'static str> {
    let win = os.is_windows();
    match (cli, method) {
        (CliId::Claude, InstallMethod::Native) => {
            Some(if win { "irm https://claude.ai/install.ps1 | iex" } else { "curl -fsSL https://claude.ai/install.sh | bash" })
        }
        (CliId::Claude, InstallMethod::Npm) => Some("npm install -g @anthropic-ai/claude-code"),
        (CliId::Claude, InstallMethod::Brew) => (!win).then_some("brew install --cask claude-code"),
        (CliId::Claude, InstallMethod::Winget) => win.then_some("winget install Anthropic.ClaudeCode"),
        (CliId::Codex, InstallMethod::Native) => Some(if win {
            "powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\""
        } else {
            "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
        }),
        (CliId::Codex, InstallMethod::Npm) => Some("npm install -g @openai/codex"),
        (CliId::Codex, InstallMethod::Brew) => (!win).then_some("brew install --cask codex"),
        (CliId::Codex, InstallMethod::Winget) => None,
    }
}

/// `installMethods`: the methods documented for a platform, the recommended one first.
pub fn install_methods(cli: CliId, os: Os) -> Vec<InstallMethod> {
    InstallMethod::ALL.into_iter().filter(|m| install_command(cli, os, *m).is_some()).collect()
}

// ── profiles ─────────────────────────────────────────────────────────────────

/// `cliForProfile`: the profile's `cli` field names the binary; shell profiles need none.
pub fn cli_for_profile(profile_cli: &str) -> Option<CliId> {
    CliId::parse(profile_cli)
}

/// `missingCli`: the CLI a profile needs when it is known to be missing (unknown / not yet checked counts as available).
pub fn missing_cli(profile_cli: &str, map: Option<&CliStatusMap>) -> Option<CliId> {
    let cli = cli_for_profile(profile_cli)?;
    (map.and_then(|m| m.get(&cli)).map(|s| s.state) == Some(CliState::Missing)).then_some(cli)
}

/// `missingCardCli`: only a held cell (its start was skipped) shows the install card.
pub fn missing_card_cli(profile_cli: &str, map: Option<&CliStatusMap>, held: bool) -> Option<CliId> {
    if held { missing_cli(profile_cli, map) } else { None }
}

pub fn profile_available(profile_cli: &str, map: Option<&CliStatusMap>) -> bool {
    missing_cli(profile_cli, map).is_none()
}

/// `spawnDecision`: fail open, only a definite "missing" blocks a spawn. `Err(cli)` = do not spawn.
pub fn spawn_decision(profile_cli: &str, status: Option<&CliStatus>) -> Result<(), CliId> {
    match cli_for_profile(profile_cli) {
        Some(cli) if status.map(|s| s.state) == Some(CliState::Missing) => Err(cli),
        _ => Ok(()),
    }
}

/// `missingClis`: distinct missing CLIs among the profiles (the new-grid warning).
pub fn missing_clis<'a>(profiles: impl IntoIterator<Item = &'a str>, map: Option<&CliStatusMap>) -> Vec<CliId> {
    let mut out = Vec::new();
    for p in profiles {
        if let Some(cli) = missing_cli(p, map)
            && !out.contains(&cli)
        {
            out.push(cli);
        }
    }
    out
}

// ── version ──────────────────────────────────────────────────────────────────

fn is_word(b: Option<&u8>) -> bool {
    matches!(b, Some(c) if c.is_ascii_alphanumeric() || *c == b'_')
}

/// `parseVersion`: the first `x.y.z(-pre)` of the output, with the word boundaries of the JS regex
/// `/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/`. Never returns anything else of the text.
pub fn parse_version(text: &str) -> Option<String> {
    let s = text.as_bytes();
    let boundary = |p: usize| is_word(p.checked_sub(1).and_then(|i| s.get(i))) != is_word(s.get(p));
    let digits = |mut p: usize| {
        let start = p;
        while p < s.len() && s[p].is_ascii_digit() {
            p += 1;
        }
        (p > start).then_some(p)
    };
    for i in 0..s.len() {
        if !s[i].is_ascii_digit() || !boundary(i) {
            continue;
        }
        let Some(a) = digits(i) else { continue };
        if s.get(a) != Some(&b'.') {
            continue;
        }
        let Some(b) = digits(a + 1) else { continue };
        if s.get(b) != Some(&b'.') {
            continue;
        }
        let Some(c) = digits(b + 1) else { continue };
        // Optional `-[0-9A-Za-z.]+`, greedy, then backtracking until a word boundary follows.
        if s.get(c) == Some(&b'-') {
            let mut end = c + 1;
            while end < s.len() && (s[end].is_ascii_alphanumeric() || s[end] == b'.') {
                end += 1;
            }
            while end > c + 1 {
                if boundary(end) {
                    return Some(text[i..end].to_string());
                }
                end -= 1;
            }
        }
        if boundary(c) {
            return Some(text[i..c].to_string());
        }
    }
    None
}

// ── environment (an ordered list of variables, like a JS Record) ─────────────

/// An environment as an ordered list (Windows keeps the case of a key such as `Path`).
pub type Env = Vec<(String, String)>;

/// `findEnvKey`: the index of the variable (case-insensitive on Windows).
pub fn find_env_key(env: &[(String, String)], name: &str, os: Os) -> Option<usize> {
    if os.is_windows() {
        let lower = name.to_lowercase();
        env.iter().position(|(k, _)| k.to_lowercase() == lower)
    } else {
        env.iter().position(|(k, _)| k == name)
    }
}

pub fn get_env<'a>(env: &'a [(String, String)], name: &str, os: Os) -> Option<&'a str> {
    find_env_key(env, name, os).map(|i| env[i].1.as_str())
}

/// `withPath`: sets PATH under the key the environment already uses (a second `PATH` next to `Path` confuses Windows).
pub fn with_path(env: &[(String, String)], value: &str, os: Os) -> Env {
    let mut out = env.to_vec();
    match find_env_key(env, "PATH", os) {
        Some(i) => out[i].1 = value.to_string(),
        None => out.push(("PATH".to_string(), value.to_string())),
    }
    out
}

/// `cleanEnv` of src/shared/env.ts over an ordered environment.
pub fn clean_env(env: &[(String, String)]) -> Env {
    env.iter().filter(|(k, _)| !unimux_exec::is_session_var(k)).cloned().collect()
}

// ── PATH arithmetic ──────────────────────────────────────────────────────────

fn norm_entry(os: Os, value: &str) -> String {
    let cut = value.trim_end_matches(['\\', '/']);
    if os.is_windows() { cut.replace('/', "\\").to_lowercase() } else { cut.to_string() }
}

fn same_path_entry(os: Os, a: &str, b: &str) -> bool {
    norm_entry(os, a) == norm_entry(os, b)
}

/// `splitPath`: per-platform delimiter, entries trimmed, surrounding quotes removed, empty ones dropped.
pub fn split_path(value: Option<&str>, os: Os) -> Vec<String> {
    let Some(value) = value else { return vec![] };
    value
        .split(os.delimiter())
        .map(|part| {
            let t = part.trim();
            if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') { t[1..t.len() - 1].to_string() } else { t.to_string() }
        })
        .filter(|p| !p.is_empty())
        .collect()
}

pub fn join_path(entries: &[String], os: Os) -> String {
    entries.join(&os.delimiter().to_string())
}

pub fn path_has(entries: &[String], dir: &str, os: Os) -> bool {
    entries.iter().any(|e| same_path_entry(os, e, dir))
}

/// `mergePaths`: keeps `base` order and appends the extras it does not contain yet.
pub fn merge_paths(base: &[String], extras: &[String], os: Os) -> Vec<String> {
    let mut out = base.to_vec();
    for extra in extras {
        if !path_has(&out, extra, os) {
            out.push(extra.clone());
        }
    }
    out
}

/// `prependDir`: puts `dir` first unless the PATH already has it.
pub fn prepend_dir(entries: &[String], dir: &str, os: Os) -> Vec<String> {
    if path_has(entries, dir, os) {
        entries.to_vec()
    } else {
        let mut out = vec![dir.to_string()];
        out.extend_from_slice(entries);
        out
    }
}

/// `expandWindowsVars`: `%NAME%` from the environment (case-insensitive); unknown variables stay untouched.
pub fn expand_windows_vars(value: &str, env: &[(String, String)]) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(0) => {
                // `%%`: no name; the second `%` may open the next token.
                out.push('%');
                rest = after;
            }
            Some(j) => {
                let name = &after[..j];
                match get_env(env, name, Os::Windows) {
                    Some(v) => out.push_str(v),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn has_unresolved_var(entry: &str) -> bool {
    let mut rest = entry;
    while let Some(i) = rest.find('%') {
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) if j > 0 => return true,
            Some(_) => rest = after,
            None => return false,
        }
    }
    false
}

/// Raw Machine and User PATH of the Windows registry (REG_EXPAND_SZ unexpanded); None = value absent or unreadable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegistryPath {
    pub machine: Option<String>,
    pub user: Option<String>,
}

/// `registryPathEntries`: Machine entries first, then User ones (how Windows builds a process PATH), expanded, unresolved
/// variables dropped, duplicates removed.
pub fn registry_path_entries(raw: &RegistryPath, env: &[(String, String)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in [&raw.machine, &raw.user] {
        let expanded = part.as_deref().map(|p| expand_windows_vars(p, env)).unwrap_or_default();
        for entry in split_path(Some(&expanded), Os::Windows) {
            if has_unresolved_var(&entry) {
                continue;
            }
            if !path_has(&out, &entry, Os::Windows) {
                out.push(entry);
            }
        }
    }
    out
}

/// `parseRegQueryPath`: the value of `reg query <key> /v Path` output (`    Path    REG_EXPAND_SZ    C:\a;C:\b`).
pub fn parse_reg_query_path(output: &str) -> Option<String> {
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let l = line.trim_start();
        if l.len() < 4 || !l[..4].eq_ignore_ascii_case("path") {
            continue;
        }
        let after = &l[4..];
        let typed = after.trim_start();
        if typed.len() == after.len() {
            continue;
        }
        let ty =
            ["REG_EXPAND_SZ", "REG_SZ"].into_iter().find(|t| typed.len() >= t.len() && typed[..t.len()].eq_ignore_ascii_case(t));
        let Some(ty) = ty else { continue };
        let value_part = &typed[ty.len()..];
        let value = value_part.trim_start();
        if value.len() == value_part.len() {
            continue;
        }
        return Some(value.trim_end().to_string());
    }
    None
}

// ── paths (Node's path.win32 / path.posix join and dirname for the cases the detector meets) ──

/// `path.join(dir, ...parts)` with Node's normalization (separators, `.` and `..`, a trailing separator of `dir`).
pub fn join(os: Os, parts: &[&str]) -> String {
    let joined =
        parts.iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join(if os.is_windows() { "\\" } else { "/" });
    normalize(os, &joined)
}

/// `path.normalize`.
pub fn normalize(os: Os, path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let sep = os.sep();
    let s = if os.is_windows() { path.replace('/', "\\") } else { path.to_string() };
    let (root, rest, absolute): (String, &str, bool) = if os.is_windows() {
        let b = s.as_bytes();
        if let Some(unc) = s.strip_prefix("\\\\") {
            // UNC: \\server\share\ is the root
            let parts: Vec<&str> = unc.splitn(3, '\\').collect();
            if parts.len() >= 2 && !parts[0].is_empty() && !parts[1].is_empty() {
                let root = format!("\\\\{}\\{}\\", parts[0], parts[1]);
                let rest_start = (2 + parts[0].len() + 1 + parts[1].len() + 1).min(s.len());
                (root, &s[rest_start..], true)
            } else {
                ("\\".to_string(), s.trim_start_matches('\\'), true)
            }
        } else if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            if b.get(2) == Some(&b'\\') { (s[..3].to_string(), &s[3..], true) } else { (s[..2].to_string(), &s[2..], false) }
        } else if let Some(r) = s.strip_prefix('\\') {
            ("\\".to_string(), r, true)
        } else {
            (String::new(), s.as_str(), false)
        }
    } else if let Some(r) = s.strip_prefix('/') {
        ("/".to_string(), r, true)
    } else {
        (String::new(), s.as_str(), false)
    };
    let trailing = rest.ends_with(sep) && !rest.is_empty();
    let mut segs: Vec<&str> = Vec::new();
    for seg in rest.split(sep) {
        match seg {
            "" | "." => {}
            ".." => {
                if segs.last().is_some_and(|l| *l != "..") {
                    segs.pop();
                } else if !absolute {
                    segs.push("..");
                }
            }
            other => segs.push(other),
        }
    }
    let mut out = root;
    out.push_str(&segs.join(&sep.to_string()));
    if out.is_empty() {
        return ".".to_string();
    }
    if trailing && !segs.is_empty() {
        out.push(sep);
    }
    out
}

/// `path.dirname` of an absolute file path.
pub fn dirname(os: Os, path: &str) -> String {
    let is_sep = |c: char| c == '/' || (os.is_windows() && c == '\\');
    let trimmed = path.trim_end_matches(is_sep);
    let trimmed = if trimmed.is_empty() { &path[..path.len().min(1)] } else { trimmed };
    match trimmed.rfind(is_sep) {
        None => {
            if os.is_windows() && trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
                trimmed[..2].to_string()
            } else {
                ".".to_string()
            }
        }
        Some(0) => trimmed[..1].to_string(),
        Some(i) => {
            if os.is_windows() && i == 2 && trimmed.as_bytes()[1] == b':' {
                trimmed[..3].to_string()
            } else {
                let head = trimmed[..i].trim_end_matches(is_sep);
                if head.is_empty() { trimmed[..1].to_string() } else { head.to_string() }
            }
        }
    }
}

// ── known install locations ──────────────────────────────────────────────────

/// `joinFor`: plain joining (no normalization) of the first part without trailing and the others without any separators.
fn join_for(os: Os, parts: &[&str]) -> String {
    let seps: &[char] = &['\\', '/'];
    parts
        .iter()
        .enumerate()
        .map(|(i, p)| if i == 0 { p.trim_end_matches(seps) } else { p.trim_matches(seps) })
        .collect::<Vec<_>>()
        .join(&os.sep().to_string())
}

/// `knownCliDirs`: where the documented installers and the common version managers put `claude` / `codex`.
pub fn known_cli_dirs(os: Os, env: &[(String, String)], home: &str) -> Vec<String> {
    let j = |parts: &[&str]| join_for(os, parts);
    if os.is_windows() {
        let non_empty = |name: &str| get_env(env, name, Os::Windows).filter(|v| !v.is_empty()).map(str::to_string);
        let app_data = non_empty("APPDATA").unwrap_or_else(|| j(&[home, "AppData", "Roaming"]));
        let local = non_empty("LOCALAPPDATA").unwrap_or_else(|| j(&[home, "AppData", "Local"]));
        let program_files = non_empty("ProgramFiles");
        let program_data = non_empty("ProgramData");
        let mut dirs = vec![
            j(&[home, ".local", "bin"]),
            j(&[home, ".claude", "local"]),
            j(&[&app_data, "npm"]),
            j(&[&local, "Microsoft", "WinGet", "Links"]),
            j(&[home, "scoop", "shims"]),
        ];
        if let Some(pf) = &program_files {
            dirs.push(j(&[pf, "nodejs"]));
        }
        dirs.push(j(&[&local, "Volta", "bin"]));
        dirs.push(j(&[home, ".bun", "bin"]));
        dirs.push(j(&[&local, "pnpm"]));
        if let Some(pd) = &program_data {
            dirs.push(j(&[pd, "chocolatey", "bin"]));
        }
        return dirs;
    }
    vec![
        j(&[home, ".local", "bin"]),
        j(&[home, ".claude", "local"]),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        j(&[home, ".npm-global", "bin"]),
        j(&[home, ".bun", "bin"]),
        j(&[home, ".volta", "bin"]),
        j(&[home, ".asdf", "shims"]),
        j(&[home, ".local", "share", "mise", "shims"]),
        j(&[home, ".local", "share", "pnpm"]),
        j(&[home, "Library", "pnpm"]),
        "/home/linuxbrew/.linuxbrew/bin".to_string(),
    ]
}

/// `versionedCliDirs`: version-manager layouts `<root>/<version>/<suffix>`.
pub fn versioned_cli_dirs(os: Os, home: &str) -> Vec<(String, &'static str)> {
    let j = |parts: &[&str]| join_for(os, parts);
    if os.is_windows() {
        return vec![
            (j(&[home, "AppData", "Roaming", "nvm"]), ""),
            (j(&[home, "AppData", "Local", "fnm", "node-versions"]), "installation"),
        ];
    }
    vec![
        (j(&[home, ".nvm", "versions", "node"]), "bin"),
        (j(&[home, ".local", "share", "fnm", "node-versions"]), "installation/bin"),
        (j(&[home, "Library", "Application Support", "fnm", "node-versions"]), "installation/bin"),
    ]
}

fn version_key(name: &str) -> Option<[f64; 3]> {
    let s = name.strip_prefix('v').unwrap_or(name);
    let mut out = [0.0; 3];
    let mut rest = s;
    for (i, slot) in out.iter_mut().enumerate() {
        let n = rest.bytes().take_while(u8::is_ascii_digit).count();
        if n == 0 {
            return None;
        }
        *slot = rest[..n].parse::<f64>().ok()?;
        rest = &rest[n..];
        if i < 2 {
            rest = rest.strip_prefix('.')?;
        }
    }
    Some(out)
}

/// `localeCompare` for folder names (case-insensitive first, lower case before upper case on a tie).
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// `sortVersionsDesc`: newest semver first; names that are not versions last.
pub fn sort_versions_desc(names: &[String]) -> Vec<String> {
    let mut out = names.to_vec();
    out.sort_by(|a, b| match (version_key(a), version_key(b)) {
        (Some(ka), Some(kb)) => {
            for i in 0..3 {
                if ka[i] != kb[i] {
                    return kb[i].partial_cmp(&ka[i]).unwrap_or(std::cmp::Ordering::Equal);
                }
            }
            std::cmp::Ordering::Equal
        }
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => locale_compare(a, b),
    });
    out
}

fn replace_home_vars(value: &str, home: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(i) = rest.find('$') {
        out.push_str(&rest[..i]);
        let after = &rest[i..];
        if let Some(r) = after.strip_prefix("${HOME}") {
            out.push_str(home);
            rest = r;
        } else if let Some(r) = after.strip_prefix("$HOME") {
            out.push_str(home);
            rest = r;
        } else {
            out.push('$');
            rest = &after[1..];
        }
    }
    out.push_str(rest);
    out
}

/// `npmPrefixBinDir`: `prefix=...` of ~/.npmrc resolved to its executables folder.
pub fn npm_prefix_bin_dir(npmrc: &str, os: Os, home: &str) -> Option<String> {
    for raw in npmrc.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        // /^\s*prefix\s*=\s*(.+?)\s*$/
        let Some(after) = line.trim_start().strip_prefix("prefix") else { continue };
        let Some(value) = after.trim_start().strip_prefix('=') else { continue };
        if value.is_empty() {
            continue;
        }
        let trimmed = value.trim();
        let captured = if trimmed.is_empty() {
            // All whitespace: the lazy group still takes the last character.
            value.chars().last().map(|c| c.to_string()).unwrap_or_default()
        } else {
            trimmed.to_string()
        };
        let mut prefix = captured.as_str();
        if prefix.starts_with(['"', '\'']) {
            prefix = &prefix[1..];
        }
        if prefix.ends_with(['"', '\'']) {
            prefix = &prefix[..prefix.len() - 1];
        }
        let tilde = if prefix == "~" || prefix.starts_with("~/") || prefix.starts_with("~\\") {
            format!("{home}{}", &prefix[1..])
        } else {
            prefix.to_string()
        };
        let resolved = replace_home_vars(&tilde, home);
        if resolved.is_empty() || resolved.contains("${") {
            return None;
        }
        return Some(if os.is_windows() { resolved } else { format!("{}/bin", resolved.trim_end_matches('/')) });
    }
    None
}

/// `executableNames`: Windows follows PATHEXT (`.exe` first, never .ps1/.vbs/.js), POSIX is the bare name.
pub fn executable_names(cli: CliId, os: Os, path_ext: Option<&str>) -> Vec<String> {
    if !os.is_windows() {
        return vec![cli.as_str().to_string()];
    }
    let exts: Vec<String> = path_ext
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .map(|e| e.trim().to_lowercase())
        .filter(|e| {
            let b = e.as_bytes();
            b.len() >= 2 && b.len() <= 6 && b[0] == b'.' && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
        .collect();
    let mut wanted: Vec<String> = Vec::new();
    for e in std::iter::once(".exe".to_string()).chain(exts).chain(std::iter::once(".cmd".to_string())) {
        if !wanted.contains(&e) {
            wanted.push(e);
        }
    }
    wanted.into_iter().filter(|e| e != ".ps1" && e != ".vbs" && e != ".js").map(|e| format!("{}{e}", cli.as_str())).collect()
}

// ── probes ───────────────────────────────────────────────────────────────────

/// Removes the escape sequences of `/\x1b\[[0-9;?]*[ -/]*[@-~]/g`.
pub fn strip_ansi(line: &str) -> String {
    let b = line.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == 0x1b && b.get(i + 1) == Some(&b'[') {
            let mut j = i + 2;
            while j < b.len() && (b[j].is_ascii_digit() || b[j] == b';' || b[j] == b'?') {
                j += 1;
            }
            while j < b.len() && (0x20..=0x2f).contains(&b[j]) {
                j += 1;
            }
            if j < b.len() && (0x40..=0x7e).contains(&b[j]) {
                i = j + 1;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// What a probe learned: the PATH of the login shell, absolute files per CLI, and the names it resolves to something that is
/// not a file (alias, function).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShellProbe {
    pub path: Vec<String>,
    pub found: BTreeMap<CliId, String>,
    pub aliased: BTreeSet<CliId>,
}

/// `parseShellProbe`: only the marker lines count; rc-file noise around them is ignored.
pub fn parse_shell_probe(output: &str) -> ShellProbe {
    let mut probe = ShellProbe::default();
    for raw in output.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let clean = strip_ansi(raw);
        let line = clean.trim();
        if let Some(value) = line.strip_prefix("__AJZ_PATH__=") {
            probe.path = split_path(Some(value), Os::Linux).into_iter().filter(|d| d.starts_with('/')).collect();
        }
        for cli in CliId::ALL {
            let prefix = format!("__AJZ_{}__=", cli.upper());
            let Some(value) = line.strip_prefix(prefix.as_str()) else { continue };
            let value = value.trim();
            // `command -v` also prints aliases and function names; only absolute file paths count.
            if value.starts_with('/') {
                probe.found.insert(cli, value.to_string());
            } else if !value.is_empty() {
                probe.aliased.insert(cli);
            }
        }
    }
    probe
}

/// `posixShellFile`: the shell file cells run for a configured kind (mirrors the pty host's resolveShell).
pub fn posix_shell_file(kind: Option<&str>, os: Os) -> &'static str {
    if kind == Some("bash") || (os != Os::Mac && kind != Some("zsh")) { "/bin/bash" } else { "/bin/zsh" }
}

/// `windowsCommandProbeScript`: prints `__AJZ_CMD_<CLI>__=<CommandType>|<Source>` per CLI.
pub fn windows_command_probe_script() -> String {
    CliId::ALL
        .iter()
        .map(|cli| {
            let marker = format!("__AJZ_CMD_{}__=", cli.upper());
            format!(
                "$c = Get-Command {name} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) {{ Write-Output ('{marker}' + $c.CommandType + '|' + $c.Source) }} else {{ Write-Output '{marker}' }}",
                name = cli.as_str()
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Result of the Windows profile probe.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowsCommandProbe {
    /// At least one marker line was printed (the shell and its profile ran).
    pub ran: bool,
    pub found: BTreeMap<CliId, String>,
    pub aliased: BTreeSet<CliId>,
}

fn is_absolute_windows(source: &str) -> bool {
    let b = source.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || source.starts_with("\\\\")
}

/// `parseWindowsCommandProbe`.
pub fn parse_windows_command_probe(output: &str) -> WindowsCommandProbe {
    let mut result = WindowsCommandProbe::default();
    for raw in output.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let clean = strip_ansi(raw);
        let line = clean.trim();
        for cli in CliId::ALL {
            let prefix = format!("__AJZ_CMD_{}__=", cli.upper());
            let Some(value) = line.strip_prefix(prefix.as_str()) else { continue };
            result.ran = true;
            let mut parts = value.split('|');
            let ty = parts.next().unwrap_or("").trim();
            let source = parts.collect::<Vec<_>>().join("|");
            let source = source.trim();
            if ty.is_empty() {
                continue;
            }
            if ty == "Application" && is_absolute_windows(source) {
                result.found.insert(cli, source.to_string());
            } else {
                result.aliased.insert(cli);
            }
        }
    }
    result
}

/// `quoteForCmd`: `"path"`, or None when the path holds what cannot be quoted for cmd.exe (`"`, `%`, line breaks).
pub fn quote_for_cmd(path: &str) -> Option<String> {
    if path.contains(['"', '%', '\r', '\n']) { None } else { Some(format!("\"{path}\"")) }
}

/// `resolveExecFile`: the detected file (quoted for cmd.exe on Windows) or the bare command.
pub fn resolve_exec_file(command: &str, status: Option<&CliStatus>, os: Os) -> String {
    let Some(path) = status.filter(|s| s.state == CliState::Found).and_then(|s| s.path.as_deref()) else {
        return command.to_string();
    };
    if !os.is_windows() {
        return path.to_string();
    }
    quote_for_cmd(path).unwrap_or_else(|| command.to_string())
}

/// `shellProbeScript`: the script run by `$SHELL -ilc` (POSIX shells and fish); None = unsupported shell.
pub fn shell_probe_script(shell_path: &str) -> Option<&'static str> {
    let name = shell_path.rsplit('/').next().unwrap_or("");
    if name == "fish" {
        return Some(
            "printf '__AJZ_PATH__=%s\\n' (string join : $PATH); printf '__AJZ_CLAUDE__=%s\\n' (command -v claude); printf '__AJZ_CODEX__=%s\\n' (command -v codex)",
        );
    }
    if !["zsh", "bash", "sh", "dash", "ksh"].contains(&name) {
        return None;
    }
    Some(
        "printf '__AJZ_PATH__=%s\\n' \"$PATH\"; printf '__AJZ_CLAUDE__=%s\\n' \"$(command -v claude 2>/dev/null)\"; printf '__AJZ_CODEX__=%s\\n' \"$(command -v codex 2>/dev/null)\"",
    )
}

#[cfg(test)]
#[path = "status_tests.rs"]
mod tests;
