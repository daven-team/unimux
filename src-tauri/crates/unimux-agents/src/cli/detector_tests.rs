//! test/cli-detect.test.ts ported: the same fake world (files, folders, texts, registry, clock, recorded exec calls) and one
//! #[tokio::test] per `it` (names in test/PORTING.md).

use super::*;
use std::collections::{HashMap, HashSet};

type ExecFn = Arc<dyn Fn(&ExecRequest) -> BoxFuture<'static, ExecResult> + Send + Sync>;

struct World {
    os: Os,
    home: String,
    env: Env,
    files: HashSet<String>,
    dirs: HashMap<String, Vec<String>>,
    texts: HashMap<String, String>,
    /// None = no registry access at all; Some(None) = the read fails.
    registry: Option<Option<RegistryPath>>,
    clock: i64,
    calls: Vec<ExecRequest>,
    shell: Option<String>,
    probe_profile: Option<String>,
}

struct Fake {
    w: Mutex<World>,
    exec: Mutex<ExecFn>,
}

impl CliDeps for Fake {
    fn os(&self) -> Os {
        self.w.lock().os
    }
    fn home(&self) -> String {
        self.w.lock().home.clone()
    }
    fn env(&self) -> Env {
        self.w.lock().env.clone()
    }
    fn now(&self) -> i64 {
        self.w.lock().clock
    }
    fn is_file(&self, path: String) -> BoxFuture<'static, bool> {
        let hit = self.w.lock().files.contains(&path);
        async move { hit }.boxed()
    }
    fn read_dir(&self, path: String) -> BoxFuture<'static, Vec<String>> {
        let v = self.w.lock().dirs.get(&path).cloned().unwrap_or_default();
        async move { v }.boxed()
    }
    fn read_file(&self, path: String) -> BoxFuture<'static, Option<String>> {
        let v = self.w.lock().texts.get(&path).cloned();
        async move { v }.boxed()
    }
    fn exec(&self, request: ExecRequest) -> BoxFuture<'static, ExecResult> {
        self.w.lock().calls.push(request.clone());
        let f = self.exec.lock().clone();
        f(&request)
    }
    fn has_registry(&self) -> bool {
        self.w.lock().registry.is_some()
    }
    fn read_windows_path(&self) -> BoxFuture<'static, Option<RegistryPath>> {
        let v = self.w.lock().registry.clone().flatten();
        async move { v }.boxed()
    }
    fn shell(&self) -> Option<String> {
        self.w.lock().shell.clone()
    }
    fn probe_profile(&self) -> Option<String> {
        self.w.lock().probe_profile.clone()
    }
}

fn res(ok: bool, stdout: &str, timed_out: bool) -> ExecResult {
    ExecResult { ok, stdout: stdout.into(), timed_out }
}
fn version_ok() -> ExecResult {
    res(true, "2.1.211 (Claude Code)\n", false)
}
fn sync_exec(f: impl Fn(&ExecRequest) -> ExecResult + Send + Sync + 'static) -> ExecFn {
    Arc::new(move |r| {
        let out = f(r);
        async move { out }.boxed()
    })
}
fn probe_out(path: &str, claude: &str, codex: &str) -> ExecResult {
    res(true, &format!("banner\n__AJZ_PATH__={path}\n__AJZ_CLAUDE__={claude}\n__AJZ_CODEX__={codex}\n"), false)
}
fn is_probe(r: &ExecRequest) -> bool {
    r.args.first().map(String::as_str) == Some("-ilc")
}
fn win_probe(claude: &str, codex: &str) -> ExecResult {
    res(true, &format!("Loading personal profile...\r\n__AJZ_CMD_CLAUDE__={claude}\r\n__AJZ_CMD_CODEX__={codex}\r\n"), false)
}
fn is_win_probe(r: &ExecRequest) -> bool {
    r.file == "powershell.exe" || r.file == "pwsh.exe"
}
fn env(pairs: &[(&str, &str)]) -> Env {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}
fn set(xs: &[&str]) -> HashSet<String> {
    xs.iter().map(|s| s.to_string()).collect()
}
fn get_path(e: &Env, os: Os) -> String {
    get_env(e, "PATH", os).unwrap_or_default().to_string()
}

