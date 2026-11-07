//! A raw HTTP/1.1 client for the server tests: full control of the request line and headers (a foreign Host, absolute
//! paths, half-sent bodies), responses read as they arrive (SSE frames), connections dropped on purpose.

use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub const ACCEPT: &str = "application/json, text/event-stream";

/// A request body: JSON (sent as `JSON.stringify(value)`) or raw bytes.
pub enum Body {
    None,
    Json(Value),
    Raw(Vec<u8>),
}

impl Body {
    fn bytes(&self) -> Option<Vec<u8>> {
        match self {
            Body::None => None,
            Body::Json(v) => Some(unimux_core::js_json::stringify(v).into_bytes()),
            Body::Raw(b) => Some(b.clone()),
        }
    }
}

impl From<Value> for Body {
    fn from(v: Value) -> Self {
        Body::Json(v)
    }
}

impl From<&str> for Body {
    fn from(s: &str) -> Self {
        Body::Raw(s.as_bytes().to_vec())
    }
}

/// One answer: status (0 when the connection failed), lower-case headers, the body (de-chunked), the time it took.
#[derive(Debug, Clone, Default)]
pub struct Res {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub text: String,
    pub ms: u128,
}

impl Res {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    pub fn content_type(&self) -> Option<&str> {
        self.header("content-type")
    }
    pub fn session(&self) -> Option<String> {
        self.header("mcp-session-id").map(str::to_string)
    }
    /// JSON-RPC messages: the JSON body or the `data:` lines of SSE events (keepalive comments dropped).
    pub fn messages(&self) -> Vec<Value> {
        if self.content_type().is_some_and(|t| t.starts_with("text/event-stream")) {
            return sse_messages(&self.text);
        }
        if self.text.is_empty() {
            return Vec::new();
        }
        vec![unimux_core::js_json::parse(&self.text).unwrap_or_else(|_| Value::String(self.text.clone()))]
    }
    pub fn json(&self) -> Value {
        self.messages().into_iter().next().unwrap_or(Value::Null)
    }
}

/// The JSON of one SSE block (`data:` lines joined), None for comments.
fn block_data(block: &str) -> Option<String> {
    let data: Vec<&str> = block.split('\n').filter_map(|l| l.strip_prefix("data:")).map(|l| l.trim_start()).collect::<Vec<_>>();
    let data = data.join("\n");
    (!data.trim().is_empty()).then_some(data)
}

pub fn sse_messages(text: &str) -> Vec<Value> {
    text.split("\n\n").filter_map(block_data).map(|d| unimux_core::js_json::parse(&d).unwrap_or(Value::String(d))).collect()
}

pub struct Request<'a> {
    pub addr: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

impl<'a> Request<'a> {
    pub fn new(addr: &'a str, method: &'a str, path: &'a str) -> Self {
        Self { addr, method, path, headers: Vec::new(), body: Body::None }
    }
    /// Sets a header (a later value for the same name replaces the earlier one, as in a JS object).
    pub fn header(mut self, name: &str, value: &str) -> Self {
        let name = name.to_ascii_lowercase();
        match self.headers.iter_mut().find(|(k, _)| *k == name) {
            Some(slot) => slot.1 = value.to_string(),
            None => self.headers.push((name, value.to_string())),
        }
        self
    }
    pub fn headers(mut self, list: &[(&str, &str)]) -> Self {
        for (k, v) in list {
            self = self.header(k, v);
        }
        self
    }
    pub fn body(mut self, body: impl Into<Body>) -> Self {
        self.body = body.into();
        self
    }
    /// The bytes on the wire (Node's http.request: Host from the URL unless given, Content-Length for a whole body).
    pub fn raw(&self) -> Vec<u8> {
        let mut head = format!("{} {} HTTP/1.1\r\n", self.method, self.path);
        if !self.headers.iter().any(|(k, _)| k == "host") {
            head.push_str(&format!("host: {}\r\n", self.addr));
        }
        for (k, v) in &self.headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        let body = self.body.bytes();
        if let Some(b) = &body {
            head.push_str(&format!("content-length: {}\r\n", b.len()));
        }
        head.push_str("connection: close\r\n\r\n");
        let mut out = head.into_bytes();
        out.extend(body.unwrap_or_default());
        out
    }

