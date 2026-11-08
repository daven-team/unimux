//! SFTP through sudo (T5, port of 1.1.4 src/sftphost/sudo.ts, src/sftphost/execSftp.ts and `startSudo` / `execSftp` of
//! src/sftphost/host.ts): which server commands are tried, how a password is passed, what sudo's messages mean, and the
//! SFTP client on an exec channel whose stdout and stderr are kept apart.
//!
//! The command is the user's own (the host editor, `sftpCommand`) or `sudo -n <sftp-server>` for the usual places. It only
//! ever runs on the user's own exec channel on their server; nothing here reaches a local shell. The password is written to
//! the channel's stdin only after sudo printed the fixed prompt marker (`-p`), never into sftp-server's input, and a second
//! marker means a wrong password whatever language sudo speaks.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures::future::BoxFuture;
use regex::Regex;
use russh::client::Msg;
use russh::{ChannelMsg, ChannelWriteHalf};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio::time::Instant;
use unimux_ssh::login::LoginHandle;
use unimux_ssh::session::SshErrorCode;
use zeroize::Zeroizing;

use crate::backend::SftpSession;
use crate::client::{ClientError, SftpClient};
use crate::host::{RemoteSession, SftpStream, SudoStart};
use crate::remote::RemoteSide;

/// Where distributions put OpenSSH's sftp-server (Debian/Ubuntu, RHEL/Fedora/SUSE, Arch).
pub const DEFAULT_SFTP_SERVERS: [&str; 3] =
    ["/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server", "/usr/lib/ssh/sftp-server"];

/// `sudoCommands`: the host's own command, else `sudo -n <server>` for each default place.
pub fn sudo_commands(custom: Option<&str>) -> Vec<String> {
    match custom.map(str::trim).filter(|c| !c.is_empty()) {
        Some(own) => vec![own.to_string()],
        None => DEFAULT_SFTP_SERVERS.iter().map(|p| format!("sudo -n {p}")).collect(),
    }
}

/// The prompt sudo prints when it reads the password (`-p`).
pub const SUDO_MARKER: &str = "[unimux-sudo-password]";

/// The environment of the exec channel: sudo's messages in English where the server accepts it (AcceptEnv LANG LC_*).
/// Same order as 1.1.4's `{ LC_ALL: 'C', LANG: 'C' }`.
pub const SUDO_ENV: [(&str, &str); 2] = [("LC_ALL", "C"), ("LANG", "C")];

/// JS `.` (any character but a line end).
static PASSWORD_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^sudo\s+-n\s+(\S[^\n\r\u{2028}\u{2029}]*)$").expect("sudo regex"));

/// `passwordCommand`: `sudo -n <rest>` -> `sudo -S -p '<marker>' <rest>` (sudo reads the password as the first line of
/// stdin, the SFTP stream follows on the same stdin). None for a command of another form (it cannot be given a password).
pub fn password_command(command: &str) -> Option<String> {
    let c = PASSWORD_COMMAND.captures(command.trim())?;
    Some(format!("sudo -S -p '{SUDO_MARKER}' {}", &c[1]))
}

/// `validSudoPassword`: a password that can be written as one stdin line (length in UTF-16 units like 1.1.4).
pub fn valid_sudo_password(pw: &str) -> bool {
    let len = pw.encode_utf16().count();
    len > 0 && len <= 1024 && !pw.contains(['\r', '\n', '\0'])
}

/// `markerCount`: how many password prompts sudo has printed so far.
pub fn marker_count(stderr: &str) -> usize {
    stderr.matches(SUDO_MARKER).count()
}

/// What sudo said (`SudoOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SudoOutcome {
    Password,
    WrongPassword,
    Tty,
    Denied,
    NotFound,
    NoSudo,
    Other,
}

/// Why one exec start did not give an SFTP session: what sudo said, or nothing conclusive within the SFTP timer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecFail {
    Sudo(SudoOutcome),
    Timeout,
}

