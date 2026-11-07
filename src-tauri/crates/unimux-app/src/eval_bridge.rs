//! The eval bridge (PLAN W2, feature `test-bridge` only, never in a release build): what CDP's `Runtime.evaluate` gives the
//! real-app scripts on Windows, for macOS, where WKWebView has no DevTools protocol. With `MC_EVAL_PORT=<port>` the check build
//! listens on 127.0.0.1:<port>; every line is a JSON request `{"id", "expression", "label"?, "timeoutMs"?}` and gets one JSON
//! line back, `{"id", "ok": true, "value"}` or `{"id", "ok": false, "error"}`. The expression runs in the window's page like
//! `Runtime.evaluate` with `awaitPromise` and `returnByValue` (scripts/eval-bridge.mjs is the client). It works on Windows
//! too, which is how the bridge itself is tested on this machine.
//!
//! Rust hands the expression to the webview (`eval`, injected by the host, so the page CSP does not apply) wrapped in an
//! async function that posts the result back through `test_bridge` op `evalResult`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::Manager;

use crate::context::AppContext;

/// The variable that turns the bridge on (check build only).
pub const PORT_VAR: &str = "MC_EVAL_PORT";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

type Pending = HashMap<u64, Sender<(bool, Value)>>;
static PENDING: LazyLock<Mutex<Pending>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Starts the listener when `MC_EVAL_PORT` is set; returns the bound port.
pub fn start(ctx: Arc<AppContext>) -> Option<u16> {
    let port: u16 = std::env::var(PORT_VAR).ok()?.trim().parse().ok().filter(|p| *p != 0)?;
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            ctx.crash.warn(&format!("eval bridge: cannot listen on 127.0.0.1:{port}: {e}"));
            return None;
        }
    };
    std::thread::Builder::new()
        .name("eval-bridge".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let ctx = ctx.clone();
                let _ = std::thread::Builder::new().name("eval-bridge-conn".into()).spawn(move || serve(stream, ctx));
            }
        })
        .ok()?;
    Some(port)
}

fn serve(stream: TcpStream, ctx: Arc<AppContext>) {
    let Ok(reader) = stream.try_clone() else { return };
    let writer = Arc::new(Mutex::new(stream));
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let (ctx, writer) = (ctx.clone(), writer.clone());
        // Requests of one connection may overlap (a long wait next to a quick probe), like CDP.
        let _ = std::thread::Builder::new().name("eval-bridge-req".into()).spawn(move || {
            let answer = answer(&ctx, &line);
            let mut out = answer.to_string();
            out.push('\n');
            let _ = writer.lock().write_all(out.as_bytes());
        });
    }
}

/// One request line -> one answer object.
pub fn answer(ctx: &AppContext, line: &str) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "id": null, "ok": false, "error": format!("bad request: {e}") }),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(expression) = request.get("expression").and_then(Value::as_str) else {
        return json!({ "id": id, "ok": false, "error": "no expression" });
    };
    let label = request.get("label").and_then(Value::as_str).unwrap_or(crate::windows::MAIN);
    let timeout = request.get("timeoutMs").and_then(Value::as_u64).map(Duration::from_millis).unwrap_or(DEFAULT_TIMEOUT);
    match evaluate(ctx, label, expression, timeout) {
        Ok((true, value)) => json!({ "id": id, "ok": true, "value": value }),
        Ok((false, error)) => json!({ "id": id, "ok": false, "error": error }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    }
}

/// The page-side wrapper: runs the expression, makes the result JSON (undefined and functions become null) and posts it back.
pub fn wrap(id: u64, expression: &str) -> String {
    format!(
        "(async () => {{ let ok = true, value; \
         try {{ value = await (\n{expression}\n); }} catch (e) {{ ok = false; value = String((e && e.stack) || e); }} \
         let out = null; \
         try {{ const s = JSON.stringify(value); out = s === undefined ? null : JSON.parse(s); }} \
         catch (e) {{ ok = false; out = 'result is not serializable: ' + e; }} \
         await window.__TAURI_INTERNALS__.invoke('test_bridge', {{ op: 'evalResult', args: {{ id: {id}, ok, value: out }} }}); \
         }})();"
    )
}

fn evaluate(ctx: &AppContext, label: &str, expression: &str, timeout: Duration) -> Result<(bool, Value), String> {
    let app = ctx.app().ok_or("the app is not running yet")?;
    let window = app.get_webview_window(label).ok_or_else(|| format!("no window {label}"))?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    PENDING.lock().insert(id, tx);
    if let Err(e) = window.eval(wrap(id, expression)) {
        PENDING.lock().remove(&id);
        return Err(format!("eval: {e}"));
    }
    let result = rx.recv_timeout(timeout);
    PENDING.lock().remove(&id);
    result.map_err(|_| {
        format!("no answer within {} ms (page not loaded, reloading, or the bridge is missing)", timeout.as_millis())
    })
}

/// `test_bridge` op `evalResult` from the page: `{id, ok, value}`.
pub fn deliver(args: &Value) -> Result<(), String> {
    let id = args.get("id").and_then(Value::as_u64).ok_or("evalResult needs an id")?;
    let ok = args.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let value = args.get("value").cloned().unwrap_or(Value::Null);
    match PENDING.lock().remove(&id) {
        Some(tx) => {
            let _ = tx.send((ok, value));
            Ok(())
        }
        // Timed out already: the caller got its error.
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapper_awaits_the_expression_and_posts_back() {
        let s = wrap(7, "1 + 1 // a trailing comment");
        assert!(s.contains("await (\n1 + 1 // a trailing comment\n)"));
        assert!(s.contains("op: 'evalResult', args: { id: 7, ok, value: out }"));
        assert!(s.starts_with("(async () => {") && s.ends_with("})();"));
    }

    #[test]
    fn delivers_to_the_waiting_request_once() {
        let (tx, rx) = channel();
        PENDING.lock().insert(424242, tx);
        deliver(&json!({ "id": 424242, "ok": true, "value": { "a": 1 } })).unwrap();
        assert_eq!(rx.recv().unwrap(), (true, json!({ "a": 1 })));
        // A late answer for a request that timed out is ignored.
        deliver(&json!({ "id": 424242, "ok": true, "value": null })).unwrap();
        assert!(deliver(&json!({ "ok": true })).is_err());
    }
}
