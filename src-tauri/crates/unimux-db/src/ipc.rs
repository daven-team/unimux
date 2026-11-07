//! The IPC of the database viewer (port of src/main/db/ipc.ts and the history / SQLite registrations): every request is
//! checked against the zod schemas of 1.1.4 before the service sees it, and a refused one gets the fixed answer of its
//! channel (`{ok: false, error: 'invalid'}`, `{ok: false}`, the empty history). Passwords travel renderer -> main only (save,
//! test, prompt answers); nothing sends one back.
//!
//! The schemas are written with a tiny interpreter of the zod subset 1.1.4 uses ([`S`]): strict objects, unions, string
//! lengths in code points (zod 4.6 counts an emoji as 1), zod 4 safe integers, records with checked keys, tuples, and the regexes spelled out by hand
//! (ASCII digits, like JavaScript's `\d`). `tests/db_ipc.rs` runs the vectors of test/golden/db-ipc.jsonl, made by the zod
//! schemas themselves (scripts/goldens-db-ipc.mjs), through them.

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use unimux_core::utf16;
use zeroize::Zeroizing;

use crate::history::DbHistoryStore;
use crate::model::{is_db_session_id, is_guid};
use crate::redis_shared::limits as rl;
use crate::service::{DbService, PasswordChange, TestPassword};
use crate::sql::limits;
use crate::sqlite_files::create_sqlite_file;

/// A refinement of a whole record (`.refine((r) => ...)`).
pub type RecordCheck = fn(&Map<String, Value>) -> bool;

