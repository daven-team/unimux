//! The stdio wire of unimux-hostd: one JSON object per line in both directions (UTF-8, `\n`).
//!
//! - request (Node -> host): `{"id": 7, "op": "pty.spawn", "args": {...}}`
//! - answer (host -> Node): `{"id": 7, "ok": true, "result": ...}` or `{"id": 7, "ok": false, "error": "text"}`; every
//!   request gets exactly one answer, in any order (a slow op such as `pty.killAll` answers from its own thread)
//! - event (host -> Node): `{"event": "pty.data", "args": {...}}`, never an `id`
//!
//! Requests are handled in the order they arrive on stdin (a `pty.write` sent after a `pty.spawn` always finds the terminal);
//! ops that wait answer later through [`Reply`] without holding up the next request. test/helpers/nodeHost.ts is the Node side.

use std::fmt::Display;
use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

/// UNIMUX_HOSTD_TRACE=1: every pty read and host-side answer is logged to stderr (test/helpers/nodeHost.ts keeps the last
/// 8 KB of stderr and adds it to the error when the host dies).
pub fn trace() -> bool {
    static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TRACE.get_or_init(|| std::env::var_os("UNIMUX_HOSTD_TRACE").is_some_and(|v| !v.is_empty()))
}

/// The shared stdout: whole lines only, one writer at a time, flushed per line.
#[derive(Clone)]
pub struct Out {
    sink: Arc<Mutex<Box<dyn Write + Send>>>,
    broken: Arc<AtomicBool>,
}

impl Out {
    pub fn stdout() -> Self {
        Self::new(Box::new(io::stdout()))
    }

    pub fn new(sink: Box<dyn Write + Send>) -> Self {
        Self { sink: Arc::new(Mutex::new(sink)), broken: Arc::new(AtomicBool::new(false)) }
    }

    /// Writes one message. A closed stdout (the Node side is gone) is remembered and later lines are dropped.
    pub fn line(&self, message: &Value) {
        if self.broken.load(Ordering::SeqCst) {
            return;
        }
        let text = message.to_string();
        let mut sink = self.sink.lock();
        if writeln!(sink, "{text}").and_then(|_| sink.flush()).is_err() {
            self.broken.store(true, Ordering::SeqCst);
        }
    }

    pub fn event(&self, name: &str, args: Value) {
        self.line(&json!({ "event": name, "args": args }));
    }

    pub fn is_broken(&self) -> bool {
        self.broken.load(Ordering::SeqCst)
    }
}

/// The one answer of a request; may be moved to another thread and answered later.
pub struct Reply {
    id: Value,
    /// None: an internal call whose answer nobody waits for.
    out: Option<Out>,
}

impl Reply {
    pub fn new(id: Value, out: Out) -> Self {
        Self { id, out: Some(out) }
    }

    pub fn discard() -> Self {
        Self { id: Value::Null, out: None }
    }

    pub fn ok(self, result: Value) {
        if let Some(out) = &self.out {
            out.line(&json!({ "id": self.id, "ok": true, "result": result }));
        }
    }

    pub fn err(self, error: impl Display) {
        if let Some(out) = &self.out {
            out.line(&json!({ "id": self.id, "ok": false, "error": error.to_string() }));
        }
    }

    pub fn send(self, result: Result<Value, String>) {
        match result {
            Ok(v) => self.ok(v),
            Err(e) => self.err(e),
        }
    }
}

/// A parsed request line.
#[derive(Debug)]
pub struct Request {
    pub id: Value,
    pub op: String,
    pub args: Value,
}

/// Parses one line; `Err` carries the answer text for a line that is not a request (answered with `id: null`).
pub fn parse(line: &str) -> Result<Request, String> {
    let value: Value = serde_json::from_str(line).map_err(|e| format!("bad request: {e}"))?;
    let Value::Object(mut obj) = value else { return Err("bad request: not an object".into()) };
    let id = obj.remove("id").unwrap_or(Value::Null);
    let op = match obj.remove("op") {
        Some(Value::String(op)) => op,
        _ => return Err("bad request: no op".into()),
    };
    let args = obj.remove("args").unwrap_or(Value::Object(Map::new()));
    Ok(Request { id, op, args })
}

