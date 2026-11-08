//! The cases of test/cli-install.test.ts (InstallManager and the install IPC handlers) on tokio's paused clock.

use std::sync::atomic::{AtomicBool, Ordering};

use super::*;
use crate::cli::status::{CliReason, CliSource};

fn found(cli: CliId, version: Option<&str>) -> CliStatus {
    CliStatus {
        cli,
        state: CliState::Found,
        path: Some(if cli == CliId::Claude { "C:\\Users\\a\\.local\\bin\\claude.exe" } else { "C:\\x\\codex.exe" }.into()),
        version: version.map(str::to_string),
        source: Some(CliSource::Known),
        reason: None,
        checked_at: 1,
    }
}

fn missing(cli: CliId) -> CliStatus {
    CliStatus::new(cli, CliState::Missing, Some(CliReason::NotOnPath), 1)
}

struct Fake {
    os: Os,
    shell: String,
    found_tools: Vec<&'static str>,
    node_version: &'static str,
    /// POSIX probe output; None = a failing probe.
    probe: Option<String>,
    command_override: Option<String>,
    start: tokio::time::Instant,
    status: Mutex<CliStatus>,
    spawned: Mutex<Vec<InstallPty>>,
    spawn_fails: AtomicBool,
    killed_pty: Mutex<Vec<String>>,
    killed_tree: Mutex<Vec<u32>>,
    states: Mutex<Vec<InstallState>>,
    execs: Mutex<Vec<ExecRequest>>,
    detects: Mutex<usize>,
    rechecks: Mutex<usize>,
    /// The next recheck waits for this.
    recheck_gate: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

impl Fake {
    fn new(os: Os) -> Self {
        Self {
            os,
            shell: if os.is_windows() { "powershell".into() } else { "zsh".into() },
            found_tools: vec![],
            node_version: "22.1.0",
            probe: Some(String::new()),
            command_override: None,
            start: tokio::time::Instant::now(),
            status: Mutex::new(missing(CliId::Claude)),
            spawned: Mutex::new(vec![]),
            spawn_fails: AtomicBool::new(false),
            killed_pty: Mutex::new(vec![]),
            killed_tree: Mutex::new(vec![]),
            states: Mutex::new(vec![]),
            execs: Mutex::new(vec![]),
            detects: Mutex::new(0),
            rechecks: Mutex::new(0),
            recheck_gate: Mutex::new(None),
        }
    }
    fn states(&self) -> Vec<InstallState> {
        self.states.lock().clone()
    }
    fn last(&self) -> InstallState {
        self.states.lock().last().cloned().expect("a state")
    }
    fn set_status(&self, s: CliStatus) {
        *self.status.lock() = s;
    }
}

impl InstallDeps for Fake {
    fn os(&self) -> Os {
        self.os
    }
    fn home(&self) -> String {
        if self.os.is_windows() { "C:\\Users\\a".into() } else { "/Users/a".into() }
    }
    fn shell(&self) -> Option<String> {
        Some(self.shell.clone())
    }
    fn env(&self) -> Env {
        [("PATH", "C:\\bin"), ("SHELL", "/bin/zsh"), ("APPDATA", "C:\\Users\\a\\AppData\\Roaming"), ("CLAUDECODE", "1")]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }
    fn now(&self) -> i64 {
        self.start.elapsed().as_millis() as i64
    }
    fn exec(&self, request: ExecRequest) -> BoxFuture<'static, ExecResult> {
        self.execs.lock().push(request.clone());
        let result = if request.file == "where.exe" {
            let ok = self.found_tools.contains(&request.args[0].as_str());
            ExecResult {
                ok,
                stdout: if ok { format!("C:\\tools\\{}.exe\r\n", request.args[0]) } else { String::new() },
                timed_out: false,
            }
        } else if request.args.first().map(String::as_str) == Some("--version") {
            ExecResult { ok: true, stdout: format!("v{}\n", self.node_version), timed_out: false }
        } else {
            match &self.probe {
                Some(out) => ExecResult { ok: true, stdout: out.clone(), timed_out: false },
                None => ExecResult::default(),
            }
        };
        async move { result }.boxed()
    }
    fn detect(&self, cli: CliId) -> BoxFuture<'static, CliStatus> {
        *self.detects.lock() += 1;
        let mut s = self.status.lock().clone();
        s.cli = cli;
        async move { s }.boxed()
    }
    fn recheck(&self, cli: CliId) -> BoxFuture<'static, CliStatusMap> {
        *self.rechecks.lock() += 1;
        let gate = self.recheck_gate.lock().take();
        let mut s = self.status.lock().clone();
        s.cli = cli;
        async move {
            if let Some(g) = gate {
                let _ = g.await;
            }
            let mut m = CliStatusMap::new();
            m.insert(cli, s);
            m
        }
        .boxed()
    }
    fn apply_env(&self, env: Env) -> BoxFuture<'static, Env> {
        let mut env = env;
        if let Some(slot) = env.iter_mut().find(|(k, _)| k == "PATH") {
            slot.1 = format!("{};C:\\fresh", slot.1);
        }
        async move { env }.boxed()
    }
    fn spawn_pty(&self, spec: InstallPty) -> Result<(), String> {
        if self.spawn_fails.swap(false, Ordering::SeqCst) {
            return Err("boom".into());
        }
        self.spawned.lock().push(spec);
        Ok(())
    }
    fn kill_pty(&self, id: &str) {
        self.killed_pty.lock().push(id.to_string());
    }
    fn kill_tree(&self, pid: u32) {
        self.killed_tree.lock().push(pid);
    }
    fn emit(&self, state: &InstallState) {
        self.states.lock().push(state.clone());
    }
    fn command_override(&self, _: CliId, _: InstallMethod) -> Option<String> {
        self.command_override.clone()
    }
}

