//! The remote side of a session (1.1.4 `RemoteSide`, `RemoteReadStream`, `RemoteWriteStream` and `remoteEntry` of
//! src/sftphost/sides.ts) on the [`SftpClient`]: reads and writes keep [`DEPTH`] requests of [`CHUNK`] bytes in flight,
//! a rename without `posix-rename@openssh.com` moves the old file aside first and puts it back on failure, and the
//! listing entries of the view.

use std::sync::Arc;

use futures::future::BoxFuture;
use futures::stream::{FuturesOrdered, FuturesUnordered, StreamExt};
use serde_json::{Map, Value, json};
use unimux_files::pane::{permission_string, safe_entry_name};

use crate::client::{ClientError, SftpClient};
use crate::error::SftpErrorCode;
use crate::limits::{posix_basename, posix_contains, posix_join, posix_normalize, posix_parent};
use crate::proto::{Attrs, NameEntry};
use crate::sides::{
    DirEntry, EntryKind, FileReader, FileSide, FileWriter, Meta, SideError, SideResult, is_not_found, kind_from_mode,
};
use crate::targets::TargetRegistry;

/// Requests kept in flight per remote stream.
pub const DEPTH: usize = 16;
/// Bytes per request.
pub const CHUNK: usize = 32 * 1024;

fn err(e: ClientError) -> SideError {
    SideError::from(e.code())
}

/// `remoteMeta`.
pub fn remote_meta(a: &Attrs) -> Meta {
    let kind = kind_from_mode(a.mode);
    Meta {
        kind,
        size: if kind == EntryKind::File { a.size.unwrap_or(0) } else { 0 },
        mtime: a.mtime.map(|m| m as i64 * 1000).unwrap_or(0),
        mode: a.mode,
    }
}

fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `ownerFromLongname`: owner and group from the `ls -l` style line a server sends with each name (only when it looks
/// like one).
pub fn owner_from_longname(longname: &str) -> Option<(String, String)> {
    if longname.is_empty() {
        return None;
    }
    let parts: Vec<&str> = longname.trim_matches(is_js_space).split(is_js_space).filter(|p| !p.is_empty()).collect();
    // JS `split(/\s+/)` on a trimmed line gives [""] for an empty one; either way fewer than 5 parts.
    if parts.len() < 5 {
        return None;
    }
    let mut chars = parts[0].chars();
    let first_ok = chars.next().is_some_and(|c| "-dlcbps".contains(c));
    let rest: Vec<char> = chars.take(9).collect();
    if !first_ok || rest.len() < 9 || !rest.iter().all(|c| "-rwxsStT".contains(*c)) {
        return None;
    }
    Some((parts[2].to_string(), parts[3].to_string()))
}

/// `remoteEntry(dir, e)`: one listing entry for the view. A name that is not one safe path segment never reads as a
/// normal entry (its joined path would point elsewhere): `unsafeName`, kind `other`, no path.
pub fn remote_entry(dir: &str, e: &NameEntry) -> Map<String, Value> {
    let meta = remote_meta(&e.attrs);
    let mut m = Map::new();
    m.insert("name".into(), json!(e.filename));
    m.insert("path".into(), json!(posix_join(&[dir, &e.filename])));
    m.insert("kind".into(), json!(meta.kind.as_str()));
    m.insert("size".into(), json!(meta.size));
    m.insert("mtime".into(), json!(meta.mtime));
    m.insert("permissions".into(), json!(meta.mode.map(permission_string).unwrap_or_default()));
    if let Some((owner, group)) = owner_from_longname(&e.longname) {
        m.insert("owner".into(), json!(owner));
        m.insert("group".into(), json!(group));
    }
    if !safe_entry_name(&e.filename, false) {
        m.insert("unsafeName".into(), json!(true));
        m.insert("kind".into(), json!("other"));
        m.insert("path".into(), json!(""));
    }
    m
}

/// `RemoteSide`.
pub struct RemoteSide {
    client: Arc<SftpClient>,
    inflight: TargetRegistry,
}

impl std::fmt::Debug for RemoteSide {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteSide").field("client", &self.client).finish()
    }
}

impl RemoteSide {
    pub fn new(client: Arc<SftpClient>) -> RemoteSide {
        RemoteSide { client, inflight: TargetRegistry::new(posix_normalize) }
    }

    /// The SFTP client (the manage ops and editor files use its raw requests).
    pub fn client(&self) -> &Arc<SftpClient> {
        &self.client
    }

    /// The session ended: pending requests fail with connectionLost, later ones at once.
    pub fn kill(&self) {
        self.client.kill();
    }

    pub fn posix_rename(&self) -> bool {
        self.client.has_posix_rename()
    }

