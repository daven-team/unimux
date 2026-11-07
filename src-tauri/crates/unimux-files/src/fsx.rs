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
pub fn fstat(file: &File) -> Result<Stat, FsError> {
    file.metadata().map(|m| Stat::of(&m)).map_err(|e| FsError::io_handle(&e, "fstat"))
}

/// `fs.promises.stat(path)` (follows links).
pub fn stat(path: &str) -> Result<Stat, FsError> {
    std::fs::metadata(path).map(|m| Stat::of(&m)).map_err(|e| FsError::io(&e, "stat", path))
}

/// `filehandle.read(buffer, 0, len, 0)` for a regular file: up to `len` bytes from the start (a short read only at the end).
pub fn read_start(file: &mut File, len: usize) -> Result<Vec<u8>, FsError> {
    let mut buf = vec![0u8; len];
    let mut filled = 0;
    while filled < len {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(FsError::io_handle(&e, "read")),
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
        result.map_err(|e| FsError::io2(&io::Error::from_raw_os_error(e.code().0 & 0xFFFF), "rename", from, to))
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(from, to).map_err(|e| FsError::io2(&e, "rename", from, to))
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

// ---------- G6: the calls of the file operations (fileOps.ts, localFiles.ts) ----------

/// `fs.promises.lstat(path)`: the entry itself, a link is not followed (on Windows a symlink or a junction is a link, as
/// libuv reports it).
#[derive(Debug, Clone, Copy)]
pub struct Lstat {
    pub is_link: bool,
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
    pub mode: u32,
    pub atime_ms: f64,
    pub mtime_ms: f64,
}

fn epoch_ms(t: Option<std::time::SystemTime>) -> f64 {
    t.map(|t| match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6,
        Err(e) => -(e.duration().as_secs() as f64 * 1e3 + e.duration().subsec_nanos() as f64 / 1e6),
    })
    .unwrap_or(0.0)
}

pub fn lstat(path: &str) -> Result<Lstat, FsError> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| FsError::io(&e, "lstat", path))?;
    let kind = meta.file_type();
    let is_link = kind.is_symlink();
    Ok(Lstat {
        is_link,
        is_dir: !is_link && kind.is_dir(),
        is_file: !is_link && kind.is_file(),
        size: meta.len(),
        mode: mode_of(&meta),
        atime_ms: epoch_ms(meta.accessed().ok()),
        mtime_ms: epoch_ms(meta.modified().ok()),
    })
}

/// `lstat(path).catch(() => null)`.
pub fn lstat_or_none(path: &str) -> Option<Lstat> {
    lstat(path).ok()
}

/// The (device, inode) pair of `lstat(path, { bigint: true })`: on Windows the volume serial number and the 64-bit file
/// index of the entry itself (a link is opened, not followed), like libuv.
pub fn file_id(path: &str) -> Option<(u64, u64)> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_READ_ATTRIBUTES: u32 = 0x80;
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(7)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .ok()?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.ok()?;
        let ino = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
        Some((info.dwVolumeSerialNumber as u64, ino))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::symlink_metadata(path).ok()?;
        Some((meta.dev(), meta.ino()))
    }
}

/// 1.1.4 `sameFile` / `sameLocalFile`: both entries exist and are the same file (dev and a non-zero inode match), the
/// case of a case-only rename on a case-insensitive volume.
pub fn same_file(a: &str, b: &str) -> bool {
    match (file_id(a), file_id(b)) {
        (Some((dev_a, ino_a)), Some((dev_b, ino_b))) => ino_a != 0 && ino_a == ino_b && dev_a == dev_b,
        _ => false,
    }
}

/// `fs.promises.readlink(path)`: the link's text (libuv drops the `\??\` / `\\?\` prefix on Windows).
pub fn readlink(path: &str) -> Result<String, FsError> {
    match std::fs::read_link(path) {
        Ok(p) => Ok(strip_verbatim(&lossy(&p))),
        Err(e) => Err(FsError::io(&e, "readlink", path)),
    }
}

/// What kind of link `fs.symlink` makes on Windows (`type`); ignored elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkType {
    File,
    Junction,
}

/// `fs.promises.symlink(target, path, type)`. A junction points at `resolve(path, '..', target)` (Node makes a junction's
/// target absolute against the link's folder).
pub fn symlink(target: &str, path: &str, kind: LinkType) -> Result<(), FsError> {
    let fail = |e: io::Error| FsError::io2(&e, "symlink", target, path);
    #[cfg(windows)]
    {
        match kind {
            LinkType::Junction => {
                let flavor = crate::jspath::Flavor::Win32;
                let absolute = crate::jspath::resolve(flavor, &[path, "..", target]);
                junction::create(&absolute, path).map_err(fail)
            }
            LinkType::File => std::os::windows::fs::symlink_file(target.replace('/', "\\"), path).map_err(fail),
        }
    }
    #[cfg(unix)]
    {
        let _ = kind;
        std::os::unix::fs::symlink(target, path).map_err(fail)
    }
}

