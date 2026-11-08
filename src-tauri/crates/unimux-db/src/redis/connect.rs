//! Opening Redis connections (1.1.4 `openRedis` and the ioredis client it configured) over the own RESP2 connection
//! ([`crate::wire::redis::RedisConn`]).
//!
//! [`Dialer`] makes the stream: TCP (DNS, keep-alive 15 s, no delay) or the SSH tunnel's forwarded channel, then TLS on top
//! when wanted, all within the connect timeout. [`open_redis`] runs the 1.1.4 connect sequence (`auth [user] pw` and
//! `client setname unimux` as ioredis' handshake, then `ping`, `select n` for n > 0 and `info server`), maps failures to the
//! fixed error codes ([`ConnectError`]) and gives a [`RedisClient`].
//!
//! [`RedisClient`] is what the ioredis client object was: it outlives the physical connection. A drop fails every pending
//! command and nothing is sent again (`maxRetriesPerRequest: 0`, `autoResendUnfulfilledCommands: false`); commands while
//! there is no connection fail at once (`enableOfflineQueue: false`). The retry decision belongs to the owner
//! ([`RedisClient::set_retry`], off until set: a failed first connect never retries). A reconnect runs the handshake again
//! and then selects the DB the dropped connection had selected (ioredis readyHandler), then reports `Ready`; when no attempt
//! is left the client reports `End` and stays closed.

use std::future::Future;
use std::io;
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use super::data::text;
use super::tls::{TlsSetup, client_config};
use crate::redis_shared::parse_info;
use crate::wire::redis::{CallError, PushFn, Raw, RedisConn};

/// Any connected byte stream (TCP, TLS, the SSH tunnel's channel).
pub trait RedisStream: AsyncRead + AsyncWrite + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> RedisStream for T {}
pub type BoxStream = Box<dyn RedisStream>;

/// Opens one forwarded channel of the session's SSH tunnel (D2); every connect and reconnect asks for a new one.
pub type StreamSource = Arc<dyn Fn() -> BoxFuture<'static, io::Result<BoxStream>> + Send + Sync>;

/// A connect failure as the fixed codes the UI shows (`RedisConnectError`). `server_message`: the server's own text, or the
/// TLS library's reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectError {
    pub code: &'static str,
    pub server_message: Option<String>,
}

impl ConnectError {
    pub fn new(code: &'static str) -> Self {
        Self { code, server_message: None }
    }

    fn with(code: &'static str, message: String) -> Self {
        Self { code, server_message: Some(message) }
    }
}

/// `message.slice(0, n)` in UTF-16 units.
pub(crate) fn js_head(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_owned();
    }
    unimux_core::utf16::slice(s, 0, n)
}

fn contains_ci(hay: &str, needle: &str) -> bool {
    hay.to_ascii_lowercase().contains(&needle.to_ascii_lowercase())
}

/// The first word of a server error (`/^([A-Z][A-Z_-]*) /`).
pub fn server_code(message: &str) -> Option<String> {
    let b = message.as_bytes();
    if !b.first().is_some_and(u8::is_ascii_uppercase) {
        return None;
    }
    let end = b.iter().position(|c| !(c.is_ascii_uppercase() || *c == b'_' || *c == b'-')).unwrap_or(b.len());
    (b.get(end) == Some(&b' ')).then(|| message[..end].to_owned())
}

/// `mapRedisConnectError` of a server error reply.
pub fn map_server_error(message: &str) -> ConnectError {
    let m = js_head(message, 4000);
    if m.starts_with("NOAUTH") {
        return ConnectError::with("dbAuth", m);
    }
    let lower = m.to_ascii_lowercase();
    if lower.starts_with("wrongpass") || lower.contains("invalid password") || lower.contains("invalid username-password") {
        return ConnectError::with("dbAuth", m);
    }
    if contains_ci(&m, "DB index is out of range") {
        return ConnectError::with("dbNoDatabase", m);
    }
    ConnectError::with("dbFailed", m)
}

