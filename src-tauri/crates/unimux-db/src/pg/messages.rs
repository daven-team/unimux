//! D5: the DB port messages of a Postgres session (`DbPortMessage` in src/shared/db.ts as src/dbhost/pgSession.ts sends
//! them), written the way `JSON.stringify` writes the 1.1.4 objects (same key order). Cells and server texts may end in a
//! lone high surrogate after their UTF-16 cut, so the messages are written by hand ([`super::port`], `wire::value`)
//! instead of through `serde_json::Value`; D12 routes the raw JSON.

use std::fmt::Write as _;

use serde_json::{Map, Value, json};
use unimux_core::js_json::write_string;

use super::error::is_server_code;
use super::port::{notice_json, server_error_json};
use crate::wire::pg::PgServerError;
use crate::wire::value::{DbValue, SERVER_TEXT_CHARS, utf16_head};

/// `DbColumn` of a Postgres result: `{name, typeOid, typeName, kind, tableOid?, columnNumber?}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgColumn {
    pub name: String,
    pub type_oid: u32,
    pub type_name: String,
    pub kind: &'static str,
    /// The table the column comes from (`tableID` when it is not 0).
    pub table_oid: Option<u32>,
    /// Its attribute number (only with a table, and when it is not 0).
    pub column_number: Option<i16>,
}

/// One DB port message of a Postgres session.
#[derive(Debug, Clone, PartialEq)]
pub enum PgPortMessage {
    Statement {
        query_id: String,
        index: usize,
        start: usize,
        end: usize,
    },
    Columns {
        query_id: String,
        index: usize,
        columns: Vec<PgColumn>,
    },
    Rows {
        query_id: String,
        index: usize,
        rows: Vec<Vec<DbValue>>,
    },
    StatementEnd {
        query_id: String,
        index: usize,
        command: String,
        row_count: Option<u64>,
        rows: u64,
        has_more: bool,
        truncated: bool,
        time_ms: u64,
    },
    StatementError {
        query_id: String,
        index: usize,
        error: &'static str,
        /// Written only when it is the server's (a 5-character SQLSTATE).
        server: Option<PgServerError>,
        time_ms: u64,
    },
    QueryEnd {
        query_id: String,
        ok: bool,
        cancelled: bool,
        time_ms: u64,
        tx: &'static str,
    },
    ResultClosed {
        query_id: String,
        index: usize,
    },
    /// `{t:'notice', queryId, message, severity?}` (a notice without a message is never sent).
    Notice {
        query_id: String,
        notice: PgServerError,
    },
}

fn head(out: &mut String, t: &str, query_id: &str) {
    out.push_str("{\"t\":\"");
    out.push_str(t);
    out.push_str("\",\"queryId\":");
    write_string(out, query_id);
}

impl PgPortMessage {
    /// The queryId the message belongs to (D12 routes by it).
    pub fn query_id(&self) -> &str {
        match self {
            PgPortMessage::Statement { query_id, .. }
            | PgPortMessage::Columns { query_id, .. }
            | PgPortMessage::Rows { query_id, .. }
            | PgPortMessage::StatementEnd { query_id, .. }
            | PgPortMessage::StatementError { query_id, .. }
            | PgPortMessage::QueryEnd { query_id, .. }
            | PgPortMessage::ResultClosed { query_id, .. }
            | PgPortMessage::Notice { query_id, .. } => query_id,
        }
    }