/// The macOS world of the TS test.
fn world() -> World {
    World {
        os: Os::Mac,
        home: "/Users/a".into(),
        env: env(&[("PATH", "/usr/bin:/bin"), ("SHELL", "/bin/zsh")]),
        files: HashSet::new(),
        dirs: HashMap::new(),
        texts: HashMap::new(),
        registry: None,
        clock: 1_000_000,
        calls: vec![],
        shell: None,
        probe_profile: None,
    }
}

/// The Windows world of the TS test.
fn win() -> World {
    World {
        os: Os::Windows,
        home: "C:\\Users\\a".into(),
        env: env(&[
            ("Path", "C:\\Windows"),
            ("PATHEXT", ".COM;.EXE;.BAT;.CMD"),
            ("USERPROFILE", "C:\\Users\\a"),
            ("APPDATA", "C:\\Users\\a\\AppData\\Roaming"),
            ("ComSpec", "C:\\Windows\\System32\\cmd.exe"),
        ]),
        ..world()
    }
}

struct T {
    fake: Arc<Fake>,
    d: Arc<CliDetector>,
}

impl T {
    fn calls(&self) -> Vec<ExecRequest> {
        self.fake.w.lock().calls.clone()
    }
    fn w(&self) -> parking_lot::MutexGuard<'_, World> {
        self.fake.w.lock()
    }
    async fn get(&self, cli: CliId) -> CliStatus {
        self.d.get(cli, GetOptions::default()).await
    }
}

fn detector(w: World, exec: ExecFn) -> T {
    let fake = Arc::new(Fake { w: Mutex::new(w), exec: Mutex::new(exec) });
    let d = CliDetector::new(fake.clone());
    T { fake, d }
}

fn plain(w: World) -> T {
    detector(w, sync_exec(|_| version_ok()))
}

use CliId::{Claude, Codex};

// ── macOS ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn finds_a_cli_in_a_known_install_directory_that_is_not_on_the_app_path_and_verifies_its_version() {
    let t = plain(World { files: set(&["/Users/a/.local/bin/claude"]), ..world() });
    let s = t.get(Claude).await;
    assert_eq!(s.state, CliState::Found);
    assert_eq!(s.path.as_deref(), Some("/Users/a/.local/bin/claude"));
    assert_eq!(s.version.as_deref(), Some("2.1.211"));
    assert_eq!(s.source, Some(CliSource::Known));
    let calls = t.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].args, vec!["--version"]);
    assert_eq!(calls[0].timeout_ms, 5000);
    // the binary's directory is on the PATH of the version check (shims start `node` from there)
    assert_eq!(get_path(&calls[0].env, Os::Mac).split(':').next(), Some("/Users/a/.local/bin"));
}

#[tokio::test]
async fn finds_a_cli_through_the_path_walk() {
    let t = plain(World {
        env: env(&[("PATH", "/usr/bin:/custom/bin"), ("SHELL", "/bin/zsh")]),
        files: set(&["/custom/bin/codex"]),
        ..world()
    });
    let s = t.get(Codex).await;
    assert_eq!((s.state, s.path.as_deref(), s.source), (CliState::Found, Some("/custom/bin/codex"), Some(CliSource::Path)));
}

#[tokio::test]
async fn finds_the_newest_nvm_version_and_an_npm_prefix_from_npmrc() {
    let mut w = world();
    w.dirs.insert("/Users/a/.nvm/versions/node".into(), vec!["v18.1.0".into(), "v20.5.0".into()]);
    w.files = set(&["/Users/a/.nvm/versions/node/v20.5.0/bin/claude", "/Users/a/.npm-g/bin/codex"]);
    w.texts.insert("/Users/a/.npmrc".into(), "prefix=~/.npm-g".into());
    let t = plain(w);
    assert_eq!(t.get(Claude).await.path.as_deref(), Some("/Users/a/.nvm/versions/node/v20.5.0/bin/claude"));
    assert_eq!(t.get(Codex).await.path.as_deref(), Some("/Users/a/.npm-g/bin/codex"));
}

