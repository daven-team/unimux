//! SP9 spike: a minimal PostgreSQL wire client over any `AsyncRead + AsyncWrite` stream (TCP, TLS, an SSH channel), built
//! on postgres-protocol 0.6.12, to measure value fidelity against node-postgres 8.23 (what 1.1.4 runs). D4 builds the real
//! client; the findings are in docs/tauri/spikes/SP9.md.
//!
//! What postgres-protocol is used for: every frontend message (startup 3.0, password, SASL, query, parse / bind / describe /
//! execute / sync, cancel 3.0), MD5 and SCRAM-SHA-256, and parsing of the backend messages it handles faithfully.
//! Parsed here instead (each one fails in postgres-protocol, see the unit tests below):
//! - `K` BackendKeyData: protocol 3.2 (PostgreSQL 18) sends a variable-length secret (32 bytes); postgres-protocol reads
//!   two i32 and refuses the rest ("expected buffer to be empty").
//! - `v` NegotiateProtocolVersion: an unknown tag for postgres-protocol.
//! - `T` RowDescription, `E` ErrorResponse, `N` NoticeResponse, `S` ParameterStatus, `C` CommandComplete: their strings
//!   are decoded lossily like Node (`Buffer.toString('utf8')`); postgres-protocol refuses invalid UTF-8, which a
//!   SQL_ASCII database sends (a column named with byte 0xff).

use std::io;

use bytes::{Buf, BufMut, BytesMut};
use fallible_iterator::FallibleIterator;
use postgres_protocol::authentication::{md5_hash, sasl};
use postgres_protocol::message::{backend, frontend};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::value::node_utf8;

/// The startup protocol version. 1.1.4 (node-postgres) always sends 3.0; 3.2 exists to measure PostgreSQL 18.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    V3_0,
    V3_2,
}

#[derive(Debug, Clone)]
pub struct PgConfig {
    pub user: String,
    pub database: String,
    pub password: Option<String>,
    pub protocol: Protocol,
}

/// BackendKeyData: 4 bytes of secret under 3.0, up to 256 under 3.2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendKey {
    pub process_id: i32,
    pub secret: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgField {
    pub name: String,
    pub table_oid: u32,
    pub column_id: i16,
    pub type_oid: u32,
    pub type_size: i16,
    pub type_modifier: i32,
    pub format: i16,
}

/// An ErrorResponse / NoticeResponse: its fields in wire order (code byte, lossy text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgServerError {
    pub fields: Vec<(u8, String)>,
}

impl PgServerError {
    pub fn field(&self, code: u8) -> Option<&str> {
        self.fields.iter().find(|(c, _)| *c == code).map(|(_, v)| v.as_str())
    }
    pub fn code(&self) -> &str {
        self.field(b'C').unwrap_or("")
    }
    pub fn message(&self) -> &str {
        self.field(b'M').unwrap_or("")
    }
}

#[derive(Debug)]
pub enum PgWireError {
    Io(io::Error),
    Server(PgServerError),
    NeedPassword,
    Protocol(String),
}

impl From<io::Error> for PgWireError {
    fn from(e: io::Error) -> Self {
        PgWireError::Io(e)
    }
}

impl std::fmt::Display for PgWireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PgWireError::Io(e) => write!(f, "io: {e}"),
            PgWireError::Server(e) => write!(f, "server {}: {}", e.code(), e.message()),
            PgWireError::NeedPassword => write!(f, "the server asks for a password"),
            PgWireError::Protocol(s) => write!(f, "protocol: {s}"),
        }
    }
}

impl std::error::Error for PgWireError {}

pub type Row = Vec<Option<Vec<u8>>>;

/// One statement of a run: its fields (None: no result set), rows as raw text bytes, the command tag or the error.
#[derive(Debug, Clone, Default)]
pub struct PgStatement {
    pub fields: Option<Vec<PgField>>,
    pub rows: Vec<Row>,
    pub tag: Option<String>,
    pub error: Option<PgServerError>,
}