    /// The server offers lsetstat@openssh.com.
    pub fn lsetstat(&self) -> bool {
        self.client.has_lsetstat()
    }

    /// `resolvePath`: the realpath of the remote pane (an error when it does not exist).
    pub async fn resolve_path(&self, path: &str) -> SideResult<String> {
        self.client.realpath(path).await.map_err(err)
    }

    /// `readdirRaw`: entries with owner and permissions (the listing of the remote pane), "." and ".." left out. `max`:
    /// stop once more than this many came.
    pub async fn readdir_raw(&self, path: &str, max: Option<usize>) -> SideResult<Vec<NameEntry>> {
        self.client.readdir(path, max).await.map_err(err)
    }

    /// `chmodNoFollow`: only the permission bits, through lsetstat when offered, else SETSTAT (which follows a symlink:
    /// callers lstat first, and a recursive change as root is refused without lsetstat).
    pub async fn chmod_no_follow(&self, path: &str, mode: u32) -> SideResult<()> {
        let attrs = Attrs::mode(mode & 0o7777);
        if self.lsetstat() {
            self.client.lsetstat(path, &attrs).await.map_err(err)
        } else {
            self.client.setstat(path, &attrs).await.map_err(err)
        }
    }

    async fn meta(&self, path: &str, follow: bool) -> SideResult<Option<Meta>> {
        let r = if follow { self.client.stat(path).await } else { self.client.lstat(path).await };
        match r {
            Ok(a) => Ok(Some(remote_meta(&a))),
            Err(e) if is_not_found(e.code()) => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    async fn rename_impl(&self, from: &str, to: &str, overwrite: bool) -> SideResult<()> {
        let c = &self.client;
        if overwrite && self.posix_rename() {
            return c.posix_rename(from, to).await.map_err(err);
        }
        let there = self.meta(to, false).await?;
        let Some(there) = there else { return c.rename(from, to).await.map_err(err) };
        if !overwrite {
            return Err(SftpErrorCode::Exists.into());
        }
        if there.kind == EntryKind::Dir {
            return Err(SftpErrorCode::IsADirectory.into());
        }
        // Without posix-rename (plain SFTP v3 rename never overwrites): the old file moves aside first, the new one comes in,
        // and only then the aside copy goes. A failure puts the old file back; nothing is deleted while it is the only copy.
        let mut aside = format!("{to}.unimux-old");
        let mut n = 1;
        while self.meta(&aside, false).await?.is_some() {
            aside = format!("{to}.unimux-old{n}");
            n += 1;
        }
        c.rename(to, &aside).await.map_err(err)?;
        if let Err(e) = c.rename(from, to).await {
            let code = e.code();
            if c.rename(&aside, to).await.is_err() {
                return Err(SideError::keep_part(code));
            }
            return Err(code.into());
        }
        let _ = c.remove(&aside).await;
        Ok(())
    }

    async fn open_read_impl(&self, path: &str) -> SideResult<Box<dyn FileReader>> {
        let handle: Arc<[u8]> = self.client.open_read(path).await.map_err(err)?.into();
        let size = match self.client.fstat(&handle).await {
            Ok(a) => remote_meta(&a).size,
            Err(_) => match self.meta(path, true).await {
                Ok(m) => m.map(|m| m.size).unwrap_or(0),
                Err(e) => {
                    self.client.close_nowait(&handle);
                    return Err(e);
                }
            },
        };
        Ok(Box::new(RemoteReader {
            client: self.client.clone(),
            handle: Some(handle),
            size,
            next: 0,
            eof: false,
            inflight: FuturesOrdered::new(),
        }))
    }

    async fn open_write_impl(&self, path: &str) -> SideResult<Box<dyn FileWriter>> {
        let handle: Arc<[u8]> = self.client.open_write(path).await.map_err(err)?.into();
        Ok(Box::new(RemoteWriter {
            client: self.client.clone(),
            handle: Some(handle),
            position: 0,
            inflight: FuturesUnordered::new(),
            failed: None,
        }))
    }
}

impl FileSide for RemoteSide {
    fn remote(&self) -> bool {
        true
    }
    fn case_insensitive(&self) -> bool {
        false
    }
    fn inflight(&self) -> &TargetRegistry {
        &self.inflight
    }
    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<String>>> {
        Box::pin(async move {
            match self.client.realpath(path).await {
                Ok(p) => Ok(Some(p)),
                Err(e) if is_not_found(e.code()) => Ok(None),
                Err(e) => Err(err(e)),
            }
        })
    }
    fn join(&self, dir: &str, name: &str) -> String {
        posix_join(&[dir, name])
    }
    fn valid_name(&self, name: &str) -> bool {
        safe_entry_name(name, false)
    }
    fn contains(&self, parent: &str, child: &str) -> bool {
        posix_contains(parent, child)
    }
    fn basename(&self, path: &str) -> String {
        posix_basename(path)
    }
    fn dirname(&self, path: &str) -> String {
        posix_parent(path)
    }
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<Meta>>> {
        Box::pin(self.meta(path, true))
    }
    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<Meta>>> {
        Box::pin(self.meta(path, false))
    }
    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Vec<DirEntry>>> {
        Box::pin(async move {
            Ok(self
                .readdir_raw(path, None)
                .await?
                .into_iter()
                .map(|e| DirEntry { meta: remote_meta(&e.attrs), name: e.filename, longname: Some(e.longname) })
                .collect())
        })
    }
    fn mkdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async move {
            match self.client.mkdir(path, &Attrs::default()).await {
                Ok(()) => Ok(()),
                Err(e) => {
                    // SFTP v3 answers a generic failure for an existing name: tell it apart.
                    if matches!(self.meta(path, false).await, Ok(Some(_))) {
                        return Err(SftpErrorCode::Exists.into());
                    }
                    Err(err(e))
                }
            }
        })
    }
    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async move { self.client.remove(path).await.map_err(err) })
    }
    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async move {
            match self.client.rmdir(path).await {
                Ok(()) => Ok(()),
                Err(e) => {
                    if e.code() == SftpErrorCode::Failed
                        && self.client.readdir(path, Some(0)).await.is_ok_and(|entries| !entries.is_empty())
                    {
                        return Err(SftpErrorCode::NotEmpty.into());
                    }
                    Err(err(e))
                }
            }
        })
    }
    fn rename<'a>(&'a self, from: &'a str, to: &'a str, overwrite: bool) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(self.rename_impl(from, to, overwrite))
    }
    fn set_mtime<'a>(&'a self, path: &'a str, mtime: i64) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async move {
            let seconds = mtime.div_euclid(1000).clamp(0, u32::MAX as i64) as u32;
            let attrs = Attrs { atime: Some(seconds), mtime: Some(seconds), ..Attrs::default() };
            self.client.setstat(path, &attrs).await.map_err(err)
        })
    }
    fn open_read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Box<dyn FileReader>>> {
        Box::pin(self.open_read_impl(path))
    }
    fn open_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Box<dyn FileWriter>>> {
        Box::pin(self.open_write_impl(path))
    }
}

