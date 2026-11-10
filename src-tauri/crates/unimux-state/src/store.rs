//! Port of src/main/store.ts: loading state.json with repairs and backups, and the debounced saver.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::Value;

use unimux_core::atomic_write::{AtomicWriteOptions, atomic_write, is_transient};
use unimux_core::js_json::{parse, stringify};
use unimux_core::json_file::backup_path;

use crate::normalize::{Normalizer, Platform};

pub const FILE: &str = "state.json";
/// The .bak copy is refreshed by a save at most this often.
pub const BAK_REFRESH: Duration = Duration::from_secs(60 * 60);
/// How long a locked state.json is read again at startup before the start gives up.
pub const LOCKED_READ_WAIT: Duration = Duration::from_millis(4000);

/// state.json exists but cannot be read (held by another program, no permission): the app must not start and save over it.
#[derive(Debug, thiserror::Error)]
#[error("{} cannot be read: {cause}", path.display())]
pub struct StateUnreadable {
    pub path: PathBuf,
    pub cause: io::Error,
}

enum ReadResult {
    Ok(Value),
    Missing,
    Unreadable(io::Error),
    Corrupt,
}

/// Test seams of the read.
pub struct ReadSeams<'a> {
    pub read: &'a dyn Fn(&Path) -> io::Result<Vec<u8>>,
    pub sleep: &'a dyn Fn(Duration),
    pub wait: Duration,
}

fn read_state(path: &Path, platform: Platform, normalizer: &dyn Normalizer, seams: &ReadSeams<'_>) -> ReadResult {
    if !path.exists() {
        return ReadResult::Missing;
    }
    let mut waited = Duration::ZERO;
    let mut attempt = 0u32;
    let bytes = loop {
        match (seams.read)(path) {
            Ok(b) => break b,
            Err(e) => {
                if !is_transient(&e) || waited >= seams.wait {
                    return ReadResult::Unreadable(e);
                }
                let ms = Duration::from_millis((25u64 << attempt.min(10)).min(500));
                (seams.sleep)(ms);
                waited += ms;
                attempt += 1;
            }
        }
    };
    // A BOM-less UTF-8 JSON text (what JSON.stringify + writeFile produce); a BOM is tolerated like JSON.parse of readFileSync.
    let text = match std::str::from_utf8(&bytes) {
        Ok(t) => t.trim_start_matches('\u{feff}'),
        Err(_) => return ReadResult::Corrupt,
    };
    // js_json::parse: what JSON.parse accepts (an escaped lone surrogate written by 1.1.x must not make the file "corrupt").
    match parse(text) {
        // A panic of the normalizer counts like a throw of normalizeState in 1.1.4: the file is corrupt, the .bak or the
        // default state is used, and the app starts instead of failing on every launch.
        Ok(raw) => match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| normalizer.normalize(raw, platform))) {
            Ok(Some(state)) => ReadResult::Ok(state),
            Ok(None) | Err(_) => ReadResult::Corrupt,
        },
        Err(_) => ReadResult::Corrupt,
    }
}

/// `state.json.<pid>.<id>.tmp`, `state.json.bak.<pid>.<id>.tmp` and the old `state.json.tmp`: the pid, when there is one.
pub fn leftover_temp(name: &str) -> Option<Option<&str>> {
    let rest = name.strip_prefix("state.json")?;
    let rest = rest.strip_prefix(".bak").unwrap_or(rest);
    let rest = rest.strip_suffix(".tmp")?;
    if rest.is_empty() {
        return Some(None);
    }
    let rest = rest.strip_prefix('.')?;
    let (pid, id) = rest.split_once('.')?;
    let valid = !pid.is_empty()
        && pid.chars().all(|c| c.is_ascii_digit())
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase());
    valid.then_some(Some(pid))
}

fn sweep_leftover_temps(dir: &Path, log: &dyn Fn(&str)) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let own = std::process::id().to_string();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        match leftover_temp(&name) {
            Some(Some(pid)) if pid == own => continue,
            Some(_) => {
                if let Err(e) = fs::remove_file(entry.path()) {
                    log(&format!("leftover {name} not removed: {e}"));
                }
            }
            None => {}
        }
    }
}

