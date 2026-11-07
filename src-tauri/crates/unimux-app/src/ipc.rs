//! The Tauri commands behind window.mc (PLAN F3): `mc_invoke` (request/answer), `mc_send` (ordered fire-and-forget),
//! `mc_invoke_raw` (a Uint8Array argument as the raw body), and the port commands (`mc_port_post` ordered like sends). Every
//! call goes through the router, which applies the sender guard and answers `MC_NOT_YET` for channels whose package has not
//! landed. Binary answers (`Reply::Bytes`, `Reply::Binary`) leave as one raw response framed by `unimux_ipc::binary`.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};
use tauri::{AppHandle, Manager, State, Webview};

use unimux_ipc::{Call, Caller, IpcError, PortSink, Reply};

use crate::context::AppContext;
use crate::update_window::UpdateWindow;

/// The caller: the webview's label and top-level URL, and the `Origin` header of this IPC request (the document that made
/// the call; absent on Tauri's postMessage fallback).
fn caller(webview: &Webview, request: &Request<'_>) -> Caller {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    let origin = request.headers().get("origin").and_then(|v| v.to_str().ok()).map(str::to_string);
    Caller::new(webview.label(), url).with_request_origin(origin)
}

fn response(reply: Reply) -> Response {
    match reply.raw_body() {
        Ok(frame) => Response::new(InvokeResponseBody::Raw(frame)),
        Err(v) => Response::new(InvokeResponseBody::Json(serde_json::to_string(&v).unwrap_or_else(|_| "null".into()))),
    }
}

#[tauri::command]
pub async fn mc_invoke(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    request: Request<'_>,
    cmd: String,
    args: Vec<Value>,
) -> Result<Response, IpcError> {
    let call = Call::new(&cmd, caller(&webview, &request), args);
    #[cfg(feature = "test-bridge")]
    if ctx.test_record.capture("invoke", &call.command, &call.caller.label, &call.args) {
        return Ok(Response::new(InvokeResponseBody::Json("null".into())));
    }
    let result = ctx.router().invoke(call).await;
    #[cfg(feature = "test-bridge")]
    ctx.test_record.observe(&result);
    result.map(response)
}

#[tauri::command]
pub async fn mc_send(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    request: Request<'_>,
    session: String,
    seq: u64,
    cmd: String,
    args: Vec<Value>,
) -> Result<(), IpcError> {
    let caller = caller(&webview, &request);
    let label = caller.label.clone();
    let Some(queue) = ctx.sends.get() else { return Ok(()) };
    // Check build: a recorded send the harness wants answered here (a stub of 1.1.4's mainInspector) still uses its number.
    #[cfg(feature = "test-bridge")]
    if ctx.test_record.capture("send", &cmd, &label, &args) {
        queue.skip(&label, &session, seq);
        return Ok(());
    }
    // A refused send (not yet, unknown, guard) still used its number: fill the slot so the next send is not held back.
    if let Err(e) = ctx.router().admit_send(&cmd, &caller) {
        #[cfg(feature = "test-bridge")]
        ctx.test_record.not_yet_hit_of(&e);
        queue.skip(&label, &session, seq);
        return Err(e);
    }
    queue.submit(&label, &session, seq, Call::new(&cmd, caller, args));
    Ok(())
}

/// A call with one Uint8Array argument (`notes:image:save`): the bytes are the raw body, the command and the other arguments
/// travel in the `mc-cmd` and `mc-args` headers (JSON with every non-ASCII character escaped, the bytes' position holds
/// null; `mc-raw-index` names that position).
#[tauri::command]
pub async fn mc_invoke_raw(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    request: Request<'_>,
) -> Result<Response, IpcError> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let cmd = header("mc-cmd").ok_or_else(|| IpcError::Unknown { command: String::new() })?;
    let args: Vec<Value> = header("mc-args")
        .and_then(|a| unimux_core::js_json::parse(&a).ok())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let body = match request.body() {
        InvokeBody::Raw(bytes) => Some(bytes.clone()),
        InvokeBody::Json(_) => None,
    };
    let mut call = Call::new(&cmd, caller(&webview, &request), args);
    call.body = body;
    let result = ctx.router().invoke(call).await;
    #[cfg(feature = "test-bridge")]
    ctx.test_record.observe(&result);
    result.map(response)
}

struct ChannelSink(Channel<InvokeResponseBody>);

impl PortSink for ChannelSink {
    fn post_json(&self, message: &Value) -> bool {
        serde_json::to_string(message).ok().is_some_and(|s| self.0.send(InvokeResponseBody::Json(s)).is_ok())
    }
    fn post_bytes(&self, bytes: &[u8]) -> bool {
        self.0.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok()
    }
}

/// The page asks for one of its ports (`pty`, `sftp`, `db`) on every load.
#[tauri::command]
pub async fn mc_port_attach(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    request: Request<'_>,
    kind: String,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), IpcError> {
    let caller = caller(&webview, &request);
    if !ctx.guard_allows(&caller) {
        return Err(IpcError::Refused { command: format!("port:{kind}") });
    }
    let result = ctx.ports.attach(&kind, &caller.label, Arc::new(ChannelSink(channel)));
    #[cfg(feature = "test-bridge")]
    ctx.test_record.observe(&result);
    result
}

/// Renderer -> host messages of the pty port (write, resize, ack, focus...), batched per microtask by the bridge and
/// numbered per page load (`session`, `seq`) like sends: Tauri runs invokes concurrently, a MessagePort kept the order. The
/// lane is `<label>\0port:<kind>`, so a closed window's lanes go with `SendQueue::forget(label)`.
#[tauri::command]
pub async fn mc_port_post(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    request: Request<'_>,
    session: String,
    seq: u64,
    kind: String,
    messages: Vec<Value>,
) -> Result<(), IpcError> {
    let caller = caller(&webview, &request);
    let Some(queue) = ctx.port_posts.get() else { return Ok(()) };
    let lane = format!("{}\0port:{kind}", caller.label);
    if !ctx.guard_allows(&caller) {
        queue.skip(&lane, &session, seq);
        return Err(IpcError::Refused { command: format!("port:{kind}") });
    }
    queue.submit(&lane, &session, seq, PortPost { kind, label: caller.label, messages });
    Ok(())
}

/// One batch of [`mc_port_post`], delivered in order by the port lane.
pub struct PortPost {
    pub kind: String,
    pub label: String,
    pub messages: Vec<Value>,
}

/// window.updateSplash of the update windows: the update window process (`--update-window`, SP6) answers through its
/// [`UpdateWindow`] state; the startup gate window of the app process comes with U1.
#[tauri::command]
pub async fn update_splash_init(app: AppHandle) -> Result<Value, IpcError> {
    match app.try_state::<Arc<UpdateWindow>>() {
        Some(win) => Ok(win.init_info()),
        None => Err(IpcError::NotYet { command: "update-splash:init".into() }),
    }
}

#[tauri::command]
pub async fn update_splash_close(app: AppHandle) {
    if let Some(win) = app.try_state::<Arc<UpdateWindow>>() {
        win.inner().request_close();
    }
}

#[tauri::command]
pub async fn update_splash_open(app: AppHandle) {
    if let Some(win) = app.try_state::<Arc<UpdateWindow>>() {
        win.open_app();
    }
}

impl AppContext {
    pub fn guard_allows(&self, caller: &Caller) -> bool {
        use unimux_ipc::Guard;
        self.guard.allowed(caller)
    }
}
