//! A small SFTP version 3 server (draft-ietf-secsh-filexfer-02, what OpenSSH speaks) for the test server: one folder is
//! `/`, paths are resolved inside it (`..` stops at `/`), the working directory is `/`. Requests: init, open, close, read,
//! write, lstat, fstat, setstat, fsetstat (size and times only), opendir, readdir, remove, mkdir, rmdir, realpath, stat,
//! rename. readlink / symlink and extended requests answer OP_UNSUPPORTED.

use std::collections::HashMap;
use std::fs::{File, Metadata, OpenOptions, ReadDir};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const FXP_INIT: u8 = 1;
pub const FXP_VERSION: u8 = 2;
pub const FXP_OPEN: u8 = 3;
pub const FXP_CLOSE: u8 = 4;
pub const FXP_READ: u8 = 5;
pub const FXP_WRITE: u8 = 6;
pub const FXP_LSTAT: u8 = 7;
pub const FXP_FSTAT: u8 = 8;
pub const FXP_SETSTAT: u8 = 9;
pub const FXP_FSETSTAT: u8 = 10;
pub const FXP_OPENDIR: u8 = 11;
pub const FXP_READDIR: u8 = 12;
pub const FXP_REMOVE: u8 = 13;
pub const FXP_MKDIR: u8 = 14;
pub const FXP_RMDIR: u8 = 15;
pub const FXP_REALPATH: u8 = 16;
pub const FXP_STAT: u8 = 17;
pub const FXP_RENAME: u8 = 18;
pub const FXP_STATUS: u8 = 101;
pub const FXP_HANDLE: u8 = 102;
pub const FXP_DATA: u8 = 103;
pub const FXP_NAME: u8 = 104;
pub const FXP_ATTRS: u8 = 105;

pub const FX_OK: u32 = 0;
pub const FX_EOF: u32 = 1;
pub const FX_NO_SUCH_FILE: u32 = 2;
pub const FX_PERMISSION_DENIED: u32 = 3;
pub const FX_FAILURE: u32 = 4;
pub const FX_BAD_MESSAGE: u32 = 5;
pub const FX_OP_UNSUPPORTED: u32 = 8;

const ATTR_SIZE: u32 = 0x1;
const ATTR_UIDGID: u32 = 0x2;
const ATTR_PERMISSIONS: u32 = 0x4;
const ATTR_ACMODTIME: u32 = 0x8;
const ATTR_EXTENDED: u32 = 0x8000_0000;

const PF_READ: u32 = 0x1;
const PF_WRITE: u32 = 0x2;
const PF_APPEND: u32 = 0x4;
const PF_CREAT: u32 = 0x8;
const PF_TRUNC: u32 = 0x10;
const PF_EXCL: u32 = 0x20;

/// Packets larger than this are refused (OpenSSH uses 256 KiB).
const MAX_PACKET: usize = 256 * 1024;
const MAX_READ: u32 = 64 * 1024;

/// A reader over one request's body.
struct Body<'a>(&'a [u8]);

impl<'a> Body<'a> {
    fn u32(&mut self) -> Option<u32> {
        let (head, rest) = self.0.split_at_checked(4)?;
        self.0 = rest;
        Some(u32::from_be_bytes(head.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        let (head, rest) = self.0.split_at_checked(8)?;
        self.0 = rest;
        Some(u64::from_be_bytes(head.try_into().ok()?))
    }
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let n = self.u32()? as usize;
        let (head, rest) = self.0.split_at_checked(n)?;
        self.0 = rest;
        Some(head)
    }
    fn string(&mut self) -> Option<String> {
        self.bytes().map(|b| String::from_utf8_lossy(b).into_owned())
    }
    fn attrs(&mut self) -> Option<Attrs> {
        let flags = self.u32()?;
        let mut a = Attrs::default();
        if flags & ATTR_SIZE != 0 {
            a.size = Some(self.u64()?);
        }
        if flags & ATTR_UIDGID != 0 {
            a.uid_gid = Some((self.u32()?, self.u32()?));
        }
        if flags & ATTR_PERMISSIONS != 0 {
            a.permissions = Some(self.u32()?);
        }
        if flags & ATTR_ACMODTIME != 0 {
            a.times = Some((self.u32()?, self.u32()?));
        }
        if flags & ATTR_EXTENDED != 0 {
            for _ in 0..self.u32()? {
                self.bytes()?;
                self.bytes()?;
            }
        }
        Some(a)
    }
}

/// SFTP file attributes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attrs {
    pub size: Option<u64>,
    pub uid_gid: Option<(u32, u32)>,
    pub permissions: Option<u32>,
    pub times: Option<(u32, u32)>,
}

