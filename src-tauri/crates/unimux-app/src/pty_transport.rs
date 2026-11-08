//! Transports of the pty data plane (P2, SP1 / SP5 decisions): how one window's frames messages reach its page.
//!
//! - `sharedBuffer` (Windows, default): `ICoreWebView2Environment12::CreateSharedBuffer` + `ICoreWebView2_17::
//!   PostSharedBufferToScript` (read only; the additional data `{"mcPort":"pty","a":<attach id>,"n":<seq>}` names the
//!   port, the page's attach and the message number: buffers an earlier attach posted while the page reloaded are dropped
//!   by the new page, which releases by `n`). A post waits until the UI thread made it (at most one post queued on the UI thread, a slower UI
//!   thread is waited for and counted every 2 s, never answered with a second post); the page answers each message with a
//!   release ack, so the batcher caps the messages in flight per window.
//! - `pull` (macOS default: WKWebView has no shared buffer): the page long-polls `mc_port_pull`, one request in flight; a
//!   post waits until a pull took it.
//! - `channel` (fallback when `ICoreWebView2_17` is missing): the attach Channel, raw bytes, with release acks.
//!
//! `MC_PTY_TRANSPORT=sharedBuffer|pull|channel` picks one in dev / check builds (measurements, SP5 comparison).
//!
//! The DB port (D12) carries JSON messages only. On Windows they go as shared buffers too ([`DbBufferSink`]: one writer
//! thread per attach batches the queued messages, `[u32 LE len][UTF-8 JSON]...` with `{"mcPort":"db","a":<attach id>}`),
//! so a large row chunk costs no Channel eval + fetch; elsewhere (and with `MC_DB_TRANSPORT=channel` in dev / check
//! builds) the attach Channel with the JSON text as the sessions wrote it.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::{Condvar, Mutex};
use serde_json::Value;
use tauri::Webview;
use tauri::ipc::{Channel, InvokeResponseBody, Request, Response};

use unimux_ipc::{IpcError, PortSink};

/// A UI thread slower than this is counted as a stall (and still waited for).
const POST_STALL: Duration = Duration::from_secs(2);
/// A pull request returns empty after this long without a message (the page asks again).
const PULL_WAIT: Duration = Duration::from_secs(20);

/// UI-thread stalls of shared-buffer posts (all windows; harness stats).
pub static POST_STALLS: AtomicU64 = AtomicU64::new(0);

/// The transport the build prefers for the pty port.
fn preferred() -> &'static str {
    #[cfg(dev_overrides)]
    if let Ok(v) = std::env::var("MC_PTY_TRANSPORT") {
        match v.as_str() {
            "sharedBuffer" => return "sharedBuffer",
            "pull" => return "pull",
            "channel" => return "channel",
            _ => {}
        }
    }
    if cfg!(windows) { "sharedBuffer" } else { "pull" }
}

/// The attach Channel (JSON messages, raw bytes). Gated: the page releases every frames message.
pub struct ChannelSink(pub Channel<InvokeResponseBody>);

impl PortSink for ChannelSink {
    fn post_json(&self, message: &Value) -> bool {
        serde_json::to_string(message).ok().is_some_and(|s| self.0.send(InvokeResponseBody::Json(s)).is_ok())
    }
    fn post_bytes(&self, bytes: &[u8]) -> bool {
        self.0.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok()
    }
    fn post_json_text(&self, text: String) -> bool {
        self.0.send(InvokeResponseBody::Json(text)).is_ok()
    }
    fn gated(&self) -> bool {
        true
    }
}

/// The transport the build prefers for the DB port.
fn db_preferred() -> &'static str {
    #[cfg(dev_overrides)]
    if let Ok(v) = std::env::var("MC_DB_TRANSPORT") {
        match v.as_str() {
            "sharedBuffer" => return "sharedBuffer",
            "channel" => return "channel",
            _ => {}
        }
    }
    if cfg!(windows) { "sharedBuffer" } else { "channel" }
}

