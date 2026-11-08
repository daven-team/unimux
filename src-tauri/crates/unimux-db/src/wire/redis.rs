//! SP9 spike: Redis replies and connections over any stream, measured against ioredis 6.0 (what 1.1.4 runs with
//! `callBuffer`, protocol 2, `stringNumbers`, identity reply transformers). D9 / D10 build the real session; the findings are
//! in docs/tauri/spikes/SP9.md.
//!
//! `RespReader` is an own resumable RESP2 reader producing `Raw` (what ioredis hands to `RedisSession.reply`: null, an
//! Error, a number string, a Buffer, an array). `RedisConn` is the own connection over it: a FIFO of pending replies (RESP2
//! answers in order), the 1.1.4 connect sequence, every pending command failed when the stream ends, nothing sent again,
//! later commands refused at once (ioredis with `enableOfflineQueue: false`, `autoResendUnfulfilledCommands: false`).
//! `reconnect` is the retry loop of 1.1.4's retryStrategy (3 attempts after 300 / 1000 / 2000 ms).
//!
//! SP9 decided against the redis crate (it stays a dev-dependency so tests/wire_servers.rs can show the gaps): redis 1.8
//! decodes status and error lines with `str::from_utf8` and drops the whole connection on a line that is not UTF-8 (a Lua
//! `redis.status_reply` / `error_reply` with such bytes) where ioredis keeps the bytes, its default 500 ms response timeout
//! cuts slow console commands, and its disconnect notice needs RESP3.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::future::Future;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use bytes::{Buf, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};
use unimux_core::js_json::write_string;

use super::value::{Head, node_utf8, server_text, write_head};

/// REDIS_LIMITS (src/shared/dbRedis.ts) used by the reply.
pub const REPLY_NODES: usize = 10_000;
pub const REPLY_BULK_BYTES: usize = 1024 * 1024;
/// RETRY_DELAYS and REDIS_LIMITS.reconnectAttempts of src/dbhost/redisSession.ts.
pub const RETRY_DELAYS_MS: [u64; 3] = [300, 1000, 2000];
pub const RECONNECT_ATTEMPTS: u32 = 3;

/// ioredis CONNECTION_CLOSED_ERROR_MSG: pending commands when the connection ends for good (no retry follows).
pub const CONNECTION_CLOSED_MSG: &str = "Connection is closed.";
/// ioredis MaxRetriesPerRequestError with `maxRetriesPerRequest: 0`: pending commands when a reconnect follows the drop.
pub const MAX_RETRIES_MSG: &str =
    "Reached the max retries per request limit (which is 0). Refer to \"maxRetriesPerRequest\" option for details.";
/// ioredis with `enableOfflineQueue: false`: a command while the stream is not writable (reconnecting).
pub const NOT_WRITABLE_MSG: &str = "Stream isn't writeable and enableOfflineQueue options is false";

/// A reply as ioredis gives it to the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Raw {
    Null,
    /// ReplyError.message (the error line, decoded like Node).
    Error(String),
    /// An integer reply as its text (`stringNumbers`).
    Integer(String),
    /// A bulk or status reply (callBuffer gives both as a Buffer).
    Bytes(Vec<u8>),
    Array(Vec<Raw>),
}

/// An own RESP2 reader (the bytes of status and error lines kept as they are). It is resumable like the ioredis 6 decoder:
/// consumed bytes leave the buffer at once, a partly read array is kept on a stack, and the search for the end of a line
/// resumes where it stopped, so a big reply that arrives in many reads costs linear time (each push parses only new bytes).
#[derive(Default)]
pub struct RespReader {
    buf: BytesMut,
    /// Arrays still being filled: (elements still to come, elements so far).
    stack: Vec<(usize, Vec<Raw>)>,
    /// How far the buffer was already searched for the CRLF of the next line.
    scanned: usize,
}

/// Maximum nesting of arrays (a hostile server cannot exhaust the stack).
const MAX_DEPTH: usize = 512;

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_owned())
}

fn parse_len(line: &[u8]) -> io::Result<i64> {
    std::str::from_utf8(line).ok().and_then(|s| s.parse().ok()).ok_or_else(|| bad("bad length"))
}

