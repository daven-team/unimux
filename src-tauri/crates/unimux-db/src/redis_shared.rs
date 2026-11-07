//! The pure Redis helpers of src/shared/dbRedis.ts (D3): binary-safe data (UTF-8 text or base64), the console line parser
//! (redis-cli / sdssplitargs quoting) and its inverse, command classes (dangerous, refused in the console, status replies,
//! refused on read-only connections, known reads), INFO / keyspace / CLIENT LIST parsing and stream id steps. Checked against
//! the TS reference by `tests/sql_golden.rs` (test/golden/db-redis.jsonl, also run through the TS code by vitest).

use base64::Engine as _;
use serde_json::{Map, Value};
use unimux_core::utf16::js_trim;

/// `REDIS_LIMITS`.
pub mod limits {
    pub const SCAN_KEYS: usize = 2000;
    pub const SCAN_COUNT_MAX: usize = 10_000;
    pub const SCAN_COUNT_DEFAULT: usize = 200;
    pub const SCAN_BUDGET_MS: u64 = 1500;
    pub const INFO_KEYS: usize = 1000;
    pub const PAGE_ITEMS: usize = 5000;
    pub const ITEM_BYTES: usize = 64 * 1024;
    pub const STRING_BYTES: usize = 1024 * 1024;
    pub const STRING_BYTES_MAX: usize = 16 * 1024 * 1024;
    pub const NAME_BYTES: usize = 1024 * 1024;
    pub const WRITE_BYTES: usize = 64 * 1024 * 1024;
    pub const WRITE_ITEMS: usize = 10_000;
    pub const ARGV: usize = 10_000;
    pub const REPLY_NODES: usize = 10_000;
    pub const REPLY_BULK_BYTES: usize = 1024 * 1024;
    pub const CONSOLE_TIMEOUT_MS: u64 = 30_000;
    pub const CONSOLE_TIMEOUT_MAX_MS: u64 = 5 * 60_000;
    pub const COUNT_KEYS: usize = 1_000_000;
    pub const DELETE_BATCH: usize = 500;
    pub const TOKEN_TTL_MS: u64 = 5 * 60_000;
    pub const DELETE_SLACK_MIN: usize = 100;
    pub const DELETE_SLACK: f64 = 0.05;
    pub const PAGE_BATCH: usize = 200;
    pub const PAGE_BYTES: usize = 8 * 1024 * 1024;
    pub const CONSOLE_ITEMS_CONFIRM: usize = 100_000;
    pub const CONSOLE_BYTES_CONFIRM: usize = 64 * 1024 * 1024;
    pub const OP_TIMEOUT_MS: u64 = 60_000;
    pub const PUBSUB_BUFFER: usize = 5000;
    pub const PUBSUB_BUFFER_BYTES: usize = 8 * 1024 * 1024;
    pub const PUBSUB_PAYLOAD_BYTES: usize = 64 * 1024;
    pub const PUBSUB_BATCH: usize = 500;
    pub const PUBSUB_FLUSH_MS: u64 = 50;
    pub const PUBSUB_CHANNELS: usize = 1000;
    pub const SLOWLOG_MAX: usize = 1000;
    pub const RECONNECT_ATTEMPTS: u32 = 3;
}

/// `RedisData`: the UTF-8 text of valid UTF-8 bytes, anything else base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedisData {
    Text(String),
    B64(String),
}

impl RedisData {
    /// The JSON form (`"text"` or `{b64}`).
    pub fn to_json(&self) -> Value {
        match self {
            RedisData::Text(s) => Value::String(s.clone()),
            RedisData::B64(b) => {
                let mut m = Map::new();
                m.insert("b64".into(), Value::String(b.clone()));
                Value::Object(m)
            }
        }
    }

    /// From the JSON form; None for anything else.
    pub fn from_json(v: &Value) -> Option<RedisData> {
        match v {
            Value::String(s) => Some(RedisData::Text(s.clone())),
            Value::Object(o) => o.get("b64").and_then(Value::as_str).map(|b| RedisData::B64(b.to_owned())),
            _ => None,
        }
    }

