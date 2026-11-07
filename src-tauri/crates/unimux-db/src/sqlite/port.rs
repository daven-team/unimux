//! The DB port messages a SQLite session sends (`DbPortMessage` in src/shared/db.ts, the subset SQLite uses), written as
//! `JSON.stringify` writes the 1.1.4 objects (same key order). Rows carry [`DbValue`]s, whose cut heads may end in a lone
//! high surrogate, so the messages are written by hand instead of through `serde_json::Value` (D12 routes the raw JSON).

use std::fmt::Write as _;

use serde_json::{Value, json};
use unimux_core::js_json::write_string;

use crate::wire::value::{DbValue, Head, server_text, write_head};

/// `DbColumn` of a SQLite result: `{name, typeOid: 0, typeName, kind}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortColumn {
    pub name: String,
    pub type_name: String,
    pub kind: &'static str,
}

/// `DbServerError` of an engine error: the message (cut to DB_LIMITS.serverText), `SQLITE_<extended code>`, severity
/// `ERROR` and, for a syntax error, the 1-based position in the statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerError {
    pub message: Head,
    pub code: String,
    pub position: Option<usize>,
}

impl ServerError {
    pub fn new(message: &str, errcode: i32, position: Option<usize>) -> Self {
        ServerError { message: server_text(message), code: format!("SQLITE_{errcode}"), position }
    }

    pub fn write_json(&self, out: &mut String) {
        out.push_str("{\"message\":");
        write_head(out, &self.message);
        out.push_str(",\"code\":");
        write_string(out, &self.code);
        out.push_str(",\"severity\":\"ERROR\"");
        if let Some(p) = self.position {
            let _ = write!(out, ",\"position\":{p}");
        }
        out.push('}');
    }

    /// The same as a JSON value (operation answers); a lone surrogate at the cut is dropped there (a Rust string cannot
    /// hold it).
    pub fn to_value(&self) -> Value {
        let mut v = json!({ "message": self.message.text, "code": self.code, "severity": "ERROR" });
        if let Some(p) = self.position {
            v["position"] = json!(p);
        }
        v
    }
}

/// One DB port message of a SQLite session.
#[derive(Debug, Clone, PartialEq)]
pub enum PortMessage {
    Statement {
        query_id: String,
        index: usize,
        start: usize,
        end: usize,
    },
    Columns {
        query_id: String,
        index: usize,
        columns: Vec<PortColumn>,
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
        server: Option<ServerError>,
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
}

fn head(out: &mut String, t: &str, query_id: &str) {
    out.push_str("{\"t\":\"");
    out.push_str(t);
    out.push_str("\",\"queryId\":");
    write_string(out, query_id);
}

impl PortMessage {
    /// The queryId the message belongs to (D12 routes by it).
    pub fn query_id(&self) -> &str {
        match self {
            PortMessage::Statement { query_id, .. }
            | PortMessage::Columns { query_id, .. }
            | PortMessage::Rows { query_id, .. }
            | PortMessage::StatementEnd { query_id, .. }
            | PortMessage::StatementError { query_id, .. }
            | PortMessage::QueryEnd { query_id, .. }
            | PortMessage::ResultClosed { query_id, .. } => query_id,
        }
    }

    /// `JSON.stringify(message)`.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        match self {
            PortMessage::Statement { query_id, index, start, end } => {
                head(&mut out, "statement", query_id);
                let _ = write!(out, ",\"index\":{index},\"start\":{start},\"end\":{end}}}");
            }
            PortMessage::Columns { query_id, index, columns } => {
                head(&mut out, "columns", query_id);
                let _ = write!(out, ",\"index\":{index},\"columns\":[");
                for (i, c) in columns.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str("{\"name\":");
                    write_string(&mut out, &c.name);
                    out.push_str(",\"typeOid\":0,\"typeName\":");
                    write_string(&mut out, &c.type_name);
                    out.push_str(",\"kind\":");
                    write_string(&mut out, c.kind);
                    out.push('}');
                }
                out.push_str("]}");
            }
            PortMessage::Rows { query_id, index, rows } => {
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
            PortMessage::StatementEnd { query_id, index, command, row_count, rows, has_more, truncated, time_ms } => {
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
            PortMessage::StatementError { query_id, index, error, server, time_ms } => {
                head(&mut out, "statementError", query_id);
                let _ = write!(out, ",\"index\":{index},\"error\":");
                write_string(&mut out, error);
                if let Some(s) = server {
                    out.push_str(",\"server\":");
                    s.write_json(&mut out);
                }
                let _ = write!(out, ",\"timeMs\":{time_ms}}}");
            }
            PortMessage::QueryEnd { query_id, ok, cancelled, time_ms, tx } => {
                head(&mut out, "queryEnd", query_id);
                let _ = write!(out, ",\"ok\":{ok},\"cancelled\":{cancelled},\"timeMs\":{time_ms},\"tx\":\"{tx}\"}}");
            }
            PortMessage::ResultClosed { query_id, index } => {
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

    #[test]
    fn messages_are_written_like_json_stringify() {
        let m = PortMessage::StatementEnd {
            query_id: "q".into(),
            index: 1,
            command: "SELECT".into(),
            row_count: None,
            rows: 10,
            has_more: false,
            truncated: true,
            time_ms: 3,
        };
        assert_eq!(
            m.to_json(),
            r#"{"t":"statementEnd","queryId":"q","index":1,"command":"SELECT","rowCount":null,"rows":10,"hasMore":false,"truncated":true,"timeMs":3}"#
        );
        let rows = PortMessage::Rows {
            query_id: "q".into(),
            index: 0,
            rows: vec![vec![DbValue::Null, DbValue::Text("a\"b".into())], vec![]],
        };
        assert_eq!(rows.to_json(), r#"{"t":"rows","queryId":"q","index":0,"rows":[[null,"a\"b"],[]]}"#);
        let err = PortMessage::StatementError {
            query_id: "q".into(),
            index: 0,
            error: "server",
            server: Some(ServerError::new("near \"FRM\": syntax error", 1, Some(10))),
            time_ms: 0,
        };
        assert_eq!(
            err.to_json(),
            r#"{"t":"statementError","queryId":"q","index":0,"error":"server","server":{"message":"near \"FRM\": syntax error","code":"SQLITE_1","severity":"ERROR","position":10},"timeMs":0}"#
        );
        let cols = PortMessage::Columns {
            query_id: "q".into(),
            index: 0,
            columns: vec![PortColumn { name: "id".into(), type_name: "INTEGER".into(), kind: "bigint" }],
        };
        assert_eq!(
            cols.to_json(),
            r#"{"t":"columns","queryId":"q","index":0,"columns":[{"name":"id","typeOid":0,"typeName":"INTEGER","kind":"bigint"}]}"#
        );
        let end = PortMessage::QueryEnd { query_id: "q".into(), ok: true, cancelled: false, time_ms: 5, tx: "idle" };
        assert_eq!(end.to_json(), r#"{"t":"queryEnd","queryId":"q","ok":true,"cancelled":false,"timeMs":5,"tx":"idle"}"#);
        for m in [m, rows, err, cols, end] {
            assert!(serde_json::from_str::<Value>(&m.to_json()).is_ok());
        }
    }
}
