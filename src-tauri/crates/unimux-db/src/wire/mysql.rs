//! SP9 spike: a minimal MySQL / MariaDB wire client over any `AsyncRead + AsyncWrite` stream, built on mysql_common 0.38.2,
//! to measure value fidelity and the login paths against mysql2 3.24 (what 1.1.4 runs with typeCast off). D7 builds the
//! real client; the findings are in docs/tauri/spikes/SP9.md.
//!
//! From mysql_common: the initial handshake parse, HandshakeResponse41 (collation 45 utf8mb4_general_ci, the same number
//! mysql2 sends for `charset: 'utf8mb4'`), the auth plugins as a state machine (`AuthProc`: mysql_native_password,
//! caching_sha2_password fast and full with the RSA public key request, sha256_password), AuthSwitchRequest, OK / EOF / ERR.
//! Own code: packet framing (3-byte length + sequence id, 16 MiB continuation), COM_QUERY (with the empty query-attribute
//! prefix when CLIENT_QUERY_ATTRIBUTES is on, like mysql2), and the column definition parser, because mysql_common's
//! `Column` does not read MariaDB's extended metadata block (uuid / inet4 / inet6 / json names that 1.1.4 uses).

use std::io;

use mysql_common::auth::plugins::{AuthProc, ChallengeResponsePlugin, Context, Response};
use mysql_common::constants::{CapabilityFlags, MariadbCapabilities, StatusFlags};
use mysql_common::io::ParseBuf;
use mysql_common::packets::{
    AuthPlugin, AuthSwitchRequest, CommonOkPacket, ErrPacket, HandshakePacket, HandshakeResponse, OkPacket, OkPacketDeserializer,
    OldEofPacket,
};
use mysql_common::proto::MySerialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::mycharset::{charset_of_name, decode, enc_of, encode, name_enc};
use super::value::{DbValue, node_utf8, to_value};

/// The flags mysql2 3.24 sends by default (ConnectionConfig.getDefaultFlags with multipleStatements off).
pub fn mysql2_default_flags() -> CapabilityFlags {
    CapabilityFlags::CLIENT_LONG_PASSWORD
        | CapabilityFlags::CLIENT_FOUND_ROWS
        | CapabilityFlags::CLIENT_LONG_FLAG
        | CapabilityFlags::CLIENT_CONNECT_WITH_DB
        | CapabilityFlags::CLIENT_ODBC
        | CapabilityFlags::CLIENT_LOCAL_FILES
        | CapabilityFlags::CLIENT_IGNORE_SPACE
        | CapabilityFlags::CLIENT_PROTOCOL_41
        | CapabilityFlags::CLIENT_IGNORE_SIGPIPE
        | CapabilityFlags::CLIENT_TRANSACTIONS
        | CapabilityFlags::CLIENT_RESERVED
        | CapabilityFlags::CLIENT_SECURE_CONNECTION
        | CapabilityFlags::CLIENT_MULTI_RESULTS
        | CapabilityFlags::CLIENT_SESSION_TRACK
        | CapabilityFlags::CLIENT_CONNECT_ATTRS
        | CapabilityFlags::CLIENT_QUERY_ATTRIBUTES
        | CapabilityFlags::CLIENT_PLUGIN_AUTH
        | CapabilityFlags::CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA
}

#[derive(Debug, Clone)]
pub struct MyConfig {
    pub user: String,
    pub password: String,
    pub database: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MyServerError {
    pub code: u16,
    pub state: String,
    pub message: String,
}

#[derive(Debug)]
pub enum MyWireError {
    Io(io::Error),
    Server(MyServerError),
    Auth(String),
    Protocol(String),
}

impl From<io::Error> for MyWireError {
    fn from(e: io::Error) -> Self {
        MyWireError::Io(e)
    }
}

impl std::fmt::Display for MyWireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MyWireError::Io(e) => write!(f, "io: {e}"),
            MyWireError::Server(e) => write!(f, "server {} ({}): {}", e.code, e.state, e.message),
            MyWireError::Auth(s) => write!(f, "auth: {s}"),
            MyWireError::Protocol(s) => write!(f, "protocol: {s}"),
        }
    }
}

impl std::error::Error for MyWireError {}

/// A column definition (ColumnDefinition41) with MariaDB's extended metadata.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MyColumn {
    pub schema: String,
    pub table: String,
    pub org_table: String,
    pub name: String,
    pub org_name: String,
    pub character_set: u16,
    pub column_length: u32,
    pub column_type: u8,
    pub flags: u16,
    pub decimals: u8,
    pub extended_type_name: Option<String>,
    pub extended_format: Option<String>,
}