/// One chunk; a short answer is read on until the chunk is full or the file ends.
async fn read_at(client: Arc<SftpClient>, handle: Arc<[u8]>, position: u64, length: usize) -> Result<Vec<u8>, ClientError> {
    let mut buf = Vec::with_capacity(length);
    while buf.len() < length {
        let part = client.read(&handle, position + buf.len() as u64, (length - buf.len()) as u32).await?;
        if part.is_empty() {
            break;
        }
        buf.extend_from_slice(&part);
    }
    Ok(buf)
}

type ReadFuture = BoxFuture<'static, (usize, Result<Vec<u8>, ClientError>)>;

/// `RemoteReadStream`: up to [`DEPTH`] reads in flight, chunks handed out in order.
struct RemoteReader {
    client: Arc<SftpClient>,
    handle: Option<Arc<[u8]>>,
    size: u64,
    next: u64,
    eof: bool,
    inflight: FuturesOrdered<ReadFuture>,
}

impl RemoteReader {
    fn fill(&mut self) {
        let Some(handle) = &self.handle else { return };
        while !self.eof && self.inflight.len() < DEPTH && self.next < self.size {
            let length = CHUNK.min((self.size - self.next) as usize);
            let (client, handle, position) = (self.client.clone(), handle.clone(), self.next);
            self.inflight.push_back(Box::pin(async move { (length, read_at(client, handle, position, length).await) }));
            self.next += length as u64;
        }
    }
}

impl FileReader for RemoteReader {
    fn size(&self) -> u64 {
        self.size
    }

    fn next_chunk(&mut self) -> BoxFuture<'_, SideResult<Option<Vec<u8>>>> {
        Box::pin(async move {
            if self.eof || self.handle.is_none() {
                return Ok(None);
            }
            self.fill();
            let Some((length, data)) = self.inflight.next().await else {
                self.eof = true;
                return Ok(None);
            };
            let buf = data.map_err(err)?;
            // The file got shorter while it was read: what was read is the whole file.
            if buf.len() < length {
                self.eof = true;
                self.inflight = FuturesOrdered::new();
                if buf.is_empty() {
                    return Ok(None);
                }
            }
            Ok(Some(buf))
        })
    }

    fn close(mut self: Box<Self>) -> BoxFuture<'static, ()> {
        self.inflight = FuturesOrdered::new();
        let handle = self.handle.take();
        let client = self.client.clone();
        Box::pin(async move {
            if let Some(h) = handle {
                let _ = client.close(&h).await;
            }
        })
    }
}