/// node-postgres `Result.addCommandComplete` (`/^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/`): command = the letters at the start
/// (None: no match), rowCount = the second number when there are two (INSERT 0 5 -> 5), else the first.
pub fn parse_tag(tag: &str) -> (Option<String>, Option<u64>) {
    let b = tag.as_bytes();
    let letters = b.iter().take_while(|c| c.is_ascii_alphabetic()).count();
    if letters == 0 {
        return (None, None);
    }
    let mut numbers = Vec::new();
    let mut at = letters;
    while numbers.len() < 2 && at < b.len() && b[at] == b' ' {
        let digits = b[at + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            break;
        }
        numbers.push(tag[at + 1..at + 1 + digits].parse::<u64>().ok());
        at += 1 + digits;
    }
    (Some(tag[..letters].to_owned()), numbers.last().copied().flatten())
}

enum Frame {
    Key(BackendKey),
    /// `newest`: the newest version the server speaks for the requested major, as the full number (PostgreSQL 13 sends 0x0003_0000;
    /// the protocol docs call it the minor version).
    Negotiate {
        newest: i32,
        unrecognized: Vec<String>,
    },
    Fields(Vec<PgField>),
    Error(PgServerError),
    Notice(PgServerError),
    Param(String, String),
    Tag(String),
    Msg(backend::Message),
}

pub struct PgConn<S> {
    stream: S,
    buf: BytesMut,
    out: BytesMut,
    pub key: Option<BackendKey>,
    pub params: Vec<(String, String)>,
    /// ReadyForQuery status: b'I', b'T' or b'E'.
    pub tx: u8,
    pub negotiated: Option<(i32, Vec<String>)>,
    pub notices: Vec<PgServerError>,
}

fn cstr(buf: &mut &[u8]) -> io::Result<String> {
    let end = buf.iter().position(|b| *b == 0).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing NUL"))?;
    let s = node_utf8(&buf[..end]);
    *buf = &buf[end + 1..];
    Ok(s)
}

fn need(buf: &[u8], n: usize) -> io::Result<()> {
    if buf.len() < n { Err(io::Error::new(io::ErrorKind::InvalidData, "short message")) } else { Ok(()) }
}

fn error_fields(mut body: &[u8]) -> io::Result<PgServerError> {
    let mut fields = Vec::new();
    loop {
        need(body, 1)?;
        let code = body[0];
        body = &body[1..];
        if code == 0 {
            return Ok(PgServerError { fields });
        }
        fields.push((code, cstr(&mut body)?));
    }
}

fn row_description(mut body: &[u8]) -> io::Result<Vec<PgField>> {
    need(body, 2)?;
    let n = body.get_i16();
    let mut fields = Vec::with_capacity(n.max(0) as usize);
    for _ in 0..n {
        let name = cstr(&mut body)?;
        need(body, 18)?;
        fields.push(PgField {
            name,
            table_oid: body.get_u32(),
            column_id: body.get_i16(),
            type_oid: body.get_u32(),
            type_size: body.get_i16(),
            type_modifier: body.get_i32(),
            format: body.get_i16(),
        });
    }
    Ok(fields)
}

/// The frame parser: the custom messages listed in the module docs, the rest through postgres-protocol.
fn parse_frame(tag: u8, whole: &mut BytesMut) -> io::Result<Frame> {
    let body = &whole[5..];
    Ok(match tag {
        b'K' => {
            let mut b = body;
            need(b, 4)?;
            let process_id = b.get_i32();
            Frame::Key(BackendKey { process_id, secret: b.to_vec() })
        }
        b'v' => {
            let mut b = body;
            need(b, 8)?;
            let newest = b.get_i32();
            let n = b.get_i32();
            let mut unrecognized = Vec::new();
            for _ in 0..n {
                unrecognized.push(cstr(&mut b)?);
            }
            Frame::Negotiate { newest, unrecognized }
        }
        b'T' => Frame::Fields(row_description(body)?),
        b'E' => Frame::Error(error_fields(body)?),
        b'N' => Frame::Notice(error_fields(body)?),
        b'S' => {
            let mut b = body;
            let k = cstr(&mut b)?;
            let v = cstr(&mut b)?;
            Frame::Param(k, v)
        }
        b'C' => {
            let mut b = body;
            Frame::Tag(cstr(&mut b)?)
        }
        _ => match backend::Message::parse(whole)? {
            Some(m) => Frame::Msg(m),
            None => return Err(io::Error::new(io::ErrorKind::InvalidData, "incomplete message")),
        },
    })
}