impl Attrs {
    pub fn of(meta: &Metadata) -> Attrs {
        let secs = |t: std::io::Result<std::time::SystemTime>| {
            t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs() as u32)
        };
        Attrs {
            size: Some(meta.len()),
            uid_gid: Some((1000, 1000)),
            permissions: Some(mode_of(meta)),
            times: Some((secs(meta.accessed()), secs(meta.modified()))),
        }
    }

    pub fn encode(&self, out: &mut Vec<u8>) {
        let mut flags = 0;
        if self.size.is_some() {
            flags |= ATTR_SIZE;
        }
        if self.uid_gid.is_some() {
            flags |= ATTR_UIDGID;
        }
        if self.permissions.is_some() {
            flags |= ATTR_PERMISSIONS;
        }
        if self.times.is_some() {
            flags |= ATTR_ACMODTIME;
        }
        put_u32(out, flags);
        if let Some(s) = self.size {
            out.extend_from_slice(&s.to_be_bytes());
        }
        if let Some((u, g)) = self.uid_gid {
            put_u32(out, u);
            put_u32(out, g);
        }
        if let Some(p) = self.permissions {
            put_u32(out, p);
        }
        if let Some((a, m)) = self.times {
            put_u32(out, a);
            put_u32(out, m);
        }
    }
}

#[cfg(unix)]
fn mode_of(meta: &Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    meta.mode()
}

#[cfg(not(unix))]
fn mode_of(meta: &Metadata) -> u32 {
    if meta.is_dir() {
        0o040755
    } else if meta.file_type().is_symlink() {
        0o120777
    } else if meta.permissions().readonly() {
        0o100444
    } else {
        0o100644
    }
}

pub fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

pub fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    put_u32(out, b.len() as u32);
    out.extend_from_slice(b);
}

/// One packet: length, type, body.
pub fn packet(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 5);
    put_u32(&mut out, body.len() as u32 + 1);
    out.push(kind);
    out.extend_from_slice(body);
    out
}

/// Reads one packet: `(type, body)`; None at the end of the stream or for an oversized packet.
pub async fn read_packet<R: AsyncRead + Unpin>(r: &mut R) -> Option<(u8, Vec<u8>)> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await.ok()?;
    let n = u32::from_be_bytes(len) as usize;
    if n == 0 || n > MAX_PACKET {
        return None;
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).await.ok()?;
    let kind = buf.remove(0);
    Some((kind, buf))
}

/// The virtual path `/a/b` resolved against `/` (`.` dropped, `..` stops at `/`), as a normalized string.
pub fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    format!("/{}", parts.join("/"))
}

#[allow(clippy::large_enum_variant, reason = "a test server with a few handles at a time")]
enum Handle {
    File(File),
    Dir(Option<ReadDir>, PathBuf),
}

struct Server {
    root: PathBuf,
    handles: HashMap<String, Handle>,
    next: u64,
}

fn io_status(e: &std::io::Error) -> u32 {
    match e.kind() {
        std::io::ErrorKind::NotFound => FX_NO_SUCH_FILE,
        std::io::ErrorKind::PermissionDenied => FX_PERMISSION_DENIED,
        _ => FX_FAILURE,
    }
}

