//! The MCP HTTP server of 1.1.4 (src/main/mcp.ts on @modelcontextprotocol/sdk 1.32.2 StreamableHTTPServerTransport),
//! reproduced message for message on hyper 1.12 (decided in SP8, see docs/tauri/spikes/SP8.md):
//!
//! - the mcp.ts check order: Host / Origin 403, path 404, Bearer 401 (constant-time compare over every token), DELETE of a
//!   session, 405 `Allow: POST`, in-flight 8 per token / 256 stateless + a 120 / 60 per s bucket per token -> 429
//!   `Retry-After: 1`, body over 256 KB -> 413 -32000, invalid JSON -> 400 -32700, unknown session -> 404 -32001;
//! - then the SDK transport checks (406 Accept, 415 Content-Type, batch over 100, the strict JSONRPCMessageSchema, already
//!   initialized / only one initialization, the protocol-version header, which refuses Claude Code's 2026-07-28
//!   `server/discover` probe);
//! - stateless JSON by default, SSE for a stateless tools/call with a progressToken and an SSE Accept, a session (SSE for
//!   every request, `: keepalive` every 15 s) for an `initialize` that declares form elicitation (256 sessions, 4 per
//!   token, bound to the token, closed on DELETE, trim and revoke);
//! - elicitation/create on the calling tool call's stream, answered by a later POST of the session (120 s; a timeout or an
//!   abort sends `notifications/cancelled` for it; an answer failing ElicitResultSchema or the requested schema is cancel);
//!   notifications/progress; notifications/cancelled from the client (the cancelled request gets no answer);
//! - MCP tasks of protocol 2025-11-25 (see [`tasks`]);
//! - cancellation by drop: hyper drops the handler future (JSON) or the response body (SSE) when the client goes away, and
//!   the request's CancellationToken fires (Node's `res.on('close')`);
//! - Node's timeouts: request head 10 s, whole request 30 s, both answered `408` (see [`io`]);
//! - an internal failure is a 500 `{"error":"MCP request failed."}` and one crash.log line without the request body.
//!
//! The tools themselves are behind [`ToolHost`] (M2 / M3); this module owns the wire, tokens, sessions, tasks, limits and
//! the connection indicators (`mcp:info`).

mod body;
mod io;
mod tasks;

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures::FutureExt;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::header::HeaderMap;
use hyper::{Method, Request, StatusCode};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::{CancellationToken, DropGuard};

use body::{Release, Resp, empty, json_error};
use tasks::TaskEntry;

use crate::elicit::{ElicitAnswer, elicit_answer};
use crate::jsonrpc::{
    error, form_elicitation, id_key, is_request, issues_message, js_number, mcp_error, messages_of, normalize_number, result,
    schema_issues, valid_message, wants_progress, wants_session,
};
use crate::tools::{CallCtx, CallError, EXPIRED, Elicit, MAX_RESULT_CHARS, Progress, ToolHost, cap_result, error_content};

pub const MAX_BODY: usize = 256 * 1024;
/// Sessions (clients that can answer elicitations) per token and in total; the oldest of a token is closed for a new one.
pub const MAX_SESSIONS_PER_TOKEN: usize = 4;
pub const MAX_SESSIONS: usize = 256;
pub const MIN_TASK_TTL_MS: u64 = 60_000;
/// mcpTools.ts ELICIT_TIMEOUT_MS.
pub const ELICIT_TIMEOUT: Duration = Duration::from_secs(120);
/// SDK 1.32.2 DEFAULT_SSE_KEEP_ALIVE_MS.
pub const KEEP_ALIVE: Duration = Duration::from_secs(15);
/// A cell counts as connected while its agent listed or called tools this recently (ms).
pub const CONNECTED_WINDOW_MS: f64 = 10.0 * 60_000.0;
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

/// `String(new DOMException('This operation was aborted', 'AbortError'))`, the reason of `controller.abort()`.
const ABORT_REASON: &str = "AbortError: This operation was aborted";
/// `String(McpError(RequestTimeout, 'Request timed out'))`, the reason of an SDK request timeout.
const TIMEOUT_REASON: &str = "McpError: MCP error -32001: Request timed out";

/// A monotonic millisecond clock (performance.now()); wall-clock changes never refill or drain the rate budget.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
/// Where internal failures are reported (the crash log); never gets request bodies or tool arguments.
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

/// McpServerOptions of 1.1.4 plus the timeouts the tests shorten.
#[derive(Clone)]
pub struct Config {
    /// The version the server reports in `initialize` (the app's version).
    pub version: String,
    /// How often a waiting call sends progress to a client that asked for it (10 s).
    pub progress_every: Duration,
    /// Per-token request budget: burst, refill per second. None disables it (benchmarks, the wire driver).
    pub rate: Option<(f64, f64)>,
    /// Simultaneous requests per token (a waiting agent holds one).
    pub max_in_flight_per_token: usize,
    /// Simultaneous stateless requests in total.
    pub max_in_flight: usize,
    /// The lower clamp of a task's ttl (60 s; tests lower it to drive the expiry).
    pub min_task_ttl: Duration,
    /// How long an elicitation waits for its answer (120 s).
    pub elicit_timeout: Duration,
    /// Node `server.headersTimeout` (10 s).
    pub header_timeout: Duration,
    /// Node `server.requestTimeout` (30 s).
    pub request_timeout: Duration,
    /// SSE keepalive comment interval (15 s).
    pub keep_alive: Duration,
    pub now: Clock,
    pub log: Log,
}

impl Default for Config {
    fn default() -> Self {
        let base = Instant::now();
        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            progress_every: Duration::from_secs(10),
            rate: Some((120.0, 60.0)),
            max_in_flight_per_token: 8,
            max_in_flight: 256,
            min_task_ttl: Duration::from_millis(MIN_TASK_TTL_MS),
            elicit_timeout: ELICIT_TIMEOUT,
            header_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(30),
            keep_alive: KEEP_ALIVE,
            now: Arc::new(move || base.elapsed().as_secs_f64() * 1000.0),
            log: Arc::new(|_| {}),
        }
    }
}