enum Item {
    Value(Raw),
    Array(usize),
}

impl RespReader {
    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// The next scalar (or the header of an array) at the start of the buffer, consumed. `None`: more bytes needed.
    fn next_item(&mut self) -> io::Result<Option<Item>> {
        let Some(&kind) = self.buf.first() else { return Ok(None) };
        let from = self.scanned.max(1);
        let Some(p) = self.buf[from..].windows(2).position(|w| w == b"\r\n") else {
            // keep the last byte: it may be the CR of a CRLF split over two reads
            self.scanned = self.buf.len().saturating_sub(1).max(1);
            return Ok(None);
        };
        let end = from + p;
        let next = end + 2;
        let item = match kind {
            b'+' => Item::Value(Raw::Bytes(self.buf[1..end].to_vec())),
            b'-' => Item::Value(Raw::Error(node_utf8(&self.buf[1..end]))),
            b':' => Item::Value(Raw::Integer(node_utf8(&self.buf[1..end]))),
            b'$' => {
                let n = parse_len(&self.buf[1..end])?;
                if n >= 0 {
                    let n = n as usize;
                    if self.buf.len() < next + n + 2 {
                        // the header line is complete: the next push only checks the length again
                        self.scanned = end;
                        return Ok(None);
                    }
                    let v = Raw::Bytes(self.buf[next..next + n].to_vec());
                    self.buf.advance(next + n + 2);
                    self.scanned = 0;
                    return Ok(Some(Item::Value(v)));
                }
                Item::Value(Raw::Null)
            }
            b'*' => {
                let n = parse_len(&self.buf[1..end])?;
                if n < 0 { Item::Value(Raw::Null) } else { Item::Array(n as usize) }
            }
            other => return Err(bad(&format!("unknown reply type {other:#x}"))),
        };
        self.buf.advance(next);
        self.scanned = 0;
        Ok(Some(item))
    }

    /// The next complete reply, if the buffer holds one.
    pub fn next_reply(&mut self) -> io::Result<Option<Raw>> {
        loop {
            let Some(item) = self.next_item()? else { return Ok(None) };
            let mut done = match item {
                Item::Array(0) => Raw::Array(Vec::new()),
                Item::Array(n) => {
                    if self.stack.len() >= MAX_DEPTH {
                        return Err(bad("reply nested too deeply"));
                    }
                    self.stack.push((n, Vec::with_capacity(n.min(1 << 16))));
                    continue;
                }
                Item::Value(v) => v,
            };
            // hand the finished element up; an array that becomes complete is a finished element itself
            loop {
                let Some((left, items)) = self.stack.last_mut() else { return Ok(Some(done)) };
                items.push(done);
                *left -= 1;
                if *left > 0 {
                    break;
                }
                let (_, items) = self.stack.pop().expect("a frame is on the stack");
                done = Raw::Array(items);
            }
        }
    }
}

