//! SP9 spike: Redis replies and connections over any stream, measured against ioredis 6.0 (what 1.1.4 runs with
//! `callBuffer`, protocol 2, `stringNumbers`, identity reply transformers). D9 / D10 build the real session; the findings are
//! in docs/tauri/spikes/SP9.md.
//!
//! `RespReader` is an own RESP2 reader producing `Raw` (what ioredis hands to `RedisSession.reply`: null, an Error, a number
//! string, a Buffer, an array). SP9 decided against the redis crate (it stays a dev-dependency so tests/wire_servers.rs can
//! show the gaps): redis 1.8 decodes status and error lines with `str::from_utf8` and drops the whole connection on a line
//! that is not UTF-8 (a Lua `redis.status_reply` / `error_reply` with such bytes) where ioredis keeps the bytes, its default
//! 500 ms response timeout cuts slow console commands, and its disconnect notice needs RESP3.

use std::fmt::Write as _;
use std::io;

use base64::Engine as _;
use bytes::{Buf, BytesMut};
use unimux_core::js_json::write_string;

use super::value::node_utf8;

/// REDIS_LIMITS (src/shared/dbRedis.ts) used by the reply.
pub const REPLY_NODES: usize = 10_000;
pub const REPLY_BULK_BYTES: usize = 1024 * 1024;
/// RETRY_DELAYS and REDIS_LIMITS.reconnectAttempts of src/dbhost/redisSession.ts.
pub const RETRY_DELAYS_MS: [u64; 3] = [300, 1000, 2000];
pub const RECONNECT_ATTEMPTS: u32 = 3;

/// A reply as ioredis gives it to the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Raw {
    Null,
    /// ReplyError.message (the error line, decoded like Node).
    Error(String),
    /// An integer reply as its text (`stringNumbers`).
    Integer(String),
    /// A bulk or status reply (callBuffer gives both as a Buffer).
    Bytes(Vec<u8>),
    Array(Vec<Raw>),
}

/// An own RESP2 reader (the bytes of status and error lines kept as they are).
#[derive(Default)]
pub struct RespReader {
    buf: BytesMut,
}

fn line_end(b: &[u8], from: usize) -> Option<usize> {
    b[from..].windows(2).position(|w| w == b"\r\n").map(|p| from + p)
}

fn parse_at(b: &[u8], at: usize, depth: usize) -> io::Result<Option<(Raw, usize)>> {
    if depth > 512 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "reply nested too deeply"));
    }
    let Some(&kind) = b.get(at) else { return Ok(None) };
    let Some(end) = line_end(b, at + 1) else { return Ok(None) };
    let line = &b[at + 1..end];
    let next = end + 2;
    let int = || -> io::Result<i64> {
        std::str::from_utf8(line)
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad length"))
    };
    Ok(Some(match kind {
        b'+' => (Raw::Bytes(line.to_vec()), next),
        b'-' => (Raw::Error(node_utf8(line)), next),
        b':' => (Raw::Integer(node_utf8(line)), next),
        b'$' => {
            let n = int()?;
            if n < 0 {
                (Raw::Null, next)
            } else {
                let n = n as usize;
                if b.len() < next + n + 2 {
                    return Ok(None);
                }
                (Raw::Bytes(b[next..next + n].to_vec()), next + n + 2)
            }
        }
        b'*' => {
            let n = int()?;
            if n < 0 {
                (Raw::Null, next)
            } else {
                let mut items = Vec::with_capacity((n as usize).min(1 << 16));
                let mut p = next;
                for _ in 0..n {
                    match parse_at(b, p, depth + 1)? {
                        Some((v, q)) => {
                            items.push(v);
                            p = q;
                        }
                        None => return Ok(None),
                    }
                }
                (Raw::Array(items), p)
            }
        }
        other => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unknown reply type {other:#x}"))),
    }))
}

