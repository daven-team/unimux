//! The two ends of a transfer behind one interface (1.1.4 src/sftphost/sides.ts): the local disk ([`crate::local`]) and a
//! remote SFTP session ([`crate::remote`]). Readers and writers move the bytes; the remote ones keep several requests in
//! flight (one request per round trip would crawl over a real link) and close their handle when they are dropped.

use futures::future::BoxFuture;

use crate::error::SftpErrorCode;
use crate::targets::TargetRegistry;

/// `EntryKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntryKind::File => "file",
            EntryKind::Dir => "dir",
            EntryKind::Symlink => "symlink",
            EntryKind::Other => "other",
        }
    }
}

pub const S_IFMT: u32 = 0o170000;
pub const S_IFDIR: u32 = 0o040000;
pub const S_IFREG: u32 = 0o100000;
pub const S_IFLNK: u32 = 0o120000;

/// `kindFromMode`.
pub fn kind_from_mode(mode: Option<u32>) -> EntryKind {
    match mode.unwrap_or(0) & S_IFMT {
        S_IFDIR => EntryKind::Dir,
        S_IFREG => EntryKind::File,
        S_IFLNK => EntryKind::Symlink,
        _ => EntryKind::Other,
    }
}

/// `Meta`: what a stat says. `size` is 0 for anything but a file; `mtime` in ms (0 when unknown).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Meta {
    pub kind: EntryKind,
    pub size: u64,
    pub mtime: i64,
    pub mode: Option<u32>,
}

/// `DirEntry`: one name of a folder with its (not followed) meta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub longname: Option<String>,
    pub meta: Meta,
}

/// `SftpError`: one of the fixed codes the UI shows (raw messages never leave the host). `keep_part`: the old target is
/// gone and could not be put back, so the complete part file is the only copy: never delete it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SideError {
    pub code: SftpErrorCode,
    pub keep_part: bool,
}

impl SideError {
    pub fn keep_part(code: SftpErrorCode) -> SideError {
        SideError { code, keep_part: true }
    }
}

impl From<SftpErrorCode> for SideError {
    fn from(code: SftpErrorCode) -> Self {
        SideError { code, keep_part: false }
    }
}

impl std::fmt::Display for SideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code.as_str())
    }
}

pub type SideResult<T> = Result<T, SideError>;

/// `isNotFound`: nothing there (or a parent is no folder).
pub fn is_not_found(code: SftpErrorCode) -> bool {
    matches!(code, SftpErrorCode::NotFound | SftpErrorCode::NotADirectory)
}

/// A file being read: its chunks in order.
pub trait FileReader: Send {
    /// The size when it was opened (the reader never reads past it).
    fn size(&self) -> u64;
    /// The next chunk; None at the end.
    fn next_chunk(&mut self) -> BoxFuture<'_, SideResult<Option<Vec<u8>>>>;
    /// Closes the file (a dropped reader closes it too, without waiting).
    fn close(self: Box<Self>) -> BoxFuture<'static, ()>;
}

/// A file being written at increasing offsets.
pub trait FileWriter: Send {
    /// Queues `data` (may wait while enough is in flight); the first failure of any earlier write comes back here.
    fn write(&mut self, data: Vec<u8>) -> BoxFuture<'_, SideResult<()>>;
    /// Waits for every write and closes the file: the first failure, else the close's.
    fn finish(self: Box<Self>) -> BoxFuture<'static, SideResult<()>>;
    /// Stops: closes the file without waiting for writes in flight (a dropped writer does the same).
    fn abort(self: Box<Self>) -> BoxFuture<'static, ()>;
}

/// `FileSide`.
pub trait FileSide: Send + Sync {
    fn remote(&self) -> bool;
    /// Names that differ only in case are the same file (Windows and default macOS disks).
    fn case_insensitive(&self) -> bool;
    /// Targets being written right now on this side (all queues that write here share it).
    fn inflight(&self) -> &TargetRegistry;
    /// Resolves symlinks (None when nothing is there).
    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<String>>>;
    fn join(&self, dir: &str, name: &str) -> String;
    /// A name read from a folder may be joined onto a path of this side (never "..", no separators: `safeEntryName`).
    fn valid_name(&self, name: &str) -> bool;
    /// `child` is `parent` or inside it.
    fn contains(&self, parent: &str, child: &str) -> bool;
    fn basename(&self, path: &str) -> String;
    fn dirname(&self, path: &str) -> String;
    /// Follows symlinks; None when nothing is there.
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<Meta>>>;
    /// Does not follow symlinks; None when nothing is there.
    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<Meta>>>;
    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Vec<DirEntry>>>;
    /// [`FileSide::readdir`] of a walk (T3): a folder with more than `max` entries fails with `tooMany` (the remote side
    /// stops reading after `max + 1`, so a huge or hostile folder never fills the memory).
    fn readdir_max<'a>(&'a self, path: &'a str, max: usize) -> BoxFuture<'a, SideResult<Vec<DirEntry>>> {
        Box::pin(async move {
            let entries = self.readdir(path).await?;
            if entries.len() > max { Err(SftpErrorCode::TooMany.into()) } else { Ok(entries) }
        })
    }
    fn mkdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>>;
    /// A file or symlink.
    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>>;
    /// An empty folder.
    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>>;
    /// `overwrite`: an existing target is replaced (atomically where the server can). Without it an existing target fails.
    fn rename<'a>(&'a self, from: &'a str, to: &'a str, overwrite: bool) -> BoxFuture<'a, SideResult<()>>;
    /// `mtime` in ms.
    fn set_mtime<'a>(&'a self, path: &'a str, mtime: i64) -> BoxFuture<'a, SideResult<()>>;
    fn open_read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Box<dyn FileReader>>>;
    fn open_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Box<dyn FileWriter>>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_from_mode() {
        assert_eq!(kind_from_mode(Some(0o40755)), EntryKind::Dir);
        assert_eq!(kind_from_mode(Some(0o100644)), EntryKind::File);
        assert_eq!(kind_from_mode(Some(0o120777)), EntryKind::Symlink);
        assert_eq!(kind_from_mode(Some(0o20666)), EntryKind::Other);
        assert_eq!(kind_from_mode(None), EntryKind::Other);
        assert!(is_not_found(SftpErrorCode::NotADirectory));
        assert!(SideError::keep_part(SftpErrorCode::Failed).keep_part);
    }
}
