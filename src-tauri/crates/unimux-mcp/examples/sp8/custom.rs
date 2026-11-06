//! SP8 spike, candidate B: a custom dispatcher on axum + hyper that reproduces the 1.1.4 wire (src/main/mcp.ts on top of
//! @modelcontextprotocol/sdk 1.32.2 StreamableHTTPServerTransport) message for message:
//!
//! - the mcp.ts check order: Host/Origin 403, path 404, Bearer 401 (constant-time compare), DELETE session, 405 Allow: POST,
//!   in-flight 8 per token / 256 stateless + bucket 120 / 60 per s -> 429 Retry-After 1, 256 KB -> 413 -32000, -32700,
//!   unknown session 404 -32001;
//! - then the SDK transport checks (406 Accept, 415 Content-Type, -32700 invalid JSON-RPC, already initialized, protocol
//!   version header 400, which is what Claude Code's `server/discover` probe for 2026-07-28 gets);
//! - stateless JSON by default, SSE for a stateless tools/call with a progressToken and an SSE Accept, a session (SSE for
//!   every request, `: keepalive` every 15 s) for an `initialize` that declares form elicitation; 256 sessions, 4 per token;
//! - elicitation/create on the calling tool call's stream, answered by a later POST of the same session (120 s, cancel on
//!   failure); notifications/progress; notifications/cancelled;
//! - MCP tasks of protocol 2025-11-25 (tools/call `params.task`, tasks/get, tasks/result, tasks/list, tasks/cancel), 16 per
//!   token, ttl clamped to 60 s..1 h, pollInterval 2000, private to the token;
//! - cancellation by drop: the request's CancellationToken is cancelled when hyper drops the handler future (JSON mode) or
//!   the response body (SSE mode), i.e. when the client goes away.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::Response;
use bytes::Bytes;
use futures::Stream;
use http_body_util::BodyExt;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::{CancellationToken, DropGuard};

use super::fake::{CallCtx, CallError, Elicit, ElicitAnswer, Fake, Progress, cap_result, now_ms};

const MAX_BODY: usize = 256 * 1024;
const MAX_SESSIONS_PER_TOKEN: usize = 4;
const MAX_SESSIONS: usize = 256;
const MAX_RUNNING_TASKS: usize = 16;
const TASK_TTL_MS: u64 = 60 * 60_000;
const MIN_TASK_TTL_MS: u64 = 60_000;
const TASK_POLL_MS: u64 = 2000;
const ELICIT_TIMEOUT: Duration = Duration::from_secs(120);
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const MAX_RESULT_CHARS: usize = 60_000;
const LATEST: &str = "2025-11-25";
const SUPPORTED: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

pub struct Config {
    pub version: String,
    pub progress_every: Duration,
    /// burst, refill per second; None disables the bucket (benchmarks, the spike driver).
    pub rate: Option<(f64, f64)>,
    pub max_in_flight_per_token: usize,
    pub max_in_flight: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: "1.2.0".into(),
            progress_every: Duration::from_secs(10),
            rate: Some((120.0, 60.0)),
            max_in_flight_per_token: 8,
            max_in_flight: 256,
        }
    }
}

struct Session {
    id: String,
    token: String,
    cell: String,
    /// Cancelled when the session closes (DELETE, trim, revoke).
    cancel: CancellationToken,
    /// Server-to-client requests waiting for their answer (elicitation/create), by JSON-RPC id.
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    /// The running client requests of this session (notifications/cancelled ends one).
    requests: Mutex<HashMap<String, CancellationToken>>,
    form_elicitation: bool,
}

struct TaskEntry {
    task: Value,
    result: Option<Value>,
    cancel: CancellationToken,
    changed: Arc<tokio::sync::Notify>,
}

#[derive(Default)]
struct Inner {
    tokens: HashMap<String, String>,
    token_of: HashMap<String, String>,
    /// Revoking a token cancels this; every request, session and task of the token is a child of it.
    token_cancel: HashMap<String, CancellationToken>,
    in_flight: HashMap<String, usize>,
    stateless_in_flight: usize,
    buckets: HashMap<String, (f64, Instant)>,
    sessions: HashMap<String, Arc<Session>>,
    /// Session ids in creation order (trim closes the oldest of a token).
    session_order: Vec<String>,
    /// Tasks per token in creation order.
    tasks: HashMap<String, Vec<(String, TaskEntry)>>,
}

