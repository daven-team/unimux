//! Commands of the `pty` domain: P1-P5: cells and the pty port (cell:*).
//!
//! P2: the pty port. The app's [`PtyEngine`] (unimux-pty: OutputChannel, FlowGate, TailBuffer, per-window batcher,
//! host-side DA1) owns the port `pty`: a page attaches it on every load (`mc_port_attach`, ipc.rs picks the transport:
//! WebView2 shared buffers on Windows, the pull transport on macOS, the Channel as fallback) and posts its messages
//! through `mc_port_post` in order. The cell commands (`cell:spawn`, `cell:kill`, ...) are P3 / P4; until then the router
//! answers them with `MC_NOT_YET`, and the check build spawns terminals through the test bridge (`pty` op).

use std::sync::{Arc, OnceLock};

use serde_json::Value;
use unimux_ipc::{PortOwner, PortSink, RouterBuilder};
use unimux_pty::batch::Transport;
use unimux_pty::engine::PtyEngine;

use crate::context::AppContext;

static ENGINE: OnceLock<PtyEngine> = OnceLock::new();

/// The engine of this run (created on first use).
pub fn engine() -> &'static PtyEngine {
    ENGINE.get_or_init(PtyEngine::new)
}

/// A port sink as the batcher's transport.
struct SinkTransport(Arc<dyn PortSink>);

impl Transport for SinkTransport {
    fn post(&self, seq: u64, bytes: Vec<u8>) -> bool {
        self.0.post_frames(seq, bytes)
    }
    fn gated(&self) -> bool {
        self.0.gated()
    }
    fn name(&self) -> &'static str {
        self.0.transport()
    }
    fn close(&self) {
        self.0.close();
    }
}

struct PtyPort;

impl PortOwner for PtyPort {
    fn attach(&self, label: &str, sink: Arc<dyn PortSink>) {
        engine().attach(label, Arc::new(SinkTransport(sink)));
    }
    fn post(&self, label: &str, message: Value) {
        engine().post(label, &message);
    }
    fn detach(&self, label: &str) {
        engine().detach(label);
    }
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let _ = r;
    ctx.ports.register("pty", Arc::new(PtyPort));
}

/// The check build's terminals (test bridge op `pty`, never in a release build): what P3's `cell:spawn` will do for a
/// cell, without the launch line, so the real-app scripts can drive the data plane with the real renderer.
///
/// `{action: "spawn", id, cwd, cols?, rows?, shell?: "cmd"|"powershell"|"pwsh"|"bash"|"zsh", file?, args?, command?}`,
/// `{action: "kill", id}`, `{action: "killAll"}`, `{action: "write", id, data}`, `{action: "route", id, window?}`,
/// `{action: "stats"}`, `{action: "replay", id}`.
#[cfg(feature = "test-bridge")]
pub fn test_op(args: &Value) -> Result<Value, String> {
    use std::time::Duration;

    use serde_json::json;
    use unimux_pty::manager::SpawnRequest;
    use unimux_pty::shell::{Launch, ShellKind};

    let s = |k: &str| args.get(k).and_then(Value::as_str);
    let engine = engine();
    match s("action").unwrap_or("") {
        "spawn" => {
            let id = s("id").ok_or("spawn needs an id")?;
            let cwd = s("cwd").ok_or("spawn needs a cwd")?;
            let shell = match s("shell").unwrap_or("cmd") {
                "cmd" => ShellKind::Cmd,
                "powershell" => ShellKind::Powershell,
                "pwsh" => ShellKind::Pwsh,
                "bash" => ShellKind::Bash,
                _ => ShellKind::Zsh,
            };
            let mut req = SpawnRequest::new(id, cwd, shell);
            if let Some(c) = args.get("cols").and_then(Value::as_u64) {
                req.cols = c.clamp(2, 1000) as u16;
            }
            if let Some(r) = args.get("rows").and_then(Value::as_u64) {
                req.rows = r.clamp(1, 1000) as u16;
            }
            req.env = std::env::vars().collect();
            req.cell_id = Some(id.to_string());
            req.command = s("command").map(str::to_string);
            if let Some(file) = s("file") {
                let list: Vec<String> = args
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let refs: Vec<&str> = list.iter().map(String::as_str).collect();
                req.launch = Some(Launch::new(file, &refs));
            }
            let pid = engine.spawn(req).map_err(|e| e.to_string())?;
            Ok(json!({ "pid": pid }))
        }
        "kill" => {
            let id = s("id").ok_or("kill needs an id")?;
            Ok(json!({ "ended": engine.kill_and_wait(id, Duration::from_secs(4)) }))
        }
        "killAll" => Ok(json!({ "ended": engine.kill_all(Duration::from_secs(3)) })),
        "write" => {
            engine.write(s("id").ok_or("write needs an id")?, s("data").unwrap_or("").as_bytes());
            Ok(Value::Null)
        }
        "route" => {
            engine.route(s("id").ok_or("route needs an id")?, s("window"));
            Ok(Value::Null)
        }
        "replay" => {
            let (data, sizes) = engine.replay(s("id").ok_or("replay needs an id")?).ok_or("no such terminal")?;
            Ok(json!({
                "bytes": data.len(),
                "sizes": sizes.iter().map(|z| json!({ "at": z.at, "cols": z.cols, "rows": z.rows })).collect::<Vec<_>>(),
            }))
        }
        "stats" => Ok(engine.stats_json()),
        other => Err(format!("unknown pty action {other}")),
    }
}
