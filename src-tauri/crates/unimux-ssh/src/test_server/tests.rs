//! The login core (S3) against the in-process server: every method, the 1.1.4 auth order as the server saw it, the host
//! key bytes, exec and SFTP on the logged-in connection.

use std::sync::Arc;

use parking_lot::Mutex;
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::Zeroizing;

use super::sftp::{self, FXP_INIT, FXP_NAME, FXP_OPEN, FXP_STATUS, FXP_VERSION, FXP_WRITE, put_bytes, put_u32};
use super::*;
use crate::keys::{KeyGenRequest, KeyType, generate_key_blocking};
use crate::login::{LOGIN_TIMERS, LoginControl, LoginEvents, LoginHandle, LoginRequest, login};
use crate::protocol::{AuthPromptInfo, AuthPromptKind};
use crate::session::{SshErrorCode, SshPhase};

/// Accepts the host key and answers prompts: passwords with `password`, keyboard prompts with `answers`.
struct Auto {
    control: Arc<LoginControl>,
    password: Option<String>,
    answers: Vec<String>,
    host_key: Mutex<Option<String>>,
    prompts: Mutex<Vec<AuthPromptKind>>,
    methods: Mutex<Vec<String>>,
    banner: Mutex<Option<String>>,
}

impl Auto {
    fn new(control: Arc<LoginControl>, password: Option<&str>, answers: &[&str]) -> Arc<Auto> {
        Arc::new(Auto {
            control,
            password: password.map(str::to_string),
            answers: answers.iter().map(|s| s.to_string()).collect(),
            host_key: Mutex::new(None),
            prompts: Mutex::new(Vec::new()),
            methods: Mutex::new(Vec::new()),
            banner: Mutex::new(None),
        })
    }
}

impl LoginEvents for Auto {
    fn phase(&self, _: SshPhase) {}
    fn banner(&self, text: &str) {
        *self.banner.lock() = Some(text.to_string());
    }
    fn host_key(&self, prompt_id: &str, key_base64: &str) {
        *self.host_key.lock() = Some(key_base64.to_string());
        self.control.answer_host_key(prompt_id, true, None);
    }
    fn auth_prompt(&self, prompt_id: &str, prompt: &AuthPromptInfo) {
        self.prompts.lock().push(prompt.kind);
        let values: Option<Vec<Zeroizing<String>>> = match prompt.kind {
            AuthPromptKind::Password => self.password.clone().map(|p| vec![Zeroizing::new(p)]),
            _ => Some(self.answers.iter().map(|a| Zeroizing::new(a.clone())).collect()),
        };
        self.control.answer_auth(prompt_id, values);
    }
    fn auth_method(&self, method: &str) {
        self.methods.lock().push(method.to_string());
    }
}

fn request(port: u16, user: &str) -> LoginRequest {
    LoginRequest {
        host: "127.0.0.1".into(),
        port,
        username: user.into(),
        private_key: None,
        passphrase: None,
        password: None,
        allow_password_prompt: false,
        debug: false,
    }
}

async fn run(req: LoginRequest, events: &Arc<Auto>) -> Result<LoginHandle, SshErrorCode> {
    login(req, LOGIN_TIMERS, events.clone(), events.control.clone()).await
}

async fn exec(handle: &LoginHandle, command: &str) -> (String, Option<u32>) {
    let mut ch = handle.channel_open_session().await.unwrap();
    ch.exec(true, command).await.unwrap();
    let (mut out, mut status) = (Vec::new(), None);
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            _ => {}
        }
    }
    (String::from_utf8_lossy(&out).into_owned(), status)
}

