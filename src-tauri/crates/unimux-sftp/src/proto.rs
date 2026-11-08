//! The SFTP version 3 wire format (draft-ietf-secsh-filexfer-02, what OpenSSH and ssh2 speak): packet types, open flags,
//! status codes, file attributes and the replies a client reads.
//!
//! Own codec instead of russh-sftp's `RawSftpSession` (deviation from PLAN T2, see PROGRESS "T2 open issues"): russh-sftp
//! keeps handles and names as `String` and decodes them lossily, so a server whose handle bytes are not UTF-8 (any binary
//! handle) gets back a different handle and every read / write / close of that file fails. ssh2 (1.1.4) kept handles as
//! bytes; this codec does the same. Names and long names are decoded like ssh2 (UTF-8, invalid bytes as U+FFFD).

pub const INIT: u8 = 1;
pub const VERSION: u8 = 2;
pub const OPEN: u8 = 3;
pub const CLOSE: u8 = 4;
pub const READ: u8 = 5;
pub const WRITE: u8 = 6;
pub const LSTAT: u8 = 7;
pub const FSTAT: u8 = 8;
pub const SETSTAT: u8 = 9;
pub const FSETSTAT: u8 = 10;
pub const OPENDIR: u8 = 11;
pub const READDIR: u8 = 12;
pub const REMOVE: u8 = 13;
pub const MKDIR: u8 = 14;
pub const RMDIR: u8 = 15;
pub const REALPATH: u8 = 16;
pub const STAT: u8 = 17;
pub const RENAME: u8 = 18;
pub const READLINK: u8 = 19;
pub const SYMLINK: u8 = 20;
pub const STATUS: u8 = 101;
pub const HANDLE: u8 = 102;
pub const DATA: u8 = 103;
pub const NAME: u8 = 104;
pub const ATTRS: u8 = 105;
pub const EXTENDED: u8 = 200;
pub const EXTENDED_REPLY: u8 = 201;

/// The protocol version this client asks for.
pub const PROTOCOL_VERSION: u32 = 3;

/// `SSH_FXF_*`.
pub mod open_flags {
    pub const READ: u32 = 0x01;
    pub const WRITE: u32 = 0x02;
    pub const APPEND: u32 = 0x04;
    pub const CREAT: u32 = 0x08;
    pub const TRUNC: u32 = 0x10;
    pub const EXCL: u32 = 0x20;
}

/// `SSH_FX_*`.
pub mod status {
    pub const OK: u32 = 0;
    pub const EOF: u32 = 1;
    pub const NO_SUCH_FILE: u32 = 2;
    pub const PERMISSION_DENIED: u32 = 3;
    pub const FAILURE: u32 = 4;
    pub const BAD_MESSAGE: u32 = 5;
    pub const NO_CONNECTION: u32 = 6;
    pub const CONNECTION_LOST: u32 = 7;
    pub const OP_UNSUPPORTED: u32 = 8;
}

const ATTR_SIZE: u32 = 0x0000_0001;
const ATTR_UIDGID: u32 = 0x0000_0002;
const ATTR_PERMISSIONS: u32 = 0x0000_0004;
const ATTR_ACMODTIME: u32 = 0x0000_0008;
const ATTR_EXTENDED: u32 = 0x8000_0000;

/// The largest packet a server may send (OpenSSH's own limit is 256 KB; a long folder listing of another server may be
/// bigger). A longer length is a broken or hostile stream: the session ends instead of allocating it.
pub const MAX_INCOMING_PACKET: usize = 16 * 1024 * 1024;

/// A reply that is not what the request expects, or a packet that does not parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtoError;

/// `ATTRS`: every field optional, as the server sent it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attrs {
    pub size: Option<u64>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub mode: Option<u32>,
    pub atime: Option<u32>,
    pub mtime: Option<u32>,
}

impl Attrs {
    pub fn mode(mode: u32) -> Attrs {
        Attrs { mode: Some(mode), ..Attrs::default() }
    }

    /// Writes the attributes (`atime` and `mtime` go together: both or neither, like ssh2).
    pub fn encode(&self, out: &mut Vec<u8>) {
        let mut flags = 0;
        if self.size.is_some() {
            flags |= ATTR_SIZE;
        }
        if self.uid.is_some() && self.gid.is_some() {
            flags |= ATTR_UIDGID;
        }
        if self.mode.is_some() {
            flags |= ATTR_PERMISSIONS;
        }
        if self.atime.is_some() && self.mtime.is_some() {
            flags |= ATTR_ACMODTIME;
        }
        put_u32(out, flags);
        if let Some(size) = self.size {
            put_u64(out, size);
        }
        if let (Some(uid), Some(gid)) = (self.uid, self.gid) {
            put_u32(out, uid);
            put_u32(out, gid);
        }
        if let Some(mode) = self.mode {
            put_u32(out, mode);
        }
        if let (Some(a), Some(m)) = (self.atime, self.mtime) {
            put_u32(out, a);
            put_u32(out, m);
        }
    }