impl RespReader {
    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// The next complete reply, if the buffer holds one.
    pub fn next_reply(&mut self) -> io::Result<Option<Raw>> {
        match parse_at(&self.buf, 0, 0)? {
            Some((v, used)) => {
                self.buf.advance(used);
                Ok(Some(v))
            }
            None => Ok(None),
        }
    }
}

/// A command in RESP (what ioredis writes: `*<n>\r\n` then `$<len>\r\n<bytes>\r\n` per argument).
pub fn encode_command(argv: &[&[u8]]) -> Vec<u8> {
    let mut out = format!("*{}\r\n", argv.len()).into_bytes();
    for a in argv {
        out.extend_from_slice(format!("${}\r\n", a.len()).as_bytes());
        out.extend_from_slice(a);
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// `RedisData`: text when the bytes are UTF-8 (Node `isUtf8`), else base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedisData {
    Text(String),
    B64(String),
}

pub fn to_data(b: &[u8]) -> RedisData {
    match std::str::from_utf8(b) {
        Ok(s) => RedisData::Text(s.to_owned()),
        Err(_) => RedisData::B64(base64::engine::general_purpose::STANDARD.encode(b)),
    }
}

/// `trimPartialUtf8`.
pub fn trim_partial_utf8(b: &[u8]) -> &[u8] {
    if std::str::from_utf8(b).is_ok() {
        return b;
    }
    for k in 1..=3 {
        if k >= b.len() {
            break;
        }
        if std::str::from_utf8(&b[..b.len() - k]).is_ok() {
            return &b[..b.len() - k];
        }
    }
    b
}

/// `cutBytes`.
pub fn cut_bytes(b: &[u8], max: usize) -> &[u8] {
    if b.len() <= max { b } else { trim_partial_utf8(&b[..max]) }
}

/// `RedisReply` (src/shared/dbRedis.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedisReply {
    Simple(String),
    Error(String),
    Integer(String),
    Bulk { v: RedisData, bytes: usize, truncated: bool },
    Null,
    Array { items: Vec<RedisReply>, length: usize },
}

/// JS `s.slice(0, 4000)` for an error text (UTF-16 units; a cut pair is dropped, see value.rs for why it cannot stay).
fn slice_4000(s: &str) -> String {
    super::value::utf16_head(s, 4000).text
}

/// `RedisSession.reply`.
pub fn reply(v: &Raw, status: bool, budget: &mut usize, top: bool) -> RedisReply {
    *budget = budget.saturating_sub(1);
    match v {
        Raw::Null => RedisReply::Null,
        Raw::Error(m) => RedisReply::Error(slice_4000(m)),
        Raw::Integer(s) => RedisReply::Integer(s.clone()),
        Raw::Bytes(b) => {
            if top
                && status
                && b.len() < 1024
                && let Ok(s) = std::str::from_utf8(b)
            {
                return RedisReply::Simple(s.to_owned());
            }
            let part = cut_bytes(b, REPLY_BULK_BYTES);
            RedisReply::Bulk { v: to_data(part), bytes: b.len(), truncated: part.len() < b.len() }
        }
        Raw::Array(items) => {
            let mut out = Vec::new();
            for x in items {
                if *budget == 0 {
                    break;
                }
                out.push(reply(x, status, budget, false));
            }
            RedisReply::Array { items: out, length: items.len() }
        }
    }
}

fn write_data(out: &mut String, d: &RedisData) {
    match d {
        RedisData::Text(s) => write_string(out, s),
        RedisData::B64(s) => {
            out.push_str("{\"b64\":");
            write_string(out, s);
            out.push('}');
        }
    }
}

