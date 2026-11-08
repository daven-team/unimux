//! The local side of a transfer (1.1.4 `LocalSide`, `localError` and `sameLocalFile` of src/sftphost/sides.ts) with
//! libuv's semantics from unimux-files (`realpath` without the `\\?\` prefix, lstat that reports a junction as a link,
//! rename through MoveFileExW, unlink that clears a read-only attribute). Names from a server become Windows paths only
//! when they pass `safeEntryName(name, { windows: true })`. Every disk call runs on the blocking pool.

use std::io;

use futures::future::BoxFuture;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use unimux_files::fserr::{FsError, uv_code};
use unimux_files::fsx;
use unimux_files::jspath::{self, Flavor};
use unimux_files::pane::safe_entry_name;

use crate::error::SftpErrorCode;
use crate::sides::{
    DirEntry, EntryKind, FileReader, FileSide, FileWriter, Meta, S_IFDIR, S_IFLNK, S_IFREG, SideError, SideResult, is_not_found,
};
use crate::targets::TargetRegistry;

const F: Flavor = Flavor::native();
/// Bytes per local read (`createReadStream` highWaterMark).
const READ_CHUNK: usize = 256 * 1024;

/// `localError`: a libuv error name as the UI's code.
pub fn local_error(code: Option<&str>) -> SftpErrorCode {
    match code {
        Some("ENOENT") => SftpErrorCode::NotFound,
        Some("EEXIST") => SftpErrorCode::Exists,
        Some("EACCES" | "EPERM" | "EBUSY") => SftpErrorCode::Permission,
        Some("ENOTEMPTY") => SftpErrorCode::NotEmpty,
        Some("ENOTDIR") => SftpErrorCode::NotADirectory,
        Some("EISDIR") => SftpErrorCode::IsADirectory,
        Some("ENOSPC" | "EDQUOT") => SftpErrorCode::NoSpace,
        Some("EXDEV") => SftpErrorCode::CrossDevice,
        _ => SftpErrorCode::Failed,
    }
}

fn fs_err(e: FsError) -> SideError {
    local_error(e.code).into()
}

fn io_err(e: io::Error) -> SideError {
    local_error(Some(uv_code(&e))).into()
}

/// Runs a disk call on the blocking pool (an offline share never stalls the runtime).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> SideResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|_| SideError::from(SftpErrorCode::Failed))
}

/// JS `Math.round` of a time in ms.
fn round_ms(ms: f64) -> i64 {
    (ms + 0.5).floor() as i64
}

/// The type bits libuv puts into `st_mode` (Windows' own mode from unimux-files has only the permission bits).
fn typed_mode(mode: u32, kind: EntryKind) -> u32 {
    if cfg!(windows) {
        mode | match kind {
            EntryKind::Symlink => S_IFLNK,
            EntryKind::Dir => S_IFDIR,
            EntryKind::File => S_IFREG,
            EntryKind::Other => 0,
        }
    } else {
        mode
    }
}