    pub fn decode(r: &mut Reader<'_>) -> Result<Attrs, ProtoError> {
        let flags = r.u32()?;
        let mut a = Attrs::default();
        if flags & ATTR_SIZE != 0 {
            a.size = Some(r.u64()?);
        }
        if flags & ATTR_UIDGID != 0 {
            a.uid = Some(r.u32()?);
            a.gid = Some(r.u32()?);
        }
        if flags & ATTR_PERMISSIONS != 0 {
            a.mode = Some(r.u32()?);
        }
        if flags & ATTR_ACMODTIME != 0 {
            a.atime = Some(r.u32()?);
            a.mtime = Some(r.u32()?);
        }
        if flags & ATTR_EXTENDED != 0 {
            let count = r.u32()?;
            for _ in 0..count {
                r.bytes()?;
                r.bytes()?;
            }
        }
        Ok(a)
    }
}

/// One entry of a `NAME` reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameEntry {
    pub filename: String,
    pub longname: String,
    pub attrs: Attrs,
}

/// What a request gets back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Status { code: u32, message: String },
    Handle(Vec<u8>),
    Data(Vec<u8>),
    Name(Vec<NameEntry>),
    Attrs(Attrs),
    ExtendedReply(Vec<u8>),
}

/// The server's `VERSION`: its version and the extensions it offers (name, data).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerVersion {
    pub version: u32,
    pub extensions: Vec<(String, Vec<u8>)>,
}

impl ServerVersion {
    pub fn extension(&self, name: &str) -> Option<&[u8]> {
        self.extensions.iter().find(|(n, _)| n == name).map(|(_, d)| d.as_slice())
    }

    /// The body of a `VERSION` packet (after the type byte).
    pub fn decode(body: &[u8]) -> Result<ServerVersion, ProtoError> {
        let mut r = Reader::new(body);
        let version = r.u32()?;
        let mut extensions = Vec::new();
        while !r.is_empty() {
            let name = r.string()?;
            // A server that sends a name without data (seen in old servers) ends the list there.
            let data = r.bytes().map(|d| d.to_vec()).unwrap_or_default();
            extensions.push((name, data));
        }
        Ok(ServerVersion { version, extensions })
    }
}

pub fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

pub fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_be_bytes());
}

pub fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    put_u32(out, b.len() as u32);
    out.extend_from_slice(b);
}

pub fn put_str(out: &mut Vec<u8>, s: &str) {
    put_bytes(out, s.as_bytes());
}

/// A packet with its length prefix: `type`, then the request id (when given), then `body`.
pub fn frame(kind: u8, id: Option<u32>, body: &[u8]) -> Vec<u8> {
    let len = 1 + if id.is_some() { 4 } else { 0 } + body.len();
    let mut out = Vec::with_capacity(4 + len);
    put_u32(&mut out, len as u32);
    out.push(kind);
    if let Some(id) = id {
        put_u32(&mut out, id);
    }
    out.extend_from_slice(body);
    out
}

/// Reads the fields of one packet body.
pub struct Reader<'a> {
    buf: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf }
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn u8(&mut self) -> Result<u8, ProtoError> {
        let (&b, rest) = self.buf.split_first().ok_or(ProtoError)?;
        self.buf = rest;
        Ok(b)
    }

    pub fn u32(&mut self) -> Result<u32, ProtoError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn u64(&mut self) -> Result<u64, ProtoError> {
        let b = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Ok(u64::from_be_bytes(a))
    }

    pub fn bytes(&mut self) -> Result<&'a [u8], ProtoError> {
        let len = self.u32()? as usize;
        self.take(len)
    }

    /// A string as ssh2 decodes it (UTF-8; an invalid sequence becomes U+FFFD).
    pub fn string(&mut self) -> Result<String, ProtoError> {
        Ok(String::from_utf8_lossy(self.bytes()?).into_owned())
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], ProtoError> {
        if self.buf.len() < n {
            return Err(ProtoError);
        }
        let (a, b) = self.buf.split_at(n);
        self.buf = b;
        Ok(a)
    }
}

