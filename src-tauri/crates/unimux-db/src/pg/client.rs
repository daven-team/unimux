//! One Postgres connection over any byte stream (TCP, TLS on TCP, a channel through the SSH tunnel): the startup (protocol
//! 3.0 pinned, `application_name=unimux`, `client_encoding=UTF8`, cleartext / MD5 / SCRAM-SHA-256 logins), the simple query
//! protocol with several results per text, one extended statement with text parameters, notices, the transaction state of
//! ReadyForQuery, and COPY (refused like node-postgres and drained).
//!
//! The frame layer is the SP9 one (`wire::pg`): BackendKeyData of any length, NegotiateProtocolVersion, and the strings of
//! RowDescription / errors / notices / ParameterStatus / command tags decoded lossily like Node.
//!
//! A ReadyForQuery that follows another one with no answer between them ends nothing the client sent (PGlite's socket
//! server sends extra ones); it is dropped, like the emit filter of 1.1.4's PgSession does.

use std::io;

use bytes::{BufMut, BytesMut};
use fallible_iterator::FallibleIterator;
use postgres_protocol::authentication::{md5_hash, sasl};
use postgres_protocol::message::{backend, frontend};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroizing;

use crate::wire::pg::{
    BackendKey, Frame, PgConfig, PgField, PgServerError, PgStatement, PgWireError, Protocol, Row, data_row, parse_frame,
    startup_bytes, tag_of,
};

/// A byte stream a connection runs on.
pub trait PgIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> PgIo for T {}

/// A boxed stream (what connectors hand out).
pub type PgStream = Box<dyn PgIo>;

/// The transaction state from ReadyForQuery (`DbTxStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxStatus {
    Idle,
    Transaction,
    Failed,
}

impl TxStatus {
    pub fn from_byte(b: u8) -> Self {
        match b {
            b'T' => TxStatus::Transaction,
            b'E' => TxStatus::Failed,
            _ => TxStatus::Idle,
        }
    }

    /// The `DbTxStatus` text.
    pub fn as_str(self) -> &'static str {
        match self {
            TxStatus::Idle => "idle",
            TxStatus::Transaction => "transaction",
            TxStatus::Failed => "failed",
        }
    }
}

/// What a statement run reports while it reads the server's answer (rows can be streamed from here).
pub trait QueryEvents: Send {
    /// The result columns of the current statement.
    fn fields(&mut self, _fields: &[PgField]) {}
    /// One row of the current statement.
    fn row(&mut self, row: Row);
    /// A notice (warnings, RAISE NOTICE).
    fn notice(&mut self, _notice: PgServerError) {}
    /// The current statement ended (command tag, empty query or error).
    fn statement_end(&mut self) {}
}

/// Collects the rows into the statements; notices go to a callback.
pub struct Collect<'a> {
    pub rows: Vec<Row>,
    pub fields: Option<Vec<PgField>>,
    pub on_notice: Option<&'a mut (dyn FnMut(PgServerError) + Send)>,
}

impl<'a> Collect<'a> {
    pub fn new(on_notice: Option<&'a mut (dyn FnMut(PgServerError) + Send)>) -> Self {
        Collect { rows: Vec::new(), fields: None, on_notice }
    }
}

impl QueryEvents for Collect<'_> {
    fn fields(&mut self, fields: &[PgField]) {
        self.fields = Some(fields.to_vec());
    }
    fn row(&mut self, row: Row) {
        self.rows.push(row);
    }
    fn notice(&mut self, notice: PgServerError) {
        if let Some(f) = self.on_notice.as_mut() {
            f(notice);
        }
    }
}

/// The end of one statement of a run (its rows went to [`QueryEvents::row`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatementEnd {
    /// Whether the statement had a result set (RowDescription).
    pub has_fields: bool,
    /// The command tag (None: empty query or error).
    pub tag: Option<String>,
    pub error: Option<PgServerError>,
    /// The statement was a COPY the client refused or drained.
    pub copy: bool,
}

/// Login data of one connection; the password stays in zeroized memory.
#[derive(Clone)]
pub struct StartupParams {
    pub user: String,
    pub database: String,
    pub password: Option<Zeroizing<String>>,
}

