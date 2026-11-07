//! The server's errors and notices as DB port JSON (`serverError`, the notice message and `codeOf` of
//! src/dbhost/pgSession.ts). Texts are cut in UTF-16 units like JS `slice`; a cut inside a surrogate pair keeps the lone
//! high surrogate and is written as `\udXXX` (what JSON.stringify writes; SP9 open issue 2), so these are written with the
//! `wire::value` writer, never with serde_json.

use std::fmt::Write as _;

use unimux_core::js_json::write_string;

use super::error::is_server_code;
use crate::wire::pg::PgServerError;
use crate::wire::value::{SERVER_TEXT_CHARS, utf16_head, write_head};

/// `cap(s, max)`: a non-empty field cut to `max` units.
fn cap_field(out: &mut String, key: &str, value: Option<&str>, max: usize) {
    if let Some(v) = value.filter(|v| !v.is_empty()) {
        let _ = write!(out, ",\"{key}\":");
        write_head(out, &utf16_head(v, max));
    }
}

/// `Number(e.position)` when it is a positive finite number.
fn position(value: Option<&str>) -> Option<f64> {
    let t = value?.trim();
    if t.is_empty() {
        return None;
    }
    let n: f64 = t.parse().ok()?;
    (n.is_finite() && n > 0.0).then_some(n)
}

/// The server's error as `DbServerError` JSON; None for an error that is not the server's (no 5-character code).
pub fn server_error_json(e: &PgServerError) -> Option<String> {
    let code = e.code();
    if !is_server_code(code) {
        return None;
    }
    let mut out = String::from("{\"message\":");
    write_head(&mut out, &utf16_head(e.field(b'M').unwrap_or(""), SERVER_TEXT_CHARS));
    out.push_str(",\"code\":");
    write_string(&mut out, code);
    cap_field(&mut out, "severity", e.field(b'S'), SERVER_TEXT_CHARS);
    cap_field(&mut out, "detail", e.field(b'D'), SERVER_TEXT_CHARS);
    cap_field(&mut out, "hint", e.field(b'H'), SERVER_TEXT_CHARS);
    if let Some(p) = position(e.field(b'P')) {
        out.push_str(",\"position\":");
        out.push_str(ryu_js::Buffer::new().format(p));
    }
    cap_field(&mut out, "schema", e.field(b's'), 200);
    cap_field(&mut out, "table", e.field(b't'), 200);
    cap_field(&mut out, "column", e.field(b'c'), 200);
    cap_field(&mut out, "constraint", e.field(b'n'), 200);
    out.push('}');
    Some(out)
}

/// The `notice` port message of a run (`{t:'notice', queryId, message, severity?}`); None when the notice has no message.
pub fn notice_json(query_id: &str, n: &PgServerError) -> Option<String> {
    let message = n.field(b'M')?;
    let mut out = String::from("{\"t\":\"notice\",\"queryId\":");
    write_string(&mut out, query_id);
    out.push_str(",\"message\":");
    write_head(&mut out, &utf16_head(message, SERVER_TEXT_CHARS));
    if let Some(s) = n.field(b'S').filter(|s| !s.is_empty()) {
        out.push_str(",\"severity\":");
        write_string(&mut out, s);
    }
    out.push('}');
    Some(out)
}

/// `codeOf`: the error code of a failed statement. `error` None: not the server's (a dropped connection).
pub fn statement_error_code(error: Option<&PgServerError>, session_ended: bool, cancel_requested: bool) -> &'static str {
    let Some(e) = error.filter(|e| is_server_code(e.code())) else {
        return if session_ended { "noSession" } else { "dbClosed" };
    };
    match e.code() {
        "57014" => {
            if cancel_requested {
                "cancelled"
            } else if e.message().to_ascii_lowercase().contains("statement timeout") {
                "statementTimeout"
            } else {
                "cancelled"
            }
        }
        "25006" => "readOnly",
        _ => "server",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(fields: &[(u8, &str)]) -> PgServerError {
        PgServerError { fields: fields.iter().map(|(c, v)| (*c, (*v).to_owned())).collect() }
    }

    #[test]
    fn server_errors_like_pg_session() {
        let e = err(&[(b'S', "ERROR"), (b'V', "ERROR"), (b'C', "42P01"), (b'M', "relation \"x\" does not exist"), (b'P', "15")]);
        assert_eq!(
            server_error_json(&e).unwrap(),
            r#"{"message":"relation \"x\" does not exist","code":"42P01","severity":"ERROR","position":15}"#
        );
        let e = err(&[
            (b'C', "23505"),
            (b'M', ""),
            (b'D', "Key (id)=(1) already exists."),
            (b's', "public"),
            (b't', "t"),
            (b'n', "t_pkey"),
            (b'P', "0"),
        ]);
        assert_eq!(
            server_error_json(&e).unwrap(),
            r#"{"message":"","code":"23505","detail":"Key (id)=(1) already exists.","schema":"public","table":"t","constraint":"t_pkey"}"#
        );
        assert_eq!(server_error_json(&err(&[(b'C', "abc"), (b'M', "x")])), None);
    }

    #[test]
    fn a_cut_inside_a_pair_keeps_the_high_surrogate() {
        let msg = format!("{}\u{1F600}", "a".repeat(SERVER_TEXT_CHARS - 1));
        let json = server_error_json(&err(&[(b'C', "XX000"), (b'M', &msg)])).unwrap();
        assert!(json.contains("a\\ud83d\",\"code\""), "{}", &json[json.len() - 40..]);
        let name = "n".repeat(300);
        let json = server_error_json(&err(&[(b'C', "XX000"), (b'M', "m"), (b'c', &name)])).unwrap();
        assert!(json.contains(&format!("\"column\":\"{}\"", "n".repeat(200))));
    }

    #[test]
    fn notices_and_codes() {
        let n = err(&[(b'S', "NOTICE"), (b'M', "hello")]);
        assert_eq!(notice_json("q1", &n).unwrap(), r#"{"t":"notice","queryId":"q1","message":"hello","severity":"NOTICE"}"#);
        assert_eq!(notice_json("q1", &err(&[(b'S', "NOTICE")])), None);
        let timeout = err(&[(b'C', "57014"), (b'M', "canceling statement due to statement timeout")]);
        let user = err(&[(b'C', "57014"), (b'M', "canceling statement due to user request")]);
        assert_eq!(statement_error_code(Some(&timeout), false, false), "statementTimeout");
        assert_eq!(statement_error_code(Some(&timeout), false, true), "cancelled");
        assert_eq!(statement_error_code(Some(&user), false, false), "cancelled");
        assert_eq!(statement_error_code(Some(&err(&[(b'C', "25006")])), false, false), "readOnly");
        assert_eq!(statement_error_code(Some(&err(&[(b'C', "42601")])), false, false), "server");
        assert_eq!(statement_error_code(None, false, false), "dbClosed");
        assert_eq!(statement_error_code(None, true, false), "noSession");
    }
}
