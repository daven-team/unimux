//! The file layer of "make main" and its recovery (port of the shared part of src/main/accounts/swap.ts): the `SwapFs`
//! seam, snapshots of Claude Code's JSON files, the guarded atomic write and where the main login lives.
//!
//! Every file is replaced atomically: `<path>.<uuid>.tmp` next to it, then a rename. A rename that hits a Windows file lock
//! (EPERM, EBUSY, EACCES) is retried 5 times with a 50..100 ms wait, and an optional guard runs before EVERY rename attempt
//! (false: the file changed since it was read, [`WriteError::Changed`]). Unlike 1.1.4's `fs.promises.writeFile` the temp
//! file is flushed to disk before the rename, so a power loss never leaves an empty credentials file.
//!
//! Everything here blocks: call it from a blocking thread.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{Map, Value};
use unimux_core::js_json;

use crate::js;

/// `{ mtimeMs, size }` of a file (`sig` compares both).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStat {
    /// Modification time in nanoseconds since the epoch (only compared for equality).
    pub mtime_ns: i128,
    pub size: u64,
}

/// The file operations of a swap (`SwapFs`); tests wrap [`RealSwapFs`] to inject failures and foreign writes.
pub trait SwapFs: Send + Sync {
    /// File text (invalid UTF-8 as U+FFFD), or `None` when the file does not exist; other read errors are returned.
    fn read_file(&self, path: &Path) -> io::Result<Option<String>>;
    fn stat(&self, path: &Path) -> io::Result<Option<FileStat>>;
    /// Creates or truncates `path` (`mode` on POSIX).
    fn write_file(&self, path: &Path, data: &str, mode: u32) -> io::Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// Removes a file; a missing one is fine (`rm(path, { force: true })`).
    fn rm(&self, path: &Path) -> io::Result<()>;
    /// `mkdir(path, { recursive: true, mode: 0o700 })`.
    fn mkdir(&self, path: &Path) -> io::Result<()>;
    /// File names in a directory (empty when it does not exist).
    fn readdir(&self, path: &Path) -> io::Result<Vec<String>>;
    /// Removes an EMPTY directory; errors are for the caller to ignore.
    fn rmdir(&self, path: &Path) -> io::Result<()>;
}

/// ENOENT / ENOTDIR: the file is absent (anything else is never mistaken for an absent file).
pub fn is_missing(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
}

fn missing_or<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(v) => Ok(Some(v)),
        Err(e) if is_missing(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

/// The real file system (`nodeSwapFs`).
#[derive(Debug, Default, Clone, Copy)]
pub struct RealSwapFs;

impl SwapFs for RealSwapFs {
    fn read_file(&self, path: &Path) -> io::Result<Option<String>> {
        missing_or(js::read_text(path))
    }

    fn stat(&self, path: &Path) -> io::Result<Option<FileStat>> {
        Ok(missing_or(fs::metadata(path))?.map(|m| FileStat {
            mtime_ns: m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i128),
            size: m.len(),
        }))
    }

    fn write_file(&self, path: &Path, data: &str, mode: u32) -> io::Result<()> {
        let mut open = fs::OpenOptions::new();
        open.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(mode);
        }
        #[cfg(not(unix))]
        let _ = mode;
        let mut f = open.open(path)?;
        f.write_all(data.as_bytes())?;
        f.sync_all()
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    fn rm(&self, path: &Path) -> io::Result<()> {
        match fs::remove_file(path) {
            Err(e) if is_missing(&e) => Ok(()),
            other => other,
        }
    }

    fn mkdir(&self, path: &Path) -> io::Result<()> {
        let mut b = fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(path)
    }

    fn readdir(&self, path: &Path) -> io::Result<Vec<String>> {
        let Some(entries) = missing_or(fs::read_dir(path))? else { return Ok(Vec::new()) };
        let mut names = Vec::new();
        for entry in entries {
            names.push(entry?.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        Ok(names)
    }

    fn rmdir(&self, path: &Path) -> io::Result<()> {
        fs::remove_dir(path)
    }
}

/// A JSON object file as read: its text, the parsed object and the stat signature it was read at.
#[derive(Debug, Clone, PartialEq)]
pub struct Snap {
    pub text: String,
    pub data: Map<String, Value>,
    pub sig: (i128, u64),
}

/// `readSnap`: `None` when the file is absent or is not a JSON object; a read error is returned.
pub fn read_snap(fs: &dyn SwapFs, path: &Path) -> io::Result<Option<Snap>> {
    let before = fs.stat(path)?;
    let text = fs.read_file(path)?;
    let (Some(text), Some(before)) = (text, before) else { return Ok(None) };
    Ok(match js_json::parse(&text) {
        Ok(Value::Object(data)) => Some(Snap { text, data, sig: (before.mtime_ns, before.size) }),
        _ => None,
    })
}

/// True while the file is still exactly what `snap` read (checked again before every rename attempt).
pub fn unchanged(fs: &dyn SwapFs, path: &Path, snap: &Snap) -> io::Result<bool> {
    Ok(read_snap(fs, path)?.is_some_and(|now| now.sig == snap.sig && now.text == snap.text))
}

/// Why a guarded write did not happen.
#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    /// The guard said the file changed between the read and the rename.
    #[error("changed")]
    Changed,
    #[error(transparent)]
    Io(#[from] io::Error),
}

const MAX_RETRIES: u32 = 5;

/// A guard of [`atomic_write`]: `Ok(false)` when the file changed meanwhile.
pub type Guard<'a> = &'a dyn Fn() -> io::Result<bool>;

/// EPERM / EBUSY / EACCES (`RETRY_CODES`).
fn retryable(error: &WriteError) -> bool {
    matches!(error, WriteError::Io(e) if unimux_core::atomic_write::is_transient(e))
}

fn retry<T>(delay: &dyn Fn(Duration), mut f: impl FnMut() -> Result<T, WriteError>) -> Result<T, WriteError> {
    let mut i = 0u32;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => {
                if i >= MAX_RETRIES || !retryable(&e) {
                    return Err(e);
                }
                delay(Duration::from_millis(u64::from(50 + ((i * 17) % 51))));
                i += 1;
            }
        }
    }
}