impl RedisReply {
    /// `JSON.stringify(reply)`.
    pub fn write_json(&self, out: &mut String) {
        match self {
            RedisReply::Simple(v) => {
                out.push_str("{\"t\":\"simple\",\"v\":");
                write_string(out, v);
                out.push('}');
            }
            RedisReply::Error(v) => {
                out.push_str("{\"t\":\"error\",\"v\":");
                write_string(out, v);
                out.push('}');
            }
            RedisReply::Integer(v) => {
                out.push_str("{\"t\":\"integer\",\"v\":");
                write_string(out, v);
                out.push('}');
            }
            RedisReply::Bulk { v, bytes, truncated } => {
                out.push_str("{\"t\":\"bulk\",\"v\":");
                write_data(out, v);
                let _ = write!(out, ",\"bytes\":{bytes}");
                if *truncated {
                    out.push_str(",\"truncated\":true");
                }
                out.push('}');
            }
            RedisReply::Null => out.push_str("{\"t\":\"null\"}"),
            RedisReply::Array { items, length } => {
                out.push_str("{\"t\":\"array\",\"items\":[");
                for (i, x) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    x.write_json(out);
                }
                let _ = write!(out, "],\"length\":{length}}}");
            }
        }
    }

    pub fn to_json(&self) -> String {
        let mut s = String::new();
        self.write_json(&mut s);
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(bytes: &[u8]) -> Vec<Raw> {
        let mut r = RespReader::default();
        let mut out = Vec::new();
        // byte by byte: partial replies wait for the rest
        for b in bytes {
            r.push(&[*b]);
            while let Some(v) = r.next_reply().unwrap() {
                out.push(v);
            }
        }
        out
    }

    #[test]
    fn own_reader_keeps_status_and_error_bytes() {
        let v = read_all(b"+OK\r\n+\xff\r\n-ERR bad \xff\r\n:-12\r\n$-1\r\n*-1\r\n$3\r\na\r\n\r\n*2\r\n$0\r\n\r\n*1\r\n:1\r\n");
        assert_eq!(
            v,
            vec![
                Raw::Bytes(b"OK".to_vec()),
                Raw::Bytes(vec![0xff]),
                Raw::Error("ERR bad \u{fffd}".into()),
                Raw::Integer("-12".into()),
                Raw::Null,
                Raw::Null,
                Raw::Bytes(b"a\r\n".to_vec()),
                Raw::Array(vec![Raw::Bytes(vec![]), Raw::Array(vec![Raw::Integer("1".into())])]),
            ]
        );
    }

    #[test]
    fn reply_shapes_like_the_session() {
        let mut budget = REPLY_NODES;
        assert_eq!(reply(&Raw::Bytes(b"PONG".to_vec()), true, &mut budget, true).to_json(), r#"{"t":"simple","v":"PONG"}"#);
        assert_eq!(
            reply(&Raw::Bytes(b"PONG".to_vec()), false, &mut budget, true).to_json(),
            r#"{"t":"bulk","v":"PONG","bytes":4}"#
        );
        assert_eq!(
            reply(&Raw::Bytes(vec![0xff, 0]), false, &mut budget, true).to_json(),
            r#"{"t":"bulk","v":{"b64":"/wA="},"bytes":2}"#
        );
        let arr = Raw::Array(vec![Raw::Bytes(b"x".to_vec()), Raw::Null, Raw::Error("ERR e".into())]);
        assert_eq!(
            reply(&arr, true, &mut budget, true).to_json(),
            r#"{"t":"array","items":[{"t":"bulk","v":"x","bytes":1},{"t":"null"},{"t":"error","v":"ERR e"}],"length":3}"#
        );
        let mut two = 2;
        assert_eq!(
            reply(&arr, false, &mut two, true).to_json(),
            r#"{"t":"array","items":[{"t":"bulk","v":"x","bytes":1}],"length":3}"#
        );
    }

    #[test]
    fn a_cut_inside_a_utf8_character_moves_back() {
        assert_eq!(cut_bytes("aé".as_bytes(), 2), b"a");
        assert_eq!(cut_bytes(&[0xff, 0xfe, 0xfd], 2), &[0xff, 0xfe]);
    }

    #[test]
    fn commands_encode_like_ioredis() {
        assert_eq!(
            encode_command(&[b"CLIENT", b"SETNAME", b"unimux"]),
            b"*3\r\n$6\r\nCLIENT\r\n$7\r\nSETNAME\r\n$6\r\nunimux\r\n"
        );
    }
}
