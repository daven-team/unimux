//! The command history of SSH hosts for the terminal autocomplete (S1, 1.1.4 src/main/ssh/commandHistory.ts):
//! `<data>/ssh/command_history.json`, 0600 on POSIX. Local only: never synced, exported or sent anywhere but the app's own
//! window. Loaded on first use; changes are written in batches 1.5 s after the first one (and at quit, [`flush`]),
//! atomically. A file from a newer version, or one that is not a history file, is never written over.
//!
//! [`flush`]: CommandHistoryStore::flush

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use unimux_core::js_json;
use unimux_core::json_file::{JsonRead, ensure_private_dir, read_json_file, write_private_file};

use crate::history_rules::{self, HistoryEntry, Hosts, PER_HOST, history_command, normalize_command_history, record_command};
use crate::js_value::is_uuid;
use crate::vault::{Clock, system_clock};

/// How long changes wait before they are written (1.1.4 `writeDelayMs` default).
pub const WRITE_DELAY: Duration = Duration::from_millis(1500);

/// The host is still saved (a deleted host's history is dropped at the next write).
pub type HostExists = Arc<dyn Fn(&str) -> bool + Send + Sync>;

pub struct CommandHistoryOptions {
    pub host_exists: HostExists,
    pub now: Clock,
    pub write_delay: Duration,
}

impl CommandHistoryOptions {
    pub fn new(host_exists: HostExists) -> Self {
        Self { host_exists, now: system_clock(), write_delay: WRITE_DELAY }
    }
}

#[derive(Default)]
struct Inner {
    hosts: Option<Hosts>,
    locked: bool,
    /// The generation of the armed batch timer (a flush disarms it).
    timer: Option<u64>,
    timers: u64,
    dirty: bool,
}

pub struct CommandHistoryStore {
    file: PathBuf,
    opts: CommandHistoryOptions,
    inner: Mutex<Inner>,
    me: Weak<CommandHistoryStore>,
}

impl std::fmt::Debug for CommandHistoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandHistoryStore").field("file", &self.file).finish()
    }
}

impl CommandHistoryStore {
    pub fn new(file: impl Into<PathBuf>, opts: CommandHistoryOptions) -> Arc<Self> {
        let file = file.into();
        Arc::new_cyclic(|me| Self { file, opts, inner: Mutex::new(Inner::default()), me: me.clone() })
    }

    pub fn file_path(&self) -> &Path {
        &self.file
    }

