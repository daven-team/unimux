//! T5: the sudo rules (1.1.4 test/sftp-manage.test.ts "SFTP through sudo: rules"), the exec engine on a fake channel with
//! the in-memory SFTP server, and the start loop with a fake runner.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, DuplexStream};
use tokio::sync::mpsc;
use tokio::time::Instant;
use unimux_ssh::session::SshErrorCode;
use zeroize::Zeroizing;

use super::*;
use crate::fake_server::{Config, Fake};

#[test]
fn rules() {
    assert_eq!(
        sudo_commands(None),
        vec![
            "sudo -n /usr/lib/openssh/sftp-server",
            "sudo -n /usr/libexec/openssh/sftp-server",
            "sudo -n /usr/lib/ssh/sftp-server"
        ]
    );
    assert_eq!(sudo_commands(Some("  doas /usr/lib/sftp-server ")), vec!["doas /usr/lib/sftp-server"]);
    assert_eq!(sudo_commands(Some("   ")).len(), 3);
    assert_eq!(
        password_command("sudo -n /usr/lib/openssh/sftp-server").as_deref(),
        Some("sudo -S -p '[unimux-sudo-password]' /usr/lib/openssh/sftp-server")
    );
    assert_eq!(
        password_command("sudo -n -u www /usr/lib/sftp-server -l INFO").as_deref(),
        Some("sudo -S -p '[unimux-sudo-password]' -u www /usr/lib/sftp-server -l INFO")
    );
    assert_eq!(password_command("doas /x"), None);
    assert_eq!(marker_count(&format!("{SUDO_MARKER}Sorry, try again.\n{SUDO_MARKER}")), 2);
    assert!(valid_sudo_password("pw"));
    assert!(!valid_sudo_password("a\nb"));
    assert!(!valid_sudo_password(""));
    assert!(!valid_sudo_password(&"x".repeat(1025)));
    assert!(valid_sudo_password(&"x".repeat(1024)));
}

#[test]
fn reads_what_sudo_says() {
    use SudoOutcome::*;
    assert_eq!(classify_sudo("sudo: a password is required\n", Some(1), false), Some(Password));
    assert_eq!(classify_sudo("Sorry, try again.\n", None, false), Some(WrongPassword));
    assert_eq!(classify_sudo("sudo: 3 incorrect password attempts\n", Some(1), false), Some(WrongPassword));
    assert_eq!(classify_sudo("sudo: sorry, you must have a tty to run sudo\n", Some(1), false), Some(Tty));
    assert_eq!(classify_sudo("Sorry, user alice is not allowed to execute '/x' as root on h.\n", Some(1), false), Some(Denied));
    assert_eq!(
        classify_sudo("alice is not in the sudoers file.  This incident will be reported.\n", Some(1), false),
        Some(Denied)
    );
    assert_eq!(classify_sudo("sudo: /usr/lib/openssh/sftp-server: command not found\n", Some(1), false), Some(NotFound));
    assert_eq!(classify_sudo("", Some(127), false), Some(NotFound));
    assert_eq!(classify_sudo("", None, false), None);
    assert_eq!(classify_sudo("something else", Some(2), false), Some(Other));
    assert_eq!(sudo_error(ExecFail::Sudo(WrongPassword)), SshErrorCode::SudoPassword);
    assert_eq!(sudo_error(ExecFail::Sudo(Tty)), SshErrorCode::SudoTty);
    assert_eq!(sudo_error(ExecFail::Sudo(Denied)), SshErrorCode::SudoDenied);
    assert_eq!(sudo_error(ExecFail::Sudo(NotFound)), SshErrorCode::SudoNoServer);
    assert_eq!(sudo_error(ExecFail::Timeout), SshErrorCode::SudoFailed);
    assert_eq!(sudo_error(ExecFail::Sudo(NoSudo)), SshErrorCode::SudoMissing);
}

#[test]
fn reads_polish_a_missing_sudo_and_an_unknown_language() {
    use SudoOutcome::*;
    assert_eq!(classify_sudo("sudo: wymagane jest hasło\n", Some(1), false), Some(Password));
    assert_eq!(classify_sudo("Niestety, spróbuj ponownie.\n", None, false), Some(WrongPassword));
    assert_eq!(classify_sudo("sudo: /usr/lib/openssh/sftp-server: nie znaleziono polecenia\n", Some(1), false), Some(NotFound));
    assert_eq!(
        classify_sudo("Niestety, użytkownik alice nie ma uprawnień do uruchamiania '/x' jako root na h.\n", Some(1), false),
        Some(Denied)
    );
    assert_eq!(classify_sudo("sudo: niestety, aby uruchomić sudo, musisz mieć terminal\n", Some(1), false), Some(Tty));
    assert_eq!(classify_sudo("sh: 1: sudo: not found\n", Some(127), false), Some(NoSudo));
    assert_eq!(classify_sudo("bash: sudo: command not found\n", Some(127), false), Some(NoSudo));
    assert_eq!(classify_sudo("sudo: /x: command not found\n", Some(1), false), Some(NotFound));
    assert_eq!(classify_sudo("sudo: ффф\n", Some(1), true), Some(Password));
    assert_eq!(classify_sudo("sudo: ффф\n", Some(1), false), Some(Other));
    assert_eq!(classify_sudo(SUDO_MARKER, None, false), None);
    // Upper-case Polish letters are folded like JS toLowerCase.
    assert_eq!(classify_sudo("SUDO: WYMAGANE JEST HASŁO\n", None, false), Some(Password));
}

