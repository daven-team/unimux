//! File system errors the way Node reports them (libuv's error names and texts), so the messages 1.1.4 showed for unusual
//! failures ("EBUSY: resource busy or locked, open 'C:\\...'"; a call on an open file handle without a path, "EISDIR:
//! illegal operation on a directory, read"; a rename with both paths, "... rename '<from>' -> '<to>'") stay the same and
//! the code checks (`ENOENT` -> "gone") match.

use std::io;

/// A failure of one file operation: the libuv code (`ENOENT`, `EPERM`, ...) and Node's message, or a plain message (the
/// `new Error(text)` throws of 1.1.4, which carry no code).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsError {
    pub code: Option<&'static str>,
    pub message: String,
}

impl FsError {
    /// `throw new Error(message)`.
    pub fn plain(message: impl Into<String>) -> Self {
        Self { code: None, message: message.into() }
    }
    /// A system error of `syscall` on `path`, worded like Node (`<CODE>: <text>, <syscall> '<path>'`).
    pub fn io(error: &io::Error, syscall: &str, path: &str) -> Self {
        let code = uv_code(error);
        Self { code: Some(code), message: format!("{code}: {}, {syscall} '{path}'", uv_text(code)) }
    }
    /// A system error of a call on an open file handle (`filehandle.read`, `.stat`, `.writeFile`, `.sync`): Node words it
    /// without a path (`<CODE>: <text>, <syscall>`).
    pub fn io_handle(error: &io::Error, syscall: &str) -> Self {
        let code = uv_code(error);
        Self { code: Some(code), message: format!("{code}: {}, {syscall}", uv_text(code)) }
    }
    /// A system error of a call with two paths (`rename`): `<CODE>: <text>, <syscall> '<from>' -> '<to>'`.
    pub fn io2(error: &io::Error, syscall: &str, from: &str, to: &str) -> Self {
        let code = uv_code(error);
        Self { code: Some(code), message: format!("{code}: {}, {syscall} '{from}' -> '{to}'", uv_text(code)) }
    }
    pub fn is(&self, code: &str) -> bool {
        self.code == Some(code)
    }
}

impl std::fmt::Display for FsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// libuv's name for an OS error (`uv_translate_sys_error` on Windows, the errno name on Unix).
pub fn uv_code(error: &io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(raw) => os_code(raw),
        None => match error.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EPERM",
            io::ErrorKind::AlreadyExists => "EEXIST",
            io::ErrorKind::InvalidInput => "EINVAL",
            io::ErrorKind::NotADirectory => "ENOTDIR",
            io::ErrorKind::IsADirectory => "EISDIR",
            io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
            _ => "UNKNOWN",
        },
    }
}

#[cfg(windows)]
fn os_code(raw: i32) -> &'static str {
    // libuv src/win/error.c (the file-system part of the table).
    match raw as u32 {
        998 | 10013 | 740 | 1920 => "EACCES", // NOACCESS, WSAEACCES, ELEVATION_REQUIRED, CANT_ACCESS_FILE
        183 | 80 => "EEXIST",                 // ALREADY_EXISTS, FILE_EXISTS
        161 | 2 | 123 | 15 | 4392 | 126 | 3 => "ENOENT", // BAD_PATHNAME, FILE_NOT_FOUND, INVALID_NAME, INVALID_DRIVE, ...
        267 => "ENOTDIR",                     // DIRECTORY
        5 | 1314 => "EPERM",                  // ACCESS_DENIED, PRIVILEGE_NOT_HELD
        32 | 33 | 170 => "EBUSY",             // SHARING_VIOLATION, LOCK_VIOLATION, BUSY
        145 => "ENOTEMPTY",                   // DIR_NOT_EMPTY
        1921 => "ELOOP",                      // CANT_RESOLVE_FILENAME
        206 => "ENAMETOOLONG",                // FILENAME_EXCED_RANGE
        17 => "EXDEV",                        // NOT_SAME_DEVICE
        19 => "EROFS",                        // WRITE_PROTECT
        112 | 39 => "ENOSPC",                 // DISK_FULL, HANDLE_DISK_FULL
        4 => "EMFILE",                        // TOO_MANY_OPEN_FILES
        1 => "EISDIR",                        // INVALID_FUNCTION
        6 => "EBADF",                         // INVALID_HANDLE
        87 => "EINVAL",                       // INVALID_PARAMETER
        121 => "ETIMEDOUT",                   // SEM_TIMEOUT
        64 => "ECONNRESET",                   // NETNAME_DELETED
        1117 | 23 | 25 | 27 => "EIO",         // IO_DEVICE, CRC, SEEK, SECTOR_NOT_FOUND
        _ => "UNKNOWN",
    }
}

