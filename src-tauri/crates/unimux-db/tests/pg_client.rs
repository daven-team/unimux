//! D4: the Postgres client against a small in-process fake server (the cases of test/db-fake.int.test.ts that are about
//! connecting: passwords, TLS modes, cancel; plus the simple query protocol: several results, errors, notices, COPY, stray
//! ReadyForQuery messages). The TLS fixtures are test/fixtures/pg-tls (CA, a server certificate for localhost and
//! 127.0.0.1, and another CA).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use postgres_protocol::authentication::md5_hash;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use unimux_db::pg::cancel::cancel_backend;
use unimux_db::pg::client::{Collect, PgIo, PgStream, TxStatus};
use unimux_db::pg::connect::{Connector, PasswordPrompt, PgOpenConfig, TcpConnector, connect_tls, open};
use unimux_db::pg::error::{ConnectError, OpenError};
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq)]
enum Auth {
    Trust,
    Cleartext,
    Md5,
}

struct FakeOptions {
    auth: Auth,
    password: &'static str,
    tls: bool,
    require_tls: bool,
    /// Logins after this many are refused (53300).
    max_logins: usize,
}

impl Default for FakeOptions {
    fn default() -> Self {
        FakeOptions { auth: Auth::Trust, password: "secret", tls: false, require_tls: false, max_logins: usize::MAX }
    }
}

#[derive(Default)]
struct FakeState {
    logins: Vec<(String, String, bool)>,
    params: Vec<Vec<(String, String)>>,
    statements: Vec<String>,
    cancels: Vec<(&'static str, i32)>,
    sleeping: HashMap<i32, Arc<Notify>>,
    next_pid: i32,
}

struct Fake {
    port: u16,
    state: Arc<Mutex<FakeState>>,
}

fn fixture(name: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/pg-tls").join(name);
    std::fs::read_to_string(p).unwrap()
}

fn server_tls() -> tokio_rustls::TlsAcceptor {
    let certs: Vec<CertificateDer<'static>> =
        CertificateDer::pem_slice_iter(fixture("server.pem").as_bytes()).collect::<Result<_, _>>().unwrap();
    let key = PrivateKeyDer::from_pem_slice(fixture("server.key").as_bytes()).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .unwrap();
    tokio_rustls::TlsAcceptor::from(Arc::new(config))
}

fn msg(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut b = vec![tag];
    b.extend(((body.len() + 4) as i32).to_be_bytes());
    b.extend(body);
    b
}

fn cstr(s: &str) -> Vec<u8> {
    let mut b = s.as_bytes().to_vec();
    b.push(0);
    b
}

fn error(code: &str, message: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for (k, v) in [(b'S', "ERROR"), (b'C', code), (b'M', message)] {
        body.push(k);
        body.extend(cstr(v));
    }
    body.push(0);
    msg(b'E', &body)
}

fn notice(message: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for (k, v) in [(b'S', "NOTICE"), (b'C', "00000"), (b'M', message)] {
        body.push(k);
        body.extend(cstr(v));
    }
    body.push(0);
    msg(b'N', &body)
}

fn fields(names: &[&str]) -> Vec<u8> {
    let mut body = (names.len() as i16).to_be_bytes().to_vec();
    for n in names {
        body.extend(cstr(n));
        body.extend([0, 0, 0, 0, 0, 0, 0, 0, 0, 25, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0]);
    }
    msg(b'T', &body)
}

fn data(values: &[Option<&str>]) -> Vec<u8> {
    let mut body = (values.len() as i16).to_be_bytes().to_vec();
    for v in values {
        match v {
            Some(v) => {
                body.extend((v.len() as i32).to_be_bytes());
                body.extend(v.as_bytes());
            }
            None => body.extend((-1i32).to_be_bytes()),
        }
    }
    msg(b'D', &body)
}

fn tag(t: &str) -> Vec<u8> {
    msg(b'C', &cstr(t))
}

async fn read_untagged(s: &mut PgStream) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).await.ok()?;
    let n = i32::from_be_bytes(len) as usize - 4;
    let mut body = vec![0u8; n];
    s.read_exact(&mut body).await.ok()?;
    Some(body)
}