fn manager(fake: Fake, timings: InstallTimings) -> (Arc<Fake>, Arc<InstallManager>) {
    let fake = Arc::new(fake);
    let m = InstallManager::new(fake.clone(), timings, Handle::current());
    (fake, m)
}

fn req(cli: &str, method: &str) -> Value {
    json!({ "cli": cli, "method": method })
}

async fn flush() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64) {
    flush().await;
    tokio::time::advance(Duration::from_millis(ms)).await;
    flush().await;
}

async fn begin(m: &Arc<InstallManager>) -> Started {
    m.start(&req("claude", "native")).await.expect("started")
}

fn tap<'a>(id: &'a str, data: &'a str) -> PtyEvent<'a> {
    PtyEvent::Tap { id, data }
}

const WRAPPED: &str = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm https://claude.ai/install.ps1 | iex\"";

#[tokio::test(start_paused = true)]
async fn lists_only_the_methods_that_can_work_with_the_exact_command_per_shell() {
    let mut f = Fake::new(Os::Windows);
    f.found_tools = vec!["winget", "npm", "node"];
    f.node_version = "20.9.0";
    let (f, m) = manager(f, InstallTimings::default());
    assert_eq!(
        m.options(&json!("claude")).await,
        Some(json!({
            "cli": "claude",
            "options": [
                { "method": "native", "command": WRAPPED },
                { "method": "winget", "command": "winget install Anthropic.ClaudeCode" },
                { "method": "npm", "command": "npm.cmd install -g @anthropic-ai/claude-code" },
            ],
            "nodeVersion": "20.9.0",
        }))
    );
    assert!(f.spawned.lock().is_empty());
    // node --version ran from where `where` found it.
    assert!(f.execs.lock().iter().any(|e| e.file == "C:\\tools\\node.exe"));
}

#[tokio::test(start_paused = true)]
async fn offers_only_the_native_installer_when_nothing_else_is_detectable_and_wraps_it_for_cmd() {
    let mut f = Fake::new(Os::Windows);
    f.shell = "cmd".into();
    let (_f, m) = manager(f, InstallTimings::default());
    let o = m.options(&json!("claude")).await.unwrap();
    assert_eq!(o["options"], json!([{ "method": "native", "command": WRAPPED }]));
    assert!(o.get("nodeVersion").is_none());
}

