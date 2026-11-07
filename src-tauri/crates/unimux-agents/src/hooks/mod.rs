//! The local endpoint for agent status hooks (port of src/main/hooks.ts `HookServer`, 1.1.4).
//!
//! Claude gets a per-cell settings file ([`claude`], H2) whose hooks post here: Claude Code 2.1.63+ posts itself (`type: "http"` hooks,
//! the token in a header), older versions run `curl` through their hook shell; Codex posts its notify payload; the launch
//! line of a role cell posts the CLI's exit code.
//!
//! Routes (127.0.0.1, a random port):
//! - `POST /h/<token>/<cell>/<event>/<nonce>`: curl hooks, the run's token in the path;
//! - `POST /k/<cell>/<event>/<nonce>` with `Authorization: Bearer <token>`: http hooks;
//! - `POST /x/<cell>/<nonce>/<exit code>`: the end of the agent CLI (the spawn's nonce is the whole credential).
//!
//! Answers: 403 for a wrong token, a wrong method or an unknown route; 400 for a cell id that does not decode or is not
//! `[\w-]{1,64}`; 204 without a body otherwise, sent only after the whole body was read (an http hook whose connection breaks
//! shows the user a hook error, and hook stdout would be fed back to Claude). A request must arrive within 5 s (Node's
//! `requestTimeout`: 408 and the connection closes). Each spawn has its own 8-byte nonce: late requests of a killed process
//! (or old-format URLs without one) are answered and dropped.

pub mod body;
pub mod claude;
pub mod codex;
pub mod fallback;
mod jsontext;
pub mod payload;
pub mod route;

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::time::Instant;

use body::{Capped, HeadTail, Utf8Stream};
use payload::{CodexNotice, DebugKind};

/// How much of a tool hook's payload is read: its head (tool name and ids come first) and its tail (tool_use_id after a large
/// input), in UTF-16 code units.
pub const TOOL_HEAD: usize = 16 * 1024;
pub const TOOL_TAIL: usize = 2 * 1024;
/// Notification and SessionStart payloads.
pub const MAX_BODY: usize = 16 * 1024;
/// The Stop / StopFailure payload carries last_assistant_message, so it may be much larger.
pub const MAX_STOP_BODY: usize = 512 * 1024;
/// Codex appends its whole notify payload to the command line; one that big still means "turn done".
pub const MAX_CODEX_BODY: usize = 1024 * 1024;
/// hook-debug.log is restarted when it is larger than this.
pub const DEBUG_LOG_MAX: u64 = 256 * 1024;
/// Node's `server.requestTimeout` of the 1.1.4 server.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// A listen that never completes (loopback blocked by security software) fails instead of hanging.
pub const LISTEN_TIMEOUT: Duration = Duration::from_secs(10);

/// URL events with a status meaning (`EVENTS`).
const EVENTS: [&str; 8] = ["prompt", "stop", "stopbg", "notify", "busy", "fail", "subagent", "codex"];
/// The precise Claude hooks (2.1.78+): only the head and the tail of their payload are read.
const TOOL_EVENTS: [&str; 8] = ["pre", "post", "permission", "subagentstart", "compact", "compacted", "elicit", "elicited"];
/// Small payloads the server keeps (Stop, StopFailure and Codex have their own, larger limits).
const BODY_EVENTS: [&str; 2] = ["notify", "session"];

/// What the server heard (the events of the TS EventEmitter, in the order it emits them).
#[derive(Debug, Clone, PartialEq)]
pub enum HookSignal {
    /// `hook`: a status event for the cell's tracker (`cell:hook` after the app's checks).
    Hook { cell: String, event: String, info: Option<Value> },
    /// `session`: the conversation of a SessionStart (followed by the app when the cell is a live Claude cell).
    Session { cell: String, session_id: String, source: Option<String> },
    /// `sessionstart`: ends background mode; never a status change by itself.
    SessionStart { cell: String, source: Option<String> },
    /// `transcript`: the transcript a Claude payload named (the context meter, H4).
    Transcript { cell: String, session_id: String, path: String },
    /// `codex`: a Codex turn completed.
    Codex { cell: String, notice: CodexNotice },
    /// `cliexit`: the launch line's tail reported that the agent CLI ended.
    CliExit { cell: String, code: Option<i64> },
}