/// A command in RESP (what ioredis writes: `*<n>\r\n` then `$<len>\r\n<bytes>\r\n` per argument).
pub fn encode_command(argv: &[&[u8]]) -> Vec<u8> {
    let mut out = format!("*{}\r\n", argv.len()).into_bytes();
    for a in argv {
        out.extend_from_slice(format!("${}\r\n", a.len()).as_bytes());
        out.extend_from_slice(a);
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// The 1.1.4 connect sequence: ioredis' handshake with `connectionName: 'unimux'`, `disableClientInfo`, no ready check and
/// no `db` option (`auth [user] pw`, `client setname unimux`), then openRedis's `ping`, `select n` (n > 0) and
/// `info server`, all in ioredis' lower case.
pub fn connect_sequence(user: &str, password: Option<&str>, db: u32) -> Vec<Vec<Vec<u8>>> {
    let mut seq = handshake(user, password);
    seq.push(vec![b"ping".to_vec()]);
    if db != 0 {
        seq.push(vec![b"select".to_vec(), db.to_string().into_bytes()]);
    }
    seq.push(vec![b"info".to_vec(), b"server".to_vec()]);
    seq
}

/// What ioredis sends on a reconnect (event_handler.js: the handshake again, then in readyHandler `select` of the DB the
/// dropped connection had selected, when one was selected; no ping, no info). Derived from the ioredis source, D9 adds the
/// golden.
pub fn reconnect_sequence(user: &str, password: Option<&str>, selected: Option<u32>) -> Vec<Vec<Vec<u8>>> {
    let mut seq = handshake(user, password);
    if let Some(db) = selected {
        seq.push(vec![b"select".to_vec(), db.to_string().into_bytes()]);
    }
    seq
}

fn handshake(user: &str, password: Option<&str>) -> Vec<Vec<Vec<u8>>> {
    let mut seq: Vec<Vec<Vec<u8>>> = Vec::new();
    if let Some(pw) = password {
        let mut auth = vec![b"auth".to_vec()];
        if !user.is_empty() {
            auth.push(user.as_bytes().to_vec());
        }
        auth.push(pw.as_bytes().to_vec());
        seq.push(auth);
    }
    seq.push(vec![b"client".to_vec(), b"setname".to_vec(), b"unimux".to_vec()]);
    seq
}

/// Why a command got no reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    /// It was written (or queued for writing) when the connection ended. ioredis fails it with MAX_RETRIES_MSG when a
    /// reconnect follows and CONNECTION_CLOSED_MSG when not; the session knows which (`message`).
    Dropped,
    /// The connection had already ended: refused at once, never written (NOT_WRITABLE_MSG).
    NotWritable,
    /// The connect sequence got an error reply.
    Server(String),
}

impl CallError {
    /// The message 1.1.4 shows (`reconnecting`: whether the retry strategy goes on after this drop).
    pub fn message(&self, reconnecting: bool) -> String {
        match self {
            CallError::Dropped if reconnecting => MAX_RETRIES_MSG.to_owned(),
            CallError::Dropped => CONNECTION_CLOSED_MSG.to_owned(),
            CallError::NotWritable => NOT_WRITABLE_MSG.to_owned(),
            CallError::Server(m) => m.clone(),
        }
    }
}

type Pending = oneshot::Sender<Result<Raw, CallError>>;

/// Where a subscriber connection's messages go (`message` / `pmessage` arrays; D10's Pub/Sub). Called on the driver task.
pub type PushFn = Arc<dyn Fn(Raw) + Send + Sync>;
type PushSlot = Arc<parking_lot::Mutex<Option<PushFn>>>;

/// A Pub/Sub message pushed by the server (RESP2: `message channel payload`, `pmessage pattern channel payload`), never the
/// reply of a command.
fn is_push(v: &Raw) -> bool {
    match v {
        Raw::Array(items) => match items.first() {
            Some(Raw::Bytes(kind)) => {
                (kind.eq_ignore_ascii_case(b"message") && items.len() == 3)
                    || (kind.eq_ignore_ascii_case(b"pmessage") && items.len() == 4)
            }
            _ => false,
        },
        _ => false,
    }
}

/// An own RESP2 connection: one driver task owns the stream, writes commands in the order `call` gives them and hands the
/// replies to the callers in the same order. The driver reads all the time, so a drop is seen without a command in flight
/// (`ended`). On EOF, a read or write error or a protocol error every pending command fails with `Dropped`, nothing is
/// sent again, and later calls fail at once with `NotWritable`.
pub struct RedisConn {
    tx: mpsc::UnboundedSender<(Vec<u8>, Pending, usize)>,
    ended: watch::Receiver<bool>,
    task: tokio::task::JoinHandle<()>,
    push: PushSlot,
}

impl RedisConn {
    pub fn start<S: AsyncRead + AsyncWrite + Send + Unpin + 'static>(stream: S) -> RedisConn {
        let (tx, rx) = mpsc::unbounded_channel();
        let (ended_tx, ended) = watch::channel(false);
        let push: PushSlot = Arc::default();
        let task = tokio::spawn(drive(stream, rx, ended_tx, push.clone()));
        RedisConn { tx, ended, task, push }
    }

    /// Starts the connection and runs the 1.1.4 connect sequence; returns the `info server` text.
    pub async fn open<S: AsyncRead + AsyncWrite + Send + Unpin + 'static>(
        stream: S,
        user: &str,
        password: Option<&str>,
        db: u32,
    ) -> Result<(RedisConn, Vec<u8>), CallError> {
        let c = RedisConn::start(stream);
        let mut last = Raw::Null;
        for argv in connect_sequence(user, password, db) {
            let refs: Vec<&[u8]> = argv.iter().map(Vec::as_slice).collect();
            last = match c.call(&refs).await? {
                Raw::Error(m) => return Err(CallError::Server(m)),
                v => v,
            };
        }
        let info = match last {
            Raw::Bytes(b) => b,
            _ => Vec::new(),
        };
        Ok((c, info))
    }

    /// Sends one command and waits for its reply (a server error reply is `Ok(Raw::Error)`).
    pub async fn call(&self, argv: &[&[u8]]) -> Result<Raw, CallError> {
        self.enqueue(argv).await
    }

    /// Queues one command for writing now (like ioredis' `sendCommand`, before anything is awaited), so commands issued one
    /// after the other go out in that order and pipeline; the future is the reply.
    pub fn enqueue(&self, argv: &[&[u8]]) -> impl Future<Output = Result<Raw, CallError>> + Send + use<> {
        self.enqueue_n(argv, 1)
    }

    /// Like [`RedisConn::enqueue`] for a command the server answers with `replies` replies (SUBSCRIBE / PSUBSCRIBE /
    /// UNSUBSCRIBE / PUNSUBSCRIBE: one confirmation per name, as ioredis counts them); the future is the last one, or the
    /// first error reply.
    pub fn enqueue_n(&self, argv: &[&[u8]], replies: usize) -> impl Future<Output = Result<Raw, CallError>> + Send + use<> {
        let rx = if *self.ended.borrow() {
            None
        } else {
            let (reply, rx) = oneshot::channel();
            self.tx.send((encode_command(argv), reply, replies.max(1))).ok().map(|()| rx)
        };
        async move {
            match rx {
                // a dropped sender without an answer: the driver ended before it took the command, so it was never written
                Some(rx) => rx.await.unwrap_or(Err(CallError::NotWritable)),
                None => Err(CallError::NotWritable),
            }
        }
    }

    /// Sends the server's Pub/Sub messages to `f` instead of treating them as replies (None: they end the connection like
    /// any reply nobody waits for).
    pub fn set_push(&self, f: Option<PushFn>) {
        *self.push.lock() = f;
    }

    /// Becomes true when the stream ended (EOF, an error, or `close`).
    pub fn ended(&self) -> watch::Receiver<bool> {
        self.ended.clone()
    }

    pub fn is_ended(&self) -> bool {
        *self.ended.borrow()
    }

    /// Drops the stream (ioredis `disconnect()`); pending commands fail with `Dropped`.
    pub fn close(&self) {
        self.task.abort();
    }
}