/// What `wait_for` and `list_agents` ask about a cell's agent (mcp.ts McpConnection).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Connection {
    /// No token issued.
    Off,
    /// Token issued, the agent has not listed or called tools yet.
    Waiting,
    /// The agent listed or called tools since its token was issued.
    Connected,
}

impl Connection {
    pub fn as_str(self) -> &'static str {
        match self {
            Connection::Off => "off",
            Connection::Waiting => "waiting",
            Connection::Connected => "connected",
        }
    }
}

struct Session {
    id: String,
    token: String,
    cell: String,
    /// Cancelled when the session closes (DELETE, trim, revoke, stop).
    cancel: CancellationToken,
    /// Server-to-client requests waiting for their answer (elicitation/create), by JSON-RPC id.
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    /// The running client requests of this session (notifications/cancelled ends one).
    requests: Mutex<HashMap<String, Arc<RequestState>>>,
    form_elicitation: bool,
}

/// One running client request.
struct RequestState {
    cancel: CancellationToken,
    /// Set by the client's notifications/cancelled, to the abort reason as the SDK stringifies it. Such a request gets no
    /// answer (SDK `_onrequest`: `if (abortController.signal.aborted) return;`).
    client_reason: Mutex<Option<String>>,
}

impl RequestState {
    fn new(cancel: CancellationToken) -> Arc<Self> {
        Arc::new(Self { cancel, client_reason: Mutex::new(None) })
    }
    fn cancelled_by_client(&self) -> bool {
        self.client_reason.lock().is_some()
    }
    /// `String(signal.reason)`: the client's reason, else the DOMException of a bare `abort()`.
    fn abort_reason(&self) -> String {
        self.client_reason.lock().clone().unwrap_or_else(|| ABORT_REASON.to_string())
    }
}

struct Running {
    url: String,
    shutdown: CancellationToken,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
    /// Test hook: the next start fails with this message (1.1.4's listen error test).
    fail_next_listen: Option<String>,
    tokens: HashMap<String, String>,
    /// cell -> token, in issue order (`configuredCellIds` lists them like the JS Map).
    token_of: Vec<(String, String)>,
    /// Revoking a token cancels this; every request, session and task of the token is a child of it.
    token_cancel: HashMap<String, CancellationToken>,
    in_flight: HashMap<String, usize>,
    stateless_in_flight: usize,
    /// token -> (tokens left, last refill time in ms).
    buckets: HashMap<String, (f64, f64)>,
    sessions: HashMap<String, Arc<Session>>,
    /// Session ids in creation order (trim closes the oldest of a token).
    session_order: Vec<String>,
    /// Tasks per token in creation order.
    tasks: HashMap<String, Vec<(String, TaskEntry)>>,
    /// When each cell's agent last listed or called tools successfully (ms of the clock), in first-seen order.
    last_seen: Vec<(String, f64)>,
}

impl Inner {
    fn token_of(&self, cell: &str) -> Option<&String> {
        self.token_of.iter().find(|(c, _)| c == cell).map(|(_, t)| t)
    }
    fn live(&self, token: &str, cell: &str) -> bool {
        self.tokens.get(token).is_some_and(|c| c == cell)
    }
}

type Listener = Arc<dyn Fn() + Send + Sync>;

pub(crate) struct Shared {
    host: Arc<dyn ToolHost>,
    cfg: Config,
    inner: Mutex<Inner>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_listener: AtomicU64,
}

impl Shared {
    /// Calls the change listeners (a token issued or revoked, a cell seen for the first time, the server started).
    fn changed(&self) {
        let listeners: Vec<_> = self.listeners.lock().iter().map(|(_, l)| l.clone()).collect();
        for listener in listeners {
            listener();
        }
    }

    /// A successful tools/list or tools/call: the agent's MCP client really works.
    fn seen(&self, cell: &str) {
        let now = (self.cfg.now)();
        let first = {
            let mut inner = self.inner.lock();
            match inner.last_seen.iter_mut().find(|(c, _)| c == cell) {
                Some((_, at)) => {
                    let first = now - *at >= CONNECTED_WINDOW_MS;
                    *at = now;
                    first
                }
                None => {
                    inner.last_seen.push((cell.to_string(), now));
                    true
                }
            }
        };
        if first {
            self.changed();
        }
    }

    fn log(&self, message: &str) {
        let cut: String = message.chars().take(300).collect();
        (self.cfg.log)(&cut);
    }
}

/// The MCP server of the app. Cheap to share (`Arc<McpServer>`); tokens can be issued before it listens.
pub struct McpServer {
    shared: Arc<Shared>,
    start_lock: tokio::sync::Mutex<()>,
}

impl McpServer {
    pub fn new(host: Arc<dyn ToolHost>, cfg: Config) -> Self {
        let shared = Arc::new(Shared {
            host,
            cfg,
            inner: Mutex::new(Inner::default()),
            listeners: Mutex::new(Vec::new()),
            next_listener: AtomicU64::new(0),
        });
        Self { shared, start_lock: tokio::sync::Mutex::new(()) }
    }

    /// Starts listening on 127.0.0.1 (a free port); a call while a start runs joins it (one server, never two). Needs a
    /// tokio runtime.
    pub async fn start(&self) -> std::io::Result<()> {
        let _joined = self.start_lock.lock().await;
        let failure = {
            let mut inner = self.shared.inner.lock();
            if inner.running.is_some() {
                return Ok(());
            }
            inner.fail_next_listen.take()
        };
        if let Some(message) = failure {
            return Err(std::io::Error::other(message));
        }
        let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.map_err(listen_error)?;
        let port = listener.local_addr()?.port();
        let shutdown = CancellationToken::new();
        tokio::spawn(serve(self.shared.clone(), listener, port, shutdown.clone()));
        self.shared.inner.lock().running = Some(Running { url: format!("http://127.0.0.1:{port}/mcp"), shutdown });
        self.shared.changed();
        Ok(())
    }

