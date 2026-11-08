//! Port of src/main/atomicWrite.ts: a unique temp file next to the target, flushed to disk, then renamed over it. Windows file
//! locks (Defender, the indexer, OneDrive) make the rename fail with a sharing violation or access denied for a moment; it is
//! retried with a short doubling backoff instead of failing the save.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::time::{base36, now_ms};

/// Options of one write (defaults as in the TS code).
#[derive(Debug, Clone)]
pub struct AtomicWriteOptions {
    /// File mode of a new file on POSIX (0o600 for private files).
    pub mode: Option<u32>,
    /// Flush the temp file before the rename (default true).
    pub fsync: bool,
    /// Retries of a rename that hit a transient lock (default 5).
    pub retries: u32,
    /// First wait between retries in ms, doubled each time (default 20).
    pub backoff_ms: u64,
}

impl Default for AtomicWriteOptions {
    fn default() -> Self {
        Self { mode: None, fsync: true, retries: 5, backoff_ms: 20 }
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// `<file>.<pid>.<base36 ms><base36 counter>.tmp`: no other writer can share it.
pub fn temp_path_for(file: &Path) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".{}.{}{}.tmp", std::process::id(), base36(now_ms().max(0) as u64), base36(n)));
    PathBuf::from(name)
}

/// EPERM / EBUSY / EACCES of Node: a file another process holds for a moment.
pub fn is_transient(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::PermissionDenied || error.kind() == io::ErrorKind::ResourceBusy {
        return true;
    }
    #[cfg(windows)]
    {
        // ERROR_ACCESS_DENIED 5, ERROR_SHARING_VIOLATION 32, ERROR_LOCK_VIOLATION 33 (libuv maps them to EPERM/EBUSY/EACCES).
        if let Some(code) = error.raw_os_error() {
            return matches!(code, 5 | 32 | 33);
        }
    }
    #[cfg(unix)]
    {
        if let Some(code) = error.raw_os_error() {
            // EPERM 1, EACCES 13, EBUSY 16
            return matches!(code, 1 | 13 | 16);
        }
    }
    false
}

/// Writes `data` to `file` atomically; returns the last error once the retries are used up (the temp file is removed then).
pub fn atomic_write(file: &Path, data: &[u8], options: &AtomicWriteOptions) -> io::Result<()> {
    atomic_write_with(file, data, options, &mut |ms| std::thread::sleep(Duration::from_millis(ms)), &mut |from, to| {
        fs::rename(from, to)
    })
}

/// [`atomic_write`] with seams for the sleep and the rename (tests).
pub fn atomic_write_with(
    file: &Path,
    data: &[u8],
    options: &AtomicWriteOptions,
    sleep: &mut dyn FnMut(u64),
    rename: &mut dyn FnMut(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    write_with(file, data, options, sleep, &mut |f| f.sync_all(), rename)
}

/// [`atomic_write_with`] with a seam for the flush of the temp file too.
fn write_with(
    file: &Path,
    data: &[u8],
    options: &AtomicWriteOptions,
    sleep: &mut dyn FnMut(u64),
    sync: &mut dyn FnMut(&fs::File) -> io::Result<()>,
    rename: &mut dyn FnMut(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let temp = temp_path_for(file);
    let result = (|| {
        let mut open = OpenOptions::new();
        open.write(true).create(true).truncate(true);
        #[cfg(unix)]
        if let Some(mode) = options.mode {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(mode);
        }
        #[cfg(not(unix))]
        let _ = options.mode;
        {
            let mut f = open.open(&temp)?;
            f.write_all(data)?;
            if options.fsync {
                sync(&f)?;
            }
        }
        let mut attempt = 0u32;
        loop {
            match rename(&temp, file) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if attempt >= options.retries || !is_transient(&error) {
                        return Err(error);
                    }
                    sleep(options.backoff_ms << attempt);
                    attempt += 1;
                }
            }
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        atomic_write(&file, b"one", &AtomicWriteOptions::default()).unwrap();
        atomic_write(&file, b"two", &AtomicWriteOptions::default()).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"two");
        // No temp file left behind.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn temp_name_shape() {
        let name = temp_path_for(Path::new("C:/x/state.json")).to_string_lossy().into_owned();
        let pid = std::process::id().to_string();
        assert!(name.starts_with(&format!("C:/x/state.json.{pid}.")), "{name}");
        assert!(name.ends_with(".tmp"));
        let id = &name[format!("C:/x/state.json.{pid}.").len()..name.len() - 4];
        assert!(id.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()), "{id}");
    }

    #[test]
    fn retries_transient_rename_failures_with_doubling_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.json");
        let mut waits = Vec::new();
        let mut fails = 3;
        atomic_write_with(&file, b"x", &AtomicWriteOptions::default(), &mut |ms| waits.push(ms), &mut |from, to| {
            if fails > 0 {
                fails -= 1;
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                fs::rename(from, to)
            }
        })
        .unwrap();
        assert_eq!(waits, vec![20, 40, 80]);
        assert_eq!(fs::read(&file).unwrap(), b"x");
    }

    #[test]
    fn gives_up_and_removes_the_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.json");
        let mut waits = 0;
        let error = atomic_write_with(&file, b"x", &AtomicWriteOptions::default(), &mut |_| waits += 1, &mut |_, _| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(waits, 5);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn flushes_the_temp_file_before_the_rename_unless_told_not_to() {
        let dir = tempfile::tempdir().unwrap();
        for (fsync, expected) in [(true, vec!["sync 1", "rename"]), (false, vec!["rename"])] {
            let order = std::cell::RefCell::new(Vec::new());
            let options = AtomicWriteOptions { fsync, ..AtomicWriteOptions::default() };
            write_with(
                &dir.path().join("a.json"),
                b"x",
                &options,
                &mut |_| {},
                &mut |f| {
                    // The data is in the temp file when it is flushed.
                    order.borrow_mut().push(format!("sync {}", f.metadata()?.len()));
                    f.sync_all()
                },
                &mut |from, to| {
                    order.borrow_mut().push("rename".into());
                    fs::rename(from, to)
                },
            )
            .unwrap();
            assert_eq!(order.into_inner(), expected, "fsync {fsync}");
        }
        assert_eq!(fs::read(dir.path().join("a.json")).unwrap(), b"x");
    }

    #[test]
    fn knows_which_error_codes_are_transient() {
        for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::ResourceBusy] {
            assert!(is_transient(&io::Error::from(kind)), "{kind:?}");
        }
        // The raw codes libuv maps to EPERM / EBUSY / EACCES.
        let raw: &[i32] = if cfg!(windows) { &[5, 32, 33] } else { &[1, 13, 16] };
        for code in raw {
            assert!(is_transient(&io::Error::from_raw_os_error(*code)), "{code}");
        }
        assert!(!is_transient(&io::Error::from(io::ErrorKind::NotFound)));
        assert!(!is_transient(&io::Error::from_raw_os_error(2)));
        assert!(!is_transient(&io::Error::other("no code")));
    }

    #[test]
    fn a_permanent_error_is_not_retried() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.json");
        let mut waits = 0;
        let error = atomic_write_with(&file, b"x", &AtomicWriteOptions::default(), &mut |_| waits += 1, &mut |_, _| {
            Err(io::Error::from(io::ErrorKind::NotFound))
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert_eq!(waits, 0);
    }
}
