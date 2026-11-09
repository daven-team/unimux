//! The eval bridge (PLAN W2, feature `test-bridge` only, never in a release build): what CDP's `Runtime.evaluate` gives the
//! real-app scripts on Windows, for macOS, where WKWebView has no DevTools protocol. With `MC_EVAL_PORT=<port>` the check build
//! listens on 127.0.0.1:<port>; every line is a JSON request `{"id", "expression", "label"?, "timeoutMs"?}` and gets one JSON
//! line back, `{"id", "ok": true, "value"}` or `{"id", "ok": false, "error"}`. The expression runs in the window's page like
//! `Runtime.evaluate` with `awaitPromise` and `returnByValue` (scripts/eval-bridge.mjs is the client). It works on Windows
//! too, which is how the bridge itself is tested on this machine.
//!
//! The text runs like `Runtime.evaluate` runs it, through the host's script execution (`eval_with_callback`: WebView2
//! ExecuteScript / WKWebView evaluateJavaScript, injected by the host, so the page CSP, which has no 'unsafe-eval', does not
//! apply), in up to two forms:
//! 1. As an expression (`wrap`): an async function awaits it, makes the result JSON and posts it back through `test_bridge`
//!    op `evalResult`. The host callback tells whether the script parsed (PARSED comes back); this is how promises are
//!    awaited.
//! 2. When it does not parse as an expression, as statements (`wrap_statements`: `var a = ...; el.dispatchEvent(...)`,
//!    `const a = 1; a`): the text is the body of a `try` block, whose completion value is the script's completion value, as
//!    in CDP; the host serializes it (a promise it ends with is not awaited, and `const` / `let` stay inside the block). A
//!    thrown error is kept in the page and read back by a probe script (`probe`), which also tells a SyntaxError (the script
//!    did not run at all) from an `undefined` result. Both come back at once instead of after the timeout.
//!    Known gap: on WKWebView wry turns the completion value into JSON with NSJSONSerialization, which raises on values
//!    such as a `Date`, so a statement script should end with a plain value (expressions have no such limit).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

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

/// What the expression wrapper completes with once it parsed (the host callback gets it JSON-encoded).
const PARSED: &str = "mc-eval-parsed";

/// The page-side wrapper of an expression: runs it, makes the result JSON (undefined and functions become null) and posts it
/// back. The script itself completes with PARSED, so the host callback shows that it parsed (a SyntaxError gives nothing).
pub fn wrap(id: u64, expression: &str) -> String {
    format!(
        "(async () => {{ let ok = true, value; \
         try {{ value = await (\n{expression}\n); }} catch (e) {{ ok = false; value = [String(e), e && e.stack].filter(Boolean).join(' '); }} \
         let out = null; \
         try {{ const s = JSON.stringify(value); out = s === undefined ? null : JSON.parse(s); }} \
         catch (e) {{ ok = false; out = 'result is not serializable: ' + e; }} \
         await window.__TAURI_INTERNALS__.invoke('test_bridge', {{ op: 'evalResult', args: {{ id: {id}, ok, value: out }} }}); \
         }})(); '{PARSED}';"
    )
}

/// The page-side form of statements: the text is the body of a `try` block (its completion value is the script's); a thrown
/// error is kept in `window.__mcEvalRuns[id]` for `probe`. Nothing of it runs when the text does not parse.
pub fn wrap_statements(id: u64, script: &str) -> String {
    format!(
        "(window.__mcEvalRuns = window.__mcEvalRuns || {{}})[{id}] = {{ ok: true }};\ntry {{\n{script}\n}} \
         catch (e) {{ window.__mcEvalRuns[{id}] = {{ ok: false, error: [String(e), e && e.stack].filter(Boolean).join(' ') }}; }}"
    )
}

/// Runs after `wrap_statements` (the host runs scripts in order): `{ran, ok, error}` of that run, which it then forgets.
pub fn probe(id: u64) -> String {
    format!(
        "(() => {{ const runs = window.__mcEvalRuns || {{}}; const r = runs[{id}]; delete runs[{id}]; \
         return r ? {{ ran: true, ok: r.ok, error: r.error === undefined ? null : r.error }} : {{ ran: false, ok: false, error: null }}; }})()"
    )
}