/// `mapRedisConnectError` of a socket / TLS error.
pub fn map_io_error(e: &io::Error, via_tunnel: bool) -> ConnectError {
    use io::ErrorKind as K;
    let message = e.to_string();
    if e.get_ref().is_some_and(|inner| inner.is::<rustls::Error>()) {
        return ConnectError::with("dbTls", js_head(&message, 500));
    }
    match e.kind() {
        K::ConnectionRefused => return ConnectError::new(if via_tunnel { "tunnel" } else { "dbRefused" }),
        K::TimedOut => return ConnectError::new("dbTimeout"),
        _ => {}
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") || lower.contains("time out") {
        return ConnectError::new("dbTimeout");
    }
    if lower.contains("certificate")
        || message.contains("SSL")
        || message.contains("TLS")
        || lower.contains("wrong version number")
    {
        return ConnectError::with("dbTls", js_head(&message, 500));
    }
    if matches!(e.kind(), K::ConnectionReset | K::BrokenPipe | K::ConnectionAborted | K::UnexpectedEof) {
        return ConnectError::new(if via_tunnel { "tunnel" } else { "dbClosed" });
    }
    let m = js_head(&message, 500);
    ConnectError { code: "dbFailed", server_message: (!m.is_empty()).then_some(m) }
}

/// The connection closed under a command ("Connection is closed.": dbClosed, or tunnel through SSH).
fn closed(via_tunnel: bool) -> ConnectError {
    ConnectError::new(if via_tunnel { "tunnel" } else { "dbClosed" })
}

/// How a connection's stream is made.
#[derive(Clone)]
pub struct Dialer {
    /// Direct: the server; through SSH: the address the SSH server connects to (only the TLS name is used then).
    pub host: String,
    pub port: u16,
    /// The name the certificate is checked against (the host the user typed).
    pub logical_host: String,
    pub tls: Option<TlsSetup>,
    /// Through SSH: the forwarded channel (no local port exists that anything else could connect to).
    pub tunnel: Option<StreamSource>,
    pub connect_timeout_ms: u64,
}

impl Dialer {
    pub fn via_tunnel(&self) -> bool {
        self.tunnel.is_some()
    }

    /// The connected stream (TLS done), within the connect timeout.
    pub async fn dial(&self) -> Result<BoxStream, ConnectError> {
        let t = Duration::from_millis(self.connect_timeout_ms.max(1));
        match tokio::time::timeout(t, self.dial_inner()).await {
            Ok(r) => r,
            Err(_) => Err(ConnectError::new("dbTimeout")),
        }
    }

    async fn dial_inner(&self) -> Result<BoxStream, ConnectError> {
        let via = self.via_tunnel();
        let base: BoxStream = match &self.tunnel {
            Some(open) => open().await.map_err(|e| {
                // the tunnel is gone or the SSH server could not reach the database
                let m = map_io_error(&e, true);
                if m.code == "dbFailed" { ConnectError::new("tunnel") } else { m }
            })?,
            None => Box::new(self.tcp().await?),
        };
        let Some(setup) = &self.tls else { return Ok(base) };
        let (config, name) =
            client_config(setup, &self.logical_host).map_err(|m| ConnectError::with("dbTls", js_head(&m, 500)))?;
        let tls = tokio_rustls::TlsConnector::from(config).connect(name, base).await.map_err(|e| map_io_error(&e, via))?;
        Ok(Box::new(tls))
    }