async fn read_msg(s: &mut PgStream) -> Option<(u8, Vec<u8>)> {
    let mut t = [0u8; 1];
    s.read_exact(&mut t).await.ok()?;
    Some((t[0], read_untagged(s).await?))
}

fn cstrs(body: &[u8]) -> Vec<String> {
    body.split(|b| *b == 0).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
}

async fn start_fake(opts: FakeOptions) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Mutex::new(FakeState { next_pid: 1000, ..Default::default() }));
    let opts = Arc::new(opts);
    let st = state.clone();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let st = st.clone();
            let opts = opts.clone();
            tokio::spawn(async move {
                let _ = serve(Box::new(sock), st, opts).await;
            });
        }
    });
    Fake { port, state }
}

async fn serve(mut s: PgStream, st: Arc<Mutex<FakeState>>, opts: Arc<FakeOptions>) -> Option<()> {
    let mut tls = false;
    let startup = loop {
        let body = read_untagged(&mut s).await?;
        let code = i32::from_be_bytes(body[..4].try_into().ok()?);
        match code {
            80_877_103 => {
                if !opts.tls || tls {
                    s.write_all(b"N").await.ok()?;
                    continue;
                }
                s.write_all(b"S").await.ok()?;
                let t = server_tls().accept(s).await.ok()?;
                s = Box::new(t);
                tls = true;
            }
            80_877_102 => {
                let pid = i32::from_be_bytes(body[4..8].try_into().ok()?);
                let mut g = st.lock();
                g.cancels.push(("protocol", pid));
                if let Some(n) = g.sleeping.get(&pid) {
                    n.notify_one();
                }
                return Some(());
            }
            196_608 => break body,
            _ => return None,
        }
    };
    let parts = cstrs(&startup[4..]);
    let params: Vec<(String, String)> =
        parts.chunks(2).filter(|c| c.len() == 2 && !c[0].is_empty()).map(|c| (c[0].clone(), c[1].clone())).collect();
    let get = |k: &str| params.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default();
    let (user, database) = (get("user"), get("database"));
    if opts.require_tls && !tls {
        s.write_all(&error("28000", "no pg_hba.conf entry for host \"127.0.0.1\", no encryption")).await.ok()?;
        return Some(());
    }
    if st.lock().logins.len() >= opts.max_logins {
        s.write_all(&error("53300", "sorry, too many clients already")).await.ok()?;
        return Some(());
    }
    if opts.auth != Auth::Trust {
        let salt = [1u8, 2, 3, 4];
        if opts.auth == Auth::Md5 {
            let mut body = 5i32.to_be_bytes().to_vec();
            body.extend(salt);
            s.write_all(&msg(b'R', &body)).await.ok()?;
        } else {
            s.write_all(&msg(b'R', &3i32.to_be_bytes())).await.ok()?;
        }
        let (t, body) = read_msg(&mut s).await?;
        assert_eq!(t, b'p');
        let given = cstrs(&body).remove(0);
        let expected = if opts.auth == Auth::Md5 {
            md5_hash(user.as_bytes(), opts.password.as_bytes(), salt)
        } else {
            opts.password.to_owned()
        };
        if given != expected {
            s.write_all(&error("28P01", &format!("password authentication failed for user \"{user}\""))).await.ok()?;
            return Some(());
        }
    }
    if database == "missing" {
        s.write_all(&error("3D000", "database \"missing\" does not exist")).await.ok()?;
        return Some(());
    }
    let pid = {
        let mut g = st.lock();
        g.logins.push((user.clone(), database.clone(), tls));
        g.params.push(params.clone());
        g.next_pid += 1;
        g.next_pid - 1
    };
    let mut out = msg(b'R', &0i32.to_be_bytes());
    out.extend(msg(b'S', &[cstr("server_version"), cstr("16.4 (fake)")].concat()));
    let mut key = pid.to_be_bytes().to_vec();
    key.extend(7i32.to_be_bytes());
    out.extend(msg(b'K', &key));
    out.extend(msg(b'Z', b"I"));
    s.write_all(&out).await.ok()?;
    let mut tx = b'I';
    let mut parsed = String::new();
    let mut bound: Vec<String> = Vec::new();
    loop {
        let (t, body) = read_msg(&mut s).await?;
        match t {
            b'Q' => {
                let text = cstrs(&body).remove(0);
                let mut out = Vec::new();
                for stmt in text.split(';').map(str::trim) {
                    if text.trim().is_empty() {
                        out.extend(msg(b'I', &[]));
                        break;
                    }
                    if stmt.is_empty() {
                        continue;
                    }
                    st.lock().statements.push(stmt.to_owned());
                    match stmt {
                        "SHOW server_version" => {
                            out.extend(fields(&["server_version"]));
                            out.extend(data(&[Some("16.4 (fake)")]));
                            out.extend(tag("SHOW"));
                        }
                        "SELECT 1" => {
                            out.extend(fields(&["?column?"]));
                            out.extend(data(&[Some("1")]));
                            out.extend(tag("SELECT 1"));
                        }
                        "SELECT NULL, 'x'" => {
                            out.extend(fields(&["a", "b"]));
                            out.extend(data(&[None, Some("x")]));
                            out.extend(data(&[None, Some("y")]));
                            out.extend(tag("SELECT 2"));
                        }
                        "BEGIN" => {
                            tx = b'T';
                            out.extend(tag("BEGIN"));
                        }
                        "COMMIT" => {
                            tx = b'I';
                            out.extend(tag("COMMIT"));
                        }
                        "NOTICE" => {
                            out.extend(notice("hello"));
                            out.extend(tag("DO"));
                        }
                        "STRAY" => {
                            // an extra ReadyForQuery for nothing the client sent (PGlite's socket server does this)
                            out.extend(tag("DO"));
                            out.extend(msg(b'Z', &[tx]));
                        }
                        "COPY t FROM STDIN" => {
                            s.write_all(&out).await.ok()?;
                            out.clear();
                            s.write_all(&msg(b'G', &[0, 0, 0])).await.ok()?;
                            let (t, body) = read_msg(&mut s).await?;
                            assert_eq!(t, b'f');
                            let why = cstrs(&body).remove(0);
                            out.extend(error("57014", &format!("COPY from stdin failed: {why}")));
                            if tx == b'T' {
                                tx = b'E';
                            }
                            break;
                        }
                        "COPY t TO STDOUT" => {
                            out.extend(msg(b'H', &[0, 0, 0]));
                            out.extend(msg(b'd', b"1\n"));
                            out.extend(msg(b'd', b"2\n"));
                            out.extend(msg(b'c', &[]));
                            out.extend(tag("COPY 2"));
                        }
                        "SELECT pg_sleep(5)" => {
                            s.write_all(&out).await.ok()?;
                            out.clear();
                            let n = Arc::new(Notify::new());
                            st.lock().sleeping.insert(pid, n.clone());
                            let cancelled = tokio::time::timeout(Duration::from_secs(5), n.notified()).await.is_ok();
                            st.lock().sleeping.remove(&pid);
                            if cancelled {
                                out.extend(error("57014", "canceling statement due to user request"));
                                break;
                            }
                            out.extend(fields(&["pg_sleep"]));
                            out.extend(data(&[Some("")]));
                            out.extend(tag("SELECT 1"));
                        }
                        s if s.starts_with("SET ") => out.extend(tag("SET")),
                        _ => {
                            out.extend(error("42601", &format!("syntax error at or near \"{stmt}\"")));
                            if tx == b'T' {
                                tx = b'E';
                            }
                            break;
                        }
                    }
                }
                out.extend(msg(b'Z', &[tx]));
                s.write_all(&out).await.ok()?;
            }
            b'P' => {
                let parts = cstrs(&body);
                parsed = parts[1].clone();
            }
            b'B' => {
                // portal, statement, 0 format codes, n params
                let mut at = body.iter().position(|b| *b == 0).unwrap() + 1;
                at += body[at..].iter().position(|b| *b == 0).unwrap() + 1;
                let nf = i16::from_be_bytes([body[at], body[at + 1]]) as usize;
                at += 2 + nf * 2;
                let np = i16::from_be_bytes([body[at], body[at + 1]]) as usize;
                at += 2;
                bound.clear();
                for _ in 0..np {
                    let len = i32::from_be_bytes(body[at..at + 4].try_into().unwrap());
                    at += 4;
                    bound.push(String::from_utf8_lossy(&body[at..at + len as usize]).into_owned());
                    at += len as usize;
                }
            }
            b'D' | b'E' => {}
            b'S' => {
                st.lock().statements.push(parsed.clone());
                let mut out = msg(b'1', &[]);
                out.extend(msg(b'2', &[]));
                if parsed == "SELECT pg_cancel_backend($1)" {
                    let target: i32 = bound[0].parse().unwrap();
                    let hit = {
                        let mut g = st.lock();
                        g.cancels.push(("function", target));
                        g.sleeping.get(&target).cloned()
                    };
                    if let Some(n) = &hit {
                        n.notify_one();
                    }
                    out.extend(fields(&["pg_cancel_backend"]));
                    out.extend(data(&[Some(if hit.is_some() { "t" } else { "f" })]));
                    out.extend(tag("SELECT 1"));
                } else {
                    out.extend(error("42601", "unknown"));
                }
                out.extend(msg(b'Z', &[tx]));
                s.write_all(&out).await.ok()?;
            }
            b'X' => return Some(()),
            _ => return None,
        }
    }
}