pub struct Shared {
    pub fake: Arc<Fake>,
    cfg: Config,
    port: u16,
    inner: Mutex<Inner>,
}

pub struct CustomServer {
    pub shared: Arc<Shared>,
    pub url: String,
}

impl CustomServer {
    pub async fn start(fake: Arc<Fake>, cfg: Config) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let port = listener.local_addr()?.port();
        let shared = Arc::new(Shared { fake, cfg, port, inner: Mutex::new(Inner::default()) });
        let app = Router::new().fallback(handle).with_state(shared.clone());
        tokio::spawn(serve(listener, app));
        Ok(Self { shared, url: format!("http://127.0.0.1:{port}/mcp") })
    }

    pub fn issue_token(&self, cell: &str) -> String {
        self.revoke_cell(cell);
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("os random");
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let mut inner = self.shared.inner.lock();
        inner.tokens.insert(token.clone(), cell.to_string());
        inner.token_of.insert(cell.to_string(), token.clone());
        inner.token_cancel.insert(token.clone(), CancellationToken::new());
        token
    }

    pub fn revoke_cell(&self, cell: &str) {
        let mut inner = self.shared.inner.lock();
        let Some(token) = inner.token_of.remove(cell) else { return };
        inner.tokens.remove(&token);
        inner.buckets.remove(&token);
        inner.in_flight.remove(&token);
        if let Some(cancel) = inner.token_cancel.remove(&token) {
            cancel.cancel();
        }
        let own: Vec<String> = inner.sessions.values().filter(|s| s.token == token).map(|s| s.id.clone()).collect();
        for id in own {
            close_session(&mut inner, &id);
        }
        inner.tasks.remove(&token);
    }

    pub fn session_count(&self) -> usize {
        self.shared.inner.lock().sessions.len()
    }
}

/// hyper-util directly (not axum::serve) for the Node timeouts: headers 10 s; the 30 s request timeout is applied while the
/// body is read. Half-closed connections are not kept (hyper's default), so a client that goes away drops the request.
async fn serve(listener: tokio::net::TcpListener, app: Router) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let _ = stream.set_nodelay(true);
        let service = hyper_util::service::TowerToHyperService::new(app.clone());
        tokio::spawn(async move {
            let io = hyper_util::rt::TokioIo::new(stream);
            let mut builder = hyper::server::conn::http1::Builder::new();
            builder.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(10)).keep_alive(true);
            let _ = builder.serve_connection(io, service).await;
        });
    }
}

fn empty(status: StatusCode) -> Response {
    Response::builder().status(status).body(Body::empty()).unwrap()
}

/// The SDK's createJsonErrorResponse / mcp.ts jsonError: `{"jsonrpc":"2.0","error":{"code","message"},"id":null}`.
fn json_error(status: StatusCode, code: i64, message: &str) -> Response {
    let body = json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null }).to_string();
    Response::builder().status(status).header(header::CONTENT_TYPE, "application/json").body(Body::from(body)).unwrap()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// `^Bearer\s+(\S+)$`, case-insensitive scheme.
fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = header_str(headers, "authorization")?;
    let (scheme, rest) = value.split_at_checked(6)?;
    if !scheme.eq_ignore_ascii_case("bearer") || !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let token = rest.trim_start();
    (!token.is_empty() && !token.contains(char::is_whitespace)).then(|| token.to_string())
}

