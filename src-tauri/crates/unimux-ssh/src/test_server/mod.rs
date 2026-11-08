//! S4: an in-process russh SSH server for tests (feature `test-server`, always on in this crate's own tests). It listens on
//! 127.0.0.1 on a free port and offers what the login core and the owners (P5 cells, T1 SFTP, D2 tunnels) need:
//!
//! - `password`, `publickey` (authorized public keys per user) and `keyboard-interactive` (fixed prompts and answers, an
//!   optional empty info request first, like some PAM setups send), with every attempt logged in order;
//! - an auth banner;
//! - `exec` through a handler closure (stdout, stderr, exit status);
//! - a `shell` that echoes what it gets (with `pty-req` and `window-change` accepted);
//! - the `sftp` subsystem over a folder ([`sftp`], SFTP v3, the folder is `/`);
//! - `direct-tcpip` to 127.0.0.1 targets only (the DB tunnels).
//!
//! Nothing here is meant for production: the server accepts only loopback connections, keeps every user in memory and
//! never touches the user's files outside the folder a test gives it.

pub mod sftp;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use parking_lot::Mutex;
use rand_core::UnwrapErr;
use russh::keys::ssh_key::{Algorithm, EcdsaCurve, PrivateKey, PublicKey};
use russh::server::{Auth, ChannelOpenHandle, Config, Handler, Msg, PublicKeyOffer, Response, Session, VerifiedPublicKey};
use russh::{Channel, ChannelId, ChannelMsg, MethodKind, MethodSet};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// What an `exec` request answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: u32,
}

/// Runs an `exec` command (the command text as the client sent it).
pub type ExecHandler = Arc<dyn Fn(&str) -> ExecOutput + Send + Sync>;

/// Keyboard-interactive for one user: the prompts `(text, echo)` and the answers that pass.
#[derive(Debug, Clone, Default)]
pub struct Keyboard {
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<(String, bool)>,
    pub answers: Vec<String>,
    /// Send an info request without prompts first (the login core answers it without asking the user).
    pub empty_first: bool,
}

/// One account.
#[derive(Debug, Clone, Default)]
pub struct TestUser {
    pub name: String,
    pub password: Option<String>,
    pub keys: Vec<PublicKey>,
    pub keyboard: Option<Keyboard>,
}

impl TestUser {
    pub fn new(name: &str) -> TestUser {
        TestUser { name: name.to_string(), ..TestUser::default() }
    }

    pub fn password(mut self, password: &str) -> TestUser {
        self.password = Some(password.to_string());
        self
    }

    /// Authorizes a public key given as an OpenSSH line (`ssh-ed25519 AAAA... comment`).
    pub fn key_line(mut self, line: &str) -> TestUser {
        if let Ok(key) = PublicKey::from_openssh(line.trim()) {
            self.keys.push(key);
        }
        self
    }

    pub fn keyboard(mut self, keyboard: Keyboard) -> TestUser {
        self.keyboard = Some(keyboard);
        self
    }
}

/// The server's setup.
#[derive(Clone)]
pub struct TestServerConfig {
    pub users: Vec<TestUser>,
    /// The host keys (the client's preference picks one). Default: one new ed25519 key.
    pub host_keys: Vec<PrivateKey>,
    /// The methods named in a USERAUTH_FAILURE (default: publickey, password, keyboard-interactive).
    pub methods: Vec<MethodKind>,
    pub banner: Option<String>,
    pub exec: Option<ExecHandler>,
    /// The folder the `sftp` subsystem serves as `/`; None refuses the subsystem.
    pub sftp_root: Option<PathBuf>,
    /// Runs an `exec` request with what the client wrote to it (called at the client's EOF; `exec sh -s` with the script
    /// on stdin, like the SSH status bar and path completion send it). Takes precedence over `exec`.
    pub exec_stdin: Option<ExecStdinHandler>,
    /// Accept `shell` requests with an echo shell.
    pub shell: bool,
    /// With `shell`: the scripted shell of 1.1.4's test/helpers/sshServer.ts instead of the plain echo ([`ShellLog`] lists
    /// the commands it knows).
    pub scripted_shell: bool,
    /// With `scripted_shell`: after `exit` the server drops the connection (a reset instead of a clean close).
    pub reset_on_exit: bool,
    /// Accept `direct-tcpip` channels to 127.0.0.1.
    pub forwarding: bool,
    /// The server's own algorithm lists (default: russh's).
    pub preferred: russh::Preferred,
}