#[tokio::test]
async fn finds_a_cli_only_through_the_login_shell_probe_and_runs_the_probe_once_for_both_clis() {
    let t = detector(
        World { files: set(&["/opt/tools/claude", "/opt/tools/codex"]), ..world() },
        sync_exec(|r| if is_probe(r) { probe_out("/usr/bin:/opt/tools", "/opt/tools/claude", "") } else { version_ok() }),
    );
    let (claude, codex) = tokio::join!(t.get(Claude), t.get(Codex));
    assert_eq!(
        (claude.state, claude.path.as_deref(), claude.source),
        (CliState::Found, Some("/opt/tools/claude"), Some(CliSource::Shell))
    );
    assert_eq!(
        (codex.state, codex.path.as_deref(), codex.source),
        (CliState::Found, Some("/opt/tools/codex"), Some(CliSource::Shell))
    );
    let probes: Vec<_> = t.calls().into_iter().filter(is_probe).collect();
    assert_eq!(probes.len(), 1);
    assert_eq!(probes[0].file, "/bin/zsh");
    assert_eq!(probes[0].timeout_ms, 5000);
}

#[tokio::test]
async fn reports_missing_only_when_every_place_was_searched() {
    let t = detector(world(), sync_exec(|r| if is_probe(r) { probe_out("/usr/bin:/bin", "", "") } else { version_ok() }));
    let s = t.get(Claude).await;
    assert_eq!((s.state, s.reason), (CliState::Missing, Some(CliReason::NotOnPath)));
}

#[tokio::test]
async fn never_reports_missing_when_the_login_shell_resolves_the_name_to_an_alias_or_function() {
    let aliased = |value: &'static str| {
        detector(world(), sync_exec(move |r| if is_probe(r) { probe_out("/usr/bin:/bin", value, "") } else { version_ok() }))
    };
    for value in ["alias claude='/opt/x/claude --flag'", "claude", "claude is a shell function"] {
        let s = aliased(value).get(Claude).await;
        assert_eq!((s.state, s.reason), (CliState::Unknown, Some(CliReason::ShellAlias)), "{value}");
    }
    // the other CLI of the same probe is still judged on its own
    assert_eq!(aliased("alias claude='x'").get(Codex).await.state, CliState::Missing);
}

#[tokio::test]
async fn probes_with_the_shell_the_cells_run_not_shell() {
    let probe_exec = || sync_exec(|r| if is_probe(r) { probe_out("/usr/bin:/bin", "", "") } else { version_ok() });
    let t = detector(World { files: set(&["/bin/bash"]), shell: Some("bash".into()), ..world() }, probe_exec());
    t.get(Claude).await;
    assert_eq!(t.calls().into_iter().find(is_probe).unwrap().file, "/bin/bash");
    let zsh = detector(
        World {
            env: env(&[("PATH", "/usr/bin:/bin"), ("SHELL", "/bin/bash")]),
            files: set(&["/bin/zsh"]),
            shell: Some("zsh".into()),
            ..world()
        },
        probe_exec(),
    );
    zsh.get(Claude).await;
    assert_eq!(zsh.calls().into_iter().find(is_probe).unwrap().file, "/bin/zsh");
    // a configured shell that is not there falls back to $SHELL
    let absent = detector(World { shell: Some("bash".into()), ..world() }, probe_exec());
    absent.get(Claude).await;
    assert_eq!(absent.calls().into_iter().find(is_probe).unwrap().file, "/bin/zsh");
}

#[tokio::test]
async fn fails_open_unknown_when_the_login_shell_probe_times_out_or_the_shell_is_unsupported() {
    let timed_out = detector(world(), sync_exec(|_| res(false, "", true)));
    let s = timed_out.get(Claude).await;
    assert_eq!((s.state, s.reason), (CliState::Unknown, Some(CliReason::Timeout)));
    let unsupported = plain(World { env: env(&[("PATH", "/usr/bin"), ("SHELL", "/opt/homebrew/bin/nu")]), ..world() });
    let s = unsupported.get(Claude).await;
    assert_eq!((s.state, s.reason), (CliState::Unknown, Some(CliReason::ProbeFailed)));
    assert!(unsupported.calls().is_empty());
}