    /// Stops listening, closes every connection, session and task and forgets every token (mcp.ts stop).
    pub fn stop(&self) {
        let (running, cancels, sessions) = {
            let mut inner = self.shared.inner.lock();
            let running = inner.running.take();
            inner.tokens.clear();
            inner.token_of.clear();
            inner.buckets.clear();
            inner.in_flight.clear();
            inner.last_seen.clear();
            inner.tasks.clear();
            inner.session_order.clear();
            let cancels: Vec<CancellationToken> = inner.token_cancel.drain().map(|(_, c)| c).collect();
            let sessions: Vec<Arc<Session>> = inner.sessions.drain().map(|(_, s)| s).collect();
            (running, cancels, sessions)
        };
        // Connections first (Node closeAllConnections): a call that ends because its token went is not answered any more.
        if let Some(running) = running {
            running.shutdown.cancel();
        }
        for cancel in cancels {
            cancel.cancel();
        }
        for session in sessions {
            end_session(&session);
        }
    }

    /// A new 256-bit token for the cell; its previous token is revoked first.
    pub fn issue_token(&self, cell: &str) -> String {
        self.revoke_cell(cell);
        let token = random_hex::<32>();
        {
            let mut inner = self.shared.inner.lock();
            inner.tokens.insert(token.clone(), cell.to_string());
            inner.token_of.push((cell.to_string(), token.clone()));
            inner.token_cancel.insert(token.clone(), CancellationToken::new());
        }
        self.shared.changed();
        token
    }

    /// Revokes the cell's token: its requests, sessions and tasks end at once (a waiting wait_for returns).
    pub fn revoke_cell(&self, cell: &str) {
        let (cancel, sessions) = {
            let mut inner = self.shared.inner.lock();
            inner.last_seen.retain(|(c, _)| c != cell);
            let Some(index) = inner.token_of.iter().position(|(c, _)| c == cell) else { return };
            let (_, token) = inner.token_of.remove(index);
            inner.tokens.remove(&token);
            inner.buckets.remove(&token);
            inner.in_flight.remove(&token);
            inner.tasks.remove(&token);
            let cancel = inner.token_cancel.remove(&token);
            let own: Vec<String> = inner.sessions.values().filter(|s| s.token == token).map(|s| s.id.clone()).collect();
            let sessions: Vec<Arc<Session>> = own.iter().filter_map(|id| remove_session(&mut inner, id)).collect();
            (cancel, sessions)
        };
        self.shared.changed();
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        for session in sessions {
            end_session(&session);
        }
    }

    /// `http://127.0.0.1:<port>/mcp` while listening.
    pub fn url(&self) -> Option<String> {
        self.shared.inner.lock().running.as_ref().map(|r| r.url.clone())
    }

    /// mcp.ts getInfo: `{running, url?, configuredCellIds, connectedCellIds}` (the app adds `error` and `starting`).
    pub fn info(&self) -> Value {
        let now = (self.shared.cfg.now)();
        let inner = self.shared.inner.lock();
        let mut info = serde_json::Map::new();
        info.insert("running".into(), json!(inner.running.is_some()));
        if let Some(running) = &inner.running {
            info.insert("url".into(), json!(running.url));
        }
        let configured: Vec<&String> = inner.token_of.iter().map(|(c, _)| c).collect();
        let connected: Vec<&String> = inner
            .last_seen
            .iter()
            .filter(|(c, at)| inner.token_of(c).is_some() && now - at < CONNECTED_WINDOW_MS)
            .map(|(c, _)| c)
            .collect();
        info.insert("configuredCellIds".into(), json!(configured));
        info.insert("connectedCellIds".into(), json!(connected));
        Value::Object(info)
    }

    /// connected: the cell's agent listed or called tools since its token was issued; waiting: token issued, not seen yet;
    /// off: no token.
    pub fn connection(&self, cell: &str) -> Connection {
        let inner = self.shared.inner.lock();
        if inner.token_of(cell).is_none() {
            Connection::Off
        } else if inner.last_seen.iter().any(|(c, _)| c == cell) {
            Connection::Connected
        } else {
            Connection::Waiting
        }
    }

    /// Open client sessions (diagnostics and tests).
    pub fn session_count(&self) -> usize {
        self.shared.inner.lock().sessions.len()
    }

    /// Called when the info changes (a token issued or revoked, a cell seen for the first time, the server started).
    /// Returns an id for [`McpServer::off_change`].
    pub fn on_change(&self, listener: impl Fn() + Send + Sync + 'static) -> u64 {
        let id = self.shared.next_listener.fetch_add(1, Ordering::Relaxed);
        self.shared.listeners.lock().push((id, Arc::new(listener)));
        id
    }

    pub fn off_change(&self, id: u64) {
        self.shared.listeners.lock().retain(|(i, _)| *i != id);
    }

    /// Test hook: the next [`McpServer::start`] fails with `message` (a listen refused by security software).
    #[doc(hidden)]
    pub fn fail_next_listen(&self, message: &str) {
        self.shared.inner.lock().fail_next_listen = Some(message.to_string());
    }