/// Runs an `exec` command with its stdin (the command text, the bytes the client sent before EOF).
pub type ExecStdinHandler = Arc<dyn Fn(&str, &[u8]) -> ExecOutput + Send + Sync>;

/// What the scripted shell saw. It greets with `Welcome\r\n$ `, echoes every byte and runs these lines: `exit` (exit status
/// 3, then close), `tail <n>` (n bytes, `TAIL-END`, exit status 0, close), `flood <n>` (n bytes, counted in
/// `flood_sent`), `split` (`zażółć 🙂` in three packets cut inside characters) and `echo <text>`.
#[derive(Debug, Clone, Default)]
pub struct ShellLog {
    /// `pty-req`: (term, cols, rows).
    pub ptys: Vec<(String, u32, u32)>,
    /// `window-change`: (cols, rows).
    pub window_changes: Vec<(u32, u32)>,
    /// Every byte the shells got.
    pub input: Vec<u8>,
    /// Bytes `flood` has written so far.
    pub flood_sent: usize,
}

impl Default for TestServerConfig {
    fn default() -> Self {
        TestServerConfig {
            users: Vec::new(),
            host_keys: Vec::new(),
            methods: vec![MethodKind::PublicKey, MethodKind::Password, MethodKind::KeyboardInteractive],
            banner: None,
            exec: None,
            sftp_root: None,
            exec_stdin: None,
            shell: false,
            scripted_shell: false,
            reset_on_exit: false,
            forwarding: false,
            preferred: russh::Preferred::default(),
        }
    }
}

/// A new host key of a type 1.1.4 accepts.
pub fn host_key(algorithm: &str) -> PrivateKey {
    let mut rng = UnwrapErr(getrandom::SysRng);
    let algorithm = match algorithm {
        "ecdsa-sha2-nistp256" => Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
        "ecdsa-sha2-nistp384" => Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
        "ecdsa-sha2-nistp521" => Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 },
        "ssh-rsa" => {
            let pair = russh::keys::ssh_key::private::RsaKeypair::random(&mut rng, 2048).expect("rsa host key");
            return PrivateKey::new(pair.into(), "").expect("rsa host key");
        }
        _ => Algorithm::Ed25519,
    };
    PrivateKey::random(&mut rng, algorithm).expect("host key")
}

/// One attempt as the server saw it: `<method>:<user>` (`none`, `password`, `publickey`, `keyboard-interactive`), plus
/// `<method>:<user>:ok` for the one that passed.
pub type AttemptLog = Arc<Mutex<Vec<String>>>;

/// A running server; stops when dropped.
pub struct TestServer {
    addr: SocketAddr,
    host_keys: Vec<String>,
    attempts: AttemptLog,
    exec_log: Arc<Mutex<Vec<String>>>,
    shell_log: Arc<Mutex<ShellLog>>,
    connections: Arc<std::sync::atomic::AtomicUsize>,
    conn_tasks: Arc<Mutex<Vec<tokio::task::AbortHandle>>>,
    shared: Arc<Shared>,
    task: JoinHandle<()>,
}

/// Counts a connection while its task runs (also when the task is aborted).
struct ConnCount(Arc<std::sync::atomic::AtomicUsize>);

impl Drop for ConnCount {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// One `direct-tcpip` request as the server saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Forward {
    pub host: String,
    pub port: u32,
    pub accepted: bool,
}