#[tokio::test]
async fn treats_a_binary_whose_version_check_fails_or_times_out_as_found_but_unverified() {
    let t = detector(World { files: set(&["/usr/local/bin/claude"]), ..world() }, sync_exec(|_| res(false, "", true)));
    let s = t.get(Claude).await;
    assert_eq!((s.state, s.reason, s.version), (CliState::Found, Some(CliReason::Timeout), None));
    let failed = detector(World { files: set(&["/usr/local/bin/claude"]), ..world() }, sync_exec(|_| res(false, "boom", false)));
    let s = failed.get(Claude).await;
    assert_eq!((s.state, s.reason), (CliState::Found, Some(CliReason::VersionFailed)));
}

#[tokio::test]
async fn never_exposes_anything_but_the_parsed_version_of_the_output() {
    let t = detector(
        World { files: set(&["/usr/local/bin/claude"]), ..world() },
        sync_exec(|_| res(true, "token sk-ant-123 1.2.3 more", false)),
    );
    let s = t.get(Claude).await;
    assert!(!serde_json::to_string(&s).unwrap().contains("sk-ant"));
    assert_eq!(s.version.as_deref(), Some("1.2.3"));
}

// ── Windows ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn finds_claude_exe_in_the_documented_local_bin_and_asks_it_through_cmd_exe() {
    let t = plain(World { files: set(&["C:\\Users\\a\\.local\\bin\\claude.exe"]), ..win() });
    let s = t.get(Claude).await;
    assert_eq!(
        (s.state, s.path.as_deref(), s.source),
        (CliState::Found, Some("C:\\Users\\a\\.local\\bin\\claude.exe"), Some(CliSource::Known))
    );
    let c = &t.calls()[0];
    assert_eq!(c.file, "C:\\Windows\\System32\\cmd.exe");
    assert_eq!(c.args, vec!["/d", "/s", "/c", "\"\"C:\\Users\\a\\.local\\bin\\claude.exe\" --version\""]);
    assert!(c.verbatim);
}

#[tokio::test]
async fn runs_an_exe_directly_when_its_path_cannot_be_quoted_for_cmd_exe() {
    let t = plain(World {
        files: set(&["C:\\100%\\claude.exe"]),
        env: env(&[("Path", "C:\\100%"), ("PATHEXT", ".EXE"), ("ComSpec", "C:\\Windows\\System32\\cmd.exe")]),
        ..win()
    });
    let s = t.get(Claude).await;
    assert_eq!((s.state, s.version.as_deref()), (CliState::Found, Some("2.1.211")));
    let c = &t.calls()[0];
    assert_eq!(c.file, "C:\\100%\\claude.exe");
    assert_eq!(c.args, vec!["--version"]);
    assert!(!c.verbatim);
}

#[tokio::test]
async fn runs_an_npm_cmd_shim_through_cmd_exe_with_a_safely_quoted_command_line() {
    let t = plain(World { files: set(&["C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd"]), ..win() });
    let s = t.get(Codex).await;
    assert_eq!((s.state, s.path.as_deref()), (CliState::Found, Some("C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd")));
    let c = &t.calls()[0];
    assert_eq!(c.file, "C:\\Windows\\System32\\cmd.exe");
    assert_eq!(c.args, vec!["/d", "/s", "/c", "\"\"C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd\" --version\""]);
    assert!(c.verbatim);
}

#[tokio::test]
async fn quotes_a_shim_path_so_that_ampersand_in_a_folder_name_works_and_refuses_what_cannot_be_quoted() {
    let amp = plain(World {
        files: set(&["C:\\Users\\R&D\\x\\claude.cmd"]),
        env: env(&[("Path", "C:\\Users\\R&D\\x"), ("PATHEXT", ".CMD"), ("ComSpec", "C:\\Windows\\System32\\cmd.exe")]),
        ..win()
    });
    let s = amp.get(Claude).await;
    assert_eq!((s.state, s.version.as_deref()), (CliState::Found, Some("2.1.211")));
    assert_eq!(amp.calls()[0].args, vec!["/d", "/s", "/c", "\"\"C:\\Users\\R&D\\x\\claude.cmd\" --version\""]);
    let percent =
        plain(World { files: set(&["C:\\100%\\claude.cmd"]), env: env(&[("Path", "C:\\100%"), ("PATHEXT", ".CMD")]), ..win() });
    let s = percent.get(Claude).await;
    assert_eq!((s.state, s.reason), (CliState::Found, Some(CliReason::VersionFailed)));
    assert!(percent.calls().is_empty());
}