impl Drop for RedisConn {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Fails pending replies and marks the end even when the task is aborted.
struct EndGuard {
    /// Each waiting command with the number of replies it still needs.
    pending: VecDeque<(Pending, usize)>,
    ended: watch::Sender<bool>,
}

impl Drop for EndGuard {
    fn drop(&mut self) {
        for (p, _) in self.pending.drain(..) {
            let _ = p.send(Err(CallError::Dropped));
        }
        let _ = self.ended.send(true);
    }
}

async fn drive<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    mut rx: mpsc::UnboundedReceiver<(Vec<u8>, Pending, usize)>,
    ended: watch::Sender<bool>,
    push: PushSlot,
) {
    let (mut rd, mut wr) = tokio::io::split(stream);
    let mut guard = EndGuard { pending: VecDeque::new(), ended };
    let mut reader = RespReader::default();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        tokio::select! {
            req = rx.recv() => {
                let Some((bytes, reply, replies)) = req else { return };
                guard.pending.push_back((reply, replies));
                // Redis reads a whole command before it answers, so writing before reading on cannot deadlock
                if wr.write_all(&bytes).await.is_err() || wr.flush().await.is_err() {
                    return;
                }
            }
            n = rd.read(&mut chunk) => {
                let Ok(n) = n else { return };
                if n == 0 {
                    return;
                }
                reader.push(&chunk[..n]);
                loop {
                    match reader.next_reply() {
                        Ok(Some(v)) => {
                            if is_push(&v) {
                                let f = push.lock().clone();
                                if let Some(f) = f {
                                    f(v);
                                    continue;
                                }
                            }
                            // a reply nobody waits for is a protocol error: end the connection like a drop
                            let Some((_, left)) = guard.pending.front_mut() else { return };
                            if *left > 1 && !matches!(v, Raw::Error(_)) {
                                *left -= 1;
                                continue;
                            }
                            let Some((p, _)) = guard.pending.pop_front() else { return };
                            let _ = p.send(Ok(v));
                        }
                        Ok(None) => break,
                        Err(_) => return,
                    }
                }
            }
        }
    }
}