impl std::fmt::Debug for StartupParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartupParams").field("user", &self.user).field("database", &self.database).finish_non_exhaustive()
    }
}

/// node-postgres' text for the CopyFail it sends when a COPY FROM STDIN has no stream (pg/lib/query.js).
pub const COPY_FAIL_TEXT: &str = "No source stream defined";

/// Larger messages than this are refused (a server that announces more is broken or hostile; Postgres caps a message at
/// 1 GiB of field data).
const MAX_MESSAGE: usize = 1 << 30;

pub struct PgClient {
    stream: PgStream,
    buf: BytesMut,
    out: BytesMut,
    key: Option<BackendKey>,
    params: Vec<(String, String)>,
    tx: TxStatus,
    negotiated: Option<(i32, Vec<String>)>,
    tls: bool,
    /// The server answered something (not just a ReadyForQuery) since the last ReadyForQuery.
    heard: bool,
    /// Notices of the startup (kept for the caller).
    startup_notices: Vec<PgServerError>,
    broken: bool,
}

impl std::fmt::Debug for PgClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgClient")
            .field("key", &self.key.as_ref().map(|k| k.process_id))
            .field("tx", &self.tx)
            .field("tls", &self.tls)
            .finish()
    }
}

fn is_answer(f: &Frame) -> bool {
    match f {
        Frame::Fields(_) | Frame::Error(_) | Frame::Tag(_) => true,
        Frame::Msg(m) => matches!(
            m,
            backend::Message::ParseComplete
                | backend::Message::BindComplete
                | backend::Message::CloseComplete
                | backend::Message::NoData
                | backend::Message::PortalSuspended
                | backend::Message::EmptyQueryResponse
                | backend::Message::ParameterDescription(_)
                | backend::Message::DataRow(_)
                | backend::Message::CopyInResponse(_)
                | backend::Message::CopyOutResponse(_)
                | backend::Message::CopyData(_)
                | backend::Message::CopyDone
        ),
        _ => false,
    }
}