/// Answers prompts from a list (None: cancelled) and records whether each was a retry.
struct Answers {
    answers: Vec<Option<&'static str>>,
    asked: Arc<Mutex<Vec<bool>>>,
}

impl PasswordPrompt for Answers {
    fn ask(&mut self, retry: bool) -> BoxFuture<'_, Option<Zeroizing<String>>> {
        self.asked.lock().push(retry);
        let next = if self.answers.is_empty() { None } else { self.answers.remove(0) };
        Box::pin(async move { next.map(|s| Zeroizing::new(s.to_owned())) })
    }
}

fn answers(list: &[Option<&'static str>]) -> (Answers, Arc<Mutex<Vec<bool>>>) {
    let asked = Arc::new(Mutex::new(Vec::new()));
    (Answers { answers: list.to_vec(), asked: asked.clone() }, asked)
}

fn config(port: u16, f: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>)) -> PgOpenConfig {
    let mut m = serde_json::Map::new();
    m.insert("kind".into(), "postgres".into());
    m.insert("host".into(), "127.0.0.1".into());
    m.insert("port".into(), port.into());
    m.insert("user".into(), "postgres".into());
    m.insert("database".into(), "postgres".into());
    m.insert("tls".into(), "disable".into());
    m.insert("readOnly".into(), false.into());
    f(&mut m);
    PgOpenConfig::from_json(&serde_json::Value::Object(m))
}