/// Events of the reconnect loop (RedisSessionOut.reconnecting / reconnected / closed in 1.1.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconnectEvent {
    Reconnecting(u32),
    Reconnected,
    Closed,
}

/// 1.1.4's retryStrategy after a drop: attempt n is announced at once (retryStrategy runs in ioredis' close handler), then
/// tried after RETRY_DELAYS_MS[n - 1]; a failed attempt is a new close, so the next attempt follows; after
/// RECONNECT_ATTEMPTS failed attempts the connection is closed. `connect` builds a new connection and runs the reconnect
/// handshake (`reconnect_sequence`).
pub async fn reconnect<T, E, F, Fut>(mut connect: F, mut event: impl FnMut(ReconnectEvent)) -> Option<T>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    for attempt in 1..=RECONNECT_ATTEMPTS {
        event(ReconnectEvent::Reconnecting(attempt));
        tokio::time::sleep(Duration::from_millis(RETRY_DELAYS_MS[(attempt - 1) as usize])).await;
        if let Ok(c) = connect(attempt).await {
            event(ReconnectEvent::Reconnected);
            return Some(c);
        }
    }
    event(ReconnectEvent::Closed);
    None
}

/// `RedisData`: text when the bytes are UTF-8 (Node `isUtf8`), else base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedisData {
    Text(String),
    B64(String),
}

pub fn to_data(b: &[u8]) -> RedisData {
    match std::str::from_utf8(b) {
        Ok(s) => RedisData::Text(s.to_owned()),
        Err(_) => RedisData::B64(base64::engine::general_purpose::STANDARD.encode(b)),
    }
}

/// `trimPartialUtf8`.
pub fn trim_partial_utf8(b: &[u8]) -> &[u8] {
    if std::str::from_utf8(b).is_ok() {
        return b;
    }
    for k in 1..=3 {
        if k >= b.len() {
            break;
        }
        if std::str::from_utf8(&b[..b.len() - k]).is_ok() {
            return &b[..b.len() - k];
        }
    }
    b
}

/// `cutBytes`.
pub fn cut_bytes(b: &[u8], max: usize) -> &[u8] {
    if b.len() <= max { b } else { trim_partial_utf8(&b[..max]) }
}

/// `RedisReply` (src/shared/dbRedis.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedisReply {
    Simple(String),
    /// The error text cut like JS `message.slice(0, 4000)`: a cut inside a surrogate pair keeps the lone high surrogate.
    Error(Head),
    Integer(String),
    Bulk {
        v: RedisData,
        bytes: usize,
        truncated: bool,
    },
    Null,
    Array {
        items: Vec<RedisReply>,
        length: usize,
    },
}

