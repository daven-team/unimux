//! The per-cell Claude settings file against the running hook server (the settings halves of the HookServer cases of
//! test/main-misc, status-continuation, main-perf, hook-fallback and status-hooks-shell), and the hooks of a written file run
//! the way Claude Code runs them: the http hooks posted with their headers, the exec form's curl started with its `args`,
//! the shell form's command line through a POSIX shell (Git Bash on Windows), each with the payload on stdin.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use unimux_agents::hooks::claude::{ClaudeHookForm, HookTarget, claude_extended_hooks, claude_hook_settings};
use unimux_agents::hooks::{HookServer, HookSignal};

struct Fixture {
    server: HookServer,
    seen: Arc<Mutex<Vec<HookSignal>>>,
    port: u16,
    dir: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let server = HookServer::new();
        let seen: Arc<Mutex<Vec<HookSignal>>> = Arc::default();
        let sink = seen.clone();
        server.set_handler(Arc::new(move |s| sink.lock().push(s)));
        let port = server.start().await.expect("listen");
        Self { server, seen, port, dir: tempfile::tempdir().unwrap() }
    }

    fn write(&self, cell: &str, version: Option<&str>, form: Option<ClaudeHookForm>) -> Value {
        let path = self.server.write_claude_settings(self.dir.path(), cell, version, form).unwrap();
        assert_eq!(path, self.dir.path().join(format!("claude-{cell}.json")));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn hooks(&self) -> Vec<(String, String, Option<Value>)> {
        self.seen
            .lock()
            .iter()
            .filter_map(|s| match s {
                HookSignal::Hook { cell, event, info } => Some((cell.clone(), event.clone(), info.clone())),
                _ => None,
            })
            .collect()
    }

    fn names(&self) -> Vec<String> {
        self.hooks().into_iter().map(|(c, e, _)| format!("{c}:{e}")).collect()
    }
}

fn hook<'a>(settings: &'a Value, name: &str) -> &'a Value {
    &settings["hooks"][name][0]["hooks"][0]
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("{key} in {v}"))
}

async fn request(port: u16, path: &str, headers: &[(&str, &str)], body: &[u8]) -> u16 {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut head =
        format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let t = String::from_utf8_lossy(&answer);
    t.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or_else(|| panic!("no status in {t:?}"))
}

fn path_of(url: &str) -> String {
    let rest = url.strip_prefix("http://127.0.0.1:").unwrap();
    rest[rest.find('/').unwrap()..].to_string()
}

/// Posts like Claude Code's http hook: its URL and its headers.
async fn post_http(port: u16, hook: &Value, body: &str) -> u16 {
    let headers: Vec<(String, String)> =
        hook["headers"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
    let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let mut all = headers.clone();
    all.push(("Content-Type", "application/json"));
    request(port, &path_of(text(hook, "url")), &all, body.as_bytes()).await
}

/// The curl Claude Code would start (Windows ships curl.exe since 1803); None when there is none.
fn curl() -> Option<String> {
    let ok = |c: &str| {
        Command::new(c).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    };
    ["curl"].into_iter().find(|c| ok(c)).map(str::to_string)
}

/// A POSIX shell like the hook shell of Claude Code (Git Bash on Windows, never WSL's bash.exe).
fn posix_shell() -> Option<String> {
    let candidates: Vec<String> = if cfg!(windows) {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        vec![format!("{pf}\\Git\\bin\\bash.exe"), format!("{pf}\\Git\\usr\\bin\\bash.exe")]
    } else {
        vec!["/bin/sh".into()]
    };
    candidates.into_iter().find(|c| Path::new(c).exists())
}

fn run_with_stdin(mut cmd: Command, stdin: &str) -> std::process::ExitStatus {
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.stdout.is_empty(), "204 has no body, so the hook prints nothing: {:?}", String::from_utf8_lossy(&out.stdout));
    out.status
}