static NO_SUDO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|\n|: )sudo: (command )?not found|sudo: nie znaleziono polecenia|nie znaleziono polecenia: sudo").expect("re")
});
static DENIED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"not allowed to execute|not in the sudoers|may not run sudo|is not allowed to run sudo|nie ma uprawnień|nie występuje w pliku sudoers|nie może uruchamiać",
    )
    .expect("re")
});
static TTY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"must have a tty|requiretty|musisz mieć terminal|wymaga terminala").expect("re"));
static WRONG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"incorrect password|try again|authentication failure|spróbuj ponownie|nieprawidłow").expect("re")
});
static PASSWORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"password is required|no tty present|terminal is required|askpass|wymagane jest hasło|hasło jest wymagane")
        .expect("re")
});
static NOT_FOUND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"command not found|no such file or directory|not found|nie znaleziono|nie ma takiego pliku").expect("re")
});

/// `classifySudo`: what sudo's stderr (and the exit code, once it ended) says; None while nothing conclusive came yet.
/// English (the exec channel asks for LC_ALL=C) and Polish texts are known; `non_interactive` (a `sudo -n` run): an unknown
/// message with exit status 1 is read as "a password is required", the usual reason sudo -n fails that way.
pub fn classify_sudo(stderr: &str, exit_code: Option<i64>, non_interactive: bool) -> Option<SudoOutcome> {
    let t = stderr.split(SUDO_MARKER).collect::<Vec<_>>().join(" ").to_lowercase();
    if NO_SUDO.is_match(&t) {
        return Some(SudoOutcome::NoSudo);
    }
    if DENIED.is_match(&t) {
        return Some(SudoOutcome::Denied);
    }
    if TTY.is_match(&t) {
        return Some(SudoOutcome::Tty);
    }
    if WRONG.is_match(&t) {
        return Some(SudoOutcome::WrongPassword);
    }
    if PASSWORD.is_match(&t) {
        return Some(SudoOutcome::Password);
    }
    if NOT_FOUND.is_match(&t) || exit_code == Some(127) {
        return Some(SudoOutcome::NotFound);
    }
    let code = exit_code?;
    Some(if non_interactive && code == 1 { SudoOutcome::Password } else { SudoOutcome::Other })
}

/// `sudoError`: the session error a failed sudo start ends with.
pub fn sudo_error(fail: ExecFail) -> SshErrorCode {
    match fail {
        ExecFail::Sudo(SudoOutcome::WrongPassword) => SshErrorCode::SudoPassword,
        ExecFail::Sudo(SudoOutcome::Tty) => SshErrorCode::SudoTty,
        ExecFail::Sudo(SudoOutcome::Denied) => SshErrorCode::SudoDenied,
        ExecFail::Sudo(SudoOutcome::NotFound) => SshErrorCode::SudoNoServer,
        ExecFail::Sudo(SudoOutcome::NoSudo) => SshErrorCode::SudoMissing,
        _ => SshErrorCode::SudoFailed,
    }
}

// ── the sudo start (1.1.4 `startSudo`) ──────────────────────────────────────

/// How many password answers one start takes.
pub const PASSWORD_TRIES: usize = 3;

/// The start loop of `startSudo` over any exec runner (the russh one in [`start_sudo`], a fake in tests): the commands in
/// order (the next one only when sudo says the program is not there); sudo asking for a password turns `sudo -n` into
/// `sudo -S -p '<marker>'` with the password asked in the view (up to 3 times). `drop_ok` ends a session that came too late.
pub async fn run_sudo<T, E>(
    commands: Vec<String>,
    exec: E,
    ask: impl Fn(bool) -> BoxFuture<'static, Option<Zeroizing<String>>>,
    live: impl Fn() -> bool,
    drop_ok: impl Fn(T),
) -> Result<T, SshErrorCode>
where
    E: Fn(String, Option<Zeroizing<String>>) -> BoxFuture<'static, Result<T, ExecFail>>,
{
    let n = commands.len();
    for (i, command) in commands.into_iter().enumerate() {
        if !live() {
            return Err(SshErrorCode::Cancelled);
        }
        let r = exec(command.clone(), None).await;
        if !live() {
            if let Ok(t) = r {
                drop_ok(t);
            }
            return Err(SshErrorCode::Cancelled);
        }
        let fail = match r {
            Ok(t) => return Ok(t),
            Err(f) => f,
        };
        if fail == ExecFail::Sudo(SudoOutcome::NotFound) && i + 1 < n {
            continue;
        }
        if fail != ExecFail::Sudo(SudoOutcome::Password) {
            return Err(sudo_error(fail));
        }
        let Some(with_password) = password_command(&command) else { return Err(SshErrorCode::SudoFailed) };
        for attempt in 0..PASSWORD_TRIES {
            let password = ask(attempt > 0).await;
            if !live() {
                return Err(SshErrorCode::Cancelled);
            }
            let Some(password) = password else { return Err(SshErrorCode::Cancelled) };
            if !valid_sudo_password(&password) {
                return Err(SshErrorCode::SudoPassword);
            }
            let again = exec(with_password.clone(), Some(password)).await;
            if !live() {
                if let Ok(t) = again {
                    drop_ok(t);
                }
                return Err(SshErrorCode::Cancelled);
            }
            match again {
                Ok(t) => return Ok(t),
                Err(ExecFail::Sudo(SudoOutcome::WrongPassword)) => {}
                Err(f) => return Err(sudo_error(f)),
            }
        }
        return Err(SshErrorCode::SudoPassword);
    }
    Err(SshErrorCode::SudoNoServer)
}