/// Typed access to the `args` object of a request; errors name the field like the TS side's zod messages would.
pub struct Args<'a>(pub &'a Value);

impl<'a> Args<'a> {
    pub fn str(&self, key: &str) -> Result<&'a str, String> {
        self.0.get(key).and_then(Value::as_str).ok_or_else(|| format!("{key}: expected a string"))
    }

    pub fn opt_str(&self, key: &str) -> Option<&'a str> {
        self.0.get(key).and_then(Value::as_str)
    }

    pub fn num(&self, key: &str) -> Result<f64, String> {
        self.0.get(key).and_then(Value::as_f64).ok_or_else(|| format!("{key}: expected a number"))
    }

    pub fn opt_num(&self, key: &str) -> Option<f64> {
        self.0.get(key).and_then(Value::as_f64)
    }

    /// A string map (an env block); keys with non-string values are skipped like Node's spawn does with undefined.
    pub fn str_map(&self, key: &str) -> Result<Vec<(String, String)>, String> {
        match self.0.get(key) {
            Some(Value::Object(map)) => {
                Ok(map.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
            }
            None | Some(Value::Null) => Ok(Vec::new()),
            _ => Err(format!("{key}: expected an object")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl Write for Buf {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            self.0.lock().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn parse_takes_id_op_args() {
        let r = parse(r#"{"id": 3, "op": "pty.has", "args": {"id": "a"}}"#).unwrap();
        assert_eq!(r.id, json!(3));
        assert_eq!(r.op, "pty.has");
        assert_eq!(r.args, json!({"id": "a"}));
        let r = parse(r#"{"id": "x", "op": "ping"}"#).unwrap();
        assert_eq!(r.args, json!({}));
    }

    #[test]
    fn parse_refuses_non_requests() {
        assert!(parse("nope").unwrap_err().starts_with("bad request:"));
        assert_eq!(parse("[1]").unwrap_err(), "bad request: not an object");
        assert_eq!(parse(r#"{"id": 1}"#).unwrap_err(), "bad request: no op");
    }

    #[test]
    fn answers_and_events_are_single_lines() {
        let buf = Buf::default();
        let out = Out::new(Box::new(buf.clone()));
        Reply::new(json!(1), out.clone()).ok(json!({"a": "x\ny"}));
        Reply::new(json!(2), out.clone()).err("boom");
        out.event("pty.data", json!({"id": "a", "data": "\r\n"}));
        let text = String::from_utf8(buf.0.lock().clone()).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(
            lines,
            vec![
                json!({"id": 1, "ok": true, "result": {"a": "x\ny"}}),
                json!({"id": 2, "ok": false, "error": "boom"}),
                json!({"event": "pty.data", "args": {"id": "a", "data": "\r\n"}}),
            ]
        );
    }

    #[test]
    fn a_closed_stdout_is_remembered() {
        struct Closed;
        impl Write for Closed {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let out = Out::new(Box::new(Closed));
        out.event("x", json!(null));
        assert!(out.is_broken());
    }

    #[test]
    fn args_accessors() {
        let v = json!({"s": "a", "n": 2, "env": {"A": "1", "B": null}});
        let a = Args(&v);
        assert_eq!(a.str("s").unwrap(), "a");
        assert_eq!(a.str("n").unwrap_err(), "n: expected a string");
        assert_eq!(a.num("n").unwrap(), 2.0);
        assert_eq!(a.opt_str("missing"), None);
        assert_eq!(a.str_map("env").unwrap(), vec![("A".to_string(), "1".to_string())]);
        assert_eq!(a.str_map("missing").unwrap(), vec![]);
        assert!(a.str_map("s").is_err());
    }
}