async fn open_with(
    port: u16,
    prompt: &mut dyn PasswordPrompt,
    f: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
) -> Result<unimux_db::pg::connect::PgOpened, OpenError> {
    let c = config(port, f);
    let (host, p) = c.endpoint();
    let connector = TcpConnector::new(host, p);
    open(&connector, &c, Duration::from_secs(5), prompt).await
}

#[tokio::test]
async fn saved_md5_password_logs_in_without_asking_and_sends_node_postgres_startup() {
    let s = start_fake(FakeOptions { auth: Auth::Md5, ..Default::default() }).await;
    let (mut p, asked) = answers(&[]);
    let o = open_with(s.port, &mut p, |m| {
        m.insert("password".into(), "secret".into());
        m.insert("user".into(), "alice".into());
        m.insert("database".into(), "app".into());
    })
    .await
    .unwrap();
    assert_eq!(o.server_version.as_deref(), Some("16.4 (fake)"));
    assert!(!o.tls);
    assert_eq!(o.client.process_id(), Some(1000));
    assert_eq!(o.client.param("server_version"), Some("16.4 (fake)"));
    assert!(asked.lock().is_empty());
    let g = s.state.lock();
    assert_eq!(g.logins, vec![("alice".to_owned(), "app".to_owned(), false)]);
    let keys: Vec<_> = g.params[0].iter().map(|(k, v)| format!("{k}={v}")).collect();
    assert_eq!(keys, ["user=alice", "database=app", "application_name=unimux", "client_encoding=UTF8"]);
}