/// `SftpBackend::start_sudo`: the SFTP server through sudo on exec channels of the session's connection.
pub async fn start_sudo(start: SudoStart) -> Result<Arc<dyn RemoteSession>, SshErrorCode> {
    let SudoStart { handle, command, timers, ask, live, .. } = start;
    let commands = sudo_commands(command.as_deref());
    let exec =
        move |command: String, password: Option<Zeroizing<String>>| -> BoxFuture<'static, Result<Arc<SftpSession>, ExecFail>> {
            let handle = handle.clone();
            Box::pin(async move {
                exec_sftp(&handle, &command, password.as_deref().map(String::as_str), timers.sftp, timers.sudo_prompt_grace).await
            })
        };
    let session = run_sudo(commands, exec, |retry| ask(retry), || live(), |s: Arc<SftpSession>| s.kill()).await?;
    Ok(session as Arc<dyn RemoteSession>)
}

// ── one server command on an exec channel (1.1.4 `execSftp`) ────────────────

/// What the exec channel reports besides stdout (stdout goes into the SFTP stream).
#[derive(Debug)]
pub enum ExecEvent {
    Stderr(Vec<u8>),
    /// The exit status (-1 for a signal, like ssh2's `exit` with a null code).
    Exit(i64),
    /// The channel closed.
    Ended,
}

/// sudo's stderr as text, the last 4096 characters (1.1.4 keeps `.slice(-4096)`).
#[derive(Default)]
struct StderrTail {
    text: String,
    /// Bytes of a UTF-8 sequence cut at a chunk end.
    rest: Vec<u8>,
}

impl StderrTail {
    fn push(&mut self, chunk: &[u8]) {
        self.rest.extend_from_slice(chunk);
        let (text, rest) = match std::str::from_utf8(&self.rest) {
            Ok(s) => (s.to_string(), Vec::new()),
            Err(e) if e.error_len().is_none() => {
                let cut = e.valid_up_to();
                (String::from_utf8_lossy(&self.rest[..cut]).into_owned(), self.rest[cut..].to_vec())
            }
            Err(_) => (String::from_utf8_lossy(&self.rest).into_owned(), Vec::new()),
        };
        self.rest = rest;
        self.text.push_str(&text);
        let count = self.text.chars().count();
        if count > 4096 {
            let skip = self.text.char_indices().nth(count - 4096).map(|(i, _)| i).unwrap_or(0);
            self.text.drain(..skip);
        }
    }
}

/// How long the end of the channel waits for a late exit status before it reads stderr (1.1.4: 20 ms).
const END_SETTLE: Duration = Duration::from_millis(20);