#[test]
fn stderr_tail_joins_split_utf8_and_keeps_4096_chars() {
    let mut t = StderrTail::default();
    let s = "hasło".as_bytes();
    t.push(&s[..4]);
    t.push(&s[4..]);
    assert_eq!(t.text, "hasło");
    t.push("ł".repeat(5000).as_bytes());
    assert_eq!(t.text.chars().count(), 4096);
}

/// A fake sudo on the far end of the channel.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Sudo {
    /// NOPASSWD: the server answers at once.
    NoPass,
    /// `sudo -n` without a cached credential: "a password is required", exit 1.
    NeedsPassword,
    /// `sudo -S -p`: prompts with the marker, accepts `pw`.
    Prompt,
    /// Says nothing at all.
    Silent,
    /// requiretty in Polish.
    TtyPl,
}

struct FakeExec {
    stream: SftpStream,
    events: mpsc::UnboundedReceiver<ExecEvent>,
    /// What sudo read as the password line.
    read_password: Arc<Mutex<Option<String>>>,
}

fn fake_exec(kind: Sudo) -> FakeExec {
    let (ours, mut theirs): (DuplexStream, DuplexStream) = tokio::io::duplex(1 << 20);
    let (tx, rx) = mpsc::unbounded_channel();
    let read_password = Arc::new(Mutex::new(None));
    let rp = read_password.clone();
    tokio::spawn(async move {
        let fake = Fake::new(Config::default());
        match kind {
            Sudo::NoPass => fake.serve(theirs).await,
            Sudo::NeedsPassword => {
                let _ = tx.send(ExecEvent::Stderr(b"sudo: a password is required\n".to_vec()));
                let _ = tx.send(ExecEvent::Exit(1));
                drop(theirs);
                let _ = tx.send(ExecEvent::Ended);
            }
            Sudo::Prompt => loop {
                let _ = tx.send(ExecEvent::Stderr(SUDO_MARKER.as_bytes().to_vec()));
                let mut line = Vec::new();
                loop {
                    let Ok(b) = theirs.read_u8().await else { return };
                    if b == b'\n' {
                        break;
                    }
                    line.push(b);
                }
                let line = String::from_utf8_lossy(&line).into_owned();
                *rp.lock() = Some(line.clone());
                if line == "pw" {
                    fake.serve(theirs).await;
                    return;
                }
                let _ = tx.send(ExecEvent::Stderr(b"Sorry, try again.\n".to_vec()));
            },
            Sudo::Silent => {
                let mut buf = [0u8; 64];
                while let Ok(n) = theirs.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                }
            }
            Sudo::TtyPl => {
                let _ =
                    tx.send(ExecEvent::Stderr("sudo: niestety, aby uruchomić sudo, musisz mieć terminal\n".as_bytes().to_vec()));
                let mut buf = [0u8; 64];
                let _ = theirs.read(&mut buf).await;
            }
        }
    });
    FakeExec { stream: Box::new(ours), events: rx, read_password }
}

async fn run(kind: Sudo, password: Option<&str>) -> (Result<Arc<SftpClient>, ExecFail>, Option<String>) {
    let f = fake_exec(kind);
    let r = exec_sftp_on(f.stream, f.events, password, Instant::now() + Duration::from_secs(20), Duration::from_secs(3)).await;
    let read = f.read_password.lock().clone();
    (r, read)
}

#[tokio::test]
async fn nopasswd_starts_sftp_at_once() {
    let (r, _) = run(Sudo::NoPass, None).await;
    assert!(r.is_ok());
}

#[tokio::test]
async fn sudo_n_asking_for_a_password_reads_password() {
    let (r, _) = run(Sudo::NeedsPassword, None).await;
    assert_eq!(r.err(), Some(ExecFail::Sudo(SudoOutcome::Password)));
}

#[tokio::test]
async fn the_password_goes_out_after_the_marker_and_before_the_init() {
    let (r, read) = run(Sudo::Prompt, Some("pw")).await;
    assert!(r.is_ok());
    assert_eq!(read.as_deref(), Some("pw"));
}

#[tokio::test]
async fn a_second_marker_is_a_wrong_password() {
    let (r, read) = run(Sudo::Prompt, Some("bad")).await;
    assert_eq!(r.err(), Some(ExecFail::Sudo(SudoOutcome::WrongPassword)));
    assert_eq!(read.as_deref(), Some("bad"));
}

#[tokio::test]
async fn a_marker_without_a_password_is_a_password_question() {
    let (r, read) = run(Sudo::Prompt, None).await;
    assert_eq!(r.err(), Some(ExecFail::Sudo(SudoOutcome::Password)));
    assert_eq!(read, None);
}