    /// `JSON.stringify(message)`.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        match self {
            PgPortMessage::Statement { query_id, index, start, end } => {
                head(&mut out, "statement", query_id);
                let _ = write!(out, ",\"index\":{index},\"start\":{start},\"end\":{end}}}");
            }
            PgPortMessage::Columns { query_id, index, columns } => {
                head(&mut out, "columns", query_id);
                let _ = write!(out, ",\"index\":{index},\"columns\":[");
                for (i, c) in columns.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str("{\"name\":");
                    write_string(&mut out, &c.name);
                    let _ = write!(out, ",\"typeOid\":{},\"typeName\":", c.type_oid);
                    write_string(&mut out, &c.type_name);
                    out.push_str(",\"kind\":");
                    write_string(&mut out, c.kind);
                    if let Some(t) = c.table_oid {
                        let _ = write!(out, ",\"tableOid\":{t}");
                    }
                    if let Some(n) = c.column_number {
                        let _ = write!(out, ",\"columnNumber\":{n}");
                    }
                    out.push('}');
                }
                out.push_str("]}");
            }
            PgPortMessage::Rows { query_id, index, rows } => {
                head(&mut out, "rows", query_id);
                let _ = write!(out, ",\"index\":{index},\"rows\":[");
                for (i, row) in rows.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push('[');
                    for (j, v) in row.iter().enumerate() {
                        if j > 0 {
                            out.push(',');
                        }
                        v.write_json(&mut out);
                    }
                    out.push(']');
                }
                out.push_str("]}");
            }
            PgPortMessage::StatementEnd { query_id, index, command, row_count, rows, has_more, truncated, time_ms } => {
                head(&mut out, "statementEnd", query_id);
                let _ = write!(out, ",\"index\":{index},\"command\":");
                write_string(&mut out, command);
                match row_count {
                    Some(n) => {
                        let _ = write!(out, ",\"rowCount\":{n}");
                    }
                    None => out.push_str(",\"rowCount\":null"),
                }
                let _ = write!(out, ",\"rows\":{rows},\"hasMore\":{has_more}");
                if *truncated {
                    out.push_str(",\"truncated\":true");
                }
                let _ = write!(out, ",\"timeMs\":{time_ms}}}");
            }
            PgPortMessage::StatementError { query_id, index, error, server, time_ms } => {
                head(&mut out, "statementError", query_id);
                let _ = write!(out, ",\"index\":{index},\"error\":");
                write_string(&mut out, error);
                if let Some(s) = server.as_ref().and_then(server_error_json) {
                    out.push_str(",\"server\":");
                    out.push_str(&s);
                }
                let _ = write!(out, ",\"timeMs\":{time_ms}}}");
            }
            PgPortMessage::QueryEnd { query_id, ok, cancelled, time_ms, tx } => {
                head(&mut out, "queryEnd", query_id);
                let _ = write!(out, ",\"ok\":{ok},\"cancelled\":{cancelled},\"timeMs\":{time_ms},\"tx\":\"{tx}\"}}");
            }
            PgPortMessage::ResultClosed { query_id, index } => {
                head(&mut out, "resultClosed", query_id);
                let _ = write!(out, ",\"index\":{index}}}");
            }
            PgPortMessage::Notice { query_id, notice } => {
                out = notice_json(query_id, notice).unwrap_or_default();
            }
        }
        out
    }
}