impl Drop for RemoteReader {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            self.client.close_nowait(&h);
        }
    }
}

/// `RemoteWriteStream`: writes at increasing offsets with up to [`DEPTH`] writes of at most [`CHUNK`] bytes in flight;
/// the first failure sticks.
struct RemoteWriter {
    client: Arc<SftpClient>,
    handle: Option<Arc<[u8]>>,
    position: u64,
    inflight: FuturesUnordered<BoxFuture<'static, Result<(), ClientError>>>,
    failed: Option<SftpErrorCode>,
}

impl RemoteWriter {
    async fn settle_one(&mut self) {
        if let Some(Err(e)) = self.inflight.next().await
            && self.failed.is_none()
        {
            self.failed = Some(e.code());
        }
    }
}

impl FileWriter for RemoteWriter {
    fn write(&mut self, data: Vec<u8>) -> BoxFuture<'_, SideResult<()>> {
        Box::pin(async move {
            let Some(handle) = self.handle.clone() else { return Err(SftpErrorCode::Cancelled.into()) };
            for piece in data.chunks(CHUNK) {
                while self.inflight.len() >= DEPTH && self.failed.is_none() {
                    self.settle_one().await;
                }
                if let Some(code) = self.failed {
                    return Err(code.into());
                }
                let (client, handle, position, piece) = (self.client.clone(), handle.clone(), self.position, piece.to_vec());
                self.position += piece.len() as u64;
                self.inflight.push(Box::pin(async move { client.write(&handle, position, &piece).await }));
            }
            match self.failed {
                Some(code) => Err(code.into()),
                None => Ok(()),
            }
        })
    }

    fn finish(mut self: Box<Self>) -> BoxFuture<'static, SideResult<()>> {
        Box::pin(async move {
            while !self.inflight.is_empty() {
                self.settle_one().await;
            }
            let Some(handle) = self.handle.take() else { return Err(SftpErrorCode::Cancelled.into()) };
            if let Some(code) = self.failed {
                let _ = self.client.close(&handle).await;
                return Err(code.into());
            }
            self.client.close(&handle).await.map_err(err)
        })
    }

    fn abort(mut self: Box<Self>) -> BoxFuture<'static, ()> {
        self.inflight = FuturesUnordered::new();
        let handle = self.handle.take();
        let client = self.client.clone();
        Box::pin(async move {
            if let Some(h) = handle {
                let _ = client.close(&h).await;
            }
        })
    }
}

impl Drop for RemoteWriter {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            self.client.close_nowait(&h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(filename: &str, longname: &str, mode: Option<u32>) -> NameEntry {
        NameEntry {
            filename: filename.into(),
            longname: longname.into(),
            attrs: Attrs { size: Some(12), mode, mtime: Some(2), ..Attrs::default() },
        }
    }

    #[test]
    fn owner_needs_an_ls_line() {
        assert_eq!(
            owner_from_longname("-rw-r--r--    1 alice    staff        12 Jan  1 00:00 a.txt"),
            Some(("alice".into(), "staff".into()))
        );
        assert_eq!(owner_from_longname("drwxr-xr-x 2 root root"), None);
        assert_eq!(owner_from_longname("x rw-r--r-- 1 a b c"), None);
        assert_eq!(owner_from_longname(""), None);
        assert_eq!(owner_from_longname("\u{a0}lrwxrwxrwx\u{3000}1 u g 3 x"), Some(("u".into(), "g".into())));
    }

    #[test]
    fn entries_have_the_ts_shape() {
        let e = remote_entry("/home", &name("a.txt", "-rw-r--r-- 1 u g 12 Jan 1 00:00 a.txt", Some(0o100644)));
        assert_eq!(
            Value::Object(e).to_string(),
            r#"{"name":"a.txt","path":"/home/a.txt","kind":"file","size":12,"mtime":2000,"permissions":"-rw-r--r--","owner":"u","group":"g"}"#
        );
        let d = remote_entry("/", &name("d", "", Some(0o40755)));
        assert_eq!(
            Value::Object(d).to_string(),
            r#"{"name":"d","path":"/d","kind":"dir","size":0,"mtime":2000,"permissions":"drwxr-xr-x"}"#
        );
        let bad = remote_entry("/x", &name("a\\b", "", None));
        assert_eq!(
            Value::Object(bad).to_string(),
            r#"{"name":"a\\b","path":"","kind":"other","size":0,"mtime":2000,"permissions":"","unsafeName":true}"#
        );
    }
}