    /// Test hook: the per-token counters (tokens, cells, buckets, in-flight) that must not grow with issued tokens.
    #[doc(hidden)]
    pub fn table_sizes(&self) -> [usize; 4] {
        let inner = self.shared.inner.lock();
        [inner.tokens.len(), inner.token_of.len(), inner.buckets.len(), inner.in_flight.len()]
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A refused listen with Node's message (`listen EACCES: permission denied 127.0.0.1`), which `mcp:info` shows as `error`.
fn listen_error(e: std::io::Error) -> std::io::Error {
    use std::io::ErrorKind;
    let (code, text) = match e.kind() {
        ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        ErrorKind::AddrInUse => ("EADDRINUSE", "address already in use"),
        ErrorKind::AddrNotAvailable => ("EADDRNOTAVAIL", "address not available"),
        _ => return e,
    };
    std::io::Error::new(e.kind(), format!("listen {code}: {text} 127.0.0.1"))
}

pub(crate) fn random_hex<const N: usize>() -> String {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("os random");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The accept loop; every connection is served by hyper http1 with Node's timeouts. Half-closed connections are not kept
/// (hyper's default), so a client that goes away drops its pending request.
async fn serve(shared: Arc<Shared>, listener: tokio::net::TcpListener, port: u16, shutdown: CancellationToken) {
    loop {
        let accepted = tokio::select! {
            r = listener.accept() => r,
            () = shutdown.cancelled() => return,
        };
        match accepted {
            Ok((stream, _)) => {
                let _ = stream.set_nodelay(true);
                tokio::spawn(connection(shared.clone(), stream, port, shutdown.clone()));
            }
            Err(e) => {
                // EMFILE and friends: Node's 'error' event is logged; do not spin.
                shared.log(&format!("MCP server error: {e}"));
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn connection(shared: Arc<Shared>, stream: tokio::net::TcpStream, port: u16, shutdown: CancellationToken) {
    let stream = Arc::new(stream);
    let mid_request = Arc::new(AtomicBool::new(false));
    let io = hyper_util::rt::TokioIo::new(io::SharedIo { stream: stream.clone(), mid_request: mid_request.clone() });
    let header_timeout = shared.cfg.header_timeout;
    let service = hyper::service::service_fn(move |req| {
        let shared = shared.clone();
        async move { Ok::<_, Infallible>(respond(shared, port, req).await) }
    });
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(header_timeout).keep_alive(true);
    // Biased: a stop wins over an answer that became ready in the same wake-up (stop cancels the connections first).
    let served = tokio::select! {
        biased;
        () = shutdown.cancelled() => return,
        r = builder.serve_connection(io, service) => r,
    };
    if let Err(e) = served
        && e.is_timeout()
        && mid_request.load(Ordering::Relaxed)
    {
        io::answer_timeout(&stream).await;
    }
}

/// One request; a panic anywhere below answers 500 without echoing anything of the request (mcp.ts handle().catch).
async fn respond(shared: Arc<Shared>, port: u16, req: Request<Incoming>) -> Resp {
    match AssertUnwindSafe(handle(shared.clone(), port, req)).catch_unwind().await {
        Ok(response) => response,
        Err(panic) => {
            shared.log(&format!("MCP request failed: {}", panic_text(&panic)));
            body::internal_error()
        }
    }
}

fn panic_text(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        format!("Error: {s}")
    } else if let Some(s) = panic.downcast_ref::<String>() {
        format!("Error: {s}")
    } else {
        "Error: panic".to_string()
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `/^Bearer\s+(\S+)$/i` on the Authorization header.
fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = header_str(headers, "authorization")?;
    let (scheme, rest) = value.split_at_checked(6)?;
    if !scheme.eq_ignore_ascii_case("bearer") || !rest.starts_with(|c: char| c.is_ascii_whitespace() || c == '\x0b') {
        return None;
    }
    let token = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == '\x0b');
    (!token.is_empty() && !token.contains(|c: char| c.is_ascii_whitespace() || c == '\x0b')).then(|| token.to_string())
}

/// The token's cell and its cancel token, compared in constant time against every issued token.
fn find_token(inner: &Inner, token: &str) -> Option<(String, CancellationToken)> {
    let mut found = None;
    for (t, cell) in &inner.tokens {
        if ct_eq(t.as_bytes(), token.as_bytes()) {
            found = Some((cell.clone(), inner.token_cancel.get(t).cloned().unwrap_or_default()));
        }
    }
    found
}

fn allow(inner: &mut Inner, cfg: &Config, token: &str) -> bool {
    let Some((burst, per_second)) = cfg.rate else { return true };
    let now = (cfg.now)();
    let bucket = inner.buckets.entry(token.to_string()).or_insert((burst, now));
    // A clock that moved backwards refills nothing (never negative) and becomes the new reference point.
    bucket.0 = (bucket.0 + ((now - bucket.1).max(0.0) / 1000.0) * per_second).min(burst);
    bucket.1 = now;
    if bucket.0 < 1.0 {
        return false;
    }
    bucket.0 -= 1.0;
    true
}

async fn handle(shared: Arc<Shared>, port: u16, req: Request<Incoming>) -> Resp {
    let started = tokio::time::Instant::now();
    let headers = req.headers().clone();
    // DNS-rebinding hardening: only the literal local origins may talk to the server.
    let host = header_str(&headers, "host").unwrap_or("");
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return empty(StatusCode::FORBIDDEN);
    }
    if let Some(origin) = headers.get("origin").map(|v| v.to_str().unwrap_or("\u{0}"))
        && !origin.is_empty()
        && origin != format!("http://127.0.0.1:{port}")
        && origin != format!("http://localhost:{port}")
    {
        return empty(StatusCode::FORBIDDEN);
    }
    // Node's req.url is the request target as sent: `/mcp` only (no query, no absolute form).
    if req.uri() != "/mcp" {
        return empty(StatusCode::NOT_FOUND);
    }
    let Some(token) = bearer(&headers) else { return empty(StatusCode::UNAUTHORIZED) };
    let Some((cell, token_cancel)) = find_token(&shared.inner.lock(), &token) else {
        return empty(StatusCode::UNAUTHORIZED);
    };
    let session_id = header_str(&headers, "mcp-session-id").map(str::to_string);
    // A session ends with DELETE (the client is done); a session of another token is unknown to this one.
    if req.method() == Method::DELETE
        && let Some(id) = &session_id
    {
        let session = {
            let mut inner = shared.inner.lock();
            if inner.sessions.get(id).is_none_or(|s| s.token != token) {
                return empty(StatusCode::NOT_FOUND);
            }
            remove_session(&mut inner, id)
        };
        if let Some(session) = session {
            end_session(&session);
        }
        return empty(StatusCode::OK);
    }
    if req.method() != Method::POST {
        return body::method_not_allowed();
    }
    // Cheap concurrency checks first, so a rejected request does not also spend rate budget.
    {
        let mut inner = shared.inner.lock();
        let in_flight = inner.in_flight.get(&token).copied().unwrap_or(0);
        let busy = in_flight >= shared.cfg.max_in_flight_per_token || inner.stateless_in_flight >= shared.cfg.max_in_flight;
        if busy || !allow(&mut inner, &shared.cfg, &token) {
            return body::too_many();
        }
        inner.in_flight.insert(token.clone(), in_flight + 1);
    }
    let abort = token_cancel.child_token();
    let mut release = Release { shared: shared.clone(), token: token.clone(), stateless: false, abort: abort.clone() };
    // Hyper drops this future when the client goes away before the answer: the guard aborts the running call. An SSE answer
    // disarms it (the Release guard in the body takes over).
    let guard = abort.clone().drop_guard();

    let raw = match read_body(req.into_body(), started + shared.cfg.request_timeout).await {
        BodyRead::Ok(raw) => raw,
        BodyRead::TooLarge => return json_error(StatusCode::PAYLOAD_TOO_LARGE, -32000, "Request body too large."),
        BodyRead::Timeout => return body::request_timeout(),
    };
    // mcp.ts readBody: `Buffer.concat(chunks).toString('utf8')` (invalid bytes become U+FFFD), then JSON.parse.
    let Ok(body) = unimux_core::js_json::parse(&String::from_utf8_lossy(&raw)) else {
        return json_error(StatusCode::BAD_REQUEST, -32700, "Parse error: invalid JSON.");
    };

    if let Some(id) = session_id {
        let session = shared.inner.lock().sessions.get(&id).cloned();
        // Unknown, closed (revoked) or another token's session: 404 tells the client to initialize again.
        let Some(session) = session.filter(|s| s.token == token) else {
            return json_error(StatusCode::NOT_FOUND, -32001, "Session not found.");
        };
        return transport(&shared, &headers, body, Mode::Session(session), release, guard).await;
    }
    if wants_session(&body) && shared.inner.lock().sessions.len() < MAX_SESSIONS {
        // Revoked while the body was read: the session must not outlive its token (mcp.ts answers 401 before the transport
        // checks). transport() checks again under the lock that inserts the session.
        if token_cancel.is_cancelled() || !shared.inner.lock().live(&token, &cell) {
            return empty(StatusCode::UNAUTHORIZED);
        }
        return transport(&shared, &headers, body, Mode::NewSession { token, cell, token_cancel }, release, guard).await;
    }
    shared.inner.lock().stateless_in_flight += 1;
    release.stateless = true;
    let json_mode = !wants_progress(&body, header_str(&headers, "accept"));
    transport(&shared, &headers, body, Mode::Stateless { token, cell, json: json_mode }, release, guard).await
}

enum BodyRead {
    Ok(Vec<u8>),
    TooLarge,
    Timeout,
}

/// The body as bytes; a larger one is still read to the end, so the 413 reaches the client (as 1.1.4).
async fn read_body(mut body: Incoming, deadline: tokio::time::Instant) -> BodyRead {
    let mut out = Vec::new();
    let mut size = 0usize;
    loop {
        let frame = match tokio::time::timeout_at(deadline, body.frame()).await {
            Err(_) => return BodyRead::Timeout,
            Ok(None) => break,
            Ok(Some(Err(_))) => return BodyRead::Timeout,
            Ok(Some(Ok(frame))) => frame,
        };
        if let Ok(data) = frame.into_data() {
            size += data.len();
            if size <= MAX_BODY {
                out.extend_from_slice(&data);
            }
        }
    }
    if size > MAX_BODY { BodyRead::TooLarge } else { BodyRead::Ok(out) }
}

enum Mode {
    Stateless { token: String, cell: String, json: bool },
    NewSession { token: String, cell: String, token_cancel: CancellationToken },
    Session(Arc<Session>),
}

/// `isJsonContentType`: the parsed media type is application/json.
fn json_content_type(value: &str) -> bool {
    value.split(';').next().is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"))
}

/// The StreamableHTTPServerTransport part: header checks, message validation, 202 / JSON / SSE.
async fn transport(
    shared: &Arc<Shared>,
    headers: &HeaderMap,
    body: Value,
    mode: Mode,
    release: Release,
    guard: DropGuard,
) -> Resp {
    let abort = release.abort.clone();
    let accept = header_str(headers, "accept").unwrap_or("");
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return json_error(
            StatusCode::NOT_ACCEPTABLE,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
        );
    }
    if !json_content_type(header_str(headers, "content-type").unwrap_or("")) {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
        );
    }
    if body.as_array().is_some_and(|a| a.len() > 100) {
        return json_error(StatusCode::BAD_REQUEST, -32600, "Invalid Request: Batch must not exceed 100 messages");
    }
    let mut messages: Vec<Value> = messages_of(&body).into_iter().cloned().collect();
    if !messages.iter().all(valid_message) {
        return json_error(StatusCode::BAD_REQUEST, -32700, "Parse error: Invalid JSON-RPC message");
    }
    for m in &mut messages {
        if let Some(id) = m.get_mut("id") {
            *id = normalize_number(id);
        }
    }
    let is_init = messages.iter().any(|m| m["method"] == "initialize" && is_request(m));
    if is_init {
        if matches!(mode, Mode::Session(_)) {
            return json_error(StatusCode::BAD_REQUEST, -32600, "Invalid Request: Server already initialized");
        }
        if messages.len() > 1 {
            return json_error(StatusCode::BAD_REQUEST, -32600, "Invalid Request: Only one initialization request is allowed");
        }
    } else if let Some(version) = header_str(headers, "mcp-protocol-version")
        && !SUPPORTED_PROTOCOL_VERSIONS.contains(&version)
    {
        let message = format!(
            "Bad Request: Unsupported protocol version: {version} (supported versions: {})",
            SUPPORTED_PROTOCOL_VERSIONS.join(", ")
        );
        return json_error(StatusCode::BAD_REQUEST, -32000, &message);
    }

    let (session, token, cell, json_mode) = match mode {
        Mode::Stateless { token, cell, json } => (None, token, cell, json),
        Mode::Session(s) => {
            if s.cancel.is_cancelled() {
                // Closed while the body was read (SDK: `if (this._closed)`).
                return json_error(StatusCode::NOT_FOUND, -32001, "Session not found");
            }
            let (t, c) = (s.token.clone(), s.cell.clone());
            (Some(s), t, c, false)
        }
        Mode::NewSession { token, cell, token_cancel } => {
            let session = Arc::new(Session {
                id: uuid::Uuid::new_v4().to_string(),
                token: token.clone(),
                cell: cell.clone(),
                cancel: token_cancel.child_token(),
                pending: Mutex::default(),
                next_id: AtomicU64::new(0),
                requests: Mutex::default(),
                form_elicitation: messages.iter().any(|m| form_elicitation(&m["params"]["capabilities"])),
            });
            let trimmed = {
                let mut inner = shared.inner.lock();
                // Checked under the lock revoke_cell takes, so a revoke either sees this session (and closes it) or wins here.
                if token_cancel.is_cancelled() || !inner.live(&token, &cell) {
                    return empty(StatusCode::UNAUTHORIZED);
                }
                inner.sessions.insert(session.id.clone(), session.clone());
                inner.session_order.push(session.id.clone());
                trim_sessions(&mut inner, &token)
            };
            for old in trimmed {
                end_session(&old);
            }
            (Some(session), token, cell, false)
        }
    };

    if !messages.iter().any(is_request) {
        for m in &messages {
            accept_message(session.as_deref(), m);
        }
        return empty(StatusCode::ACCEPTED);
    }
    let ctx = Arc::new(ReqCtx { shared: shared.clone(), session: session.clone(), token, cell });
    if json_mode {
        // The SDK hands every message to the server at once: requests of a batch run side by side.
        let mut calls = Vec::new();
        for m in &messages {
            if is_request(m) {
                let state = RequestState::new(abort.clone());
                calls.push(dispatch(&ctx, m.clone(), None, state));
            } else {
                accept_message(session.as_deref(), m);
            }
        }
        // With half-close off (hyper's default) hyper notices the client's FIN while this handler is pending and drops the
        // handler future, so `guard` aborts the calls (as 1.1.4's res 'close').
        let mut out = futures::future::join_all(calls).await;
        drop(guard);
        drop(release);
        // SDK send(): one answer is sent as an object, several as an array.
        let answer = if out.len() == 1 { out.pop().unwrap_or(Value::Null) } else { Value::Array(out) };
        return body::json_body(StatusCode::OK, &answer);
    }
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let session_header = session.as_ref().map(|s| s.id.clone());
    for m in messages {
        if !is_request(&m) {
            accept_message(session.as_deref(), &m);
            continue;
        }
        let ctx = ctx.clone();
        let tx = tx.clone();
        let state = RequestState::new(abort.child_token());
        if let Some(s) = &session {
            s.requests.lock().insert(id_key(&m["id"]), state.clone());
        }
        // Every long operation observes the request's cancel, so the call ends on its own when the client goes away. A
        // request the client cancelled gets no answer; its stream ends once nothing else is pending on it.
        tokio::spawn(async move {
            let id = id_key(&m["id"]);
            let run = AssertUnwindSafe(dispatch(&ctx, m, Some(tx.clone()), state.clone())).catch_unwind().await;
            if let Some(s) = &ctx.session {
                let mut requests = s.requests.lock();
                if requests.get(&id).is_some_and(|r| Arc::ptr_eq(r, &state)) {
                    requests.remove(&id);
                }
            }
            match run {
                Ok(answer) if !state.cancelled_by_client() => {
                    let _ = tx.send(answer);
                }
                Ok(_) => {}
                Err(panic) => ctx.shared.log(&format!("MCP request failed: {}", panic_text(&panic))),
            }
        });
    }
    drop(tx);
    guard.disarm();
    body::sse(rx, release, session_header.as_deref(), shared.cfg.keep_alive)
}

/// Notifications and responses: elicitation answers reach their waiting call, notifications/cancelled ends a request.
fn accept_message(session: Option<&Session>, m: &Value) {
    let Some(session) = session else { return };
    if m.get("method").is_none() {
        let sender = session.pending.lock().remove(&id_key(&m["id"]));
        if let Some(sender) = sender {
            let _ = sender.send(m.clone());
        }
        return;
    }
    // CancelledNotificationSchema: a reason that is not a string fails the parse and the notification is dropped.
    let reason = &m["params"]["reason"];
    if m["method"] == "notifications/cancelled" && (reason.is_null() || reason.is_string()) {
        let request = session.requests.lock().get(&id_key(&m["params"]["requestId"])).cloned();
        if let Some(state) = request {
            state.client_reason.lock().get_or_insert_with(|| reason.as_str().unwrap_or(ABORT_REASON).to_string());
            state.cancel.cancel();
        }
    }
}

pub(crate) struct ReqCtx {
    shared: Arc<Shared>,
    session: Option<Arc<Session>>,
    token: String,
    cell: String,
}

impl ReqCtx {
    fn live(&self) -> bool {
        self.shared.inner.lock().live(&self.token, &self.cell)
    }
    /// The transport's session id, which the SDK passes to every task store call.
    fn session_id(&self) -> Option<&str> {
        self.session.as_deref().map(|s| s.id.as_str())
    }
}

async fn dispatch(ctx: &Arc<ReqCtx>, m: Value, out: Option<mpsc::UnboundedSender<Value>>, state: Arc<RequestState>) -> Value {
    let id = m["id"].clone();
    let params = &m["params"];
    let method = m["method"].as_str().unwrap_or("");
    let issues = schema_issues(method, m.get("params"));
    if !issues.is_empty() {
        return error(&id, -32603, &issues_message(&issues));
    }
    let host = &ctx.shared.host;
    match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&asked) { asked } else { LATEST_PROTOCOL_VERSION };
            let mut answer = serde_json::Map::new();
            answer.insert("protocolVersion".into(), json!(version));
            answer.insert(
                "capabilities".into(),
                json!({ "tools": {}, "tasks": { "list": {}, "cancel": {}, "requests": { "tools": { "call": {} } } } }),
            );
            answer.insert("serverInfo".into(), json!({ "name": "unimux", "version": ctx.shared.cfg.version }));
            let instructions = host.instructions(&ctx.cell);
            if !instructions.is_empty() {
                answer.insert("instructions".into(), json!(instructions));
            }
            result(&id, Value::Object(answer))
        }
        "ping" => result(&id, json!({})),
        "tools/list" => {
            let tools = host.tools(&ctx.cell);
            if ctx.live() {
                ctx.shared.seen(&ctx.cell);
            }
            result(&id, json!({ "tools": tools }))
        }
        "tools/call" => tools_call(ctx, &id, params, out, state).await,
        "tasks/get" => tasks::get(ctx, &id, params["taskId"].as_str().unwrap_or("")),
        "tasks/result" => tasks::result_of(ctx, &id, params["taskId"].as_str().unwrap_or(""), state.cancel.clone()).await,
        "tasks/list" => tasks::list(ctx, &id, params["cursor"].as_str()),
        "tasks/cancel" => tasks::cancel(ctx, &id, params["taskId"].as_str().unwrap_or("")),
        _ => error(&id, -32601, "Method not found"),
    }
}

