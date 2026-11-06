//! Port of src/main/startupTiming.ts: milliseconds since the process started for each startup step, one line per launch in
//! startup.log (the last 20 launches).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use parking_lot::Mutex;

/// Marks the renderer may report (anything else from the renderer is ignored).
pub const RENDERER_MARKS: [&str; 2] = ["renderer-boot", "first-output"];
/// Launches kept in startup.log.
pub const STARTUP_LOG_LINES: usize = 20;

pub fn is_renderer_mark(name: &str) -> bool {
    RENDERER_MARKS.contains(&name)
}

/// Records named marks once each (the first one wins).
#[derive(Debug)]
pub struct StartupTimer {
    origin: Instant,
    marks: Mutex<Vec<(String, f64)>>,
}

impl StartupTimer {
    pub fn new(origin: Instant) -> Self {
        Self { origin, marks: Mutex::new(Vec::new()) }
    }
    pub fn mark(&self, name: &str) {
        let ms = self.origin.elapsed().as_secs_f64() * 1000.0;
        self.mark_at(name, ms);
    }
    pub fn mark_at(&self, name: &str, ms: f64) {
        let mut marks = self.marks.lock();
        if !marks.iter().any(|(n, _)| n == name) {
            marks.push((name.to_string(), ms));
        }
    }
    pub fn has(&self, name: &str) -> bool {
        self.marks.lock().iter().any(|(n, _)| n == name)
    }
    /// `name=ms` pairs in the order they happened.
    pub fn line(&self) -> String {
        self.marks.lock().iter().map(|(n, ms)| format!("{n}={}", ms.round() as i64)).collect::<Vec<_>>().join(" ")
    }
}

/// The log with this launch's line last, older launches trimmed to `keep` lines in total.
pub fn startup_log_text(previous: &[String], current: &str, keep: usize) -> String {
    let mut all: Vec<&str> = previous.iter().map(String::as_str).collect();
    all.push(current);
    let start = all.len().saturating_sub(keep);
    format!("{}\n", all[start..].join("\n"))
}

/// Writes this launch's line to startup.log, replacing the line an earlier flush of the same launch wrote. Never fails.
#[derive(Debug)]
pub struct StartupLog {
    file: PathBuf,
    header: String,
    previous: Mutex<Option<Vec<String>>>,
}

impl StartupLog {
    pub fn new(file: impl Into<PathBuf>, header: impl Into<String>) -> Self {
        Self { file: file.into(), header: header.into(), previous: Mutex::new(None) }
    }
    pub fn path(&self) -> &Path {
        &self.file
    }
    pub fn flush(&self, timer: &StartupTimer) {
        let mut previous = self.previous.lock();
        let lines = previous.get_or_insert_with(|| {
            fs::read_to_string(&self.file)
                .map(|t| t.split('\n').map(|l| l.trim_end_matches('\r').to_string()).filter(|l| !l.trim().is_empty()).collect())
                .unwrap_or_default()
        });
        let text = startup_log_text(lines, &format!("{} {}", self.header, timer.line()), STARTUP_LOG_LINES);
        let _ = fs::write(&self.file, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_mark_wins_and_line_format() {
        let t = StartupTimer::new(Instant::now());
        t.mark_at("modules-loaded", 12.4);
        t.mark_at("window-created", 80.6);
        t.mark_at("modules-loaded", 99.0);
        assert_eq!(t.line(), "modules-loaded=12 window-created=81");
        assert!(t.has("window-created"));
    }

    #[test]
    fn renderer_marks_are_fixed() {
        assert!(is_renderer_mark("renderer-boot"));
        assert!(is_renderer_mark("first-output"));
        assert!(!is_renderer_mark("window-created"));
        assert!(!is_renderer_mark(""));
    }

    #[test]
    fn keeps_twenty_lines_and_replaces_own_line() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("startup.log");
        let old: Vec<String> = (0..25).map(|i| format!("old {i}")).collect();
        fs::write(&file, old.join("\n")).unwrap();
        let t = StartupTimer::new(Instant::now());
        let log = StartupLog::new(&file, "2026-11-06T00:00:00.000Z 1.2.0 win32");
        t.mark_at("a", 1.0);
        log.flush(&t);
        t.mark_at("b", 2.0);
        log.flush(&t);
        let text = fs::read_to_string(&file).unwrap();
        let lines: Vec<&str> = text.trim_end().split('\n').collect();
        assert_eq!(lines.len(), 20);
        assert_eq!(lines[19], "2026-11-06T00:00:00.000Z 1.2.0 win32 a=1 b=2");
        assert_eq!(lines[0], "old 6");
    }
}