fn messages_of(body: &Value) -> Vec<&Value> {
    match body {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

fn is_request(m: &Value) -> bool {
    m["method"].is_string() && (m["id"].is_string() || m["id"].is_number())
}

fn id_key(id: &Value) -> String {
    id.to_string()
}

/// An `initialize` from a client that can answer form elicitations (`elicitation: {}` is the older spelling).
fn wants_session(body: &Value) -> bool {
    messages_of(body).iter().any(|m| m["method"] == "initialize" && form_elicitation(&m["params"]["capabilities"]))
}

fn form_elicitation(capabilities: &Value) -> bool {
    match &capabilities["elicitation"] {
        Value::Object(e) => e.contains_key("form") || e.is_empty(),
        _ => false,
    }
}

fn wants_progress(body: &Value, accept: Option<&str>) -> bool {
    if !accept.is_some_and(|a| a.contains("text/event-stream")) {
        return false;
    }
    messages_of(body).iter().any(|m| {
        let token = &m["params"]["_meta"]["progressToken"];
        m["method"] == "tools/call" && (token.is_string() || token.is_number())
    })
}

/// A JSON-RPC 2.0 request, notification, response or error (the SDK's JSONRPCMessageSchema, loosely).
fn valid_message(m: &Value) -> bool {
    let Some(obj) = m.as_object() else { return false };
    if obj.get("jsonrpc") != Some(&json!("2.0")) {
        return false;
    }
    if let Some(method) = obj.get("method") {
        return method.is_string() && obj.get("id").is_none_or(|id| id.is_string() || id.is_number());
    }
    let id_ok = obj.get("id").is_some_and(|id| id.is_string() || id.is_number());
    id_ok && (obj.contains_key("result") || obj.contains_key("error"))
}

/// Releases the request's in-flight slot and fires its abort when the response is done or dropped (Node's `res.on('close')`).
struct Release {
    shared: Arc<Shared>,
    token: String,
    stateless: bool,
    abort: CancellationToken,
}

impl Drop for Release {
    fn drop(&mut self) {
        self.abort.cancel();
        let mut inner = self.shared.inner.lock();
        if self.stateless {
            inner.stateless_in_flight = inner.stateless_in_flight.saturating_sub(1);
        }
        if inner.tokens.contains_key(&self.token)
            && let Some(n) = inner.in_flight.get_mut(&self.token)
        {
            *n = n.saturating_sub(1);
        }
    }
}

/// An SSE response body: frames from a channel, a `: keepalive` comment every 15 s, and the Release guard, so hyper
/// dropping the body (client gone) aborts the request.
struct SseBody {
    rx: mpsc::UnboundedReceiver<Value>,
    keep_alive: tokio::time::Interval,
    _release: Release,
}

impl Stream for SseBody {
    type Item = Result<Bytes, Infallible>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(msg)) => return Poll::Ready(Some(Ok(Bytes::from(format!("event: message\ndata: {msg}\n\n"))))),
            Poll::Ready(None) => return Poll::Ready(None),
            Poll::Pending => {}
        }
        if self.keep_alive.poll_tick(cx).is_ready() {
            return Poll::Ready(Some(Ok(Bytes::from_static(b": keepalive\n\n"))));
        }
        Poll::Pending
    }
}

fn sse_response(rx: mpsc::UnboundedReceiver<Value>, release: Release, session: Option<&str>) -> Response {
    let start = tokio::time::Instant::now() + KEEP_ALIVE;
    let body = SseBody { rx, keep_alive: tokio::time::interval_at(start, KEEP_ALIVE), _release: release };
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header("x-accel-buffering", "no");
    if let Some(id) = session {
        builder = builder.header("mcp-session-id", id);
    }
    builder.body(Body::from_stream(body)).unwrap()
}