/// `RedisSession.reply`.
pub fn reply(v: &Raw, status: bool, budget: &mut usize, top: bool) -> RedisReply {
    *budget = budget.saturating_sub(1);
    match v {
        Raw::Null => RedisReply::Null,
        Raw::Error(m) => RedisReply::Error(server_text(m)),
        Raw::Integer(s) => RedisReply::Integer(s.clone()),
        Raw::Bytes(b) => {
            if top
                && status
                && b.len() < 1024
                && let Ok(s) = std::str::from_utf8(b)
            {
                return RedisReply::Simple(s.to_owned());
            }
            let part = cut_bytes(b, REPLY_BULK_BYTES);
            RedisReply::Bulk { v: to_data(part), bytes: b.len(), truncated: part.len() < b.len() }
        }
        Raw::Array(items) => {
            let mut out = Vec::new();
            for x in items {
                if *budget == 0 {
                    break;
                }
                out.push(reply(x, status, budget, false));
            }
            RedisReply::Array { items: out, length: items.len() }
        }
    }
}

fn write_data(out: &mut String, d: &RedisData) {
    match d {
        RedisData::Text(s) => write_string(out, s),
        RedisData::B64(s) => {
            out.push_str("{\"b64\":");
            write_string(out, s);
            out.push('}');
        }
    }
}