/// The sink of a port attach: the Channel for sftp, shared buffers on Windows for db, the preferred data plane for pty.
/// Returns the transport name the page has to serve.
pub async fn sink_for(
    kind: &str,
    webview: &Webview,
    channel: Channel<InvokeResponseBody>,
    attach: Option<&str>,
) -> (Arc<dyn PortSink>, &'static str) {
    if kind == "db" && db_preferred() == "sharedBuffer" && shared_buffer_supported(webview).await {
        let attach = attach.filter(|a| valid_attach_id(a)).map(str::to_string);
        return (DbBufferSink::start(webview.clone(), channel, attach), "sharedBuffer");
    }
    if kind != "pty" {
        return (Arc::new(ChannelSink(channel)), "channel");
    }
    match preferred() {
        "pull" => {
            let sink = PullSink::new(channel);
            if let Some(old) = pulls().lock().insert(webview.label().to_string(), sink.clone()) {
                old.close();
            }
            (sink, "pull")
        }
        "sharedBuffer" if shared_buffer_supported(webview).await => {
            let attach = attach.filter(|a| valid_attach_id(a)).map(str::to_string);
            (Arc::new(SharedBufferSink { webview: webview.clone(), channel, attach }), "sharedBuffer")
        }
        _ => (Arc::new(ChannelSink(channel)), "channel"),
    }
}

// ---- WebView2 shared buffers (Windows) ----

#[cfg(windows)]
async fn shared_buffer_supported(webview: &Webview) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_17, ICoreWebView2Environment12};
    use windows::core::Interface;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let queued = webview
        .with_webview(move |platform| {
            // SAFETY: COM queries on the live controller and environment, on the UI thread Tauri runs this closure on.
            let ok = unsafe {
                platform.environment().cast::<ICoreWebView2Environment12>().is_ok()
                    && platform.controller().CoreWebView2().ok().and_then(|c| c.cast::<ICoreWebView2_17>().ok()).is_some()
            };
            let _ = tx.send(ok);
        })
        .is_ok();
    queued && rx.await.unwrap_or(false)
}

#[cfg(not(windows))]
async fn shared_buffer_supported(_webview: &Webview) -> bool {
    false
}

/// The page's attach id goes into JSON text as is: only short ids of plain characters (a UUID) are used.
fn valid_attach_id(a: &str) -> bool {
    !a.is_empty() && a.len() <= 64 && a.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// The additional data of a shared buffer.
fn additional_data(attach: Option<&str>, seq: u64) -> String {
    match attach {
        Some(a) => format!("{{\"mcPort\":\"pty\",\"a\":\"{a}\",\"n\":{seq}}}"),
        None => format!("{{\"mcPort\":\"pty\",\"n\":{seq}}}"),
    }
}

pub struct SharedBufferSink {
    webview: Webview,
    /// JSON messages (none for pty since P2) and the fallback.
    channel: Channel<InvokeResponseBody>,
    /// The page's attach id (see `additional_data`).
    attach: Option<String>,
}

impl PortSink for SharedBufferSink {
    fn post_json(&self, message: &Value) -> bool {
        serde_json::to_string(message).ok().is_some_and(|s| self.channel.send(InvokeResponseBody::Json(s)).is_ok())
    }
    fn post_bytes(&self, bytes: &[u8]) -> bool {
        self.post_frames(0, bytes.to_vec())
    }
    fn post_frames(&self, seq: u64, bytes: Vec<u8>) -> bool {
        post_shared_buffer(&self.webview, additional_data(self.attach.as_deref(), seq), bytes)
    }
    fn gated(&self) -> bool {
        true
    }
    fn transport(&self) -> &'static str {
        "sharedBuffer"
    }
}

/// A DB port batch is cut at this size (a single larger message still goes alone).
const DB_BATCH_BYTES: usize = 4 << 20;

#[derive(Default)]
struct DbQueue {
    items: VecDeque<String>,
    closed: bool,
}

/// The DB port as shared buffers (see the module text). Messages keep their order: a batch that could not be posted goes
/// over the Channel as a whole, before anything later.
pub struct DbBufferSink {
    queue: Arc<(Mutex<DbQueue>, Condvar)>,
}

impl DbBufferSink {
    fn start(webview: Webview, channel: Channel<InvokeResponseBody>, attach: Option<String>) -> Arc<dyn PortSink> {
        let queue: Arc<(Mutex<DbQueue>, Condvar)> = Arc::default();
        let q = queue.clone();
        let extra = match &attach {
            Some(a) => format!("{{\"mcPort\":\"db\",\"a\":\"{a}\"}}"),
            None => "{\"mcPort\":\"db\"}".to_string(),
        };
        let spawned = std::thread::Builder::new().name("unimux-db-port".into()).spawn(move || {
            loop {
                let batch = {
                    let (lock, cv) = &*q;
                    let mut st = lock.lock();
                    while st.items.is_empty() && !st.closed {
                        cv.wait(&mut st);
                    }
                    if st.closed {
                        return;
                    }
                    take_batch(&mut st.items, DB_BATCH_BYTES)
                };
                if !post_shared_buffer(&webview, extra.clone(), frame_batch(&batch)) {
                    for text in batch {
                        let _ = channel.send(InvokeResponseBody::Json(text));
                    }
                }
            }
        });
        if spawned.is_err() {
            queue.0.lock().closed = true;
        }
        Arc::new(DbBufferSink { queue })
    }
}