/// Parses a reply packet body (after the length): its type, request id and contents. None for a packet a client never
/// gets (it is ignored like an answer to nothing).
pub fn parse_reply(packet: &[u8]) -> Result<Option<(u32, Reply)>, ProtoError> {
    let mut r = Reader::new(packet);
    let kind = r.u8()?;
    let id = r.u32()?;
    let reply = match kind {
        STATUS => {
            let code = r.u32()?;
            // Version 3 servers may leave out the message and the language tag.
            let message = if r.is_empty() { String::new() } else { r.string().unwrap_or_default() };
            Reply::Status { code, message }
        }
        HANDLE => Reply::Handle(r.bytes()?.to_vec()),
        DATA => Reply::Data(r.bytes()?.to_vec()),
        NAME => {
            let count = r.u32()? as usize;
            // Each entry takes at least 12 bytes: a count beyond that is a broken packet, not a reason to allocate.
            if count > packet.len() / 12 {
                return Err(ProtoError);
            }
            let mut names = Vec::with_capacity(count);
            for _ in 0..count {
                let filename = r.string()?;
                let longname = r.string()?;
                let attrs = Attrs::decode(&mut r)?;
                names.push(NameEntry { filename, longname, attrs });
            }
            Reply::Name(names)
        }
        ATTRS => Reply::Attrs(Attrs::decode(&mut r)?),
        EXTENDED_REPLY => Reply::ExtendedReply(r.buf.to_vec()),
        _ => return Ok(None),
    };
    Ok(Some((id, reply)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attrs_round_trip_and_extended_pairs_are_skipped() {
        let a = Attrs { size: Some(5), uid: Some(1), gid: Some(2), mode: Some(0o100644), atime: Some(7), mtime: Some(9) };
        let mut buf = Vec::new();
        a.encode(&mut buf);
        assert_eq!(Attrs::decode(&mut Reader::new(&buf)).unwrap(), a);
        let mut ext = Vec::new();
        put_u32(&mut ext, ATTR_PERMISSIONS | ATTR_EXTENDED);
        put_u32(&mut ext, 0o40755);
        put_u32(&mut ext, 1);
        put_str(&mut ext, "k");
        put_str(&mut ext, "v");
        assert_eq!(Attrs::decode(&mut Reader::new(&ext)).unwrap(), Attrs::mode(0o40755));
        // Only one of atime / mtime: no times sent.
        let mut half = Vec::new();
        Attrs { mtime: Some(1), ..Attrs::default() }.encode(&mut half);
        assert_eq!(half, vec![0, 0, 0, 0]);
    }

    #[test]
    fn replies_parse_and_broken_ones_fail() {
        let mut body = vec![STATUS];
        put_u32(&mut body, 7);
        put_u32(&mut body, status::NO_SUCH_FILE);
        assert_eq!(parse_reply(&body).unwrap(), Some((7, Reply::Status { code: 2, message: String::new() })));
        let mut handle = vec![HANDLE];
        put_u32(&mut handle, 1);
        put_bytes(&mut handle, &[0xff, 0x00, 0x80]);
        assert_eq!(parse_reply(&handle).unwrap(), Some((1, Reply::Handle(vec![0xff, 0x00, 0x80]))));
        let mut names = vec![NAME];
        put_u32(&mut names, 2);
        put_u32(&mut names, 1_000_000);
        assert_eq!(parse_reply(&names), Err(ProtoError));
        let mut bad = vec![NAME];
        put_u32(&mut bad, 2);
        put_u32(&mut bad, 1);
        put_bytes(&mut bad, b"\xffa");
        put_str(&mut bad, "");
        put_u32(&mut bad, 0);
        let Some((_, Reply::Name(n))) = parse_reply(&bad).unwrap() else { panic!() };
        assert_eq!(n[0].filename, "\u{fffd}a");
        assert_eq!(parse_reply(&[DATA, 0, 0]), Err(ProtoError));
    }

    #[test]
    fn version_lists_extensions() {
        let mut body = Vec::new();
        put_u32(&mut body, 3);
        put_str(&mut body, "posix-rename@openssh.com");
        put_str(&mut body, "1");
        put_str(&mut body, "lsetstat@openssh.com");
        put_str(&mut body, "1");
        let v = ServerVersion::decode(&body).unwrap();
        assert_eq!(v.version, 3);
        assert_eq!(v.extension("posix-rename@openssh.com"), Some(&b"1"[..]));
        assert_eq!(v.extension("x"), None);
        assert_eq!(frame(INIT, None, &[0, 0, 0, 3]), vec![0, 0, 0, 5, INIT, 0, 0, 0, 3]);
    }
}