#[tokio::test]
async fn picks_up_a_directory_only_the_registry_path_has() {
    let t = plain(World {
        registry: Some(Some(RegistryPath { machine: Some("C:\\Windows".into()), user: Some("%USERPROFILE%\\tools".into()) })),
        files: set(&["C:\\Users\\a\\tools\\claude.exe"]),
        ..win()
    });
    let s = t.get(Claude).await;
    assert_eq!(
        (s.state, s.source, s.path.as_deref()),
        (CliState::Found, Some(CliSource::Path), Some("C:\\Users\\a\\tools\\claude.exe"))
    );
}

#[tokio::test]
async fn reports_missing_with_a_readable_registry_and_unknown_when_the_registry_cannot_be_read() {
    let exec = || sync_exec(|r| if is_win_probe(r) { win_probe("", "") } else { version_ok() });
    let readable = detector(
        World { registry: Some(Some(RegistryPath { machine: Some("C:\\Windows".into()), user: None })), ..win() },
        exec(),
    );
    assert_eq!(readable.get(Claude).await.state, CliState::Missing);
    let broken = detector(World { registry: Some(None), ..win() }, exec());
    let s = broken.get(Claude).await;
    assert_eq!((s.state, s.reason), (CliState::Unknown, Some(CliReason::RegistryFailed)));
}

#[tokio::test]
async fn refreshes_the_cell_path_from_the_registry_without_reordering_it_and_keeps_the_path_key() {
    let t = plain(World {
        registry: Some(Some(RegistryPath {
            machine: Some("C:\\Windows;C:\\Machine".into()),
            user: Some("%USERPROFILE%\\Other".into()),
        })),
        files: set(&["C:\\Users\\a\\.local\\bin\\claude.exe"]),
        ..win()
    });
    t.get(Claude).await;
    let e = t.d.apply_env(env(&[("Path", "C:\\Windows;C:\\Mine"), ("MC_CELL_ID", "c1")]), Some(Claude)).await;
    assert_eq!(
        e.iter().filter(|(k, _)| k.eq_ignore_ascii_case("path")).map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        vec!["Path"]
    );
    // the detected dir goes in front, the rest keeps its order, registry-only entries come last
    assert_eq!(get_path(&e, Os::Windows), "C:\\Users\\a\\.local\\bin;C:\\Windows;C:\\Mine;C:\\Machine;C:\\Users\\a\\Other");
    assert_eq!(get_env(&e, "MC_CELL_ID", Os::Windows), Some("c1"));
}

#[tokio::test]
async fn does_not_touch_a_path_that_already_has_everything() {
    let t = plain(World {
        registry: Some(Some(RegistryPath { machine: Some("C:\\Windows".into()), user: None })),
        files: set(&["C:\\Windows\\claude.exe"]),
        ..win()
    });
    t.get(Claude).await;
    assert_eq!(get_path(&t.d.apply_env(env(&[("Path", "C:\\Windows")]), Some(Claude)).await, Os::Windows), "C:\\Windows");
}

/// The Windows world of the profile-probe cases (the probe answer comes from `probed_exec`).
fn probed() -> World {
    World { files: set(&["C:\\Tools\\claude.exe"]), shell: Some("powershell".into()), ..win() }
}

fn probed_exec(claude: &'static str) -> ExecFn {
    sync_exec(move |r| if is_win_probe(r) { win_probe(claude, "") } else { version_ok() })
}

#[tokio::test]
async fn finds_an_application_the_profile_put_on_the_path_and_verifies_it() {
    let t = detector(probed(), probed_exec("Application|C:\\Tools\\claude.exe"));
    let s = t.get(Claude).await;
    assert_eq!(
        (s.state, s.path.as_deref(), s.source, s.version.as_deref()),
        (CliState::Found, Some("C:\\Tools\\claude.exe"), Some(CliSource::Shell), Some("2.1.211"))
    );
    let probe = t.calls().into_iter().find(is_win_probe).unwrap();
    assert_eq!(probe.file, "powershell.exe");
    assert!(probe.args.contains(&"-Command".to_string()));
    assert!(!probe.args.contains(&"-NoProfile".to_string())); // the profile is the point
    assert_eq!(probe.timeout_ms, 8000);
}

