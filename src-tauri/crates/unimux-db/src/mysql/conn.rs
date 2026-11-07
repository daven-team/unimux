//! One MySQL / MariaDB connection: the login as mysql2 3.24 does it (1.1.4: `mysql.createConnection` in
//! src/dbhost/host.ts), and COM_QUERY in the text protocol as a stream of events the caller pulls.
//!
//! Login: the client flags of mysql2 (`0x08baf3cf`, plus MULTI_FACTOR_AUTHENTICATION when the server offers it, without
//! DEPRECATE_EOF; MariaDB's extended metadata asked for when offered, which turns CLIENT_MYSQL off), collation 45
//! (utf8mb4_general_ci), max packet 0, the SSL request before the credentials when TLS is on, then HandshakeResponse41
//! with the token mysql2 picks: the server's plugin when it is mysql_native_password or caching_sha2_password (or
//! sha256_password over TLS), else a mysql_native_password token and the server switches. The plugins are mysql_common's
//! (`AuthProc`): native, caching_sha2 (fast path; full authentication sends the password in clear over TLS and RSA-OAEP
//! encrypted with the server's public key otherwise), sha256_password and, new in 1.2.0, MariaDB's client_ed25519.
//! mysql_clear_password is refused like mysql2 does without `enableCleartextPlugin`, and so is any other plugin.
//!
//! Queries: the caller pulls one event at a time ([`MyConn::next_event`]), so a result that is not read leaves its rows in
//! the socket and TCP flow control stops the server: that is the back-pressure (mysql2 paused the socket at 2,000 rows /
//! 8 MiB; [`super::stream::MyStream`] keeps that read-ahead bound). Several results (CALL) follow each other while the
//! server sets SERVER_MORE_RESULTS_EXISTS. The OK and EOF packets' status flags are kept ([`MyConn::status`]); the
//! session-state block of an OK switches the client charset like mysql2 (`character_set_client`).

use std::time::Duration;

use bytes::Bytes;
use mysql_common::auth::plugins::{AuthProc, ChallengeResponsePlugin, Context, Response};
use mysql_common::constants::{CapabilityFlags, MariadbCapabilities, StatusFlags};
use mysql_common::io::ParseBuf;
use mysql_common::packets::{
    AuthPlugin, CommonOkPacket, ErrPacket, HandshakePacket, OkPacket, OkPacketDeserializer, OldEofPacket,
};
use tokio::io::{AsyncRead, AsyncWrite};
use zeroize::Zeroizing;

use super::error::{MyError, MyServerError};
use super::packet::{MaybeTls, PacketIo, RawRow, lenenc};
use super::tls::{MyTlsParams, upgrade};
use crate::wire::mycharset::{charset_of_name, enc_of, encode, unknown_encoding_message};
use crate::wire::mysql::{
    LoginTrace, MyColumn, MyResult, local_infile_message, mysql2_default_flags, parse_column, tracked_client_charset,
};
use crate::wire::value::node_utf8;

/// mysql2's `charsetNumber` for `charset: 'utf8mb4'` (utf8mb4_general_ci).
pub const UTF8MB4_GENERAL_CI: u16 = 45;
const SERVER_STATUS_IN_TRANS: u16 = 0x0001;

/// The login of one connection. The password is wiped when dropped.
#[derive(Clone)]
pub struct MyLogin {
    pub user: String,
    pub password: Zeroizing<String>,
    /// The default database ('' for none: the side connection for KILL QUERY, or a connection without one).
    pub database: String,
}

impl std::fmt::Debug for MyLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MyLogin").field("user", &self.user).field("database", &self.database).finish_non_exhaustive()
    }
}

/// An OK packet: a statement without rows, or the end of a CALL.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MyOk {
    /// Matched rows for an UPDATE (CLIENT_FOUND_ROWS), like mysql2's `affectedRows`.
    pub affected_rows: u64,
    pub last_insert_id: Option<u64>,
    pub status: u16,
    pub warnings: u16,
    pub info: String,
}

impl MyOk {
    pub fn in_transaction(&self) -> bool {
        self.status & SERVER_STATUS_IN_TRANS != 0
    }