#[tokio::test(start_paused = true)]
async fn no_marker_within_the_grace_starts_sftp_and_never_writes_the_password() {
    let (r, _) = run(Sudo::NoPass, Some("pw")).await;
    assert!(r.is_ok());
}

#[tokio::test(start_paused = true)]
async fn silence_ends_with_timeout() {
    let (r, _) = run(Sudo::Silent, None).await;
    assert_eq!(r.err(), Some(ExecFail::Timeout));
}

#[tokio::test]
async fn polish_requiretty_ends_at_once() {
    let (r, _) = run(Sudo::TtyPl, None).await;
    assert_eq!(r.err(), Some(ExecFail::Sudo(SudoOutcome::Tty)));
}

/// The start loop with scripted exec results.
struct Script {
    results: Mutex<Vec<Result<u32, ExecFail>>>,
    calls: Mutex<Vec<(String, Option<String>)>>,
}

async fn start_with(
    results: Vec<Result<u32, ExecFail>>,
    answers: Vec<Option<&'static str>>,
    custom: Option<&str>,
) -> (Result<u32, SshErrorCode>, Vec<(String, Option<String>)>, Vec<bool>) {
    let script = Arc::new(Script { results: Mutex::new(results), calls: Mutex::new(Vec::new()) });
    let s2 = script.clone();
    let exec = move |cmd: String, pw: Option<Zeroizing<String>>| -> BoxFuture<'static, Result<u32, ExecFail>> {
        s2.calls.lock().push((cmd, pw.map(|p| p.to_string())));
        let r = s2.results.lock().remove(0);
        Box::pin(async move { r })
    };
    let answers = Arc::new(Mutex::new(answers));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let (a2, k2) = (answers.clone(), asked.clone());
    let ask = move |retry: bool| -> BoxFuture<'static, Option<Zeroizing<String>>> {
        k2.lock().push(retry);
        let a = a2.lock().remove(0).map(|s| Zeroizing::new(s.to_string()));
        Box::pin(async move { a })
    };
    let dropped = AtomicUsize::new(0);
    let r = run_sudo(
        sudo_commands(custom),
        exec,
        ask,
        || true,
        |_| {
            dropped.fetch_add(1, Ordering::SeqCst);
        },
    )
    .await;
    let calls = script.calls.lock().clone();
    let asked = asked.lock().clone();
    (r, calls, asked)
}

#[tokio::test]
async fn start_tries_the_next_place_only_when_the_server_is_not_there() {
    let nf = Err(ExecFail::Sudo(SudoOutcome::NotFound));
    let (r, calls, _) = start_with(vec![nf, Ok(7)], vec![], None).await;
    assert_eq!(r, Ok(7));
    assert_eq!(calls[1].0, "sudo -n /usr/libexec/openssh/sftp-server");
    let (r, calls, _) = start_with(vec![nf, nf, nf], vec![], None).await;
    assert_eq!(r, Err(SshErrorCode::SudoNoServer));
    assert_eq!(calls.len(), 3);
    let (r, _, _) = start_with(vec![Err(ExecFail::Sudo(SudoOutcome::Denied))], vec![], None).await;
    assert_eq!(r, Err(SshErrorCode::SudoDenied));
    let (r, _, _) = start_with(vec![Err(ExecFail::Timeout)], vec![], None).await;
    assert_eq!(r, Err(SshErrorCode::SudoFailed));
}

#[tokio::test]
async fn start_asks_the_password_three_times() {
    let pw = Err(ExecFail::Sudo(SudoOutcome::Password));
    let wrong = Err(ExecFail::Sudo(SudoOutcome::WrongPassword));
    let (r, calls, asked) = start_with(vec![pw, wrong, Ok(3)], vec![Some("a"), Some("b")], None).await;
    assert_eq!(r, Ok(3));
    assert_eq!(asked, vec![false, true]);
    assert_eq!(calls[1], ("sudo -S -p '[unimux-sudo-password]' /usr/lib/openssh/sftp-server".to_string(), Some("a".to_string())));
    let (r, _, asked) = start_with(vec![pw, wrong, wrong, wrong], vec![Some("a"), Some("b"), Some("c")], None).await;
    assert_eq!(r, Err(SshErrorCode::SudoPassword));
    assert_eq!(asked.len(), 3);
    let (r, _, _) = start_with(vec![pw], vec![None], None).await;
    assert_eq!(r, Err(SshErrorCode::Cancelled));
    let (r, calls, _) = start_with(vec![pw], vec![Some("a\nb")], None).await;
    assert_eq!(r, Err(SshErrorCode::SudoPassword));
    assert_eq!(calls.len(), 1);
    let (r, _, _) = start_with(vec![pw, Err(ExecFail::Sudo(SudoOutcome::Tty))], vec![Some("a")], None).await;
    assert_eq!(r, Err(SshErrorCode::SudoTty));
    // A custom command of another form cannot take a password.
    let (r, _, _) = start_with(vec![pw], vec![], Some("doas /usr/lib/sftp-server")).await;
    assert_eq!(r, Err(SshErrorCode::SudoFailed));
}
