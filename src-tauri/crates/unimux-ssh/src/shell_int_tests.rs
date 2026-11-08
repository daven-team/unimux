//! SSH shell cells against the in-process test server's scripted shell: the cases of 1.1.4's test/ssh.int.test.ts,
//! test/ssh-remote-list.int.test.ts and test/ssh-bar.int.test.ts that need a real connection (the login methods
//! themselves are test_server/tests.rs, the output plane is unimux-pty's).

use std::sync::atomic::{AtomicBool, Ordering};

use unimux_pty::batch::Transport;
use unimux_pty::frame::KIND_DATA;

use super::*;
use crate::protocol::AuthPromptKind;
use crate::test_server::{ExecOutput, TestServer, TestServerConfig, TestUser};

#[derive(Default)]
struct Rec {
    messages: Mutex<Vec<HostMessage>>,
}

impl ShellEvents for Rec {
    fn spawned(&self, _id: &str) {}
    fn message(&self, m: HostMessage) {
        self.messages.lock().push(m);
    }
}

#[derive(Default)]
struct Frames {
    bytes: Mutex<Vec<u8>>,
    /// Data payload bytes of every terminal so far.
    data_len: std::sync::atomic::AtomicUsize,
    /// Keep only the count (the flood).
    count_only: AtomicBool,
}

/// `(kind, id, payload)` of every frame of one message.
fn frames_of(bytes: &[u8]) -> Vec<(u8, &[u8], &[u8])> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 7 <= bytes.len() {
        let id_len = u16::from_le_bytes([bytes[i + 1], bytes[i + 2]]) as usize;
        let at = i + 3 + id_len;
        let len = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        out.push((bytes[i], &bytes[i + 3..at], &bytes[at + 4..at + 4 + len]));
        i = at + 4 + len;
    }
    out
}

impl Transport for Frames {
    fn post(&self, _seq: u64, bytes: Vec<u8>) -> bool {
        let data: usize = frames_of(&bytes).iter().filter(|f| f.0 == KIND_DATA).map(|f| f.2.len()).sum();
        self.data_len.fetch_add(data, Ordering::SeqCst);
        if !self.count_only.load(Ordering::SeqCst) {
            self.bytes.lock().extend_from_slice(&bytes);
        }
        true
    }
    fn gated(&self) -> bool {
        false
    }
    fn name(&self) -> &'static str {
        "test"
    }
    fn close(&self) {}
}

/// One `sshStatus`: phase, error, exit code, banner.
type StatusOf = (SshPhase, Option<SshErrorCode>, Option<i64>, Option<String>);

struct Rig {
    engine: PtyEngine,
    shells: Arc<SshShells>,
    rec: Arc<Rec>,
    frames: Arc<Frames>,
    exits: Arc<Mutex<Vec<(String, i64)>>>,
}

const FAST: ShellTimers = ShellTimers {
    shell: Duration::from_secs(20),
    quiet: Duration::from_millis(100),
    startup_max: Duration::from_millis(2000),
    kill_grace: Duration::from_millis(500),
};

fn rig() -> Rig {
    let engine = PtyEngine::new();
    let exits = Arc::new(Mutex::new(Vec::new()));
    let e = exits.clone();
    engine.on_exit(move |id, code| e.lock().push((id.to_string(), code)));
    let rec = Arc::new(Rec::default());
    let shells = SshShells::with_timers(engine.clone(), tokio::runtime::Handle::current(), rec.clone(), LOGIN_TIMERS, FAST);
    let frames = Arc::new(Frames::default());
    // The main window's attach turns flow control on, like the app.
    engine.attach("main", frames.clone());
    Rig { engine, shells, rec, frames, exits }
}

async fn server(config: TestServerConfig) -> TestServer {
    let users = vec![TestUser::new("alice").password("pw")];
    TestServer::start(TestServerConfig { users, shell: true, scripted_shell: true, ..config }).await.unwrap()
}

fn req(id: &str, port: u16, password: Option<&str>) -> ConnectRequest {
    ConnectRequest {
        id: id.into(),
        host: "127.0.0.1".into(),
        port,
        username: "alice".into(),
        cols: 100,
        rows: 30,
        private_key: None,
        passphrase: None,
        password: password.map(|p| zeroize::Zeroizing::new(p.to_string())),
        startup: None,
        allow_password_prompt: true,
        debug: false,
        sftp_sudo: None,
    }
}

async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..6000 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("not reached: {what}");
}