pub const MY_BINARY_CHARSET: u16 = 63;
const BIT: u8 = 0x10;
const VECTOR: u8 = 0xf2;
const GEOMETRY: u8 = 0xff;
const STRINGISH: [u8; 9] = [0x0f, 0xfd, 0xfe, 0xf9, 0xfa, 0xfb, 0xfc, 0xf7, 0xf8];

impl MyColumn {
    /// `mysqlFieldBinary` (src/shared/dbMysql.ts): values shown as `\x` hex.
    pub fn binary(&self) -> bool {
        if self.extended_format.as_deref() == Some("json") {
            return false;
        }
        if matches!(self.column_type, BIT | GEOMETRY | VECTOR) {
            return true;
        }
        STRINGISH.contains(&self.column_type) && self.character_set == MY_BINARY_CHARSET
    }
}

/// What a statement answered: an OK packet, or a result set (columns, raw rows), possibly followed by more results.
#[derive(Debug, Clone)]
pub enum MyResult {
    Ok {
        affected_rows: u64,
        last_insert_id: Option<u64>,
        status: u16,
        warnings: u16,
        info: String,
    },
    Set {
        columns: Vec<MyColumn>,
        rows: Vec<Vec<Option<Vec<u8>>>>,
        status: u16,
        warnings: u16,
    },
    Error(MyServerError),
    /// An error of the client, not of the server (mysql2 fails the statement with an Error that has no errno; 1.1.4 maps
    /// that to `dbClosed`). Only LOAD DATA LOCAL INFILE gives one here, after the server's OK to the empty file.
    ClientError(String),
}

impl MyResult {
    /// The rows as port values (`decoders` + `toValue` of mysqlSession.ts).
    pub fn values(&self) -> Vec<Vec<DbValue>> {
        match self {
            MyResult::Set { columns, rows, .. } => rows
                .iter()
                .map(|r| {
                    r.iter()
                        .enumerate()
                        .map(|(i, v)| to_value(v.as_deref(), columns.get(i).is_some_and(MyColumn::binary)))
                        .collect()
                })
                .collect(),
            _ => Vec::new(),
        }
    }
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

/// How the login went (for the SP9 measurements).
#[derive(Debug, Clone, Default)]
pub struct LoginTrace {
    pub first_plugin: String,
    pub switched_to: Option<String>,
    /// caching_sha2_password: 3 = fast path (cached), 4 = full authentication.
    pub cache_state: Option<u8>,
    pub requested_public_key: bool,
}

pub struct MyConn<S> {
    stream: S,
    buf: Vec<u8>,
    seq: u8,
    pub caps: CapabilityFlags,
    pub server_caps: CapabilityFlags,
    pub mariadb_ext: MariadbCapabilities,
    pub server_version: String,
    pub connection_id: u32,
    pub login: LoginTrace,
    /// mysql2's `config.charsetNumber`: 45 for `charset: 'utf8mb4'` (what 1.1.4 passes), then whatever
    /// `character_set_client` the server's session tracking reports. COM_QUERY text is encoded in it.
    pub client_charset: u16,
}

fn lenenc(b: &mut &[u8]) -> io::Result<Option<u64>> {
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "short length-encoded integer");
    let first = *b.first().ok_or_else(bad)?;
    let (n, v) = match first {
        0xfb => (1, None),
        0xfc => (3, Some(u64::from(u16::from_le_bytes([*b.get(1).ok_or_else(bad)?, *b.get(2).ok_or_else(bad)?])))),
        0xfd => {
            let s = b.get(1..4).ok_or_else(bad)?;
            (4, Some(u64::from(s[0]) | u64::from(s[1]) << 8 | u64::from(s[2]) << 16))
        }
        0xfe => (9, Some(u64::from_le_bytes(b.get(1..9).ok_or_else(bad)?.try_into().unwrap()))),
        x => (1, Some(u64::from(x))),
    };
    if b.len() < n {
        return Err(bad());
    }
    *b = &b[n..];
    Ok(v)
}

fn lenenc_bytes<'a>(b: &mut &'a [u8]) -> io::Result<Option<&'a [u8]>> {
    match lenenc(b)? {
        None => Ok(None),
        Some(n) => {
            let n = n as usize;
            if b.len() < n {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "short length-encoded string"));
            }
            let (v, rest) = b.split_at(n);
            *b = rest;
            Ok(Some(v))
        }
    }
}

