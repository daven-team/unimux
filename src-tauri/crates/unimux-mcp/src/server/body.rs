//! Response bodies: a whole body (JSON or empty) or an SSE stream. The SSE stream owns the request's [`Release`] guard, so
//! hyper dropping the body (the client went away, the server stopped) aborts the request and frees its in-flight slot, as
//! Node's `res.on('close')` does in 1.1.4.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use hyper::body::{Frame, SizeHint};
use hyper::header::{self, HeaderValue};
use hyper::{Response, StatusCode};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::Shared;

pub type Resp = Response<McpBody>;

pub enum McpBody {
    Full(Option<Bytes>),
    Sse(Box<SseBody>),
}

impl hyper::body::Body for McpBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        match self.get_mut() {
            McpBody::Full(bytes) => Poll::Ready(bytes.take().map(|b| Ok(Frame::data(b)))),
            McpBody::Sse(sse) => sse.poll(cx).map(|item| item.map(|b| Ok(Frame::data(b)))),
        }
    }

    fn is_end_stream(&self) -> bool {
        matches!(self, McpBody::Full(None))
    }

    fn size_hint(&self) -> SizeHint {
        match self {
            McpBody::Full(Some(b)) => SizeHint::with_exact(b.len() as u64),
            McpBody::Full(None) => SizeHint::with_exact(0),
            McpBody::Sse(_) => SizeHint::default(),
        }
    }
}

/// Releases the request's in-flight slot and fires its abort when the response is done or dropped.
pub struct Release {
    pub shared: Arc<Shared>,
    pub token: String,
    pub stateless: bool,
    pub abort: CancellationToken,
}

impl Drop for Release {
    fn drop(&mut self) {
        self.abort.cancel();
        let mut inner = self.shared.inner.lock();
        if self.stateless {
            inner.stateless_in_flight = inner.stateless_in_flight.saturating_sub(1);
        }
        // mcp.ts release: the count is kept only while the token exists (a revoke dropped it already).
        if inner.tokens.contains_key(&self.token)
            && let Some(n) = inner.in_flight.get_mut(&self.token)
        {
            *n = n.saturating_sub(1);
        }
    }
}

/// An SSE response body: `event: message` frames from a channel and a `: keepalive` comment every 15 s (SDK 1.32.2
/// DEFAULT_SSE_KEEP_ALIVE_MS). It ends when every sender is gone (all answers of the POST were written), or, for a session
/// stream, when the session closes (DELETE, trim, revoke: the SDK's transport.close() closes every stream of the session).
/// What was queued before the close is still written; the senders stop queueing once the session is closed.
pub struct SseBody {
    rx: mpsc::UnboundedReceiver<Value>,
    keep_alive: tokio::time::Interval,
    closed: Option<Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>>>,
    _release: Release,
}

impl SseBody {
    fn poll(&mut self, cx: &mut Context<'_>) -> Poll<Option<Bytes>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(msg)) => {
                let data = crate::surrogate_ids::expose(unimux_core::js_json::stringify(&msg));
                return Poll::Ready(Some(Bytes::from(format!("event: message\ndata: {data}\n\n"))));
            }
            Poll::Ready(None) => return Poll::Ready(None),
            Poll::Pending => {}
        }
        if let Some(closed) = &mut self.closed
            && closed.as_mut().poll(cx).is_ready()
        {
            return Poll::Ready(None);
        }
        if self.keep_alive.poll_tick(cx).is_ready() {
            return Poll::Ready(Some(Bytes::from_static(b": keepalive\n\n")));
        }
        Poll::Pending
    }
}

pub fn empty(status: StatusCode) -> Resp {
    let mut r = Response::new(McpBody::Full(None));
    *r.status_mut() = status;
    r
}

/// `405` with `Allow: POST` (no standalone SSE stream: everything a call sends travels on its own response).
pub fn method_not_allowed() -> Resp {
    let mut r = empty(StatusCode::METHOD_NOT_ALLOWED);
    r.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST"));
    r
}

/// `429` with `Retry-After: 1`.
pub fn too_many() -> Resp {
    let mut r = empty(StatusCode::TOO_MANY_REQUESTS);
    r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    r
}

/// Node's answer to a body that did not arrive within the request timeout (the connection is closed after it).
pub fn request_timeout() -> Resp {
    let mut r = empty(StatusCode::REQUEST_TIMEOUT);
    r.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
    r
}

pub fn json_body(status: StatusCode, value: &Value) -> Resp {
    let text = crate::surrogate_ids::expose(unimux_core::js_json::stringify(value));
    let mut r = Response::new(McpBody::Full(Some(Bytes::from(text))));
    *r.status_mut() = status;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

/// The SDK's createJsonErrorResponse / mcp.ts jsonError: `{"jsonrpc":"2.0","error":{"code","message"},"id":null}`.
pub fn json_error(status: StatusCode, code: i64, message: &str) -> Resp {
    json_body(status, &json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null }))
}

/// mcp.ts's answer to an internal failure: the request body is never echoed.
pub fn internal_error() -> Resp {
    json_body(StatusCode::INTERNAL_SERVER_ERROR, &json!({ "error": "MCP request failed." }))
}

pub fn sse(
    rx: mpsc::UnboundedReceiver<Value>,
    release: Release,
    session: Option<&str>,
    keep_alive: Duration,
    session_closed: Option<CancellationToken>,
) -> Resp {
    let start = tokio::time::Instant::now() + keep_alive;
    let body = SseBody {
        rx,
        keep_alive: tokio::time::interval_at(start, keep_alive),
        closed: session_closed.map(|c| Box::pin(c.cancelled_owned())),
        _release: release,
    };
    let mut r = Response::new(McpBody::Sse(Box::new(body)));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    if let Some(id) = session.and_then(|s| HeaderValue::from_str(s).ok()) {
        h.insert("mcp-session-id", id);
    }
    r
}