#[tokio::test]
async fn treats_an_alias_function_or_script_as_unknown_never_as_missing() {
    for kind in ["Alias|claude-real", "Function|", "ExternalScript|C:\\Tools\\claude.ps1", "Cmdlet|"] {
        let t = detector(probed(), probed_exec(kind));
        let s = t.get(Claude).await;
        assert_eq!((s.state, s.reason), (CliState::Unknown, Some(CliReason::ShellAlias)), "{kind}");
    }
}

#[tokio::test]
async fn is_missing_only_when_the_shell_itself_ran_and_knows_nothing() {
    assert_eq!(detector(probed(), probed_exec("")).get(Claude).await.state, CliState::Missing);
    let broken = detector(probed(), sync_exec(|_| res(false, "", true)));
    let s = broken.get(Claude).await;
    assert_eq!((s.state, s.reason), (CliState::Unknown, Some(CliReason::Timeout)));
    let no_output = detector(probed(), sync_exec(|_| res(true, "garbage", false)));
    let s = no_output.get(Claude).await;
    assert_eq!((s.state, s.reason), (CliState::Unknown, Some(CliReason::ProbeFailed)));
}

#[tokio::test]
async fn runs_one_probe_for_both_clis_and_none_when_the_binary_is_found_on_the_path() {
    let t = detector(probed(), probed_exec(""));
    tokio::join!(t.get(Claude), t.get(Codex));
    assert_eq!(t.calls().iter().filter(|c| is_win_probe(c)).count(), 1);
    let hit = plain(World { files: set(&["C:\\Windows\\claude.exe"]), shell: Some("powershell".into()), ..win() });
    hit.get(Claude).await;
    assert_eq!(hit.calls().iter().filter(|c| is_win_probe(c)).count(), 0);
}

#[tokio::test]
async fn uses_pwsh_for_the_pwsh_shell_falling_back_to_windows_powershell_and_skips_the_probe_for_cmd() {
    let t = detector(World { shell: Some("pwsh".into()), ..probed() }, probed_exec("Application|C:\\Tools\\claude.exe"));
    t.get(Claude).await;
    assert_eq!(t.calls().into_iter().find(is_win_probe).unwrap().file, "pwsh.exe");
    let fallback = detector(
        World { shell: Some("pwsh".into()), ..probed() },
        sync_exec(|r| match r.file.as_str() {
            "pwsh.exe" => res(false, "", false),
            "powershell.exe" => win_probe("Application|C:\\Tools\\claude.exe", ""),
            _ => version_ok(),
        }),
    );
    let s = fallback.get(Claude).await;
    assert_eq!((s.state, s.source), (CliState::Found, Some(CliSource::Shell)));
    let cmd = detector(World { shell: Some("cmd".into()), ..probed() }, probed_exec("Application|C:\\Tools\\claude.exe"));
    assert_eq!(cmd.get(Claude).await.state, CliState::Missing);
    assert_eq!(cmd.calls().iter().filter(|c| is_win_probe(c)).count(), 0);
}

#[tokio::test]
async fn dot_sources_the_test_profile_instead_of_the_real_one_when_asked() {
    let t = detector(World { probe_profile: Some("D:\\lab\\profile.ps1".into()), ..probed() }, probed_exec(""));
    t.get(Claude).await;
    let probe = t.calls().into_iter().find(is_win_probe).unwrap();
    assert!(probe.args.contains(&"-NoProfile".to_string()));
    assert!(probe.args.last().unwrap().contains(". 'D:\\lab\\profile.ps1'; "));
}

// ── applyEnv on POSIX ────────────────────────────────────────────────────────

#[tokio::test]
async fn prepends_the_detected_directory_only_when_the_path_lacks_it_and_leaves_shell_cells_alone() {
    let t = plain(World { files: set(&["/Users/a/.local/bin/claude"]), ..world() });
    t.get(Claude).await;
    let p = |e: Env| get_path(&e, Os::Mac);
    assert_eq!(p(t.d.apply_env(env(&[("PATH", "/usr/bin:/bin")]), Some(Claude)).await), "/Users/a/.local/bin:/usr/bin:/bin");
    assert_eq!(p(t.d.apply_env(env(&[("PATH", "/x:/Users/a/.local/bin")]), Some(Claude)).await), "/x:/Users/a/.local/bin");
    assert_eq!(p(t.d.apply_env(env(&[("PATH", "/usr/bin")]), None).await), "/usr/bin");
}