/// What a finished call answers (mcp.ts CallToolRequestSchema handler and startTask): Ok(the result) or Err(the text of an
/// unknown tool, a protocol error for a plain call). `seen_on_error`: an error answer still means the client works (not
/// counted for tasks).
pub(crate) fn call_outcome(
    shared: &Shared,
    token: &str,
    cell: &str,
    name: &str,
    outcome: Result<Value, CallError>,
    seen_on_error: bool,
) -> Result<Value, String> {
    let live = shared.inner.lock().live(token, cell);
    match outcome {
        // Revoked while the call was running (a waiting wait_for is aborted by revokeCell): do not hand out the result.
        Ok(_) | Err(CallError::Unknown) if !live => Ok(error_content(EXPIRED)),
        Ok(value) => {
            shared.seen(cell);
            let text = cap_result(&unimux_core::js_json::stringify(&value), MAX_RESULT_CHARS);
            Ok(json!({ "content": [{ "type": "text", "text": text }] }))
        }
        Err(CallError::Unknown) => Err(format!("Unknown tool: {name}")),
        Err(e) => {
            if live && seen_on_error {
                shared.seen(cell);
            }
            Ok(error_content(&e.text(name)))
        }
    }
}

async fn tools_call(
    ctx: &Arc<ReqCtx>,
    id: &Value,
    params: &Value,
    out: Option<mpsc::UnboundedSender<Value>>,
    state: Arc<RequestState>,
) -> Value {
    let name = params["name"].as_str().unwrap_or("").to_string();
    let args = params.get("arguments").cloned();
    if params.get("task").is_some_and(Value::is_object) {
        // Recheck the token on every call, including calls racing with a cell restart.
        if !ctx.live() {
            return mcp_error(id, -32600, EXPIRED);
        }
        if !ctx.shared.host.supports_task(&name) {
            return mcp_error(id, -32601, &format!("Tool {name} does not run as a task."));
        }
        return tasks::start(ctx, id, &name, args, params["task"]["ttl"].as_f64());
    }
    let progress: Option<Progress> = match (&out, &params["_meta"]["progressToken"]) {
        (Some(tx), token) if token.is_string() || token.is_number() => {
            let (tx, token, state) = (tx.clone(), token.clone(), state.clone());
            Some(Arc::new(move |progress: f64, total: f64, message: String| {
                // extra.sendNotification: nothing once the client cancelled the request.
                if state.cancelled_by_client() {
                    return;
                }
                let _ = tx.send(json!({ "method": "notifications/progress",
                    "params": { "progressToken": token, "progress": js_number(progress), "total": js_number(total), "message": message },
                    "jsonrpc": "2.0" }));
            }))
        }
        _ => None,
    };
    let elicit: Option<Elicit> = match (&ctx.session, &out) {
        (Some(session), Some(tx)) if session.form_elicitation => {
            Some(elicit_on(session.clone(), tx.clone(), state.clone(), ctx.shared.cfg.elicit_timeout))
        }
        _ => None,
    };
    if !ctx.live() {
        return result(id, error_content(EXPIRED));
    }
    let call = CallCtx {
        cell: ctx.cell.clone(),
        cancel: state.cancel.clone(),
        elicit,
        progress,
        progress_every: ctx.shared.cfg.progress_every,
        task: false,
    };
    let outcome = ctx.shared.host.clone().call(name.clone(), args, call).await;
    match call_outcome(&ctx.shared, &ctx.token, &ctx.cell, &name, outcome, true) {
        Ok(answer) => result(id, answer),
        Err(text) => mcp_error(id, -32602, &text),
    }
}