#[cfg(unix)]
fn os_code(raw: i32) -> &'static str {
    match raw {
        libc::ENOENT => "ENOENT",
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::EBUSY => "EBUSY",
        libc::ELOOP => "ELOOP",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::EMFILE => "EMFILE",
        libc::ENFILE => "ENFILE",
        libc::EINVAL => "EINVAL",
        libc::EEXIST => "EEXIST",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::EXDEV => "EXDEV",
        libc::EROFS => "EROFS",
        libc::ENOSPC => "ENOSPC",
        libc::EIO => "EIO",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::EAGAIN => "EAGAIN",
        libc::EBADF => "EBADF",
        libc::EFBIG => "EFBIG",
        libc::ENXIO => "ENXIO",
        libc::EDQUOT => "EDQUOT",
        _ => "UNKNOWN",
    }
}

/// `uv_strerror` of a code.
pub fn uv_text(code: &str) -> &'static str {
    match code {
        "ENOENT" => "no such file or directory",
        "EACCES" => "permission denied",
        "EPERM" => "operation not permitted",
        "ENOTDIR" => "not a directory",
        "EISDIR" => "illegal operation on a directory",
        "EBUSY" => "resource busy or locked",
        "ELOOP" => "too many symbolic links encountered",
        "ENAMETOOLONG" => "name too long",
        "EMFILE" => "too many open files",
        "ENFILE" => "file table overflow",
        "EINVAL" => "invalid argument",
        "EEXIST" => "file already exists",
        "ENOTEMPTY" => "directory not empty",
        "EXDEV" => "cross-device link not permitted",
        "EROFS" => "read-only file system",
        "ENOSPC" => "no space left on device",
        "EIO" => "i/o error",
        "ETIMEDOUT" => "connection timed out",
        "ECONNRESET" => "connection reset by peer",
        "EAGAIN" => "resource temporarily unavailable",
        "EBADF" => "bad file descriptor",
        "EFBIG" => "file too large",
        "ENXIO" => "no such device or address",
        "EDQUOT" => "disk quota exceeded",
        _ => "unknown error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_wording() {
        let e = io::Error::from(io::ErrorKind::NotFound);
        assert_eq!(FsError::io(&e, "open", "C:\\x").message, "ENOENT: no such file or directory, open 'C:\\x'");
        // Node 26: fs.promises.rename('C:/nope-xyz/a', 'C:/nope-xyz/b'), and filehandle.read on an opened folder.
        assert_eq!(
            FsError::io2(&e, "rename", "C:\\nope-xyz\\a", "C:\\nope-xyz\\b").message,
            "ENOENT: no such file or directory, rename 'C:\\nope-xyz\\a' -> 'C:\\nope-xyz\\b'"
        );
        let dir = io::Error::from(io::ErrorKind::IsADirectory);
        assert_eq!(FsError::io_handle(&dir, "read").message, "EISDIR: illegal operation on a directory, read");
        #[cfg(windows)]
        {
            // A save's final rename over a file another program holds open (ERROR_SHARING_VIOLATION).
            let busy = io::Error::from_raw_os_error(32);
            assert_eq!(
                FsError::io2(&busy, "rename", "C:\\a.mc-save-1", "C:\\a").message,
                "EBUSY: resource busy or locked, rename 'C:\\a.mc-save-1' -> 'C:\\a'"
            );
        }
        #[cfg(windows)]
        {
            assert_eq!(uv_code(&io::Error::from_raw_os_error(32)), "EBUSY");
            assert_eq!(uv_code(&io::Error::from_raw_os_error(5)), "EPERM");
            assert_eq!(uv_code(&io::Error::from_raw_os_error(3)), "ENOENT");
            assert_eq!(uv_code(&io::Error::from_raw_os_error(267)), "ENOTDIR");
        }
    }
}
