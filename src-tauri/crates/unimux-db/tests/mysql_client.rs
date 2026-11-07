//! D7: the MySQL / MariaDB client core (unimux_db::mysql) against an in-process fake server on the MySQL protocol: the
//! login paths (native, caching_sha2 fast path, auth switch, the refused clear password plugin), TLS (prefer fallback,
//! no check, verify-full with a CA and the host name), COM_QUERY results as events (rows, several results, errors,
//! LOAD DATA LOCAL), the session charset from session tracking, MyStream's take / more / drain, and the idle close watch.
//! Real servers (MySQL 8.4 / 9, MariaDB 11) are covered by tests/wire_servers.rs through scripts/spike-db-wire.mjs.

use std::sync::Arc;
use std::time::Duration;

use mysql_common::auth::plugins::caching_sha2_password::scramble_sha256;
use mysql_common::auth::plugins::mysql_native_password::scramble_native;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, duplex};
use unimux_db::mysql::{
    MyConn, MyError, MyEvent, MyLogin, MyOpenParams, MyStream, MyTlsMode, MyTlsParams, MyTlsVerify, map_connect_error, open,
};
use zeroize::Zeroizing;

const SCRAMBLE: [u8; 20] = *b"abcdefghijklmnopqrst";
const CLIENT_SSL: u32 = 0x800;
const QUERY_ATTRIBUTES: u32 = 1 << 27;
const SESSION_STATE_CHANGED: u16 = 0x4000;
const MORE_RESULTS: u16 = 0x0008;

// ── a fake server ──

async fn read_frame<S: AsyncRead + Unpin>(s: &mut S) -> (u8, Vec<u8>) {
    let mut h = [0u8; 4];
    s.read_exact(&mut h).await.unwrap();
    let len = usize::from(h[0]) | usize::from(h[1]) << 8 | usize::from(h[2]) << 16;
    let mut p = vec![0u8; len];
    s.read_exact(&mut p).await.unwrap();
    (h[3], p)
}

async fn write_frame<S: AsyncWrite + Unpin>(s: &mut S, seq: u8, p: &[u8]) {
    let mut out = vec![(p.len() & 0xff) as u8, (p.len() >> 8 & 0xff) as u8, (p.len() >> 16) as u8, seq];
    out.extend_from_slice(p);
    s.write_all(&out).await.unwrap();
    s.flush().await.unwrap();
}

fn lenenc_str(out: &mut Vec<u8>, s: &[u8]) {
    assert!(s.len() < 251);
    out.push(s.len() as u8);
    out.extend_from_slice(s);
}

fn hello(caps: u32, plugin: &str) -> Vec<u8> {
    let mut p = vec![10];
    p.extend_from_slice(b"8.0.36\0");
    p.extend_from_slice(&77u32.to_le_bytes());
    p.extend_from_slice(&SCRAMBLE[..8]);
    p.push(0);
    p.extend_from_slice(&(caps as u16).to_le_bytes());
    p.push(45);
    p.extend_from_slice(&2u16.to_le_bytes());
    p.extend_from_slice(&((caps >> 16) as u16).to_le_bytes());
    p.push(21);
    p.extend_from_slice(&[0u8; 10]);
    p.extend_from_slice(&SCRAMBLE[8..]);
    p.push(0);
    p.extend_from_slice(plugin.as_bytes());
    p.push(0);
    p
}

/// What the server read from a HandshakeResponse.
#[derive(Debug)]
struct Response {
    flags: u32,
    user: String,
    token: Vec<u8>,
    database: String,
    plugin: String,
}

fn cstr(b: &mut &[u8]) -> String {
    let n = b.iter().position(|&x| x == 0).unwrap();
    let s = String::from_utf8(b[..n].to_vec()).unwrap();
    *b = &b[n + 1..];
    s
}

fn parse_response(p: &[u8]) -> Response {
    let flags = u32::from_le_bytes(p[..4].try_into().unwrap());
    let mut b = &p[32..];
    let user = cstr(&mut b);
    let n = usize::from(b[0]);
    let token = b[1..1 + n].to_vec();
    b = &b[1 + n..];
    let database = cstr(&mut b);
    let plugin = cstr(&mut b);
    Response { flags, user, token, database, plugin }
}