fn lenenc_text(b: &mut &[u8]) -> io::Result<String> {
    Ok(lenenc_bytes(b)?.map(node_utf8).unwrap_or_default())
}

/// ColumnDefinition41 (+ the MariaDB extended metadata block when that capability is on), like mysql2's ColumnDefinition:
/// the names are decoded in the column's charset (the client encoding, `client_charset`, for a binary column).
pub fn parse_column(mut b: &[u8], mariadb_extended: bool, client_charset: u16) -> io::Result<MyColumn> {
    let _catalog = lenenc_bytes(&mut b)?;
    let schema = lenenc_bytes(&mut b)?.unwrap_or_default();
    let table = lenenc_bytes(&mut b)?.unwrap_or_default();
    let org_table = lenenc_bytes(&mut b)?.unwrap_or_default();
    let name = lenenc_bytes(&mut b)?.unwrap_or_default();
    let org_name = lenenc_bytes(&mut b)?.unwrap_or_default();
    let mut c = MyColumn::default();
    if mariadb_extended {
        let block = lenenc_bytes(&mut b)?.unwrap_or_default();
        let mut e = block;
        while !e.is_empty() {
            let id = e[0];
            e = &e[1..];
            let v = lenenc_text(&mut e)?;
            match id {
                0 => c.extended_type_name = Some(v),
                1 => c.extended_format = Some(v),
                _ => {}
            }
        }
    }
    if b.len() < 13 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "short column definition"));
    }
    let f = &b[1..];
    c.character_set = u16::from_le_bytes([f[0], f[1]]);
    c.column_length = u32::from_le_bytes([f[2], f[3], f[4], f[5]]);
    c.column_type = f[6];
    c.flags = u16::from_le_bytes([f[7], f[8]]);
    c.decimals = f[9];
    let enc = name_enc(c.character_set, client_charset);
    c.schema = decode(schema, enc);
    c.table = decode(table, enc);
    c.org_table = decode(org_table, enc);
    c.name = decode(name, enc);
    c.org_name = decode(org_name, enc);
    Ok(c)
}

/// `character_set_client` from an OK packet's session-state block (CLIENT_SESSION_TRACK), as mysql2's ResultSetHeader
/// reads it: entries of (type, lenenc data); type 0 (system variable) data is a lenenc name and a lenenc value.
pub fn tracked_client_charset(state: &[u8]) -> Option<String> {
    let mut b = state;
    let mut found = None;
    while !b.is_empty() {
        let kind = b[0];
        b = &b[1..];
        let Ok(Some(mut data)) = lenenc_bytes(&mut b) else { break };
        if kind == 0
            && let (Ok(Some(k)), Ok(Some(v))) = (lenenc_bytes(&mut data), lenenc_bytes(&mut data))
            && k == b"character_set_client"
        {
            found = Some(node_utf8(v));
        }
    }
    found
}

/// The error mysql2 3.24 reports for LOAD DATA LOCAL INFILE without an `infileStreamFactory` (lib/commands/query.js).
pub fn local_infile_message(file: &str) -> String {
    format!(
        "As a result of LOCAL INFILE command server wants to read {file} file, but as of v2.0 you must provide streamFactory option returning ReadStream."
    )
}

/// A text-protocol row: one length-encoded string per column, 0xfb for NULL.
pub fn parse_text_row(mut b: &[u8], columns: usize) -> io::Result<Vec<Option<Vec<u8>>>> {
    let mut row = Vec::with_capacity(columns);
    for _ in 0..columns {
        row.push(lenenc_bytes(&mut b)?.map(<[u8]>::to_vec));
    }
    Ok(row)
}

impl<S: AsyncRead + AsyncWrite + Unpin> MyConn<S> {
    async fn read_packet(&mut self) -> io::Result<Vec<u8>> {
        let mut payload = Vec::new();
        loop {
            while self.buf.len() < 4 {
                self.fill().await?;
            }
            let len = usize::from(self.buf[0]) | usize::from(self.buf[1]) << 8 | usize::from(self.buf[2]) << 16;
            while self.buf.len() < 4 + len {
                self.fill().await?;
            }
            self.seq = self.buf[3].wrapping_add(1);
            payload.extend_from_slice(&self.buf[4..4 + len]);
            self.buf.drain(..4 + len);
            if len < 0xff_ffff {
                return Ok(payload);
            }
        }
    }