#[tokio::test(start_paused = true)]
async fn probes_the_login_shell_once_on_posix_and_offers_brew_and_npm_from_it() {
    let mut f = Fake::new(Os::Mac);
    f.probe = Some("__AJZ_TOOL_brew__=/opt/homebrew/bin/brew\n__AJZ_TOOL_npm__=/usr/local/bin/npm\n__AJZ_TOOL_node__=/usr/local/bin/node\n__AJZ_TOOL_curl__=/usr/bin/curl\n__AJZ_NODEV__=v22.2.0\n".into());
    let (f, m) = manager(f, InstallTimings::default());
    let o = m.options(&json!("claude")).await.unwrap();
    let methods: Vec<&str> = o["options"].as_array().unwrap().iter().map(|x| x["method"].as_str().unwrap()).collect();
    assert_eq!(methods, ["native", "brew", "npm"]);
    assert_eq!(o["options"][1]["command"], "brew install --cask claude-code");
    m.options(&json!("codex")).await;
    let execs = f.execs.lock().clone();
    assert_eq!(execs.len(), 1, "cached");
    assert_eq!(execs[0].file, "/bin/zsh");
    assert_eq!(execs[0].args[0], "-ilc");
    assert!(execs[0].env.iter().any(|(k, v)| k == "Unimux_PROBE" && v == "1"));
}

#[tokio::test(start_paused = true)]
async fn falls_back_to_the_native_installer_on_macos_and_to_nothing_on_linux_when_the_probe_fails() {
    let mut mac = Fake::new(Os::Mac);
    mac.probe = None;
    let (_f, m) = manager(mac, InstallTimings::default());
    assert_eq!(m.options(&json!("codex")).await.unwrap()["options"].as_array().unwrap().len(), 1);
    let mut linux = Fake::new(Os::Linux);
    linux.probe = None;
    let (_f, m) = manager(linux, InstallTimings::default());
    assert_eq!(m.options(&json!("codex")).await.unwrap()["options"], json!([]));
}

#[tokio::test(start_paused = true)]
async fn refreshes_the_prerequisites_after_the_cache_expired() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings { tools_ttl_ms: 1000, ..InstallTimings::default() });
    m.options(&json!("claude")).await;
    let calls = f.execs.lock().len();
    m.options(&json!("claude")).await;
    assert_eq!(f.execs.lock().len(), calls);
    advance(1500).await;
    m.options(&json!("claude")).await;
    assert!(f.execs.lock().len() > calls);
}

#[tokio::test(start_paused = true)]
async fn rejects_an_unknown_cli() {
    let (_f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    for bad in [json!("shell"), json!("__proto__"), json!(42), Value::Null, json!({})] {
        assert_eq!(m.options(&bad).await, None);
    }
}

#[tokio::test(start_paused = true)]
async fn refuses_hostile_and_impossible_requests_without_spawning_anything() {
    let mut f = Fake::new(Os::Windows);
    f.found_tools = vec!["winget"];
    let (f, m) = manager(f, InstallTimings::default());
    let bad = [
        Value::Null,
        json!("claude"),
        json!(42),
        json!([]),
        json!([["claude", "native"]]),
        json!({}),
        json!({ "cli": "claude" }),
        json!({ "method": "native" }),
        req("claude;calc", "native"),
        req("__proto__", "native"),
        req("constructor", "native"),
        req("claude", "native && calc"),
        req("claude", "__proto__"),
        req("claude", "toString"),
        json!({ "cli": "claude", "method": ["native"] }),
        json!({ "cli": ["claude"], "method": "native" }),
        json!({ "cli": "claude", "method": 42 }),
        req("claude", "brew"),
        req("codex", "winget"),
    ];
    for request in bad {
        assert_eq!(m.start(&request).await, Err(StartError::Invalid), "{request}");
    }
    assert!(f.spawned.lock().is_empty());
    assert!(!m.is_active());
}

#[tokio::test(start_paused = true)]
async fn refuses_a_method_whose_prerequisite_is_missing() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    assert_eq!(m.start(&req("claude", "winget")).await, Err(StartError::Unavailable));
    assert_eq!(m.start(&req("claude", "npm")).await, Err(StartError::Unavailable));
    assert!(f.spawned.lock().is_empty());
    assert!(!m.is_active(), "the claim is released");
    assert!(m.start(&req("claude", "native")).await.is_ok());
}

#[tokio::test(start_paused = true)]
async fn ignores_extra_fields_so_a_renderer_supplied_command_is_never_used() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    m.start(&json!({ "cli": "claude", "method": "native", "command": "calc.exe", "env": { "X": "1" }, "cwd": "C:\\" }))
        .await
        .unwrap();
    let spawned = f.spawned.lock().clone();
    assert_eq!(spawned.len(), 1);
    assert!(!spawned[0].command.contains("calc"));
    assert!(spawned[0].command.contains("irm https://claude.ai/install.ps1 | iex\""));
}