    fn load<'a>(&self, inner: &'a mut Inner) -> &'a mut Hosts {
        if inner.hosts.is_none() {
            let hosts = match read_json_file(&self.file) {
                JsonRead::Value(v) => {
                    let parsed = normalize_command_history(&v);
                    inner.locked = parsed.newer || parsed.invalid;
                    parsed.hosts
                }
                // Missing, or unparsable and moved to a .bak-<time>: start empty. Still there means unreadable: keep it.
                JsonRead::Missing | JsonRead::Failed => {
                    inner.locked = self.file.exists();
                    Hosts::new()
                }
            };
            inner.hosts = Some(hosts);
        }
        inner.hosts.as_mut().expect("loaded")
    }

    fn known<'a>(&self, host_id: &'a Value) -> Option<&'a str> {
        host_id.as_str().filter(|id| is_uuid(id) && (self.opts.host_exists)(id))
    }

    pub fn read_only(&self) -> bool {
        let mut inner = self.inner.lock();
        self.load(&mut inner);
        inner.locked
    }

    /// `list(hostId)`: the host's entries, most recent first (empty for an unknown host or a bad id).
    pub fn list(&self, host_id: &Value) -> Vec<HistoryEntry> {
        let Some(id) = self.known(host_id) else { return Vec::new() };
        let mut inner = self.inner.lock();
        self.load(&mut inner).get(id).cloned().unwrap_or_default()
    }

    /// `record(hostId, command)`: false when refused (unknown host, a line that is not kept, a read-only file).
    pub fn record(&self, host_id: &Value, command: &Value) -> bool {
        let Some(id) = self.known(host_id) else { return false };
        let Some(command) = command.as_str() else { return false };
        if history_command(command) != Some(command) {
            return false;
        }
        let mut inner = self.inner.lock();
        self.load(&mut inner);
        if inner.locked {
            return false;
        }
        let now = (self.opts.now)() as f64;
        let hosts = inner.hosts.as_mut().expect("loaded");
        let before: &[HistoryEntry] = hosts.get(id).map(Vec::as_slice).unwrap_or(&[]);
        let Some(next) = record_command(before, command, now, PER_HOST) else { return true };
        // Most recently used host last in the map, so the oldest host is the first one dropped over the limit.
        hosts.shift_remove(id);
        hosts.insert(id.to_string(), next);
        while hosts.len() > history_rules::HOSTS_MAX {
            hosts.shift_remove_index(0);
        }
        self.changed(&mut inner);
        true
    }

    /// `clear(hostId)`: one host's history, or every host's (null); written at once.
    pub fn clear(&self, host_id: &Value) -> bool {
        let id = match host_id {
            Value::Null => None,
            Value::String(s) if is_uuid(s) => Some(s.as_str()),
            _ => return false,
        };
        let mut inner = self.inner.lock();
        self.load(&mut inner);
        if inner.locked {
            return false;
        }
        let hosts = inner.hosts.as_mut().expect("loaded");
        match id {
            None => hosts.clear(),
            Some(id) => {
                hosts.shift_remove(id);
            }
        }
        self.changed(&mut inner);
        self.flush_locked(&mut inner);
        true
    }

    /// Entries kept per existing host id, in the map's order.
    pub fn counts(&self) -> Map<String, Value> {
        let mut inner = self.inner.lock();
        let hosts = self.load(&mut inner);
        hosts.iter().filter(|(id, _)| (self.opts.host_exists)(id)).map(|(id, e)| (id.clone(), json!(e.len()))).collect()
    }

    /// `status()` for Settings > SSH: `{counts, readOnly, file}`.
    pub fn status(&self) -> Value {
        let counts = self.counts();
        json!({ "counts": counts, "readOnly": self.read_only(), "file": self.file.to_string_lossy() })
    }

    fn changed(&self, inner: &mut Inner) {
        inner.dirty = true;
        if inner.timer.is_some() {
            return;
        }
        inner.timers += 1;
        let generation = inner.timers;
        inner.timer = Some(generation);
        let me = self.me.clone();
        let delay = self.opts.write_delay;
        // Like an unref'd setTimeout: the thread never keeps anything alive (it holds a weak reference).
        let spawned = std::thread::Builder::new().name("ssh-history-write".into()).spawn(move || {
            std::thread::sleep(delay);
            if let Some(store) = me.upgrade() {
                let mut inner = store.inner.lock();
                if inner.timer == Some(generation) {
                    inner.timer = None;
                    store.flush_locked(&mut inner);
                }
            }
        });
        if spawned.is_err() {
            // No timer: the changes are written with the next flush (at quit at the latest).
            inner.timer = None;
        }
    }

    /// Writes pending changes now (app quit). A failed write is tried again with the next change.
    pub fn flush(&self) {
        let mut inner = self.inner.lock();
        self.flush_locked(&mut inner);
    }

    fn flush_locked(&self, inner: &mut Inner) {
        inner.timer = None;
        if !inner.dirty || inner.locked {
            return;
        }
        let Some(hosts) = inner.hosts.as_mut() else { return };
        hosts.retain(|id, _| (self.opts.host_exists)(id));
        let mut body = Map::new();
        for (id, entries) in hosts.iter() {
            body.insert(id.clone(), Value::Array(entries.iter().map(HistoryEntry::to_json).collect()));
        }
        let text = js_json::stringify(&json!({ "version": history_rules::VERSION, "hosts": Value::Object(body) }));
        let written = self.file.parent().map_or(Ok(()), ensure_private_dir).and_then(|()| write_private_file(&self.file, &text));
        if written.is_ok() {
            inner.dirty = false;
        }
    }

    /// The answer of `ssh:history:list` (`CommandHistoryEntry[]`).
    pub fn list_json(&self, host_id: &Value) -> Value {
        Value::Array(self.list(host_id).iter().map(HistoryEntry::to_json).collect())
    }
}