/// The startup message bytes (node-postgres order: user, database, application_name, then client_encoding UTF8).
pub fn startup_bytes(cfg: &PgConfig) -> io::Result<BytesMut> {
    let params = [
        ("user", cfg.user.as_str()),
        ("database", cfg.database.as_str()),
        ("application_name", "unimux"),
        ("client_encoding", "UTF8"),
    ];
    let mut buf = BytesMut::new();
    match cfg.protocol {
        Protocol::V3_0 => frontend::startup_message(params, &mut buf)?,
        Protocol::V3_2 => {
            let mut body = BytesMut::new();
            body.put_i32(0x0003_0002);
            for (k, v) in params {
                body.put_slice(k.as_bytes());
                body.put_u8(0);
                body.put_slice(v.as_bytes());
                body.put_u8(0);
            }
            body.put_u8(0);
            buf.put_i32(body.len() as i32 + 4);
            buf.put_slice(&body);
        }
    }
    Ok(buf)
}

/// A CancelRequest for the key (any secret length; 4 bytes is the 3.0 form postgres-protocol writes).
pub fn cancel_bytes(key: &BackendKey) -> BytesMut {
    let mut buf = BytesMut::new();
    if let Ok(secret) = <[u8; 4]>::try_from(key.secret.as_slice()) {
        frontend::cancel_request(key.process_id, i32::from_be_bytes(secret), &mut buf);
    } else {
        buf.put_i32(12 + key.secret.len() as i32);
        buf.put_i32(80_877_102);
        buf.put_i32(key.process_id);
        buf.put_slice(&key.secret);
    }
    buf
}

/// Sends a CancelRequest over a fresh stream to the same server.
pub async fn send_cancel<S: AsyncWrite + AsyncRead + Unpin>(mut stream: S, key: &BackendKey) -> io::Result<()> {
    stream.write_all(&cancel_bytes(key)).await?;
    stream.flush().await?;
    // the server closes the connection without an answer
    let mut b = [0u8; 1];
    let _ = stream.read(&mut b).await;
    Ok(())
}

impl<S: AsyncRead + AsyncWrite + Unpin> PgConn<S> {
    pub async fn connect(stream: S, cfg: &PgConfig) -> Result<Self, PgWireError> {
        let mut c = PgConn {
            stream,
            buf: BytesMut::with_capacity(64 * 1024),
            out: BytesMut::new(),
            key: None,
            params: Vec::new(),
            tx: b'I',
            negotiated: None,
            notices: Vec::new(),
        };
        c.out = startup_bytes(cfg)?;
        c.flush().await?;
        let mut scram: Option<sasl::ScramSha256> = None;
        loop {
            match c.frame().await? {
                Frame::Msg(backend::Message::AuthenticationOk) => {}
                Frame::Msg(backend::Message::AuthenticationCleartextPassword) => {
                    let pw = cfg.password.as_deref().ok_or(PgWireError::NeedPassword)?;
                    frontend::password_message(pw.as_bytes(), &mut c.out)?;
                    c.flush().await?;
                }
                Frame::Msg(backend::Message::AuthenticationMd5Password(body)) => {
                    let pw = cfg.password.as_deref().ok_or(PgWireError::NeedPassword)?;
                    let hash = md5_hash(cfg.user.as_bytes(), pw.as_bytes(), body.salt());
                    frontend::password_message(hash.as_bytes(), &mut c.out)?;
                    c.flush().await?;
                }
                Frame::Msg(backend::Message::AuthenticationSasl(body)) => {
                    let pw = cfg.password.as_deref().ok_or(PgWireError::NeedPassword)?;
                    let mechanisms: Vec<String> = body.mechanisms().map(|m| Ok(m.to_owned())).collect()?;
                    if !mechanisms.iter().any(|m| m == sasl::SCRAM_SHA_256) {
                        return Err(PgWireError::Protocol(format!("no supported SASL mechanism in {mechanisms:?}")));
                    }
                    let s = sasl::ScramSha256::new(pw.as_bytes(), sasl::ChannelBinding::unsupported());
                    frontend::sasl_initial_response(sasl::SCRAM_SHA_256, s.message(), &mut c.out)?;
                    scram = Some(s);
                    c.flush().await?;
                }
                Frame::Msg(backend::Message::AuthenticationSaslContinue(body)) => {
                    let s = scram.as_mut().ok_or_else(|| PgWireError::Protocol("SASL continue without a start".into()))?;
                    s.update(body.data())?;
                    frontend::sasl_response(s.message(), &mut c.out)?;
                    c.flush().await?;
                }
                Frame::Msg(backend::Message::AuthenticationSaslFinal(body)) => {
                    let s = scram.as_mut().ok_or_else(|| PgWireError::Protocol("SASL final without a start".into()))?;
                    s.finish(body.data())?;
                }
                Frame::Key(k) => c.key = Some(k),
                Frame::Negotiate { newest, unrecognized } => c.negotiated = Some((newest, unrecognized)),
                Frame::Param(k, v) => c.params.push((k, v)),
                Frame::Notice(n) => c.notices.push(n),
                Frame::Error(e) => return Err(PgWireError::Server(e)),
                Frame::Msg(backend::Message::ReadyForQuery(b)) => {
                    c.tx = b.status();
                    return Ok(c);
                }
                Frame::Msg(other) => {
                    return Err(PgWireError::Protocol(format!("unexpected message during startup: {}", tag_of(&other))));
                }
                Frame::Fields(_) | Frame::Tag(_) => return Err(PgWireError::Protocol("unexpected result during startup".into())),
            }
        }
    }