    async fn fill(&mut self) -> io::Result<()> {
        let mut chunk = [0u8; 16 * 1024];
        let n = self.stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed"));
        }
        self.buf.extend_from_slice(&chunk[..n]);
        Ok(())
    }

    async fn write_packet(&mut self, payload: &[u8]) -> io::Result<()> {
        let mut out = Vec::with_capacity(payload.len() + 8);
        let mut rest = payload;
        loop {
            let n = rest.len().min(0xff_ffff);
            out.extend_from_slice(&[(n & 0xff) as u8, (n >> 8 & 0xff) as u8, (n >> 16) as u8, self.seq]);
            self.seq = self.seq.wrapping_add(1);
            out.extend_from_slice(&rest[..n]);
            rest = &rest[n..];
            if n < 0xff_ffff {
                break;
            }
        }
        self.stream.write_all(&out).await?;
        self.stream.flush().await
    }

    fn server_error(&self, p: &[u8]) -> MyWireError {
        match ParseBuf(p).parse::<ErrPacket>(self.caps) {
            Ok(ErrPacket::Error(e)) => MyWireError::Server(MyServerError {
                code: e.error_code(),
                state: e.sql_state_ref().map(|s| s.as_str().into_owned()).unwrap_or_default(),
                message: node_utf8(e.message_ref()),
            }),
            Ok(ErrPacket::Progress(_)) => MyWireError::Protocol("progress report".into()),
            Err(e) => MyWireError::Io(e),
        }
    }

    pub async fn connect(stream: S, cfg: &MyConfig) -> Result<Self, MyWireError> {
        let mut c = MyConn {
            stream,
            buf: Vec::new(),
            seq: 0,
            caps: CapabilityFlags::empty(),
            server_caps: CapabilityFlags::empty(),
            mariadb_ext: MariadbCapabilities::empty(),
            server_version: String::new(),
            connection_id: 0,
            login: LoginTrace::default(),
            client_charset: 45,
        };
        let hello = c.read_packet().await?;
        if hello.first() == Some(&0xff) {
            return Err(c.server_error(&hello));
        }
        let hs: HandshakePacket = ParseBuf(&hello).parse(())?;
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
        let nonce = hs.nonce();
        let plugin = hs.auth_plugin().map(|p| p.into_owned()).unwrap_or(AuthPlugin::MysqlNativePassword);
        c.login.first_plugin = String::from_utf8_lossy(plugin.as_bytes()).into_owned();
        let mut proc = AuthProc::init(&plugin).map_err(|e| MyWireError::Auth(e.to_string()))?;
        let mut scramble = nonce.clone();
        let first = {
            let ctx = Ctx { pass: cfg.password.as_bytes(), scramble: &scramble, tls: false };
            proc.run(&ctx, &nonce).map_err(|e| MyWireError::Auth(e.to_string()))?
        };
        let attrs = [
            ("_client_name".to_owned(), "unimux".to_owned()),
            ("_client_version".to_owned(), env!("CARGO_PKG_VERSION").to_owned()),
        ];
        let resp = HandshakeResponse::new(
            first.data().map(<[u8]>::to_vec),
            hs.server_version_parsed().unwrap_or((8, 0, 0)),
            Some(cfg.user.as_bytes().to_vec()),
            cfg.database.as_ref().map(|d| d.as_bytes().to_vec()),
            Some(plugin.clone()),
            caps,
            Some(attrs.into_iter().collect()),
            16 * 1024 * 1024,
        )
        .with_mariadb_ext_capabilities(ext);
        c.caps = resp.capabilities();
        c.mariadb_ext = ext;
        let mut payload = Vec::new();
        resp.serialize(&mut payload);
        c.write_packet(&payload).await?;
        loop {
            let p = c.read_packet().await?;
            match p.first() {
                Some(0x00) => return Ok(c),
                Some(0xff) => return Err(c.server_error(&p)),
                Some(0xfe) => {
                    let sw: AuthSwitchRequest = ParseBuf(&p).parse(())?;
                    let plugin = sw.auth_plugin().into_owned();
                    let data = sw.plugin_data();
                    let data = data.strip_suffix(&[0]).unwrap_or(data).to_vec();
                    c.login.switched_to = Some(String::from_utf8_lossy(plugin.as_bytes()).into_owned());
                    scramble = data.clone();
                    proc = AuthProc::init(&plugin).map_err(|e| MyWireError::Auth(e.to_string()))?;
                    let ctx = Ctx { pass: cfg.password.as_bytes(), scramble: &scramble, tls: false };
                    let r = proc.run(&ctx, &data).map_err(|e| MyWireError::Auth(e.to_string()))?;
                    c.send_auth(r).await?;
                }
                Some(0x01) => {
                    let data = p[1..].to_vec();
                    if data.len() == 1 {
                        c.login.cache_state = Some(data[0]);
                    }
                    let ctx = Ctx { pass: cfg.password.as_bytes(), scramble: &scramble, tls: false };
                    let r = proc.run(&ctx, &data).map_err(|e| MyWireError::Auth(e.to_string()))?;
                    if r.data() == Some(&[0x02][..]) {
                        c.login.requested_public_key = true;
                    }
                    c.send_auth(r).await?;
                }
                _ => return Err(MyWireError::Protocol(format!("unexpected login packet {:?}", p.first()))),
            }
        }
    }

    async fn send_auth(&mut self, r: Response) -> io::Result<()> {
        match r.data() {
            Some(d) => self.write_packet(d).await,
            None => Ok(()),
        }
    }

    fn mariadb_extended(&self) -> bool {
        self.mariadb_ext.contains(MariadbCapabilities::MARIADB_CLIENT_EXTENDED_METADATA)
    }

    /// COM_QUERY with text results; every result of the statement (CALL gives several). The text is encoded in the
    /// session's client charset like mysql2 (`client_charset`).
    pub async fn query(&mut self, sql: &str) -> Result<Vec<MyResult>, MyWireError> {
        let text = match encode(sql, enc_of(self.client_charset)) {
            Ok(t) => t,
            Err(name) => {
                return Err(MyWireError::Protocol(format!(
                    "the spike does not encode queries in {name} (D7: iconv-lite tables)"
                )));
            }
        };
        self.seq = 0;
        let mut payload = vec![0x03];
        if (self.caps & self.server_caps).contains(CapabilityFlags::CLIENT_QUERY_ATTRIBUTES) {
            // parameter_count 0, parameter_set_count 1 (what mysql2 writes with no attributes)
            payload.extend_from_slice(&[0x00, 0x01]);
        }
        payload.extend_from_slice(&text);
        self.write_packet(&payload).await?;
        let mut results = Vec::new();
        // LOAD DATA LOCAL INFILE: mysql2 without infileStreamFactory answers with an empty file and fails the statement
        let mut infile: Option<String> = None;
        loop {
            let p = self.read_packet().await?;
            let status = match p.first() {
                Some(0x00) => {
                    let ok: OkPacket = ParseBuf(&p).parse::<OkPacketDeserializer<CommonOkPacket>>(self.caps)?.into();
                    if let Some(name) = ok.session_state_info_ref().and_then(tracked_client_charset)
                        && let Some(n) = charset_of_name(&name)
                    {
                        self.client_charset = n;
                    }
                    if let Some(file) = infile.take() {
                        // doneInsert: the error instead of the result
                        results.push(MyResult::ClientError(local_infile_message(&file)));
                        return Ok(results);
                    }
                    let status = ok.status_flags().bits();
                    results.push(MyResult::Ok {
                        affected_rows: ok.affected_rows(),
                        last_insert_id: ok.last_insert_id(),
                        status,
                        warnings: ok.warnings(),
                        info: ok.info_ref().map(node_utf8).unwrap_or_default(),
                    });
                    status
                }
                Some(0xff) => {
                    match self.server_error(&p) {
                        MyWireError::Server(e) => results.push(MyResult::Error(e)),
                        other => return Err(other),
                    }
                    return Ok(results);
                }
                Some(0xfb) => {
                    // the server's OK / ERR to the empty file follows
                    infile = Some(node_utf8(&p[1..]));
                    self.write_packet(&[]).await?;
                    continue;
                }
                _ => {
                    let mut b = &p[..];
                    let n = lenenc(&mut b)?.unwrap_or(0) as usize;
                    let mut columns = Vec::with_capacity(n);
                    for _ in 0..n {
                        let d = self.read_packet().await?;
                        columns.push(parse_column(&d, self.mariadb_extended(), self.client_charset)?);
                    }
                    let eof = self.read_packet().await?;
                    if eof.first() != Some(&0xfe) {
                        return Err(MyWireError::Protocol("no EOF after the column definitions".into()));
                    }
                    let mut rows = Vec::new();
                    let (status, warnings) = loop {
                        let r = self.read_packet().await?;
                        match r.first() {
                            Some(0xfe) if r.len() < 9 => {
                                let ok: OkPacket = ParseBuf(&r).parse::<OkPacketDeserializer<OldEofPacket>>(self.caps)?.into();
                                break (ok.status_flags().bits(), ok.warnings());
                            }
                            Some(0xff) => {
                                match self.server_error(&r) {
                                    MyWireError::Server(e) => results.push(MyResult::Error(e)),
                                    other => return Err(other),
                                }
                                return Ok(results);
                            }
                            _ => rows.push(parse_text_row(&r, n)?),
                        }
                    };
                    results.push(MyResult::Set { columns, rows, status, warnings });
                    status
                }
            };
            if !StatusFlags::from_bits_retain(status).contains(StatusFlags::SERVER_MORE_RESULTS_EXISTS) {
                return Ok(results);
            }
        }
    }

    pub async fn quit(mut self) -> io::Result<()> {
        self.seq = 0;
        self.write_packet(&[0x01]).await?;
        self.stream.shutdown().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_are_the_mysql2_set() {
        // node -e "CC=require('./node_modules/mysql2/lib/connection_config.js'); CC.mergeFlags(CC.getDefaultFlags({}), '')"
        assert_eq!(mysql2_default_flags().bits(), 0x08ba_f3cf);
    }

    #[test]
    fn mariadb_extended_metadata_is_read() {
        let mut d = Vec::new();
        for s in ["def", "db", "t", "t", "id", "id"] {
            d.push(s.len() as u8);
            d.extend(s.as_bytes());
        }
        // block: id 0 "uuid", id 1 "json"
        d.extend([12, 0, 4]);
        d.extend(b"uuid");
        d.extend([1, 4]);
        d.extend(b"json");
        d.extend([0x0c, 45, 0, 144, 0, 0, 0, 0xfe, 0, 0, 0, 0, 0]);
        let c = parse_column(&d, true, 45).unwrap();
        assert_eq!((c.extended_type_name.as_deref(), c.extended_format.as_deref()), (Some("uuid"), Some("json")));
        assert_eq!((c.character_set, c.column_type, c.name.as_str()), (45, 0xfe, "id"));
        assert!(!c.binary());
    }

    #[test]
    fn binary_columns_like_mysql_field_binary() {
        let col = |t: u8, cs: u16| MyColumn { column_type: t, character_set: cs, ..Default::default() };
        assert!(col(0xfc, 63).binary());
        assert!(!col(0xfc, 45).binary());
        assert!(col(0x10, 63).binary());
        assert!(col(0xff, 63).binary());
        assert!(!col(0x03, 63).binary());
        assert!(!col(0xf5, 63).binary());
    }

    #[test]
    fn text_rows_with_nulls() {
        let row = parse_text_row(&[1, b'a', 0xfb, 0], 3).unwrap();
        assert_eq!(row, vec![Some(b"a".to_vec()), None, Some(Vec::new())]);
    }

    #[test]
    fn session_tracking_gives_the_client_charset() {
        // a schema entry (type 1), then character_set_client = latin1 (type 0)
        let mut s = vec![1, 3, 2, b's', b'9'];
        let var = [&[20u8][..], b"character_set_client", &[6], b"latin1"].concat();
        s.push(0);
        s.push(var.len() as u8);
        s.extend(var);
        assert_eq!(tracked_client_charset(&s).as_deref(), Some("latin1"));
        assert_eq!(tracked_client_charset(&[1, 3, 2, b's', b'9']), None);
    }

    #[test]
    fn column_names_follow_the_column_charset() {
        let mut d = Vec::new();
        for s in [&b"def"[..], b"", b"", b"", &[0xe9, b'x'], b""] {
            d.push(s.len() as u8);
            d.extend(s);
        }
        // latin1_swedish_ci (8)
        d.extend([0x0c, 8, 0, 4, 0, 0, 0, 0xfd, 0, 0, 0, 0, 0]);
        assert_eq!(parse_column(&d, false, 45).unwrap().name, "éx");
        // binary (63): the client encoding
        let n = d.len() - 12;
        d[n] = 63;
        assert_eq!(parse_column(&d, false, 45).unwrap().name, "\u{fffd}x");
        assert_eq!(parse_column(&d, false, 5).unwrap().name, "éx");
    }
}