impl HookSignal {
    /// The TS event name and its arguments as JSON (undefined as null), for the golden comparison and diagnostics.
    pub fn to_json(&self) -> Value {
        let opt = |s: &Option<String>| s.as_ref().map_or(Value::Null, |s| json!(s));
        match self {
            Self::Hook { cell, event, info } => json!(["hook", cell, event, info.clone().unwrap_or(Value::Null)]),
            Self::Session { cell, session_id, source } => json!(["session", cell, session_id, opt(source)]),
            Self::SessionStart { cell, source } => json!(["sessionstart", cell, opt(source)]),
            Self::Transcript { cell, session_id, path } => json!(["transcript", cell, session_id, path]),
            Self::Codex { cell, notice } => json!(["codex", cell, notice.to_json()]),
            Self::CliExit { cell, code } => json!(["cliexit", cell, code.map_or(Value::Null, |c| json!(c))]),
        }
    }
}

/// Receives every signal, on the connection's task (keep it short: emit and return).
pub type SignalHandler = Arc<dyn Fn(HookSignal) + Send + Sync>;

fn random_hex(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    getrandom::fill(&mut raw).expect("os random source");
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`: None where JS throws a URIError (a bad escape, bytes that are not UTF-8).
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3)?;
            let text = std::str::from_utf8(hex).ok()?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(text, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `/^-?\d{1,10}$/` then `Number(...)`.
fn exit_code(s: &str) -> Option<i64> {
    let digits = s.strip_prefix('-').unwrap_or(s);
    if !(1..=10).contains(&digits.len()) || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Appends a Stop / StopFailure / SessionStart diagnostics line to `<dir>/hook-debug.log` (restarted when it exceeds
/// 256 KiB). Diagnostics are optional: every error is ignored. Writes are serialized (Node ran them on one thread): two
/// handlers that both saw the old size must not truncate each other's line.
pub fn log_stop_debug(dir: &Path, cell_id: &str, body: &str, kind: Option<DebugKind>) {
    use std::io::Write as _;
    static WRITE: Mutex<()> = Mutex::new(());
    let _one_at_a_time = WRITE.lock();
    let file = dir.join("hook-debug.log");
    let _ = std::fs::create_dir_all(dir);
    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    if size > DEBUG_LOG_MAX {
        let _ = std::fs::write(&file, b"");
    }
    let now = unimux_core::time::now_ms();
    let line = match kind {
        None => payload::stop_debug_line(cell_id, body, now),
        Some(k) => payload::hook_debug_line(k, cell_id, body, now),
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = f.write_all(line.as_bytes());
    }
}

struct Shared {
    token: String,
    /// The current spawn nonce per cell; hook URLs carry it.
    nonces: Mutex<HashMap<String, String>>,
    /// Set (MC_HOOK_DEBUG=1) to the data dir: Stop / StopFailure / SessionStart payload shapes go to hook-debug.log.
    debug_dir: RwLock<Option<PathBuf>>,
    handler: RwLock<Option<SignalHandler>>,
}

impl Shared {
    fn emit(&self, signal: HookSignal) {
        let handler = self.handler.read().clone();
        if let Some(h) = handler {
            h(signal);
        }
    }

    fn debug(&self, cell: &str, body: &str, kind: Option<DebugKind>) {
        let dir = self.debug_dir.read().clone();
        if let Some(dir) = dir {
            log_stop_debug(&dir, cell, body, kind);
        }
    }
}

/// The hook server of one app run: a 16-byte token per run, an 8-byte nonce per spawn.
pub struct HookServer {
    shared: Arc<Shared>,
    port: RwLock<u16>,
    stop: Mutex<Option<watch::Sender<bool>>>,
}

impl Default for HookServer {
    fn default() -> Self {
        Self::new()
    }
}

impl HookServer {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                token: random_hex(16),
                nonces: Mutex::new(HashMap::new()),
                debug_dir: RwLock::new(None),
                handler: RwLock::new(None),
            }),
            port: RwLock::new(0),
            stop: Mutex::new(None),
        }
    }

    pub fn token(&self) -> &str {
        &self.shared.token
    }

    /// The listening port (0 until [`HookServer::start`] succeeded).
    pub fn port(&self) -> u16 {
        *self.port.read()
    }

    /// MC_HOOK_DEBUG: the folder of hook-debug.log (the data dir), or None.
    pub fn set_debug_dir(&self, dir: Option<PathBuf>) {
        *self.shared.debug_dir.write() = dir;
    }

    /// Where the signals go (one handler; the app routes them).
    pub fn set_handler(&self, handler: SignalHandler) {
        *self.shared.handler.write() = Some(handler);
    }

    /// Listens on 127.0.0.1 with a random port. Fails when the listen does not complete within 10 s. Later errors of a
    /// running server (a broken connection) are not fatal.
    pub async fn start(&self) -> std::io::Result<u16> {
        let listener = match tokio::time::timeout(LISTEN_TIMEOUT, TcpListener::bind(("127.0.0.1", 0))).await {
            Ok(r) => r?,
            Err(_) => {
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "hook server did not start listening in time"));
            }
        };
        let port = listener.local_addr()?.port();
        *self.port.write() = port;
        let (tx, rx) = watch::channel(false);
        *self.stop.lock() = Some(tx);
        let shared = self.shared.clone();
        tokio::spawn(accept_loop(listener, shared, rx));
        Ok(port)
    }

    /// `server.close()` of Node 22: no new connections, idle keep-alive connections close now, requests in flight finish and
    /// their connection closes after the answer.
    pub fn stop(&self) {
        if let Some(tx) = self.stop.lock().take() {
            let _ = tx.send(true);
        }
    }

    fn nonce_or_new(&self, cell_id: &str) -> String {
        self.shared.nonces.lock().entry(cell_id.to_string()).or_insert_with(|| random_hex(8)).clone()
    }

    /// A fresh nonce for the cell: hooks of its previous process are dropped from now on (writeClaudeSettings, prepareCodex).
    pub fn renew_nonce(&self, cell_id: &str) -> String {
        let nonce = random_hex(8);
        self.shared.nonces.lock().insert(cell_id.to_string(), nonce.clone());
        nonce
    }

    /// The cell's current nonce, if it has one.
    pub fn nonce(&self, cell_id: &str) -> Option<String> {
        self.shared.nonces.lock().get(cell_id).cloned()
    }

    /// Hook URL for the cell's current spawn (a nonce is created on first use).
    pub fn url(&self, cell_id: &str, event: &str) -> String {
        let nonce = self.nonce_or_new(cell_id);
        format!("http://127.0.0.1:{}/h/{}/{}/{event}/{nonce}", self.port(), self.shared.token, encode_uri_component(cell_id))
    }

    /// Hook URL of an http hook: the token travels in the Authorization header instead of the path.
    pub fn header_url(&self, cell_id: &str, event: &str) -> String {
        self.url(cell_id, event).replacen(&format!("/h/{}/", self.shared.token), "/k/", 1)
    }

    /// Hook URL a Codex process of the cell posts its notify payload to; a fresh nonce invalidates the previous process.
    pub fn prepare_codex(&self, cell_id: &str) -> String {
        self.renew_nonce(cell_id);
        self.url(cell_id, "codex")
    }

    /// The URL the launch line posts the CLI's exit code to (`/<code>` appended by the shell). Call it after the spawn's
    /// nonce was made (writeClaudeSettings / prepareCodex); a later spawn's nonce makes it stale.
    pub fn exit_url(&self, cell_id: &str) -> String {
        let nonce = self.nonce_or_new(cell_id);
        format!("http://127.0.0.1:{}/x/{cell_id}/{nonce}", self.port())
    }

    /// The cell is gone for good: its nonce goes too (late hooks of its last process are dropped like unknown ones).
    pub fn forget(&self, cell_id: &str) {
        self.shared.nonces.lock().remove(cell_id);
    }
}

impl Drop for HookServer {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn accept_loop(listener: TcpListener, shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    loop {
        let accepted = tokio::select! {
            r = listener.accept() => r,
            _ = stop.changed() => return,
        };
        let Ok((stream, _addr)) = accepted else {
            // EMFILE and the like: keep serving.
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        };
        let _ = stream.set_nodelay(true);
        let shared = shared.clone();
        let mut conn_stop = stop.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let service = service_fn(move |req: Request<Incoming>| {
                let shared = shared.clone();
                async move { Ok::<_, Infallible>(handle(&shared, req).await) }
            });
            let conn =
                http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(REQUEST_TIMEOUT).serve_connection(io, service);
            tokio::pin!(conn);
            tokio::select! {
                _ = conn.as_mut() => {}
                // Stopped (or the server is gone): an idle connection closes, a request in flight is answered first.
                () = async { let _ = conn_stop.wait_for(|stopped| *stopped).await; } => {
                    conn.as_mut().graceful_shutdown();
                    let _ = conn.await;
                }
            }
        });
    }
}

type Reply = Response<Empty<Bytes>>;

fn reply(status: u16) -> Reply {
    let mut r = Response::new(Empty::new());
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::NO_CONTENT);
    r
}

/// Node's 408 for a request that did not arrive in time; the connection closes.
fn timed_out() -> Reply {
    let mut r = reply(408);
    r.headers_mut().insert(hyper::header::CONNECTION, hyper::header::HeaderValue::from_static("close"));
    r
}

/// Reads the body to its end, giving each decoded piece of text to `sink`. Err(true) when the 5 s ran out, Err(false) when
/// the connection broke.
async fn read_body(body: &mut Incoming, deadline: Instant, mut sink: impl FnMut(&str)) -> Result<(), bool> {
    let mut decoder = Utf8Stream::default();
    let mut text = String::new();
    loop {
        let frame = match tokio::time::timeout_at(deadline, body.frame()).await {
            Err(_) => return Err(true),
            Ok(None) => break,
            Ok(Some(Err(_))) => return Err(false),
            Ok(Some(Ok(frame))) => frame,
        };
        if let Ok(data) = frame.into_data() {
            text.clear();
            decoder.push(&data, &mut text);
            if !text.is_empty() {
                sink(&text);
            }
        }
    }
    text.clear();
    decoder.finish(&mut text);
    if !text.is_empty() {
        sink(&text);
    }
    Ok(())
}

/// Reads and discards the body (an answer is never sent before the request was read: the client would see a reset).
async fn drain(body: &mut Incoming, deadline: Instant) -> Result<(), bool> {
    loop {
        match tokio::time::timeout_at(deadline, body.frame()).await {
            Err(_) => return Err(true),
            Ok(None) => return Ok(()),
            Ok(Some(Err(_))) => return Err(false),
            Ok(Some(Ok(_))) => {}
        }
    }
}

/// `req.url` of Node: the request target as sent (an absolute-form target keeps its scheme and host).
fn request_target(req: &Request<Incoming>) -> String {
    let uri = req.uri();
    if uri.scheme().is_some() {
        return uri.to_string();
    }
    uri.path_and_query().map_or_else(|| uri.path().to_string(), |pq| pq.as_str().to_string())
}

async fn handle(shared: &Shared, req: Request<Incoming>) -> Reply {
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    let target = request_target(&req);
    let mut parts: Vec<String> = target.split('/').filter(|p| !p.is_empty()).map(str::to_string).collect();
    let post = req.method() == hyper::Method::POST;
    let bearer = req.headers().get(hyper::header::AUTHORIZATION).map(|v| v.as_bytes().to_vec());
    let mut body = req.into_body();
    let finish = |status: u16, read: Result<(), bool>| match read {
        Err(true) => timed_out(),
        _ => reply(status),
    };

    // x/<cellId>/<nonce>/<exit code>: the launch line's tail says the agent CLI ended.
    if parts.first().map(String::as_str) == Some("x") {
        let cell = parts.get(1).cloned().unwrap_or_default();
        let nonce = parts.get(2).cloned().unwrap_or_default();
        if post && payload::is_cell_id(&cell) && !nonce.is_empty() && shared.nonces.lock().get(&cell) == Some(&nonce) {
            let code = exit_code(parts.get(3).map_or("", String::as_str));
            shared.emit(HookSignal::CliExit { cell, code });
        }
        let read = drain(&mut body, deadline).await;
        return finish(if post { 204 } else { 403 }, read);
    }

    if parts.first().map(String::as_str) == Some("k") && bearer.as_deref() == Some(format!("Bearer {}", shared.token).as_bytes())
    {
        parts.splice(0..1, ["h".to_string(), shared.token.clone()]);
    }
    if !post || parts.first().map(String::as_str) != Some("h") || parts.get(1) != Some(&shared.token) {
        let read = drain(&mut body, deadline).await;
        return finish(403, read);
    }
    let Some(cell) = decode_uri_component(parts.get(2).map_or("", String::as_str)) else {
        let read = drain(&mut body, deadline).await;
        return finish(400, read);
    };
    if !payload::is_cell_id(&cell) {
        let read = drain(&mut body, deadline).await;
        return finish(400, read);
    }
    let event = parts.get(3).cloned().unwrap_or_default();
    // Each spawn gets a fresh nonce: late requests of a killed process (or old-format URLs without one) are dropped.
    let current = parts.get(4).is_some_and(|n| shared.nonces.lock().get(&cell) == Some(n));

    let tool_event = TOOL_EVENTS.contains(&event.as_str());
    let big_payload = matches!(event.as_str(), "stop" | "fail" | "codex");
    let max_body = if event == "codex" {
        MAX_CODEX_BODY
    } else if big_payload {
        MAX_STOP_BODY
    } else {
        MAX_BODY
    };
    // An http hook always posts its whole payload; events whose status needs no payload never keep it.
    let keep_body = big_payload || BODY_EVENTS.contains(&event.as_str());

    let mut head_tail = HeadTail::new(TOOL_HEAD, TOOL_TAIL);
    let mut capped = Capped::new(max_body);
    let read = if tool_event {
        read_body(&mut body, deadline, |t| head_tail.push(t)).await
    } else if keep_body {
        read_body(&mut body, deadline, |t| capped.push(t)).await
    } else {
        drain(&mut body, deadline).await
    };
    match read {
        Err(true) => return timed_out(),
        // A connection that broke mid-body: no 'end', nothing is emitted.
        Err(false) => return reply(400),
        Ok(()) => {}
    }
    head_tail.finish();
    if current {
        interpret(shared, &cell, &event, tool_event, big_payload, &head_tail, capped);
    }
    // 204 without a body: hook stdout would otherwise be fed back to Claude as context.
    reply(204)
}

/// The `'end'` handler of hooks.ts: what the request means, emitted in the same order.
fn interpret(shared: &Shared, cell: &str, event: &str, tool_event: bool, big_payload: bool, ht: &HeadTail, capped: Capped) {
    let cell = cell.to_string();
    if capped.oversized && !big_payload {
        return;
    }
    let body = capped.text.as_str();
    if event == "codex" {
        // An oversized payload (nothing parsed) still ends the turn, just without ids.
        let notice = if capped.oversized { Some(CodexNotice::default()) } else { payload::parse_codex_notify(body) };
        if let Some(notice) = notice {
            shared.emit(HookSignal::Codex { cell, notice });
        }
        return;
    }
    if event == "session" {
        let parsed = payload::parse_session_start(body);
        note_transcript(shared, &cell, payload::parse_object(body).as_ref());
        if let Some(p) = parsed {
            shared.debug(&cell, body, Some(DebugKind::Session));
            shared.emit(HookSignal::Session { cell: cell.clone(), session_id: p.session_id, source: p.source.clone() });
            // Separate from 'hook': it never changes the status by itself, it only ends background mode.
            shared.emit(HookSignal::SessionStart { cell, source: p.source });
        }
        return;
    }
    if tool_event {
        if let Some(m) = payload::tool_hook_event_units(event, &ht.head, &ht.tail) {
            shared.emit(HookSignal::Hook { cell, event: m.event.to_string(), info: m.info });
        }
        return;
    }
    if !EVENTS.contains(&event) {
        return;
    }
    match event {
        "notify" => {
            if let Some(m) = payload::notification_event(body) {
                shared.emit(HookSignal::Hook { cell, event: m.event.to_string(), info: m.info });
            }
        }
        "stop" => {
            shared.debug(&cell, body, None);
            let parsed = payload::parse_object(body);
            note_transcript(shared, &cell, parsed.as_ref());
            let kind = if payload::has_active_background_work(parsed.as_ref()) { "stopbg" } else { "stop" };
            shared.emit(HookSignal::Hook { cell, event: kind.into(), info: Some(payload::stop_info(parsed.as_ref())) });
        }
        "fail" => {
            shared.debug(&cell, body, Some(DebugKind::Fail));
            let info = json!({ "error": payload::parse_failure(body) });
            shared.emit(HookSignal::Hook { cell, event: "fail".into(), info: Some(info) });
        }
        // Internal event, only derived from Stop.
        "stopbg" => {}
        "subagent" => {
            shared.emit(HookSignal::Hook { cell, event: "busy".into(), info: Some(json!({ "subagent": true })) });
        }
        _ => shared.emit(HookSignal::Hook { cell, event: event.to_string(), info: None }),
    }
}

fn note_transcript(shared: &Shared, cell: &str, p: Option<&serde_json::Map<String, Value>>) {
    if let Some((session_id, path)) = payload::transcript_of(p) {
        shared.emit(HookSignal::Transcript { cell: cell.to_string(), session_id, path });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_component_round_trip_and_js_errors() {
        assert_eq!(encode_uri_component("a b/ą"), "a%20b%2F%C4%85");
        assert_eq!(decode_uri_component("a%20b").as_deref(), Some("a b"));
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%C0%80"), None); // overlong: URIError in JS
        assert_eq!(decode_uri_component("%ED%A0%80"), None); // an encoded surrogate: URIError in JS
    }

    #[test]
    fn exit_codes() {
        assert_eq!(exit_code("0"), Some(0));
        assert_eq!(exit_code("-1"), Some(-1));
        assert_eq!(exit_code("9999999999"), Some(9_999_999_999));
        assert_eq!(exit_code("12345678901"), None);
        assert_eq!(exit_code("1a"), None);
        assert_eq!(exit_code(""), None);
        assert_eq!(exit_code("-"), None);
    }
}