/// Options of [`load_state`].
pub struct LoadOptions<'a> {
    pub log: &'a dyn Fn(&str),
    pub seams: Option<ReadSeams<'a>>,
}

impl Default for LoadOptions<'_> {
    fn default() -> Self {
        Self { log: &|_| {}, seams: None }
    }
}

/// Reads state.json (repairing what it can), falling back to .bak and then to the defaults. An unparsable file is kept as a
/// backup first. A file that exists but stays unreadable is an error: the caller must not start (and save over it).
pub fn load_state(
    dir: &Path,
    platform: Platform,
    normalizer: &dyn Normalizer,
    options: &LoadOptions<'_>,
) -> Result<Value, StateUnreadable> {
    let _ = fs::create_dir_all(dir);
    sweep_leftover_temps(dir, options.log);
    let main = dir.join(FILE);
    let bak = dir.join(format!("{FILE}.bak"));
    let default_read = |p: &Path| fs::read(p);
    let default_sleep = |d: Duration| thread::sleep(d);
    let fallback_seams = ReadSeams { read: &default_read, sleep: &default_sleep, wait: LOCKED_READ_WAIT };
    let seams = options.seams.as_ref().unwrap_or(&fallback_seams);
    match read_state(&main, platform, normalizer, seams) {
        ReadResult::Unreadable(cause) => {
            let _ = fs::copy(&main, backup_path(&main));
            (options.log)(&format!("state.json could not be read, not starting: {cause}"));
            Err(StateUnreadable { path: main, cause })
        }
        ReadResult::Ok(state) => {
            // The .bak copy is a convenience: a file held by antivirus must never stop the app from starting.
            match fs::read(&main).and_then(|bytes| atomic_write(&bak, &bytes, &AtomicWriteOptions::default())) {
                Ok(()) => {}
                Err(e) => (options.log)(&format!("state.json.bak not refreshed: {e}")),
            }
            Ok(state)
        }
        other => {
            if matches!(other, ReadResult::Corrupt) {
                let kept = backup_path(&main);
                match fs::rename(&main, &kept) {
                    Ok(()) => (options.log)(&format!("state.json could not be read and was kept as {}", kept.display())),
                    Err(e) => (options.log)(&format!("state.json could not be read nor kept: {e}")),
                }
            }
            let no_wait = ReadSeams { read: seams.read, sleep: seams.sleep, wait: Duration::ZERO };
            match read_state(&bak, platform, normalizer, &no_wait) {
                ReadResult::Ok(state) => Ok(state),
                _ => Ok(normalizer.default_state(platform)),
            }
        }
    }
}

/// The text written to state.json: compact `JSON.stringify(state)`.
pub fn serialize_state(state: &Value) -> String {
    stringify(state)
}

pub fn write_state_now(dir: &Path, state: &Value) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    atomic_write(&dir.join(FILE), serialize_state(state).as_bytes(), &AtomicWriteOptions::default())
}

/// Waits before the next try after a failed save: 1 s, 2 s, 4 s ... up to 30 s.
pub fn retry_delay(failures: u32) -> Duration {
    let ms = 1000u64.saturating_mul(1u64 << failures.saturating_sub(1).min(20));
    Duration::from_millis(ms.min(30_000))
}

type WriteFn = Arc<dyn Fn(&Path, &Value) -> io::Result<()> + Send + Sync>;

struct SaverState {
    pending: Option<Arc<Value>>,
    deadline: Option<Instant>,
    failures: u32,
    /// A successful save refreshes .bak from this time on (an hour after the last refresh, or after the start).
    bak_due: Instant,
    stopped: bool,
}

/// The debounced saver (createSaver): the newest pending state wins, a failed save stays pending and is retried with a
/// growing delay, .bak is refreshed at most hourly. A background thread does the timed writes; `flush` writes at once.
pub struct Saver {
    dir: PathBuf,
    debounce: Duration,
    write: WriteFn,
    write_bak: WriteFn,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    timer: Arc<Timer>,
    /// Serializes writes (the timer thread and an explicit flush never write at the same time).
    writing: Mutex<()>,
}