fn echo() -> ExecHandler {
    Arc::new(|cmd: &str| ExecOutput {
        stdout: cmd.strip_prefix("echo ").map(|s| format!("{s}\n")).unwrap_or_default().into_bytes(),
        stderr: Vec::new(),
        status: if cmd.starts_with("echo ") { 0 } else { 127 },
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_password_logs_in_and_the_host_key_is_the_servers() {
    let server = TestServer::start(TestServerConfig {
        users: vec![TestUser::new("u").password("pw")],
        exec: Some(echo()),
        banner: Some("Welcome\x1b[31m!\n".into()),
        ..TestServerConfig::default()
    })
    .await
    .unwrap();
    let events = Auto::new(LoginControl::new(), None, &[]);
    let mut req = request(server.port(), "u");
    req.password = Some(Zeroizing::new("pw".into()));
    let handle = run(req, &events).await.expect("login");
    assert_eq!(events.host_key.lock().as_deref(), Some(server.host_keys_base64()[0].as_str()));
    assert_eq!(server.attempts(), ["password:u", "password:u:ok"]);
    assert_eq!(*events.methods.lock(), ["password"]);
    assert!(events.banner.lock().as_deref().is_some_and(|b| b.starts_with("Welcome") && !b.contains('\x1b')));
    assert_eq!(exec(&handle, "echo sp7-ok").await, ("sp7-ok\n".to_string(), Some(0)));
    assert_eq!(server.execs(), ["echo sp7-ok"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn publickey_logs_in_with_a_generated_key_of_every_type() {
    for (key_type, bits) in [(KeyType::Ed25519, None), (KeyType::Ecdsa, Some(384)), (KeyType::Rsa, Some(2048))] {
        let key = generate_key_blocking(&KeyGenRequest { key_type, bits, comment: "t@x".into(), passphrase: None }).unwrap();
        let server = TestServer::start(TestServerConfig {
            users: vec![TestUser::new("k").key_line(&key.meta.public_key)],
            ..TestServerConfig::default()
        })
        .await
        .unwrap();
        let events = Auto::new(LoginControl::new(), None, &[]);
        let mut req = request(server.port(), "k");
        req.private_key = Some(key.private_key.clone());
        run(req, &events).await.unwrap_or_else(|e| panic!("{key_type:?}: {e:?}"));
        assert_eq!(server.attempts().last().map(String::as_str), Some("publickey:k:ok"), "{key_type:?}");
        assert_eq!(*events.methods.lock(), ["publickey"]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn keyboard_interactive_asks_after_an_empty_info_request() {
    let kbd = Keyboard {
        name: "PAM".into(),
        instructions: String::new(),
        prompts: vec![("Password: ".into(), false)],
        answers: vec!["kbd-pw".into()],
        empty_first: true,
    };
    let server = TestServer::start(TestServerConfig {
        users: vec![TestUser::new("kbd").keyboard(kbd)],
        methods: vec![MethodKind::KeyboardInteractive],
        ..TestServerConfig::default()
    })
    .await
    .unwrap();
    let events = Auto::new(LoginControl::new(), None, &["kbd-pw"]);
    run(request(server.port(), "kbd"), &events).await.expect("login");
    assert_eq!(server.attempts(), ["none:kbd", "keyboard-interactive:kbd", "keyboard-interactive:kbd:ok"]);
    assert_eq!(*events.methods.lock(), ["none", "keyboard-interactive"]);
    // The empty request was answered without a prompt: one question reached the user.
    assert_eq!(*events.prompts.lock(), [AuthPromptKind::Keyboard]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_saved_password_goes_on_like_ssh_login_and_ends_with_auth() {
    let kbd = Keyboard { prompts: vec![("Password: ".into(), false)], answers: vec!["right".into()], ..Keyboard::default() };
    let server = TestServer::start(TestServerConfig {
        users: vec![TestUser::new("u").password("right").keyboard(kbd)],
        ..TestServerConfig::default()
    })
    .await
    .unwrap();
    let events = Auto::new(LoginControl::new(), Some("still-wrong"), &["nope"]);
    let mut req = request(server.port(), "u");
    req.password = Some(Zeroizing::new("wrong".into()));
    req.allow_password_prompt = true;
    let r = run(req, &events).await;
    assert_eq!(r.err(), Some(SshErrorCode::Auth));
    assert_eq!(
        *events.methods.lock(),
        [
            "password",
            "password",
            "password",
            "password",
            "keyboard-interactive",
            "keyboard-interactive",
            "keyboard-interactive",
            "false"
        ]
    );
    assert_eq!(server.attempts().iter().filter(|a| a.ends_with(":ok")).count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_password_prompt_is_answered_once_the_server_names_password() {
    let server = TestServer::start(TestServerConfig {
        users: vec![TestUser::new("u").password("pw")],
        methods: vec![MethodKind::Password],
        ..TestServerConfig::default()
    })
    .await
    .unwrap();
    let events = Auto::new(LoginControl::new(), Some("pw"), &[]);
    let mut req = request(server.port(), "u");
    req.allow_password_prompt = true;
    run(req, &events).await.expect("login");
    assert_eq!(*events.methods.lock(), ["none", "password"]);
    assert_eq!(*events.prompts.lock(), [AuthPromptKind::Password]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_host_key_ends_the_login_with_the_reason_main_gave() {
    struct Refuse(Arc<LoginControl>);
    impl LoginEvents for Refuse {
        fn phase(&self, _: SshPhase) {}
        fn banner(&self, _: &str) {}
        fn host_key(&self, prompt_id: &str, _: &str) {
            self.0.answer_host_key(prompt_id, false, Some(SshErrorCode::HostKeyChanged));
        }
        fn auth_prompt(&self, _: &str, _: &AuthPromptInfo) {}
    }
    let server = TestServer::start(TestServerConfig { users: vec![TestUser::new("u").password("pw")], ..Default::default() })
        .await
        .unwrap();
    let control = LoginControl::new();
    let r = login(request(server.port(), "u"), LOGIN_TIMERS, Arc::new(Refuse(control.clone())), control).await;
    assert_eq!(r.err(), Some(SshErrorCode::HostKeyChanged));
    assert!(server.attempts().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn every_host_key_type_is_shown_as_its_blob() {
    for alg in ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp521", "ssh-rsa"] {
        let server = TestServer::start(TestServerConfig {
            users: vec![TestUser::new("u").password("pw")],
            host_keys: vec![host_key(alg)],
            ..TestServerConfig::default()
        })
        .await
        .unwrap();
        let events = Auto::new(LoginControl::new(), None, &[]);
        let mut req = request(server.port(), "u");
        req.password = Some(Zeroizing::new("pw".into()));
        run(req, &events).await.unwrap_or_else(|e| panic!("{alg}: {e:?}"));
        let shown = events.host_key.lock().clone().unwrap();
        assert_eq!(shown, server.host_keys_base64()[0], "{alg}");
        assert_eq!(crate::keys::key_type_of_blob(&STANDARD.decode(&shown).unwrap()).as_deref(), Some(alg));
    }
}

/// A minimal SFTP client step: send one packet, read one answer.
async fn sftp_call(stream: &mut russh::ChannelStream<russh::client::Msg>, kind: u8, body: &[u8]) -> (u8, Vec<u8>) {
    stream.write_all(&sftp::packet(kind, body)).await.unwrap();
    sftp::read_packet(stream).await.expect("sftp answer")
}

#[tokio::test(flavor = "multi_thread")]
async fn sftp_serves_the_folder_as_root() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("hello.txt"), b"hi").unwrap();
    let server = TestServer::start(TestServerConfig {
        users: vec![TestUser::new("u").password("pw")],
        sftp_root: Some(dir.path().to_path_buf()),
        ..TestServerConfig::default()
    })
    .await
    .unwrap();
    let events = Auto::new(LoginControl::new(), None, &[]);
    let mut req = request(server.port(), "u");
    req.password = Some(Zeroizing::new("pw".into()));
    let handle = run(req, &events).await.expect("login");
    let ch = handle.channel_open_session().await.unwrap();
    ch.request_subsystem(true, "sftp").await.unwrap();
    let mut s = ch.into_stream();
    let mut init = Vec::new();
    put_u32(&mut init, 3);
    let (kind, body) = sftp_call(&mut s, FXP_INIT, &init).await;
    assert_eq!((kind, &body[..]), (FXP_VERSION, &[0, 0, 0, 3][..]));
    // realpath "..": still the root.
    let mut rp = Vec::new();
    put_u32(&mut rp, 1);
    put_bytes(&mut rp, b"..");
    let (kind, body) = sftp_call(&mut s, sftp::FXP_REALPATH, &rp).await;
    assert_eq!(kind, FXP_NAME);
    assert_eq!(&body[8..8 + 4 + 1], &[0, 0, 0, 1, b'/']);
    // open + write + close a new file.
    let mut open = Vec::new();
    put_u32(&mut open, 2);
    put_bytes(&mut open, b"/new.txt");
    put_u32(&mut open, 0x2 | 0x8 | 0x10);
    put_u32(&mut open, 0);
    let (kind, body) = sftp_call(&mut s, FXP_OPEN, &open).await;
    assert_eq!(kind, sftp::FXP_HANDLE);
    let handle_id = body[8..].to_vec();
    let mut write = Vec::new();
    put_u32(&mut write, 3);
    put_bytes(&mut write, &handle_id);
    write.extend_from_slice(&0u64.to_be_bytes());
    put_bytes(&mut write, b"data");
    let (kind, body) = sftp_call(&mut s, FXP_WRITE, &write).await;
    assert_eq!((kind, &body[4..8]), (FXP_STATUS, &[0, 0, 0, 0][..]));
    let mut close = Vec::new();
    put_u32(&mut close, 4);
    put_bytes(&mut close, &handle_id);
    sftp_call(&mut s, sftp::FXP_CLOSE, &close).await;
    assert_eq!(std::fs::read(dir.path().join("new.txt")).unwrap(), b"data");
    // A missing file: NO_SUCH_FILE.
    let mut stat = Vec::new();
    put_u32(&mut stat, 5);
    put_bytes(&mut stat, b"/missing");
    let (kind, body) = sftp_call(&mut s, sftp::FXP_STAT, &stat).await;
    assert_eq!((kind, &body[4..8]), (FXP_STATUS, &[0, 0, 0, 2][..]));
    let _ = s.shutdown().await;
    let mut rest = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(1), s.read_to_end(&mut rest)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn direct_tcpip_reaches_only_loopback_targets() {
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = target.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut s, _) = target.accept().await.unwrap();
        let mut buf = [0u8; 4];
        s.read_exact(&mut buf).await.unwrap();
        s.write_all(&buf).await.unwrap();
    });
    let server = TestServer::start(TestServerConfig {
        users: vec![TestUser::new("u").password("pw")],
        forwarding: true,
        ..TestServerConfig::default()
    })
    .await
    .unwrap();
    let events = Auto::new(LoginControl::new(), None, &[]);
    let mut req = request(server.port(), "u");
    req.password = Some(Zeroizing::new("pw".into()));
    let handle = run(req, &events).await.expect("login");
    assert!(handle.channel_open_direct_tcpip("example.com", 80, "127.0.0.1", 0).await.is_err());
    let ch = handle.channel_open_direct_tcpip("127.0.0.1", port as u32, "127.0.0.1", 0).await.unwrap();
    let mut s = ch.into_stream();
    s.write_all(b"ping").await.unwrap();
    let mut back = [0u8; 4];
    s.read_exact(&mut back).await.unwrap();
    assert_eq!(&back, b"ping");
}