fn ok(affected: u8, status: u16, state: Option<&[u8]>) -> Vec<u8> {
    let mut p = vec![0, affected, 0];
    let status = if state.is_some() { status | SESSION_STATE_CHANGED } else { status };
    p.extend_from_slice(&status.to_le_bytes());
    p.extend_from_slice(&0u16.to_le_bytes());
    if let Some(state) = state {
        p.push(0); // info ''
        lenenc_str(&mut p, state);
    }
    p
}

fn err(code: u16, state: &str, message: &str) -> Vec<u8> {
    let mut p = vec![0xff];
    p.extend_from_slice(&code.to_le_bytes());
    p.push(b'#');
    p.extend_from_slice(state.as_bytes());
    p.extend_from_slice(message.as_bytes());
    p
}

fn column(name: &str, charset: u16, kind: u8) -> Vec<u8> {
    let mut p = Vec::new();
    for s in ["def", "shop", "t", "t", name, name] {
        lenenc_str(&mut p, s.as_bytes());
    }
    p.push(0x0c);
    p.extend_from_slice(&charset.to_le_bytes());
    p.extend_from_slice(&255u32.to_le_bytes());
    p.push(kind);
    p.extend_from_slice(&[0, 0, 0, 0, 0]);
    p
}

fn eof(status: u16) -> Vec<u8> {
    let mut p = vec![0xfe, 0, 0];
    p.extend_from_slice(&status.to_le_bytes());
    p
}

fn row(cells: &[Option<&str>]) -> Vec<u8> {
    let mut p = Vec::new();
    for c in cells {
        match c {
            Some(s) => lenenc_str(&mut p, s.as_bytes()),
            None => p.push(0xfb),
        }
    }
    p
}

/// Writes packets with consecutive sequence ids starting at `seq`.
async fn send_all<S: AsyncWrite + Unpin>(s: &mut S, mut seq: u8, packets: &[Vec<u8>]) {
    for p in packets {
        write_frame(s, seq, p).await;
        seq = seq.wrapping_add(1);
    }
}

/// A result set of `n` rows of (n, label) in the text protocol, ending with `status`.
fn numbers(n: usize, status: u16) -> Vec<Vec<u8>> {
    let mut out = vec![vec![2], column("n", 63, 0x08), column("label", 45, 0xfd), eof(2)];
    for i in 1..=n {
        out.push(row(&[Some(&i.to_string()), Some(&format!("row {i}"))]));
    }
    out.push(eof(status));
    out
}

fn login(password: &str, database: &str) -> MyLogin {
    MyLogin { user: "root".into(), password: Zeroizing::new(password.into()), database: database.into() }
}

/// The server side of a native login (checks the token) on `s`; returns what the client sent.
async fn accept_native<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S, caps: u32, password: &str) -> Response {
    write_frame(s, 0, &hello(caps, "mysql_native_password")).await;
    let (seq, p) = read_frame(s).await;
    let r = parse_response(&p);
    let want = scramble_native(&SCRAMBLE, password.as_bytes()).map(|x| x.to_vec()).unwrap_or_default();
    if r.token == want {
        write_frame(s, seq + 1, &ok(0, 2, None)).await;
    } else {
        write_frame(s, seq + 1, &err(1045, "28000", "Access denied for user 'root'@'localhost' (using password: YES)")).await;
    }
    r
}

/// A MySQL 8 like server: every capability up to bit 27 (QUERY_ATTRIBUTES) except SSL; no multi-factor login.
const CAPS: u32 = 0x0fff_ffff & !CLIENT_SSL;
const MULTI_FACTOR: u32 = 1 << 28;

async fn connected(server: impl FnOnce(DuplexStream) -> tokio::task::JoinHandle<()>) -> MyConn<DuplexStream> {
    let (a, b) = duplex(1 << 20);
    let _task = server(b);
    MyConn::connect(a, &login("pw", "shop"), None).await.unwrap()
}

// ── logins ──