/// The saver's state and the condvar of its timer thread. The thread holds this (not the saver) while it waits, so it can
/// wait without a timeout and a dropped saver still wakes it up (see `Drop for Saver`).
struct Timer {
    state: Mutex<SaverState>,
    wake: Condvar,
}

impl Saver {
    pub fn new(dir: PathBuf, log: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<Self> {
        let write: WriteFn = Arc::new(|d: &Path, s: &Value| write_state_now(d, s));
        let write_bak: WriteFn = Arc::new(|d: &Path, s: &Value| {
            atomic_write(&d.join(format!("{FILE}.bak")), serialize_state(s).as_bytes(), &AtomicWriteOptions::default())
        });
        Self::with(dir, Duration::from_millis(500), write, write_bak, log)
    }

    pub fn with(
        dir: PathBuf,
        debounce: Duration,
        write: WriteFn,
        write_bak: WriteFn,
        log: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Arc<Self> {
        let saver = Arc::new(Self {
            dir,
            debounce,
            write,
            write_bak,
            log,
            timer: Arc::new(Timer {
                state: Mutex::new(SaverState {
                    pending: None,
                    deadline: None,
                    failures: 0,
                    bak_due: Instant::now() + BAK_REFRESH,
                    stopped: false,
                }),
                wake: Condvar::new(),
            }),
            writing: Mutex::new(()),
        });
        let weak = Arc::downgrade(&saver);
        let timer = saver.timer.clone();
        thread::Builder::new()
            .name("state-saver".into())
            .spawn(move || {
                loop {
                    let due = {
                        let mut st = timer.state.lock();
                        if st.stopped {
                            return;
                        }
                        match st.deadline {
                            // Nothing pending: sleeps until a save, a failed flush, stop or the saver's drop notifies.
                            None => {
                                timer.wake.wait(&mut st);
                                false
                            }
                            Some(d) if d > Instant::now() => {
                                let left = d - Instant::now();
                                timer.wake.wait_for(&mut st, left);
                                false
                            }
                            Some(_) => true,
                        }
                    };
                    if due {
                        let Some(saver) = weak.upgrade() else { return };
                        saver.flush();
                    }
                }
            })
            .expect("state saver thread");
        saver
    }

    /// A new state to save (debounced). While a failed save waits for its retry, that timer stays.
    pub fn save(&self, state: Arc<Value>) {
        let mut st = self.timer.state.lock();
        st.pending = Some(state);
        if st.deadline.is_none() {
            st.deadline = Some(Instant::now() + self.debounce);
            self.timer.wake.notify_all();
        }
    }

    /// Writes the pending state now; true when nothing is left unsaved. Never panics: a failed save stays pending.
    pub fn flush(&self) -> bool {
        let _w = self.writing.lock();
        let s = {
            let mut st = self.timer.state.lock();
            st.deadline = None;
            match st.pending.take() {
                Some(s) => s,
                None => return true,
            }
        };
        match (self.write)(&self.dir, &s) {
            Ok(()) => {
                let mut st = self.timer.state.lock();
                if st.failures > 0 {
                    (self.log)(&format!("state saved again after {} failed attempt(s)", st.failures));
                }
                st.failures = 0;
                if Instant::now() >= st.bak_due {
                    st.bak_due = Instant::now() + BAK_REFRESH;
                    drop(st);
                    let _ = (self.write_bak)(&self.dir, &s);
                }
                true
            }
            Err(e) => {
                let mut st = self.timer.state.lock();
                // A newer state saved meanwhile wins; otherwise this one is tried again.
                if st.pending.is_none() {
                    st.pending = Some(s);
                }
                st.failures += 1;
                if st.failures == 1 {
                    (self.log)(&format!("state save failed, retrying: {e}"));
                }
                st.deadline = Some(Instant::now() + retry_delay(st.failures));
                self.timer.wake.notify_all();
                false
            }
        }
    }

    /// True while a state change is not on disk yet.
    pub fn has_pending(&self) -> bool {
        self.timer.state.lock().pending.is_some()
    }

    /// The last save at quit / session end: a failed save is tried again every `interval` while `timeout` lasts.
    pub fn flush_until_saved(&self, timeout: Duration, interval: Duration) -> bool {
        let start = Instant::now();
        self.flush();
        while self.has_pending() && start.elapsed() < timeout {
            thread::sleep(interval);
            self.flush();
        }
        !self.has_pending()
    }

    /// Tests: an hour has passed since the last .bak refresh.
    #[cfg(test)]
    fn bak_due_now(&self) {
        self.timer.state.lock().bak_due = Instant::now();
    }

    /// Stops the timer thread (after the final flush).
    pub fn stop(&self) {
        self.timer.state.lock().stopped = true;
        self.timer.wake.notify_all();
    }
}

impl Drop for Saver {
    /// A saver dropped without `stop` ends its timer thread too (it no longer wakes up on its own to notice).
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    //! Cases of test/store.test.ts, test/state-store.test.ts and test/state-sync-faults.test.ts (PORTING rows).
    use super::*;
    use crate::normalize::PassThrough;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn load(dir: &Path) -> Value {
        load_state(dir, Platform::Win32, &PassThrough, &LoadOptions::default()).unwrap()
    }

    #[test]
    fn leftover_temp_names() {
        assert_eq!(leftover_temp("state.json.tmp"), Some(None));
        assert_eq!(leftover_temp("state.json.123.mhndk03f0.tmp"), Some(Some("123")));
        assert_eq!(leftover_temp("state.json.bak.123.abc.tmp"), Some(Some("123")));
        assert_eq!(leftover_temp("state.json.bak.tmp"), Some(None));
        assert_eq!(leftover_temp("state.json"), None);
        assert_eq!(leftover_temp("state.json.12a.x.tmp"), None);
        assert_eq!(leftover_temp("state.json.1.X.tmp"), None);
        assert_eq!(leftover_temp("other.json.tmp"), None);
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(dir.path());
        assert_eq!(s["version"], 1);
        assert!(!dir.path().join(FILE).exists());
    }

    #[test]
    fn a_good_file_loads_unchanged_and_refreshes_the_bak() {
        let dir = tempfile::tempdir().unwrap();
        let text = r#"{"version":1,"projects":[],"zzz":{"b":1,"a":2.5},"settings":{"fontSize":13}}"#;
        fs::write(dir.path().join(FILE), text).unwrap();
        let s = load(dir.path());
        assert_eq!(serialize_state(&s), text);
        assert_eq!(fs::read_to_string(dir.path().join("state.json.bak")).unwrap(), text);
    }

    #[test]
    fn a_bak_that_cannot_be_refreshed_does_not_stop_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let text = r#"{"version":1,"projects":[],"name":"main"}"#;
        fs::write(dir.path().join(FILE), text).unwrap();
        // A .bak that cannot be replaced (here: a directory with content in its place).
        fs::create_dir_all(dir.path().join("state.json.bak").join("x")).unwrap();
        let lines = Mutex::new(Vec::<String>::new());
        let log = |line: &str| lines.lock().push(line.to_string());
        let s = load_state(dir.path(), Platform::Win32, &PassThrough, &LoadOptions { log: &log, seams: None }).unwrap();
        assert_eq!(s["name"], "main");
        assert!(lines.lock().iter().any(|l| l.contains("not refreshed")), "{:?}", lines.lock());
        assert_eq!(fs::read_to_string(dir.path().join(FILE)).unwrap(), text);
    }

    #[test]
    fn a_corrupt_file_is_kept_and_the_bak_is_used() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), "{not json").unwrap();
        fs::write(dir.path().join("state.json.bak"), r#"{"version":1,"projects":[],"from":"bak"}"#).unwrap();
        let s = load(dir.path());
        assert_eq!(s["from"], "bak");
        assert!(!dir.path().join(FILE).exists());
        let kept: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("state.json.bak-"))
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read_to_string(dir.path().join(&kept[0])).unwrap(), "{not json");
    }

    #[test]
    fn a_panicking_normalizer_counts_as_corrupt_and_the_bak_is_used() {
        struct Panics;
        impl Normalizer for Panics {
            fn normalize(&self, raw: Value, platform: Platform) -> Option<Value> {
                if raw.get("from").is_some() {
                    return PassThrough.normalize(raw, platform);
                }
                panic!("normalizer bug");
            }
            fn default_state(&self, platform: Platform) -> Value {
                PassThrough.default_state(platform)
            }
            fn after_edit(&self, merged: Value, previous: &Value) -> Result<Value, String> {
                PassThrough.after_edit(merged, previous)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), r#"{"version":1,"projects":[]}"#).unwrap();
        fs::write(dir.path().join("state.json.bak"), r#"{"version":1,"projects":[],"from":"bak"}"#).unwrap();
        let s = load_state(dir.path(), Platform::Win32, &Panics, &LoadOptions::default()).unwrap();
        assert_eq!(s["from"], "bak");
    }

    #[test]
    fn a_lone_surrogate_written_by_1_1_x_loads_and_is_not_kept_as_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        // JSON.stringify({ ..., name: 'Proj \ud83d' }) of 1.1.x; JSON.parse reads it back.
        let text = r#"{"version":1,"projects":[{"id":"p1","name":"Proj \ud83d","dir":"C:/x","tabs":[]}],"\udc00":1}"#;
        fs::write(dir.path().join(FILE), text).unwrap();
        let s = load(dir.path());
        assert_eq!(s["projects"][0]["name"], "Proj \u{fffd}");
        assert_eq!(s["\u{fffd}"], 1);
        assert_eq!(fs::read_to_string(dir.path().join(FILE)).unwrap(), text);
        let names: Vec<String> =
            fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(!names.iter().any(|n| n.starts_with("state.json.bak-")), "{names:?}");
    }

    #[test]
    fn a_wrong_version_counts_as_corrupt_and_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), r#"{"version":2,"projects":[]}"#).unwrap();
        let s = load(dir.path());
        assert_eq!(s["version"], 1);
        assert!(s["profiles"].is_array());
    }

    #[test]
    fn an_unreadable_file_stops_the_start_and_nothing_is_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), r#"{"version":1,"projects":[]}"#).unwrap();
        let reads = AtomicU32::new(0);
        let read = |_: &Path| -> io::Result<Vec<u8>> {
            reads.fetch_add(1, Ordering::Relaxed);
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        };
        let slept = Mutex::new(Duration::ZERO);
        let sleep = |d: Duration| *slept.lock() += d;
        let opts = LoadOptions { log: &|_| {}, seams: Some(ReadSeams { read: &read, sleep: &sleep, wait: LOCKED_READ_WAIT }) };
        let err = load_state(dir.path(), Platform::Win32, &PassThrough, &opts).unwrap_err();
        assert!(err.path.ends_with(FILE));
        // Retried for about 4 s (25, 50 ... 500 ms steps) before giving up.
        assert!(*slept.lock() >= LOCKED_READ_WAIT, "{:?}", slept.lock());
        assert!(reads.load(Ordering::Relaxed) > 5);
        assert_eq!(fs::read_to_string(dir.path().join(FILE)).unwrap(), r#"{"version":1,"projects":[]}"#);
    }

    #[test]
    fn a_briefly_locked_file_is_read_again() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), r#"{"version":1,"projects":[],"x":1}"#).unwrap();
        let reads = AtomicU32::new(0);
        let read = |p: &Path| -> io::Result<Vec<u8>> {
            if reads.fetch_add(1, Ordering::Relaxed) < 2 {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                fs::read(p)
            }
        };
        let opts = LoadOptions { log: &|_| {}, seams: Some(ReadSeams { read: &read, sleep: &|_| {}, wait: LOCKED_READ_WAIT }) };
        assert_eq!(load_state(dir.path(), Platform::Win32, &PassThrough, &opts).unwrap()["x"], 1);
    }

    #[test]
    fn sweeps_temps_of_other_processes_only() {
        let dir = tempfile::tempdir().unwrap();
        let own = format!("state.json.{}.abc.tmp", std::process::id());
        for name in ["state.json.tmp", "state.json.99999999.abc.tmp", own.as_str(), "notes.json.1.a.tmp"] {
            fs::write(dir.path().join(name), "x").unwrap();
        }
        load(dir.path());
        assert!(!dir.path().join("state.json.tmp").exists());
        assert!(!dir.path().join("state.json.99999999.abc.tmp").exists());
        assert!(dir.path().join(&own).exists());
        assert!(dir.path().join("notes.json.1.a.tmp").exists());
    }

    #[test]
    fn retry_delays() {
        assert_eq!(retry_delay(1), Duration::from_secs(1));
        assert_eq!(retry_delay(2), Duration::from_secs(2));
        assert_eq!(retry_delay(5), Duration::from_secs(16));
        assert_eq!(retry_delay(6), Duration::from_secs(30));
        assert_eq!(retry_delay(60), Duration::from_secs(30));
    }

    fn saver_with(fail: Arc<AtomicU32>, written: Arc<Mutex<Vec<String>>>) -> Arc<Saver> {
        let w = written.clone();
        let write: WriteFn = Arc::new(move |_: &Path, s: &Value| {
            if fail.load(Ordering::SeqCst) > 0 {
                fail.fetch_sub(1, Ordering::SeqCst);
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
            w.lock().push(serialize_state(s));
            Ok(())
        });
        Saver::with(
            PathBuf::from("."),
            Duration::from_millis(30),
            write,
            Arc::new(|_: &Path, _: &Value| Ok(())),
            Arc::new(|_| {}),
        )
    }

    #[test]
    fn debounces_and_the_newest_state_wins() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let saver = saver_with(Arc::new(AtomicU32::new(0)), written.clone());
        for i in 0..5 {
            saver.save(Arc::new(serde_json::json!({ "i": i })));
        }
        thread::sleep(Duration::from_millis(400));
        assert_eq!(*written.lock(), vec![r#"{"i":4}"#.to_string()]);
        assert!(!saver.has_pending());
        saver.stop();
    }

    #[test]
    fn a_failed_save_stays_pending_and_flush_until_saved_retries() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let fail = Arc::new(AtomicU32::new(2));
        let saver = saver_with(fail, written.clone());
        saver.save(Arc::new(serde_json::json!({ "a": 1 })));
        assert!(saver.flush_until_saved(Duration::from_secs(3), Duration::from_millis(20)));
        assert_eq!(*written.lock(), vec![r#"{"a":1}"#.to_string()]);
        saver.stop();
    }

    #[test]
    fn a_newer_state_saved_while_a_failed_one_waits_wins_and_flush_reports_instead_of_panicking() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let fail = Arc::new(AtomicU32::new(u32::MAX));
        let saver = saver_with(fail.clone(), written.clone());
        saver.save(Arc::new(serde_json::json!({ "name": "old" })));
        assert!(!saver.flush());
        assert!(saver.has_pending());
        saver.save(Arc::new(serde_json::json!({ "name": "new" })));
        assert!(!saver.flush());
        fail.store(0, Ordering::SeqCst);
        assert!(saver.flush());
        assert_eq!(*written.lock(), vec![r#"{"name":"new"}"#.to_string()]);
        assert!(!saver.has_pending());
        saver.stop();
    }

    #[test]
    fn refreshes_the_bak_with_a_save_at_most_once_an_hour() {
        let baks = Arc::new(Mutex::new(Vec::new()));
        let b = baks.clone();
        let saver = Saver::with(
            PathBuf::from("."),
            Duration::from_secs(60),
            Arc::new(|_: &Path, _: &Value| Ok(())),
            Arc::new(move |_: &Path, s: &Value| {
                b.lock().push(s["name"].as_str().unwrap_or_default().to_string());
                Ok(())
            }),
            Arc::new(|_| {}),
        );
        saver.save(Arc::new(serde_json::json!({ "name": "first" })));
        assert!(saver.flush());
        assert!(baks.lock().is_empty());
        saver.bak_due_now();
        saver.save(Arc::new(serde_json::json!({ "name": "second" })));
        assert!(saver.flush());
        saver.save(Arc::new(serde_json::json!({ "name": "third" })));
        assert!(saver.flush());
        assert_eq!(*baks.lock(), vec!["second".to_string()]);
        saver.stop();
    }

    #[test]
    fn writes_state_json_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let saver = Saver::new(dir.path().to_path_buf(), Arc::new(|_| {}));
        saver.save(Arc::new(serde_json::json!({"version": 1, "projects": [], "n": 1.0})));
        assert!(saver.flush());
        assert_eq!(fs::read_to_string(dir.path().join(FILE)).unwrap(), r#"{"version":1,"projects":[],"n":1}"#);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        saver.stop();
    }
}