#[tokio::test(start_paused = true)]
async fn types_the_command_with_its_end_marker_in_a_clean_environment_with_the_refreshed_path() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let r = begin(&m).await;
    assert!(r.pty_id.starts_with("install:"));
    assert_eq!(r.command, WRAPPED);
    let spawned = f.spawned.lock().clone();
    assert_eq!(spawned[0].id, r.pty_id);
    assert_eq!(spawned[0].command, format!("{WRAPPED}; Write-Host ('__AJZ_DONE_' + '_' + [int](-not $?))"));
    let get = |k: &str| spawned[0].env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    assert_eq!(get("PATH").as_deref(), Some("C:\\bin;C:\\fresh"));
    assert_eq!(get("CLAUDECODE"), None);
    assert_eq!(f.states(), vec![InstallState::Running { session_id: r.session_id }]);
}

#[tokio::test(start_paused = true)]
async fn uses_the_shell_specific_marker_for_cmd_and_posix_shells() {
    let mut f = Fake::new(Os::Windows);
    f.shell = "cmd".into();
    let (f, m) = manager(f, InstallTimings::default());
    begin(&m).await;
    assert_eq!(f.spawned.lock()[0].command, format!("{WRAPPED} && echo __AJZ_DON^E__0 || echo __AJZ_DON^E__1"));
    let mut mac = Fake::new(Os::Mac);
    mac.probe = Some("__AJZ_TOOL_curl__=/usr/bin/curl\n".into());
    let (f, m) = manager(mac, InstallTimings::default());
    m.start(&req("codex", "native")).await.unwrap();
    assert_eq!(
        f.spawned.lock()[0].command,
        "(set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | sh); echo \"__AJZ_DONE_\"\"_$?\""
    );
}

#[tokio::test(start_paused = true)]
async fn honours_the_unpackaged_build_override_for_the_typed_text_only() {
    let mut f = Fake::new(Os::Windows);
    f.command_override = Some("powershell -File D:\\lab\\fake.ps1".into());
    let (f, m) = manager(f, InstallTimings::default());
    let r = begin(&m).await;
    assert!(f.spawned.lock()[0].command.starts_with("powershell -File D:\\lab\\fake.ps1; Write-Host"));
    assert_eq!(r.command, WRAPPED);
    assert_eq!(m.start(&req("claude", "bogus")).await, Err(StartError::Invalid));
}

#[tokio::test(start_paused = true)]
async fn reports_a_spawn_failure_and_releases_the_claim() {
    let f = Fake::new(Os::Windows);
    f.spawn_fails.store(true, Ordering::SeqCst);
    let (_f, m) = manager(f, InstallTimings::default());
    assert_eq!(m.start(&req("claude", "native")).await, Err(StartError::Spawn));
    assert!(!m.is_active());
    assert!(m.start(&req("claude", "native")).await.is_ok());
}

#[tokio::test(start_paused = true)]
async fn succeeds_when_the_marker_arrives_split_across_chunks_and_the_detector_finds_the_cli() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let r = begin(&m).await;
    let id = r.pty_id.as_str();
    m.on_host_event(PtyEvent::Spawned { id, pid: 4321 });
    m.on_host_event(tap(
        id,
        "PS C:\\Users\\a> irm https://claude.ai/install.ps1 | iex; Write-Host ('__AJZ_DONE_' + '_' + [int](-not $?))\r\n",
    ));
    m.on_host_event(tap(id, "Installing...\r\n__AJZ_DO"));
    flush().await;
    assert_eq!(f.states().len(), 1, "neither the echo nor half a marker count");
    f.set_status(found(CliId::Claude, Some("2.1.211")));
    m.on_host_event(tap(id, "NE__0\r\n"));
    flush().await;
    assert_eq!(*f.rechecks.lock(), 1);
    assert_eq!(
        f.last(),
        InstallState::Succeeded {
            session_id: r.session_id.clone(),
            version: Some("2.1.211".into()),
            path: Some("C:\\Users\\a\\.local\\bin\\claude.exe".into()),
            dir: Some("C:\\Users\\a\\.local\\bin".into()),
        }
    );
    assert_eq!(*f.killed_tree.lock(), vec![4321]);
    assert_eq!(*f.killed_pty.lock(), vec![r.pty_id.clone()]);
    assert!(!m.is_active());
}