    async fn tcp(&self) -> Result<TcpStream, ConnectError> {
        let host = self.host.trim_start_matches('[').trim_end_matches(']');
        let addrs: Vec<_> = tokio::net::lookup_host((host, self.port)).await.map_err(|_| ConnectError::new("dbDns"))?.collect();
        if addrs.is_empty() {
            return Err(ConnectError::new("dbDns"));
        }
        let mut last = None;
        for a in addrs {
            match TcpStream::connect(a).await {
                Ok(s) => {
                    let _ = s.set_nodelay(true);
                    let ka = socket2::TcpKeepalive::new().with_time(Duration::from_secs(15));
                    let _ = socket2::SockRef::from(&s).set_tcp_keepalive(&ka);
                    return Ok(s);
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.map_or_else(|| ConnectError::new("dbRefused"), |e| map_io_error(&e, false)))
    }
}

/// The login and stream of one logical connection (main, console or Pub/Sub).
#[derive(Clone)]
pub struct ClientOptions {
    pub dialer: Dialer,
    /// ACL user (empty: the default user).
    pub user: String,
    pub password: Option<Zeroizing<String>>,
}

impl ClientOptions {
    fn via_tunnel(&self) -> bool {
        self.dialer.via_tunnel()
    }
}

fn argv(parts: &[Vec<u8>]) -> Vec<&[u8]> {
    parts.iter().map(Vec::as_slice).collect()
}

/// ioredis' `handleAuthError`: a password the server does not need is only warned about.
fn auth_error_ignored(m: &str) -> bool {
    m.contains("no password is set")
        || m.contains("without any password configured for the default user")
        || m.contains("wrong number of arguments for 'auth' command")
}

/// The handshake on a new stream (ioredis connectHandler with protocol 2: `auth`, then `client setname unimux` whose
/// errors are ignored, sent together).
async fn handshake(conn: &RedisConn, o: &ClientOptions) -> Result<(), ConnectError> {
    let via = o.via_tunnel();
    let auth = o.password.as_ref().map(|pw| {
        let mut a: Vec<Vec<u8>> = vec![b"auth".to_vec()];
        if !o.user.is_empty() {
            a.push(o.user.as_bytes().to_vec());
        }
        a.push(pw.as_bytes().to_vec());
        let f = conn.enqueue(&argv(&a));
        // the copy of the password in the argument list goes now; the encoded command is in the driver's queue only
        for x in &mut a {
            zeroize::Zeroize::zeroize(x);
        }
        f
    });
    let setname = conn.enqueue(&[b"client", b"setname", b"unimux"]);
    if let Some(auth) = auth {
        match auth.await {
            Ok(Raw::Error(m)) if !auth_error_ignored(&m) => return Err(map_server_error(&m)),
            Ok(_) => {}
            Err(_) => return Err(closed(via)),
        }
    }
    setname.await.map_err(|_| closed(via))?;
    Ok(())
}

/// A connected client and what the connect learned.
pub struct Opened {
    pub client: RedisClient,
    pub server_version: Option<String>,
}

/// `openRedis`: connects, checks the login (PING answers NOAUTH when a password is needed), selects the DB and reads the
/// version. The whole sequence is bounded by the connect timeout plus 2 s (`dbTimeout`).
pub async fn open_redis(o: ClientOptions, db_index: u32) -> Result<Opened, ConnectError> {
    let limit = Duration::from_millis(o.dialer.connect_timeout_ms + 2000);
    match tokio::time::timeout(limit, open_inner(o, db_index)).await {
        Ok(r) => r,
        Err(_) => Err(ConnectError::new("dbTimeout")),
    }
}

async fn open_inner(o: ClientOptions, db_index: u32) -> Result<Opened, ConnectError> {
    let via = o.via_tunnel();
    let stream = o.dialer.dial().await?;
    let conn = RedisConn::start(stream);
    handshake(&conn, &o).await?;
    match conn.call(&[b"ping"]).await {
        // An ACL user may lack PING (unusual); only a missing login is a failure here.
        Ok(Raw::Error(m)) if m.starts_with("NOAUTH") || m.starts_with("WRONGPASS") => return Err(map_server_error(&m)),
        Ok(_) => {}
        Err(_) => return Err(closed(via)),
    }
    if db_index != 0 {
        match conn.call(&[b"select", db_index.to_string().as_bytes()]).await {
            Ok(Raw::Error(m)) => return Err(map_server_error(&m)),
            Ok(_) => {}
            Err(_) => return Err(closed(via)),
        }
    }
    let mut server_version = None;
    if let Ok(v @ Raw::Bytes(_)) = conn.call(&[b"info", b"server"]).await {
        let info = parse_info(&text(&v));
        // new Map(entries): the last of a repeated name wins
        let get =
            |k: &str| info.iter().flat_map(|s| s.entries.iter()).filter(|(n, _)| n == k).map(|(_, v)| v.clone()).next_back();
        let v = match get("valkey_version").filter(|v| !v.is_empty()) {
            Some(v) => Some(format!("Valkey {v}")),
            None => get("redis_version").filter(|v| !v.is_empty()),
        };
        server_version = v.map(|v| js_head(&v, 200));
    }
    if conn.is_ended() {
        return Err(closed(via));
    }
    let client = RedisClient::new(o, conn, db_index);
    Ok(Opened { client, server_version })
}

/// What a client reports (ioredis' `ready` after a reconnect, `end` once it is closed for good).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientEvent {
    Ready,
    End,
}

/// The owner's retry decision: the delay before attempt n, or None to give up (ioredis `retryStrategy`).
pub type RetryFn = Arc<dyn Fn(u32) -> Option<u64> + Send + Sync>;
pub type EventFn = Arc<dyn Fn(ClientEvent) + Send + Sync>;

struct State {
    conn: Option<Arc<RedisConn>>,
    /// Changes with every installed connection: a close of an older one is ignored.
    epoch: u64,
    /// Closed for good.
    ended: bool,
    /// `disconnect()` asked: the next close ends the client.
    manual: bool,
    /// ioredis `condition.select`: the last DB a `select` command named.
    selected: u32,
    /// ioredis `prevCondition.select`: kept from the connection that dropped while ready, selected again after a reconnect.
    prev_select: Option<u32>,
    attempts: u32,
    retry: Option<RetryFn>,
    listeners: Vec<EventFn>,
    last_error: Option<ConnectError>,
    reconnect: Option<JoinHandle<()>>,
    /// The Pub/Sub messages' receiver, put on every connection this client installs.
    push: Option<PushFn>,
}

struct Inner {
    opts: ClientOptions,
    state: Mutex<State>,
}

/// One logical Redis connection (see the module text).
#[derive(Clone)]
pub struct RedisClient {
    inner: Arc<Inner>,
}

/// A reply that never came: the connection dropped, was not there, or the server answered with an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CmdError {
    /// A server error reply (ReplyError.message).
    Reply(String),
    /// No reply (dropped, not writable).
    Conn(CallError),
}