/// Runs a command hook of the file the way Claude Code does (exec form: the program and `args`; else the command line
/// through the POSIX shell).
fn run_command_hook(hook: &Value, stdin: &str, shell: Option<&str>) -> bool {
    assert_eq!(hook["type"], "command");
    if let Some(args) = hook["args"].as_array() {
        let mut cmd = Command::new(text(hook, "command"));
        cmd.args(args.iter().map(|a| a.as_str().unwrap()));
        return run_with_stdin(cmd, stdin).success();
    }
    let Some(shell) = shell else { return false };
    let mut cmd = Command::new(shell);
    cmd.arg("-c").arg(text(hook, "command"));
    run_with_stdin(cmd, stdin).success()
}

// main-misc "writes a claude settings file with the status hooks"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_a_claude_settings_file_with_the_status_hooks() {
    let f = Fixture::new().await;
    let json = f.write("c9", None, None);
    let keys: Vec<&String> = json["hooks"].as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        ["UserPromptSubmit", "Stop", "Notification", "PreToolUse", "PostToolUse", "SubagentStop", "SessionStart", "StopFailure"]
    );
    let token = f.server.token();
    assert!(text(hook(&json, "PostToolUse"), "command").contains(&format!("/h/{token}/c9/busy/")));
    assert!(text(hook(&json, "Stop"), "command").contains(&format!("/h/{token}/c9/stop/")));
    f.server.stop();
}

// status-reliability "writes a StopFailure hook that posts its payload", background-stop "writes a Stop hook that posts its
// payload", session-hook "writes a SessionStart hook that posts its payload"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_stop_stop_failure_and_session_start_hooks_post_their_payloads() {
    let f = Fixture::new().await;
    let json = f.write("c3", None, None);
    let token = f.server.token();
    let fail = text(hook(&json, "StopFailure"), "command");
    assert!(fail.contains("--data-binary @-"), "{fail}");
    assert!(fail.contains(&format!("/h/{token}/c3/fail/")), "{fail}");
    let stop = text(hook(&json, "Stop"), "command");
    assert!(stop.contains("--data-binary @-") && stop.contains("/c3/stop"), "{stop}");
    assert!(!text(hook(&json, "UserPromptSubmit"), "command").contains("--data-binary"));
    let session = text(hook(&json, "SessionStart"), "command");
    assert!(session.contains("--data-binary @-") && session.contains("-m 2"), "{session}");
    assert!(session.contains(&format!("/h/{token}/c3/session")), "{session}");
    f.server.stop();
}

// main-misc "rejects malformed ids and oversized bodies without crashing, and sends bodies only for notify" (settings half)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sends_bodies_only_for_the_hooks_whose_payload_counts() {
    let f = Fixture::new().await;
    let json = f.write("c2", None, None);
    assert!(text(hook(&json, "Notification"), "command").contains("--data-binary"));
    assert!(!text(hook(&json, "PostToolUse"), "command").contains("--data-binary"));
    f.server.stop();
}

// status-continuation "SubagentStop hook wiring: has its own URL event and arrives as a subagent busy hook" (settings half)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subagent_stop_has_its_own_url_event_and_arrives_as_a_subagent_busy_hook() {
    let f = Fixture::new().await;
    let json = f.write("c4", None, None);
    assert!(text(hook(&json, "SubagentStop"), "command").contains("/c4/subagent/"));
    assert!(text(hook(&json, "PostToolUse"), "command").contains("/c4/busy/"));
    let url = |event: &str| text(hook(&json, event), "command").rsplit(' ').next().unwrap().to_string();
    assert_eq!(request(f.port, &path_of(&url("SubagentStop")), &[], b"{}").await, 204);
    assert_eq!(request(f.port, &path_of(&url("PostToolUse")), &[], b"{}").await, 204);
    assert_eq!(f.hooks(), [("c4".into(), "busy".into(), Some(json!({ "subagent": true }))), ("c4".into(), "busy".into(), None)]);
    f.server.stop();
}