// ── cache ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn shares_one_detection_between_concurrent_callers() {
    let t = plain(World { files: set(&["/usr/local/bin/claude"]), ..world() });
    let (a, b, c) = tokio::join!(t.get(Claude), t.get(Claude), t.get(Claude));
    assert_eq!(a, b);
    assert_eq!(b, c);
    assert_eq!(t.calls().len(), 1);
}

async fn wait_until(mut f: impl FnMut() -> bool) {
    for _ in 0..2000 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("condition not reached");
}

#[tokio::test]
async fn keeps_found_for_10_minutes_then_serves_the_stale_value_while_re_verifying_in_the_background() {
    let t = plain(World { files: set(&["/usr/local/bin/claude"]), ..world() });
    t.get(Claude).await;
    t.w().clock += FOUND_TTL_MS - 1;
    t.get(Claude).await;
    assert_eq!(t.calls().len(), 1);
    t.w().clock += 2;
    let stale = t.get(Claude).await;
    assert_eq!(stale.state, CliState::Found);
    wait_until(|| t.calls().len() == 2).await;
}

#[tokio::test]
async fn keeps_missing_for_30_seconds_and_then_looks_again() {
    let t = detector(world(), sync_exec(|r| if is_probe(r) { probe_out("/usr/bin", "", "") } else { version_ok() }));
    assert_eq!(t.get(Claude).await.state, CliState::Missing);
    let probes = || t.calls().iter().filter(|c| is_probe(c)).count();
    assert_eq!(probes(), 1);
    t.w().clock += MISSING_TTL_MS - 1;
    t.get(Claude).await;
    assert_eq!(probes(), 1);
    t.w().files.insert("/Users/a/.local/bin/claude".into());
    t.w().clock += 2;
    assert_eq!(t.get(Claude).await.state, CliState::Found);
}

#[tokio::test]
async fn invalidate_recheck_forget_the_cache_and_the_login_shell_snapshot() {
    let t = detector(world(), sync_exec(|r| if is_probe(r) { probe_out("/usr/bin", "", "") } else { version_ok() }));
    t.get(Claude).await;
    t.w().files.insert("/usr/local/bin/claude".into());
    assert_eq!(t.get(Claude).await.state, CliState::Missing); // still cached
    assert_eq!(t.d.recheck(Some(Claude)).await[&Claude].state, CliState::Found);
    assert_eq!(t.d.peek(Claude).unwrap().path.as_deref(), Some("/usr/local/bin/claude"));
    t.d.invalidate(None);
    assert!(t.d.peek(Claude).is_none());
    assert!(t.d.snapshot().is_empty());
}

#[tokio::test]
async fn does_not_let_an_older_slower_detection_overwrite_a_newer_recheck() {
    let (release, gate) = tokio::sync::oneshot::channel::<()>();
    let gate = Arc::new(Mutex::new(Some(gate)));
    let exec: ExecFn = Arc::new(move |_r| {
        let first = gate.lock().take();
        async move {
            if let Some(g) = first {
                let _ = g.await;
            }
            version_ok()
        }
        .boxed()
    });
    let t = detector(World { files: set(&["/usr/local/bin/claude"]), ..world() }, exec);
    let d = t.d.clone();
    let old = tokio::spawn(async move { d.get(Claude, GetOptions::default()).await });
    wait_until(|| t.calls().len() == 1).await;
    t.d.recheck(Some(Claude)).await;
    let _ = release.send(());
    old.await.unwrap();
    assert_eq!(t.d.peek(Claude).unwrap().state, CliState::Found);
}

#[tokio::test(start_paused = true)]
async fn returns_unknown_instead_of_blocking_when_a_detection_is_slower_than_the_caller_is_willing_to_wait() {
    let exec: ExecFn = Arc::new(|_| futures::future::pending::<ExecResult>().boxed()); // the probe never answers
    let t = detector(world(), exec);
    let s = t.d.get(Claude, GetOptions { wait_ms: 1000, force: false }).await;
    assert_eq!((s.state, s.reason), (CliState::Unknown, Some(CliReason::Timeout)));
}