/// One zod schema.
pub enum S {
    /// `z.string().min(min).max(max)` (code points, as zod 4.6 counts them) with an optional refinement.
    Str {
        min: usize,
        max: usize,
        check: Option<fn(&str) -> bool>,
    },
    /// `z.number().int().min(min).max(max)` (zod 4: safe integers only).
    Int {
        min: f64,
        max: f64,
    },
    Bool,
    Null,
    /// `z.literal(v)`.
    Lit(Value),
    /// `z.enum([...])`.
    Enum(&'static [&'static str]),
    /// `z.object({...}).strict()`: (key, schema, optional).
    Obj(Vec<(&'static str, S, bool)>),
    /// `z.union([...])` / `z.discriminatedUnion(...)`.
    Union(Vec<S>),
    Nullable(Box<S>),
    /// `z.array(item).min(min).max(max)`.
    Arr {
        item: Box<S>,
        min: usize,
        max: usize,
    },
    /// `z.record(key, value)` with a refinement on the whole record.
    Record {
        key: Box<S>,
        value: Box<S>,
        check: Option<RecordCheck>,
    },
    /// `z.tuple([...])`.
    Tuple(Vec<S>),
    /// Any schema with a refinement on the value.
    Refine(Box<S>, fn(&Value) -> bool),
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

impl S {
    pub fn check(&self, v: &Value) -> bool {
        match self {
            S::Str { min, max, check } => match v.as_str() {
                Some(s) => {
                    // zod 4.6 counts code points for min / max (an emoji is 1), not UTF-16 units.
                    let n = s.chars().count();
                    n >= *min && n <= *max && check.is_none_or(|f| f(s))
                }
                None => false,
            },
            S::Int { min, max } => match v.as_f64() {
                Some(n) => n.fract() == 0.0 && n.abs() <= MAX_SAFE && n >= *min && n <= *max,
                None => false,
            },
            S::Bool => v.is_boolean(),
            S::Null => v.is_null(),
            S::Lit(l) => v == l,
            S::Enum(names) => v.as_str().is_some_and(|s| names.contains(&s)),
            S::Obj(fields) => {
                let Some(o) = v.as_object() else { return false };
                o.keys().all(|k| fields.iter().any(|(f, _, _)| f == k))
                    && fields.iter().all(|(f, s, optional)| match o.get(*f) {
                        Some(x) => s.check(x),
                        None => *optional,
                    })
            }
            S::Union(options) => options.iter().any(|s| s.check(v)),
            S::Nullable(s) => v.is_null() || s.check(v),
            S::Arr { item, min, max } => match v.as_array() {
                Some(a) => a.len() >= *min && a.len() <= *max && a.iter().all(|x| item.check(x)),
                None => false,
            },
            S::Record { key, value, check } => match v.as_object() {
                Some(o) => {
                    o.iter().all(|(k, x)| key.check(&Value::String(k.clone())) && value.check(x)) && check.is_none_or(|f| f(o))
                }
                None => false,
            },
            S::Tuple(items) => match v.as_array() {
                Some(a) => a.len() == items.len() && a.iter().zip(items).all(|(x, s)| s.check(x)),
                None => false,
            },
            S::Refine(s, f) => s.check(v) && f(v),
        }
    }
}

// ── building blocks ─────────────────────────────────────────────────────────

fn opt(key: &'static str, s: S) -> (&'static str, S, bool) {
    (key, s, true)
}
fn req(key: &'static str, s: S) -> (&'static str, S, bool) {
    (key, s, false)
}
fn obj(fields: Vec<(&'static str, S, bool)>) -> S {
    S::Obj(fields)
}
fn lit(v: &str) -> S {
    S::Lit(json!(v))
}
fn int(min: f64, max: f64) -> S {
    S::Int { min, max }
}
fn any_int() -> S {
    int(-MAX_SAFE, MAX_SAFE)
}
fn text(max: usize) -> S {
    S::Str { min: 0, max, check: None }
}
fn regex(max: usize, check: fn(&str) -> bool) -> S {
    S::Str { min: 0, max, check: Some(check) }
}
fn arr(item: S, min: usize, max: usize) -> S {
    S::Arr { item: Box::new(item), min, max }
}
fn uuid() -> S {
    regex(usize::MAX, is_guid)
}
fn session_id() -> S {
    regex(usize::MAX, is_db_session_id)
}
/// `name`: an identifier without NUL.
fn name() -> S {
    S::Str { min: 1, max: limits::IDENTIFIER, check: Some(|s| !s.contains('\0')) }
}
fn port() -> S {
    int(1.0, 65535.0)
}
fn value() -> S {
    S::Nullable(Box::new(text(limits::FULL_VALUE_CHARS)))
}
fn key_values() -> S {
    S::Record {
        key: Box::new(name()),
        value: Box::new(text(limits::FULL_VALUE_CHARS)),
        check: Some(|r| (1..=32).contains(&r.len())),
    }
}
fn values() -> S {
    S::Record { key: Box::new(name()), value: Box::new(value()), check: Some(|r| r.len() <= 1600) }
}

/// `^\d{a,b}$` with ASCII digits.
fn digits(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

pub fn connection_input() -> S {
    obj(vec![
        opt("id", uuid()),
        req("kind", S::Enum(&["postgres", "mysql", "redis", "sqlite"])),
        req("name", text(limits::NAME)),
        opt("color", text(16)),
        opt("group", text(limits::GROUP)),
        req("host", text(limits::HOST)),
        // A SQLite connection has no port: 0 (the normalizer refuses 0 for every other kind).
        req("port", int(0.0, 65535.0)),
        req("user", text(limits::USER)),
        opt("database", text(limits::DATABASE)),
        opt("dbIndex", int(0.0, 10_000.0)),
        req("tls", S::Enum(&["disable", "prefer", "require", "verify-full"])),
        opt("caPath", text(limits::CA_PATH)),
        req(
            "ssh",
            S::Nullable(Box::new(obj(vec![req("hostId", uuid()), req("dbHost", text(limits::HOST)), req("dbPort", port())]))),
        ),
        req("readOnly", S::Bool),
        opt("statementTimeoutMs", int(1.0, limits::STATEMENT_TIMEOUT_MAX_MS as f64)),
        opt("path", text(limits::CA_PATH)),
    ])
}

fn password() -> S {
    S::Str { min: 1, max: limits::PASSWORD, check: None }
}

pub fn password_change() -> S {
    S::Union(vec![
        obj(vec![req("keep", S::Lit(json!(true)))]),
        obj(vec![req("set", password())]),
        obj(vec![req("clear", S::Lit(json!(true)))]),
    ])
}

pub fn test_password() -> S {
    S::Union(vec![obj(vec![req("set", password())]), obj(vec![req("saved", uuid())]), S::Null])
}

pub fn answer() -> S {
    S::Union(vec![
        obj(vec![req("sessionId", session_id()), req("promptId", uuid()), req("cancel", S::Lit(json!(true)))]),
        obj(vec![
            req("sessionId", session_id()),
            req("promptId", uuid()),
            req("values", arr(text(limits::PASSWORD), 0, 10)),
            opt("remember", S::Bool),
        ]),
        obj(vec![req("sessionId", session_id()), req("promptId", uuid()), req("hostKey", S::Enum(&["once", "save", "replace"]))]),
    ])
}

/// The options of `db:connect`: `{database?}` without NUL, or nothing (`.optional().nullable()`).
pub fn connect_options() -> S {
    S::Nullable(Box::new(obj(vec![opt(
        "database",
        S::Str { min: 0, max: limits::DATABASE, check: Some(|d| !d.contains('\0')) },
    )])))
}

fn sort() -> S {
    arr(obj(vec![req("column", name()), req("desc", S::Bool)]), 0, limits::SORT_COLUMNS)
}

fn edit_request() -> S {
    let edit = S::Union(vec![
        obj(vec![req("op", lit("update")), req("key", key_values()), req("set", values()), opt("original", values())]),
        obj(vec![req("op", lit("insert")), req("values", values())]),
        obj(vec![req("op", lit("delete")), req("key", key_values()), opt("original", values())]),
    ]);
    obj(vec![req("schema", name()), req("table", name()), req("edits", arr(edit, 1, limits::EDITS))])
}

const OBJECT_KINDS: &[&str] =
    &["table", "partitioned", "view", "matview", "foreign", "sequence", "function", "procedure", "trigger", "event", "index"];

/// `op` of `db:pg`.
pub fn pg_op() -> S {
    let row_cap = || int(1.0, limits::ROW_CAP_MAX as f64);
    S::Union(vec![
        obj(vec![req("op", lit("databases"))]),
        obj(vec![req("op", lit("schemas"))]),
        obj(vec![req("op", lit("objects")), req("schema", name())]),
        obj(vec![req("op", lit("tableInfo")), req("schema", name()), req("name", name())]),
        obj(vec![
            req("op", lit("ddl")),
            req("schema", name()),
            req("name", name()),
            req("kind", S::Enum(OBJECT_KINDS)),
            opt("args", text(8192)),
        ]),
        obj(vec![
            req("op", lit("tablePage")),
            req(
                "req",
                obj(vec![
                    req("queryId", uuid()),
                    req("schema", name()),
                    req("table", name()),
                    req("limit", row_cap()),
                    opt("offset", int(0.0, MAX_SAFE)),
                    opt("after", arr(text(limits::FULL_VALUE_CHARS), 0, 32)),
                    opt("sort", sort()),
                    opt("filter", text(limits::FILTER)),
                ]),
            ),
        ]),
        obj(vec![
            req("op", lit("query")),
            req(
                "req",
                obj(vec![
                    req("queryId", uuid()),
                    req("sql", text(limits::SQL)),
                    opt("rowCap", row_cap()),
                    opt("statementTimeoutMs", S::Nullable(Box::new(int(0.0, limits::STATEMENT_TIMEOUT_MAX_MS as f64)))),
                    opt("readWrite", S::Bool),
                    opt("continueOnError", S::Bool),
                ]),
            ),
        ]),
        obj(vec![req("op", lit("fetchMore")), req("queryId", uuid()), req("count", row_cap())]),
        obj(vec![req("op", lit("closeResult")), req("queryId", uuid())]),
        obj(vec![req("op", lit("cancel"))]),
        obj(vec![req("op", lit("transaction")), req("action", S::Enum(&["begin", "commit", "rollback"]))]),
        obj(vec![req("op", lit("previewEdits")), req("req", edit_request())]),
        obj(vec![req("op", lit("applyEdits")), req("req", edit_request())]),
        obj(vec![
            req("op", lit("cellValue")),
            req("req", obj(vec![req("schema", name()), req("table", name()), req("key", key_values()), req("column", name())])),
        ]),
    ])
}

// ── Redis ───────────────────────────────────────────────────────────────────

/// `dataBytes`: UTF-8 length of text, decoded length of base64.
fn b64_bytes(b64: &str) -> usize {
    let n = utf16::len(b64);
    let pad = if b64.ends_with("==") {
        2
    } else if b64.ends_with('=') {
        1
    } else {
        0
    };
    (n * 3 / 4).saturating_sub(pad)
}

fn is_b64(s: &str) -> bool {
    let body = s.trim_end_matches('=');
    s.len() - body.len() <= 2 && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// `data(maxBytes)`: UTF-8 text or `{b64}`, limited in bytes.
fn data(max_bytes: usize) -> S {
    S::Union(vec![
        S::Refine(
            Box::new(text(max_bytes)),
            match max_bytes {
                rl::NAME_BYTES => |v| v.as_str().is_some_and(|s| s.len() <= rl::NAME_BYTES),
                _ => |v| v.as_str().is_some_and(|s| s.len() <= rl::WRITE_BYTES),
            },
        ),
        obj(vec![req("b64", regex(max_bytes.div_ceil(3) * 4 + 4, is_b64))]),
    ])
}

/// The bytes of every value in a request together (`totalBytes`).
pub fn total_bytes(v: &Value) -> usize {
    match v {
        Value::String(s) => s.len(),
        Value::Array(a) => a.iter().map(total_bytes).sum(),
        Value::Object(o) => match o.get("b64") {
            Some(Value::String(b)) if o.len() == 1 => b64_bytes(b),
            _ => o.values().map(total_bytes).sum(),
        },
        _ => 0,
    }
}

fn r_key() -> S {
    data(rl::NAME_BYTES)
}
fn r_value() -> S {
    data(rl::WRITE_BYTES)
}
fn pattern() -> S {
    text(rl::NAME_BYTES)
}
fn cursor() -> S {
    regex(usize::MAX, |s| digits(s, 1, 20))
}
fn count() -> S {
    int(1.0, rl::PAGE_ITEMS as f64)
}
/// `^(?:\d{1,20}-\d{1,20}|\d{1,20}|\*|\d{1,20}-\*)$`.
fn is_stream_id(s: &str) -> bool {
    if s == "*" {
        return true;
    }
    match s.split_once('-') {
        None => digits(s, 1, 20),
        Some((a, b)) => digits(a, 1, 20) && (b == "*" || digits(b, 1, 20)),
    }
}
/// `^\(?(?:\d{1,20}(?:-\d{1,20})?)$|^[-+]$`.
fn is_range_id(s: &str) -> bool {
    if s == "-" || s == "+" {
        return true;
    }
    let s = s.strip_prefix('(').unwrap_or(s);
    match s.split_once('-') {
        None => digits(s, 1, 20),
        Some((a, b)) => digits(a, 1, 20) && digits(b, 1, 20),
    }
}
/// `^[+-]?(?:inf|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$` with the `i` flag.
fn is_score(s: &str) -> bool {
    let s = s.strip_prefix(['+', '-']).unwrap_or(s);
    if s.eq_ignore_ascii_case("inf") {
        return true;
    }
    let b = s.as_bytes();
    let mut i = 0;
    let int_digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    i += int_digits;
    let mut frac_digits = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        frac_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        i += frac_digits;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if exp == 0 {
            return false;
        }
        i += exp;
    }
    i == b.len()
}
fn stream_id() -> S {
    regex(usize::MAX, is_stream_id)
}
fn range_id() -> S {
    regex(usize::MAX, is_range_id)
}
fn score() -> S {
    regex(usize::MAX, is_score)
}
fn type_name() -> S {
    S::Str { min: 1, max: 64, check: Some(|s| s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) }
}
fn ttl() -> S {
    int(1.0, MAX_SAFE)
}
fn items(s: S) -> S {
    arr(s, 1, rl::WRITE_ITEMS)
}
fn pairs(a: S, b: S) -> S {
    items(S::Tuple(vec![a, b]))
}

fn new_value() -> S {
    S::Union(vec![
        obj(vec![req("type", lit("string")), req("value", r_value())]),
        obj(vec![req("type", lit("hash")), req("entries", pairs(r_key(), r_value()))]),
        obj(vec![req("type", lit("list")), req("items", items(r_value()))]),
        obj(vec![req("type", lit("set")), req("members", items(r_key()))]),
        obj(vec![req("type", lit("zset")), req("entries", pairs(r_key(), score()))]),
        obj(vec![req("type", lit("stream")), opt("id", stream_id()), req("fields", pairs(r_key(), r_value()))]),
    ])
}

fn write() -> S {
    let b = || S::Bool;
    S::Union(vec![
        obj(vec![
            req("op", lit("set")),
            req("key", r_key()),
            req("value", r_value()),
            opt("keepTtl", b()),
            opt("ttlMs", ttl()),
            opt("existing", b()),
        ]),
        obj(vec![
            req("op", lit("hset")),
            req("key", r_key()),
            req("field", r_key()),
            req("value", r_value()),
            opt("onlyNew", b()),
            opt("existing", b()),
        ]),
        obj(vec![req("op", lit("hdel")), req("key", r_key()), req("fields", items(r_key()))]),
        obj(vec![req("op", lit("lpush")), req("key", r_key()), req("items", items(r_value())), opt("existing", b())]),
        obj(vec![req("op", lit("rpush")), req("key", r_key()), req("items", items(r_value())), opt("existing", b())]),
        obj(vec![
            req("op", lit("lset")),
            req("key", r_key()),
            req("index", any_int()),
            req("value", r_value()),
            opt("expected", r_value()),
        ]),
        obj(vec![req("op", lit("lrem")), req("key", r_key()), req("count", any_int()), req("value", r_value())]),
        obj(vec![req("op", lit("ldel")), req("key", r_key()), req("index", any_int()), req("expected", r_value())]),
        obj(vec![req("op", lit("sadd")), req("key", r_key()), req("members", items(r_key())), opt("existing", b())]),
        obj(vec![req("op", lit("srem")), req("key", r_key()), req("members", items(r_key()))]),
        obj(vec![
            req("op", lit("zadd")),
            req("key", r_key()),
            req("entries", pairs(r_key(), score())),
            opt("mode", S::Enum(&["nx", "xx"])),
            opt("existing", b()),
        ]),
        obj(vec![req("op", lit("zrem")), req("key", r_key()), req("members", items(r_key()))]),
        obj(vec![
            req("op", lit("zincrby")),
            req("key", r_key()),
            req("member", r_key()),
            req("by", score()),
            opt("existing", b()),
        ]),
        obj(vec![
            req("op", lit("xadd")),
            req("key", r_key()),
            opt("id", stream_id()),
            req("fields", pairs(r_key(), r_value())),
            opt("maxLen", int(0.0, MAX_SAFE)),
            opt("approx", b()),
            opt("existing", b()),
        ]),
        obj(vec![req("op", lit("xdel")), req("key", r_key()), req("ids", items(stream_id()))]),
        obj(vec![
            req("op", lit("xtrim")),
            req("key", r_key()),
            req("strategy", S::Enum(&["maxlen", "minid"])),
            req(
                "threshold",
                regex(usize::MAX, |s| match s.split_once('-') {
                    None => digits(s, 1, 20),
                    Some((a, b)) => digits(a, 1, 20) && digits(b, 1, 20),
                }),
            ),
            opt("approx", b()),
        ]),
        obj(vec![req("op", lit("rename")), req("key", r_key()), req("newKey", r_key()), opt("overwrite", b())]),
        obj(vec![req("op", lit("expire")), req("key", r_key()), req("ttlMs", ttl())]),
        obj(vec![req("op", lit("persist")), req("key", r_key())]),
        obj(vec![req("op", lit("delete")), req("keys", items(r_key()))]),
        obj(vec![req("op", lit("create")), req("key", r_key()), req("value", new_value()), opt("ttlMs", ttl())]),
    ])
}

fn read_req() -> S {
    S::Union(vec![
        obj(vec![
            req("type", lit("string")),
            req("key", r_key()),
            opt("offset", int(0.0, MAX_SAFE)),
            opt("maxBytes", int(1.0, rl::STRING_BYTES_MAX as f64)),
        ]),
        obj(vec![
            req("type", lit("hash")),
            req("key", r_key()),
            req("cursor", cursor()),
            req("count", count()),
            opt("match", pattern()),
        ]),
        obj(vec![req("type", lit("list")), req("key", r_key()), req("start", int(0.0, MAX_SAFE)), req("count", count())]),
        obj(vec![
            req("type", lit("set")),
            req("key", r_key()),
            req("cursor", cursor()),
            req("count", count()),
            opt("match", pattern()),
        ]),
        obj(vec![
            req("type", lit("zset")),
            req("key", r_key()),
            req("start", int(0.0, MAX_SAFE)),
            req("count", count()),
            opt("rev", S::Bool),
        ]),
        obj(vec![
            req("type", lit("zset")),
            req("key", r_key()),
            req("cursor", cursor()),
            req("count", count()),
            opt("match", pattern()),
        ]),
        obj(vec![
            req("type", lit("stream")),
            req("key", r_key()),
            req("start", range_id()),
            req("end", range_id()),
            req("count", count()),
            opt("rev", S::Bool),
        ]),
    ])
}

fn item_req() -> S {
    S::Union(vec![
        obj(vec![req("type", lit("hash")), req("key", r_key()), req("field", r_key())]),
        obj(vec![req("type", lit("list")), req("key", r_key()), req("index", any_int())]),
        obj(vec![
            req("type", lit("stream")),
            req("key", r_key()),
            req("id", regex(usize::MAX, |s| s.split_once('-').is_some_and(|(a, b)| digits(a, 1, 20) && digits(b, 1, 20)))),
            req("field", r_key()),
        ]),
    ])
}

/// `op` of `db:redis`.
pub fn redis_op() -> S {
    let channels = || arr(r_key(), 0, rl::PUBSUB_CHANNELS);
    S::Union(vec![
        obj(vec![req("kind", lit("databases"))]),
        obj(vec![req("kind", lit("select")), req("index", int(0.0, 10_000.0))]),
        obj(vec![
            req("kind", lit("scan")),
            req(
                "req",
                obj(vec![
                    req("cursor", cursor()),
                    opt("match", pattern()),
                    opt("count", int(1.0, rl::SCAN_COUNT_MAX as f64)),
                    opt("type", type_name()),
                    opt("limit", int(1.0, rl::SCAN_KEYS as f64)),
                    opt("details", S::Bool),
                ]),
            ),
        ]),
        obj(vec![req("kind", lit("keyInfo")), req("keys", arr(r_key(), 0, rl::INFO_KEYS))]),
        obj(vec![req("kind", lit("read")), req("req", read_req())]),
        obj(vec![req("kind", lit("readItem")), req("req", item_req())]),
        obj(vec![req("kind", lit("write")), req("write", write())]),
        obj(vec![req("kind", lit("countPattern")), req("match", pattern()), opt("type", type_name())]),
        obj(vec![req("kind", lit("deletePattern")), req("token", uuid())]),
        obj(vec![req("kind", lit("cancel"))]),
        obj(vec![
            req("kind", lit("command")),
            req(
                "req",
                obj(vec![
                    req(
                        "argv",
                        S::Refine(Box::new(arr(r_value(), 1, rl::ARGV)), |a| {
                            a[0].as_str().is_some_and(|s| (1..=64).contains(&utf16::len(s)))
                        }),
                    ),
                    opt("readWrite", S::Bool),
                    opt("confirmed", S::Bool),
                    opt("timeoutMs", int(1.0, rl::CONSOLE_TIMEOUT_MAX_MS as f64)),
                ]),
            ),
        ]),
        obj(vec![
            req("kind", lit("info")),
            opt(
                "section",
                regex(usize::MAX, |s| (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphabetic() || b == b'_')),
            ),
        ]),
        obj(vec![req("kind", lit("slowlog")), opt("count", int(1.0, rl::SLOWLOG_MAX as f64))]),
        obj(vec![req("kind", lit("clients"))]),
        obj(vec![req("kind", lit("subscribe")), opt("channels", channels()), opt("patterns", channels())]),
        obj(vec![req("kind", lit("unsubscribe")), opt("channels", channels()), opt("patterns", channels()), opt("all", S::Bool)]),
        obj(vec![req("kind", lit("pubsubState"))]),
        obj(vec![req("kind", lit("publish")), req("channel", r_key()), req("message", r_value()), opt("readWrite", S::Bool)]),
    ])
}

/// `z.array(sessionId).max(1000)` of `db:pin`.
pub fn pins() -> S {
    arr(session_id(), 0, 1000)
}

/// The schemas by name (the vectors of tests/db_ipc.rs name them like scripts/goldens-db-ipc.mjs).
pub fn schema(name: &str) -> Option<S> {
    Some(match name {
        "connectionInput" => connection_input(),
        "passwordChange" => password_change(),
        "testPassword" => test_password(),
        "answer" => answer(),
        "connectOptions" => connect_options(),
        "op" => pg_op(),
        "redisOp" => redis_op(),
        "pins" => pins(),
        "uuid" => uuid(),
        "sessionId" => session_id(),
        _ => return None,
    })
}

/// The fixed answer of a refused request.
pub fn invalid() -> Value {
    json!({ "ok": false, "error": "invalid" })
}

/// `db:redis`: the schema and the byte budget of the whole request (REDIS_LIMITS.writeBytes).
pub fn valid_redis_op(op: &Value) -> bool {
    redis_op().check(op) && total_bytes(op) <= rl::WRITE_BYTES
}

// ── handlers (createDbHandlers, registerDbHistoryIpc, registerSqliteFileIpc) ──

/// `db:connections:save`.
pub fn save(svc: &DbService, input: &Value, change: &Value) -> Value {
    if !connection_input().check(input) || !password_change().check(change) {
        return invalid();
    }
    let change = if let Some(p) = change.get("set").and_then(Value::as_str) {
        PasswordChange::Set(Zeroizing::new(p.to_string()))
    } else if change.get("clear").is_some() {
        PasswordChange::Clear
    } else {
        PasswordChange::Keep
    };
    svc.save_connection(input, &change)
}

/// `db:connections:delete`.
pub fn remove(svc: &DbService, id: &Value) -> Value {
    match id.as_str().filter(|id| is_guid(id)) {
        Some(id) => svc.delete_connection(id),
        None => json!({ "ok": false }),
    }
}

/// `db:connections:duplicate`.
pub fn duplicate(svc: &DbService, id: &Value) -> Value {
    match id.as_str().filter(|id| is_guid(id)) {
        Some(id) => svc.duplicate_connection(id),
        None => json!({ "ok": false }),
    }
}

/// `db:connections:test`: a test never names a saved connection's id (it uses `{saved}` for its password).
pub fn test(svc: &DbService, input: &Value, password: &Value) -> BoxFuture<'static, Value> {
    if !connection_input().check(input) || !test_password().check(password) || input.get("id").is_some() {
        return Box::pin(async { invalid() });
    }
    let password = if let Some(p) = password.get("set").and_then(Value::as_str) {
        TestPassword::Set(Zeroizing::new(p.to_string()))
    } else if let Some(id) = password.get("saved").and_then(Value::as_str) {
        TestPassword::Saved(id.to_string())
    } else {
        TestPassword::None
    };
    svc.test_connection(input, &password)
}

/// `db:connect`: an empty database is MySQL without a default database (the service ignores it for other kinds).
pub fn connect(svc: &DbService, connection_id: &Value, opts: &Value) -> Value {
    let Some(id) = connection_id.as_str().filter(|id| is_guid(id)) else { return invalid() };
    if !connect_options().check(opts) {
        return invalid();
    }
    match svc.connect(id, opts.get("database").and_then(Value::as_str)) {
        Ok(session_id) => json!({ "ok": true, "sessionId": session_id }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

/// `db:disconnect`.
pub fn disconnect(svc: &DbService, id: &Value) -> Value {
    match id.as_str().filter(|id| is_db_session_id(id)) {
        Some(id) => svc.disconnect(id),
        None => json!({ "ok": false }),
    }
}

/// `db:prompt:answer`.
pub fn answer_prompt(svc: &DbService, raw: &Value) -> Value {
    json!({ "ok": answer().check(raw) && svc.answer(raw) })
}

/// `db:pg`. `window`: the asking window, whose port gets the results.
pub fn pg(svc: &DbService, id: &Value, raw: &Value, window: Option<String>) -> BoxFuture<'static, Value> {
    match id.as_str().filter(|id| is_db_session_id(id)) {
        Some(id) if pg_op().check(raw) => svc.op(id, raw.clone(), window),
        _ => Box::pin(async { invalid() }),
    }
}

/// `db:redis`.
pub fn redis(svc: &DbService, id: &Value, raw: &Value, window: Option<String>) -> BoxFuture<'static, Value> {
    match id.as_str().filter(|id| is_db_session_id(id)) {
        Some(id) if valid_redis_op(raw) => svc.op(id, json!({ "op": "redis", "req": raw }), window),
        _ => Box::pin(async { invalid() }),
    }
}

/// `db:pin`: a bad list is ignored.
pub fn pin(svc: &DbService, ids: &Value, window: &str) {
    if pins().check(ids) {
        let ids: Vec<String> = ids.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
        svc.pin(&ids, window);
    }
}

/// `db:history:star`.
pub fn history_star(store: &DbHistoryStore, connection_id: &Value, id: &Value, star: &Value) -> Value {
    json!({ "ok": connection_id.as_str().is_some_and(is_guid) && store.star(connection_id, id, star) })
}

/// `db:history:clear`.
pub fn history_clear(store: &DbHistoryStore, connection_id: &Value, stars: &Value) -> Value {
    json!({ "ok": store.clear(connection_id, stars) })
}

/// `db:history:enabled`.
pub fn history_enabled(store: &DbHistoryStore, enabled: &Value) -> Value {
    json!({ "ok": store.set_enabled(enabled) })
}

/// `db:sqlite:create` with a typed path (it must not exist yet); no path asks the save dialog (the app's).
pub fn sqlite_create_at(path: &Value) -> Value {
    match path.as_str() {
        Some(p) => create_sqlite_file(p, false).to_json(),
        None => invalid(),
    }
}

/// `db:export`: the file name the renderer suggests (no folder) and the text; None when refused.
pub fn export_request<'a>(name: &'a Value, text: &'a Value) -> Option<(&'a str, &'a str)> {
    let name = name.as_str()?;
    let text = text.as_str()?;
    let ok_name = !name.is_empty() && utf16::len(name) <= 200 && !name.contains(['\\', '/', '\0']);
    (ok_name && utf16::len(text) <= 512 * 1024 * 1024).then_some((name, text))
}

/// `basename(name)` of the export into MC_DB_EXPORT_DIR, for a name `export_request` accepted (no separators): on
/// Windows Node's path.win32.basename drops a leading drive (`C:evil.csv` is `evil.csv`), which Path::join would otherwise
/// take as a new root and write outside the folder.
pub fn export_file_name(name: &str, windows: bool) -> &str {
    let b = name.as_bytes();
    if windows && b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' { &name[2..] } else { name }
}

/// The extension filter of the export dialog: `name.split('.').pop()`, upper-cased as its name.
pub fn export_extension(name: &str) -> String {
    name.rsplit('.').next().unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_file_names_are_node_basenames() {
        assert_eq!(export_file_name("C:evil.csv", true), "evil.csv");
        assert_eq!(export_file_name("z:a.json", true), "a.json");
        assert_eq!(export_file_name("C:", true), "");
        assert_eq!(export_file_name("C:evil.csv", false), "C:evil.csv");
        assert_eq!(export_file_name("1:a.csv", true), "1:a.csv");
        assert_eq!(export_file_name("wynik ż.csv", true), "wynik ż.csv");
        assert_eq!(export_file_name("ż", true), "ż");
        let dir = std::path::Path::new(if cfg!(windows) { r"D:\exports" } else { "/exports" });
        let joined = dir.join(export_file_name("C:evil.csv", cfg!(windows)));
        assert!(joined.starts_with(dir), "{joined:?}");
    }

    #[test]
    fn hand_written_patterns() {
        for s in ["1", "+1.5", "-.5", "1e5", "1.E-3", "inf", "-INF", "+Inf", "007"] {
            assert!(is_score(s), "{s}");
        }
        for s in ["", ".", "e5", "1e", "infe5", "1.2.3", "--1", "nan", "1 "] {
            assert!(!is_score(s), "{s}");
        }
        for s in ["*", "1", "1-2", "1-*", "12345678901234567890-1"] {
            assert!(is_stream_id(s), "{s}");
        }
        for s in ["", "-", "1-", "*-1", "a", "123456789012345678901"] {
            assert!(!is_stream_id(s), "{s}");
        }
        for s in ["-", "+", "(1", "(1-2", "5"] {
            assert!(is_range_id(s), "{s}");
        }
        for s in ["(", "((1", "1-*", "(-", "*"] {
            assert!(!is_range_id(s), "{s}");
        }
        assert!(is_b64("QUJD") && is_b64("QQ==") && is_b64("") && !is_b64("Q===") && !is_b64("Q-"));
        assert_eq!(b64_bytes("QUJD"), 3);
        assert_eq!(b64_bytes("QQ=="), 1);
        assert_eq!(total_bytes(&json!({ "kind": "write", "write": { "key": { "b64": "QUJD" }, "value": "żó" } })), 5 + 3 + 4);
    }
}