#[tokio::test]
async fn asks_when_none_is_saved_retries_after_a_wrong_one_and_gives_up_after_three() {
    let s = start_fake(FakeOptions { auth: Auth::Cleartext, ..Default::default() }).await;
    let (mut p, asked) = answers(&[Some("wrong"), Some("secret")]);
    let o = open_with(s.port, &mut p, |_| {}).await.unwrap();
    assert_eq!(o.password.as_deref().map(|p| p.as_str()), Some("secret"));
    assert_eq!(*asked.lock(), vec![false, true]);
    let (mut p, asked) = answers(&[Some("nope"), Some("nope"), Some("nope"), Some("nope")]);
    let e = open_with(s.port, &mut p, |m| {
        m.insert("password".into(), "stale".into());
    })
    .await
    .unwrap_err();
    assert_eq!(e, OpenError { code: "dbAuth", message: Some("password authentication failed for user \"postgres\"".into()) });
    assert_eq!(*asked.lock(), vec![true, true, true]);
}

#[tokio::test]
async fn a_cancelled_prompt_and_a_missing_database() {
    let s = start_fake(FakeOptions { auth: Auth::Md5, ..Default::default() }).await;
    let (mut p, _) = answers(&[None]);
    assert_eq!(open_with(s.port, &mut p, |_| {}).await.unwrap_err(), OpenError::new("cancelled"));
    let t = start_fake(FakeOptions::default()).await;
    let (mut p, _) = answers(&[]);
    let e = open_with(t.port, &mut p, |m| {
        m.insert("database".into(), "missing".into());
    })
    .await
    .unwrap_err();
    assert_eq!(e, OpenError { code: "dbNoDatabase", message: Some("database \"missing\" does not exist".into()) });
}

#[tokio::test]
async fn tls_require_and_prefer_encrypt_prefer_falls_back_and_require_does_not() {
    let s = start_fake(FakeOptions { tls: true, ..Default::default() }).await;
    let (mut p, _) = answers(&[]);
    for mode in ["require", "prefer"] {
        let o = open_with(s.port, &mut p, |m| {
            m.insert("tls".into(), mode.into());
        })
        .await
        .unwrap();
        assert!(o.tls && o.client.tls());
    }
    assert_eq!(s.state.lock().logins.iter().map(|l| l.2).collect::<Vec<_>>(), [true, true]);
    let plain = start_fake(FakeOptions::default()).await;
    let o = open_with(plain.port, &mut p, |m| {
        m.insert("tls".into(), "prefer".into());
    })
    .await
    .unwrap();
    assert!(!o.tls);
    let e = open_with(plain.port, &mut p, |m| {
        m.insert("tls".into(), "require".into());
    })
    .await
    .unwrap_err();
    assert_eq!(e.code, "dbTlsUnsupported");
}

#[tokio::test]
async fn verify_full_needs_the_right_ca_and_a_host_the_certificate_names() {
    let s = start_fake(FakeOptions { tls: true, ..Default::default() }).await;
    let (mut p, _) = answers(&[]);
    for host in ["localhost", "127.0.0.1"] {
        let o = open_with(s.port, &mut p, |m| {
            m.insert("host".into(), host.into());
            m.insert("tls".into(), "verify-full".into());
            m.insert("ca".into(), fixture("ca.pem").into());
        })
        .await
        .unwrap();
        assert!(o.tls, "{host}");
    }
    let e = open_with(s.port, &mut p, |m| {
        m.insert("host".into(), "localhost".into());
        m.insert("tls".into(), "verify-full".into());
        m.insert("ca".into(), fixture("other-ca.pem").into());
    })
    .await
    .unwrap_err();
    assert_eq!(e.code, "dbTls");
    assert!(e.message.is_some_and(|m| !m.is_empty()));
    // the certificate names localhost and 127.0.0.1, not ::1 / another address of the machine
    let c = config(s.port, |m| {
        m.insert("tls".into(), "verify-full".into());
        m.insert("ca".into(), fixture("ca.pem").into());
        m.insert("ssh".into(), serde_json::json!({ "dbHost": "127.0.0.2", "dbPort": s.port, "tunnelKey": "k", "owner": true }));
    });
    // through a "tunnel" that ends at 127.0.0.1 while the logical host is 127.0.0.2: the name check fails
    let e = open(&TcpConnector::new("127.0.0.1", s.port), &c, Duration::from_secs(5), &mut p).await.unwrap_err();
    assert_eq!(e.code, "dbTls");
    assert_eq!(s.state.lock().logins.len(), 2);
}