fn lstat_meta(st: &fsx::Lstat) -> Meta {
    let kind = if st.is_link {
        EntryKind::Symlink
    } else if st.is_dir {
        EntryKind::Dir
    } else if st.is_file {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    Meta {
        kind,
        size: if kind == EntryKind::File { st.size } else { 0 },
        mtime: round_ms(st.mtime_ms),
        mode: Some(typed_mode(st.mode, kind)),
    }
}

fn stat_meta(st: &fsx::Stat) -> Meta {
    let kind = if st.is_dir {
        EntryKind::Dir
    } else if st.is_file {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    Meta {
        kind,
        size: if kind == EntryKind::File { st.size } else { 0 },
        mtime: round_ms(st.mtime_ms),
        mode: Some(typed_mode(st.mode, kind)),
    }
}

/// `sameLocalFile(a, b)`: `a` and `b` name the same file (a case-only rename on a case-insensitive disk); on a
/// case-sensitive one they differ.
pub async fn same_local_file(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_string(), b.to_string());
    blocking(move || fsx::same_file(&a, &b)).await.unwrap_or(false)
}

fn fold(path: &str, case_insensitive: bool) -> String {
    let r = jspath::resolve(F, &[path]);
    if case_insensitive { r.to_lowercase() } else { r }
}

/// `LocalSide`.
#[derive(Debug)]
pub struct LocalSide {
    case_insensitive: bool,
    windows_names: bool,
    inflight: TargetRegistry,
}

impl Default for LocalSide {
    fn default() -> Self {
        LocalSide::new(cfg!(any(windows, target_os = "macos")), cfg!(windows))
    }
}

impl LocalSide {
    pub fn new(case_insensitive: bool, windows_names: bool) -> LocalSide {
        LocalSide { case_insensitive, windows_names, inflight: TargetRegistry::new(move |p| fold(p, case_insensitive)) }
    }

    async fn meta(&self, path: &str, follow: bool) -> SideResult<Option<Meta>> {
        let p = path.to_string();
        let r =
            blocking(move || if follow { fsx::stat(&p).map(|s| stat_meta(&s)) } else { fsx::lstat(&p).map(|s| lstat_meta(&s)) })
                .await?;
        match r {
            Ok(m) => Ok(Some(m)),
            Err(e) if is_not_found(local_error(e.code)) => Ok(None),
            Err(e) => Err(fs_err(e)),
        }
    }

    async fn fs<T: Send + 'static>(&self, f: impl FnOnce() -> Result<T, FsError> + Send + 'static) -> SideResult<T> {
        blocking(f).await?.map_err(fs_err)
    }
}

impl FileSide for LocalSide {
    fn remote(&self) -> bool {
        false
    }
    fn case_insensitive(&self) -> bool {
        self.case_insensitive
    }
    fn inflight(&self) -> &TargetRegistry {
        &self.inflight
    }
    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<String>>> {
        let p = path.to_string();
        Box::pin(blocking(move || fsx::realpath(&p).ok()))
    }
    fn join(&self, dir: &str, name: &str) -> String {
        if jspath::is_absolute(F, dir) { jspath::resolve(F, &[dir, name]) } else { jspath::join_name(F, dir, name) }
    }
    fn valid_name(&self, name: &str) -> bool {
        safe_entry_name(name, self.windows_names)
    }
    fn contains(&self, parent: &str, child: &str) -> bool {
        let rel = jspath::relative(F, &fold(parent, self.case_insensitive), &fold(child, self.case_insensitive));
        let sep = jspath::sep_of(F);
        // "..cache" inside the folder is fine; only ".." itself or "../..." leaves it.
        rel.is_empty() || (rel != ".." && !rel.starts_with(&format!("..{sep}")) && !jspath::is_absolute(F, &rel))
    }
    fn basename(&self, path: &str) -> String {
        jspath::basename(F, path)
    }
    fn dirname(&self, path: &str) -> String {
        jspath::dirname(F, path)
    }
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<Meta>>> {
        Box::pin(self.meta(path, true))
    }
    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<Meta>>> {
        Box::pin(self.meta(path, false))
    }
    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Vec<DirEntry>>> {
        let dir = path.to_string();
        let child = move |name: &str| {
            if jspath::is_absolute(F, &dir) { jspath::resolve(F, &[&dir, name]) } else { jspath::join_name(F, &dir, name) }
        };
        let p = path.to_string();
        Box::pin(async move {
            self.fs(move || {
                let names = fsx::readdir_names(&p)?;
                let mut out = Vec::with_capacity(names.len());
                for name in names {
                    // Vanished or unreadable: skipped.
                    if let Ok(st) = fsx::lstat(&child(&name)) {
                        out.push(DirEntry { meta: lstat_meta(&st), name, longname: None });
                    }
                }
                Ok(out)
            })
            .await
        })
    }
    fn mkdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>> {
        let p = path.to_string();
        Box::pin(self.fs(move || fsx::mkdir(&p, None)))
    }
    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>> {
        let p = path.to_string();
        Box::pin(self.fs(move || fsx::unlink(&p)))
    }
    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>> {
        let p = path.to_string();
        Box::pin(self.fs(move || std::fs::remove_dir(&p).map_err(|e| FsError::io(&e, "rmdir", &p))))
    }
    fn rename<'a>(&'a self, from: &'a str, to: &'a str, overwrite: bool) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async move {
            if !overwrite && self.meta(to, false).await?.is_some() && !same_local_file(from, to).await {
                return Err(SftpErrorCode::Exists.into());
            }
            let (f, t) = (from.to_string(), to.to_string());
            self.fs(move || fsx::rename(&f, &t)).await
        })
    }
    fn set_mtime<'a>(&'a self, path: &'a str, mtime: i64) -> BoxFuture<'a, SideResult<()>> {
        let p = path.to_string();
        Box::pin(self.fs(move || fsx::utimes(&p, mtime as f64, mtime as f64)))
    }
    fn open_read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Box<dyn FileReader>>> {
        Box::pin(async move {
            let meta = self.meta(path, true).await?.ok_or(SideError::from(SftpErrorCode::NotFound))?;
            if meta.kind == EntryKind::Dir {
                return Err(SftpErrorCode::IsADirectory.into());
            }
            let p = path.to_string();
            let file = blocking(move || std::fs::File::open(&p)).await?.map_err(io_err)?;
            Ok(Box::new(LocalReader { file: Some(tokio::fs::File::from_std(file)), size: meta.size }) as Box<dyn FileReader>)
        })
    }
    fn open_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Box<dyn FileWriter>>> {
        let p = path.to_string();
        Box::pin(async move {
            let file = blocking(move || std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(&p))
                .await?
                .map_err(io_err)?;
            Ok(Box::new(LocalWriter { file: tokio::fs::File::from_std(file) }) as Box<dyn FileWriter>)
        })
    }
}