// main-perf "accept http hook posts with the header token, keep the curl path, and read big tool payloads to the end"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accept_http_hook_posts_with_the_header_token_keep_the_curl_path_and_read_big_tool_payloads_to_the_end() {
    let f = Fixture::new().await;
    let json = f.write("c1", Some("2.1.309"), None);
    let pre = hook(&json, "PreToolUse");
    assert!(!text(pre, "url").contains(f.server.token()));
    // A PostToolUse payload with a whole file in it: answered 204, still a busy.
    let big = json!({ "tool_response": "x".repeat(3_000_000) }).to_string();
    assert_eq!(post_http(f.port, hook(&json, "PostToolUse"), &big).await, 204);
    assert_eq!(post_http(f.port, hook(&json, "Stop"), r#"{"background_tasks":[]}"#).await, 204);
    assert_eq!(post_http(f.port, hook(&json, "Notification"), r#"{"notification_type":"permission_prompt"}"#).await, 204);
    // The same URL without the header (or with a wrong one) is refused.
    assert_eq!(request(f.port, &path_of(text(pre, "url")), &[], b"{}").await, 403);
    assert_eq!(request(f.port, &path_of(text(pre, "url")), &[("Authorization", "Bearer nope")], b"{}").await, 403);
    // SessionStart still posts through curl's path token.
    let args = hook(&json, "SessionStart")["args"].as_array().unwrap();
    assert!(args.last().unwrap().as_str().unwrap().contains(&format!("/h/{}/c1/session/", f.server.token())));
    assert_eq!(f.names(), ["c1:busy", "c1:stop", "c1:notify"]);
    f.server.stop();
}

// hook-fallback "writes command hooks into the settings file when the form is overridden"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_command_hooks_into_the_settings_file_when_the_form_is_overridden() {
    let f = Fixture::new().await;
    let settings = f.write("cell-1", Some("2.1.310"), Some(ClaudeHookForm::Shell));
    assert_eq!(hook(&settings, "Stop")["type"], "command");
    let http = f.write("cell-1", Some("2.1.310"), None);
    assert_eq!(hook(&http, "Stop")["type"], "http");
    f.server.stop();
}

// status-hooks-shell "Claude hook settings: 2.1.78+ gets the precise hooks; older and unknown versions keep the basic set"
#[test]
fn from_2_1_78_on_the_precise_hooks_older_and_unknown_versions_keep_the_basic_set() {
    assert!(claude_extended_hooks(Some("2.1.310 (Claude Code)")));
    assert!(claude_extended_hooks(Some("2.1.78")));
    assert!(!claude_extended_hooks(Some("2.1.77")));
    assert!(!claude_extended_hooks(None));
    let url = |e: &str| format!("http://127.0.0.1:1/h/t/c/{e}/n");
    let header = |e: &str| format!("http://127.0.0.1:1/k/c/{e}/n");
    let target = HookTarget { url: &url, header_url: &header, token: "t" };
    let extended = claude_hook_settings(&target, ClaudeHookForm::Http, true);
    for event in [
        "PermissionRequest",
        "PostToolUseFailure",
        "PermissionDenied",
        "SubagentStart",
        "PreCompact",
        "PostCompact",
        "Elicitation",
        "ElicitationResult",
    ] {
        assert!(extended["hooks"].get(event).is_some(), "{event}");
    }
    assert!(extended["hooks"]["PermissionRequest"].to_string().contains("/permission/"));
    assert!(extended["hooks"]["PreToolUse"].to_string().contains("/pre/"));
    let basic = claude_hook_settings(&target, ClaudeHookForm::Http, false);
    assert!(basic["hooks"].get("PermissionRequest").is_none());
    assert!(basic["hooks"]["PreToolUse"].to_string().contains("/busy/"));
    // The curl form never gets them (they would upload whole payloads through a process per call).
    assert!(claude_hook_settings(&target, ClaudeHookForm::Shell, true)["hooks"].get("PermissionRequest").is_none());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_settings_file_is_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt as _;
    let f = Fixture::new().await;
    let path = f.server.write_claude_settings(f.dir.path(), "c1", None, None).unwrap();
    assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
    f.server.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_settings_file_drops_the_hooks_of_the_previous_process() {
    let f = Fixture::new().await;
    let old = f.write("c1", None, None);
    let new = f.write("c1", None, None);
    let url = |s: &Value| text(hook(s, "UserPromptSubmit"), "command").rsplit(' ').next().unwrap().to_string();
    assert_ne!(url(&old), url(&new));
    assert_eq!(request(f.port, &path_of(&url(&old)), &[], b"").await, 204);
    assert!(f.names().is_empty(), "a late hook of the old process is answered and dropped");
    assert_eq!(request(f.port, &path_of(&url(&new)), &[], b"").await, 204);
    assert_eq!(f.names(), ["c1:prompt"]);
    f.server.stop();
}

/// The hooks of a written file, run the way Claude Code runs them, reach the server with their payloads: the exec form (curl
/// with `args`), the shell form (the curl line through the hook shell) and the http form (posted with its headers).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_written_hooks_run_like_claude_code_runs_them_reach_the_server() {
    let Some(_curl) = curl() else {
        eprintln!("skipped: no curl on this machine");
        return;
    };
    let f = Fixture::new().await;
    let session = |id: &str| json!({ "session_id": id, "source": "startup" }).to_string();
    const ID: &str = "3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091";

    // exec (2.1.139+): SessionStart is a shell-free curl, every other hook an http hook.
    let exec = f.write("cx", Some("2.1.310"), None);
    assert!(run_command_hook(hook(&exec, "SessionStart"), &session(ID), None));
    assert_eq!(post_http(f.port, hook(&exec, "PermissionRequest"), r#"{"tool_name":"Bash"}"#).await, 204);
    assert_eq!(post_http(f.port, hook(&exec, "Stop"), r#"{"background_tasks":[]}"#).await, 204);

    // shell (an unknown version): every hook is a curl line through the hook shell.
    let shell = posix_shell();
    let plain = f.write("cs", None, None);
    if let Some(sh) = shell.as_deref() {
        assert!(run_command_hook(hook(&plain, "Notification"), r#"{"notification_type":"permission_prompt"}"#, Some(sh)));
        assert!(run_command_hook(hook(&plain, "PreToolUse"), r#"{"tool_name":"Bash"}"#, Some(sh)));
        assert!(run_command_hook(hook(&plain, "StopFailure"), r#"{"error":"rate_limit"}"#, Some(sh)));
    } else {
        eprintln!("shell form: no POSIX shell (Git Bash) on this machine, its curl lines were not run");
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let seen = f.seen.lock().clone();
    let mut want = vec![
        HookSignal::Session { cell: "cx".into(), session_id: ID.into(), source: Some("startup".into()) },
        HookSignal::SessionStart { cell: "cx".into(), source: Some("startup".into()) },
        HookSignal::Hook {
            cell: "cx".into(),
            event: "notify".into(),
            info: Some(json!({ "need": "permission", "immediate": true, "tool": "Bash" })),
        },
        HookSignal::Hook {
            cell: "cx".into(),
            event: "stop".into(),
            info: Some(json!({ "tasks": 0, "active": 0, "statuses": [], "types": [], "continuation": false, "workflows": 0 })),
        },
    ];
    if shell.is_some() {
        want.push(HookSignal::Hook { cell: "cs".into(), event: "notify".into(), info: Some(json!({ "need": "permission" })) });
        want.push(HookSignal::Hook { cell: "cs".into(), event: "busy".into(), info: None });
        want.push(HookSignal::Hook { cell: "cs".into(), event: "fail".into(), info: Some(json!({ "error": "rate_limit" })) });
    }
    assert_eq!(seen, want);
    f.server.stop();
}