/// The heart of `execSftp` on any channel: `stream` is the channel's stdin / stdout, `events` its stderr, exit status and
/// end. Without a password the SFTP INIT goes out at once. With one (a `sudo -S -p '<marker>'` run) the password is written
/// only after sudo printed the marker, and the INIT right behind it; a second marker is a wrong password. When no marker
/// comes within `prompt_grace` sudo is taken not to ask: the INIT goes out and the password is never written.
pub async fn exec_sftp_on(
    stream: SftpStream,
    mut events: mpsc::UnboundedReceiver<ExecEvent>,
    password: Option<&str>,
    deadline: Instant,
    prompt_grace: Duration,
) -> Result<Arc<SftpClient>, ExecFail> {
    let non_interactive = password.is_none();
    let mut stderr = StderrTail::default();
    let mut exit: Option<i64> = None;
    let mut stream = Some(stream);
    let mut start: Option<BoxFuture<'static, Result<Arc<SftpClient>, ClientError>>> = None;
    let mut started = false;
    let mut wrote = false;
    let mut events_open = true;
    let mut ended: Option<Instant> = None;
    let grace = tokio::time::sleep(prompt_grace);
    tokio::pin!(grace);
    if password.is_none() {
        start = stream.take().map(|s| Box::pin(SftpClient::start(s)) as BoxFuture<'static, _>);
        started = true;
    }
    loop {
        tokio::select! {
            biased;
            r = async { start.as_mut().expect("guarded").await }, if start.is_some() => {
                start = None;
                match r {
                    Ok(client) => return Ok(client),
                    Err(_) => {
                        ended.get_or_insert_with(|| Instant::now() + END_SETTLE);
                    }
                }
            }
            ev = events.recv(), if events_open => match ev {
                Some(ExecEvent::Stderr(chunk)) => {
                    stderr.push(&chunk);
                    let markers = marker_count(&stderr.text);
                    if markers >= 1 && password.is_none() {
                        return Err(ExecFail::Sudo(SudoOutcome::Password));
                    }
                    if markers >= 2 {
                        return Err(ExecFail::Sudo(SudoOutcome::WrongPassword));
                    }
                    if markers == 1 && !wrote && let Some(pw) = password {
                        // A prompt after the INIT went out: sudo has read the INIT as (part of) the password. Never write it then.
                        if started {
                            return Err(ExecFail::Sudo(SudoOutcome::Other));
                        }
                        wrote = true;
                        let mut s = stream.take().expect("not started");
                        let mut line = Zeroizing::new(Vec::with_capacity(pw.len() + 1));
                        line.extend_from_slice(pw.as_bytes());
                        line.push(b'\n');
                        if write_line(&mut s, &line).await.is_err() {
                            ended.get_or_insert_with(|| Instant::now() + END_SETTLE);
                        } else {
                            start = Some(Box::pin(SftpClient::start(s)));
                        }
                        started = true;
                        continue;
                    }
                    let o = classify_sudo(&stderr.text, None, false);
                    // A wrong password makes sudo wait for the next line (the SFTP INIT has none): it would hang until the timeout.
                    if let Some(o @ (SudoOutcome::WrongPassword | SudoOutcome::Tty | SudoOutcome::Denied | SudoOutcome::NoSudo)) = o {
                        return Err(ExecFail::Sudo(o));
                    }
                }
                Some(ExecEvent::Exit(code)) => exit = Some(code),
                Some(ExecEvent::Ended) | None => {
                    events_open = false;
                    ended.get_or_insert_with(|| Instant::now() + END_SETTLE);
                }
            },
            _ = &mut grace, if !started => {
                started = true;
                if let Some(s) = stream.take() {
                    start = Some(Box::pin(SftpClient::start(s)));
                }
            }
            _ = sleep_until_opt(ended), if ended.is_some() => {
                let o = classify_sudo(&stderr.text, Some(exit.unwrap_or(-1)), non_interactive);
                return Err(ExecFail::Sudo(o.unwrap_or(SudoOutcome::Other)));
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err(classify_sudo(&stderr.text, exit, non_interactive).map(ExecFail::Sudo).unwrap_or(ExecFail::Timeout));
            }
        }
    }
}

async fn write_line(s: &mut SftpStream, line: &[u8]) -> std::io::Result<()> {
    s.write_all(line).await?;
    s.flush().await
}

async fn sleep_until_opt(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => futures::future::pending().await,
    }
}

/// The SFTP stream's buffer between the channel pumps and the client.
const PIPE_BUFFER: usize = 256 * 1024;

/// The exec channel of a started server: closed when the session ends or the start failed.
struct ExecGuard {
    write: Arc<ChannelWriteHalf<Msg>>,
    tasks: Vec<AbortHandle>,
}