async fn handle(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let started = Instant::now();
    let port = shared.port;
    let headers = req.headers().clone();
    // DNS-rebinding hardening: only the literal local origins may talk to the server.
    let host = header_str(&headers, "host").unwrap_or("");
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return empty(StatusCode::FORBIDDEN);
    }
    if let Some(origin) = header_str(&headers, "origin")
        && origin != format!("http://127.0.0.1:{port}")
        && origin != format!("http://localhost:{port}")
    {
        return empty(StatusCode::FORBIDDEN);
    }
    if req.uri().path_and_query().map(|p| p.as_str()) != Some("/mcp") {
        return empty(StatusCode::NOT_FOUND);
    }
    let Some(token) = bearer(&headers) else { return empty(StatusCode::UNAUTHORIZED) };
    let found = {
        let inner = shared.inner.lock();
        // Constant-time over every issued token: no early exit on the first differing byte.
        let mut found = None;
        for (t, cell) in &inner.tokens {
            if ct_eq(t.as_bytes(), token.as_bytes()) {
                found = Some((cell.clone(), inner.token_cancel.get(t).cloned().unwrap_or_default()));
            }
        }
        found
    };
    let Some((cell, token_cancel)) = found else { return empty(StatusCode::UNAUTHORIZED) };
    let session_id = header_str(&headers, "mcp-session-id").map(str::to_string);
    if req.method() == Method::DELETE
        && let Some(id) = &session_id
    {
        let mut inner = shared.inner.lock();
        if inner.sessions.get(id).is_none_or(|s| s.token != token) {
            return empty(StatusCode::NOT_FOUND);
        }
        close_session(&mut inner, id);
        shared.fake.events.push(json!({ "kind": "session-close", "by": "delete" }));
        return empty(StatusCode::OK);
    }
    if req.method() != Method::POST {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "POST")
            .body(Body::empty())
            .unwrap();
    }
    // Cheap concurrency checks first, so a rejected request does not also spend rate budget.
    {
        let mut inner = shared.inner.lock();
        let in_flight = inner.in_flight.get(&token).copied().unwrap_or(0);
        let busy = in_flight >= shared.cfg.max_in_flight_per_token || inner.stateless_in_flight >= shared.cfg.max_in_flight;
        if busy || !allow(&mut inner, &shared.cfg, &token) {
            return Response::builder()
                .status(StatusCode::TOO_MANY_REQUESTS)
                .header(header::RETRY_AFTER, "1")
                .body(Body::empty())
                .unwrap();
        }
        inner.in_flight.insert(token.clone(), in_flight + 1);
    }
    let abort = token_cancel.child_token();
    let mut release = Release { shared: shared.clone(), token: token.clone(), stateless: false, abort: abort.clone() };
    // Hyper drops this future when the client goes away before the answer: the guard aborts the running call. An SSE answer
    // disarms it (the Release guard in the body takes over).
    let guard = abort.clone().drop_guard();

    let raw = match read_body(req.into_body(), started).await {
        BodyRead::Ok(raw) => raw,
        BodyRead::TooLarge => return json_error(StatusCode::PAYLOAD_TOO_LARGE, -32000, "Request body too large."),
        BodyRead::Timeout => return empty(StatusCode::REQUEST_TIMEOUT),
    };
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return json_error(StatusCode::BAD_REQUEST, -32700, "Parse error: invalid JSON.");
    };

    if let Some(id) = session_id {
        let session = shared.inner.lock().sessions.get(&id).cloned();
        let Some(session) = session.filter(|s| s.token == token) else {
            return json_error(StatusCode::NOT_FOUND, -32001, "Session not found.");
        };
        return transport(&shared, &headers, body, Mode::Session(session), release, guard).await;
    }
    let session_slot = wants_session(&body) && shared.inner.lock().sessions.len() < MAX_SESSIONS;
    if session_slot {
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
async fn read_body(body: Body, started: Instant) -> BodyRead {
    let deadline = tokio::time::Instant::from_std(started + Duration::from_secs(30));
    let mut body = body;
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

fn allow(inner: &mut Inner, cfg: &Config, token: &str) -> bool {
    let Some((burst, per_second)) = cfg.rate else { return true };
    let now = Instant::now();
    let bucket = inner.buckets.entry(token.to_string()).or_insert((burst, now));
    let elapsed = now.saturating_duration_since(bucket.1).as_secs_f64();
    bucket.0 = (bucket.0 + elapsed * per_second).min(burst);
    bucket.1 = now;
    if bucket.0 < 1.0 {
        return false;
    }
    bucket.0 -= 1.0;
    true
}

enum Mode {
    Stateless { token: String, cell: String, json: bool },
    NewSession { token: String, cell: String, token_cancel: CancellationToken },
    Session(Arc<Session>),
}

/// The StreamableHTTPServerTransport part: header checks, message validation, 202 / JSON / SSE.
async fn transport(
    shared: &Arc<Shared>,
    headers: &HeaderMap,
    body: Value,
    mode: Mode,
    release: Release,
    guard: DropGuard,
) -> Response {
    let abort = release.abort.clone();
    let accept = header_str(headers, "accept").unwrap_or("");
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return json_error(
            StatusCode::NOT_ACCEPTABLE,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
        );
    }
    let content_type = header_str(headers, "content-type").unwrap_or("");
    if content_type.split(';').next().map(|t| t.trim().to_ascii_lowercase()) != Some("application/json".into()) {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
        );
    }
    if body.as_array().is_some_and(|a| a.len() > 100) {
        return json_error(StatusCode::BAD_REQUEST, -32600, "Invalid Request: Batch must not exceed 100 messages");
    }
    let messages: Vec<Value> = messages_of(&body).into_iter().cloned().collect();
    if !messages.iter().all(valid_message) {
        return json_error(StatusCode::BAD_REQUEST, -32700, "Parse error: Invalid JSON-RPC message");
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
        && !SUPPORTED.contains(&version)
    {
        let message =
            format!("Bad Request: Unsupported protocol version: {version} (supported versions: {})", SUPPORTED.join(", "));
        return json_error(StatusCode::BAD_REQUEST, -32000, &message);
    }

    let (session, token, cell, json_mode) = match mode {
        Mode::Stateless { token, cell, json } => (None, token, cell, json),
        Mode::Session(s) => {
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
            let mut inner = shared.inner.lock();
            inner.sessions.insert(session.id.clone(), session.clone());
            inner.session_order.push(session.id.clone());
            trim_sessions(&mut inner, &token);
            drop(inner);
            shared.fake.events.push(json!({ "kind": "session-open", "cell": cell }));
            (Some(session), token, cell, false)
        }
    };

    if !messages.iter().any(is_request) {
        for m in &messages {
            accept_message(shared, session.as_deref(), m);
        }
        return empty(StatusCode::ACCEPTED);
    }
    let batch = body.is_array();
    let ctx = Arc::new(ReqCtx { shared: shared.clone(), session: session.clone(), token, cell, abort: abort.clone() });
    if json_mode {
        let mut out = Vec::new();
        let work = async {
            for m in &messages {
                if is_request(m) {
                    out.push(dispatch(&ctx, m.clone(), None).await);
                } else {
                    accept_message(shared, session.as_deref(), m);
                }
            }
        };
        // Measured in SP8: with half-close off (hyper's default) hyper notices the client's FIN while this handler is
        // pending and drops the handler future, so `guard` aborts the call (as 1.1.4's res 'close'); no socket watcher needed.
        work.await;
        drop(release);
        let body = if batch { Value::Array(out) } else { out.pop().unwrap_or(Value::Null) };
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
    }
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let session_header = session.as_ref().map(|s| s.id.clone());
    for m in messages {
        if !is_request(&m) {
            accept_message(shared, session.as_deref(), &m);
            continue;
        }
        let ctx = ctx.clone();
        let tx = tx.clone();
        let request_abort = abort.child_token();
        if let Some(s) = &session {
            s.requests.lock().insert(id_key(&m["id"]), request_abort.clone());
        }
        // Every long operation observes request_abort, so the call ends (and logs) on its own when the client goes away.
        tokio::spawn(async move {
            let id = id_key(&m["id"]);
            let answer = dispatch_with(&ctx, m, Some(tx.clone()), request_abort).await;
            if let Some(s) = &ctx.session {
                s.requests.lock().remove(&id);
            }
            let _ = tx.send(answer);
        });
    }
    drop(tx);
    guard.disarm();
    sse_response(rx, release, session_header.as_deref())
}

/// Notifications and responses: elicitation answers reach their waiting call, notifications/cancelled ends a request.
fn accept_message(shared: &Arc<Shared>, session: Option<&Session>, m: &Value) {
    let Some(session) = session else { return };
    if m.get("method").is_none() {
        let sender = session.pending.lock().remove(&id_key(&m["id"]));
        if let Some(sender) = sender {
            let _ = sender.send(m.clone());
        }
        return;
    }
    if m["method"] == "notifications/cancelled" {
        let request = session.requests.lock().get(&id_key(&m["params"]["requestId"])).cloned();
        if let Some(cancel) = request {
            shared.fake.events.push(json!({ "kind": "client-cancelled" }));
            cancel.cancel();
        }
    }
}

struct ReqCtx {
    shared: Arc<Shared>,
    session: Option<Arc<Session>>,
    token: String,
    cell: String,
    abort: CancellationToken,
}

impl ReqCtx {
    fn live(&self) -> bool {
        self.shared.inner.lock().tokens.get(&self.token).is_some_and(|c| *c == self.cell)
    }
}

fn result(id: &Value, result: Value) -> Value {
    // The SDK's key order: result, jsonrpc, id.
    let mut m = Map::new();
    m.insert("result".into(), result);
    m.insert("jsonrpc".into(), json!("2.0"));
    m.insert("id".into(), id.clone());
    Value::Object(m)
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// An McpError as the SDK serializes it: the message carries the `MCP error <code>: ` prefix.
fn mcp_error(id: &Value, code: i64, message: &str) -> Value {
    error(id, code, &format!("MCP error {code}: {message}"))
}

async fn dispatch(ctx: &Arc<ReqCtx>, m: Value, out: Option<mpsc::UnboundedSender<Value>>) -> Value {
    dispatch_with(ctx, m, out, ctx.abort.clone()).await
}

async fn dispatch_with(
    ctx: &Arc<ReqCtx>,
    m: Value,
    out: Option<mpsc::UnboundedSender<Value>>,
    cancel: CancellationToken,
) -> Value {
    let id = m["id"].clone();
    let params = &m["params"];
    let fake = &ctx.shared.fake;
    match m["method"].as_str().unwrap_or("") {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = if SUPPORTED.contains(&asked) { asked } else { LATEST };
            result(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {}, "tasks": { "list": {}, "cancel": {}, "requests": { "tools": { "call": {} } } } },
                    "serverInfo": { "name": "unimux", "version": ctx.shared.cfg.version },
                    "instructions": fake.instructions,
                }),
            )
        }
        "ping" => result(&id, json!({})),
        "tools/list" => {
            fake.events.push(json!({ "kind": "tools-list", "cell": ctx.cell }));
            result(&id, json!({ "tools": fake.tools_for(&ctx.cell) }))
        }
        "tools/call" => tools_call(ctx, &id, params, out, cancel).await,
        "tasks/get" => {
            let inner = ctx.shared.inner.lock();
            match find_task(&inner, &ctx.token, params["taskId"].as_str().unwrap_or("")) {
                Some(t) => result(&id, t.task.clone()),
                None => mcp_error(&id, -32602, "Failed to retrieve task: Task not found"),
            }
        }
        "tasks/result" => task_result(ctx, &id, params["taskId"].as_str().unwrap_or(""), cancel).await,
        "tasks/list" => {
            let inner = ctx.shared.inner.lock();
            let tasks: Vec<Value> =
                inner.tasks.get(&ctx.token).map(|v| v.iter().take(10).map(|(_, t)| t.task.clone()).collect()).unwrap_or_default();
            result(&id, json!({ "tasks": tasks, "_meta": {} }))
        }
        "tasks/cancel" => {
            let task_id = params["taskId"].as_str().unwrap_or("");
            let mut inner = ctx.shared.inner.lock();
            let Some(entry) =
                inner.tasks.get_mut(&ctx.token).and_then(|v| v.iter_mut().find(|(i, _)| i == task_id)).map(|(_, t)| t)
            else {
                return mcp_error(&id, -32602, &format!("Task not found: {task_id}"));
            };
            let status = entry.task["status"].as_str().unwrap_or("").to_string();
            if ["completed", "failed", "cancelled"].contains(&status.as_str()) {
                return mcp_error(&id, -32602, &format!("Cannot cancel task in terminal status: {status}"));
            }
            entry.task["status"] = json!("cancelled");
            entry.task["statusMessage"] = json!("Client cancelled task execution.");
            entry.task["lastUpdatedAt"] = json!(iso_now());
            entry.cancel.cancel();
            entry.changed.notify_waiters();
            let mut answer = Map::new();
            answer.insert("_meta".into(), json!({}));
            for (k, v) in entry.task.as_object().cloned().unwrap_or_default() {
                answer.insert(k, v);
            }
            result(&id, Value::Object(answer))
        }
        _ => error(&id, -32601, "Method not found"),
    }
}