fn status(id: u32, code: u32, message: &str) -> Vec<u8> {
    let mut b = Vec::new();
    put_u32(&mut b, id);
    put_u32(&mut b, code);
    put_bytes(&mut b, message.as_bytes());
    put_bytes(&mut b, b"en");
    packet(FXP_STATUS, &b)
}

fn attrs_reply(id: u32, a: &Attrs) -> Vec<u8> {
    let mut b = Vec::new();
    put_u32(&mut b, id);
    a.encode(&mut b);
    packet(FXP_ATTRS, &b)
}

fn longname(name: &str, a: &Attrs) -> String {
    let mode = a.permissions.unwrap_or(0);
    let kind = match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        _ => '-',
    };
    let bits: String = (0..9)
        .map(|i| {
            let on = mode & (0o400 >> i) != 0;
            if !on { '-' } else { ['r', 'w', 'x'][i % 3] }
        })
        .collect();
    format!("{kind}{bits}    1 test     test     {:>8} Jan  1 00:00 {name}", a.size.unwrap_or(0))
}

impl Server {
    fn local(&self, path: &str) -> PathBuf {
        let virt = normalize(path);
        let mut p = self.root.clone();
        // A part with a backslash or a colon could leave the root on Windows (`..\x`, `C:`); it is replaced, never pushed.
        for part in virt.split('/').filter(|s| !s.is_empty()) {
            if part.contains(['\\', ':']) {
                p.push(part.replace(['\\', ':'], "_"));
            } else {
                p.push(part);
            }
        }
        p
    }

    fn add(&mut self, h: Handle) -> String {
        self.next += 1;
        let id = format!("h{}", self.next);
        self.handles.insert(id.clone(), h);
        id
    }

    fn handle_reply(id: u32, handle: &str) -> Vec<u8> {
        let mut b = Vec::new();
        put_u32(&mut b, id);
        put_bytes(&mut b, handle.as_bytes());
        packet(FXP_HANDLE, &b)
    }