#[tokio::test]
async fn disable_against_a_tls_only_server_reads_the_server_message() {
    let s = start_fake(FakeOptions { tls: true, require_tls: true, ..Default::default() }).await;
    let (mut p, _) = answers(&[]);
    let e = open_with(s.port, &mut p, |_| {}).await.unwrap_err();
    assert_eq!(e.code, "dbAuth");
    assert!(e.message.unwrap().contains("no encryption"));
}

#[tokio::test]
async fn refused_and_timed_out_connects() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    let (mut p, _) = answers(&[]);
    assert_eq!(open_with(port, &mut p, |_| {}).await.unwrap_err().code, "dbRefused");
    // a server that accepts and never answers
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = silent.local_addr().unwrap().port();
    let c = config(port, |_| {});
    let e = open(&TcpConnector::new("127.0.0.1", port), &c, Duration::from_millis(300), &mut p).await.unwrap_err();
    assert_eq!(e.code, "dbTimeout");
    drop(silent);
}

#[tokio::test]
async fn read_only_and_statement_timeout_settings_run_before_the_version() {
    let s = start_fake(FakeOptions::default()).await;
    let (mut p, _) = answers(&[]);
    open_with(s.port, &mut p, |m| {
        m.insert("readOnly".into(), true.into());
        m.insert("statementTimeoutMs".into(), 1500.5.into());
    })
    .await
    .unwrap();
    assert_eq!(
        s.state.lock().statements,
        ["SET statement_timeout = 1500", "SET default_transaction_read_only = on", "SHOW server_version"]
    );
}