/// A local file read in chunks of up to 256 KB (to its end, like `createReadStream`).
struct LocalReader {
    file: Option<tokio::fs::File>,
    size: u64,
}

impl FileReader for LocalReader {
    fn size(&self) -> u64 {
        self.size
    }
    fn next_chunk(&mut self) -> BoxFuture<'_, SideResult<Option<Vec<u8>>>> {
        Box::pin(async move {
            let Some(file) = self.file.as_mut() else { return Ok(None) };
            let mut buf = vec![0u8; READ_CHUNK];
            let n = loop {
                match file.read(&mut buf).await {
                    Ok(n) => break n,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) => return Err(io_err(e)),
                }
            };
            if n == 0 {
                self.file = None;
                return Ok(None);
            }
            buf.truncate(n);
            Ok(Some(buf))
        })
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move { drop(self) })
    }
}

/// A local file written from its start (`createWriteStream(path, { flags: 'w' })`).
struct LocalWriter {
    file: tokio::fs::File,
}

impl FileWriter for LocalWriter {
    fn write(&mut self, data: Vec<u8>) -> BoxFuture<'_, SideResult<()>> {
        Box::pin(async move { self.file.write_all(&data).await.map_err(io_err) })
    }
    fn finish(mut self: Box<Self>) -> BoxFuture<'static, SideResult<()>> {
        Box::pin(async move { self.file.flush().await.map_err(io_err) })
    }
    fn abort(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move { drop(self) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("unimux-t2-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn errors_map_like_local_error() {
        assert_eq!(local_error(Some("ENOENT")), SftpErrorCode::NotFound);
        assert_eq!(local_error(Some("EBUSY")), SftpErrorCode::Permission);
        assert_eq!(local_error(Some("EDQUOT")), SftpErrorCode::NoSpace);
        assert_eq!(local_error(Some("EXDEV")), SftpErrorCode::CrossDevice);
        assert_eq!(local_error(Some("EIO")), SftpErrorCode::Failed);
        assert_eq!(local_error(None), SftpErrorCode::Failed);
        assert_eq!(round_ms(1.5), 2);
        assert_eq!(round_ms(-1.5), -1);
    }

    #[test]
    fn contains_and_names() {
        let side = LocalSide::new(true, true);
        let (a, b) = if cfg!(windows) { ("C:\\Data", "c:\\data\\x") } else { ("/data", "/DATA/x") };
        assert!(side.contains(a, b));
        assert!(side.contains(a, a));
        let dotted = if cfg!(windows) { "C:\\Data\\..cache" } else { "/data/..cache" };
        assert!(side.contains(a, dotted));
        let outside = if cfg!(windows) { "C:\\Data2" } else { "/data2" };
        assert!(!side.contains(a, outside));
        assert!(!side.valid_name("con.txt"));
        assert!(!side.valid_name("a:b"));
        assert!(!side.valid_name("a."));
        assert!(LocalSide::new(false, false).valid_name("a:b"));
        assert_eq!(side.inflight().key(if cfg!(windows) { "C:\\A\\B.txt" } else { "/A/B.txt" }), {
            if cfg!(windows) { "c:\\a\\b.txt" } else { "/a/b.txt" }
        });
        // The in-flight registry folds case on a case-insensitive side only.
        let exact = LocalSide::new(false, false);
        assert_ne!(exact.inflight().key("/x/A.txt"), exact.inflight().key("/x/a.txt"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn copies_lists_renames_and_maps_errors() {
        let dir = scratch("local");
        let d = dir.to_string_lossy().into_owned();
        let side = LocalSide::default();
        let a = side.join(&d, "a.bin");
        let data: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        let mut w = side.open_write(&a).await.unwrap();
        w.write(data[..300_000].to_vec()).await.unwrap();
        w.write(data[300_000..].to_vec()).await.unwrap();
        w.finish().await.unwrap();
        let mut r = side.open_read(&a).await.unwrap();
        assert_eq!(r.size(), data.len() as u64);
        let mut back = Vec::new();
        while let Some(c) = r.next_chunk().await.unwrap() {
            back.extend(c);
        }
        r.close().await;
        assert_eq!(back, data);
        side.set_mtime(&a, 1_600_000_000_000).await.unwrap();
        assert_eq!(side.lstat(&a).await.unwrap().unwrap().mtime, 1_600_000_000_000);
        let sub = side.join(&d, "sub");
        side.mkdir(&sub).await.unwrap();
        assert_eq!(side.mkdir(&sub).await.unwrap_err().code, SftpErrorCode::Exists);
        assert_eq!(side.open_read(&sub).await.err().unwrap().code, SftpErrorCode::IsADirectory);
        let mut names: Vec<(String, EntryKind)> =
            side.readdir(&d).await.unwrap().into_iter().map(|e| (e.name, e.meta.kind)).collect();
        names.sort_by(|x, y| x.0.cmp(&y.0));
        assert_eq!(names, vec![("a.bin".into(), EntryKind::File), ("sub".into(), EntryKind::Dir)]);
        let b = side.join(&d, "b.bin");
        std::fs::write(&b, b"x").unwrap();
        assert_eq!(side.rename(&a, &b, false).await.unwrap_err().code, SftpErrorCode::Exists);
        side.rename(&a, &b, true).await.unwrap();
        assert_eq!(side.stat(&a).await.unwrap(), None);
        assert_eq!(std::fs::read(&b).unwrap().len(), data.len());
        if side.case_insensitive() {
            // A case-only rename is not a conflict with itself.
            let upper = side.join(&d, "B.BIN");
            side.rename(&b, &upper, false).await.unwrap();
            assert!(std::fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name() == "B.BIN"));
        }
        std::fs::write(side.join(&sub, "x"), b"1").unwrap();
        assert_eq!(side.rmdir(&sub).await.unwrap_err().code, SftpErrorCode::NotEmpty);
        assert_eq!(side.unlink(&side.join(&d, "nope")).await.unwrap_err().code, SftpErrorCode::NotFound);
        assert_eq!(side.realpath(&side.join(&d, "nope")).await.unwrap(), None);
        assert!(side.realpath(&d).await.unwrap().is_some_and(|p| !p.starts_with("\\\\?\\")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