/// `fs.promises.mkdir(path, { mode })` (one folder; the mode only counts on macOS and Linux, under the umask).
pub fn mkdir(path: &str, mode: Option<u32>) -> Result<(), FsError> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(mode.unwrap_or(0o777));
    }
    #[cfg(not(unix))]
    let _ = mode;
    builder.create(path).map_err(|e| FsError::io(&e, "mkdir", path))
}

/// `(await open(path, 'wx')).close()`: a new empty file, never over an existing one.
pub fn create_new_file(path: &str) -> Result<(), FsError> {
    OpenOptions::new().write(true).create_new(true).open(path).map(drop).map_err(|e| FsError::io(&e, "open", path))
}

/// `fs.promises.copyFile(src, dest, COPYFILE_EXCL)`: fails when `dest` exists (CopyFileW with bFailIfExists on Windows, which
/// keeps the attributes; the mode of the source elsewhere, like libuv).
pub fn copy_file_excl(src: &str, dest: &str) -> Result<(), FsError> {
    #[cfg(windows)]
    {
        use windows::Win32::Storage::FileSystem::CopyFileW;
        use windows::core::HSTRING;
        let result = unsafe { CopyFileW(&HSTRING::from(src), &HSTRING::from(dest), true) };
        result.map_err(|e| FsError::io2(&io::Error::from_raw_os_error(e.code().0 & 0xFFFF), "copyfile", src, dest))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let fail = |e: io::Error| FsError::io2(&e, "copyfile", src, dest);
        let mut input = File::open(src).map_err(fail)?;
        let meta = input.metadata().map_err(fail)?;
        let mut output =
            OpenOptions::new().write(true).create_new(true).mode(mode_of(&meta) & 0o7777).open(dest).map_err(fail)?;
        let copied = io::copy(&mut input, &mut output).and_then(|_| output.set_permissions(meta.permissions()));
        if let Err(e) = copied {
            drop(output);
            let _ = std::fs::remove_file(dest);
            return Err(fail(e));
        }
        Ok(())
    }
}

/// `fs.promises.utimes(path, atime, mtime)` with the times of a `Stats` (Dates: whole milliseconds, `Math.round`).
pub fn utimes(path: &str, atime_ms: f64, mtime_ms: f64) -> Result<(), FsError> {
    let round = |ms: f64| (ms + 0.5).floor();
    let (atime_ms, mtime_ms) = (round(atime_ms), round(mtime_ms));
    #[cfg(windows)]
    {
        use std::fs::FileTimes;
        use std::os::windows::fs::OpenOptionsExt;
        use std::time::Duration;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
        let fail = |e: io::Error| FsError::io(&e, "utime", path);
        let at = |ms: f64| {
            if ms >= 0.0 {
                UNIX_EPOCH + Duration::from_millis(ms as u64)
            } else {
                UNIX_EPOCH - Duration::from_millis((-ms) as u64)
            }
        };
        let file = OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .share_mode(7)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(fail)?;
        file.set_times(FileTimes::new().set_accessed(at(atime_ms)).set_modified(at(mtime_ms))).map_err(fail)
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        let spec = |ms: f64| {
            let secs = (ms / 1e3).floor();
            libc::timespec { tv_sec: secs as libc::time_t, tv_nsec: ((ms - secs * 1e3) * 1e6) as libc::c_long }
        };
        let c = CString::new(path).map_err(|_| FsError::plain("utime"))?;
        let times = [spec(atime_ms), spec(mtime_ms)];
        if unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err(FsError::io(&io::Error::last_os_error(), "utime", path))
        }
    }
}

/// `fs.promises.rm(path, { recursive: true, force: true })`: a missing path is fine, a link is removed (never what it
/// points to), a folder with everything in it.
pub fn rm_rf(path: &str) -> Result<(), FsError> {
    let fail = |e: io::Error| FsError::io(&e, "rm", path);
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(fail(e)),
    };
    let kind = meta.file_type();
    if kind.is_dir() && !kind.is_symlink() {
        return std::fs::remove_dir_all(path).map_err(fail);
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        // A junction or a directory symlink on Windows goes with RemoveDirectory.
        Err(e) if kind.is_symlink() => std::fs::remove_dir(path).map_err(|_| fail(e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => unlink(path),
    }
}

/// The names in a folder (`fs.promises.readdir(path)`), in the order the OS lists them.
pub fn readdir_names(path: &str) -> Result<Vec<String>, FsError> {
    Ok(readdir(path)?.into_iter().map(|d| d.name).collect())
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