    fn set_attrs(path: &Path, a: &Attrs) -> std::io::Result<()> {
        if let Some(size) = a.size {
            OpenOptions::new().write(true).open(path)?.set_len(size)?;
        }
        if let Some((atime, mtime)) = a.times {
            let f = File::options().write(true).open(path).or_else(|_| File::open(path))?;
            let times = std::fs::FileTimes::new()
                .set_accessed(UNIX_EPOCH + Duration::from_secs(atime.into()))
                .set_modified(UNIX_EPOCH + Duration::from_secs(mtime.into()));
            f.set_times(times)?;
        }
        #[cfg(unix)]
        if let Some(mode) = a.permissions {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o7777))?;
        }
        Ok(())
    }

    /// Answers one request.
    fn reply(&mut self, kind: u8, body: &[u8]) -> Vec<u8> {
        let mut b = Body(body);
        let Some(id) = b.u32() else { return status(0, FX_BAD_MESSAGE, "bad message") };
        self.answer(id, kind, &mut b).unwrap_or_else(|| status(id, FX_BAD_MESSAGE, "bad message"))
    }

    fn answer(&mut self, id: u32, kind: u8, b: &mut Body<'_>) -> Option<Vec<u8>> {
        let done = |r: std::io::Result<()>| match r {
            Ok(()) => status(id, FX_OK, "ok"),
            Err(e) => status(id, io_status(&e), &e.to_string()),
        };
        Some(match kind {
            FXP_OPEN => {
                let path = self.local(&b.string()?);
                let flags = b.u32()?;
                b.attrs()?;
                let mut o = OpenOptions::new();
                o.read(flags & PF_READ != 0)
                    .write(flags & (PF_WRITE | PF_APPEND) != 0)
                    .append(flags & PF_APPEND != 0)
                    .truncate(flags & PF_TRUNC != 0);
                if flags & PF_CREAT != 0 {
                    if flags & PF_EXCL != 0 {
                        o.create_new(true);
                    } else {
                        o.create(true);
                    }
                }
                match o.open(&path) {
                    Ok(f) => {
                        let h = self.add(Handle::File(f));
                        Self::handle_reply(id, &h)
                    }
                    Err(e) => status(id, io_status(&e), &e.to_string()),
                }
            }
            FXP_CLOSE => {
                let h = b.string()?;
                match self.handles.remove(&h) {
                    Some(_) => status(id, FX_OK, "ok"),
                    None => status(id, FX_FAILURE, "no such handle"),
                }
            }
            FXP_READ => {
                let h = b.string()?;
                let (offset, len) = (b.u64()?, b.u32()?.min(MAX_READ));
                let Some(Handle::File(f)) = self.handles.get_mut(&h) else {
                    return Some(status(id, FX_FAILURE, "no such handle"));
                };
                let mut buf = vec![0u8; len as usize];
                let read = f.seek(SeekFrom::Start(offset)).and_then(|_| f.read(&mut buf));
                match read {
                    Ok(0) => status(id, FX_EOF, "eof"),
                    Ok(n) => {
                        let mut out = Vec::new();
                        put_u32(&mut out, id);
                        put_bytes(&mut out, &buf[..n]);
                        packet(FXP_DATA, &out)
                    }
                    Err(e) => status(id, io_status(&e), &e.to_string()),
                }
            }
            FXP_WRITE => {
                let h = b.string()?;
                let offset = b.u64()?;
                let data = b.bytes()?;
                let Some(Handle::File(f)) = self.handles.get_mut(&h) else {
                    return Some(status(id, FX_FAILURE, "no such handle"));
                };
                done(f.seek(SeekFrom::Start(offset)).and_then(|_| f.write_all(data)))
            }
            FXP_LSTAT | FXP_STAT => {
                let path = self.local(&b.string()?);
                let meta = if kind == FXP_LSTAT { std::fs::symlink_metadata(&path) } else { std::fs::metadata(&path) };
                match meta {
                    Ok(m) => attrs_reply(id, &Attrs::of(&m)),
                    Err(e) => status(id, io_status(&e), &e.to_string()),
                }
            }
            FXP_FSTAT => {
                let h = b.string()?;
                let meta = match self.handles.get(&h) {
                    Some(Handle::File(f)) => f.metadata(),
                    Some(Handle::Dir(_, p)) => std::fs::metadata(p),
                    None => return Some(status(id, FX_FAILURE, "no such handle")),
                };
                match meta {
                    Ok(m) => attrs_reply(id, &Attrs::of(&m)),
                    Err(e) => status(id, io_status(&e), &e.to_string()),
                }
            }
            FXP_SETSTAT => {
                let path = self.local(&b.string()?);
                let a = b.attrs()?;
                done(Self::set_attrs(&path, &a))
            }
            FXP_FSETSTAT => {
                let h = b.string()?;
                let a = b.attrs()?;
                match self.handles.get(&h) {
                    Some(Handle::File(f)) => {
                        let r = (|| {
                            if let Some(size) = a.size {
                                f.set_len(size)?;
                            }
                            if let Some((atime, mtime)) = a.times {
                                let times = std::fs::FileTimes::new()
                                    .set_accessed(UNIX_EPOCH + Duration::from_secs(atime.into()))
                                    .set_modified(UNIX_EPOCH + Duration::from_secs(mtime.into()));
                                f.set_times(times)?;
                            }
                            Ok(())
                        })();
                        done(r)
                    }
                    Some(Handle::Dir(_, p)) => {
                        let p = p.clone();
                        done(Self::set_attrs(&p, &a))
                    }
                    None => status(id, FX_FAILURE, "no such handle"),
                }
            }
            FXP_OPENDIR => {
                let path = self.local(&b.string()?);
                match std::fs::read_dir(&path) {
                    Ok(rd) => {
                        let h = self.add(Handle::Dir(Some(rd), path));
                        Self::handle_reply(id, &h)
                    }
                    Err(e) => status(id, io_status(&e), &e.to_string()),
                }
            }
            FXP_READDIR => {
                let h = b.string()?;
                let Some(Handle::Dir(rd, _)) = self.handles.get_mut(&h) else {
                    return Some(status(id, FX_FAILURE, "no such handle"));
                };
                let Some(rd) = rd.as_mut() else { return Some(status(id, FX_EOF, "eof")) };
                let entries: Vec<(String, Attrs)> = rd
                    .by_ref()
                    .take(100)
                    .filter_map(Result::ok)
                    .filter_map(|e| {
                        let meta = std::fs::symlink_metadata(e.path()).ok()?;
                        Some((e.file_name().to_string_lossy().into_owned(), Attrs::of(&meta)))
                    })
                    .collect();
                if entries.is_empty() {
                    if let Some(Handle::Dir(rd, _)) = self.handles.get_mut(&h) {
                        *rd = None;
                    }
                    return Some(status(id, FX_EOF, "eof"));
                }
                let mut out = Vec::new();
                put_u32(&mut out, id);
                put_u32(&mut out, entries.len() as u32);
                for (name, a) in &entries {
                    put_bytes(&mut out, name.as_bytes());
                    put_bytes(&mut out, longname(name, a).as_bytes());
                    a.encode(&mut out);
                }
                packet(FXP_NAME, &out)
            }
            FXP_REMOVE => {
                let path = self.local(&b.string()?);
                done(std::fs::remove_file(path))
            }
            FXP_MKDIR => {
                let path = self.local(&b.string()?);
                b.attrs()?;
                done(std::fs::create_dir(path))
            }
            FXP_RMDIR => {
                let path = self.local(&b.string()?);
                done(std::fs::remove_dir(path))
            }
            FXP_REALPATH => {
                let virt = normalize(&b.string()?);
                let mut out = Vec::new();
                put_u32(&mut out, id);
                put_u32(&mut out, 1);
                put_bytes(&mut out, virt.as_bytes());
                put_bytes(&mut out, virt.as_bytes());
                Attrs::default().encode(&mut out);
                packet(FXP_NAME, &out)
            }
            FXP_RENAME => {
                let (from, to) = (self.local(&b.string()?), self.local(&b.string()?));
                if to.exists() {
                    return Some(status(id, FX_FAILURE, "target exists"));
                }
                done(std::fs::rename(from, to))
            }
            _ => status(id, FX_OP_UNSUPPORTED, "unsupported"),
        })
    }
}