    pub fn param(&self, name: &str) -> Option<&str> {
        self.params.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    async fn flush(&mut self) -> io::Result<()> {
        let out = self.out.split();
        self.stream.write_all(&out).await?;
        self.stream.flush().await
    }

    async fn frame(&mut self) -> io::Result<Frame> {
        loop {
            if self.buf.len() >= 5 {
                let len = i32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]);
                if len < 4 {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "message length < 4"));
                }
                let total = 1 + len as usize;
                if self.buf.len() >= total {
                    let tag = self.buf[0];
                    let mut whole = self.buf.split_to(total);
                    return parse_frame(tag, &mut whole);
                }
                self.buf.reserve(total - self.buf.len());
            }
            if self.stream.read_buf(&mut self.buf).await? == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed"));
            }
        }
    }

    /// A simple-protocol run (Query): one entry per statement of the text.
    pub async fn simple_query(&mut self, sql: &str) -> Result<Vec<PgStatement>, PgWireError> {
        frontend::query(sql, &mut self.out)?;
        self.flush().await?;
        let mut done = Vec::new();
        let mut cur = PgStatement::default();
        loop {
            match self.frame().await? {
                Frame::Fields(f) => cur.fields = Some(f),
                Frame::Msg(backend::Message::DataRow(row)) => cur.rows.push(data_row(&row)?),
                Frame::Tag(t) => {
                    cur.tag = Some(t);
                    done.push(std::mem::take(&mut cur));
                }
                Frame::Msg(backend::Message::EmptyQueryResponse) => done.push(std::mem::take(&mut cur)),
                Frame::Error(e) => {
                    cur.error = Some(e);
                    done.push(std::mem::take(&mut cur));
                }
                Frame::Notice(n) => self.notices.push(n),
                Frame::Param(k, v) => self.params.push((k, v)),
                Frame::Msg(backend::Message::ReadyForQuery(b)) => {
                    self.tx = b.status();
                    return Ok(done);
                }
                Frame::Msg(backend::Message::CopyInResponse(_)) => {
                    frontend::copy_fail("COPY is not supported", &mut self.out)?;
                    self.flush().await?;
                }
                Frame::Msg(backend::Message::CopyOutResponse(_) | backend::Message::CopyData(_) | backend::Message::CopyDone) => {
                }
                Frame::Msg(backend::Message::NotificationResponse(_)) => {}
                Frame::Msg(other) => {
                    return Err(PgWireError::Protocol(format!("unexpected message in a query: {}", tag_of(&other))));
                }
                Frame::Key(_) | Frame::Negotiate { .. } => {
                    return Err(PgWireError::Protocol("startup message in a query".into()));
                }
            }
        }
    }

    /// The pg-cursor path: Parse / Bind (text results) / Describe portal / Execute(batch) + Flush until the portal is done,
    /// then Sync. Every value is the same text form as the simple protocol (both use the type's output function).
    pub async fn cursor_query(&mut self, sql: &str, batch: i32) -> Result<PgStatement, PgWireError> {
        frontend::parse("", sql, std::iter::empty(), &mut self.out)?;
        // no parameters, every result column in text format (what pg-cursor binds)
        frontend::bind(
            "",
            "",
            std::iter::empty::<i16>(),
            std::iter::empty::<()>(),
            |_: (), _| Ok(postgres_protocol::IsNull::Yes),
            std::iter::empty::<i16>(),
            &mut self.out,
        )
        .map_err(|_| PgWireError::Protocol("bind".into()))?;
        frontend::describe(b'P', "", &mut self.out)?;
        frontend::execute("", batch, &mut self.out)?;
        frontend::flush(&mut self.out);
        self.flush().await?;
        let mut cur = PgStatement::default();
        loop {
            match self.frame().await? {
                Frame::Msg(backend::Message::ParseComplete | backend::Message::BindComplete | backend::Message::NoData) => {}
                Frame::Fields(f) => cur.fields = Some(f),
                Frame::Msg(backend::Message::DataRow(row)) => cur.rows.push(data_row(&row)?),
                Frame::Msg(backend::Message::PortalSuspended) => {
                    frontend::execute("", batch, &mut self.out)?;
                    frontend::flush(&mut self.out);
                    self.flush().await?;
                }
                Frame::Tag(t) => {
                    cur.tag = Some(t);
                    break;
                }
                Frame::Msg(backend::Message::EmptyQueryResponse) => break,
                Frame::Error(e) => {
                    cur.error = Some(e);
                    break;
                }
                Frame::Notice(n) => self.notices.push(n),
                Frame::Param(k, v) => self.params.push((k, v)),
                Frame::Msg(other) => {
                    return Err(PgWireError::Protocol(format!("unexpected message in a cursor: {}", tag_of(&other))));
                }
                Frame::Key(_) | Frame::Negotiate { .. } => {
                    return Err(PgWireError::Protocol("startup message in a cursor".into()));
                }
            }
        }
        frontend::sync(&mut self.out);
        self.flush().await?;
        loop {
            match self.frame().await? {
                Frame::Msg(backend::Message::ReadyForQuery(b)) => {
                    self.tx = b.status();
                    return Ok(cur);
                }
                Frame::Notice(n) => self.notices.push(n),
                Frame::Param(k, v) => self.params.push((k, v)),
                _ => {}
            }
        }
    }

    pub async fn terminate(mut self) -> io::Result<()> {
        frontend::terminate(&mut self.out);
        self.flush().await?;
        self.stream.shutdown().await
    }
}