async fn tools_call(
    ctx: &Arc<ReqCtx>,
    id: &Value,
    params: &Value,
    out: Option<mpsc::UnboundedSender<Value>>,
    cancel: CancellationToken,
) -> Value {
    let name = params["name"].as_str().unwrap_or("").to_string();
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let fake = ctx.shared.fake.clone();
    if params.get("task").is_some_and(Value::is_object) {
        if !ctx.live() {
            return mcp_error(id, -32600, "Agent connection has expired.");
        }
        if !Fake::supports_task(&name) {
            return mcp_error(id, -32601, &format!("Tool {name} does not run as a task."));
        }
        return start_task(ctx, id, &name, args, params["task"]["ttl"].as_u64());
    }
    let progress: Option<Progress> = match (&out, &params["_meta"]["progressToken"]) {
        (Some(tx), token) if token.is_string() || token.is_number() => {
            let (tx, token) = (tx.clone(), token.clone());
            Some(Arc::new(move |progress: f64, total: f64, message: String| {
                let _ = tx.send(json!({ "method": "notifications/progress",
                    "params": { "progressToken": token, "progress": js_number(progress), "total": js_number(total), "message": message },
                    "jsonrpc": "2.0" }));
            }))
        }
        _ => None,
    };
    let elicit: Option<Elicit> = match (&ctx.session, &out) {
        (Some(session), Some(tx)) if session.form_elicitation => Some(elicit_on(session.clone(), tx.clone(), cancel.clone())),
        _ => None,
    };
    if !ctx.live() {
        return result(id, error_content("Agent connection has expired."));
    }
    let call = CallCtx {
        cell: ctx.cell.clone(),
        cancel: cancel.clone(),
        elicit,
        progress,
        progress_every: ctx.shared.cfg.progress_every,
        task: false,
    };
    match fake.call(&name, &args, call).await {
        Ok(_) if !ctx.live() => result(id, error_content("Agent connection has expired.")),
        Ok(value) => {
            result(id, json!({ "content": [{ "type": "text", "text": cap_result(&value.to_string(), MAX_RESULT_CHARS) }] }))
        }
        Err(CallError::Unknown) => mcp_error(id, -32602, &format!("Unknown tool: {name}")),
        Err(CallError::Tool(text)) => result(id, error_content(&text)),
        Err(CallError::Aborted) => result(id, error_content("This operation was aborted")),
    }
}