    pub fn more_results(&self) -> bool {
        StatusFlags::from_bits_retain(self.status).contains(StatusFlags::SERVER_MORE_RESULTS_EXISTS)
    }
}

/// What a running statement answered next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MyEvent {
    /// A result set starts: its columns (mysql2 'fields').
    Fields(Vec<MyColumn>),
    /// A row of the current result set (mysql2 'result' with an array).
    Row(RawRow),
    /// The current result set ended (its EOF packet).
    SetEnd { status: u16, warnings: u16 },
    /// A result without rows (mysql2 'result' with a ResultSetHeader).
    Ok(MyOk),
    /// The statement failed on the server; nothing follows.
    Error(MyServerError),
    /// LOAD DATA LOCAL INFILE was answered with an empty file and fails like mysql2 (`local_infile_message`).
    ClientError(String),
}

/// A statement read whole (`exec` of mysqlSession): the first result set, and the last OK packet (a CALL ends with one).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MyExec {
    pub fields: Option<Vec<MyColumn>>,
    pub rows: Vec<RawRow>,
    pub header: Option<MyOk>,
}

#[derive(Debug)]
enum Phase {
    /// Waiting for the next result's first packet (OK, ERR, LOCAL INFILE request, or a column count).
    Header,
    Columns {
        left: usize,
        columns: Vec<MyColumn>,
    },
    ColumnsEof {
        columns: Vec<MyColumn>,
    },
    Rows {
        count: usize,
    },
}

#[derive(Debug)]
enum State {
    Idle,
    Query {
        phase: Phase,
        infile: Option<String>,
    },
    /// A fatal error happened: the connection must be dropped.
    Broken(MyError),
}

struct Ctx<'a> {
    pass: &'a [u8],
    scramble: &'a [u8],
    tls: bool,
}

impl Context for &Ctx<'_> {
    fn pass(&self) -> &[u8] {
        self.pass
    }
    fn is_ipc_transport(&self) -> bool {
        false
    }
    fn is_tls_transport(&self) -> bool {
        self.tls
    }
    fn scramble(&self) -> &[u8] {
        self.scramble
    }
    fn server_key_pem(&self) -> Option<&[u8]> {
        None
    }
}

/// mysql2's error for a plugin it cannot run (auth_switch.js).
fn unknown_plugin(name: &str) -> MyError {
    MyError::Auth(format!(
        "Server requests authentication using unknown plugin {name}. See TODO: add plugins doco here on how to configure or author authentication plugins."
    ))
}

const CLEAR_PASSWORD_REFUSED: &str = "Server requested authentication using mysql_clear_password, which sends the password in plaintext over the network and is disabled by default. To enable it, set the `enableCleartextPlugin` option to `true` in your connection configuration, or provide a custom `mysql_clear_password` auth plugin via the `authPlugins` option. Only use this over a secure connection (TLS/SSL).";

/// The plugins this client runs after a switch (mysql2's four less mysql_clear_password, plus client_ed25519).
fn switch_plugin(plugin: &AuthPlugin<'_>) -> Result<AuthProc, MyError> {
    match plugin {
        AuthPlugin::MysqlNativePassword | AuthPlugin::CachingSha2Password | AuthPlugin::Sha256Password | AuthPlugin::Ed25519 => {
            AuthProc::init(plugin).map_err(|e| MyError::Auth(e.to_string()))
        }
        AuthPlugin::MysqlClearPassword => Err(MyError::Auth(CLEAR_PASSWORD_REFUSED.into())),
        other => Err(unknown_plugin(&String::from_utf8_lossy(other.as_bytes()))),
    }
}

fn auth_err(e: mysql_common::auth::plugins::Error) -> MyError {
    MyError::Auth(e.to_string())
}

/// The data of an AuthSwitchRequest: the 20-byte scramble comes with a terminating NUL (21 bytes), ed25519's 32-byte
/// nonce may too (33).
fn switch_data(data: &[u8]) -> &[u8] {
    match data {
        [rest @ .., 0] if rest.len() == 20 || rest.len() == 32 => rest,
        _ => data,
    }
}