#[tokio::test]
async fn native_login_sends_mysql2s_flags_and_database() {
    let (a, mut b) = duplex(1 << 20);
    let srv = tokio::spawn(async move { accept_native(&mut b, CAPS, "pw").await });
    let c = MyConn::connect(a, &login("pw", "shop"), None).await.unwrap();
    let r = srv.await.unwrap();
    assert_eq!(r.flags, 0x08ba_f3cf);
    assert_eq!((r.user.as_str(), r.database.as_str(), r.plugin.as_str()), ("root", "shop", "mysql_native_password"));
    assert_eq!((c.server_version.as_str(), c.connection_id, c.tls), ("8.0.36", 77, false));
    assert_eq!(c.status, 2);
}

#[tokio::test]
async fn multi_factor_is_added_when_the_server_offers_it() {
    let (a, mut b) = duplex(1 << 20);
    let srv = tokio::spawn(async move { accept_native(&mut b, CAPS | MULTI_FACTOR, "pw").await });
    MyConn::connect(a, &login("pw", ""), None).await.unwrap();
    assert_eq!(srv.await.unwrap().flags, 0x08ba_f3cf | MULTI_FACTOR);
}

#[tokio::test]
async fn a_wrong_password_is_the_servers_1045() {
    let (a, mut b) = duplex(1 << 20);
    tokio::spawn(async move { accept_native(&mut b, CAPS, "secret").await });
    let e = MyConn::connect(a, &login("pw", ""), None).await.unwrap_err();
    assert_eq!(e.errno(), Some(1045));
    assert_eq!(map_connect_error(&e, false), "dbAuth");
}

#[tokio::test]
async fn caching_sha2_fast_path() {
    let (a, mut b) = duplex(1 << 20);
    let srv = tokio::spawn(async move {
        write_frame(&mut b, 0, &hello(CAPS, "caching_sha2_password")).await;
        let (seq, p) = read_frame(&mut b).await;
        let r = parse_response(&p);
        assert_eq!(r.plugin, "caching_sha2_password");
        assert_eq!(r.token, scramble_sha256(&SCRAMBLE, b"pw").unwrap().to_vec());
        send_all(&mut b, seq + 1, &[vec![0x01, 0x03], ok(0, 2, None)]).await;
    });
    let c = MyConn::connect(a, &login("pw", "shop"), None).await.unwrap();
    srv.await.unwrap();
    assert_eq!(c.login.cache_state, Some(3));
}

#[tokio::test]
async fn an_auth_switch_gets_the_new_scramble_and_clear_password_is_refused() {
    let fresh = *b"ABCDEFGHIJKLMNOPQRST";
    let (a, mut b) = duplex(1 << 20);
    let srv = tokio::spawn(async move {
        write_frame(&mut b, 0, &hello(CAPS, "client_unknown")).await;
        let (seq, p) = read_frame(&mut b).await;
        // an unknown server plugin: mysql2 answers with a native token
        assert_eq!(parse_response(&p).plugin, "mysql_native_password");
        let mut switch = vec![0xfe];
        switch.extend_from_slice(b"mysql_native_password\0");
        switch.extend_from_slice(&fresh);
        switch.push(0);
        write_frame(&mut b, seq + 1, &switch).await;
        let (seq, token) = read_frame(&mut b).await;
        assert_eq!(token, scramble_native(&fresh, b"pw").unwrap().to_vec());
        write_frame(&mut b, seq + 1, &ok(0, 2, None)).await;
    });
    let c = MyConn::connect(a, &login("pw", ""), None).await.unwrap();
    srv.await.unwrap();
    assert_eq!(c.login.switched_to.as_deref(), Some("mysql_native_password"));

    let (a, mut b) = duplex(1 << 20);
    tokio::spawn(async move {
        write_frame(&mut b, 0, &hello(CAPS, "mysql_native_password")).await;
        let (seq, _) = read_frame(&mut b).await;
        write_frame(&mut b, seq + 1, b"\xfemysql_clear_password\0").await;
        let _ = read_frame(&mut b).await;
    });
    let e = MyConn::connect(a, &login("pw", ""), None).await.unwrap_err();
    assert!(matches!(&e, MyError::Auth(m) if m.contains("mysql_clear_password")), "{e:?}");
    assert_eq!(map_connect_error(&e, false), "dbFailed");
}

// ── TLS ──