impl PgClient {
    /// Logs in on a stream (already TLS when `tls`). `NeedPassword` when the server asks for a password and none is given.
    pub async fn startup(stream: PgStream, tls: bool, login: &StartupParams) -> Result<Self, PgWireError> {
        let mut c = PgClient {
            stream,
            buf: BytesMut::with_capacity(16 * 1024),
            out: BytesMut::new(),
            key: None,
            params: Vec::new(),
            tx: TxStatus::Idle,
            negotiated: None,
            tls,
            heard: false,
            startup_notices: Vec::new(),
            broken: false,
        };
        let cfg =
            PgConfig { user: login.user.clone(), database: login.database.clone(), password: None, protocol: Protocol::V3_0 };
        c.out = startup_bytes(&cfg)?;
        c.flush().await?;
        let password = || login.password.as_ref().map(|p| p.as_str()).ok_or(PgWireError::NeedPassword);
        let mut scram: Option<sasl::ScramSha256> = None;
        loop {
            match c.frame().await? {
                Frame::Msg(backend::Message::AuthenticationOk) => {}
                Frame::Msg(backend::Message::AuthenticationCleartextPassword) => {
                    let pw = password()?;
                    frontend::password_message(pw.as_bytes(), &mut c.out)?;
                    c.flush().await?;
                }
                Frame::Msg(backend::Message::AuthenticationMd5Password(body)) => {
                    let pw = password()?;
                    let hash = Zeroizing::new(md5_hash(login.user.as_bytes(), pw.as_bytes(), body.salt()));
                    frontend::password_message(hash.as_bytes(), &mut c.out)?;
                    c.flush().await?;
                }
                Frame::Msg(backend::Message::AuthenticationSasl(body)) => {
                    let mechanisms: Vec<String> = body.mechanisms().map(|m| Ok(m.to_owned())).collect()?;
                    if !mechanisms.iter().any(|m| m == sasl::SCRAM_SHA_256) {
                        return Err(PgWireError::Protocol("SASL: Only mechanism SCRAM-SHA-256 is currently supported".into()));
                    }
                    let pw = password()?;
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
                Frame::Msg(
                    backend::Message::AuthenticationGss
                    | backend::Message::AuthenticationKerberosV5
                    | backend::Message::AuthenticationScmCredential
                    | backend::Message::AuthenticationSspi
                    | backend::Message::AuthenticationGssContinue(_),
                ) => return Err(PgWireError::Protocol("the server asks for a login method unimux does not support".into())),
                Frame::Key(k) => c.key = Some(k),
                Frame::Negotiate { newest, unrecognized } => c.negotiated = Some((newest, unrecognized)),
                Frame::Param(k, v) => c.params.push((k, v)),
                Frame::Notice(n) => c.startup_notices.push(n),
                Frame::Error(e) => return Err(PgWireError::Server(e)),
                Frame::Msg(backend::Message::ReadyForQuery(b)) => {
                    c.tx = TxStatus::from_byte(b.status());
                    return Ok(c);
                }
                Frame::Msg(other) => {
                    return Err(PgWireError::Protocol(format!("unexpected message during startup: {}", tag_of(&other))));
                }
                Frame::Fields(_) | Frame::Tag(_) => return Err(PgWireError::Protocol("unexpected result during startup".into())),
            }
        }
    }

    /// BackendKeyData (pid and secret for a cancel).
    pub fn key(&self) -> Option<&BackendKey> {
        self.key.as_ref()
    }

    pub fn process_id(&self) -> Option<i32> {
        self.key.as_ref().map(|k| k.process_id)
    }

    /// The last value of a ParameterStatus (`server_version`, `client_encoding`, ...).
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    pub fn tx(&self) -> TxStatus {
        self.tx
    }

    /// The connection runs over TLS.
    pub fn tls(&self) -> bool {
        self.tls
    }

    /// NegotiateProtocolVersion of the startup, if the server sent one.
    pub fn negotiated(&self) -> Option<&(i32, Vec<String>)> {
        self.negotiated.as_ref()
    }

    pub fn take_startup_notices(&mut self) -> Vec<PgServerError> {
        std::mem::take(&mut self.startup_notices)
    }

    /// An I/O or protocol error happened: the connection cannot be used any more.
    pub fn is_broken(&self) -> bool {
        self.broken
    }

    async fn flush(&mut self) -> io::Result<()> {
        let out = self.out.split();
        let r = async {
            self.stream.write_all(&out).await?;
            self.stream.flush().await
        }
        .await;
        if r.is_err() {
            self.broken = true;
        }
        r
    }

    async fn frame(&mut self) -> io::Result<Frame> {
        let r = self.read_frame().await;
        if r.is_err() {
            self.broken = true;
        }
        r
    }

    async fn read_frame(&mut self) -> io::Result<Frame> {
        loop {
            if self.buf.len() >= 5 {
                let len = i32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]);
                if len < 4 || len as usize > MAX_MESSAGE {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, format!("bad message length {len}")));
                }
                let total = 1 + len as usize;
                if self.buf.len() >= total {
                    let tag = self.buf[0];
                    let mut whole = self.buf.split_to(total);
                    return parse_frame(tag, &mut whole);
                }
                // grows with the data that arrives, never by what the length claims
                self.buf.reserve((total - self.buf.len()).min(1 << 20));
            }
            if self.stream.read_buf(&mut self.buf).await? == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Connection terminated unexpectedly"));
            }
        }
    }

    /// The next message after the startup, without stray ReadyForQuery messages.
    async fn next(&mut self) -> io::Result<Frame> {
        loop {
            let f = self.frame().await?;
            if let Frame::Msg(backend::Message::ReadyForQuery(_)) = &f {
                if !self.heard {
                    continue;
                }
                self.heard = false;
            } else if is_answer(&f) {
                self.heard = true;
            }
            return Ok(f);
        }
    }

    fn check_usable(&self) -> Result<(), PgWireError> {
        if self.broken {
            Err(PgWireError::Io(io::Error::new(io::ErrorKind::NotConnected, "Connection terminated")))
        } else {
            Ok(())
        }
    }

    /// A simple-protocol run (Query): one [`StatementEnd`] per statement of the text, up to the first error (the server
    /// stops there). Rows and notices go to `events`. COPY FROM STDIN is refused with node-postgres' CopyFail text (the
    /// server answers 57014); COPY TO STDOUT is read and dropped.
    pub async fn simple_query_with(&mut self, sql: &str, events: &mut dyn QueryEvents) -> Result<Vec<StatementEnd>, PgWireError> {
        self.check_usable()?;
        frontend::query(sql, &mut self.out)?;
        self.flush().await?;
        let mut done = Vec::new();
        let mut cur = StatementEnd::default();
        loop {
            match self.next().await? {
                Frame::Fields(f) => {
                    cur.has_fields = true;
                    events.fields(&f);
                }
                Frame::Msg(backend::Message::DataRow(row)) => events.row(data_row(&row)?),
                Frame::Tag(t) => {
                    cur.tag = Some(t);
                    done.push(std::mem::take(&mut cur));
                    events.statement_end();
                }
                Frame::Msg(backend::Message::EmptyQueryResponse) => {
                    done.push(std::mem::take(&mut cur));
                    events.statement_end();
                }
                Frame::Error(e) => {
                    cur.error = Some(e);
                    done.push(std::mem::take(&mut cur));
                    events.statement_end();
                }
                Frame::Notice(n) => events.notice(n),
                Frame::Param(k, v) => self.params.push((k, v)),
                Frame::Msg(backend::Message::ReadyForQuery(b)) => {
                    self.tx = TxStatus::from_byte(b.status());
                    return Ok(done);
                }
                Frame::Msg(backend::Message::CopyInResponse(_)) => {
                    cur.copy = true;
                    frontend::copy_fail(COPY_FAIL_TEXT, &mut self.out)?;
                    self.flush().await?;
                }
                Frame::Msg(backend::Message::CopyOutResponse(_)) => cur.copy = true,
                Frame::Msg(backend::Message::CopyData(_) | backend::Message::CopyDone) => {}
                Frame::Msg(backend::Message::NotificationResponse(_)) => {}
                Frame::Msg(other) => {
                    self.broken = true;
                    return Err(PgWireError::Protocol(format!("unexpected message in a query: {}", tag_of(&other))));
                }
                Frame::Key(_) | Frame::Negotiate { .. } => {
                    self.broken = true;
                    return Err(PgWireError::Protocol("startup message in a query".into()));
                }
            }
        }
    }

    /// [`simple_query_with`](Self::simple_query_with) that collects every statement's rows.
    pub async fn simple_query(
        &mut self,
        sql: &str,
        on_notice: Option<&mut (dyn FnMut(PgServerError) + Send)>,
    ) -> Result<Vec<PgStatement>, PgWireError> {
        let mut events = SplitCollect { statements: Vec::new(), cur: PgStatement::default(), on_notice };
        let ends = self.simple_query_with(sql, &mut events).await?;
        let mut out = Vec::with_capacity(ends.len());
        let mut parts = events.statements.into_iter();
        for end in ends {
            let mut s = parts.next().unwrap_or_default();
            s.tag = end.tag;
            s.error = end.error;
            out.push(s);
        }
        Ok(out)
    }

    /// One statement through the extended protocol (unnamed statement and portal, text parameters, text results, then
    /// Sync): what node-postgres does for `client.query({ text, values })`.
    pub async fn query_params(
        &mut self,
        sql: &str,
        params: &[Option<&str>],
        events: &mut dyn QueryEvents,
    ) -> Result<StatementEnd, PgWireError> {
        self.check_usable()?;
        frontend::parse("", sql, std::iter::empty(), &mut self.out)?;
        frontend::bind(
            "",
            "",
            std::iter::empty::<i16>(),
            params.iter(),
            |p: &Option<&str>, buf: &mut BytesMut| match p {
                Some(v) => {
                    buf.put_slice(v.as_bytes());
                    Ok(postgres_protocol::IsNull::No)
                }
                None => Ok(postgres_protocol::IsNull::Yes),
            },
            std::iter::empty::<i16>(),
            &mut self.out,
        )
        .map_err(|_| PgWireError::Protocol("bind".into()))?;
        frontend::describe(b'P', "", &mut self.out)?;
        frontend::execute("", 0, &mut self.out)?;
        frontend::sync(&mut self.out);
        self.flush().await?;
        let mut end = StatementEnd::default();
        loop {
            match self.next().await? {
                Frame::Msg(backend::Message::ParseComplete | backend::Message::BindComplete | backend::Message::NoData) => {}
                Frame::Fields(f) => {
                    end.has_fields = true;
                    events.fields(&f);
                }
                Frame::Msg(backend::Message::DataRow(row)) => events.row(data_row(&row)?),
                Frame::Tag(t) => end.tag = Some(t),
                Frame::Msg(backend::Message::EmptyQueryResponse) => {}
                Frame::Error(e) => end.error = Some(e),
                Frame::Notice(n) => events.notice(n),
                Frame::Param(k, v) => self.params.push((k, v)),
                Frame::Msg(backend::Message::ReadyForQuery(b)) => {
                    self.tx = TxStatus::from_byte(b.status());
                    return Ok(end);
                }
                Frame::Msg(backend::Message::CopyInResponse(_)) => {
                    end.copy = true;
                    frontend::copy_fail(COPY_FAIL_TEXT, &mut self.out)?;
                    self.flush().await?;
                }
                Frame::Msg(backend::Message::CopyOutResponse(_)) => end.copy = true,
                Frame::Msg(backend::Message::CopyData(_) | backend::Message::CopyDone) => {}
                Frame::Msg(backend::Message::NotificationResponse(_)) => {}
                Frame::Msg(other) => {
                    self.broken = true;
                    return Err(PgWireError::Protocol(format!("unexpected message in a statement: {}", tag_of(&other))));
                }
                Frame::Key(_) | Frame::Negotiate { .. } => {
                    self.broken = true;
                    return Err(PgWireError::Protocol("startup message in a statement".into()));
                }
            }
        }
    }

    /// The first column of the first row of a one-statement run (`SHOW server_version`, `SELECT pg_cancel_backend(...)`);
    /// a server error is returned as `PgWireError::Server`.
    pub async fn query_value(&mut self, sql: &str, params: &[Option<&str>]) -> Result<Option<String>, PgWireError> {
        let mut events = Collect::new(None);
        let end = if params.is_empty() {
            let ends = self.simple_query_with(sql, &mut events).await?;
            ends.into_iter().find(|e| e.error.is_some()).unwrap_or_default()
        } else {
            self.query_params(sql, params, &mut events).await?
        };
        if let Some(e) = end.error {
            return Err(PgWireError::Server(e));
        }
        Ok(events.rows.into_iter().next().and_then(|r| r.into_iter().next().flatten()).map(|b| crate::wire::value::node_utf8(&b)))
    }

    /// Runs a statement that must succeed (`SET ...`); its server error is returned.
    pub async fn execute(&mut self, sql: &str) -> Result<(), PgWireError> {
        let mut events = Collect::new(None);
        let ends = self.simple_query_with(sql, &mut events).await?;
        match ends.into_iter().find_map(|e| e.error) {
            Some(e) => Err(PgWireError::Server(e)),
            None => Ok(()),
        }
    }

    /// Says goodbye (Terminate) and closes the stream; errors are ignored (`client.end()`).
    pub async fn end(mut self) {
        if !self.broken {
            frontend::terminate(&mut self.out);
            let _ = self.flush().await;
        }
        let _ = self.stream.shutdown().await;
    }
}

/// Collects rows per statement for [`PgClient::simple_query`].
struct SplitCollect<'a> {
    statements: Vec<PgStatement>,
    cur: PgStatement,
    on_notice: Option<&'a mut (dyn FnMut(PgServerError) + Send)>,
}

impl QueryEvents for SplitCollect<'_> {
    fn fields(&mut self, fields: &[PgField]) {
        self.cur.fields = Some(fields.to_vec());
    }
    fn statement_end(&mut self) {
        self.statements.push(std::mem::take(&mut self.cur));
    }
    fn row(&mut self, row: Row) {
        self.cur.rows.push(row);
    }
    fn notice(&mut self, notice: PgServerError) {
        if let Some(f) = self.on_notice.as_mut() {
            f(notice);
        }
    }
}