impl ExecGuard {
    fn close(self) {
        for t in &self.tasks {
            t.abort();
        }
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let write = self.write;
            rt.spawn(async move {
                let _ = write.close().await;
            });
        }
    }
}

/// Opens an exec channel running `command` (LC_ALL=C / LANG=C where the server accepts it) and pumps it: stdout into the
/// returned SFTP stream, the stream's writes into stdin, stderr / exit status / close as [`ExecEvent`]s.
async fn open_exec(
    handle: &LoginHandle,
    command: &str,
) -> Result<(SftpStream, mpsc::UnboundedReceiver<ExecEvent>, ExecGuard), ()> {
    let mut ch = handle.channel_open_session().await.map_err(drop)?;
    for (name, value) in SUDO_ENV {
        ch.set_env(false, name, value).await.map_err(drop)?;
    }
    ch.exec(true, command).await.map_err(drop)?;
    // ssh2 calls the exec callback once the server accepted the request ("Unable to exec" otherwise).
    let mut early = Vec::new();
    loop {
        match ch.wait().await {
            Some(ChannelMsg::Success) => break,
            Some(ChannelMsg::Failure | ChannelMsg::Close) | None => {
                let _ = ch.close().await;
                return Err(());
            }
            Some(m) => early.push(m),
        }
    }
    let (mut read, write) = ch.split();
    let write = Arc::new(write);
    let (theirs, ours) = tokio::io::duplex(PIPE_BUFFER);
    let (our_r, mut our_w) = tokio::io::split(ours);
    let (tx, rx) = mpsc::unbounded_channel();
    let out_task = tokio::spawn(async move {
        let mut stdout_open = true;
        let mut msgs = early.into_iter();
        loop {
            let msg = match msgs.next() {
                Some(m) => Some(m),
                None => read.wait().await,
            };
            let Some(msg) = msg else { break };
            match msg {
                ChannelMsg::Data { data } => {
                    // Output nobody reads any more (the client is gone) is dropped; the channel still reports its end.
                    if stdout_open && our_w.write_all(&data).await.is_err() {
                        stdout_open = false;
                    }
                }
                ChannelMsg::ExtendedData { data, ext: 1 } => {
                    let _ = tx.send(ExecEvent::Stderr(data.to_vec()));
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    let _ = tx.send(ExecEvent::Exit(i64::from(exit_status)));
                }
                ChannelMsg::ExitSignal { .. } => {
                    let _ = tx.send(ExecEvent::Exit(-1));
                }
                ChannelMsg::Eof => {
                    if stdout_open {
                        stdout_open = false;
                        let _ = our_w.shutdown().await;
                    }
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = our_w.shutdown().await;
        let _ = tx.send(ExecEvent::Ended);
    });
    let mut writer = Box::pin(write.make_writer());
    let in_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::with_capacity(64 * 1024, our_r);
        let _ = tokio::io::copy_buf(&mut reader, &mut writer).await;
        let _ = writer.shutdown().await;
    });
    let guard = ExecGuard { write, tasks: vec![out_task.abort_handle(), in_task.abort_handle()] };
    Ok((Box::new(theirs), rx, guard))
}

/// `execSftp`: one server command on an exec channel of the session's connection with the SFTP client on it; the channel
/// ends with the session.
async fn exec_sftp(
    handle: &LoginHandle,
    command: &str,
    password: Option<&str>,
    sftp_timer: Duration,
    prompt_grace: Duration,
) -> Result<Arc<SftpSession>, ExecFail> {
    let deadline = Instant::now() + sftp_timer;
    let (stream, events, guard) = match tokio::time::timeout_at(deadline, open_exec(handle, command)).await {
        Err(_) => return Err(ExecFail::Timeout),
        Ok(Err(())) => return Err(ExecFail::Sudo(SudoOutcome::Other)),
        Ok(Ok(x)) => x,
    };
    match exec_sftp_on(stream, events, password, deadline, prompt_grace).await {
        Ok(client) => Ok(SftpSession::with_on_kill(Arc::new(RemoteSide::new(client)), move || guard.close())),
        Err(f) => {
            guard.close();
            Err(f)
        }
    }
}

#[cfg(test)]
#[path = "sudo_tests.rs"]
mod tests;