fn params(tls: MyTlsMode, ca: Option<String>, host: &str) -> MyOpenParams {
    MyOpenParams { host: host.into(), tls, ca, login: login("pw", "shop"), connect_timeout: Duration::from_secs(10) }
}

#[tokio::test]
async fn prefer_falls_back_to_plain_and_require_fails() {
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let n = attempts.clone();
    let factory = move || {
        n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (a, mut b) = duplex(1 << 20);
        tokio::spawn(async move {
            // a server without TLS: the client hangs up at once when it wants TLS
            write_frame(&mut b, 0, &hello(CAPS, "mysql_native_password")).await;
            let mut h = [0u8; 4];
            if b.read_exact(&mut h).await.is_ok() {
                let len = usize::from(h[0]) | usize::from(h[1]) << 8;
                let mut p = vec![0u8; len];
                b.read_exact(&mut p).await.unwrap();
                write_frame(&mut b, h[3] + 1, &ok(0, 2, None)).await;
            }
        });
        async move { Ok::<_, MyError>(a) }
    };
    let (c, tls) = open(&params(MyTlsMode::Prefer, None, "127.0.0.1"), factory.clone()).await.unwrap();
    assert!(!tls && !c.tls);
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    let e = open(&params(MyTlsMode::Require, None, "127.0.0.1"), factory).await.unwrap_err();
    assert_eq!(e, MyError::TlsUnsupported);
    assert_eq!(map_connect_error(&e, false), "dbTlsUnsupported");
}

/// A server with TLS (a certificate for `names`): SSL request, TLS handshake, then a native login.
fn tls_server(names: Vec<String>) -> (String, impl Fn() -> DuplexStream) {
    let ck = rcgen::generate_simple_self_signed(names).unwrap();
    let ca = ck.cert.pem();
    let chain = vec![ck.cert.der().clone()];
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(ck.signing_key.serialize_der().into());
    let config = Arc::new(
        rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .unwrap(),
    );
    let start = move || {
        let (a, mut b) = duplex(1 << 20);
        let acceptor = tokio_rustls::TlsAcceptor::from(config.clone());
        tokio::spawn(async move {
            write_frame(&mut b, 0, &hello(CAPS | CLIENT_SSL, "mysql_native_password")).await;
            let (seq, req) = read_frame(&mut b).await;
            assert_eq!(seq, 1);
            assert_eq!(req.len(), 32);
            assert_ne!(u32::from_le_bytes(req[..4].try_into().unwrap()) & CLIENT_SSL, 0);
            let Ok(mut t) = acceptor.accept(b).await else { return };
            let (seq, p) = read_frame(&mut t).await;
            assert_eq!(seq, 2);
            let r = parse_response(&p);
            assert_eq!(r.token, scramble_native(&SCRAMBLE, b"pw").unwrap().to_vec());
            write_frame(&mut t, seq + 1, &ok(0, 2, None)).await;
            let _ = t.read(&mut [0u8; 16]).await;
        });
        a
    };
    (ca, start)
}

#[tokio::test]
async fn tls_without_check_and_verify_full_with_the_host_name() {
    let (ca, start) = tls_server(vec!["localhost".into()]);
    let stream = || {
        let s = start();
        async move { Ok::<_, MyError>(s) }
    };
    // require: no certificate check
    let (c, tls) = open(&params(MyTlsMode::Require, None, "127.0.0.1"), stream).await.unwrap();
    assert!(tls && c.tls);
    // verify-full: the CA and the name match
    let (_, tls) = open(&params(MyTlsMode::VerifyFull, Some(ca.clone()), "localhost"), stream).await.unwrap();
    assert!(tls);
    // verify-full against an IP address the certificate does not name
    let e = open(&params(MyTlsMode::VerifyFull, Some(ca), "127.0.0.1"), stream).await.unwrap_err();
    assert_eq!(map_connect_error(&e, false), "dbTls", "{e:?}");
    // verify-full with another CA
    let (other, _) = tls_server(vec!["localhost".into()]);
    let e = open(&params(MyTlsMode::VerifyFull, Some(other), "localhost"), stream).await.unwrap_err();
    assert_eq!(map_connect_error(&e, false), "dbTls", "{e:?}");
}

