//! crash.log: one writer per process (port of src/main/updaterLog.ts + stability.ts describeError). A line is
//! `<ISO> <level> <text>`; above 200 KB the file rolls over to crash.old.log. Logging never fails the caller.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use crate::time::iso_now;

/// Size above which the log rolls over (200 KB like the TS logger).
pub const MAX_BYTES: u64 = 200 * 1024;

/// A rolling log file (crash.log, later updater.log).
#[derive(Debug)]
pub struct RollingLog {
    file: PathBuf,
    rotate_to: Option<PathBuf>,
    lock: Mutex<()>,
}

impl RollingLog {
    pub fn new(file: impl Into<PathBuf>, rotate_to: Option<PathBuf>) -> Self {
        Self { file: file.into(), rotate_to, lock: Mutex::new(()) }
    }

    /// crash.log + crash.old.log in `data_dir`.
    pub fn crash_log(data_dir: &Path) -> Self {
        Self::new(data_dir.join("crash.log"), Some(data_dir.join("crash.old.log")))
    }

    pub fn path(&self) -> &Path {
        &self.file
    }

    pub fn info(&self, message: &str) {
        self.write("info", message);
    }
    pub fn warn(&self, message: &str) {
        self.write("warn", message);
    }
    pub fn error(&self, message: &str) {
        self.write("error", message);
    }

    pub fn write(&self, level: &str, message: &str) {
        let _guard = self.lock.lock();
        let _ = (|| -> std::io::Result<()> {
            if fs::metadata(&self.file).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
                match &self.rotate_to {
                    Some(to) => {
                        if fs::rename(&self.file, to).is_err() {
                            fs::write(&self.file, "")?;
                        }
                    }
                    None => fs::write(&self.file, "")?,
                }
            }
            if let Some(parent) = self.file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let mut f = OpenOptions::new().create(true).append(true).open(&self.file)?;
            f.write_all(format!("{} {} {}\n", iso_now(), level, message).as_bytes())
        })();
    }
}

/// Message (and detail) cut to `max` characters with an ellipsis, like describeError.
pub fn describe_error(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}\u{2026}")
    } else {
        text.to_string()
    }
}

/// `rendererReport`: one renderer error report as a log line, or None when it is not a report.
pub fn renderer_report(
    kind: &serde_json::Value,
    message: &serde_json::Value,
    stack: Option<&serde_json::Value>,
) -> Option<String> {
    let kind = kind.as_str()?;
    if kind.is_empty() || kind.len() > 24 || !kind.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        return None;
    }
    let message = message.as_str()?;
    let text = match stack.and_then(|s| s.as_str()) {
        Some(s) if !s.is_empty() => format!("{message}\n{s}"),
        _ => message.to_string(),
    };
    // JS slices UTF-16 units; for the log a char cut is close enough and never splits a character.
    let text: String = text.chars().take(4000).collect();
    Some(format!("renderer {kind}: {text}"))
}

/// Reports from the renderer: at most `max` per window (a render loop that throws must not fill the disk).
#[derive(Debug)]
pub struct ReportLimiter {
    max: u32,
    window_ms: i64,
    start: Option<i64>,
    count: u32,
}

impl ReportLimiter {
    pub fn new(max: u32, window_ms: i64) -> Self {
        Self { max, window_ms, start: None, count: 0 }
    }
    pub fn allow(&mut self, now: i64) -> bool {
        if self.start.is_none_or(|s| now - s >= self.window_ms) {
            self.start = Some(now);
            self.count = 0;
        }
        if self.count >= self.max {
            return false;
        }
        self.count += 1;
        true
    }
}

impl Default for ReportLimiter {
    fn default() -> Self {
        Self::new(20, 60_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lines_and_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let log = RollingLog::crash_log(dir.path());
        log.error("boom");
        let text = fs::read_to_string(dir.path().join("crash.log")).unwrap();
        assert!(text.ends_with(" error boom\n"), "{text}");
        assert_eq!(&text[4..5], "-");
        fs::write(dir.path().join("crash.log"), vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();
        log.warn("after");
        assert_eq!(fs::metadata(dir.path().join("crash.old.log")).unwrap().len(), MAX_BYTES + 1);
        assert!(fs::read_to_string(dir.path().join("crash.log")).unwrap().ends_with(" warn after\n"));
    }

    #[test]
    fn describe_cuts() {
        assert_eq!(describe_error("abc", 4000), "abc");
        assert_eq!(describe_error("abcdef", 3), "abc\u{2026}");
    }

    #[test]
    fn renderer_reports() {
        assert_eq!(renderer_report(&json!("boot"), &json!("x"), Some(&json!("at y"))).as_deref(), Some("renderer boot: x\nat y"));
        assert_eq!(renderer_report(&json!("Boot"), &json!("x"), None), None);
        assert_eq!(renderer_report(&json!("boot"), &json!(1), None), None);
        assert_eq!(renderer_report(&json!("a-very-long-kind-name-over-24"), &json!("x"), None), None);
    }

    #[test]
    fn limiter() {
        let mut l = ReportLimiter::new(2, 1000);
        assert!(l.allow(0));
        assert!(l.allow(10));
        assert!(!l.allow(20));
        assert!(l.allow(1000));
    }
}