#[tokio::test(start_paused = true)]
async fn fails_with_a_mapped_reason_on_a_non_zero_exit() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let r = begin(&m).await;
    m.on_host_event(tap(&r.pty_id, "curl: (22) The requested URL returned error: 403\r\n__AJZ_DONE__22\r\n"));
    flush().await;
    assert_eq!(
        f.last(),
        InstallState::Failed { session_id: r.session_id, reason: InstallReason::Proxy, exit_code: Some(22), dir: None }
    );
    assert_eq!(*f.killed_pty.lock(), vec![r.pty_id]);
}

#[tokio::test(start_paused = true)]
async fn reports_installed_but_not_on_path_and_a_shell_exit() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let r = begin(&m).await;
    m.on_host_event(tap(&r.pty_id, "Setup complete\r\n__AJZ_DONE__0\r\n"));
    flush().await;
    assert_eq!(
        f.last(),
        InstallState::Failed {
            session_id: r.session_id,
            reason: InstallReason::NotOnPath,
            exit_code: Some(0),
            dir: Some("C:\\Users\\a\\.local\\bin".into()),
        }
    );
    let r = begin(&m).await;
    m.on_host_event(tap(&r.pty_id, "Access is denied\r\n"));
    m.on_host_event(PtyEvent::Exit { id: &r.pty_id, code: 1 });
    flush().await;
    assert!(matches!(f.last(), InstallState::Failed { reason: InstallReason::Permission, exit_code: Some(1), .. }));
    let r = begin(&m).await;
    m.on_host_event(PtyEvent::SpawnError { id: &r.pty_id });
    assert!(matches!(f.last(), InstallState::Failed { reason: InstallReason::Generic, exit_code: None, .. }));
    assert!(!m.is_active());
}

#[tokio::test(start_paused = true)]
async fn times_out_after_10_minutes_kills_the_terminal_and_reports_timeout() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let r = begin(&m).await;
    m.on_host_event(PtyEvent::Spawned { id: &r.pty_id, pid: 9 });
    advance(10 * 60_000 - 1000).await;
    assert_eq!(f.states().len(), 1);
    advance(2000).await;
    assert_eq!(
        f.last(),
        InstallState::Failed { session_id: r.session_id, reason: InstallReason::Timeout, exit_code: None, dir: None }
    );
    assert_eq!(*f.killed_tree.lock(), vec![9]);
    assert!(!m.is_active());
}

#[tokio::test(start_paused = true)]
async fn succeeds_at_the_time_limit_when_the_cli_is_there_after_all() {
    let (f, m) =
        manager(Fake::new(Os::Windows), InstallTimings { poll: Duration::from_secs(20 * 60), ..InstallTimings::default() });
    begin(&m).await;
    f.set_status(found(CliId::Claude, Some("2.1.0")));
    advance(10 * 60_000 + 10).await;
    assert_eq!(f.last().status(), "succeeded");
}

#[tokio::test(start_paused = true)]
async fn cancel_kills_the_process_tree_and_the_pty_emits_nothing_and_ignores_late_output() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let r = begin(&m).await;
    m.on_host_event(PtyEvent::Spawned { id: &r.pty_id, pid: 777 });
    m.cancel("some-other-id");
    assert!(f.killed_pty.lock().is_empty());
    m.cancel(&r.session_id);
    assert_eq!(*f.killed_tree.lock(), vec![777]);
    assert_eq!(*f.killed_pty.lock(), vec![r.pty_id.clone()]);
    assert!(!m.is_active());
    f.set_status(found(CliId::Claude, Some("2.1.0")));
    m.on_host_event(tap(&r.pty_id, "__AJZ_DONE__0\r\n"));
    m.on_host_event(PtyEvent::Exit { id: &r.pty_id, code: 0 });
    advance(11 * 60_000).await;
    assert_eq!(f.states().len(), 1);
    assert_eq!(*f.rechecks.lock(), 0);
}