#[tokio::test]
async fn the_connect_timeout_covers_the_login() {
    let factory = || {
        let (a, b) = duplex(1024);
        // a server that never says hello
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(b);
        });
        async move { Ok::<_, MyError>(a) }
    };
    let mut p = params(MyTlsMode::Disable, None, "127.0.0.1");
    p.connect_timeout = Duration::from_millis(100);
    let e = open(&p, factory).await.unwrap_err();
    assert_eq!(e, MyError::Timeout);
    assert_eq!(map_connect_error(&e, false), "dbTimeout");
}

// ── queries ──

#[tokio::test]
async fn rows_results_and_errors_as_events() {
    let mut c = connected(|mut b| {
        tokio::spawn(async move {
            accept_native(&mut b, CAPS, "pw").await;
            // 1: a select
            let (_, q) = read_frame(&mut b).await;
            assert_eq!(&q[..3], &[0x03, 0x00, 0x01], "COM_QUERY with the empty query-attribute prefix");
            assert_eq!(&q[3..], b"SELECT * FROM numbers");
            send_all(&mut b, 1, &numbers(2, 2)).await;
            // 2: a CALL with a set and its OK (in a transaction)
            let (_, _) = read_frame(&mut b).await;
            let mut call = numbers(1, 2 | MORE_RESULTS);
            call.push(ok(0, 3, None));
            send_all(&mut b, 1, &call).await;
            // 3: an error
            let (_, _) = read_frame(&mut b).await;
            send_all(&mut b, 1, &[err(1146, "42S02", "Table 'shop.nope' doesn't exist")]).await;
            // 4: LOAD DATA LOCAL
            let (_, _) = read_frame(&mut b).await;
            send_all(&mut b, 1, &[[&[0xfb][..], b"/etc/passwd"].concat()]).await;
            let (seq, empty) = read_frame(&mut b).await;
            assert!(empty.is_empty());
            write_frame(&mut b, seq + 1, &ok(1, 2, None)).await;
            let _ = b.read(&mut [0u8; 16]).await;
        })
    })
    .await;

    c.start_query("SELECT * FROM numbers").await.unwrap();
    assert_eq!(c.start_query("SELECT 1").await.unwrap_err(), MyError::Busy);
    let mut events = Vec::new();
    while let Some(ev) = c.next_event().await.unwrap() {
        events.push(ev);
    }
    let MyEvent::Fields(cols) = &events[0] else { panic!("{events:?}") };
    assert_eq!(cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["n", "label"]);
    let MyEvent::Row(r) = &events[1] else { panic!() };
    assert_eq!(r.to_vec(), vec![Some(b"1".to_vec()), Some(b"row 1".to_vec())]);
    assert!(matches!(events[3], MyEvent::SetEnd { status: 2, .. }));
    assert_eq!(events.len(), 4);

    let call = c.exec("CALL p()").await.unwrap();
    assert_eq!(call.rows.len(), 1);
    assert!(call.header.unwrap().in_transaction());
    assert!(c.in_transaction() && c.is_idle());

    let e = c.exec("SELECT * FROM nope").await.unwrap_err();
    let s = unimux_db::mysql::server_error(&e).unwrap();
    assert_eq!(
        s.to_json(),
        r#"{"message":"ERROR 1146 (42S02): Table 'shop.nope' doesn't exist","code":"42S02","severity":"ERROR"}"#
    );

    let results = c.query_all("LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE t").await.unwrap();
    assert!(matches!(&results[..], [unimux_db::mysql::MyResult::ClientError(m)] if m.contains("/etc/passwd file")));
    assert!(c.is_idle());
}

#[tokio::test]
async fn the_session_charset_follows_session_tracking() {
    let mut c = connected(|mut b| {
        tokio::spawn(async move {
            accept_native(&mut b, CAPS, "pw").await;
            let (_, _) = read_frame(&mut b).await;
            // one session-state entry: type 0 (system variable), its data (name, value)
            let mut data = Vec::new();
            lenenc_str(&mut data, b"character_set_client");
            lenenc_str(&mut data, b"cp1250");
            let mut var = vec![0u8, data.len() as u8];
            var.extend(data);
            send_all(&mut b, 1, &[ok(0, 2, Some(&var))]).await;
            let (_, q) = read_frame(&mut b).await;
            // "SELECT 'ł'" in cp1250: ł is 0xb3
            assert_eq!(&q[3..], b"SELECT '\xb3'");
            send_all(&mut b, 1, &[ok(0, 2, None)]).await;
            let _ = b.read(&mut [0u8; 16]).await;
        })
    })
    .await;
    c.exec("SET NAMES cp1250").await.unwrap();
    assert_eq!(c.client_charset, 26);
    c.exec("SELECT 'ł'").await.unwrap();
}