fn error_content(text: &str) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": text }] })
}

/// JS numbers: a whole f64 prints without `.0`.
fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

/// elicitation/create on the calling tool call's stream; the answer comes back as a POST of the same session.
fn elicit_on(session: Arc<Session>, tx: mpsc::UnboundedSender<Value>, cancel: CancellationToken) -> Elicit {
    Arc::new(move |message: String, schema: Value| {
        let (session, tx, cancel) = (session.clone(), tx.clone(), cancel.clone());
        Box::pin(async move {
            let n = session.next_id.fetch_add(1, Ordering::Relaxed);
            let id = json!(n);
            let (answer_tx, answer_rx) = oneshot::channel();
            session.pending.lock().insert(id_key(&id), answer_tx);
            let request = json!({ "method": "elicitation/create", "params": { "mode": "form", "message": message, "requestedSchema": schema },
                "jsonrpc": "2.0", "id": id });
            let cancelled = ElicitAnswer { action: "cancel".into(), content: None };
            if tx.send(request).is_err() {
                return cancelled;
            }
            let answer = tokio::select! {
                a = tokio::time::timeout(ELICIT_TIMEOUT, answer_rx) => a.ok().and_then(Result::ok),
                () = cancel.cancelled() => None,
                () = session.cancel.cancelled() => None,
            };
            session.pending.lock().remove(&id_key(&id));
            match answer {
                Some(m) if m["result"]["action"].is_string() => ElicitAnswer {
                    action: m["result"]["action"].as_str().unwrap_or("cancel").to_string(),
                    content: m["result"].get("content").cloned(),
                },
                _ => cancelled,
            }
        })
    })
}

