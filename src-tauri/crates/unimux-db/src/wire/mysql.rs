//! The MySQL / MariaDB wire pieces SP9 measured against mysql2 3.24 (what 1.1.4 runs with typeCast off), shared with the
//! production client in [`crate::mysql`] (D7, which replaced the spike's own connection): mysql2's client flags, the
//! column definition parser (mysql_common's `Column` does not read MariaDB's extended metadata block: uuid / inet4 /
//! inet6 / json names that 1.1.4 uses; names decoded in the column charset), the session-state charset tracking, the
//! LOAD DATA LOCAL message, and the result form the SP9 goldens are written from. The findings are in
//! docs/tauri/spikes/SP9.md.

use std::io;

use mysql_common::constants::CapabilityFlags;

use super::mycharset::{decode, name_enc};
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

/// The server's ERR packet: error number, SQLSTATE ('' when the packet has none) and message (decoded like Node).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MyServerError {
    pub code: u16,
    pub state: String,
    pub message: String,
}

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

/// How the login went (the SP9 measurements and the client's tests).
#[derive(Debug, Clone, Default)]
pub struct LoginTrace {
    pub first_plugin: String,
    pub switched_to: Option<String>,
    /// caching_sha2_password: 3 = fast path (cached), 4 = full authentication.
    pub cache_state: Option<u8>,
    pub requested_public_key: bool,
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
