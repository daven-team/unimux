//! Token renewal of saved Claude profiles (port of src/main/accounts/refresh.ts; A2 the outcome type and the per-profile
//! lock, A3 the renewal itself in [`renew`]): `withProfileLock` keeps renewals and swap writes of one profile directory from
//! interleaving.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Why a renewal did not happen right now (no token inside): `read`, `network`, `bad-response`, `write`, `http-<status>` or
/// `blocked`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientDetail {
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

/// `RefreshOutcome`. `Unusable`: the server rotated the token but it could not be stored, so the saved login is lost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshOutcome {
    Ok,
    Dead,
    Transient(Option<TransientDetail>),
    Unusable,
}

impl RefreshOutcome {
    /// What the gates answer for a profile they may not renew (`{ kind: 'transient', detail: { reason: 'blocked' } }`).
    pub fn blocked() -> Self {
        RefreshOutcome::Transient(Some(TransientDetail { reason: "blocked".into(), retry_after_ms: None }))
    }
}

type Gate = Arc<tokio::sync::Mutex<()>>;

/// `withProfileLock`: one FIFO lock per profile directory (`path.resolve(dir)`), for blocking threads and async tasks
/// alike. Jobs on one directory run one after the other in the order they asked; other directories are not held up.
#[derive(Default)]
pub struct ProfileLocks {
    gates: Mutex<HashMap<PathBuf, Gate>>,
}

impl std::fmt::Debug for ProfileLocks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileLocks").field("held", &self.gates.lock().len()).finish()
    }
}

/// A held profile lock; the next job on that directory starts when it is dropped.
pub struct ProfileGuard<'a> {
    locks: &'a ProfileLocks,
    key: PathBuf,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl Drop for ProfileGuard<'_> {
    fn drop(&mut self) {
        let mut gates = self.locks.gates.lock();
        drop(self.guard.take());
        // Nobody else holds or waits for this directory: forget it.
        if gates.get(&self.key).is_some_and(|g| Arc::strong_count(g) == 1) {
            gates.remove(&self.key);
        }
    }
}

/// `path.resolve(dir)`: absolute, `.` and `..` resolved lexically (symlinks are not followed).
pub(crate) fn key_of(dir: &Path) -> PathBuf {
    use std::path::Component;
    let abs = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

impl ProfileLocks {
    pub fn new() -> Self {
        Self::default()
    }

    fn gate(&self, key: &Path) -> Gate {
        self.gates.lock().entry(key.to_path_buf()).or_default().clone()
    }

    /// Waits for every earlier job on `dir` (blocking; not from inside an async task).
    pub fn lock(&self, dir: &Path) -> ProfileGuard<'_> {
        let key = key_of(dir);
        let guard = self.gate(&key).blocking_lock_owned();
        ProfileGuard { locks: self, key, guard: Some(guard) }
    }

    /// [`lock`](Self::lock) for async tasks.
    pub async fn lock_async(&self, dir: &Path) -> ProfileGuard<'_> {
        let key = key_of(dir);
        let guard = self.gate(&key).lock_owned().await;
        ProfileGuard { locks: self, key, guard: Some(guard) }
    }

    /// Runs `f` holding the locks of every distinct directory in `dirs`, in order (`withProfileLocks`). Only one activation
    /// runs at a time, so the order cannot deadlock.
    pub fn with_all<T>(&self, dirs: &[PathBuf], f: impl FnOnce() -> T) -> T {
        let mut seen: Vec<PathBuf> = Vec::new();
        let mut held = Vec::new();
        for dir in dirs {
            let key = key_of(dir);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            held.push(self.lock(dir));
        }
        let out = f();
        while let Some(g) = held.pop() {
            drop(g);
        }
        out
    }

    /// Directories with a holder or a waiter (tests).
    pub fn active(&self) -> usize {
        self.gates.lock().len()
    }
}

pub mod limits;
pub mod renew;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[test]
    fn jobs_on_one_directory_run_in_turn_and_other_directories_are_free() {
        let locks = Arc::new(ProfileLocks::new());
        let dir = std::env::temp_dir().join("a2-profile-lock-test");
        let held = locks.lock(&dir);
        // Another directory is not held up.
        drop(locks.lock(&dir.with_file_name("other")));
        let released = Arc::new(AtomicBool::new(false));
        let (l, d, r) = (locks.clone(), dir.clone(), released.clone());
        let waiter = std::thread::spawn(move || {
            // `..` resolves to the same directory, so this waits for the holder.
            let _g = l.lock(&d.join("..").join("a2-profile-lock-test"));
            r.load(Ordering::SeqCst)
        });
        std::thread::sleep(Duration::from_millis(100));
        released.store(true, Ordering::SeqCst);
        drop(held);
        assert!(waiter.join().unwrap(), "the waiter ran while the directory was held");
        assert_eq!(locks.active(), 0);
    }
}