/// Serves one SFTP session on `stream` until the client closes it.
pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, root: PathBuf) -> std::io::Result<()> {
    let mut server = Server { root, handles: HashMap::new(), next: 0 };
    let Some((FXP_INIT, _)) = read_packet(&mut stream).await else { return Ok(()) };
    let mut v = Vec::new();
    put_u32(&mut v, 3);
    stream.write_all(&packet(FXP_VERSION, &v)).await?;
    while let Some((kind, body)) = read_packet(&mut stream).await {
        let reply = server.reply(kind, &body);
        stream.write_all(&reply).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_root() {
        assert_eq!(normalize("."), "/");
        assert_eq!(normalize("/a/./b/../c"), "/a/c");
        assert_eq!(normalize("../../etc/passwd"), "/etc/passwd");
        assert_eq!(normalize("a//b/"), "/a/b");
    }

    #[test]
    fn attrs_round_trip() {
        let a = Attrs { size: Some(5), uid_gid: Some((1, 2)), permissions: Some(0o100644), times: Some((3, 4)) };
        let mut out = Vec::new();
        a.encode(&mut out);
        assert_eq!(Body(&out).attrs(), Some(a));
    }

    #[test]
    fn long_names_look_like_ls() {
        let a = Attrs { size: Some(12), permissions: Some(0o040755), ..Attrs::default() };
        assert!(longname("dir", &a).starts_with("drwxr-xr-x"));
    }
}