#[tokio::test]
async fn simple_query_results_errors_notices_copy_and_stray_ready_for_query() {
    let s = start_fake(FakeOptions::default()).await;
    let (mut p, _) = answers(&[]);
    let mut c = open_with(s.port, &mut p, |_| {}).await.unwrap().client;
    let mut notices = Vec::new();
    let mut on_notice = |n: unimux_db::wire::pg::PgServerError| notices.push(n.message().to_owned());
    let r = c.simple_query("SELECT NULL, 'x'; SET a = 1; NOTICE; bad; SELECT 1", Some(&mut on_notice)).await.unwrap();
    assert_eq!(r.len(), 4);
    assert_eq!(r[0].rows, vec![vec![None, Some(b"x".to_vec())], vec![None, Some(b"y".to_vec())]]);
    assert_eq!(r[0].fields.as_ref().unwrap().iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(r[0].tag.as_deref(), Some("SELECT 2"));
    assert!(r[1].fields.is_none() && r[1].tag.as_deref() == Some("SET"));
    assert_eq!(r[2].tag.as_deref(), Some("DO"));
    assert_eq!(r[3].error.as_ref().unwrap().code(), "42601");
    assert_eq!(notices, ["hello"]);
    // transaction state from ReadyForQuery
    c.execute("BEGIN").await.unwrap();
    assert_eq!(c.tx(), TxStatus::Transaction);
    let r = c.simple_query("bad", None).await.unwrap();
    assert!(r[0].error.is_some());
    assert_eq!(c.tx(), TxStatus::Failed);
    c.execute("COMMIT").await.unwrap();
    assert_eq!(c.tx(), TxStatus::Idle);
    // COPY FROM STDIN is refused with node-postgres' text; COPY TO STDOUT is drained
    let r = c.simple_query("COPY t FROM STDIN", None).await.unwrap();
    let e = r[0].error.as_ref().unwrap();
    assert_eq!((e.code(), e.message()), ("57014", "COPY from stdin failed: No source stream defined"));
    let mut events = Collect::new(None);
    let ends = c.simple_query_with("COPY t TO STDOUT", &mut events).await.unwrap();
    assert!(ends[0].copy && ends[0].tag.as_deref() == Some("COPY 2") && events.rows.is_empty());
    // an extra ReadyForQuery does not end the next statement early
    c.execute("STRAY").await.unwrap();
    assert_eq!(c.query_value("SELECT 1", &[]).await.unwrap().as_deref(), Some("1"));
    assert_eq!(c.query_value("SELECT 1", &[]).await.unwrap().as_deref(), Some("1"));
    // an empty query
    let r = c.simple_query("", None).await.unwrap();
    assert_eq!(r.len(), 1);
    assert!(r[0].tag.is_none() && r[0].error.is_none());
    assert!(!c.is_broken());
    c.end().await;
}

async fn run_sleep(
    s: &Fake,
    password: Option<&'static str>,
) -> (unimux_db::pg::connect::PgTarget, tokio::task::JoinHandle<String>, unimux_db::wire::pg::BackendKey) {
    let (mut p, _) = answers(&[]);
    let c = config(s.port, |m| {
        if let Some(pw) = password {
            m.insert("password".into(), pw.into());
        }
    });
    let mut client = open(&TcpConnector::new("127.0.0.1", s.port), &c, Duration::from_secs(5), &mut p).await.unwrap().client;
    let key = client.key().unwrap().clone();
    let run = tokio::spawn(async move {
        let r = client.simple_query("SELECT pg_sleep(5); SELECT 1", None).await.unwrap();
        assert_eq!(r.len(), 1, "the rest of the run is skipped");
        let e = r[0].error.as_ref().map(|e| e.code().to_owned()).unwrap_or_default();
        assert_eq!(client.query_value("SELECT 1", &[]).await.unwrap().as_deref(), Some("1"), "the session goes on");
        e
    });
    for _ in 0..200 {
        if s.state.lock().sleeping.contains_key(&key.process_id) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    (c.target(Duration::from_secs(5)), run, key)
}

#[tokio::test]
async fn cancel_through_pg_cancel_backend_on_a_side_connection() {
    let s = start_fake(FakeOptions { auth: Auth::Md5, ..Default::default() }).await;
    let (target, run, key) = run_sleep(&s, Some("secret")).await;
    let pw = Zeroizing::new("secret".to_owned());
    assert!(cancel_backend(&TcpConnector::new("127.0.0.1", s.port), &target, Some(&pw), &key).await);
    assert_eq!(run.await.unwrap(), "57014");
    let g = s.state.lock();
    assert_eq!(g.cancels, [("function", 1000)]);
    assert_eq!(g.logins.len(), 2, "the side connection logged in with the session's password");
}

#[tokio::test]
async fn cancel_falls_back_to_the_protocol_cancel_request() {
    let s = start_fake(FakeOptions { max_logins: 1, ..Default::default() }).await;
    let (target, run, key) = run_sleep(&s, None).await;
    assert!(cancel_backend(&TcpConnector::new("127.0.0.1", s.port), &target, None, &key).await);
    assert_eq!(run.await.unwrap(), "57014");
    assert_eq!(s.state.lock().cancels, [("protocol", 1000)]);
}

/// A connector whose stream cannot be opened (an ended SSH tunnel).
struct DeadTunnel;

impl Connector for DeadTunnel {
    fn open(&self) -> BoxFuture<'_, Result<PgStream, ConnectError>> {
        Box::pin(async { Err(ConnectError::Tunnel("tunnel closed".into())) })
    }
    fn via_tunnel(&self) -> bool {
        true
    }
}

/// A connector over an in-memory stream that the "server" closes at once.
struct ClosedTunnel;

impl Connector for ClosedTunnel {
    fn open(&self) -> BoxFuture<'_, Result<PgStream, ConnectError>> {
        Box::pin(async {
            let (a, b) = tokio::io::duplex(64);
            drop(b);
            Ok(Box::new(a) as Box<dyn PgIo>)
        })
    }
    fn via_tunnel(&self) -> bool {
        true
    }
}

#[tokio::test]
async fn tunnel_errors_read_tunnel() {
    let c = config(1, |_| {});
    let (mut p, _) = answers(&[]);
    assert_eq!(open(&DeadTunnel, &c, Duration::from_secs(1), &mut p).await.unwrap_err().code, "tunnel");
    assert_eq!(open(&ClosedTunnel, &c, Duration::from_secs(1), &mut p).await.unwrap_err().code, "tunnel");
    let target = c.target(Duration::from_secs(1));
    assert!(matches!(connect_tls(&ClosedTunnel, &target, None).await, Err(ConnectError::Closed(_))));
}