/// An elicitation/create waiting for its answer. Dropped while armed (the tool stopped waiting because its call was
/// aborted), it does what the SDK's `cancel(reason)` does: forget the request and send `notifications/cancelled` for it on
/// the call's stream, unless the session is closed (the SDK's transport is closed then and sends nothing).
struct PendingElicit {
    session: Arc<Session>,
    tx: mpsc::UnboundedSender<Value>,
    id: Value,
    state: Arc<RequestState>,
    armed: bool,
}

impl PendingElicit {
    fn cancel(&mut self, reason: &str) {
        self.armed = false;
        self.session.pending.lock().remove(&id_key(&self.id));
        if !self.session.cancel.is_cancelled() {
            let _ = self.tx.send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled",
                "params": { "requestId": self.id, "reason": reason } }));
        }
    }
    fn answered(&mut self) {
        self.armed = false;
        self.session.pending.lock().remove(&id_key(&self.id));
    }
}

impl Drop for PendingElicit {
    fn drop(&mut self) {
        if self.armed {
            let reason = self.state.abort_reason();
            self.cancel(&reason);
        }
    }
}

/// elicitation/create on the calling tool call's stream; the answer comes back as a POST of the same session. A timeout or
/// an abort of the call sends `notifications/cancelled` for it (SDK Protocol.request), so the client closes its prompt.
fn elicit_on(session: Arc<Session>, tx: mpsc::UnboundedSender<Value>, state: Arc<RequestState>, timeout: Duration) -> Elicit {
    Arc::new(move |message: String, schema: Value| {
        let (session, tx, state) = (session.clone(), tx.clone(), state.clone());
        Box::pin(async move {
            // `options.signal.throwIfAborted()` before anything is sent.
            if state.cancel.is_cancelled() || session.cancel.is_cancelled() {
                return ElicitAnswer::cancel();
            }
            let n = session.next_id.fetch_add(1, Ordering::Relaxed);
            let id = json!(n);
            let (answer_tx, answer_rx) = oneshot::channel();
            session.pending.lock().insert(id_key(&id), answer_tx);
            let request = json!({ "method": "elicitation/create",
                "params": { "mode": "form", "message": message, "requestedSchema": schema }, "jsonrpc": "2.0", "id": id });
            if tx.send(request).is_err() {
                session.pending.lock().remove(&id_key(&id));
                return ElicitAnswer::cancel();
            }
            let mut pending = PendingElicit { session: session.clone(), tx, id, state: state.clone(), armed: true };
            let answer = tokio::select! {
                a = answer_rx => a.ok(),
                () = tokio::time::sleep(timeout) => {
                    pending.cancel(TIMEOUT_REASON);
                    return ElicitAnswer::cancel();
                }
                () = state.cancel.cancelled() => {
                    pending.cancel(&state.abort_reason());
                    return ElicitAnswer::cancel();
                }
                () = session.cancel.cancelled() => {
                    pending.cancel(ABORT_REASON);
                    return ElicitAnswer::cancel();
                }
            };
            pending.answered();
            answer.and_then(|m| elicit_answer(&m, &schema)).unwrap_or_else(ElicitAnswer::cancel)
        })
    })
}