impl Rig {
    /// The data frames of `id` (each one is whole UTF-8 text: the session decodes before it pushes).
    fn chunks(&self, id: &str) -> Vec<Vec<u8>> {
        let bytes = self.frames.bytes.lock();
        frames_of(&bytes).into_iter().filter(|f| f.0 == KIND_DATA && f.1 == id.as_bytes()).map(|f| f.2.to_vec()).collect()
    }
    fn out(&self, id: &str) -> String {
        String::from_utf8_lossy(&self.chunks(id).concat()).into_owned()
    }
    fn statuses(&self, id: &str) -> Vec<StatusOf> {
        self.rec
            .messages
            .lock()
            .iter()
            .filter_map(|m| match m {
                HostMessage::Status { id: i, phase, error, exit_code, banner } if i == id => {
                    Some((*phase, *error, *exit_code, banner.clone()))
                }
                _ => None,
            })
            .collect()
    }
    fn phases(&self, id: &str) -> Vec<SshPhase> {
        self.statuses(id).into_iter().filter(|s| s.3.is_none()).map(|s| s.0).collect()
    }
    fn last(&self, id: &str) -> (SshPhase, Option<SshErrorCode>, Option<i64>) {
        let s = self.statuses(id).pop().unwrap();
        (s.0, s.1, s.2)
    }
    fn exit_of(&self, id: &str) -> Option<i64> {
        self.exits.lock().iter().find(|(i, _)| i == id).map(|(_, c)| *c)
    }
    fn host_key(&self, id: &str) -> Option<(String, String)> {
        self.rec.messages.lock().iter().find_map(|m| match m {
            HostMessage::HostKey { id: i, prompt_id, key } if i == id => Some((prompt_id.clone(), key.clone())),
            _ => None,
        })
    }
    async fn trust(&self, id: &str) -> String {
        wait_for("host key", || self.host_key(id).is_some()).await;
        let (prompt_id, key) = self.host_key(id).unwrap();
        self.shells.answer(HostCommand::HostKeyAnswer { id: id.into(), prompt_id, accept: true, error: None });
        key
    }
    fn prompts(&self, id: &str) -> Vec<(String, AuthPromptKind, bool)> {
        self.rec
            .messages
            .lock()
            .iter()
            .filter_map(|m| match m {
                HostMessage::AuthPrompt { id: i, prompt_id, prompt } if i == id => {
                    Some((prompt_id.clone(), prompt.kind, prompt.retry))
                }
                _ => None,
            })
            .collect()
    }
    async fn connected(&self, id: &str, port: u16) {
        self.shells.connect(req(id, port, Some("pw")));
        self.trust(id).await;
        wait_for("prompt", || self.out(id).contains("$ ")).await;
    }
    fn ack(&self, id: &str, chars: usize) {
        if chars > 0 {
            self.engine.post("main", &json!({ "t": "ack", "id": id, "chars": chars }));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn signs_in_types_the_startup_once_resizes_decodes_utf8_and_reports_the_exit() {
    let s = server(TestServerConfig::default()).await;
    let r = rig();
    let mut request = req("c1", s.port(), Some("pw"));
    request.startup = Some("echo one\recho two\r".into());
    r.shells.connect(request);
    let key = r.trust("c1").await;
    assert_eq!(key, s.host_keys_base64()[0]);
    wait_for("startup output", || r.out("c1").contains("two\r\n$ ")).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(String::from_utf8_lossy(&s.shell_log().input), "echo one\recho two\r", "typed once");
    let out = r.out("c1");
    assert!(out.find("Welcome").unwrap() < out.find("one").unwrap(), "after the greeting: {out:?}");
    assert_eq!(r.phases("c1"), [SshPhase::Connecting, SshPhase::Verifying, SshPhase::Authenticating, SshPhase::Connected]);
    assert_eq!(s.shell_log().ptys, [("xterm-256color".to_string(), 100, 30)]);

    r.engine.resize("c1", 120, 40);
    wait_for("window change", || !s.shell_log().window_changes.is_empty()).await;
    assert_eq!(s.shell_log().window_changes, [(120, 40)]);

    // A keystroke reaches the server as written and its echo comes back.
    let before = r.out("c1").len();
    r.engine.write("c1", b"a");
    wait_for("echo", || r.out("c1").len() > before).await;
    assert_eq!(&r.out("c1")[before..], "a");
    r.engine.write("c1", b"\r");

    // A character cut across packets arrives whole: every pushed chunk is valid UTF-8.
    r.engine.write("c1", b"split\r");
    wait_for("split text", || r.out("c1").contains("zażółć 🙂")).await;
    assert!(r.chunks("c1").iter().all(|c| std::str::from_utf8(c).is_ok()));
    assert!(!r.out("c1").contains('\u{FFFD}'));

    r.engine.write("c1", b"exit\r");
    wait_for("exit", || r.exit_of("c1").is_some()).await;
    assert_eq!(r.exit_of("c1"), Some(3));
    assert_eq!(r.last("c1"), (SshPhase::Closed, None, Some(3)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn asks_for_a_password_three_times_and_a_cancelled_prompt_ends_the_login() {
    let s = server(TestServerConfig::default()).await;
    let r = rig();
    r.shells.connect(req("c1", s.port(), None));
    r.trust("c1").await;
    for i in 1..=3 {
        wait_for("prompt", || r.prompts("c1").len() == i).await;
        let (prompt_id, _, _) = r.prompts("c1")[i - 1].clone();
        let values = Some(vec![zeroize::Zeroizing::new("wrong".to_string())]);
        r.shells.answer(HostCommand::AuthAnswer { id: "c1".into(), prompt_id, values });
    }
    wait_for("exit", || r.exit_of("c1").is_some()).await;
    let kinds: Vec<(AuthPromptKind, bool)> = r.prompts("c1").into_iter().map(|p| (p.1, p.2)).collect();
    assert_eq!(kinds, [(AuthPromptKind::Password, false), (AuthPromptKind::Password, true), (AuthPromptKind::Password, true)]);
    assert_eq!(r.last("c1"), (SshPhase::Error, Some(SshErrorCode::Auth), None));
    assert_eq!(r.exit_of("c1"), Some(-1));

    r.shells.connect(req("c2", s.port(), None));
    r.trust("c2").await;
    wait_for("prompt", || !r.prompts("c2").is_empty()).await;
    let prompt_id = r.prompts("c2")[0].0.clone();
    r.shells.answer(HostCommand::AuthAnswer { id: "c2".into(), prompt_id, values: None });
    wait_for("exit", || r.exit_of("c2").is_some()).await;
    assert_eq!(r.last("c2"), (SshPhase::Error, Some(SshErrorCode::Cancelled), None));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kills_drops_and_replaces_sessions_like_1_1_4() {
    let s = server(TestServerConfig::default()).await;
    let r = rig();

    // A kill closes the server side, resolves and reports nothing.
    r.connected("c1", s.port()).await;
    assert_eq!(s.connections(), 1);
    let wait = r.engine.kill("c1");
    assert!(!r.shells.has("c1"));
    assert!(tokio::task::spawn_blocking(move || wait.wait(Duration::from_secs(5))).await.unwrap());
    wait_for("server side closed", || s.connections() == 0).await;
    assert_eq!(r.exit_of("c1"), None);

    // A kill while the host key question is open: no session, no late events, even when the answer comes after it.
    r.shells.connect(req("c2", s.port(), Some("pw")));
    wait_for("host key", || r.host_key("c2").is_some()).await;
    let before = r.statuses("c2").len();
    let started = std::time::Instant::now();
    let wait = r.engine.kill("c2");
    assert!(tokio::task::spawn_blocking(move || wait.wait(Duration::from_secs(5))).await.unwrap());
    assert!(started.elapsed() < Duration::from_secs(2));
    let (prompt_id, _) = r.host_key("c2").unwrap();
    r.shells.answer(HostCommand::HostKeyAnswer { id: "c2".into(), prompt_id, accept: true, error: None });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(r.statuses("c2").len(), before);
    assert!(!r.shells.has("c2"));

    // A dropped connection ends as reset with exit -1, never as a clean close.
    wait_for("server side closed", || s.connections() == 0).await;
    r.connected("c3", s.port()).await;
    s.drop_connections();
    wait_for("exit", || r.exit_of("c3").is_some()).await;
    assert_eq!(r.exit_of("c3"), Some(-1));
    assert_eq!(r.last("c3"), (SshPhase::Error, Some(SshErrorCode::Reset), None));

    // A second connect for the same id replaces the first session: one connection stays.
    wait_for("server side closed", || s.connections() == 0).await;
    r.shells.connect(req("c4", s.port(), Some("pw")));
    r.shells.connect(req("c4", s.port(), Some("pw")));
    wait_for("connected", || {
        if let Some((prompt_id, _)) = r.host_key("c4") {
            r.shells.answer(HostCommand::HostKeyAnswer { id: "c4".into(), prompt_id, accept: true, error: None });
        }
        r.shells.is_connected("c4")
    })
    .await;
    wait_for("one connection", || s.connections() == 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_remote_exit_stays_a_clean_close_when_the_server_answers_with_a_reset() {
    let s = server(TestServerConfig { reset_on_exit: true, ..TestServerConfig::default() }).await;
    let r = rig();
    r.connected("c1", s.port()).await;
    r.engine.write("c1", b"exit\r");
    wait_for("exit", || r.exit_of("c1").is_some()).await;
    assert_eq!(r.exit_of("c1"), Some(3));
    assert_eq!(r.last("c1"), (SshPhase::Closed, None, Some(3)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn back_pressures_the_server_until_acks_and_drains_a_paused_tail_before_the_end() {
    let s = server(TestServerConfig::default()).await;
    let r = rig();
    r.connected("c1", s.port()).await;
    let delivered = || r.frames.data_len.load(Ordering::SeqCst);
    r.ack("c1", delivered());
    r.frames.count_only.store(true, Ordering::SeqCst);
    let base = delivered();
    r.engine.write("c1", b"flood 25165824\r");
    let total = 24 * 1024 * 1024;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let stalled = s.shell_log().flood_sent;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(s.shell_log().flood_sent, stalled, "the server is held back while nothing is acknowledged");
    assert!(stalled < total);
    let mut acked = base;
    for _ in 0..3000 {
        let now = delivered();
        r.ack("c1", now - acked);
        acked = now;
        if s.shell_log().flood_sent == total && now >= base + total {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(s.shell_log().flood_sent, total);
    assert!(delivered() >= base + total, "everything arrives after acks");
    r.frames.count_only.store(false, Ordering::SeqCst);

    // No acks from here on: the session pauses and the rest waits in the channel when the server exits and hangs up;
    // the tail is still delivered before the end is reported.
    r.connected("c2", s.port()).await;
    r.ack("c2", r.out("c2").len());
    r.engine.write("c2", b"tail 1800000\r");
    wait_for("exit", || r.exit_of("c2").is_some()).await;
    assert!(r.out("c2").contains("TAIL-END"));
    assert_eq!(r.last("c2"), (SshPhase::Closed, None, Some(0)));
}

/// A server whose `exec sh -s` answers the scripts like a Linux server (`bar`: also the status bar), or like Windows.
async fn script_server(bar: &'static str, busy: Arc<AtomicBool>) -> TestServer {
    let handler = move |command: &str, stdin: &[u8]| -> ExecOutput {
        let script = String::from_utf8_lossy(stdin).into_owned();
        if command != "exec sh -s" || bar == "windows" {
            let stderr = b"'exec' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
            return ExecOutput { stdout: vec![], stderr: stderr.to_vec(), status: 1 };
        }
        // Slow enough for the busy / cancelled cases.
        std::thread::sleep(Duration::from_millis(150));
        if script.starts_with("# unimux status bar") {
            let mut text = String::from("@v 1\n@host srv36\n@kernel Linux 6.1.0\n@user root\n@cpu 100 50 1000\n@net 1000 2000\n");
            if script.contains("os-release") {
                text.push_str("@os debian Debian GNU/Linux 12 (bookworm)\n");
            }
            text.push_str("@end\n");
            return ExecOutput { stdout: text.into_bytes(), stderr: vec![], status: 0 };
        }
        if busy.load(Ordering::SeqCst) {
            return ExecOutput { stdout: b"@busy\n".to_vec(), stderr: vec![], status: 0 };
        }
        let line = |name: &str| script.lines().find_map(|l| l.strip_prefix(name)).unwrap_or("''").to_string();
        let (c, d) = (line("c="), line("d="));
        let cwd = if c == "''" { "/home/alice".to_string() } else { c.trim_matches('\'').to_string() };
        let mut out = format!("@cwd {cwd}\n");
        if !script.contains("exit 0\n") || script.contains("@dir") {
            let listing = match d.as_str() {
                "''" => Some((cwd.clone(), (1..=10).map(|i| format!("TEST{i}")).collect::<Vec<_>>())),
                "'/'" => Some(("/".into(), vec!["home/".into(), "srv/".into()])),
                "'/srv/'" => Some(("/srv".into(), vec!["ftp/".into()])),
                "'/home/'" => Some(("/home".into(), vec!["alice/".into()])),
                _ => None,
            };
            match listing {
                Some((dir, names)) => {
                    out.push_str(&format!("@dir {dir}\n./\n../\n"));
                    for n in names {
                        out.push_str(&format!("{n}\n"));
                    }
                }
                None => out.push_str("@nodir\n"),
            }
        }
        ExecOutput { stdout: out.into_bytes(), stderr: vec![], status: 0 }
    };
    let config = TestServerConfig { exec_stdin: Some(Arc::new(handler)), ..TestServerConfig::default() };
    server(config).await
}

fn list(dir: &str, cwd: Option<&str>, cwd_only: bool) -> ListRequest {
    ListRequest { dir: dir.into(), cwd: cwd.map(str::to_string), cwd_only }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lists_folders_on_the_cells_own_connection_with_busy_cancelled_and_gone() {
    let busy = Arc::new(AtomicBool::new(false));
    let s = script_server("debian", busy.clone()).await;
    let r = rig();
    r.connected("c1", s.port()).await;
    let home = r.shells.list("c1", list("", None, false)).await;
    let ListResult::Ok { cwd, entries, truncated } = home else { panic!("{home:?}") };
    assert_eq!((cwd.as_deref(), truncated), (Some("/home/alice"), false));
    let mut names: Vec<String> = entries.into_iter().map(|e| e.0).collect();
    names.sort();
    let mut expected: Vec<String> = (1..=10).map(|i| format!("TEST{i}")).collect();
    expected.sort();
    assert_eq!(names, expected);
    assert_eq!(r.shells.list("c1", list("/s", None, false)).await, ListResult::Failed("nodir"));
    assert_eq!(
        r.shells.list("c1", list("/srv/", None, false)).await,
        ListResult::Ok { cwd: Some("/home/alice".into()), entries: vec![("ftp".into(), true)], truncated: false }
    );
    assert_eq!(
        r.shells.list("c1", list("", Some("/srv"), true)).await,
        ListResult::Ok { cwd: Some("/srv".into()), entries: vec![], truncated: false }
    );
    assert_eq!(s.connections(), 1, "no second login");
    assert!(s.execs().iter().all(|c| c == "exec sh -s"));

    // A newer request replaces the waiting one, which answers cancelled.
    let (a, b, c) = tokio::join!(
        r.shells.list("c1", list("/", None, false)),
        async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            r.shells.list("c1", list("/srv/", None, false)).await
        },
        async {
            tokio::time::sleep(Duration::from_millis(60)).await;
            r.shells.list("c1", list("/home/", None, false)).await
        },
    );
    assert!(matches!(a, ListResult::Ok { .. }), "{a:?}");
    assert_eq!(b, ListResult::Failed("cancelled"));
    assert!(matches!(&c, ListResult::Ok { entries, .. } if entries == &[("alice".to_string(), true)]), "{c:?}");
    assert_eq!(r.shells.list("nope", list("/", None, false)).await, ListResult::Failed("gone"));

    // A full-screen program in the shell: the script answers busy.
    busy.store(true, Ordering::SeqCst);
    assert_eq!(r.shells.list("c1", list("", None, false)).await, ListResult::Failed("busy"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn runs_the_bar_script_on_the_same_connection_one_run_at_a_time() {
    let s = script_server("debian", Arc::new(AtomicBool::new(false))).await;
    let r = rig();
    r.connected("c1", s.port()).await;
    let StatsRun::Ok { text, bytes, partial, .. } = r.shells.stats("c1", true).await else { panic!("first run") };
    assert!(!partial);
    assert_eq!(bytes, text.len());
    assert!(text.contains("@host srv36") && text.contains("@os debian"), "{text}");
    let StatsRun::Ok { text, .. } = r.shells.stats("c1", false).await else { panic!("second run") };
    assert!(!text.contains("@os"), "the system is asked for only the first time");
    assert_eq!(s.connections(), 1);
    assert_eq!(s.execs().len(), 2);
    let (a, b) = tokio::join!(r.shells.stats("c1", true), async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        r.shells.stats("c1", false).await
    });
    assert_eq!(b, StatsRun::Failed("busy"));
    assert!(matches!(a, StatsRun::Ok { .. }));
    assert_eq!(r.shells.stats("nope", false).await, StatsRun::Failed("gone"));

    // A server without sh: the run answers, with nothing a bar can read.
    let s = script_server("windows", Arc::new(AtomicBool::new(false))).await;
    r.connected("c2", s.port()).await;
    let StatsRun::Ok { text, .. } = r.shells.stats("c2", true).await else { panic!("windows run") };
    assert!(!text.contains("@v "), "{text:?}");
}
