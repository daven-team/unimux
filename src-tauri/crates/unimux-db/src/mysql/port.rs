//! The DB port messages a MySQL / MariaDB session sends (`DbPortMessage` in src/shared/db.ts, the subset mysqlSession.ts
//! uses), written as `JSON.stringify` writes the 1.1.4 objects (same key order). Cells and server texts are cut in UTF-16
//! units and may end in a lone high surrogate, so the messages are written by hand (D12 routes the raw JSON).

use std::fmt::Write as _;

use serde_json::{Value, json};
use unimux_core::js_json::write_string;

use super::error::DbServerError;
use crate::wire::value::{DbValue, Head, write_head};

/// `DbColumn` of a MySQL result: `{name, typeOid: <the field's column type>, typeName, kind}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MyPortColumn {
    pub name: String,
    pub type_oid: u8,
    pub type_name: String,
    pub kind: &'static str,
}

/// One DB port message of a MySQL session.
#[derive(Debug, Clone, PartialEq)]
pub enum MyPortMessage {
    /// `set`: the number of a CALL's result set (2 and up) that takes a result of its own.
    Statement {
        query_id: String,
        index: usize,
        start: usize,
        end: usize,
        set: Option<usize>,
    },
    Columns {
        query_id: String,
        index: usize,
        columns: Vec<MyPortColumn>,
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
        server: Option<DbServerError>,
        time_ms: u64,
    },
    /// SHOW WARNINGS rows and the CALL set cap.
    Notice {
        query_id: String,
        message: Head,
        severity: String,
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
}

fn head(out: &mut String, t: &str, query_id: &str) {
    out.push_str("{\"t\":\"");
    out.push_str(t);
    out.push_str("\",\"queryId\":");
    write_string(out, query_id);
}

/// A server error as an operation answer carries it (`DbResult.server`); a lone surrogate at the cut is dropped there (a
/// Rust string cannot hold it).
pub fn server_value(s: &DbServerError) -> Value {
    let mut v = json!({ "message": s.message.text });
    if let Some(code) = &s.code {
        v["code"] = json!(code);
    }
    v["severity"] = json!(s.severity);
    if let Some(p) = s.position {
        v["position"] = json!(p);
    }
    v
}

impl MyPortMessage {
    /// The queryId the message belongs to (D12 routes by it).
    pub fn query_id(&self) -> &str {
        match self {
            MyPortMessage::Statement { query_id, .. }
            | MyPortMessage::Columns { query_id, .. }
            | MyPortMessage::Rows { query_id, .. }
            | MyPortMessage::StatementEnd { query_id, .. }
            | MyPortMessage::StatementError { query_id, .. }
            | MyPortMessage::Notice { query_id, .. }
            | MyPortMessage::QueryEnd { query_id, .. }
            | MyPortMessage::ResultClosed { query_id, .. } => query_id,
        }
    }

    /// `JSON.stringify(message)`.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        match self {
            MyPortMessage::Statement { query_id, index, start, end, set } => {
                head(&mut out, "statement", query_id);
                let _ = write!(out, ",\"index\":{index},\"start\":{start},\"end\":{end}");
                if let Some(set) = set {
                    let _ = write!(out, ",\"set\":{set}");
                }
                out.push('}');
            }
            MyPortMessage::Columns { query_id, index, columns } => {
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
                    out.push('}');
                }
                out.push_str("]}");
            }
            MyPortMessage::Rows { query_id, index, rows } => {
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
            MyPortMessage::StatementEnd { query_id, index, command, row_count, rows, has_more, truncated, time_ms } => {
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
            MyPortMessage::StatementError { query_id, index, error, server, time_ms } => {
                head(&mut out, "statementError", query_id);
                let _ = write!(out, ",\"index\":{index},\"error\":");
                write_string(&mut out, error);
                if let Some(s) = server {
                    out.push_str(",\"server\":");
                    s.write_json(&mut out);
                }
                let _ = write!(out, ",\"timeMs\":{time_ms}}}");
            }
            MyPortMessage::Notice { query_id, message, severity } => {
                head(&mut out, "notice", query_id);
                out.push_str(",\"message\":");
                write_head(&mut out, message);
                out.push_str(",\"severity\":");
                write_string(&mut out, severity);
                out.push('}');
            }
            MyPortMessage::QueryEnd { query_id, ok, cancelled, time_ms, tx } => {
                head(&mut out, "queryEnd", query_id);
                let _ = write!(out, ",\"ok\":{ok},\"cancelled\":{cancelled},\"timeMs\":{time_ms},\"tx\":\"{tx}\"}}");
            }
            MyPortMessage::ResultClosed { query_id, index } => {
                head(&mut out, "resultClosed", query_id);
                let _ = write!(out, ",\"index\":{index}}}");
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::value::server_text;

    #[test]
    fn messages_are_written_like_json_stringify() {
        let st = MyPortMessage::Statement { query_id: "q".into(), index: 2, start: 0, end: 9, set: Some(2) };
        assert_eq!(st.to_json(), r#"{"t":"statement","queryId":"q","index":2,"start":0,"end":9,"set":2}"#);
        let cols = MyPortMessage::Columns {
            query_id: "q".into(),
            index: 0,
            columns: vec![MyPortColumn { name: "id".into(), type_oid: 3, type_name: "int".into(), kind: "int" }],
        };
        assert_eq!(
            cols.to_json(),
            r#"{"t":"columns","queryId":"q","index":0,"columns":[{"name":"id","typeOid":3,"typeName":"int","kind":"int"}]}"#
        );
        let end = MyPortMessage::StatementEnd {
            query_id: "q".into(),
            index: 0,
            command: "CALL".into(),
            row_count: Some(5),
            rows: 3,
            has_more: false,
            truncated: true,
            time_ms: 1,
        };
        assert_eq!(
            end.to_json(),
            r#"{"t":"statementEnd","queryId":"q","index":0,"command":"CALL","rowCount":5,"rows":3,"hasMore":false,"truncated":true,"timeMs":1}"#
        );
        let notice =
            MyPortMessage::Notice { query_id: "q".into(), message: server_text("Note 1003: x"), severity: "NOTE".into() };
        assert_eq!(notice.to_json(), r#"{"t":"notice","queryId":"q","message":"Note 1003: x","severity":"NOTE"}"#);
        let err = MyPortMessage::StatementError {
            query_id: "q".into(),
            index: 1,
            error: "server",
            server: Some(DbServerError {
                message: server_text("ERROR 1064 (42000): near 'FRM'"),
                code: Some("42000".into()),
                severity: "ERROR",
                position: Some(10),
            }),
            time_ms: 0,
        };
        assert_eq!(
            err.to_json(),
            r#"{"t":"statementError","queryId":"q","index":1,"error":"server","server":{"message":"ERROR 1064 (42000): near 'FRM'","code":"42000","severity":"ERROR","position":10},"timeMs":0}"#
        );
        let q = MyPortMessage::QueryEnd { query_id: "q".into(), ok: true, cancelled: false, time_ms: 4, tx: "transaction" };
        assert_eq!(q.to_json(), r#"{"t":"queryEnd","queryId":"q","ok":true,"cancelled":false,"timeMs":4,"tx":"transaction"}"#);
        for m in [st, cols, end, notice, err, q] {
            assert!(serde_json::from_str::<Value>(&m.to_json()).is_ok());
        }
    }
}