fn data_row(row: &backend::DataRowBody) -> io::Result<Row> {
    let buf = row.buffer();
    row.ranges().map(|r| Ok(r.map(|r| buf[r].to_vec()))).collect()
}

fn tag_of(m: &backend::Message) -> &'static str {
    match m {
        backend::Message::BindComplete => "BindComplete",
        backend::Message::CloseComplete => "CloseComplete",
        backend::Message::CopyInResponse(_) => "CopyInResponse",
        backend::Message::CopyOutResponse(_) => "CopyOutResponse",
        backend::Message::DataRow(_) => "DataRow",
        backend::Message::NoData => "NoData",
        backend::Message::ParameterDescription(_) => "ParameterDescription",
        backend::Message::ParseComplete => "ParseComplete",
        backend::Message::PortalSuspended => "PortalSuspended",
        backend::Message::ReadyForQuery(_) => "ReadyForQuery",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(tag: u8, body: &[u8]) -> BytesMut {
        let mut b = BytesMut::new();
        b.put_u8(tag);
        b.put_i32(body.len() as i32 + 4);
        b.put_slice(body);
        b
    }

    #[test]
    fn postgres_protocol_refuses_a_3_2_backend_key_and_ours_keeps_it() {
        let mut body = vec![0, 0, 0x30, 0x39];
        body.extend((0u8..32).collect::<Vec<_>>());
        let mut m = message(b'K', &body);
        assert!(backend::Message::parse(&mut m.clone()).is_err());
        match parse_frame(b'K', &mut m).unwrap() {
            Frame::Key(k) => assert_eq!(k, BackendKey { process_id: 12345, secret: (0u8..32).collect() }),
            _ => panic!("not a key"),
        }
    }

    #[test]
    fn postgres_protocol_does_not_know_negotiate_protocol_version() {
        let mut body = vec![0, 0, 0, 0, 0, 0, 0, 1];
        body.extend(b"_pq_.x\0");
        let mut m = message(b'v', &body);
        assert!(backend::Message::parse(&mut m.clone()).is_err());
        match parse_frame(b'v', &mut m).unwrap() {
            Frame::Negotiate { newest, unrecognized } => assert_eq!((newest, unrecognized), (0, vec!["_pq_.x".to_owned()])),
            _ => panic!("not a negotiate"),
        }
    }

    #[test]
    fn a_field_name_that_is_not_utf8_is_read_like_node() {
        let mut body = vec![0, 1];
        body.extend([b'a', 0xff, 0]);
        body.extend([0, 0, 0, 0, 0, 1, 0, 0, 0, 23, 0, 4, 0xff, 0xff, 0xff, 0xff, 0, 0]);
        let mut m = message(b'T', &body);
        // postgres-protocol parses lazily; its field iterator refuses the name
        let parsed = backend::Message::parse(&mut m.clone()).unwrap().unwrap();
        let backend::Message::RowDescription(rd) = parsed else { panic!("not a row description") };
        assert!(rd.fields().collect::<Vec<_>>().is_err());
        match parse_frame(b'T', &mut m).unwrap() {
            Frame::Fields(f) => assert_eq!(f[0].name, "a\u{fffd}"),
            _ => panic!("not fields"),
        }
    }

    #[test]
    fn cancel_request_bytes_for_both_key_sizes() {
        let short = cancel_bytes(&BackendKey { process_id: 7, secret: vec![1, 2, 3, 4] });
        assert_eq!(&short[..], &[0, 0, 0, 16, 0x04, 0xd2, 0x16, 0x2e, 0, 0, 0, 7, 1, 2, 3, 4]);
        let long = cancel_bytes(&BackendKey { process_id: 7, secret: vec![9; 32] });
        assert_eq!(long.len(), 44);
        assert_eq!(&long[..12], &[0, 0, 0, 44, 0x04, 0xd2, 0x16, 0x2e, 0, 0, 0, 7]);
    }

    #[test]
    fn startup_message_matches_node_postgres() {
        let cfg = PgConfig { user: "u".into(), database: "d".into(), password: None, protocol: Protocol::V3_0 };
        let b = startup_bytes(&cfg).unwrap();
        let mut expect = vec![0, 3, 0, 0];
        expect.extend(b"user\0u\0database\0d\0application_name\0unimux\0client_encoding\0UTF8\0\0");
        let mut whole = (expect.len() as i32 + 4).to_be_bytes().to_vec();
        whole.extend(expect);
        assert_eq!(&b[..], &whole[..]);
    }

    #[test]
    fn command_tags_like_node_postgres() {
        assert_eq!(parse_tag("SELECT 3"), (Some("SELECT".into()), Some(3)));
        assert_eq!(parse_tag("INSERT 0 5"), (Some("INSERT".into()), Some(5)));
        assert_eq!(parse_tag("CREATE TABLE"), (Some("CREATE".into()), None));
        assert_eq!(parse_tag("BEGIN"), (Some("BEGIN".into()), None));
        assert_eq!(parse_tag("FOO_BAR 3"), (Some("FOO".into()), None));
        assert_eq!(parse_tag("SELECT 3abc"), (Some("SELECT".into()), Some(3)));
        assert_eq!(parse_tag("1 x"), (None, None));
    }
}
