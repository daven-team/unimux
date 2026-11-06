//! Spike SP5 (check flavour only, feature `test-bridge`): the ConPTY data plane of unimux-pty behind two commands, driven by
//! scripts/sp5/run.mjs from a page it serves itself. Output leaves as binary frames over one `Channel` per page, the page
//! acknowledges parsed bytes. Nothing in the app uses it; P1 / P2 / P3 build the real pty service.

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
mod other {
    use serde_json::Value;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use unimux_ipc::IpcError;

    #[tauri::command]
    pub async fn spike_pty_attach(config: Option<Value>, channel: Channel<InvokeResponseBody>) -> Result<Value, IpcError> {
        let _ = (config, channel);
        Err(IpcError::failed("spike_pty", "the SP5 spike is Windows only"))
    }

    #[tauri::command]
    pub async fn spike_pty(op: String, args: Option<Value>) -> Result<Value, IpcError> {
        let _ = (op, args);
        Err(IpcError::failed("spike_pty", "the SP5 spike is Windows only"))
    }
}
#[cfg(not(windows))]
pub use other::*;

#[cfg(windows)]
mod imp {
    use std::sync::{Arc, OnceLock};

    use parking_lot::Mutex;
    use serde_json::{Value, json};
    use tauri::ipc::{Channel, InvokeResponseBody};

    use unimux_ipc::IpcError;
    use unimux_pty::conpty::{ConptyApi, SpawnOptions};
    use unimux_pty::plane::{Plane, PlaneConfig};

    fn plane_slot() -> &'static Mutex<Option<Arc<Plane>>> {
        static PLANE: OnceLock<Mutex<Option<Arc<Plane>>>> = OnceLock::new();
        PLANE.get_or_init(|| Mutex::new(None))
    }

    fn fail(m: impl std::fmt::Display) -> IpcError {
        IpcError::failed("spike_pty", m.to_string())
    }

    /// A page attaches its channel; `config` {batchMs, timer1ms, flow} starts a fresh plane (old terminals are killed).
    #[tauri::command]
    pub async fn spike_pty_attach(config: Option<Value>, channel: Channel<InvokeResponseBody>) -> Result<Value, IpcError> {
        let config = config.unwrap_or(Value::Null);
        let defaults = PlaneConfig::default();
        let cfg = PlaneConfig {
            batch_ms: config.get("batchMs").and_then(Value::as_u64).unwrap_or(defaults.batch_ms),
            focus_ms: config.get("focusMs").and_then(Value::as_u64).unwrap_or(defaults.focus_ms),
            timer_1ms: config.get("timer1ms").and_then(Value::as_bool).unwrap_or(defaults.timer_1ms),
            flow: config.get("flow").and_then(Value::as_bool).unwrap_or(defaults.flow),
        };
        let api = ConptyApi::shared().map_err(fail)?;
        let plane = Plane::new(api, cfg);
        plane.attach(Arc::new(move |bytes: Vec<u8>| channel.send(InvokeResponseBody::Raw(bytes)).is_ok()));
        if let Some(old) = plane_slot().lock().replace(plane.clone()) {
            old.kill_all();
        }
        Ok(plane.stats_json())
    }

    fn plane() -> Result<Arc<Plane>, IpcError> {
        plane_slot().lock().clone().ok_or_else(|| fail("no plane attached"))
    }

    fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, IpcError> {
        args.get(key).and_then(Value::as_str).ok_or_else(|| fail(format!("missing {key}")))
    }

    fn u16_arg(args: &Value, key: &str, default: u16) -> u16 {
        args.get(key).and_then(Value::as_u64).map(|v| v.min(u16::MAX as u64) as u16).unwrap_or(default)
    }

    #[tauri::command]
    pub async fn spike_pty(op: String, args: Option<Value>) -> Result<Value, IpcError> {
        let args = args.unwrap_or(Value::Null);
        match op.as_str() {
            "spawn" => {
                let p = plane()?;
                let id = str_arg(&args, "id")?;
                let mut opts = SpawnOptions::new(str_arg(&args, "file")?, &[]);
                opts.args = args
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                opts.cols = u16_arg(&args, "cols", 80);
                opts.rows = u16_arg(&args, "rows", 24);
                opts.cwd = args.get("cwd").and_then(Value::as_str).map(Into::into);
                // The app's environment plus what 1.1.4's pty host set for every terminal, plus the page's extras.
                let mut env: Vec<(String, String)> = std::env::vars().collect();
                let mut set = |k: &str, v: &str| {
                    env.retain(|(key, _)| !key.eq_ignore_ascii_case(k));
                    env.push((k.to_string(), v.to_string()));
                };
                if let Some(extra) = args.get("env").and_then(Value::as_object) {
                    for (k, v) in extra {
                        if let Some(v) = v.as_str() {
                            set(k, v);
                        }
                    }
                }
                set("TERM", "xterm-256color");
                set("COLORTERM", "truecolor");
                set("TERM_PROGRAM", "unimux");
                opts.env = Some(env);
                let pid = p.spawn(id, &opts).map_err(fail)?;
                Ok(json!({ "pid": pid }))
            }
            "write" => {
                plane()?.write(str_arg(&args, "id")?, str_arg(&args, "data")?.as_bytes());
                Ok(Value::Null)
            }
            "resize" => {
                plane()?.resize(str_arg(&args, "id")?, u16_arg(&args, "cols", 80), u16_arg(&args, "rows", 24));
                Ok(Value::Null)
            }
            // Several terminals' acks in one call: {acks: [[id, bytes], ...]}.
            "ack" => {
                let p = plane()?;
                for item in args.get("acks").and_then(Value::as_array).into_iter().flatten() {
                    if let (Some(id), Some(n)) = (item.get(0).and_then(Value::as_str), item.get(1).and_then(Value::as_u64)) {
                        p.ack(id, n as usize);
                    }
                }
                Ok(Value::Null)
            }
            "synthetic" => {
                let p = plane()?;
                let rate = args.get("rate").and_then(Value::as_u64).unwrap_or(1_000_000);
                let seconds = args.get("seconds").and_then(Value::as_u64).unwrap_or(0);
                p.synthetic(str_arg(&args, "id")?, rate, seconds);
                Ok(Value::Null)
            }
            "focus" => {
                plane()?.focus(args.get("id").and_then(Value::as_str));
                Ok(Value::Null)
            }
            "kill" => {
                plane()?.kill(str_arg(&args, "id")?);
                Ok(Value::Null)
            }
            "killAll" => {
                if let Some(p) = plane_slot().lock().clone() {
                    p.kill_all();
                }
                Ok(Value::Null)
            }
            "stats" => Ok(plane()?.stats_json()),
            _ => Err(fail(format!("unknown op {op}"))),
        }
    }
}