#[tokio::test]
async fn my_stream_takes_batches_and_drains_the_rest() {
    let mut c = connected(|mut b| {
        tokio::spawn(async move {
            accept_native(&mut b, CAPS, "pw").await;
            let (_, _) = read_frame(&mut b).await;
            send_all(&mut b, 1, &numbers(25, 2)).await;
            let (_, _) = read_frame(&mut b).await;
            send_all(&mut b, 1, &numbers(5, 2)).await;
            let (_, _) = read_frame(&mut b).await;
            send_all(&mut b, 1, &[ok(3, 2, None)]).await;
            let _ = b.read(&mut [0u8; 16]).await;
        })
    })
    .await;
    let mut s = MyStream::start(&mut c, "SELECT * FROM numbers").await.unwrap();
    let first = s.take(&mut c, 10).await.unwrap();
    assert_eq!(first.len(), 10);
    assert_eq!(s.fields.as_ref().unwrap().len(), 2);
    assert!(s.more(&mut c).await);
    assert_eq!(s.take(&mut c, 10).await.unwrap()[0].get(0), Some(&b"11"[..]));
    assert!(s.drain(&mut c, Duration::from_secs(5)).await);
    assert!(c.is_idle());

    let mut s = MyStream::start(&mut c, "SELECT * FROM numbers").await.unwrap();
    assert_eq!(s.take(&mut c, 100).await.unwrap().len(), 5);
    assert!(!s.more(&mut c).await && s.done);

    let mut s = MyStream::start(&mut c, "UPDATE t SET a = 1").await.unwrap();
    assert!(s.take(&mut c, 10).await.unwrap().is_empty());
    assert_eq!(s.header.as_ref().unwrap().affected_rows, 3);
    assert!(s.fields.is_none());
}

#[tokio::test]
async fn an_idle_connection_reports_the_servers_goodbye() {
    let mut c = connected(|mut b| {
        tokio::spawn(async move {
            accept_native(&mut b, CAPS, "pw").await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            write_frame(&mut b, 0, &err(4031, "HY000", "The client was disconnected by the server because of inactivity.")).await;
            drop(b);
        })
    })
    .await;
    let e = c.closed().await;
    assert_eq!(e.errno(), Some(4031));
    assert!(c.broken().is_some());
    assert!(c.start_query("SELECT 1").await.is_err());
}

#[tokio::test]
async fn a_query_in_an_unknown_encoding_is_refused_before_sending() {
    let mut c = connected(|mut b| {
        tokio::spawn(async move {
            accept_native(&mut b, CAPS & !QUERY_ATTRIBUTES, "pw").await;
            let (_, q) = read_frame(&mut b).await;
            // no query attributes on the server: no prefix
            assert_eq!(q, b"\x03SET NAMES dec8");
            let mut data = Vec::new();
            lenenc_str(&mut data, b"character_set_client");
            lenenc_str(&mut data, b"dec8");
            let mut var = vec![0u8, data.len() as u8];
            var.extend(data);
            send_all(&mut b, 1, &[ok(0, 2, Some(&var))]).await;
            let _ = b.read(&mut [0u8; 16]).await;
        })
    })
    .await;
    c.exec("SET NAMES dec8").await.unwrap();
    let e = c.start_query("SELECT 1").await.unwrap_err();
    assert_eq!(e, MyError::Encoding("Encoding not recognized: 'dec8' (searched as: 'dec8')".into()));
    assert!(c.is_idle() && c.broken().is_none());
}

#[tokio::test]
async fn tls_params_are_plain_data() {
    let p = MyTlsParams { host: "db".into(), verify: MyTlsVerify::Off };
    assert_eq!(p.clone(), p);
}