impl RedisReply {
    /// `JSON.stringify(reply)`.
    pub fn write_json(&self, out: &mut String) {
        match self {
            RedisReply::Simple(v) => {
                out.push_str("{\"t\":\"simple\",\"v\":");
                write_string(out, v);
                out.push('}');
            }
            RedisReply::Error(v) => {
                out.push_str("{\"t\":\"error\",\"v\":");
                write_head(out, v);
                out.push('}');
            }
            RedisReply::Integer(v) => {
                out.push_str("{\"t\":\"integer\",\"v\":");
                write_string(out, v);
                out.push('}');
            }
            RedisReply::Bulk { v, bytes, truncated } => {
                out.push_str("{\"t\":\"bulk\",\"v\":");
                write_data(out, v);
                let _ = write!(out, ",\"bytes\":{bytes}");
                if *truncated {
                    out.push_str(",\"truncated\":true");
                }
                out.push('}');
            }
            RedisReply::Null => out.push_str("{\"t\":\"null\"}"),
            RedisReply::Array { items, length } => {
                out.push_str("{\"t\":\"array\",\"items\":[");
                for (i, x) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    x.write_json(out);
                }
                let _ = write!(out, "],\"length\":{length}}}");
            }
        }
    }

    pub fn to_json(&self) -> String {
        let mut s = String::new();
        self.write_json(&mut s);
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(bytes: &[u8]) -> Vec<Raw> {
        let mut r = RespReader::default();
        let mut out = Vec::new();
        // byte by byte: partial replies wait for the rest
        for b in bytes {
            r.push(&[*b]);
            while let Some(v) = r.next_reply().unwrap() {
                out.push(v);
            }
        }
        out
    }

    #[test]
    fn own_reader_keeps_status_and_error_bytes() {
        let input: &[u8] =
            b"+OK\r\n+\xff\r\n-ERR bad \xff\r\n:-12\r\n$-1\r\n*-1\r\n$3\r\na\r\n\r\n*2\r\n$0\r\n\r\n*1\r\n:1\r\n*0\r\n*2\r\n*0\r\n*-1\r\n";
        let want = vec![
            Raw::Bytes(b"OK".to_vec()),
            Raw::Bytes(vec![0xff]),
            Raw::Error("ERR bad \u{fffd}".into()),
            Raw::Integer("-12".into()),
            Raw::Null,
            Raw::Null,
            Raw::Bytes(b"a\r\n".to_vec()),
            Raw::Array(vec![Raw::Bytes(vec![]), Raw::Array(vec![Raw::Integer("1".into())])]),
            Raw::Array(vec![]),
            Raw::Array(vec![Raw::Array(vec![]), Raw::Null]),
        ];
        assert_eq!(read_all(input), want);
        // all at once gives the same
        let mut r = RespReader::default();
        r.push(input);
        let mut all = Vec::new();
        while let Some(v) = r.next_reply().unwrap() {
            all.push(v);
        }
        assert_eq!(all, want);
    }

    #[test]
    fn bad_input_is_an_error() {
        let mut r = RespReader::default();
        r.push(b"?x\r\n");
        assert!(r.next_reply().is_err());
        let mut r = RespReader::default();
        r.push(b"$zz\r\n");
        assert!(r.next_reply().is_err());
        let mut r = RespReader::default();
        r.push("*1\r\n".repeat(MAX_DEPTH + 1).as_bytes());
        assert!(r.next_reply().is_err());
    }

    /// The review measured 9 s for 500k elements in 64 KiB chunks with the old re-parsing reader; resumable it is linear.
    #[test]
    fn a_big_array_in_small_chunks_is_linear() {
        let n = 500_000;
        let mut wire = format!("*{n}\r\n").into_bytes();
        for i in 0..n {
            let v = format!("member-{i:08}");
            wire.extend_from_slice(format!("${}\r\n{v}\r\n", v.len()).as_bytes());
        }
        let t = std::time::Instant::now();
        let mut r = RespReader::default();
        let mut got = None;
        for c in wire.chunks(16 * 1024) {
            r.push(c);
            if let Some(v) = r.next_reply().unwrap() {
                got = Some(v);
            }
        }
        let ms = t.elapsed().as_millis();
        let Some(Raw::Array(items)) = got else { panic!("no reply") };
        assert_eq!(items.len(), n);
        assert_eq!(items[n - 1], Raw::Bytes(format!("member-{:08}", n - 1).into_bytes()));
        // debug build: a few hundred ms; the quadratic reader needed minutes in debug
        assert!(ms < 5000, "{ms} ms");
        // and a long status line split into many reads is not scanned again from the start
        let mut r = RespReader::default();
        let line = format!("+{}\r\n", "s".repeat(4 * 1024 * 1024));
        for c in line.as_bytes().chunks(1024) {
            r.push(c);
            if let Some(v) = r.next_reply().unwrap() {
                assert_eq!(v, Raw::Bytes(vec![b's'; 4 * 1024 * 1024]));
            }
        }
        assert!(t.elapsed().as_millis() < 10_000);
    }

    #[test]
    fn reply_shapes_like_the_session() {
        let mut budget = REPLY_NODES;
        assert_eq!(reply(&Raw::Bytes(b"PONG".to_vec()), true, &mut budget, true).to_json(), r#"{"t":"simple","v":"PONG"}"#);
        assert_eq!(
            reply(&Raw::Bytes(b"PONG".to_vec()), false, &mut budget, true).to_json(),
            r#"{"t":"bulk","v":"PONG","bytes":4}"#
        );
        assert_eq!(
            reply(&Raw::Bytes(vec![0xff, 0]), false, &mut budget, true).to_json(),
            r#"{"t":"bulk","v":{"b64":"/wA="},"bytes":2}"#
        );
        let arr = Raw::Array(vec![Raw::Bytes(b"x".to_vec()), Raw::Null, Raw::Error("ERR e".into())]);
        assert_eq!(
            reply(&arr, true, &mut budget, true).to_json(),
            r#"{"t":"array","items":[{"t":"bulk","v":"x","bytes":1},{"t":"null"},{"t":"error","v":"ERR e"}],"length":3}"#
        );
        let mut two = 2;
        assert_eq!(
            reply(&arr, false, &mut two, true).to_json(),
            r#"{"t":"array","items":[{"t":"bulk","v":"x","bytes":1}],"length":3}"#
        );
    }

    #[test]
    fn an_error_cut_inside_a_pair_keeps_the_high_surrogate() {
        // node: JSON.stringify({t:'error',v:('ERR '+'x'.repeat(3995)+'\u{1F600}').slice(0,4000)}) ends with `x\ud83d"}`
        let m = format!("ERR {}\u{1F600}", "x".repeat(3995));
        let mut budget = REPLY_NODES;
        let j = reply(&Raw::Error(m), false, &mut budget, true).to_json();
        assert!(j.ends_with("xx\\ud83d\"}"), "{}", &j[j.len() - 20..]);
        let m = format!("ERR {}\u{1F600}", "x".repeat(3994));
        let j = reply(&Raw::Error(m), false, &mut budget, true).to_json();
        assert!(j.ends_with("x\u{1F600}\"}"));
    }

    #[test]
    fn a_cut_inside_a_utf8_character_moves_back() {
        assert_eq!(cut_bytes("aé".as_bytes(), 2), b"a");
        assert_eq!(cut_bytes(&[0xff, 0xfe, 0xfd], 2), &[0xff, 0xfe]);
    }

    #[test]
    fn commands_encode_like_ioredis() {
        assert_eq!(
            encode_command(&[b"CLIENT", b"SETNAME", b"unimux"]),
            b"*3\r\n$6\r\nCLIENT\r\n$7\r\nSETNAME\r\n$6\r\nunimux\r\n"
        );
    }

    #[test]
    fn reconnect_handshake_from_the_ioredis_source() {
        let s = |v: Vec<Vec<Vec<u8>>>| v.into_iter().map(|a| node_utf8(&a.join(&b' '))).collect::<Vec<_>>();
        assert_eq!(s(reconnect_sequence("u", Some("p"), Some(2))), ["auth u p", "client setname unimux", "select 2"]);
        assert_eq!(s(reconnect_sequence("", None, None)), ["client setname unimux"]);
        assert_eq!(s(connect_sequence("", Some("p"), 3)), ["auth p", "client setname unimux", "ping", "select 3", "info server"]);
    }

    #[tokio::test]
    async fn the_connection_fails_pending_commands_on_a_drop_and_refuses_later_ones() {
        let (client, mut server) = tokio::io::duplex(1024);
        let c = RedisConn::start(client);
        let mut buf = vec![0u8; 256];
        // a reply in two parts, then a pending command and the drop
        let ping = [b"ping".as_slice()];
        let call = c.call(&ping);
        let srv = async {
            let n = server.read(&mut buf).await.unwrap();
            assert_eq!(&buf[..n], b"*1\r\n$4\r\nping\r\n");
            server.write_all(b"+PO").await.unwrap();
            tokio::task::yield_now().await;
            server.write_all(b"NG\r\n").await.unwrap();
        };
        let (r, ()) = tokio::join!(call, srv);
        assert_eq!(r, Ok(Raw::Bytes(b"PONG".to_vec())));
        let blpop = [b"blpop".as_slice(), b"k", b"0"];
        let pending = c.call(&blpop);
        let srv = async {
            let n = server.read(&mut buf).await.unwrap();
            assert!(buf[..n].ends_with(b"blpop\r\n$1\r\nk\r\n$1\r\n0\r\n"));
            drop(server);
        };
        let (r, ()) = tokio::join!(pending, srv);
        assert_eq!(r, Err(CallError::Dropped));
        assert_eq!(r.unwrap_err().message(true), MAX_RETRIES_MSG);
        let mut ended = c.ended();
        ended.wait_for(|e| *e).await.unwrap();
        assert_eq!(c.call(&[b"ping".as_slice()]).await, Err(CallError::NotWritable));
    }

    #[tokio::test]
    async fn a_drop_with_nothing_in_flight_is_seen() {
        let (client, server) = tokio::io::duplex(64);
        let c = RedisConn::start(client);
        drop(server);
        let mut ended = c.ended();
        tokio::time::timeout(Duration::from_secs(1), ended.wait_for(|e| *e)).await.unwrap().unwrap();
        assert!(c.is_ended());
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_waits_the_1_1_4_delays() {
        let t = tokio::time::Instant::now();
        let mut ev = Vec::new();
        let got =
            reconnect(|a| async move { if a == 2 { Ok(a) } else { Err(()) } }, |e| ev.push((e, t.elapsed().as_millis()))).await;
        assert_eq!(got, Some(2));
        assert_eq!(
            ev,
            [(ReconnectEvent::Reconnecting(1), 0), (ReconnectEvent::Reconnecting(2), 300), (ReconnectEvent::Reconnected, 1300)]
        );
        let mut ev = Vec::new();
        let t = tokio::time::Instant::now();
        let got: Option<()> = reconnect(|_| async { Err::<(), ()>(()) }, |e| ev.push((e, t.elapsed().as_millis()))).await;
        assert_eq!(got, None);
        assert_eq!(ev.last(), Some(&(ReconnectEvent::Closed, 3300)));
    }
}
