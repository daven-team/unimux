//! Node's `fs.stat(path)` for the context tracker and the session listing (H4): size, `mtimeMs`, `birthtimeMs`, `ino` and
//! the file / folder kind, following links. On Windows it is what libuv's `fs__stat` does: open a handle with no data access
//! (FILE_FLAG_BACKUP_SEMANTICS, so folders open too; every sharing mode, so a transcript Claude is writing can be stat'ed)
//! and read GetFileInformationByHandle, whose file index is `stat.ino` and whose creation time is `birthtime`. Comparing
//! `ino` and `birthtimeMs` tells a replaced transcript (same path, new file) from one that only grew.

use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileStat {
    pub size: u64,
    pub mtime_ms: f64,
    pub birthtime_ms: f64,
    pub ino: u64,
    pub is_file: bool,
    pub is_dir: bool,
}

/// `sec * 1e3 + nsec / 1e6` (Node's msFromTimeSpec), negative before 1970.
pub fn ms_of(t: SystemTime) -> f64 {
    let ms = |d: Duration| d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6;
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => ms(d),
        Err(e) => -ms(e.duration()),
    }
}

#[cfg(windows)]
pub fn stat(path: &Path) -> io::Result<FileStat> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{FILETIME, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
    };
    let f = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is open for the duration of the call; info is a valid out pointer.
    unsafe { GetFileInformationByHandle(HANDLE(f.as_raw_handle()), &mut info) }.map_err(io::Error::other)?;
    let time = |ft: FILETIME| {
        let intervals = ((u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime)) as i64 - 116_444_736_000_000_000;
        let d = Duration::new(intervals.unsigned_abs() / 10_000_000, (intervals.unsigned_abs() % 10_000_000) as u32 * 100);
        ms_of(if intervals >= 0 { UNIX_EPOCH + d } else { UNIX_EPOCH - d })
    };
    let is_dir = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
    Ok(FileStat {
        size: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
        mtime_ms: time(info.ftLastWriteTime),
        birthtime_ms: time(info.ftCreationTime),
        ino: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        is_file: !is_dir,
        is_dir,
    })
}

#[cfg(not(windows))]
pub fn stat(path: &Path) -> io::Result<FileStat> {
    let st = std::fs::metadata(path)?;
    #[cfg(unix)]
    let ino = std::os::unix::fs::MetadataExt::ino(&st);
    #[cfg(not(unix))]
    let ino = 0;
    Ok(FileStat {
        size: st.len(),
        mtime_ms: st.modified().map(ms_of).unwrap_or(0.0),
        birthtime_ms: st.created().map(ms_of).unwrap_or(0.0),
        ino,
        is_file: st.is_file(),
        is_dir: st.is_dir(),
    })
}

/// Reads up to `length` bytes at `start` (fewer at the end of the file), like `fh.read(buf, 0, length, start)`.
pub fn read_at(f: &std::fs::File, start: u64, length: usize) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; length];
    let mut done = 0;
    while done < length {
        let n = read_once(f, &mut buf[done..], start + done as u64)?;
        if n == 0 {
            break;
        }
        done += n;
    }
    buf.truncate(done);
    Ok(buf)
}

#[cfg(windows)]
fn read_once(f: &std::fs::File, buf: &mut [u8], at: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(f, buf, at)
}

#[cfg(unix)]
fn read_once(f: &std::fs::File, buf: &mut [u8], at: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(f, buf, at)
}

#[cfg(not(any(windows, unix)))]
fn read_once(f: &std::fs::File, buf: &mut [u8], at: u64) -> io::Result<usize> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = f;
    f.seek(SeekFrom::Start(at))?;
    f.read(buf)
}

/// `readSlice(file, start, length)`: the bytes as `Buffer.toString('utf8')` decodes them (bad sequences as U+FFFD).
pub fn read_slice(path: &Path, start: u64, length: usize) -> io::Result<String> {
    let f = std::fs::File::open(path)?;
    let buf = read_at(&f, start, length)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_tells_a_replaced_file_from_a_grown_one_and_opens_folders() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.jsonl");
        std::fs::write(&file, b"one\n").unwrap();
        let first = stat(&file).unwrap();
        assert!(first.is_file && !first.is_dir);
        assert_eq!(first.size, 4);
        // Kept open while stat'ed (Claude writes the transcript it holds open).
        let held = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        std::io::Write::write_all(&mut &held, b"two\n").unwrap();
        let grown = stat(&file).unwrap();
        assert_eq!((grown.size, grown.ino, grown.birthtime_ms), (8, first.ino, first.birthtime_ms));
        drop(held);
        let other = dir.path().join("b.jsonl");
        std::fs::write(&other, b"one\ntwo\nthree\n").unwrap();
        std::fs::remove_file(&file).unwrap();
        std::fs::rename(&other, &file).unwrap();
        assert_ne!(stat(&file).unwrap().ino, first.ino);
        let folder = stat(dir.path()).unwrap();
        assert!(folder.is_dir && !folder.is_file);
        assert!(stat(&dir.path().join("missing")).is_err());
        assert_eq!(read_slice(&file, 4, 100).unwrap(), "two\nthree\n");
        assert!(first.mtime_ms > 1.6e12);
    }
}