impl RedisClient {
    fn new(opts: ClientOptions, conn: RedisConn, selected: u32) -> RedisClient {
        let inner = Arc::new(Inner {
            opts,
            state: Mutex::new(State {
                conn: None,
                epoch: 0,
                ended: false,
                manual: false,
                selected,
                prev_select: None,
                attempts: 0,
                retry: None,
                listeners: Vec::new(),
                last_error: None,
                reconnect: None,
                push: None,
            }),
        });
        Inner::install(&inner, conn);
        RedisClient { inner }
    }

    /// Sends a command now (in call order, pipelined) and gives its reply; a server error is `Err(Reply)`.
    pub fn call(&self, args: &[&[u8]]) -> impl Future<Output = Result<Raw, CmdError>> + Send + use<> {
        self.call_n(args, 1)
    }

    /// Like [`RedisClient::call`] for a command answered with `replies` replies (the Pub/Sub (un)subscribe commands: one
    /// confirmation per name); the reply is the last one.
    pub fn call_n(&self, args: &[&[u8]], replies: usize) -> impl Future<Output = Result<Raw, CmdError>> + Send + use<> {
        // ioredis takes the DB of a `select` as the one to select again after a reconnect as soon as it sends it, also when
        // the server refuses it (a reconnect then selected a DB the session never was on, while it kept browsing its own).
        // Here only a select the server accepted on the current connection counts.
        let select = args
            .first()
            .is_some_and(|n| n.eq_ignore_ascii_case(b"select"))
            .then(|| args.get(1).and_then(|a| std::str::from_utf8(a).ok()).and_then(|a| a.parse::<u32>().ok()))
            .flatten();
        let (conn, epoch) = {
            let st = self.inner.state.lock();
            (st.conn.clone(), st.epoch)
        };
        let f = conn.map(|c| c.enqueue_n(args, replies));
        let inner = Arc::downgrade(&self.inner);
        async move {
            match f {
                None => Err(CmdError::Conn(CallError::NotWritable)),
                Some(f) => match f.await {
                    Ok(Raw::Error(m)) => Err(CmdError::Reply(m)),
                    Ok(v) => {
                        if let (Some(db), Some(inner)) = (select, inner.upgrade()) {
                            let mut st = inner.state.lock();
                            if st.epoch == epoch && st.conn.is_some() {
                                st.selected = db;
                            }
                        }
                        Ok(v)
                    }
                    Err(e) => Err(CmdError::Conn(e)),
                },
            }
        }
    }