/// The answer of a statement run from the host's completion value and the probe's report.
pub fn statements_answer(completion: &str, report: &Value) -> (bool, Value) {
    if report.get("ran").and_then(Value::as_bool) != Some(true) {
        return (false, Value::String("SyntaxError: the script parses neither as an expression nor as statements".into()));
    }
    if report.get("ok").and_then(Value::as_bool) != Some(true) {
        return (false, report.get("error").cloned().unwrap_or(Value::Null));
    }
    // Empty: `undefined` (WKWebView) or a value the host cannot convert; null, like JSON.stringify of undefined.
    (true, serde_json::from_str(completion).unwrap_or(Value::Null))
}

fn no_answer(timeout: Duration) -> String {
    format!("no answer within {} ms (page not loaded, reloading, or the bridge is missing)", timeout.as_millis())
}

/// Runs `script` through the host and waits for its completion value as JSON text (empty when it threw or did not parse, on
/// WKWebView also for `undefined` and values it cannot convert).
fn host_eval(window: &tauri::WebviewWindow, script: String, deadline: Instant, timeout: Duration) -> Result<String, String> {
    let (tx, rx) = channel::<String>();
    let tx = Mutex::new(Some(tx));
    window
        .eval_with_callback(script, move |result| {
            if let Some(tx) = tx.lock().take() {
                let _ = tx.send(result);
            }
        })
        .map_err(|e| format!("eval: {e}"))?;
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| no_answer(timeout))
}

fn evaluate(ctx: &AppContext, label: &str, expression: &str, timeout: Duration) -> Result<(bool, Value), String> {
    let app = ctx.app().ok_or("the app is not running yet")?;
    let window = app.get_webview_window(label).ok_or_else(|| format!("no window {label}"))?;
    let deadline = Instant::now() + timeout;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    PENDING.lock().insert(id, tx);
    let parsed = host_eval(&window, wrap(id, expression), deadline, timeout);
    if parsed.as_deref().is_ok_and(|s| serde_json::from_str::<String>(s).is_ok_and(|s| s == PARSED)) {
        let result = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        PENDING.lock().remove(&id);
        return result.map_err(|_| no_answer(timeout));
    }
    PENDING.lock().remove(&id);
    parsed?;
    // Not an expression: run it as statements, then read back how that went.
    let completion = host_eval(&window, wrap_statements(id, expression), deadline, timeout)?;
    let report = host_eval(&window, probe(id), deadline, timeout)?;
    Ok(statements_answer(&completion, &serde_json::from_str(&report).unwrap_or(Value::Null)))
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
        assert!(s.starts_with("(async () => {") && s.ends_with("})(); 'mc-eval-parsed';"));
    }

    #[test]
    fn statements_run_in_a_try_block_and_report_through_the_probe() {
        let s = wrap_statements(9, "const a = 1; a // comment");
        assert!(s.starts_with(
            "(window.__mcEvalRuns = window.__mcEvalRuns || {})[9] = { ok: true };\ntry {\nconst a = 1; a // comment\n} "
        ));
        assert!(s.contains("window.__mcEvalRuns[9] = { ok: false, error: [String(e), e && e.stack].filter(Boolean).join(' ') }"));
        assert!(probe(9).contains("const r = runs[9]; delete runs[9];"));
        // Ran: the host's completion value; undefined (empty on WKWebView) is null.
        let ran = json!({ "ran": true, "ok": true, "error": null });
        assert_eq!(statements_answer("1", &ran), (true, json!(1)));
        assert_eq!(statements_answer("", &ran), (true, Value::Null));
        assert_eq!(statements_answer("{\"a\":[1]}", &ran), (true, json!({ "a": [1] })));
        // Threw: the error. Never ran: a SyntaxError.
        assert_eq!(
            statements_answer("", &json!({ "ran": true, "ok": false, "error": "Error: boom" })),
            (false, json!("Error: boom"))
        );
        let (ok, error) = statements_answer("", &json!({ "ran": false, "ok": false, "error": null }));
        assert!(!ok && error.as_str().unwrap().starts_with("SyntaxError"));
        assert!(!statements_answer("", &Value::Null).0);
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
