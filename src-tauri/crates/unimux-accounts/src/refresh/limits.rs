//! The 429 windows of the token endpoint by refresh-token fingerprint (port of src/main/accounts/refreshLimits.ts):
//! in memory, mirrored to `<data>/refresh-limits.json` (fingerprints and times only, never a token), so a restart keeps the
//! window and every path (poll, manual refresh, swap) respects one window.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value};
use unimux_core::atomic_write::{AtomicWriteOptions, atomic_write};
use unimux_core::js_json;

use crate::js;

/// An entry is forgotten this long after its window ended (its failure count only matters while the limiter is engaged).
pub const KEEP_AFTER_MS: f64 = 2.0 * 60.0 * 60_000.0;

/// While `until` has not passed, this refresh token is not sent to the token endpoint again; `failures` drives the
/// exponential wait.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RefreshLimit {
    pub until: f64,
    pub failures: u32,
}

pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// `createRefreshLimits(file, now)`. Entries keep the insertion order of a JS `Map` (written in that order).
pub struct RefreshLimits {
    file: Option<PathBuf>,
    now: Clock,
    entries: Mutex<Vec<(String, RefreshLimit)>>,
}

impl std::fmt::Debug for RefreshLimits {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshLimits").field("file", &self.file).field("entries", &self.entries.lock().len()).finish()
    }
}

fn is_key(key: &str) -> bool {
    key.len() == 16 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn parse_entry(value: &Value) -> Option<RefreshLimit> {
    let entry = value.as_object()?;
    let until = js::finite(entry.get("until"))?;
    let failures = entry.get("failures")?.as_f64()?;
    // Number.isInteger(failures) && failures > 0
    (failures.is_finite() && failures.fract() == 0.0 && failures > 0.0)
        .then(|| RefreshLimit { until, failures: failures.min(f64::from(u32::MAX)) as u32 })
}

/// Reads the file (anything unusable is ignored: no usable file yet).
fn load(file: &Path) -> Vec<(String, RefreshLimit)> {
    let Ok(text) = js::read_text(file) else { return Vec::new() };
    let Ok(Value::Object(raw)) = js_json::parse(&text) else { return Vec::new() };
    raw.iter().filter(|(k, _)| is_key(k)).filter_map(|(k, v)| parse_entry(v).map(|e| (k.clone(), e))).collect()
}

impl RefreshLimits {
    /// Without a file nothing is persisted (tests, or a run without a data dir).
    pub fn new(file: Option<PathBuf>, now: Clock) -> Self {
        let entries = file.as_deref().map(load).unwrap_or_default();
        Self { file, now, entries: Mutex::new(entries) }
    }

    pub fn get(&self, key: &str) -> Option<RefreshLimit> {
        self.entries.lock().iter().find(|(k, _)| k == key).map(|(_, e)| *e)
    }

    pub fn set(&self, key: &str, limit: RefreshLimit) {
        let mut entries = self.entries.lock();
        match entries.iter_mut().find(|(k, _)| k == key) {
            Some((_, e)) => *e = limit,
            None => entries.push((key.to_string(), limit)),
        }
        self.save(&mut entries);
    }

    pub fn delete(&self, key: &str) {
        let mut entries = self.entries.lock();
        let before = entries.len();
        entries.retain(|(k, _)| k != key);
        if entries.len() != before {
            self.save(&mut entries);
        }
    }

    /// Drops entries whose window ended more than [`KEEP_AFTER_MS`] ago, then writes the rest (a failed write is ignored:
    /// the in-memory copy still protects this run).
    fn save(&self, entries: &mut Vec<(String, RefreshLimit)>) {
        let Some(file) = &self.file else { return };
        let now = (self.now)();
        entries.retain(|(_, e)| e.until + KEEP_AFTER_MS >= now);
        let mut out = Map::new();
        for (k, e) in entries.iter() {
            let mut entry = Map::new();
            entry.insert("until".into(), js::num(e.until));
            entry.insert("failures".into(), js::num(f64::from(e.failures)));
            out.insert(k.clone(), Value::Object(entry));
        }
        let text = js_json::stringify(&Value::Object(out));
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = atomic_write(file, text.as_bytes(), &AtomicWriteOptions::default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_792_152_000_000.0;

    fn clock(at: Arc<Mutex<f64>>) -> Clock {
        Arc::new(move || *at.lock())
    }

    /// accounts-refresh "keeps the window across a restart through the limits file (fingerprints and times only)".
    #[test]
    fn keeps_the_window_across_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("refresh-limits.json");
        let now = Arc::new(Mutex::new(NOW));
        let limits = RefreshLimits::new(Some(file.clone()), clock(now.clone()));
        limits.set("0123456789abcdef", RefreshLimit { until: NOW + 300_000.0, failures: 1 });
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"0123456789abcdef":{"until":1792152300000,"failures":1}}"#);
        let again = RefreshLimits::new(Some(file.clone()), clock(now));
        assert_eq!(again.get("0123456789abcdef"), Some(RefreshLimit { until: NOW + 300_000.0, failures: 1 }));
        again.delete("0123456789abcdef");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{}");
    }

    /// accounts-refresh "ignores a damaged limits file and drops old entries on the next write".
    #[test]
    fn ignores_a_damaged_file_and_drops_old_entries_on_the_next_write() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("refresh-limits.json");
        std::fs::write(&file, "{not json").unwrap();
        let now = Arc::new(Mutex::new(NOW));
        assert_eq!(RefreshLimits::new(Some(file.clone()), clock(now.clone())).get("0123456789abcdef"), None);
        std::fs::write(
            &file,
            r#"{"0123456789abcdef":{"until":1,"failures":2},"bad":{"until":1,"failures":1},"aaaaaaaaaaaaaaaa":{"until":"x","failures":1},"bbbbbbbbbbbbbbbb":{"until":5,"failures":1.5},"cccccccccccccccc":{"until":5,"failures":0}}"#,
        )
        .unwrap();
        let limits = RefreshLimits::new(Some(file.clone()), clock(now));
        assert_eq!(limits.get("0123456789abcdef"), Some(RefreshLimit { until: 1.0, failures: 2 }));
        for k in ["bad", "aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"] {
            assert_eq!(limits.get(k), None, "{k}");
        }
        limits.set("dddddddddddddddd", RefreshLimit { until: NOW + 1.0, failures: 1 });
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"dddddddddddddddd":{"until":1792152000001,"failures":1}}"#);
    }
}