#[tokio::test(start_paused = true)]
async fn cancelling_while_the_detector_re_check_runs_drops_the_result() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let r = begin(&m).await;
    let (open, gate) = tokio::sync::oneshot::channel();
    *f.recheck_gate.lock() = Some(gate);
    f.set_status(found(CliId::Claude, Some("2.1.0")));
    m.on_host_event(tap(&r.pty_id, "__AJZ_DONE__0\r\n"));
    flush().await;
    m.cancel(&r.session_id);
    let _ = open.send(());
    flush().await;
    assert_eq!(f.states().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn allows_only_one_install_at_a_time_and_a_new_one_after_the_first_ended() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let first = begin(&m).await;
    assert_eq!(m.start(&req("codex", "native")).await, Err(StartError::Busy));
    assert_eq!(m.start(&req("claude", "native")).await, Err(StartError::Busy));
    m.on_host_event(tap(&first.pty_id, "__AJZ_DONE__1\r\n"));
    flush().await;
    assert!(m.start(&req("codex", "native")).await.is_ok());
    assert_eq!(f.spawned.lock().len(), 2);
    // A concurrent start while the prerequisites are probed.
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let request = req("claude", "native");
    let (a, b) = tokio::join!(m.start(&request), m.start(&request));
    assert!(a.is_ok() != b.is_ok());
    assert_eq!(f.spawned.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn ignores_messages_of_other_terminals_and_arriving_without_a_session() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    assert!(!m.on_host_event(tap("install:nobody", "__AJZ_DONE__0\r\n")));
    let r = begin(&m).await;
    assert!(!m.on_host_event(tap("abc-cell", "__AJZ_DONE__0\r\n")));
    let other = r.pty_id.replace("install:", "install:x");
    assert!(!m.on_host_event(tap(&other, "__AJZ_DONE__0\r\n")));
    flush().await;
    assert_eq!(f.states().len(), 1);
    assert_eq!(*f.rechecks.lock(), 0);
}

#[tokio::test(start_paused = true)]
async fn fails_the_active_install_on_a_crash_and_kills_on_dispose() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    begin(&m).await;
    m.fail_active();
    assert!(matches!(f.last(), InstallState::Failed { reason: InstallReason::Generic, .. }));
    assert!(!m.is_active());
    let r = begin(&m).await;
    m.on_host_event(PtyEvent::Spawned { id: &r.pty_id, pid: 5 });
    let before = f.states().len();
    m.dispose();
    assert_eq!(f.killed_tree.lock().last(), Some(&5));
    assert_eq!(f.killed_pty.lock().last(), Some(&r.pty_id));
    assert_eq!(f.states().len(), before);
}

#[tokio::test(start_paused = true)]
async fn finishes_after_a_grace_period_when_the_detector_sees_a_verified_cli() {
    let t = InstallTimings { poll: Duration::from_millis(1000), grace: Duration::from_millis(5000), ..InstallTimings::default() };
    let (f, m) = manager(Fake::new(Os::Windows), t);
    let r = begin(&m).await;
    advance(3000).await;
    assert_eq!(f.states().len(), 1);
    f.set_status(found(CliId::Claude, Some("2.1.9")));
    advance(1100).await;
    assert_eq!(f.states().len(), 1, "found, but the command may still be finishing");
    advance(5100).await;
    assert!(matches!(f.last(), InstallState::Succeeded { ref version, .. } if version.as_deref() == Some("2.1.9")));
    assert_eq!(f.killed_pty.lock().last(), Some(&r.pty_id));
    assert_eq!(*f.rechecks.lock(), 1, "polls never invalidate the caches");
    assert!(*f.detects.lock() >= 2);
}