fn find_task<'a>(inner: &'a Inner, token: &str, task_id: &str) -> Option<&'a TaskEntry> {
    inner.tasks.get(token)?.iter().find(|(i, _)| i == task_id).map(|(_, t)| t)
}

/// `new Date().toISOString()`.
fn iso_now() -> String {
    let ms = now_ms() as i64;
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn start_task(ctx: &Arc<ReqCtx>, id: &Value, name: &str, args: Value, ttl: Option<u64>) -> Value {
    let mut inner = ctx.shared.inner.lock();
    let running =
        inner.tasks.get(&ctx.token).map(|v| v.iter().filter(|(_, t)| t.task["status"] == "working").count()).unwrap_or(0);
    if running >= MAX_RUNNING_TASKS {
        return mcp_error(id, -32600, &format!("At most {MAX_RUNNING_TASKS} tasks may run at once; wait for one to finish."));
    }
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).expect("os random");
    let task_id: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let ttl = ttl.unwrap_or(TASK_TTL_MS).clamp(MIN_TASK_TTL_MS, TASK_TTL_MS);
    let created = iso_now();
    let task = json!({ "taskId": task_id, "status": "working", "ttl": ttl, "createdAt": created, "lastUpdatedAt": created, "pollInterval": TASK_POLL_MS });
    let Some(token_cancel) = inner.token_cancel.get(&ctx.token).cloned() else {
        return mcp_error(id, -32600, "Agent connection has expired.");
    };
    let cancel = token_cancel.child_token();
    let changed = Arc::new(tokio::sync::Notify::new());
    inner.tasks.entry(ctx.token.clone()).or_default().push((
        task_id.clone(),
        TaskEntry { task: task.clone(), result: None, cancel: cancel.clone(), changed: changed.clone() },
    ));
    drop(inner);
    let (shared, token, cell, name) = (ctx.shared.clone(), ctx.token.clone(), ctx.cell.clone(), name.to_string());
    let tid = task_id.clone();
    tokio::spawn(async move {
        let call = CallCtx {
            cell: cell.clone(),
            cancel: cancel.clone(),
            elicit: None,
            progress: None,
            progress_every: shared.cfg.progress_every,
            task: true,
        };
        let outcome = shared.fake.call(&name, &args, call).await;
        let live = shared.inner.lock().tokens.get(&token).is_some_and(|c| *c == cell);
        let content = match outcome {
            Ok(_) if !live => error_content("Agent connection has expired."),
            Ok(value) => json!({ "content": [{ "type": "text", "text": cap_result(&value.to_string(), MAX_RESULT_CHARS) }] }),
            Err(CallError::Unknown) => error_content(&format!("Unknown tool: {name}")),
            Err(CallError::Tool(text)) => error_content(&text),
            Err(CallError::Aborted) => error_content("This operation was aborted"),
        };
        let mut inner = shared.inner.lock();
        if let Some((_, entry)) = inner.tasks.get_mut(&token).and_then(|v| v.iter_mut().find(|(i, _)| *i == tid))
            && entry.task["status"] == "working"
        {
            entry.task["status"] = json!("completed");
            entry.task["lastUpdatedAt"] = json!(iso_now());
            entry.result = Some(content);
            entry.changed.notify_waiters();
        }
    });
    // Expiry after the ttl (1.1.4 keeps a task and its result for its ttl).
    let (shared, token) = (ctx.shared.clone(), ctx.token.clone());
    let tid = task_id;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ttl)).await;
        if let Some(v) = shared.inner.lock().tasks.get_mut(&token) {
            v.retain(|(i, _)| *i != tid);
        }
    });
    result(id, json!({ "task": task }))
}