impl TestServer {
    /// Binds 127.0.0.1:0 and serves every connection on its own task.
    pub async fn start(mut config: TestServerConfig) -> std::io::Result<TestServer> {
        if config.host_keys.is_empty() {
            config.host_keys.push(host_key("ssh-ed25519"));
        }
        let host_keys =
            config.host_keys.iter().filter_map(|k| k.public_key().to_bytes().ok()).map(|b| STANDARD.encode(b)).collect();
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let russh_config = Arc::new(Config {
            server_id: russh::SshId::Standard("SSH-2.0-unimux_test_server".into()),
            methods: MethodSet::from(&config.methods[..]),
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            keys: config.host_keys.clone(),
            preferred: config.preferred.clone(),
            inactivity_timeout: Some(Duration::from_secs(120)),
            max_auth_attempts: 100,
            nodelay: true,
            ..Config::default()
        });
        let attempts: AttemptLog = Arc::new(Mutex::new(Vec::new()));
        let exec_log = Arc::new(Mutex::new(Vec::new()));
        let shell_log = Arc::new(Mutex::new(ShellLog::default()));
        let connections = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let conn_tasks = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::new(Shared {
            config,
            attempts: attempts.clone(),
            exec_log: exec_log.clone(),
            shell_log: shell_log.clone(),
            conn_tasks: conn_tasks.clone(),
            forwards: Mutex::new(Vec::new()),
        });
        let server_shared = shared.clone();
        let count = connections.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, peer)) = listener.accept().await {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let handler = Conn { shared: shared.clone(), channels: HashMap::new(), keyboard_round: 0 };
                let cfg = russh_config.clone();
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let guard = ConnCount(count.clone());
                // The session runs on one end of a pipe and a pump copies the socket to the other: aborting the pump
                // drops the socket without a disconnect message (`drop_connections`).
                let _ = socket.set_nodelay(true);
                let (inner, mut outer) = tokio::io::duplex(64 * 1024);
                let pump = tokio::spawn(async move {
                    let mut socket = socket;
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut outer).await;
                });
                shared.conn_tasks.lock().push(pump.abort_handle());
                tokio::spawn(async move {
                    let _guard = guard;
                    if let Ok(session) = russh::server::run_stream(cfg, inner, handler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        Ok(TestServer { addr, host_keys, attempts, exec_log, shell_log, connections, conn_tasks, shared: server_shared, task })
    }

    /// What the shells saw so far.
    pub fn shell_log(&self) -> ShellLog {
        self.shell_log.lock().clone()
    }

    /// The connections open right now.
    pub fn connections(&self) -> usize {
        self.connections.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Drops every connection without a disconnect message (a network failure as the client sees it).
    pub fn drop_connections(&self) {
        for t in self.conn_tasks.lock().drain(..) {
            t.abort();
        }
    }

    /// Every `direct-tcpip` request so far: the target and whether it was accepted.
    pub fn forwards(&self) -> Vec<Forward> {
        self.shared.forwards.lock().clone()
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The base64 blobs of the host keys (what the client's host key question shows, and known_hosts.json stores).
    pub fn host_keys_base64(&self) -> &[String] {
        &self.host_keys
    }

    /// The authentication attempts so far, in order.
    pub fn attempts(&self) -> Vec<String> {
        self.attempts.lock().clone()
    }

    /// The exec commands so far.
    pub fn execs(&self) -> Vec<String> {
        self.exec_log.lock().clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
        self.drop_connections();
    }
}

struct Shared {
    config: TestServerConfig,
    attempts: AttemptLog,
    exec_log: Arc<Mutex<Vec<String>>>,
    shell_log: Arc<Mutex<ShellLog>>,
    conn_tasks: Arc<Mutex<Vec<tokio::task::AbortHandle>>>,
    forwards: Mutex<Vec<Forward>>,
}

/// The scripted shell (see [`ShellLog`]).
async fn scripted_shell(mut ch: Channel<Msg>, shared: Arc<Shared>) {
    const CHUNK: usize = 32 * 1024;
    let _ = ch.data_bytes(b"Welcome\r\n$ ".to_vec()).await;
    let mut line = Vec::new();
    while let Some(msg) = ch.wait().await {
        let data = match msg {
            ChannelMsg::Data { data } => data,
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => continue,
        };
        shared.shell_log.lock().input.extend_from_slice(&data);
        for &b in data.iter() {
            if b != b'\r' {
                line.push(b);
                let _ = ch.data_bytes(vec![b]).await;
                continue;
            }
            let cmd = String::from_utf8_lossy(&line).trim().to_string();
            line.clear();
            let _ = ch.data_bytes(b"\r\n".to_vec()).await;
            let (word, arg) = cmd.split_once(' ').unwrap_or((cmd.as_str(), ""));
            let size = arg.parse::<usize>().unwrap_or(0);
            match word {
                "exit" => {
                    let _ = ch.exit_status(3).await;
                    let _ = ch.eof().await;
                    let _ = ch.close().await;
                    if shared.config.reset_on_exit {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        for t in shared.conn_tasks.lock().drain(..) {
                            t.abort();
                        }
                    }
                    return;
                }
                "tail" => {
                    let mut left = size;
                    while left > 0 {
                        let n = left.min(CHUNK);
                        if ch.data_bytes(vec![b'x'; n]).await.is_err() {
                            return;
                        }
                        left -= n;
                    }
                    let _ = ch.data_bytes(b"TAIL-END\r\n".to_vec()).await;
                    let _ = ch.exit_status(0).await;
                    let _ = ch.eof().await;
                    let _ = ch.close().await;
                    return;
                }
                "flood" => {
                    let mut left = size;
                    while left > 0 {
                        let n = left.min(CHUNK);
                        if ch.data_bytes(vec![b'x'; n]).await.is_err() {
                            return;
                        }
                        shared.shell_log.lock().flood_sent += n;
                        left -= n;
                    }
                }
                "split" => {
                    let bytes = "zażółć 🙂".as_bytes();
                    for part in [&bytes[..3], &bytes[3..12], &bytes[12..]] {
                        let _ = ch.data_bytes(part.to_vec()).await;
                        tokio::time::sleep(Duration::from_millis(30)).await;
                    }
                    let _ = ch.data_bytes(b"\r\n".to_vec()).await;
                }
                "echo" => {
                    let _ = ch.data_bytes(format!("{arg}\r\n").into_bytes()).await;
                }
                _ => {}
            }
            let _ = ch.data_bytes(b"$ ".to_vec()).await;
        }
    }
}

impl Shared {
    fn user(&self, name: &str) -> Option<&TestUser> {
        self.config.users.iter().find(|u| u.name == name)
    }

    fn log(&self, entry: String) {
        self.attempts.lock().push(entry);
    }
}

struct Conn {
    shared: Arc<Shared>,
    channels: HashMap<ChannelId, Channel<Msg>>,
    keyboard_round: u32,
}

impl Conn {
    /// A refusal that names the configured methods again, like OpenSSH (russh would drop the refused method from the list).
    fn reject(&self) -> Auth {
        Auth::Reject { proceed_with_methods: Some(MethodSet::from(&self.shared.config.methods[..])), partial_success: false }
    }
}

fn same_key(a: &PublicKey, b: &PublicKey) -> bool {
    a.key_data() == b.key_data()
}

impl Handler for Conn {
    type Error = russh::Error;

    async fn auth_none(&mut self, user: &str) -> Result<Auth, Self::Error> {
        self.shared.log(format!("none:{user}"));
        Ok(self.reject())
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.shared.log(format!("password:{user}"));
        let ok = self.shared.user(user).and_then(|u| u.password.as_deref()) == Some(password);
        if ok {
            self.shared.log(format!("password:{user}:ok"));
            return Ok(Auth::Accept);
        }
        Ok(self.reject())
    }

    async fn auth_publickey_offered(&mut self, user: &str, offer: PublicKeyOffer<'_>) -> Result<Auth, Self::Error> {
        let known = self.shared.user(user).is_some_and(|u| u.keys.iter().any(|k| same_key(k, offer.public_key)));
        if known {
            return Ok(Auth::Accept);
        }
        self.shared.log(format!("publickey:{user}"));
        Ok(self.reject())
    }

    async fn auth_publickey(&mut self, user: &str, key: VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
        self.shared.log(format!("publickey:{user}"));
        let known = self.shared.user(user).is_some_and(|u| u.keys.iter().any(|k| same_key(k, key.public_key)));
        if known {
            self.shared.log(format!("publickey:{user}:ok"));
            return Ok(Auth::Accept);
        }
        Ok(self.reject())
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        let Some(kbd) = self.shared.user(user).and_then(|u| u.keyboard.clone()) else {
            self.shared.log(format!("keyboard-interactive:{user}"));
            return Ok(self.reject());
        };
        let partial = |prompts: Vec<(String, bool)>| Auth::Partial {
            name: kbd.name.clone().into(),
            instructions: kbd.instructions.clone().into(),
            prompts: prompts.into_iter().map(|(p, e)| (p.into(), e)).collect::<Vec<_>>().into(),
        };
        match response {
            None => {
                self.shared.log(format!("keyboard-interactive:{user}"));
                self.keyboard_round = 0;
                if kbd.empty_first {
                    self.keyboard_round = 1;
                    return Ok(partial(Vec::new()));
                }
                self.keyboard_round = 2;
                Ok(partial(kbd.prompts.clone()))
            }
            Some(answers) => {
                if self.keyboard_round == 1 {
                    self.keyboard_round = 2;
                    return Ok(partial(kbd.prompts.clone()));
                }
                let given: Vec<String> = answers.map(|b| String::from_utf8_lossy(&b).into_owned()).collect();
                if given == kbd.answers {
                    self.shared.log(format!("keyboard-interactive:{user}:ok"));
                    Ok(Auth::Accept)
                } else {
                    Ok(self.reject())
                }
            }
        }
    }

    async fn authentication_banner(&mut self) -> Result<Option<String>, Self::Error> {
        Ok(self.shared.config.banner.clone())
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let loopback = matches!(host_to_connect, "127.0.0.1" | "localhost" | "::1");
        let log = |accepted: bool| {
            let forward = Forward { host: host_to_connect.to_string(), port: port_to_connect, accepted };
            self.shared.forwards.lock().push(forward);
        };
        let Ok(port) = u16::try_from(port_to_connect) else {
            log(false);
            return Ok(());
        };
        if !self.shared.config.forwarding || !loopback {
            log(false);
            return Ok(());
        }
        let Ok(mut target) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await else {
            log(false);
            return Ok(());
        };
        log(true);
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut target).await;
        });
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shared.shell_log.lock().ptys.push((term.to_string(), col_width, row_height));
        session.channel_success(channel)
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shared.shell_log.lock().window_changes.push((col_width, row_height));
        session.channel_success(channel)
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        let Some(ch) = self.channels.remove(&channel).filter(|_| self.shared.config.shell) else {
            return session.channel_failure(channel);
        };
        session.channel_success(channel)?;
        if self.shared.config.scripted_shell {
            tokio::spawn(scripted_shell(ch, self.shared.clone()));
            return Ok(());
        }
        tokio::spawn(async move {
            let mut stream = ch.into_stream();
            let mut buf = [0u8; 4096];
            while let Ok(n) = stream.read(&mut buf).await {
                if n == 0 || stream.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
        });
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        if let Some(handler) = self.shared.config.exec_stdin.clone() {
            let Some(mut ch) = self.channels.remove(&channel) else { return session.channel_failure(channel) };
            session.channel_success(channel)?;
            let command = String::from_utf8_lossy(data).into_owned();
            self.shared.exec_log.lock().push(command.clone());
            tokio::spawn(async move {
                let mut input = Vec::new();
                while let Some(msg) = ch.wait().await {
                    match msg {
                        ChannelMsg::Data { data } => input.extend_from_slice(&data),
                        ChannelMsg::Eof | ChannelMsg::Close => break,
                        _ => {}
                    }
                }
                let out = handler(&command, &input);
                if !out.stdout.is_empty() {
                    let _ = ch.data_bytes(out.stdout).await;
                }
                if !out.stderr.is_empty() {
                    let _ = ch.extended_data_bytes(1, out.stderr).await;
                }
                let _ = ch.exit_status(out.status).await;
                let _ = ch.eof().await;
                let _ = ch.close().await;
            });
            return Ok(());
        }
        let (Some(ch), Some(exec)) = (self.channels.remove(&channel), self.shared.config.exec.clone()) else {
            return session.channel_failure(channel);
        };
        session.channel_success(channel)?;
        let command = String::from_utf8_lossy(data).into_owned();
        self.shared.exec_log.lock().push(command.clone());
        tokio::spawn(async move {
            let out = exec(&command);
            if !out.stdout.is_empty() {
                let _ = ch.data_bytes(out.stdout).await;
            }
            if !out.stderr.is_empty() {
                let _ = ch.extended_data_bytes(1, out.stderr).await;
            }
            let _ = ch.exit_status(out.status).await;
            let _ = ch.eof().await;
            let _ = ch.close().await;
        });
        Ok(())
    }

    async fn subsystem_request(&mut self, channel: ChannelId, name: &str, session: &mut Session) -> Result<(), Self::Error> {
        let root = self.shared.config.sftp_root.clone().filter(|_| name == "sftp");
        let (Some(ch), Some(root)) = (self.channels.remove(&channel), root) else {
            return session.channel_failure(channel);
        };
        session.channel_success(channel)?;
        tokio::spawn(async move {
            let _ = sftp::serve(ch.into_stream(), root).await;
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests;
