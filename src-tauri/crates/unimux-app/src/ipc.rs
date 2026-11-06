//! The Tauri commands behind window.mc (PLAN F3): `mc_invoke` (request/answer), `mc_send` (ordered fire-and-forget),
//! `mc_invoke_raw` (a Uint8Array argument as the raw body), and the port commands. Every call goes through the router,
//! which applies the sender guard and answers `MC_NOT_YET` for channels whose package has not landed.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};
use tauri::{State, Webview};

use unimux_ipc::{Call, Caller, IpcError, PortSink, Reply};

use crate::context::AppContext;

fn caller(webview: &Webview) -> Caller {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    Caller::new(webview.label(), url)
}

fn response(reply: Reply) -> Response {
    match reply {
        Reply::Json(v) => Response::new(InvokeResponseBody::Json(serde_json::to_string(&v).unwrap_or_else(|_| "null".into()))),
        Reply::Bytes(b) => Response::new(InvokeResponseBody::Raw(b)),
    }
}

#[tauri::command]
pub async fn mc_invoke(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    cmd: String,
    args: Vec<Value>,
) -> Result<Response, IpcError> {
    let call = Call::new(&cmd, caller(&webview), args);
    ctx.router().invoke(call).await.map(response)
}

#[tauri::command]
pub async fn mc_send(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    session: String,
    seq: u64,
    cmd: String,
    args: Vec<Value>,
) -> Result<(), IpcError> {
    let caller = caller(&webview);
    ctx.router().admit_send(&cmd, &caller)?;
    let label = caller.label.clone();
    let call = Call::new(&cmd, caller, args);
    if let Some(queue) = ctx.sends.get() {
        queue.submit(&label, &session, seq, call);
    }
    Ok(())
}

/// A call with one Uint8Array argument (`notes:image:save`): the bytes are the raw body, the command and the other arguments
/// travel in the `mc-cmd` and `mc-args` headers (JSON, the bytes' position holds null).
#[tauri::command]
pub async fn mc_invoke_raw(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    request: Request<'_>,
) -> Result<Response, IpcError> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let cmd = header("mc-cmd").ok_or_else(|| IpcError::Unknown { command: String::new() })?;
    let args: Vec<Value> = header("mc-args").and_then(|a| serde_json::from_str(&a).ok()).unwrap_or_default();
    let body = match request.body() {
        InvokeBody::Raw(bytes) => Some(bytes.clone()),
        InvokeBody::Json(_) => None,
    };
    let mut call = Call::new(&cmd, caller(&webview), args);
    call.body = body;
    ctx.router().invoke(call).await.map(response)
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
    kind: String,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), IpcError> {
    let caller = caller(&webview);
    if !ctx.guard_allows(&caller) {
        return Err(IpcError::Refused { command: format!("port:{kind}") });
    }
    ctx.ports.attach(&kind, &caller.label, Arc::new(ChannelSink(channel)))
}

/// Renderer -> host messages of the pty port (write, resize, ack, focus...).
#[tauri::command]
pub async fn mc_port_post(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    kind: String,
    message: Value,
) -> Result<(), IpcError> {
    let caller = caller(&webview);
    if !ctx.guard_allows(&caller) {
        return Err(IpcError::Refused { command: format!("port:{kind}") });
    }
    ctx.ports.post(&kind, &caller.label, message)
}

/// window.updateSplash of the update windows (U1 / U2 fill these; wave 0 has no gate window yet).
#[tauri::command]
pub async fn update_splash_init() -> Result<Value, IpcError> {
    Err(IpcError::NotYet { command: "update-splash:init".into() })
}

#[tauri::command]
pub async fn update_splash_close() {}

#[tauri::command]
pub async fn update_splash_open() {}

impl AppContext {
    pub fn guard_allows(&self, caller: &Caller) -> bool {
        use unimux_ipc::Guard;
        self.guard.allowed(caller)
    }
}