    /// Like [`RedisClient::call`] with owned arguments.
    pub fn call_vec(&self, args: &[Vec<u8>]) -> impl Future<Output = Result<Raw, CmdError>> + Send + use<> {
        self.call(&argv(args))
    }

    /// Where the server's Pub/Sub messages go (this connection and every reconnect).
    pub fn set_push(&self, f: Option<PushFn>) {
        let conn = {
            let mut st = self.inner.state.lock();
            st.push = f.clone();
            st.conn.clone()
        };
        if let Some(c) = conn {
            c.set_push(f);
        }
    }

    /// Turns the retry on (with the owner's decision) or off.
    pub fn set_retry(&self, retry: Option<RetryFn>) {
        self.inner.state.lock().retry = retry;
    }

    pub fn on_event(&self, f: EventFn) {
        self.inner.state.lock().listeners.push(f);
    }

    /// The last connect error a reconnect attempt met (ioredis' last `error` event).
    pub fn last_error(&self) -> Option<ConnectError> {
        self.inner.state.lock().last_error.clone()
    }

    pub fn is_connected(&self) -> bool {
        self.inner.state.lock().conn.as_ref().is_some_and(|c| !c.is_ended())
    }

    pub fn is_ended(&self) -> bool {
        self.inner.state.lock().ended
    }

    pub fn via_tunnel(&self) -> bool {
        self.inner.opts.via_tunnel()
    }

    /// Identifies the client (two clones of one client have the same id).
    pub fn id(&self) -> usize {
        Arc::as_ptr(&self.inner) as *const () as usize
    }

    /// `disconnect(reconnect)`: false closes for good (an `End` follows when a connection was up); true drops the current
    /// connection so the retry decision runs as for any drop (the session's watchdog).
    pub fn disconnect(&self, reconnect: bool) {
        let conn = {
            let mut st = self.inner.state.lock();
            if !reconnect {
                st.manual = true;
                st.retry = None;
                if let Some(t) = st.reconnect.take() {
                    t.abort();
                }
                if st.conn.is_none() {
                    st.ended = true;
                }
            }
            st.conn.clone()
        };
        if let Some(c) = conn {
            c.close();
        }
    }
}

impl Inner {
    fn install(me: &Arc<Inner>, conn: RedisConn) {
        let conn = Arc::new(conn);
        let mut ended = conn.ended();
        let epoch = {
            let mut st = me.state.lock();
            conn.set_push(st.push.clone());
            st.epoch += 1;
            st.conn = Some(conn);
            st.epoch
        };
        let weak = Arc::downgrade(me);
        tokio::spawn(async move {
            let _ = ended.wait_for(|e| *e).await;
            if let Some(me) = weak.upgrade() {
                Inner::closed(&me, epoch);
            }
        });
    }

    fn emit(me: &Arc<Inner>, ev: ClientEvent) {
        let listeners = me.state.lock().listeners.clone();
        for l in listeners {
            l(ev);
        }
    }

    /// ioredis closeHandler.
    fn closed(me: &Arc<Inner>, epoch: u64) {
        {
            let mut st = me.state.lock();
            if st.epoch != epoch || st.conn.is_none() {
                return;
            }
            st.conn = None;
            if st.prev_select.is_none() {
                st.prev_select = Some(st.selected);
            }
        }
        Inner::after_close(me);
    }