    /// `isBinaryData`.
    pub fn is_binary(&self) -> bool {
        matches!(self, RedisData::B64(_))
    }
}

/// `bytesToBase64` (btoa: standard alphabet, padded).
pub fn bytes_to_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `base64ToBytes` (atob's forgiving decode: ASCII blanks ignored, padding optional, non-zero trailing bits allowed); None
/// where atob throws.
pub fn base64_to_bytes(b64: &str) -> Option<Vec<u8>> {
    let mut s: Vec<u8> = b64.bytes().filter(|b| !matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')).collect();
    if s.len().is_multiple_of(4) {
        if s.ends_with(b"==") {
            s.truncate(s.len() - 2);
        } else if s.ends_with(b"=") {
            s.truncate(s.len() - 1);
        }
    }
    if s.len() % 4 == 1 {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for &c in &s {
        buf = (buf << 6) | val(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// `redisDataFromBytes`: text when the bytes are valid UTF-8 (a leading BOM is dropped, as TextDecoder does), else base64.
pub fn data_from_bytes(bytes: &[u8]) -> RedisData {
    match std::str::from_utf8(bytes) {
        Ok(s) => RedisData::Text(s.strip_prefix('\u{feff}').unwrap_or(s).to_owned()),
        Err(_) => RedisData::B64(bytes_to_base64(bytes)),
    }
}

/// `redisDataBytes`; None when the base64 is broken (atob throws).
pub fn data_bytes(d: &RedisData) -> Option<Vec<u8>> {
    match d {
        RedisData::Text(s) => Some(s.as_bytes().to_vec()),
        RedisData::B64(b) => base64_to_bytes(b),
    }
}

/// `redisDataLength`.
pub fn data_length(d: &RedisData) -> Option<usize> {
    data_bytes(d).map(|b| b.len())
}

/// `redisDataHex`: "68 65 6c" style hex.
pub fn data_hex(d: &RedisData, sep: &str) -> Option<String> {
    Some(data_bytes(d)?.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(sep))
}

/// `redisDataFromHex`: hex typed by the user (blanks allowed) as data; None when it is not hex.
pub fn data_from_hex(hex: &str) -> Option<RedisData> {
    let h: String = hex.chars().filter(|&c| !unimux_core::utf16::is_js_space_char(c)).collect();
    if !h.len().is_multiple_of(2) || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes: Vec<u8> = (0..h.len() / 2).map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap_or(0)).collect();
    Some(data_from_bytes(&bytes))
}

/// `redisDataDisplay`: the text, or redis-cli's escaped form of binary ("\x00\xff"). Broken base64 shows nothing.
pub fn data_display(d: &RedisData) -> String {
    match d {
        RedisData::Text(s) => s.clone(),
        RedisData::B64(b) => base64_to_bytes(b).map(|bytes| escape_bytes(&bytes)).unwrap_or_default(),
    }
}

fn escape_bytes(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len());
    for &b in bytes {
        match b {
            0x5c => s.push_str("\\\\"),
            0x22 => s.push_str("\\\""),
            0x0a => s.push_str("\\n"),
            0x0d => s.push_str("\\r"),
            0x09 => s.push_str("\\t"),
            0x20..=0x7e => s.push(char::from(b)),
            _ => s.push_str(&format!("\\x{b:02x}")),
        }
    }
    s
}

/// `redisDataKey`: "t:<text>" or "b:<base64>".
pub fn data_key(d: &RedisData) -> String {
    match d {
        RedisData::Text(s) => format!("t:{s}"),
        RedisData::B64(b) => format!("b:{b}"),
    }
}

/// `redisDataEquals`.
pub fn data_equals(a: &RedisData, b: &RedisData) -> bool {
    data_key(a) == data_key(b)
}

/// Why a console line does not parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineError {
    UnbalancedQuotes,
    Empty,
}

impl LineError {
    pub fn as_str(self) -> &'static str {
        match self {
            LineError::UnbalancedQuotes => "unbalancedQuotes",
            LineError::Empty => "empty",
        }
    }
}

/// UTF-8 of one UTF-16 code unit sequence as TextEncoder writes it (an unpaired surrogate is U+FFFD).
fn push_units(bytes: &mut Vec<u8>, units: &[u16]) {
    bytes.extend_from_slice(String::from_utf16_lossy(units).as_bytes());
}

/// `parseRedisCommandLine`: words separated by blanks; "double quotes" know \n \r \t \b \a \\ \" and \xHH; 'single quotes'
/// know only \'; a closing quote must be followed by a blank or the end of the line.
pub fn parse_command_line(line: &str) -> Result<Vec<RedisData>, LineError> {
    let u: Vec<u16> = line.encode_utf16().collect();
    let n = u.len();
    let ws = |c: Option<u16>| matches!(c, Some(0x20 | 0x0a | 0x0d | 0x09 | 0x0b | 0x0c));
    let at = |i: usize| u.get(i).copied();
    let is_hex = |c: Option<u16>| c.is_some_and(|c| c < 0x80 && (c as u8).is_ascii_hexdigit());
    let mut argv = Vec::new();
    let mut i = 0;
    loop {
        while i < n && ws(at(i)) {
            i += 1;
        }
        if i >= n {
            break;
        }
        let mut bytes: Vec<u8> = Vec::new();
        let (mut in_dq, mut in_sq, mut done) = (false, false, false);
        // `line.codePointAt(i)` as UTF-8, `i` past a pair's first half.
        let code_point = |i: &mut usize, bytes: &mut Vec<u8>| {
            let c = u[*i];
            if (0xd800..0xdc00).contains(&c) && at(*i + 1).is_some_and(|d| (0xdc00..0xe000).contains(&d)) {
                push_units(bytes, &u[*i..*i + 2]);
                *i += 1;
            } else {
                push_units(bytes, &u[*i..*i + 1]);
            }
        };
        while !done {
            let c = at(i);
            if in_dq {
                let Some(ch) = c else { return Err(LineError::UnbalancedQuotes) };
                if ch == u16::from(b'\\') && at(i + 1) == Some(u16::from(b'x')) && is_hex(at(i + 2)) && is_hex(at(i + 3)) {
                    let h = String::from_utf16_lossy(&u[i + 2..i + 4]);
                    bytes.push(u8::from_str_radix(&h, 16).unwrap_or(0));
                    i += 3;
                } else if ch == u16::from(b'\\') && i + 1 < n {
                    i += 1;
                    let e = u[i];
                    let mapped: Option<u8> = match e {
                        0x6e => Some(b'\n'),
                        0x72 => Some(b'\r'),
                        0x74 => Some(b'\t'),
                        0x62 => Some(0x08),
                        0x61 => Some(0x07),
                        _ => None,
                    };
                    match mapped {
                        Some(b) => bytes.push(b),
                        None => push_units(&mut bytes, &u[i..i + 1]),
                    }
                } else if ch == u16::from(b'"') {
                    if i + 1 < n && !ws(at(i + 1)) {
                        return Err(LineError::UnbalancedQuotes);
                    }
                    done = true;
                } else {
                    code_point(&mut i, &mut bytes);
                }
            } else if in_sq {
                let Some(ch) = c else { return Err(LineError::UnbalancedQuotes) };
                if ch == u16::from(b'\\') && at(i + 1) == Some(u16::from(b'\'')) {
                    i += 1;
                    bytes.push(b'\'');
                } else if ch == u16::from(b'\'') {
                    if i + 1 < n && !ws(at(i + 1)) {
                        return Err(LineError::UnbalancedQuotes);
                    }
                    done = true;
                } else {
                    code_point(&mut i, &mut bytes);
                }
            } else if c.is_none() || ws(c) {
                done = true;
            } else if c == Some(u16::from(b'"')) {
                in_dq = true;
            } else if c == Some(u16::from(b'\'')) {
                in_sq = true;
            } else {
                code_point(&mut i, &mut bytes);
            }
            if i < n {
                i += 1;
            }
        }
        argv.push(data_from_bytes(&bytes));
    }
    if argv.is_empty() { Err(LineError::Empty) } else { Ok(argv) }
}

/// `/[\u0000-\u001f\u007f]/`.
fn control(c: char) -> bool {
    (c as u32) < 0x20 || c == '\u{7f}'
}

/// `quoteRedisArg`: bare when safe, else double-quoted with escapes, so the line parses back to the same argument.
pub fn quote_arg(d: &RedisData) -> String {
    match d {
        RedisData::B64(_) => format!("\"{}\"", data_display(d)),
        RedisData::Text(s) => {
            let unsafe_char = |c: char| unimux_core::utf16::is_js_space_char(c) || matches!(c, '"' | '\'' | '\\') || control(c);
            if !s.is_empty() && !s.chars().any(unsafe_char) {
                return s.clone();
            }
            let mut out = String::with_capacity(s.len() + 2);
            out.push('"');
            for ch in s.chars() {
                match ch {
                    '\\' => out.push_str("\\\\"),
                    '"' => out.push_str("\\\""),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if control(c) => out.push_str(&format!("\\x{:02x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
            out
        }
    }
}

/// `REDIS_CONTAINER_COMMANDS`: their second word is a subcommand.
pub const CONTAINER_COMMANDS: &[&str] = &[
    "ACL", "CLIENT", "CLUSTER", "COMMAND", "CONFIG", "FUNCTION", "LATENCY", "MEMORY", "MODULE", "OBJECT", "PUBSUB", "SCRIPT",
    "SLOWLOG", "XGROUP", "XINFO",
];

/// `REDIS_DANGEROUS_COMMANDS`: asked about before they run.
pub const DANGEROUS_COMMANDS: &[&str] = &[
    "FLUSHALL",
    "FLUSHDB",
    "KEYS",
    "CONFIG SET",
    "CONFIG REWRITE",
    "CONFIG RESETSTAT",
    "SHUTDOWN",
    "DEBUG",
    "SAVE",
    "BGSAVE",
    "BGREWRITEAOF",
    "REPLICAOF",
    "SLAVEOF",
    "FAILOVER",
    "CLIENT KILL",
    "CLIENT PAUSE",
    "SCRIPT FLUSH",
    "FUNCTION FLUSH",
    "MIGRATE",
    "SWAPDB",
    "ACL SETUSER",
    "ACL DELUSER",
    "MODULE LOAD",
    "MODULE LOADEX",
    "MODULE UNLOAD",
    "MODULE LIST",
    "MODULE HELP",
];

const BLOCKING: &[&str] = &[
    "BLPOP",
    "BRPOP",
    "BRPOPLPUSH",
    "BLMOVE",
    "BLMPOP",
    "BZPOPMIN",
    "BZPOPMAX",
    "BZMPOP",
    "WAIT",
    "WAITAOF",
    "MONITOR",
    "SYNC",
    "PSYNC",
];
const SUBSCRIBE: &[&str] = &["SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "UNSUBSCRIBE", "PUNSUBSCRIBE", "SUNSUBSCRIBE"];
const TRANSACTION: &[&str] = &["MULTI", "EXEC", "DISCARD", "WATCH", "UNWATCH"];
const CONNECTION: &[&str] = &[
    "QUIT",
    "RESET",
    "HELLO",
    "AUTH",
    "CLIENT REPLY",
    "CLIENT NO-EVICT",
    "CLIENT NO-TOUCH",
    "CLIENT TRACKING",
    "CLIENT CACHING",
    "READONLY",
    "READWRITE",
    "ASKING",
];

/// `REDIS_READ_ONLY_REFUSED` (beyond the dangerous ones): refused on a read-only connection whatever the server says.
const READ_ONLY_REFUSED_MORE: &[&str] = &[
    "EVAL",
    "EVALSHA",
    "FCALL",
    "SCRIPT LOAD",
    "SCRIPT KILL",
    "FUNCTION LOAD",
    "FUNCTION DELETE",
    "FUNCTION RESTORE",
    "FUNCTION KILL",
    "PUBLISH",
    "SPUBLISH",
    "CONFIG SET",
    "ACL LOAD",
    "ACL SAVE",
    "SLOWLOG RESET",
    "LATENCY RESET",
    "MEMORY PURGE",
    "CLIENT SETNAME",
    "CLIENT SETINFO",
    "CLIENT UNPAUSE",
    "CLUSTER",
    "OBJECT FREQ",
];

/// `REDIS_READ_ONLY_REFUSED.has(name)`.
pub fn read_only_refused(name: &str) -> bool {
    DANGEROUS_COMMANDS.contains(&name) || READ_ONLY_REFUSED_MORE.contains(&name)
}

/// `REDIS_READ_COMMANDS`: known to only read (used on a read-only connection when the command table cannot be read).
pub const READ_COMMANDS: &[&str] = &[
    "GET",
    "MGET",
    "STRLEN",
    "GETRANGE",
    "SUBSTR",
    "LCS",
    "EXISTS",
    "TYPE",
    "TTL",
    "PTTL",
    "EXPIRETIME",
    "PEXPIRETIME",
    "DUMP",
    "TOUCH",
    "HGET",
    "HMGET",
    "HGETALL",
    "HKEYS",
    "HVALS",
    "HLEN",
    "HEXISTS",
    "HSCAN",
    "HSTRLEN",
    "HRANDFIELD",
    "LRANGE",
    "LLEN",
    "LINDEX",
    "LPOS",
    "SMEMBERS",
    "SISMEMBER",
    "SMISMEMBER",
    "SCARD",
    "SSCAN",
    "SRANDMEMBER",
    "SINTER",
    "SUNION",
    "SDIFF",
    "SINTERCARD",
    "ZRANGE",
    "ZRANGEBYSCORE",
    "ZREVRANGE",
    "ZREVRANGEBYSCORE",
    "ZRANGEBYLEX",
    "ZREVRANGEBYLEX",
    "ZSCORE",
    "ZMSCORE",
    "ZCARD",
    "ZCOUNT",
    "ZLEXCOUNT",
    "ZRANK",
    "ZREVRANK",
    "ZSCAN",
    "ZRANDMEMBER",
    "ZINTER",
    "ZUNION",
    "ZDIFF",
    "ZINTERCARD",
    "XRANGE",
    "XREVRANGE",
    "XLEN",
    "XINFO STREAM",
    "XINFO GROUPS",
    "XINFO CONSUMERS",
    "XPENDING",
    "XREAD",
    "BITCOUNT",
    "BITPOS",
    "GETBIT",
    "BITFIELD_RO",
    "GEOPOS",
    "GEODIST",
    "GEOHASH",
    "GEORADIUS_RO",
    "GEORADIUSBYMEMBER_RO",
    "GEOSEARCH",
    "SORT_RO",
    "EVAL_RO",
    "EVALSHA_RO",
    "FCALL_RO",
    "SCAN",
    "DBSIZE",
    "RANDOMKEY",
    "INFO",
    "PING",
    "ECHO",
    "TIME",
    "LASTSAVE",
    "ROLE",
    "LOLWUT",
    "MEMORY USAGE",
    "MEMORY STATS",
    "MEMORY DOCTOR",
    "OBJECT ENCODING",
    "OBJECT IDLETIME",
    "OBJECT REFCOUNT",
    "SLOWLOG GET",
    "SLOWLOG LEN",
    "CLIENT LIST",
    "CLIENT INFO",
    "CLIENT GETNAME",
    "CLIENT ID",
    "COMMAND",
    "COMMAND INFO",
    "COMMAND COUNT",
    "COMMAND DOCS",
    "COMMAND LIST",
    "COMMAND GETKEYS",
    "CONFIG GET",
    "PUBSUB CHANNELS",
    "PUBSUB NUMSUB",
    "PUBSUB NUMPAT",
    "LATENCY LATEST",
    "LATENCY HISTORY",
    "SELECT",
];

const STATUS_REPLIES: &[&str] = &[
    "SET",
    "SELECT",
    "PING",
    "FLUSHDB",
    "FLUSHALL",
    "RENAME",
    "LSET",
    "LTRIM",
    "MSET",
    "HMSET",
    "TYPE",
    "SAVE",
    "BGSAVE",
    "BGREWRITEAOF",
    "SETEX",
    "PSETEX",
    "SWAPDB",
    "RESTORE",
    "CONFIG SET",
    "CONFIG REWRITE",
    "CONFIG RESETSTAT",
    "CLIENT SETNAME",
    "CLIENT KILL",
    "CLIENT PAUSE",
    "CLIENT UNPAUSE",
    "SCRIPT FLUSH",
    "SCRIPT KILL",
    "FUNCTION FLUSH",
    "FUNCTION DELETE",
    "FUNCTION RESTORE",
    "XGROUP CREATE",
    "XGROUP SETID",
    "XSETID",
    "ACL SETUSER",
    "ACL LOAD",
    "ACL SAVE",
    "MIGRATE",
    "REPLICAOF",
    "SLAVEOF",
    "DEBUG",
    "SLOWLOG RESET",
    "LATENCY RESET",
    "MEMORY PURGE",
    "SHUTDOWN",
    "FAILOVER",
    "MODULE LOAD",
    "MODULE UNLOAD",
    "PFMERGE",
    "QUIT",
    "RESET",
];

/// `RedisConsoleRefusal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Blocking,
    Subscribe,
    Transaction,
    Connection,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::Blocking => "blocking",
            Refusal::Subscribe => "subscribe",
            Refusal::Transaction => "transaction",
            Refusal::Connection => "connection",
        }
    }
}

/// `RedisCommandClass`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandClass {
    pub name: String,
    pub dangerous: bool,
    pub refused: Option<Refusal>,
    pub status: bool,
}

/// `word(d)`: text upper case (JS toUpperCase, full Unicode), binary ''.
fn word(d: Option<&RedisData>) -> String {
    match d {
        Some(RedisData::Text(s)) => s.to_uppercase(),
        _ => String::new(),
    }
}

/// `redisCommandName`: upper case, with the subcommand of a container command ("CONFIG SET").
pub fn command_name(argv: &[RedisData]) -> String {
    let first = word(argv.first());
    if CONTAINER_COMMANDS.contains(&first.as_str()) && argv.len() > 1 { format!("{first} {}", word(argv.get(1))) } else { first }
}

/// `classifyRedisCommand`.
pub fn classify_command(argv: &[RedisData]) -> CommandClass {
    let first = word(argv.first());
    let name = command_name(argv);
    let dangerous =
        DANGEROUS_COMMANDS.contains(&name.as_str()) || DANGEROUS_COMMANDS.contains(&first.as_str()) || first == "MODULE";
    let mut refused = None;
    if BLOCKING.contains(&first.as_str())
        || ((first == "XREAD" || first == "XREADGROUP") && argv.iter().any(|a| word(Some(a)) == "BLOCK"))
    {
        refused = Some(Refusal::Blocking);
    }
    if SUBSCRIBE.contains(&first.as_str()) {
        refused = Some(Refusal::Subscribe);
    } else if TRANSACTION.contains(&first.as_str()) {
        refused = Some(Refusal::Transaction);
    } else if CONNECTION.contains(&name.as_str()) || CONNECTION.contains(&first.as_str()) {
        refused = Some(Refusal::Connection);
    }
    let status = STATUS_REPLIES.contains(&name.as_str()) || STATUS_REPLIES.contains(&first.as_str());
    let set_get = first == "SET" && argv.iter().enumerate().any(|(i, a)| i > 2 && word(Some(a)) == "GET");
    CommandClass { name, dangerous, refused, status: status && !set_get }
}

/// `RedisInfoSection`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InfoSection {
    pub name: String,
    pub entries: Vec<(String, String)>,
}

/// `text.split(/\r?\n/)`.
fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l))
}