/// The oldest queued messages up to `max` bytes (at least one).
fn take_batch(items: &mut VecDeque<String>, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut size = 0;
    while let Some(next) = items.front() {
        if !out.is_empty() && size + 4 + next.len() > max {
            break;
        }
        size += 4 + next.len();
        out.extend(items.pop_front());
    }
    out
}

/// `[u32 LE len][UTF-8 JSON]...`
fn frame_batch(batch: &[String]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(batch.iter().map(|t| t.len() + 4).sum());
    for text in batch {
        bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
        bytes.extend_from_slice(text.as_bytes());
    }
    bytes
}

impl PortSink for DbBufferSink {
    fn post_json(&self, message: &Value) -> bool {
        serde_json::to_string(message).ok().is_some_and(|s| self.post_json_text(s))
    }
    fn post_bytes(&self, _bytes: &[u8]) -> bool {
        false
    }
    fn post_json_text(&self, text: String) -> bool {
        let (lock, cv) = &*self.queue;
        let mut st = lock.lock();
        if st.closed {
            return false;
        }
        st.items.push_back(text);
        cv.notify_one();
        true
    }
    fn transport(&self) -> &'static str {
        "sharedBuffer"
    }
    fn close(&self) {
        let (lock, cv) = &*self.queue;
        let mut st = lock.lock();
        st.closed = true;
        st.items.clear();
        cv.notify_all();
    }
}

/// Posts one message as a shared buffer and waits until the UI thread called `PostSharedBufferToScript`.
#[cfg(windows)]
fn post_shared_buffer(webview: &Webview, extra: String, bytes: Vec<u8>) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, ICoreWebView2_17, ICoreWebView2Environment12,
    };
    use windows::core::{HSTRING, Interface};
    if bytes.is_empty() {
        return true;
    }
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let queued = webview
        .with_webview(move |platform| {
            let extra = HSTRING::from(extra);
            // SAFETY: COM calls on the live environment and webview, on the UI thread Tauri runs this closure on; the copy
            // stays inside the buffer's own size.
            let posted = unsafe {
                (|| -> windows::core::Result<()> {
                    let env = platform.environment().cast::<ICoreWebView2Environment12>()?;
                    let buffer = env.CreateSharedBuffer(bytes.len() as u64)?;
                    let mut ptr: *mut u8 = std::ptr::null_mut();
                    buffer.Buffer(&mut ptr)?;
                    if ptr.is_null() {
                        return Err(windows::core::Error::empty());
                    }
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
                    let core = platform.controller().CoreWebView2()?.cast::<ICoreWebView2_17>()?;
                    core.PostSharedBufferToScript(&buffer, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, &extra)
                })()
            };
            let _ = tx.send(posted.is_ok());
        })
        .is_ok();
    if !queued {
        return false;
    }
    loop {
        match rx.recv_timeout(POST_STALL) {
            Ok(posted) => return posted,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                POST_STALLS.fetch_add(1, Ordering::Relaxed);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
}

#[cfg(not(windows))]
fn post_shared_buffer(_webview: &Webview, _extra: String, _bytes: Vec<u8>) -> bool {
    false
}

// ---- pull transport ----

#[derive(Default)]
struct PullState {
    message: Option<Vec<u8>>,
    closed: bool,
}

pub struct PullSink {
    state: Mutex<PullState>,
    /// The sender waits here until its message was pulled.
    taken: Condvar,
    ready: tokio::sync::Notify,
    channel: Channel<InvokeResponseBody>,
}

impl PullSink {
    fn new(channel: Channel<InvokeResponseBody>) -> Arc<Self> {
        Arc::new(Self { state: Mutex::default(), taken: Condvar::new(), ready: tokio::sync::Notify::new(), channel })
    }

    /// The next message (None: the sink was replaced or closed; empty: nothing for PULL_WAIT).
    async fn pull(&self) -> Option<Vec<u8>> {
        let deadline = tokio::time::Instant::now() + PULL_WAIT;
        loop {
            let notified = self.ready.notified();
            {
                let mut st = self.state.lock();
                if let Some(m) = st.message.take() {
                    drop(st);
                    self.taken.notify_all();
                    return Some(m);
                }
                if st.closed {
                    return None;
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Some(Vec::new());
            }
        }
    }
}

impl PortSink for PullSink {
    fn post_json(&self, message: &Value) -> bool {
        serde_json::to_string(message).ok().is_some_and(|s| self.channel.send(InvokeResponseBody::Json(s)).is_ok())
    }
    fn post_bytes(&self, bytes: &[u8]) -> bool {
        self.post_frames(0, bytes.to_vec())
    }
    fn post_frames(&self, _seq: u64, bytes: Vec<u8>) -> bool {
        let mut st = self.state.lock();
        while st.message.is_some() && !st.closed {
            self.taken.wait(&mut st);
        }
        if st.closed {
            return false;
        }
        st.message = Some(bytes);
        self.ready.notify_one();
        while st.message.is_some() && !st.closed {
            self.taken.wait(&mut st);
        }
        !st.closed || st.message.is_none()
    }
    fn transport(&self) -> &'static str {
        "pull"
    }
    fn close(&self) {
        self.state.lock().closed = true;
        self.taken.notify_all();
        self.ready.notify_waiters();
        self.ready.notify_one();
    }
}

fn pulls() -> &'static Mutex<HashMap<String, Arc<PullSink>>> {
    static PULLS: OnceLock<Mutex<HashMap<String, Arc<PullSink>>>> = OnceLock::new();
    PULLS.get_or_init(Mutex::default)
}