#[tokio::test]
async fn notifies_listeners_about_changes_only() {
    let t = detector(
        World { files: set(&["/usr/local/bin/claude"]), ..world() },
        sync_exec(|r| if is_probe(r) { probe_out("/usr/bin", "", "") } else { version_ok() }),
    );
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    t.d.on_change(move |map| s2.lock().push((map.get(&Claude).map(|s| s.state), map.get(&Codex).map(|s| s.state))));
    t.get(Claude).await;
    t.d.recheck(Some(Claude)).await; // same result again: no second notification
    t.get(Codex).await; // codex is new (missing)
    assert_eq!(*seen.lock(), vec![(Some(CliState::Found), None), (Some(CliState::Found), Some(CliState::Missing))]);
}

// ── beyond the TS cases ──────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_detection_the_caller_stopped_waiting_for_still_lands_in_the_cache() {
    let exec: ExecFn = Arc::new(|_| {
        async {
            tokio::time::sleep(Duration::from_millis(3000)).await;
            version_ok()
        }
        .boxed()
    });
    let t = detector(World { files: set(&["/usr/local/bin/claude"]), ..world() }, exec);
    let s = t.d.get(Claude, GetOptions { wait_ms: 1000, force: false }).await;
    assert_eq!(s.state, CliState::Unknown);
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(t.d.peek(Claude).map(|s| s.state), Some(CliState::Found));
}

#[tokio::test]
async fn a_failed_registry_read_is_retried_on_the_next_spawn_and_focus_forgets_a_good_one() {
    let t = plain(World { registry: Some(None), ..win() });
    assert_eq!(t.d.apply_env(env(&[("Path", "C:\\A")]), None).await, env(&[("Path", "C:\\A")]));
    t.w().registry = Some(Some(RegistryPath { machine: Some("C:\\B".into()), user: None }));
    // the failed read was not cached
    assert_eq!(get_path(&t.d.apply_env(env(&[("Path", "C:\\A")]), None).await, Os::Windows), "C:\\A;C:\\B");
    t.w().registry = Some(Some(RegistryPath { machine: Some("C:\\C".into()), user: None }));
    // a good read is kept for a minute ...
    assert_eq!(get_path(&t.d.apply_env(env(&[("Path", "C:\\A")]), None).await, Os::Windows), "C:\\A;C:\\B");
    // ... unless a window focus forgot it
    t.d.invalidate_registry();
    assert_eq!(get_path(&t.d.apply_env(env(&[("Path", "C:\\A")]), None).await, Os::Windows), "C:\\A;C:\\C");
    t.w().registry = Some(Some(RegistryPath { machine: Some("C:\\D".into()), user: None }));
    t.w().clock += REGISTRY_TTL_MS + 1;
    assert_eq!(get_path(&t.d.apply_env(env(&[("Path", "C:\\A")]), None).await, Os::Windows), "C:\\A;C:\\D");
}

#[tokio::test]
async fn version_for_asks_the_binary_a_cell_path_really_runs() {
    let t = plain(World { files: set(&["/Users/a/.local/bin/claude", "/old/bin/claude"]), ..world() });
    t.get(Claude).await;
    // the detected folder first on the PATH: the detected version, no extra run
    let v = t.d.version_for(Claude, &env(&[("PATH", "/Users/a/.local/bin:/old/bin")]), 2000).await;
    assert_eq!(v.as_deref(), Some("2.1.211"));
    assert_eq!(t.calls().len(), 1);
    // an older install earlier on the PATH is asked itself, once (cached per path)
    *t.fake.exec.lock() = sync_exec(|_| res(true, "1.0.0 (Claude Code)", false));
    let v = t.d.version_for(Claude, &env(&[("PATH", "/old/bin:/Users/a/.local/bin")]), 2000).await;
    assert_eq!(v.as_deref(), Some("1.0.0"));
    let v = t.d.version_for(Claude, &env(&[("PATH", "/old/bin")]), 2000).await;
    assert_eq!(v.as_deref(), Some("1.0.0"));
    assert_eq!(t.calls().len(), 2);
    assert_eq!(t.calls()[1].env.iter().find(|(k, _)| k == "PATH").unwrap().1.split(':').next(), Some("/old/bin"));
}
