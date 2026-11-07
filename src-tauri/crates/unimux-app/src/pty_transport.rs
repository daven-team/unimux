//! Transports of the pty data plane (P2, SP1 / SP5 decisions): how one window's frames messages reach its page.
//!
//! - `sharedBuffer` (Windows, default): `ICoreWebView2Environment12::CreateSharedBuffer` + `ICoreWebView2_17::
//!   PostSharedBufferToScript` (read only; the additional data `{"mcPort":"pty","n":<seq>}` names the port and the
//!   message number). A post waits until the UI thread made it (at most one post queued on the UI thread, a slower UI
//!   thread is waited for and counted every 2 s, never answered with a second post); the page answers each message with a
//!   release ack, so the batcher caps the messages in flight per window.
//! - `pull` (macOS default: WKWebView has no shared buffer): the page long-polls `mc_port_pull`, one request in flight; a
//!   post waits until a pull took it.
//! - `channel` (fallback when `ICoreWebView2_17` is missing): the attach Channel, raw bytes, with release acks.
//!
//! `MC_PTY_TRANSPORT=sharedBuffer|pull|channel` picks one in dev / check builds (measurements, SP5 comparison).

use std::collections::HashMap;
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
    fn gated(&self) -> bool {
        true
    }
}

/// The sink of a port attach: the Channel for sftp / db, the preferred data plane for pty. Returns the transport name the
/// page has to serve.
pub async fn sink_for(kind: &str, webview: &Webview, channel: Channel<InvokeResponseBody>) -> (Arc<dyn PortSink>, &'static str) {
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
            (Arc::new(SharedBufferSink { webview: webview.clone(), channel }), "sharedBuffer")
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

pub struct SharedBufferSink {
    webview: Webview,
    /// JSON messages (none for pty since P2) and the fallback.
    channel: Channel<InvokeResponseBody>,
}

impl PortSink for SharedBufferSink {
    fn post_json(&self, message: &Value) -> bool {
        serde_json::to_string(message).ok().is_some_and(|s| self.channel.send(InvokeResponseBody::Json(s)).is_ok())
    }
    fn post_bytes(&self, bytes: &[u8]) -> bool {
        self.post_frames(0, bytes.to_vec())
    }
    fn post_frames(&self, seq: u64, bytes: Vec<u8>) -> bool {
        post_shared_buffer(&self.webview, seq, bytes)
    }
    fn gated(&self) -> bool {
        true
    }
    fn transport(&self) -> &'static str {
        "sharedBuffer"
    }
}

/// Posts one message as a shared buffer and waits until the UI thread called `PostSharedBufferToScript`.
#[cfg(windows)]
fn post_shared_buffer(webview: &Webview, seq: u64, bytes: Vec<u8>) -> bool {
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
            let extra = HSTRING::from(format!("{{\"mcPort\":\"pty\",\"n\":{seq}}}"));
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
fn post_shared_buffer(_webview: &Webview, _seq: u64, _bytes: Vec<u8>) -> bool {
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