/// A window is gone: its pull sink goes with it.
pub fn window_destroyed(label: &str) {
    if let Some(old) = pulls().lock().remove(label) {
        old.close();
    }
}

/// The pull transport's request: the window's next frames message as the raw body (empty: nothing yet, ask again; an
/// error: the port was replaced, stop).
#[tauri::command]
pub async fn mc_port_pull(
    webview: Webview,
    ctx: tauri::State<'_, Arc<crate::context::AppContext>>,
    request: Request<'_>,
    kind: String,
) -> Result<Response, IpcError> {
    let caller = crate::ipc::caller_of(&webview, &request);
    if kind != "pty" || !ctx.guard_allows(&caller) {
        return Err(IpcError::Refused { command: format!("port:{kind}") });
    }
    let sink = pulls().lock().get(webview.label()).cloned();
    let Some(sink) = sink else { return Err(IpcError::Refused { command: "port:pty".into() }) };
    match sink.pull().await {
        Some(bytes) => Ok(Response::new(InvokeResponseBody::Raw(bytes))),
        None => Err(IpcError::Refused { command: "port:pty".into() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_batches_keep_the_order_and_frame_each_message() {
        let mut q: VecDeque<String> = ["ab", "cde", "f"].map(String::from).into();
        assert_eq!(take_batch(&mut q, 13), vec!["ab".to_string(), "cde".to_string()]);
        assert_eq!(take_batch(&mut q, 1), vec!["f".to_string()], "one message always goes");
        assert!(q.is_empty());
        let bytes = frame_batch(&["{}".to_string(), "\"\\udc00\"".to_string()]);
        assert_eq!(&bytes[..6], &[2, 0, 0, 0, b'{', b'}']);
        assert_eq!(&bytes[6..10], &[8, 0, 0, 0]);
        assert_eq!(&bytes[10..], b"\"\\udc00\"");
    }

    #[test]
    fn shared_buffers_name_the_attach_and_the_message_number() {
        assert!(valid_attach_id("1b4e28ba-2fa1-11d2-883f-0016d3cca427"));
        assert!(!valid_attach_id("x\",\"n\":1"));
        assert!(!valid_attach_id(""));
        assert!(!valid_attach_id(&"a".repeat(65)));
        let v: Value = serde_json::from_str(&additional_data(Some("abc-1"), 7)).unwrap();
        assert_eq!(v, serde_json::json!({ "mcPort": "pty", "a": "abc-1", "n": 7 }));
        let v: Value = serde_json::from_str(&additional_data(None, 3)).unwrap();
        assert_eq!(v, serde_json::json!({ "mcPort": "pty", "n": 3 }));
    }
}