#[tokio::test(start_paused = true)]
async fn lets_the_marker_win_inside_the_grace_period_and_needs_a_verified_version() {
    let t = InstallTimings { poll: Duration::from_millis(1000), grace: Duration::from_millis(5000), ..InstallTimings::default() };
    let (f, m) = manager(Fake::new(Os::Windows), t);
    let r = begin(&m).await;
    f.set_status(found(CliId::Claude, Some("2.1.9")));
    advance(1100).await;
    m.on_host_event(tap(&r.pty_id, "__AJZ_DONE__0\r\n"));
    flush().await;
    assert_eq!(f.last().status(), "succeeded");
    advance(10_000).await;
    assert_eq!(f.states().iter().filter(|s| s.status() == "succeeded").count(), 1);

    let t = InstallTimings { poll: Duration::from_millis(1000), grace: Duration::from_millis(2000), ..InstallTimings::default() };
    let (f, m) = manager(Fake::new(Os::Windows), t);
    begin(&m).await;
    f.set_status(CliStatus { version: None, reason: Some(CliReason::VersionFailed), ..found(CliId::Claude, None) });
    advance(8000).await;
    assert_eq!(f.states().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn ends_as_aborted_when_the_user_hits_ctrl_c_and_no_marker_follows() {
    let (f, m) =
        manager(Fake::new(Os::Windows), InstallTimings { abort_grace: Duration::from_millis(2000), ..InstallTimings::default() });
    let r = begin(&m).await;
    m.on_host_event(PtyEvent::Spawned { id: &r.pty_id, pid: 11 });
    m.on_host_event(tap(&r.pty_id, "Downloading...\r\n^C\r\nPS C:\\Users\\a> "));
    m.on_host_event(PtyEvent::Interrupt { id: &r.pty_id });
    advance(1900).await;
    assert_eq!(f.states().len(), 1);
    advance(200).await;
    assert_eq!(
        f.last(),
        InstallState::Failed { session_id: r.session_id, reason: InstallReason::Aborted, exit_code: None, dir: None }
    );
    assert_eq!(*f.killed_tree.lock(), vec![11]);
    assert!(!m.is_active());
}

#[tokio::test(start_paused = true)]
async fn lets_a_marker_that_still_arrives_after_ctrl_c_decide() {
    let mut fk = Fake::new(Os::Windows);
    fk.shell = "cmd".into();
    let (f, m) = manager(fk, InstallTimings { abort_grace: Duration::from_millis(2000), ..InstallTimings::default() });
    let r = begin(&m).await;
    m.on_host_event(PtyEvent::Interrupt { id: &r.pty_id });
    advance(500).await;
    m.on_host_event(tap(&r.pty_id, "^C\r\n__AJZ_DONE__1\r\n"));
    flush().await;
    assert!(matches!(f.last(), InstallState::Failed { reason: InstallReason::Generic, exit_code: Some(1), .. }));
    advance(5000).await;
    assert_eq!(f.states().iter().filter(|s| s.status() == "failed").count(), 1);

    // Installed after all.
    let (f, m) =
        manager(Fake::new(Os::Windows), InstallTimings { abort_grace: Duration::from_millis(1000), ..InstallTimings::default() });
    let r = begin(&m).await;
    f.set_status(found(CliId::Claude, Some("2.1.0")));
    m.on_host_event(PtyEvent::Interrupt { id: &r.pty_id });
    advance(1100).await;
    assert_eq!(f.last().status(), "succeeded");
}

#[tokio::test(start_paused = true)]
async fn does_not_finish_on_half_of_a_multi_digit_exit_code() {
    let (f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    let r = begin(&m).await;
    m.on_host_event(tap(&r.pty_id, "curl: (22) The requested URL returned error: 403\r\n__AJZ_DONE__1"));
    flush().await;
    assert_eq!(f.states().len(), 1);
    m.on_host_event(tap(&r.pty_id, "30\r\n"));
    flush().await;
    assert!(matches!(f.last(), InstallState::Failed { exit_code: Some(130), .. }));
}

#[tokio::test(start_paused = true)]
async fn exposes_the_running_install_so_a_window_opened_later_attaches_to_it() {
    let (_f, m) = manager(Fake::new(Os::Windows), InstallTimings::default());
    assert_eq!(m.active(), None);
    let r = begin(&m).await;
    assert_eq!(
        m.active().map(|a| a.to_json()),
        Some(json!({ "sessionId": r.session_id, "ptyId": r.pty_id, "cli": "claude", "method": "native", "command": r.command }))
    );
    m.cancel(&r.session_id);
    assert_eq!(m.active(), None);
}

#[tokio::test(start_paused = true)]
async fn probes_the_tools_with_the_shell_the_cells_run() {
    let mut fk = Fake::new(Os::Mac);
    fk.probe = Some("__AJZ_TOOL_curl__=/usr/bin/curl\n".into());
    fk.shell = "bash".into();
    let (f, m) = manager(fk, InstallTimings::default());
    m.options(&json!("claude")).await;
    assert_eq!(f.execs.lock()[0].file, "/bin/bash");
}

#[test]
fn start_results_serialize_like_main() {
    assert_eq!(start_result_json(&Err(StartError::Busy)), json!({ "ok": false, "error": "busy" }));
    let ok = Started { session_id: "s".into(), pty_id: "install:s".into(), command: "c".into() };
    assert_eq!(start_result_json(&Ok(ok)).to_string(), r#"{"ok":true,"sessionId":"s","ptyId":"install:s","command":"c"}"#);
    let id = uuid_v4();
    assert_eq!(id.len(), 36);
    assert_eq!(&id[14..15], "4");
}