/// tasks/result blocks until the task is terminal, then answers its result with the related-task meta.
async fn task_result(ctx: &Arc<ReqCtx>, id: &Value, task_id: &str, cancel: CancellationToken) -> Value {
    loop {
        let changed = {
            let inner = ctx.shared.inner.lock();
            let Some(entry) = find_task(&inner, &ctx.token, task_id) else {
                return mcp_error(id, -32602, &format!("Task not found: {task_id}"));
            };
            let status = entry.task["status"].as_str().unwrap_or("");
            if ["completed", "failed", "cancelled"].contains(&status) {
                let Some(mut answer) = entry.result.clone() else {
                    return mcp_error(id, -32603, &format!("Task {task_id} has no result stored"));
                };
                answer["_meta"] = json!({ "io.modelcontextprotocol/related-task": { "taskId": task_id } });
                return result(id, answer);
            }
            entry.changed.clone()
        };
        tokio::select! {
            () = changed.notified() => {}
            () = tokio::time::sleep(Duration::from_millis(TASK_POLL_MS)) => {}
            () = cancel.cancelled() => return mcp_error(id, -32603, "This operation was aborted"),
        }
    }
}

fn trim_sessions(inner: &mut Inner, token: &str) {
    let own: Vec<String> =
        inner.session_order.iter().filter(|id| inner.sessions.get(*id).is_some_and(|s| s.token == token)).cloned().collect();
    let excess = own.len().saturating_sub(MAX_SESSIONS_PER_TOKEN);
    for id in own.into_iter().take(excess) {
        close_session(inner, &id);
    }
}

fn close_session(inner: &mut Inner, id: &str) {
    if let Some(session) = inner.sessions.remove(id) {
        session.cancel.cancel();
        for (_, cancel) in session.requests.lock().drain() {
            cancel.cancel();
        }
    }
    inner.session_order.retain(|s| s != id);
}
