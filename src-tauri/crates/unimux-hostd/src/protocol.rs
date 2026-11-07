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

/// A line that is not a valid request: the answer goes to `id` (the request's own id when it could be read, else null).
#[derive(Debug, PartialEq)]
pub struct BadRequest {
    pub id: Value,
    pub error: String,
}

/// Parses one line. Every line with an id gets its answer under that id, a bad one included (the Node side waits for it).
/// JSON is read like JSON.parse reads what JSON.stringify wrote: an escaped lone surrogate (`"\ud800"`, half an emoji in a
/// `pty.write`) becomes U+FFFD, as Node's UTF-8 write of that string would send it.
pub fn parse(line: &str) -> Result<Request, BadRequest> {
    let value =
        unimux_core::js_json::parse(line).map_err(|e| BadRequest { id: leading_id(line), error: format!("bad request: {e}") })?;
    let Value::Object(mut obj) = value else {
        return Err(BadRequest { id: Value::Null, error: "bad request: not an object".into() });
    };
    let id = obj.remove("id").unwrap_or(Value::Null);
    let op = match obj.remove("op") {
        Some(Value::String(op)) => op,
        _ => return Err(BadRequest { id, error: "bad request: no op".into() }),
    };
    let args = obj.remove("args").unwrap_or(Value::Object(Map::new()));
    Ok(Request { id, op, args })
}

/// The id of a line that is not valid JSON, when it starts the way the Node side writes requests (`{"id":7,...` or
/// `{"id":"x",...`); else null.
fn leading_id(line: &str) -> Value {
    let rest = line.trim_start();
    let Some(rest) = rest.strip_prefix('{') else { return Value::Null };
    let Some(rest) = rest.trim_start().strip_prefix("\"id\"") else { return Value::Null };
    let Some(rest) = rest.trim_start().strip_prefix(':') else { return Value::Null };
    let rest = rest.trim_start();
    let end = if let Some(text) = rest.strip_prefix('"') {
        // A plain string id (no escapes inside).
        match text.find(['"', '\\']) {
            Some(i) if text.as_bytes()[i] == b'"' => i + 2,
            _ => return Value::Null,
        }
    } else {
        rest.find(|c: char| !(c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | 'e' | 'E'))).unwrap_or(rest.len())
    };
    let after = rest[end..].trim_start();
    if end == 0 || !(after.starts_with(',') || after.starts_with('}')) {
        return Value::Null;
    }
    serde_json::from_str(&rest[..end]).unwrap_or(Value::Null)
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
        let e = parse("nope").unwrap_err();
        assert!(e.error.starts_with("bad request:"));
        assert_eq!(e.id, Value::Null);
        assert_eq!(parse("[1]").unwrap_err(), BadRequest { id: Value::Null, error: "bad request: not an object".into() });
    }

    #[test]
    fn a_bad_request_is_answered_under_its_own_id() {
        assert_eq!(parse(r#"{"id": 1}"#).unwrap_err(), BadRequest { id: json!(1), error: "bad request: no op".into() });
        assert_eq!(parse(r#"{"id":6,"op":7}"#).unwrap_err().id, json!(6));
        assert_eq!(parse(r#"{"id":"x","op":null}"#).unwrap_err().id, json!("x"));
        // Not JSON at all, but the id leads the line as the Node side writes it.
        let e = parse(r#"{"id":12,"op":"pty.write","args":{"id":"a","data":"\x"}}"#).unwrap_err();
        assert_eq!(e.id, json!(12));
        assert!(e.error.starts_with("bad request:"), "{}", e.error);
        assert_eq!(parse(r#"{ "id" : "r-1" , "op": oops}"#).unwrap_err().id, json!("r-1"));
        assert_eq!(parse(r#"{"op":"ping","id":3,"#).unwrap_err().id, Value::Null);
        assert_eq!(parse(r#"{"id":12x,"op"}"#).unwrap_err().id, Value::Null);
    }

    #[test]
    fn a_lone_surrogate_from_json_stringify_reads_as_a_replacement_character() {
        // JSON.stringify('\ud800') is "\ud800" (RFC 8259 allows it); serde_json alone refuses it.
        let r = parse(r#"{"id":9,"op":"pty.write","args":{"id":"a","data":"x\ud800y😀"}}"#).unwrap();
        assert_eq!(r.id, json!(9));
        assert_eq!(r.args["data"], json!("x\u{FFFD}y\u{1F600}"));
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