/// `parseRedisInfo`: INFO's text as sections ("# Server" headers, "key:value" lines).
pub fn parse_info(text: &str) -> Vec<InfoSection> {
    let mut sections: Vec<InfoSection> = Vec::new();
    let mut current: Option<usize> = None;
    for raw in lines(text) {
        let line = js_trim(raw);
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('#') {
            sections.push(InfoSection { name: js_trim(rest).to_owned(), entries: Vec::new() });
            current = Some(sections.len() - 1);
            continue;
        }
        let Some(at) = line.find(':').filter(|&a| a > 0) else { continue };
        let k = match current {
            Some(k) => k,
            None => {
                sections.push(InfoSection { name: String::new(), entries: Vec::new() });
                sections.len() - 1
            }
        };
        current = Some(k);
        sections[k].entries.push((line[..at].to_owned(), line[at + 1..].to_owned()));
    }
    sections
}

/// `RedisDbInfo` (numbers as JS numbers).
#[derive(Debug, Clone, PartialEq)]
pub struct DbInfo {
    pub index: f64,
    pub keys: f64,
    pub expires: f64,
    pub avg_ttl_ms: f64,
}

/// `Number(x) || 0`.
fn number_or_zero(x: Option<&str>) -> f64 {
    let n = x.map_or(f64::NAN, crate::sql::values::js_to_number);
    if n.is_nan() || n == 0.0 { 0.0 } else { n }
}