/// Closes the token's oldest sessions above MAX_SESSIONS_PER_TOKEN (a client that reconnects keeps opening new ones).
fn trim_sessions(inner: &mut Inner, token: &str) -> Vec<Arc<Session>> {
    let own: Vec<String> =
        inner.session_order.iter().filter(|id| inner.sessions.get(*id).is_some_and(|s| s.token == token)).cloned().collect();
    let excess = own.len().saturating_sub(MAX_SESSIONS_PER_TOKEN);
    own.into_iter().take(excess).filter_map(|id| remove_session(inner, &id)).collect()
}

fn remove_session(inner: &mut Inner, id: &str) -> Option<Arc<Session>> {
    inner.session_order.retain(|s| s != id);
    inner.sessions.remove(id)
}

/// The session's transport closes: its running requests are aborted (outside the server lock).
fn end_session(session: &Session) {
    session.cancel.cancel();
    let requests: Vec<Arc<RequestState>> = session.requests.lock().drain().map(|(_, s)| s).collect();
    for state in requests {
        state.cancel.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_follows_the_1_1_4_regex() {
        let h = |v: &str| {
            let mut m = HeaderMap::new();
            m.insert("authorization", v.parse().unwrap());
            bearer(&m)
        };
        assert_eq!(h("Bearer abc").as_deref(), Some("abc"));
        assert_eq!(h("bearer \t abc").as_deref(), Some("abc"));
        assert_eq!(h("BEARER abc"), Some("abc".into()));
        assert_eq!(h("Bearerabc"), None);
        assert_eq!(h("Bearer a b"), None);
        assert_eq!(h("Bearer "), None);
        assert_eq!(h("Basic abc"), None);
        assert_eq!(h("Bearer abc "), None);
    }

    #[test]
    fn content_type_is_parsed_not_matched() {
        assert!(json_content_type("application/json"));
        assert!(json_content_type("Application/JSON; charset=utf-8"));
        assert!(!json_content_type("application/json-seq"));
        assert!(!json_content_type("text/plain"));
    }

    #[test]
    fn the_rate_bucket_never_refills_from_a_backwards_clock() {
        let clock = Arc::new(Mutex::new(1000.0));
        let c = clock.clone();
        let cfg = Config { rate: Some((2.0, 1.0)), now: Arc::new(move || *c.lock()), ..Config::default() };
        let mut inner = Inner::default();
        assert!(allow(&mut inner, &cfg, "t") && allow(&mut inner, &cfg, "t"));
        assert!(!allow(&mut inner, &cfg, "t"));
        *clock.lock() -= 3_600_000.0;
        assert!(!allow(&mut inner, &cfg, "t"));
        *clock.lock() += 1000.0;
        assert!(allow(&mut inner, &cfg, "t"));
        assert!(!allow(&mut inner, &cfg, "t"));
    }
}