/// Temp file next to the target + rename. `guard` runs before EVERY rename attempt.
pub fn atomic_write(
    delay: &dyn Fn(Duration),
    fs: &dyn SwapFs,
    path: &Path,
    data: &str,
    guard: Option<Guard<'_>>,
) -> Result<(), WriteError> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let temp = PathBuf::from(temp);
    let result = retry(delay, || Ok(fs.write_file(&temp, data, 0o600)?)).and_then(|()| {
        retry(delay, || {
            if let Some(g) = guard
                && !g()?
            {
                return Err(WriteError::Changed);
            }
            Ok(fs.rename(&temp, path)?)
        })
    });
    if result.is_err() {
        let _ = fs.rm(&temp);
    }
    result
}

/// Where the main login lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapPaths {
    pub credentials: PathBuf,
    pub claude_json: PathBuf,
}

/// A variable of the process environment; on Windows names are case-insensitive (as `process.env` there).
pub fn env_get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    if let Some(v) = env.get(key) {
        return Some(v);
    }
    if cfg!(windows) {
        return env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str());
    }
    None
}

/// `swapPaths`: `None` when CLAUDE_CONFIG_DIR is set but not absolute (never resolved against the cwd).
pub fn swap_paths(home: &Path, env: &BTreeMap<String, String>) -> Option<SwapPaths> {
    let custom = env_get(env, "CLAUDE_CONFIG_DIR").map(js::trim).filter(|c| !c.is_empty());
    if let Some(c) = custom
        && !is_absolute(c)
    {
        return None;
    }
    Some(match custom {
        Some(c) => {
            let dir = PathBuf::from(c);
            SwapPaths { credentials: dir.join(".credentials.json"), claude_json: dir.join(".claude.json") }
        }
        None => SwapPaths { credentials: home.join(".claude").join(".credentials.json"), claude_json: home.join(".claude.json") },
    })
}

/// Node's `path.isAbsolute`: on Windows a leading slash or backslash counts too (a rooted path), as does `C:\`.
fn is_absolute(p: &str) -> bool {
    if cfg!(windows) {
        let b = p.as_bytes();
        matches!(b.first(), Some(b'/' | b'\\'))
            || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\'))
    } else {
        p.starts_with('/')
    }
}

/// `str`: a non-empty string.
pub fn str_of(v: Option<&Value>) -> Option<&str> {
    js::string(v).filter(|s| !s.is_empty())
}

/// `claudeAiOauth` of credentials, when it is an object.
pub fn oauth_of(data: &Map<String, Value>) -> Option<&Map<String, Value>> {
    js::record(data.get("claudeAiOauth"))
}

/// `validOauth`: an access and a refresh token.
pub fn valid_oauth(o: Option<&Map<String, Value>>) -> bool {
    o.is_some_and(|o| str_of(o.get("accessToken")).is_some() && str_of(o.get("refreshToken")).is_some())
}