/// `parseRedisKeyspace`: the "db0:keys=1,expires=0,avg_ttl=0" lines, by index.
pub fn parse_keyspace(sections: &[InfoSection]) -> Vec<DbInfo> {
    let mut out = Vec::new();
    for s in sections {
        for (k, v) in &s.entries {
            let Some(digits) = k.strip_prefix("db").filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())) else {
                continue;
            };
            // Object.fromEntries(v.split(',').map((p) => p.split('='))): the last of a repeated name wins.
            let mut fields: Vec<(&str, Option<&str>)> = Vec::new();
            for p in v.split(',') {
                let mut it = p.split('=');
                let name = it.next().unwrap_or("");
                let value = it.next();
                match fields.iter_mut().find(|(n, _)| *n == name) {
                    Some(f) => f.1 = value,
                    None => fields.push((name, value)),
                }
            }
            let get = |name: &str| fields.iter().find(|(n, _)| *n == name).and_then(|(_, v)| *v);
            out.push(DbInfo {
                index: crate::sql::values::js_to_number(digits),
                keys: number_or_zero(get("keys")),
                expires: number_or_zero(get("expires")),
                avg_ttl_ms: number_or_zero(get("avg_ttl")),
            });
        }
    }
    out.sort_by(|a, b| (a.index - b.index).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// `parseRedisClientList`: each CLIENT LIST line as its key=value fields (JS object order: index-like names first).
pub fn parse_client_list(text: &str) -> Vec<Map<String, Value>> {
    lines(text)
        .filter(|l| !js_trim(l).is_empty())
        .map(|line| {
            let mut rec = Map::new();
            for part in js_trim(line).split(' ') {
                // `rec['__proto__'] = text` sets no property in JS (a string is not a prototype).
                if let Some(at) = part.find('=').filter(|&a| a > 0)
                    && &part[..at] != "__proto__"
                {
                    rec.insert(part[..at].to_owned(), Value::String(part[at + 1..].to_owned()));
                }
            }
            unimux_core::js_json::order_map_like_js(&mut rec);
            rec
        })
        .collect()
}

const U64_MAX: &str = "18446744073709551615";

/// `/^(\d+)-(\d+)$/`: the two digit strings without leading zeros (BigInt reads them so).
fn stream_parts(id: &str) -> Option<(String, String)> {
    let (a, b) = id.split_once('-')?;
    let ok = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    if !ok(a) || !ok(b) {
        return None;
    }
    let norm = |s: &str| {
        let t = s.trim_start_matches('0');
        if t.is_empty() { "0".to_owned() } else { t.to_owned() }
    };
    Some((norm(a), norm(b)))
}

/// Compares two canonical decimal strings.
fn cmp_dec(a: &str, b: &str) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

fn inc_dec(s: &str) -> String {
    let mut d: Vec<u8> = s.bytes().collect();
    let mut i = d.len();
    loop {
        if i == 0 {
            d.insert(0, b'1');
            break;
        }
        i -= 1;
        if d[i] == b'9' {
            d[i] = b'0';
        } else {
            d[i] += 1;
            break;
        }
    }
    String::from_utf8(d).unwrap_or_default()
}

fn dec_dec(s: &str) -> String {
    let mut d: Vec<u8> = s.bytes().collect();
    let mut i = d.len();
    while i > 0 {
        i -= 1;
        if d[i] == b'0' {
            d[i] = b'9';
        } else {
            d[i] -= 1;
            break;
        }
    }
    let t = String::from_utf8(d).unwrap_or_default();
    let t = t.trim_start_matches('0');
    if t.is_empty() { "0".into() } else { t.to_owned() }
}

/// `isStreamId`: "ms-seq", both within u64.
pub fn is_stream_id(id: &str) -> bool {
    stream_parts(id).is_some_and(|(a, b)| cmp_dec(&a, U64_MAX).is_le() && cmp_dec(&b, U64_MAX).is_le())
}

/// `streamIdStep`: the id right after (dir 1) or before (dir -1) a stream id; None past the ends.
pub fn stream_id_step(id: &str, forward: bool) -> Option<String> {
    let (mut ms, mut seq) = stream_parts(id)?;
    if forward {
        if cmp_dec(&seq, U64_MAX).is_lt() {
            seq = inc_dec(&seq);
        } else if cmp_dec(&ms, U64_MAX).is_lt() {
            ms = inc_dec(&ms);
            seq = "0".into();
        } else {
            return None;
        }
    } else if seq != "0" {
        seq = dec_dec(&seq);
    } else if ms != "0" {
        ms = dec_dec(&ms);
        seq = U64_MAX.into();
    } else {
        return None;
    }
    Some(format!("{ms}-{seq}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> RedisData {
        RedisData::Text(s.into())
    }

    #[test]
    fn data() {
        assert_eq!(data_from_bytes(&[0, 255, 0xc3]), RedisData::B64("AP/D".into()));
        assert_eq!(data_hex(&RedisData::B64("AP/D".into()), " ").as_deref(), Some("00 ff c3"));
        assert_eq!(data_from_hex("6869"), Some(t("hi")));
        assert_eq!(data_from_hex("6"), None);
        assert_eq!(base64_to_bytes(" AP8 "), Some(vec![0, 255]));
        assert_eq!(base64_to_bytes("A"), None);
        assert_eq!(data_from_bytes(&[0xef, 0xbb, 0xbf, b'A']), t("A"));
    }

    #[test]
    fn command_lines() {
        let argv = |l: &str| parse_command_line(l).unwrap();
        assert_eq!(argv("SET k \"line\\nnext\\t\\\"q\\\" \\\\\""), [t("SET"), t("k"), t("line\nnext\t\"q\" \\")]);
        assert_eq!(argv("SET k 'it\\'s \\n raw'"), [t("SET"), t("k"), t("it's \\n raw")]);
        assert_eq!(argv("SET k a\"b c\""), [t("SET"), t("k"), t("ab c")]);
        assert_eq!(argv("SET k \"\\x00\\xff\""), [t("SET"), t("k"), RedisData::B64("AP8=".into())]);
        assert_eq!(parse_command_line("SET \"a\"b"), Err(LineError::UnbalancedQuotes));
        assert_eq!(parse_command_line("   "), Err(LineError::Empty));
        for a in ["plain", "a b", "q\"x", "back\\slash", "nl\nx", "", "ż"] {
            assert_eq!(argv(&format!("SET {}", quote_arg(&t(a)))), [t("SET"), t(a)]);
        }
    }

    #[test]
    fn classes_and_ids() {
        assert_eq!(command_name(&[t("config"), t("set"), t("x")]), "CONFIG SET");
        let c = classify_command(&[t("SET"), t("k"), t("v"), t("GET")]);
        assert!(!c.status);
        assert_eq!(classify_command(&[t("XREAD"), t("BLOCK"), t("0")]).refused, Some(Refusal::Blocking));
        assert_eq!(stream_id_step("5-0", false).as_deref(), Some("4-18446744073709551615"));
        assert_eq!(stream_id_step("5-18446744073709551615", true).as_deref(), Some("6-0"));
        assert_eq!(stream_id_step("0-0", false), None);
        assert_eq!(stream_id_step("18446744073709551615-18446744073709551615", true), None);
        assert!(!is_stream_id("1"));
    }
}
