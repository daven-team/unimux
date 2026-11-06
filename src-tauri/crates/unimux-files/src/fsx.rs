//! The file system calls of 1.1.4 with libuv's semantics: `realpath` (GetFinalPathNameByHandle without the `\\?\` prefix),
//! `readdir` with file types (a reparse point of any kind is a link, as `uv_fs_scandir` reports it), `open` for reading that
//! also opens a folder (FILE_FLAG_BACKUP_SEMANTICS), `stat` times as `mtimeMs`, and `rename` through MoveFileExW.

use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::fserr::FsError;

/// What `fs.Dirent` says about an entry (`withFileTypes`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirentKind {
    Dir,
    File,
    Link,
    Other,
}

pub struct Dirent {
    pub name: String,
    pub kind: DirentKind,
}

fn lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `fs.promises.realpath(path)`.
pub fn realpath(path: &str) -> Result<String, FsError> {
    match std::fs::canonicalize(path) {
        Ok(p) => Ok(strip_verbatim(&lossy(&p))),
        Err(e) => Err(FsError::io(&e, "realpath", path)),
    }
}

/// libuv drops the `\\?\` prefix GetFinalPathNameByHandle puts in front (`\\?\UNC\server\share` -> `\\server\share`).
fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = path.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// `fs.promises.readdir(path, { withFileTypes: true })`, in the order the OS lists them.
pub fn readdir(path: &str) -> Result<Vec<Dirent>, FsError> {
    let fail = |e: io::Error| FsError::io(&e, "scandir", path);
    let mut out = Vec::new();
    for entry in std::fs::read_dir(path).map_err(fail)? {
        let entry = entry.map_err(fail)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push(Dirent { name, kind: dirent_kind(&entry) });
    }
    Ok(out)
}

#[cfg(windows)]
fn dirent_kind(entry: &std::fs::DirEntry) -> DirentKind {
    use std::os::windows::fs::MetadataExt;
    const REPARSE_POINT: u32 = 0x400;
    const DEVICE: u32 = 0x40;
    const DIRECTORY: u32 = 0x10;
    // On Windows the entry's metadata comes from the directory listing itself (no extra call), like libuv's scandir.
    let Ok(meta) = entry.metadata() else { return DirentKind::Other };
    let attributes = meta.file_attributes();
    if attributes & REPARSE_POINT != 0 {
        DirentKind::Link
    } else if attributes & DEVICE != 0 {
        DirentKind::Other
    } else if attributes & DIRECTORY != 0 {
        DirentKind::Dir
    } else {
        DirentKind::File
    }
}

#[cfg(not(windows))]
fn dirent_kind(entry: &std::fs::DirEntry) -> DirentKind {
    match entry.file_type() {
        Ok(t) if t.is_symlink() => DirentKind::Link,
        Ok(t) if t.is_dir() => DirentKind::Dir,
        Ok(t) if t.is_file() => DirentKind::File,
        _ => DirentKind::Other,
    }
}

/// `fs.promises.open(path, 'r')`: a folder opens too (its stat then says it is no file).
pub fn open_read(path: &str) -> Result<File, FsError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    options.open(path).map_err(|e| FsError::io(&e, "open", path))
}

/// Size, kind and times of an open file or a path.
#[derive(Debug, Clone, Copy)]
pub struct Stat {
    pub is_file: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: f64,
    /// `stats.mode` (Unix permission bits; on Windows 0o444 for a read-only file, 0o666 otherwise, plus the type bits).
    pub mode: u32,
    pub readonly: bool,
}

impl Stat {
    pub fn of(meta: &Metadata) -> Self {
        let mtime_ms = meta
            .modified()
            .ok()
            .map(|t| match t.duration_since(UNIX_EPOCH) {
                Ok(d) => d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6,
                Err(e) => -(e.duration().as_secs() as f64 * 1e3 + e.duration().subsec_nanos() as f64 / 1e6),
            })
            .unwrap_or(0.0);
        Self {
            is_file: meta.is_file(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime_ms,
            mode: mode_of(meta),
            readonly: meta.permissions().readonly(),
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
    if meta.permissions().readonly() { 0o444 } else { 0o666 }
}

/// `filehandle.stat()`.
pub fn fstat(file: &File, path: &str) -> Result<Stat, FsError> {
    file.metadata().map(|m| Stat::of(&m)).map_err(|e| FsError::io(&e, "fstat", path))
}

/// `fs.promises.stat(path)` (follows links).
pub fn stat(path: &str) -> Result<Stat, FsError> {
    std::fs::metadata(path).map(|m| Stat::of(&m)).map_err(|e| FsError::io(&e, "stat", path))
}

/// `filehandle.read(buffer, 0, len, 0)` for a regular file: up to `len` bytes from the start (a short read only at the end).
pub fn read_start(file: &mut File, len: usize, path: &str) -> Result<Vec<u8>, FsError> {
    let mut buf = vec![0u8; len];
    let mut filled = 0;
    while filled < len {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(FsError::io(&e, "read", path)),
        }
    }
    buf.truncate(filled);
    Ok(buf)
}

/// `fs.promises.rename(from, to)`: replaces an existing file like libuv (MoveFileExW with MOVEFILE_REPLACE_EXISTING on
/// Windows, so a read-only target refuses as in 1.1.4).
pub fn rename(from: &str, to: &str) -> Result<(), FsError> {
    #[cfg(windows)]
    {
        use windows::Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MoveFileExW};
        use windows::core::HSTRING;
        let result = unsafe { MoveFileExW(&HSTRING::from(from), &HSTRING::from(to), MOVEFILE_REPLACE_EXISTING) };
        result.map_err(|e| FsError::io(&io::Error::from_raw_os_error(e.code().0 & 0xFFFF), "rename", from))
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(from, to).map_err(|e| FsError::io(&e, "rename", from))
    }
}

/// `fs.promises.unlink(path)`; libuv clears a read-only attribute first on Windows.
pub fn unlink(path: &str) -> Result<(), FsError> {
    let fail = |e: io::Error| FsError::io(&e, "unlink", path);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            let meta = std::fs::symlink_metadata(path).map_err(fail)?;
            let mut perms = meta.permissions();
            if !perms.readonly() {
                return Err(fail(e));
            }
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            std::fs::set_permissions(path, perms).map_err(fail)?;
            std::fs::remove_file(path).map_err(fail)
        }
        Err(e) => Err(fail(e)),
    }
}

/// A path as the string 1.1.4 would hold.
pub fn path_string(path: &Path) -> String {
    lossy(path)
}

pub fn path_buf(path: &str) -> PathBuf {
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefixes_go() {
        assert_eq!(strip_verbatim("\\\\?\\C:\\a"), "C:\\a");
        assert_eq!(strip_verbatim("\\\\?\\UNC\\srv\\share\\a"), "\\\\srv\\share\\a");
        assert_eq!(strip_verbatim("/home/a"), "/home/a");
    }
}