/// `JSON.stringify({ ...base, [key]: value })`-style object: an existing key keeps its place, a new one goes last.
pub fn with_key(base: &Map<String, Value>, key: &str, value: Value) -> Value {
    let mut m = base.clone();
    m.insert(key.into(), value);
    let mut v = Value::Object(m);
    js_json::order_like_js(&mut v);
    v
}

/// `JSON.stringify(value)`.
pub fn stringify(v: &Value) -> String {
    js_json::stringify(v)
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify2(v: &Value) -> String {
    js_json::stringify_pretty(v, 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_paths_follow_claude_config_dir() {
        let home = Path::new(if cfg!(windows) { r"C:\h" } else { "/h" });
        let none = BTreeMap::new();
        let p = swap_paths(home, &none).unwrap();
        assert_eq!(p.credentials, home.join(".claude").join(".credentials.json"));
        assert_eq!(p.claude_json, home.join(".claude.json"));
        let rel = BTreeMap::from([("CLAUDE_CONFIG_DIR".to_string(), "relative/dir".to_string())]);
        assert_eq!(swap_paths(home, &rel), None);
        let blank = BTreeMap::from([("CLAUDE_CONFIG_DIR".to_string(), "  ".to_string())]);
        assert_eq!(swap_paths(home, &blank).unwrap(), p);
        let abs = if cfg!(windows) { r"D:\c" } else { "/c" };
        let custom = BTreeMap::from([("CLAUDE_CONFIG_DIR".to_string(), format!(" {abs} "))]);
        let p = swap_paths(home, &custom).unwrap();
        assert_eq!(p.claude_json, Path::new(abs).join(".claude.json"));
    }

    #[test]
    fn with_key_keeps_the_place_of_an_existing_key() {
        let base = js_json::parse(r#"{"a":1,"claudeAiOauth":{"x":1},"b":2}"#).unwrap();
        let v = with_key(base.as_object().unwrap(), "claudeAiOauth", serde_json::json!({"y": 2}));
        assert_eq!(stringify(&v), r#"{"a":1,"claudeAiOauth":{"y":2},"b":2}"#);
        let v = with_key(base.as_object().unwrap(), "oauthAccount", serde_json::json!(1));
        assert_eq!(stringify(&v), r#"{"a":1,"claudeAiOauth":{"x":1},"b":2,"oauthAccount":1}"#);
    }

    #[test]
    fn atomic_write_retries_busy_renames_and_leaves_no_temp_file() {
        struct Flaky(std::sync::atomic::AtomicU32);
        impl SwapFs for Flaky {
            fn read_file(&self, p: &Path) -> io::Result<Option<String>> {
                RealSwapFs.read_file(p)
            }
            fn stat(&self, p: &Path) -> io::Result<Option<FileStat>> {
                RealSwapFs.stat(p)
            }
            fn write_file(&self, p: &Path, d: &str, m: u32) -> io::Result<()> {
                RealSwapFs.write_file(p, d, m)
            }
            fn rename(&self, f: &Path, t: &Path) -> io::Result<()> {
                if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 3 {
                    return Err(io::Error::from(io::ErrorKind::PermissionDenied));
                }
                RealSwapFs.rename(f, t)
            }
            fn rm(&self, p: &Path) -> io::Result<()> {
                RealSwapFs.rm(p)
            }
            fn mkdir(&self, p: &Path) -> io::Result<()> {
                RealSwapFs.mkdir(p)
            }
            fn readdir(&self, p: &Path) -> io::Result<Vec<String>> {
                RealSwapFs.readdir(p)
            }
            fn rmdir(&self, p: &Path) -> io::Result<()> {
                RealSwapFs.rmdir(p)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.json");
        let waits = std::sync::Mutex::new(Vec::new());
        let delay = |d: Duration| waits.lock().unwrap().push(d.as_millis());
        atomic_write(&delay, &Flaky(0.into()), &file, "{}", None).unwrap();
        assert_eq!(*waits.lock().unwrap(), vec![50, 67, 84]);
        assert_eq!(RealSwapFs.readdir(dir.path()).unwrap(), vec!["f.json"]);
        // A guard that says "changed" is not retried and leaves no temp file.
        let guard = || Ok(false);
        assert!(matches!(atomic_write(&delay, &RealSwapFs, &file, "x", Some(&guard)), Err(WriteError::Changed)));
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
        assert_eq!(RealSwapFs.readdir(dir.path()).unwrap(), vec!["f.json"]);
    }
}