    /// The retry decision after a close (or a failed attempt): the next attempt is scheduled, or the client ends.
    fn after_close(me: &Arc<Inner>) {
        let (attempt, retry) = {
            let mut st = me.state.lock();
            if st.ended {
                return;
            }
            if st.manual {
                st.ended = true;
                drop(st);
                Inner::emit(me, ClientEvent::End);
                return;
            }
            st.attempts += 1;
            (st.attempts, st.retry.clone())
        };
        // the decision runs outside the lock: it reports to the session's owner
        let delay = retry.and_then(|f| f(attempt));
        let mut st = me.state.lock();
        if st.ended || st.manual {
            let manual = st.manual;
            st.ended = true;
            drop(st);
            if manual {
                Inner::emit(me, ClientEvent::End);
            }
            return;
        }
        let Some(delay) = delay else {
            st.ended = true;
            drop(st);
            Inner::emit(me, ClientEvent::End);
            return;
        };
        let weak: Weak<Inner> = Arc::downgrade(me);
        st.reconnect = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let Some(me) = weak.upgrade() else { return };
            Inner::attempt(&me).await;
        }));
    }

    async fn attempt(me: &Arc<Inner>) {
        let opts = me.opts.clone();
        let via = opts.via_tunnel();
        let r = async {
            let stream = opts.dialer.dial().await?;
            let conn = RedisConn::start(stream);
            let t = Duration::from_millis(opts.dialer.connect_timeout_ms.max(1));
            match tokio::time::timeout(t, handshake(&conn, &opts)).await {
                Ok(Ok(())) => Ok(conn),
                Ok(Err(e)) => Err(e),
                Err(_) => Err(ConnectError::new("dbTimeout")),
            }
        }
        .await;
        match r {
            Ok(conn) => {
                {
                    let mut st = me.state.lock();
                    if st.ended || st.manual {
                        conn.close();
                        let manual = st.manual;
                        st.ended = true;
                        drop(st);
                        if manual {
                            Inner::emit(me, ClientEvent::End);
                        }
                        return;
                    }
                    st.reconnect = None;
                    st.attempts = 0;
                    // readyHandler: the new connection starts on DB 0; the dropped one's DB is selected again, before any
                    // command of the owner (the select is queued first)
                    let target = st.prev_select.take().unwrap_or(0);
                    st.selected = 0;
                    if target != 0 {
                        st.selected = target;
                        let f = conn.enqueue(&[b"select", target.to_string().as_bytes()]);
                        tokio::spawn(async move {
                            let _ = f.await;
                        });
                    }
                }
                Inner::install(me, conn);
                Inner::emit(me, ClientEvent::Ready);
            }
            Err(e) => {
                me.state.lock().last_error =
                    Some(if e.code == "dbFailed" && e.server_message.is_none() { closed(via) } else { e });
                Inner::after_close(me);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_errors_map_like_1_1_4() {
        assert_eq!(map_server_error("NOAUTH Authentication required.").code, "dbAuth");
        assert_eq!(map_server_error("WRONGPASS invalid username-password pair").code, "dbAuth");
        assert_eq!(map_server_error("ERR invalid password").code, "dbAuth");
        assert_eq!(map_server_error("ERR DB index is out of range").code, "dbNoDatabase");
        let e = map_server_error("ERR other");
        assert_eq!((e.code, e.server_message.as_deref()), ("dbFailed", Some("ERR other")));
        assert_eq!(server_code("WRONGTYPE Operation against a key"), Some("WRONGTYPE".into()));
        assert_eq!(server_code("ERR"), None);
        assert_eq!(server_code("err x"), None);
        assert!(auth_error_ignored("ERR AUTH <password> called without any password configured for the default user."));
        assert!(auth_error_ignored("ERR Client sent AUTH, but no password is set"));
    }

    #[test]
    fn socket_errors_map_like_1_1_4() {
        let e = |k| io::Error::new(k, "x");
        assert_eq!(map_io_error(&e(io::ErrorKind::ConnectionRefused), false).code, "dbRefused");
        assert_eq!(map_io_error(&e(io::ErrorKind::ConnectionRefused), true).code, "tunnel");
        assert_eq!(map_io_error(&e(io::ErrorKind::TimedOut), false).code, "dbTimeout");
        assert_eq!(map_io_error(&e(io::ErrorKind::ConnectionReset), false).code, "dbClosed");
        assert_eq!(map_io_error(&e(io::ErrorKind::UnexpectedEof), true).code, "tunnel");
        let tls = io::Error::new(io::ErrorKind::InvalidData, rustls::Error::General("bad".into()));
        assert_eq!(map_io_error(&tls, false).code, "dbTls");
    }
}