fn put_lenenc(out: &mut Vec<u8>, n: usize) {
    let n = n as u64;
    if n < 251 {
        out.push(n as u8);
    } else if n < 1 << 16 {
        out.push(0xfc);
        out.extend_from_slice(&(n as u16).to_le_bytes());
    } else if n < 1 << 24 {
        out.push(0xfd);
        out.extend_from_slice(&n.to_le_bytes()[..3]);
    } else {
        out.push(0xfe);
        out.extend_from_slice(&n.to_le_bytes());
    }
}

/// The connection attributes (performance_schema.session_connect_attrs). 1.1.4 sent mysql2's
/// `_client_name: Node-MySQL-2`; 1.2.0 names itself (decision recorded in PROGRESS.md D7).
pub fn connect_attributes() -> [(&'static str, &'static str); 2] {
    [("_client_name", "unimux"), ("_client_version", env!("CARGO_PKG_VERSION"))]
}

/// The first 32 bytes of mysql2's SSLRequest and HandshakeResponse: flags, max packet 0, charset, 19 zero bytes, the
/// MariaDB extended capabilities.
fn handshake_head(out: &mut Vec<u8>, caps: CapabilityFlags, charset: u16, ext: MariadbCapabilities) {
    out.extend_from_slice(&caps.bits().to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.push(charset as u8);
    out.extend_from_slice(&[0u8; 19]);
    out.extend_from_slice(&ext.bits().to_le_bytes());
}

/// mysql2's HandshakeResponse (packets/handshake_response.js), byte for byte. The user and the database are written in
/// the client encoding (utf8 for collation 45), the plugin name in latin1.
pub fn handshake_response(
    caps: CapabilityFlags,
    ext: MariadbCapabilities,
    charset: u16,
    login: &MyLogin,
    token: &[u8],
    plugin: &str,
) -> Vec<u8> {
    let enc = enc_of(charset);
    let text = |s: &str| encode(s, enc).unwrap_or_else(|_| s.as_bytes().to_vec());
    let mut out = Vec::with_capacity(128 + token.len());
    handshake_head(&mut out, caps, charset, ext);
    out.extend(text(&login.user));
    out.push(0);
    if caps.contains(CapabilityFlags::CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA) {
        put_lenenc(&mut out, token.len());
        out.extend_from_slice(token);
    } else if caps.contains(CapabilityFlags::CLIENT_SECURE_CONNECTION) {
        out.push(token.len() as u8);
        out.extend_from_slice(token);
    } else {
        out.extend_from_slice(token);
        out.push(0);
    }
    if caps.contains(CapabilityFlags::CLIENT_CONNECT_WITH_DB) {
        out.extend(text(&login.database));
        out.push(0);
    }
    if caps.contains(CapabilityFlags::CLIENT_PLUGIN_AUTH) {
        out.extend(plugin.bytes());
        out.push(0);
    }
    if caps.contains(CapabilityFlags::CLIENT_CONNECT_ATTRS) {
        let mut attrs = Vec::new();
        for (k, v) in connect_attributes() {
            for s in [k, v] {
                let b = text(s);
                put_lenenc(&mut attrs, b.len());
                attrs.extend(b);
            }
        }
        put_lenenc(&mut out, attrs.len());
        out.extend(attrs);
    }
    out
}

/// One connection.
pub struct MyConn<S> {
    io: PacketIo<S>,
    state: State,
    /// The flags this client sent.
    pub caps: CapabilityFlags,
    pub server_caps: CapabilityFlags,
    pub mariadb_ext: MariadbCapabilities,
    pub server_version: String,
    /// The server's thread id (mysql2 `threadId`), for KILL QUERY on a side connection.
    pub connection_id: u32,
    pub login: LoginTrace,
    /// mysql2's `config.charsetNumber`: 45, then whatever `character_set_client` the server's session tracking reports.
    /// COM_QUERY text is encoded in it.
    pub client_charset: u16,
    /// The status flags of the last OK or EOF packet.
    pub status: u16,
    /// The connection runs over TLS.
    pub tls: bool,
}

impl<S> std::fmt::Debug for MyConn<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MyConn")
            .field("server_version", &self.server_version)
            .field("connection_id", &self.connection_id)
            .field("tls", &self.tls)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> MyConn<S> {
    /// The capabilities both sides have: what the server's packets are parsed with.
    fn wire_caps(&self) -> CapabilityFlags {
        self.caps & self.server_caps
    }

    fn server_error(&self, p: &[u8]) -> MyError {
        match ParseBuf(p).parse::<ErrPacket>(self.wire_caps()) {
            Ok(ErrPacket::Error(e)) => MyError::Server(MyServerError {
                code: e.error_code(),
                state: e.sql_state_ref().map(|s| s.as_str().into_owned()).unwrap_or_default(),
                message: node_utf8(e.message_ref()),
            }),
            Ok(ErrPacket::Progress(_)) => MyError::Protocol("progress report".into()),
            Err(e) => MyError::Protocol(e.to_string()),
        }
    }

    /// Logs in over `stream` (TCP or an SSH channel), upgrading to TLS first when `tls` is given.
    pub async fn connect(stream: S, login: &MyLogin, tls: Option<&MyTlsParams>) -> Result<Self, MyError> {
        let mut c = MyConn {
            io: PacketIo::new(stream),
            state: State::Idle,
            caps: CapabilityFlags::empty(),
            server_caps: CapabilityFlags::empty(),
            mariadb_ext: MariadbCapabilities::empty(),
            server_version: String::new(),
            connection_id: 0,
            login: LoginTrace::default(),
            client_charset: UTF8MB4_GENERAL_CI,
            status: 0,
            tls: false,
        };
        let hello = c.io.read_packet().await?;
        if hello.first() == Some(&0xff) {
            return Err(c.server_error(&hello));
        }
        let hs: HandshakePacket = ParseBuf(&hello).parse(()).map_err(|e| MyError::Protocol(e.to_string()))?;
        c.server_caps = hs.capabilities();
        c.server_version = node_utf8(hs.server_version_ref());
        c.connection_id = hs.connection_id();
        let mut caps = mysql2_default_flags();
        caps |= c.server_caps & CapabilityFlags::MULTI_FACTOR_AUTHENTICATION;
        let mut ext = MariadbCapabilities::empty();
        // mysql2: a MariaDB server offering extended metadata gets it asked for, which needs CLIENT_MYSQL (LONG_PASSWORD) off
        if hs.mariadb_ext_capabilities().contains(MariadbCapabilities::MARIADB_CLIENT_EXTENDED_METADATA) {
            caps.remove(CapabilityFlags::CLIENT_LONG_PASSWORD);
            ext |= MariadbCapabilities::MARIADB_CLIENT_EXTENDED_METADATA;
        }
        if let Some(params) = tls {
            if !c.server_caps.contains(CapabilityFlags::CLIENT_SSL) {
                return Err(MyError::TlsUnsupported);
            }
            caps |= CapabilityFlags::CLIENT_SSL;
            let mut req = Vec::with_capacity(32);
            handshake_head(&mut req, caps, c.client_charset, ext);
            c.io.write_packet(&req).await?;
            if c.io.buffered() > 0 {
                return Err(MyError::Tls("the server sent data before the TLS handshake".into()));
            }
            let MaybeTls::Plain(plain) = std::mem::replace(&mut c.io.stream, MaybeTls::Upgrading) else {
                return Err(MyError::Protocol("TLS upgrade twice".into()));
            };
            c.io.stream = MaybeTls::Tls(Box::new(upgrade(plain, params).await?));
            c.tls = true;
        }
        c.caps = caps;
        c.mariadb_ext = ext;

        let mut nonce = hs.nonce();
        nonce.truncate(20);
        let server_plugin = hs.auth_plugin().map(|p| p.into_owned()).unwrap_or(AuthPlugin::MysqlNativePassword);
        c.login.first_plugin = String::from_utf8_lossy(server_plugin.as_bytes()).into_owned();
        let pass = login.password.as_bytes();
        // mysql2's choice of the first token (client_handshake.js canUseAuthMethodDirectly)
        let (plugin, token, mut proc): (AuthPlugin<'static>, Zeroizing<Vec<u8>>, Option<AuthProc>) = match &server_plugin {
            AuthPlugin::CachingSha2Password | AuthPlugin::MysqlNativePassword => {
                let mut p = AuthProc::init(&server_plugin).map_err(|e| MyError::Auth(e.to_string()))?;
                let ctx = Ctx { pass, scramble: &nonce, tls: c.tls };
                let first = p.run(&ctx, &nonce).map_err(auth_err)?;
                (server_plugin.clone(), Zeroizing::new(first.data().map(<[u8]>::to_vec).unwrap_or_default()), Some(p))
            }
            AuthPlugin::Sha256Password if c.tls => {
                let token = if pass.is_empty() { Vec::new() } else { [pass, &[0]].concat() };
                (server_plugin.clone(), Zeroizing::new(token), None)
            }
            _ => {
                let mut p = AuthProc::init(&AuthPlugin::MysqlNativePassword).map_err(|e| MyError::Auth(e.to_string()))?;
                let ctx = Ctx { pass, scramble: &nonce, tls: c.tls };
                let first = p.run(&ctx, &nonce).map_err(auth_err)?;
                (AuthPlugin::MysqlNativePassword, Zeroizing::new(first.data().map(<[u8]>::to_vec).unwrap_or_default()), None)
            }
        };
        let plugin_name = String::from_utf8_lossy(plugin.as_bytes()).into_owned();
        let resp = Zeroizing::new(handshake_response(caps, ext, c.client_charset, login, &token, &plugin_name));
        c.io.write_packet(&resp).await?;
        let mut scramble = nonce;
        loop {
            let p = c.io.read_packet().await?;
            match p.first() {
                Some(0x00) => {
                    if let Ok(ok) = ParseBuf(&p).parse::<OkPacketDeserializer<CommonOkPacket>>(c.wire_caps()) {
                        let ok: OkPacket = ok.into();
                        c.status = ok.status_flags().bits();
                        c.track_charset(&ok);
                    }
                    return Ok(c);
                }
                Some(0xff) => return Err(c.server_error(&p)),
                // AuthSwitchRequest, or AuthNextFactor (0x02) of a multi-factor login: mysql2 answers both the same way
                // (with the same password, as it has no second one)
                Some(0xfe | 0x02) => {
                    let body = &p[1..];
                    let Some(nul) = body.iter().position(|&b| b == 0) else {
                        return Err(unknown_plugin(""));
                    };
                    let next = AuthPlugin::from_bytes(&body[..nul]).into_owned();
                    let data = switch_data(&body[nul + 1..]).to_vec();
                    c.login.switched_to = Some(String::from_utf8_lossy(next.as_bytes()).into_owned());
                    let mut p = switch_plugin(&next)?;
                    scramble = data.clone();
                    let ctx = Ctx { pass, scramble: &scramble, tls: c.tls };
                    let r = p.run(&ctx, &data).map_err(auth_err)?;
                    proc = Some(p);
                    c.send_auth(r).await?;
                }
                Some(0x01) => {
                    let data = p[1..].to_vec();
                    if data.len() == 1 {
                        c.login.cache_state = Some(data[0]);
                    }
                    let Some(p) = proc.as_mut() else {
                        return Err(MyError::Auth("AuthPluginMoreData received but no auth plugin instance found".into()));
                    };
                    let ctx = Ctx { pass, scramble: &scramble, tls: c.tls };
                    let r = p.run(&ctx, &data).map_err(auth_err)?;
                    if r.data() == Some(&[0x02][..]) {
                        c.login.requested_public_key = true;
                    }
                    c.send_auth(r).await?;
                }
                _ => return Err(MyError::Protocol("Unexpected packet during handshake phase".into())),
            }
        }
    }

    async fn send_auth(&mut self, r: Response) -> Result<(), MyError> {
        match r.data() {
            Some(d) => {
                let d = Zeroizing::new(d.to_vec());
                self.io.write_packet(&d).await
            }
            None => Ok(()),
        }
    }

    fn track_charset(&mut self, ok: &OkPacket<'_>) {
        if let Some(name) = ok.session_state_info_ref().and_then(tracked_client_charset)
            && let Some(n) = charset_of_name(&name)
        {
            self.client_charset = n;
        }
    }

    fn mariadb_extended(&self) -> bool {
        self.mariadb_ext.contains(MariadbCapabilities::MARIADB_CLIENT_EXTENDED_METADATA)
    }

    /// The server reported an open transaction in its last status.
    pub fn in_transaction(&self) -> bool {
        self.status & SERVER_STATUS_IN_TRANS != 0
    }

    /// No statement is being read.
    pub fn is_idle(&self) -> bool {
        matches!(self.state, State::Idle)
    }

    /// The fatal error the connection ended with, if any.
    pub fn broken(&self) -> Option<&MyError> {
        match &self.state {
            State::Broken(e) => Some(e),
            _ => None,
        }
    }

    fn fail(&mut self, e: MyError) -> MyError {
        if e.is_fatal() {
            self.state = State::Broken(e.clone());
        }
        e
    }

    /// Sends a statement (COM_QUERY, text protocol). Its answer is read with [`MyConn::next_event`]; nothing else can be
    /// sent until that returned None.
    pub async fn start_query(&mut self, sql: &str) -> Result<(), MyError> {
        match &self.state {
            State::Idle => {}
            State::Broken(e) => return Err(e.clone()),
            State::Query { .. } => return Err(MyError::Busy),
        }
        let text = match encode(sql, enc_of(self.client_charset)) {
            Ok(t) => t,
            Err(name) => return Err(MyError::Encoding(unknown_encoding_message(name))),
        };
        self.io.reset_seq();
        let mut payload = Vec::with_capacity(text.len() + 3);
        payload.push(0x03);
        if (self.caps & self.server_caps).contains(CapabilityFlags::CLIENT_QUERY_ATTRIBUTES) {
            // parameter_count 0, parameter_set_count 1 (what mysql2 writes with no attributes)
            payload.extend_from_slice(&[0x00, 0x01]);
        }
        payload.extend_from_slice(&text);
        if let Err(e) = self.io.write_packet(&payload).await {
            return Err(self.fail(e));
        }
        self.state = State::Query { phase: Phase::Header, infile: None };
        Ok(())
    }

    /// The next event of the running statement; None once it ended (then the connection takes the next command). Cancel
    /// safe: dropping the future between packets loses nothing.
    pub async fn next_event(&mut self) -> Result<Option<MyEvent>, MyError> {
        loop {
            match &self.state {
                State::Idle => return Ok(None),
                State::Broken(e) => return Err(e.clone()),
                State::Query { .. } => {}
            }
            let p = match self.io.read_packet().await {
                Ok(p) => p,
                Err(e) => return Err(self.fail(e)),
            };
            match self.step(p).await {
                Ok(Some(ev)) => return Ok(Some(ev)),
                Ok(None) => {}
                Err(e) => return Err(self.fail(e)),
            }
        }
    }

    /// One packet of the running statement.
    async fn step(&mut self, p: Bytes) -> Result<Option<MyEvent>, MyError> {
        let State::Query { phase, infile } = std::mem::replace(&mut self.state, State::Idle) else {
            return Ok(None);
        };
        match phase {
            Phase::Header => match p.first() {
                Some(0x00) => {
                    let ok: OkPacket = ParseBuf(&p)
                        .parse::<OkPacketDeserializer<CommonOkPacket>>(self.wire_caps())
                        .map_err(|e| MyError::Protocol(e.to_string()))?
                        .into();
                    self.track_charset(&ok);
                    let my = MyOk {
                        affected_rows: ok.affected_rows(),
                        last_insert_id: ok.last_insert_id(),
                        status: ok.status_flags().bits(),
                        warnings: ok.warnings(),
                        info: ok.info_ref().map(node_utf8).unwrap_or_default(),
                    };
                    self.status = my.status;
                    if my.more_results() {
                        self.state = State::Query { phase: Phase::Header, infile: None };
                    }
                    // doneInsert: mysql2 fails the statement instead of reporting the server's OK to the empty file
                    if let Some(file) = infile {
                        return Ok(Some(MyEvent::ClientError(local_infile_message(&file))));
                    }
                    Ok(Some(MyEvent::Ok(my)))
                }
                Some(0xff) => match self.server_error(&p) {
                    MyError::Server(e) => Ok(Some(MyEvent::Error(e))),
                    other => Err(other),
                },
                Some(0xfb) => {
                    // LOAD DATA LOCAL INFILE: mysql2 without infileStreamFactory sends an empty file; the server's OK / ERR
                    // to it follows
                    let file = node_utf8(&p[1..]);
                    self.io.write_packet(&[]).await?;
                    self.state = State::Query { phase: Phase::Header, infile: Some(file) };
                    Ok(None)
                }
                _ => {
                    let mut b: &[u8] = &p;
                    let n = lenenc(&mut b)?.unwrap_or(0);
                    let n = usize::try_from(n)
                        .ok()
                        .filter(|&n| n > 0 && n <= 65_535)
                        .ok_or_else(|| MyError::Protocol(format!("bad column count {n}")))?;
                    self.state = State::Query { phase: Phase::Columns { left: n, columns: Vec::with_capacity(n) }, infile };
                    Ok(None)
                }
            },
            Phase::Columns { left, mut columns } => {
                let c = parse_column(&p, self.mariadb_extended(), self.client_charset)
                    .map_err(|e| MyError::Protocol(e.to_string()))?;
                columns.push(c);
                let phase = if left == 1 { Phase::ColumnsEof { columns } } else { Phase::Columns { left: left - 1, columns } };
                self.state = State::Query { phase, infile };
                Ok(None)
            }
            Phase::ColumnsEof { columns } => {
                if p.first() != Some(&0xfe) {
                    return Err(MyError::Protocol("no EOF after the column definitions".into()));
                }
                self.state = State::Query { phase: Phase::Rows { count: columns.len() }, infile };
                Ok(Some(MyEvent::Fields(columns)))
            }
            Phase::Rows { count } => match p.first() {
                Some(0xfe) if p.len() < 9 => {
                    let eof: OkPacket = ParseBuf(&p)
                        .parse::<OkPacketDeserializer<OldEofPacket>>(self.wire_caps())
                        .map_err(|e| MyError::Protocol(e.to_string()))?
                        .into();
                    let status = eof.status_flags().bits();
                    self.status = status;
                    if StatusFlags::from_bits_retain(status).contains(StatusFlags::SERVER_MORE_RESULTS_EXISTS) {
                        self.state = State::Query { phase: Phase::Header, infile };
                    }
                    Ok(Some(MyEvent::SetEnd { status, warnings: eof.warnings() }))
                }
                Some(0xff) => match self.server_error(&p) {
                    MyError::Server(e) => Ok(Some(MyEvent::Error(e))),
                    other => Err(other),
                },
                _ => {
                    let row = RawRow::parse(p, count)?;
                    self.state = State::Query { phase: Phase::Rows { count }, infile };
                    Ok(Some(MyEvent::Row(row)))
                }
            },
        }
    }

    /// Reads the running statement to its end, rows thrown away (the connection is free afterwards).
    pub async fn finish(&mut self) -> Result<(), MyError> {
        while self.next_event().await?.is_some() {}
        Ok(())
    }

    /// One statement read whole (metadata, settings, edits): the server's error is `Err(Server)`.
    pub async fn exec(&mut self, sql: &str) -> Result<MyExec, MyError> {
        self.start_query(sql).await?;
        let mut out = MyExec::default();
        let mut sets = 0usize;
        let mut failure = None;
        while let Some(ev) = self.next_event().await? {
            match ev {
                MyEvent::Fields(f) => {
                    sets += 1;
                    if out.fields.is_none() {
                        out.fields = Some(f);
                    }
                }
                MyEvent::Row(r) if sets == 1 => out.rows.push(r),
                MyEvent::Row(_) | MyEvent::SetEnd { .. } => {}
                MyEvent::Ok(ok) => out.header = Some(ok),
                MyEvent::Error(e) => failure = Some(MyError::Server(e)),
                MyEvent::ClientError(m) => failure = Some(MyError::Client(m)),
            }
        }
        match failure {
            Some(e) => Err(e),
            None => Ok(out),
        }
    }

    /// Every result of a statement as the SP9 goldens describe them (tests/wire_servers.rs).
    pub async fn query_all(&mut self, sql: &str) -> Result<Vec<MyResult>, MyError> {
        self.start_query(sql).await?;
        let mut results = Vec::new();
        type OpenSet = (Vec<MyColumn>, Vec<Vec<Option<Vec<u8>>>>);
        let mut set: Option<OpenSet> = None;
        while let Some(ev) = self.next_event().await? {
            match ev {
                MyEvent::Fields(columns) => set = Some((columns, Vec::new())),
                MyEvent::Row(r) => {
                    if let Some((_, rows)) = set.as_mut() {
                        rows.push(r.to_vec());
                    }
                }
                MyEvent::SetEnd { status, warnings } => {
                    if let Some((columns, rows)) = set.take() {
                        results.push(MyResult::Set { columns, rows, status, warnings });
                    }
                }
                MyEvent::Ok(ok) => results.push(MyResult::Ok {
                    affected_rows: ok.affected_rows,
                    last_insert_id: ok.last_insert_id,
                    status: ok.status,
                    warnings: ok.warnings,
                    info: ok.info,
                }),
                MyEvent::Error(e) => results.push(MyResult::Error(e)),
                MyEvent::ClientError(m) => results.push(MyResult::ClientError(m)),
            }
        }
        Ok(results)
    }

    /// Waits while the connection is idle and returns how it ended: the server closed it (after `wait_timeout`, a KILL,
    /// a restart; MySQL 8 says why in an ERR packet first) or the network failed. Cancel safe: the session selects on it
    /// between commands, like mysql2's 'error' / 'end' handlers.
    pub async fn closed(&mut self) -> MyError {
        if let State::Broken(e) = &self.state {
            return e.clone();
        }
        let e = loop {
            if let Err(e) = self.io.fill().await {
                break e;
            }
        };
        let e = match self.io.try_packet() {
            Some(p) if p.first() == Some(&0xff) => match self.server_error(&p) {
                MyError::Server(s) => MyError::Server(s),
                _ => e,
            },
            _ => e,
        };
        self.state = State::Broken(MyError::Closed);
        e
    }

    /// COM_QUIT and the end of the stream (mysql2 `end()`); a running statement is abandoned.
    pub async fn quit(mut self, wait: Duration) {
        let _ = tokio::time::timeout(wait, async {
            self.io.reset_seq();
            let _ = self.io.write_packet(&[0x01]).await;
            self.io.shutdown().await;
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_data_drops_the_terminating_nul() {
        let mut d = vec![1u8; 20];
        d.push(0);
        assert_eq!(switch_data(&d).len(), 20);
        let mut e = vec![1u8; 32];
        e.push(0);
        assert_eq!(switch_data(&e).len(), 32);
        assert_eq!(switch_data(&[1, 2, 0]).len(), 3);
    }

    #[test]
    fn handshake_response_like_mysql2() {
        let login = MyLogin { user: "root".into(), password: Zeroizing::new("pw".into()), database: "shop".into() };
        let caps = mysql2_default_flags();
        let r = handshake_response(caps, MariadbCapabilities::empty(), 45, &login, &[9; 20], "mysql_native_password");
        assert_eq!(&r[..4], &0x08ba_f3cfu32.to_le_bytes());
        assert_eq!(&r[4..8], &[0, 0, 0, 0]);
        assert_eq!(r[8], 45);
        assert_eq!(&r[9..32], &[0u8; 23]);
        assert_eq!(&r[32..37], b"root\0");
        assert_eq!(r[37], 20);
        assert_eq!(&r[38..58], &[9; 20]);
        assert_eq!(&r[58..63], b"shop\0");
        assert_eq!(&r[63..85], b"mysql_native_password\0");
        let attrs = &r[85..];
        assert_eq!(usize::from(attrs[0]), attrs.len() - 1);
        assert_eq!(&attrs[1..14], b"\x0c_client_name");
        // no database: an empty string, as mysql2 writes `database || ''`
        let none = MyLogin { database: String::new(), ..login };
        let r = handshake_response(caps, MariadbCapabilities::empty(), 45, &none, &[], "caching_sha2_password");
        assert_eq!(&r[32..39], b"root\0\0\0");
    }
}