/// `serverError(error)` as a JSON value for operation answers (`DbResult.server`); None when the error is not the
/// server's. A lone high surrogate left by the 4,000-unit cut is dropped here (a Rust string cannot hold it; the port
/// messages keep it).
pub fn server_error_value(e: &PgServerError) -> Option<Value> {
    if !is_server_code(e.code()) {
        return None;
    }
    let cap = |v: Option<&str>, max: usize| v.filter(|v| !v.is_empty()).map(|v| utf16_head(v, max).text);
    let mut m = Map::new();
    m.insert("message".into(), json!(utf16_head(e.message(), SERVER_TEXT_CHARS).text));
    m.insert("code".into(), json!(e.code()));
    for (key, code) in [("severity", b'S'), ("detail", b'D'), ("hint", b'H')] {
        if let Some(v) = cap(e.field(code), SERVER_TEXT_CHARS) {
            m.insert(key.into(), json!(v));
        }
    }
    if let Some(p) = e.field(b'P').and_then(|p| p.trim().parse::<f64>().ok()).filter(|p| p.is_finite() && *p > 0.0) {
        let n = if p.fract() == 0.0 && p < 9e15 { json!(p as u64) } else { json!(p) };
        m.insert("position".into(), n);
    }
    for (key, code) in [("schema", b's'), ("table", b't'), ("column", b'c'), ("constraint", b'n')] {
        if let Some(v) = cap(e.field(code), 200) {
            m.insert(key.into(), json!(v));
        }
    }
    Some(Value::Object(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(fields: &[(u8, &str)]) -> PgServerError {
        PgServerError { fields: fields.iter().map(|(c, v)| (*c, (*v).to_owned())).collect() }
    }

    #[test]
    fn messages_are_written_like_json_stringify() {
        let cols = PgPortMessage::Columns {
            query_id: "q".into(),
            index: 0,
            columns: vec![
                PgColumn {
                    name: "id".into(),
                    type_oid: 23,
                    type_name: "integer".into(),
                    kind: "number",
                    table_oid: Some(16_385),
                    column_number: Some(1),
                },
                PgColumn {
                    name: "x".into(),
                    type_oid: 25,
                    type_name: "text".into(),
                    kind: "text",
                    table_oid: None,
                    column_number: None,
                },
            ],
        };
        assert_eq!(
            cols.to_json(),
            r#"{"t":"columns","queryId":"q","index":0,"columns":[{"name":"id","typeOid":23,"typeName":"integer","kind":"number","tableOid":16385,"columnNumber":1},{"name":"x","typeOid":25,"typeName":"text","kind":"text"}]}"#
        );
        let e = PgPortMessage::StatementError {
            query_id: "q".into(),
            index: 2,
            error: "server",
            server: Some(err(&[(b'S', "ERROR"), (b'C', "42703"), (b'M', "column \"x\" does not exist"), (b'P', "8")])),
            time_ms: 4,
        };
        assert_eq!(
            e.to_json(),
            r#"{"t":"statementError","queryId":"q","index":2,"error":"server","server":{"message":"column \"x\" does not exist","code":"42703","severity":"ERROR","position":8},"timeMs":4}"#
        );
        let closed = PgPortMessage::StatementError {
            query_id: "q".into(),
            index: 0,
            error: "dbClosed",
            server: Some(err(&[(b'M', "x")])),
            time_ms: 0,
        };
        assert_eq!(closed.to_json(), r#"{"t":"statementError","queryId":"q","index":0,"error":"dbClosed","timeMs":0}"#);
        let n = PgPortMessage::Notice { query_id: "q".into(), notice: err(&[(b'S', "NOTICE"), (b'M', "hi")]) };
        assert_eq!(n.to_json(), r#"{"t":"notice","queryId":"q","message":"hi","severity":"NOTICE"}"#);
        let end = PgPortMessage::StatementEnd {
            query_id: "q".into(),
            index: 0,
            command: "SELECT".into(),
            row_count: None,
            rows: 1000,
            has_more: true,
            truncated: false,
            time_ms: 1,
        };
        assert_eq!(
            end.to_json(),
            r#"{"t":"statementEnd","queryId":"q","index":0,"command":"SELECT","rowCount":null,"rows":1000,"hasMore":true,"timeMs":1}"#
        );
    }

    #[test]
    fn server_error_values_for_answers() {
        let v =
            server_error_value(&err(&[(b'S', "ERROR"), (b'C', "23505"), (b'M', "dup"), (b'D', "Key"), (b'n', "pk")])).unwrap();
        assert_eq!(v, json!({"message": "dup", "code": "23505", "severity": "ERROR", "detail": "Key", "constraint": "pk"}));
        let v = server_error_value(&err(&[(b'C', "42601"), (b'M', "x"), (b'P', "12")])).unwrap();
        assert_eq!(v, json!({"message": "x", "code": "42601", "position": 12}));
        assert_eq!(server_error_value(&err(&[(b'C', "oops")])), None);
    }
}
