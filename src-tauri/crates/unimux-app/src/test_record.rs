//! Check build only (feature `test-bridge`): what the real-app harness (scripts/real-app.mjs, PLAN X1) learns about a run
//! besides the page.
//!
//! - Not-yet calls: every window.mc command (and port) a page asked for that no package implements yet. Kept in memory for
//!   the `notYet` op and, when `MC_NOT_YET_LOG` names a file, appended there once per command as soon as it happens, so a
//!   script that fails after the app is gone (a crash, a quit, its scratch folder removed) can still say "blocked by
//!   <package>" instead of failing obscurely.
//! - Recorded calls: the calls of chosen channels with their arguments (`record` / `recorded` ops), optionally answered
//!   here without running the handler (`swallow`). This replaces the Electron mainInspector stubs of the verify scripts
//!   (`ipcMain.on('notify')`, `attention:flash`, `notify:show`, a recorded `update:install` that must not install).

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde_json::{Value, json};

use unimux_ipc::IpcError;

/// The env var of the not-yet log file (check builds only: this module is compiled out of release builds).
pub const NOT_YET_LOG_ENV: &str = "MC_NOT_YET_LOG";

#[derive(Default)]
struct Recording {
    /// Watched channel -> answered here (swallowed) or run as usual.
    channels: HashMap<String, bool>,
    calls: Vec<Value>,
}

pub struct TestRecorder {
    not_yet: Mutex<BTreeMap<String, u64>>,
    log: Option<PathBuf>,
    recording: Mutex<Recording>,
    started: std::time::Instant,
}

impl TestRecorder {
    pub fn from_env() -> Self {
        Self::new(std::env::var_os(NOT_YET_LOG_ENV).filter(|v| !v.is_empty()).map(PathBuf::from))
    }

    pub fn new(log: Option<PathBuf>) -> Self {
        Self {
            not_yet: Mutex::new(BTreeMap::new()),
            log,
            recording: Mutex::new(Recording::default()),
            started: std::time::Instant::now(),
        }
    }

    /// Notes a call's answer: a not-yet error is counted and, the first time per command, written to the log.
    pub fn observe<T>(&self, result: &Result<T, IpcError>) {
        if let Err(e) = result {
            self.not_yet_hit_of(e);
        }
    }

    pub fn not_yet_hit_of(&self, error: &IpcError) {
        if let IpcError::NotYet { command } = error {
            self.not_yet_hit(command);
        }
    }

    pub fn not_yet_hit(&self, command: &str) {
        let mut map = self.not_yet.lock();
        let n = map.entry(command.to_string()).or_insert(0);
        *n += 1;
        if *n == 1
            && let Some(path) = &self.log
        {
            // One line per command in a single write, under the lock (calls of several threads never interleave);
            // appended right away (the harness reads it even when the app died).
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = f.write_all(format!("{command}\n").as_bytes());
            }
        }
    }

    /// `{command: count}` of the not-yet calls so far.
    pub fn not_yet(&self) -> Value {
        json!(self.not_yet.lock().clone())
    }

    /// Adds channels to the recording (earlier ones stay); `swallow` answers these here (null) without their handler.
    pub fn start(&self, channels: Vec<String>, swallow: bool) {
        let mut r = self.recording.lock();
        for channel in channels {
            r.channels.insert(channel, swallow);
        }
    }

    /// The calls recorded so far, of one channel or of all; `take` removes what it returns.
    pub fn recorded(&self, channel: Option<&str>, take: bool) -> Value {
        let mut r = self.recording.lock();
        let wanted = |c: &Value| channel.is_none_or(|ch| c["channel"] == ch);
        let out: Vec<Value> = r.calls.iter().filter(|c| wanted(c)).cloned().collect();
        if take {
            r.calls.retain(|c| !wanted(c));
        }
        Value::Array(out)
    }

    /// Records a call of a watched channel; true when it must be answered here instead of running.
    pub fn capture(&self, kind: &str, command: &str, label: &str, args: &[Value]) -> bool {
        let mut r = self.recording.lock();
        let Some(&swallow) = r.channels.get(command) else { return false };
        let at = self.started.elapsed().as_secs_f64() * 1000.0;
        r.calls.push(json!({ "kind": kind, "channel": command, "label": label, "args": args, "at": at }));
        swallow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_yet_calls_are_counted_and_logged_once() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("not-yet.log");
        let r = TestRecorder::new(Some(log.clone()));
        r.observe::<()>(&Err(IpcError::NotYet { command: "fs:exists".into() }));
        r.observe::<()>(&Err(IpcError::NotYet { command: "fs:exists".into() }));
        r.observe::<()>(&Err(IpcError::NotYet { command: "cell:spawn".into() }));
        r.observe::<()>(&Err(IpcError::failed("x", "y")));
        r.observe::<()>(&Ok(()));
        assert_eq!(r.not_yet(), json!({ "cell:spawn": 1, "fs:exists": 2 }));
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "fs:exists\ncell:spawn\n");
    }

    #[test]
    fn no_log_file_without_the_env_var() {
        let r = TestRecorder::new(None);
        r.not_yet_hit("notify");
        assert_eq!(r.not_yet(), json!({ "notify": 1 }));
    }

    #[test]
    fn records_only_watched_channels_and_swallows_on_request() {
        let r = TestRecorder::new(None);
        assert!(!r.capture("send", "notify", "main", &[json!(1)]));
        r.start(vec!["notify".into()], false);
        assert!(!r.capture("send", "notify", "main", &[json!({"title": "t"})]));
        assert!(!r.capture("invoke", "fs:exists", "main", &[]));
        // A second recording adds its channels; the first one keeps recording.
        r.start(vec!["update:install".into()], true);
        assert!(r.capture("invoke", "update:install", "main", &[]));
        assert!(!r.capture("send", "notify", "detached-1", &[json!(2)]));
        assert_eq!(r.recorded(Some("update:install"), false).as_array().unwrap().len(), 1);
        let notes = r.recorded(Some("notify"), true);
        assert_eq!(notes.as_array().unwrap().len(), 2);
        assert_eq!(notes[0]["args"], json!([{"title": "t"}]));
        assert_eq!(notes[1]["label"], "detached-1");
        // Taking one channel leaves the others.
        assert_eq!(r.recorded(Some("notify"), true), json!([]));
        assert_eq!(r.recorded(None, true).as_array().unwrap().len(), 1);
        assert_eq!(r.recorded(None, true), json!([]));
    }
}