    pub async fn send(self) -> Res {
        self.stream(Duration::from_secs(20), |_| Flow::Continue).await
    }

    /// Sends and closes the connection after `after` (a client that goes away).
    pub async fn send_and_drop(self, after: Duration) {
        let Ok(mut stream) = TcpStream::connect(self.addr).await else { return };
        let _ = stream.write_all(&self.raw()).await;
        tokio::time::sleep(after).await;
        drop(stream);
    }

    /// Sends and reads the answer as it arrives: `on_frame` sees every SSE message; the read ends at the end of the answer,
    /// after `limit`, or when `on_frame` says Finish.
    pub async fn stream(self, limit: Duration, mut on_frame: impl FnMut(&Value) -> Flow) -> Res {
        let started = Instant::now();
        let mut res = Res::default();
        let Ok(mut stream) = TcpStream::connect(self.addr).await else { return res };
        if stream.write_all(&self.raw()).await.is_err() {
            return res;
        }
        let deadline = tokio::time::Instant::now() + limit;
        let mut buf = Vec::new();
        let mut head_done = false;
        let mut body = Vec::new();
        let mut chunked = false;
        let mut length: Option<usize> = None;
        let mut consumed = 0usize;
        let mut finished = false;
        loop {
            let mut chunk = [0u8; 8192];
            let n = match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
                Ok(Ok(n)) => n,
                _ => break,
            };
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if !head_done {
                let Some(end) = find(&buf, b"\r\n\r\n") else { continue };
                let head = String::from_utf8_lossy(&buf[..end]).to_string();
                buf.drain(..end + 4);
                head_done = true;
                let mut lines = head.split("\r\n");
                res.status = lines.next().and_then(|l| l.split(' ').nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0);
                for line in lines {
                    if let Some((k, v)) = line.split_once(':') {
                        res.headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
                    }
                }
                chunked = res.header("transfer-encoding").is_some_and(|v| v.contains("chunked"));
                length = res.header("content-length").and_then(|v| v.parse().ok());
            }
            // Move complete body bytes from `buf` to `body`.
            let mut done = false;
            if chunked {
                while let Some(line_end) = find(&buf, b"\r\n") {
                    let size = usize::from_str_radix(String::from_utf8_lossy(&buf[..line_end]).trim(), 16).unwrap_or(0);
                    if size == 0 {
                        done = true;
                        break;
                    }
                    if buf.len() < line_end + 2 + size + 2 {
                        break;
                    }
                    body.extend_from_slice(&buf[line_end + 2..line_end + 2 + size]);
                    buf.drain(..line_end + 2 + size + 2);
                }
            } else {
                body.append(&mut buf);
                if length.is_some_and(|l| body.len() >= l) {
                    done = true;
                }
            }
            // SSE frames seen so far (cut on bytes: a read may end inside a multi-byte character).
            while let Some(cut) = find(&body[consumed..], b"\n\n") {
                let block = String::from_utf8_lossy(&body[consumed..consumed + cut]).to_string();
                consumed += cut + 2;
                if let Some(data) = block_data(&block)
                    && let Ok(message) = unimux_core::js_json::parse(&data)
                    && on_frame(&message) == Flow::Finish
                {
                    finished = true;
                }
            }
            if done || finished {
                break;
            }
        }
        res.text = String::from_utf8_lossy(&body).to_string();
        res.ms = started.elapsed().as_millis();
        res
    }
}

#[derive(PartialEq, Eq)]
pub enum Flow {
    Continue,
    Finish,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}
