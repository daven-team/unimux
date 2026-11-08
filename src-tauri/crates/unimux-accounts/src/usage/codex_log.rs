//! The newest `rate_limits` event of the Codex session logs (port of src/main/usage/codexLog.ts): the network-free answer of
//! the live Codex card. Only file tails are read. Blocking (run it on a blocking thread).

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::parse::{parse_codex_plan, parse_codex_rate_limits, parse_iso_date};
use super::types::UsageWindow;

const TAIL_BYTES: u64 = 256 * 1024;
const NEWEST_FILES: usize = 8;

/// What a session log tells.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexLog {
    pub windows: Vec<UsageWindow>,
    pub plan: Option<String>,
    /// Epoch ms of the event (its timestamp, else now).
    pub at: f64,
}

fn read_tail(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let size = file.metadata()?.len();
    let length = size.min(TAIL_BYTES);
    file.seek(SeekFrom::Start(size - length))?;
    let mut buffer = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut buffer)?;
    let text = String::from_utf8_lossy(&buffer).into_owned();
    // A tail read may start in the middle of a line.
    Ok(if size > length {
        match text.find('\n') {
            Some(i) => text[i + 1..].to_string(),
            None => text,
        }
    } else {
        text
    })
}

/// `readdir(dir, { recursive: true })`: every entry below `dir` as a path relative to it (symbolic links not followed).
fn walk(dir: &Path, prefix: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let rel = prefix.join(entry.file_name());
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(rel.clone());
        if is_dir {
            let _ = walk(&entry.path(), &rel, out);
        }
    }
    Ok(())
}

/// `readCodexLog(codexHome)`.
pub fn read_codex_log(codex_home: &Path, now_ms: f64) -> Option<CodexLog> {
    let sessions = codex_home.join("sessions");
    let mut names = Vec::new();
    walk(&sessions, Path::new(""), &mut names).ok()?;
    // Paths start with YYYY/MM/DD and file names with a timestamp, so reverse order is newest first.
    let mut files: Vec<String> =
        names.iter().map(|n| n.to_string_lossy().into_owned()).filter(|n| n.ends_with(".jsonl")).collect();
    files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    files.reverse();
    for name in files.into_iter().take(NEWEST_FILES) {
        let Ok(text) = read_tail(&sessions.join(&name)) else { continue };
        for line in text.split('\n').rev() {
            if !line.contains("\"rate_limits\"") {
                continue;
            }
            let Ok(event) = unimux_core::js_json::parse(line) else { continue };
            let body = match event.get("payload") {
                Some(Value::Null) | None => &event,
                Some(p) => p,
            };
            let at = match event.get("timestamp") {
                Some(Value::String(s)) => parse_iso_date(s),
                _ => f64::NAN,
            };
            let at = if at.is_finite() { at } else { now_ms };
            if let Some(windows) = parse_codex_rate_limits(body, at) {
                let plan = body.get("rate_limits").and_then(parse_codex_plan);
                return Some(CodexLog { windows, plan, at });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::types::WindowId;

    #[test]
    fn newest_event_with_windows_wins() {
        let home = tempfile::tempdir().unwrap();
        let day = home.path().join("sessions").join("2026").join("11").join("06");
        fs::create_dir_all(&day).unwrap();
        let old = r#"{"timestamp":"2026-11-06T10:00:00Z","payload":{"rate_limits":{"primary":{"used_percent":5}}}}"#;
        fs::write(day.join("rollout-2026-11-06T09-00-00.jsonl"), format!("{old}\n")).unwrap();
        let newer = [
            r#"{"timestamp":"2026-11-06T11:00:00Z","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":42,"window_minutes":300},"plan_type":"pro"}}}"#,
            r#"{"timestamp":"2026-11-06T11:05:00Z","payload":{"rate_limits":null}}"#,
            "not json \"rate_limits\"",
        ]
        .join("\n");
        fs::write(day.join("rollout-2026-11-06T10-00-00.jsonl"), newer).unwrap();
        let log = read_codex_log(home.path(), 0.0).unwrap();
        assert_eq!(log.windows.len(), 1);
        assert_eq!((log.windows[0].id, log.windows[0].used_percent), (WindowId::FiveHour, 42.0));
        assert_eq!(log.plan.as_deref(), Some("pro"));
        assert_eq!(log.at, parse_iso_date("2026-11-06T11:00:00Z"));
        assert!(read_codex_log(&home.path().join("none"), 0.0).is_none());
    }

    fn event(primary: u32, ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","rate_limits":{{"primary":{{"used_percent":{primary},"window_minutes":300,"resets_at":1781010642}},"secondary":{{"used_percent":3,"window_minutes":10080,"resets_at":1781558816}},"plan_type":"plus"}}}}}}"#
        )
    }

    fn put(home: &Path, rel: &str, body: &str) {
        let path = home.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    /// usage-fetchers "returns the newest event that has limits and ignores empty ones", "reads only the tail of a huge log",
    /// "does not find an event that sits only in the unread head of a huge log", "is null without sessions or without any
    /// limits"
    #[test]
    fn ts_newest_event_tail_only_and_nothing_without_limits() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        assert!(read_codex_log(h, 0.0).is_none());
        put(h, "sessions/2026/10/10/rollout-x.jsonl", "not json\n{\"payload\":{}}\n");
        assert!(read_codex_log(h, 0.0).is_none());

        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        put(h, "sessions/2026/10/08/rollout-2026-10-08T10-00-00-a.jsonl", &format!("{}\n", event(11, "2026-10-08T10:00:00Z")));
        let empty = r#"{"timestamp":"2026-10-09T11:00:00Z","payload":{"type":"token_count","rate_limits":{"primary":null,"secondary":null}}}"#;
        put(
            h,
            "sessions/2026/10/09/rollout-2026-10-09T10-00-00-b.jsonl",
            &format!("{}\n{empty}\n", event(22, "2026-10-09T10:00:00Z")),
        );
        let log = read_codex_log(h, 0.0).unwrap();
        assert_eq!(log.windows.iter().map(|w| w.used_percent).collect::<Vec<_>>(), [22.0, 3.0]);
        assert_eq!((log.plan.as_deref(), log.at), (Some("plus"), parse_iso_date("2026-10-09T10:00:00Z")));

        let filler = format!("{}\n", "x".repeat(2000)).repeat(2500);
        let home = tempfile::tempdir().unwrap();
        put(
            home.path(),
            "sessions/2026/10/10/rollout-2026-10-10T10-00-00-c.jsonl",
            &format!("{filler}{}\n", event(77, "2026-10-10T10:00:00Z")),
        );
        assert_eq!(read_codex_log(home.path(), 0.0).unwrap().windows[0].used_percent, 77.0);
        let home = tempfile::tempdir().unwrap();
        put(
            home.path(),
            "sessions/2026/10/10/rollout-2026-10-10T10-00-00-d.jsonl",
            &format!("{}\n{filler}", event(66, "2026-10-10T10:00:00Z")),
        );
        assert!(read_codex_log(home.path(), 0.0).is_none());
    }
}
