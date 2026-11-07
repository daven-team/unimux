//! The caches of the Git module (src/main/git.ts): per-folder maps that keep at most [`CACHE_LIMIT`] entries (the oldest
//! insert goes first, `remember`), the generation counter every write and trust change bumps (part of the key of shared reads,
//! and the guard that keeps an answer older than a write out of a cache), and the in-flight dedupe of identical reads (a window
//! focus asks the Files tree and the Git panel at once: they share one run).

use std::any::Any;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::hash::Hash;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;

/// Per-folder caches of a long session (many projects and worktrees) keep at most this many entries, the oldest go first.
pub const CACHE_LIMIT: usize = 100;

/// A map with the insertion order of a JS `Map` and the `remember` rule of git.ts: setting a key moves it to the newest place,
/// and the oldest entries go while there are more than the limit.
#[derive(Debug)]
pub struct Lru<K, V> {
    limit: usize,
    seq: u64,
    map: HashMap<K, (u64, V)>,
    order: BTreeMap<u64, K>,
}

impl<K: Eq + Hash + Clone, V> Default for Lru<K, V> {
    fn default() -> Self {
        Self::new(CACHE_LIMIT)
    }
}

impl<K: Eq + Hash + Clone, V> Lru<K, V> {
    pub fn new(limit: usize) -> Self {
        Self { limit, seq: 0, map: HashMap::new(), order: BTreeMap::new() }
    }

    /// `remember(map, key, value)`.
    pub fn remember(&mut self, key: K, value: V) {
        self.remove(&key);
        self.seq += 1;
        self.order.insert(self.seq, key.clone());
        self.map.insert(key, (self.seq, value));
        while self.map.len() > self.limit {
            let Some((_, oldest)) = self.order.pop_first() else { break };
            self.map.remove(&oldest);
        }
    }

    /// A read: it does not change the order (a JS Map `get`).
    pub fn get(&self, key: &K) -> Option<&V> {
        self.map.get(key).map(|(_, v)| v)
    }

    pub fn remove(&mut self, key: &K) -> Option<V> {
        let (seq, value) = self.map.remove(key)?;
        self.order.remove(&seq);
        Some(value)
    }

    /// Keeps the entries `keep` says yes to (the push targets of one root are dropped this way).
    pub fn retain(&mut self, mut keep: impl FnMut(&K, &V) -> bool) {
        let gone: Vec<K> = self.map.iter().filter(|(k, (_, v))| !keep(k, v)).map(|(k, _)| k.clone()).collect();
        for key in gone {
            self.remove(&key);
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// The keys from the oldest to the newest.
    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.order.values()
    }
}

/// Bumped by every write and trust change.
#[derive(Debug, Default)]
pub struct Generation(AtomicU64);

impl Generation {
    pub fn get(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn bump(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
}

type Entries = Arc<Mutex<HashMap<String, (u64, Box<dyn Any + Send + Sync>)>>>;

/// The shared work panicked (a rejected promise in git.ts): every caller of that run gets this, the next call runs afresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkPanicked(pub String);

impl std::fmt::Display for WorkPanicked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WorkPanicked {}

/// Removes the entry of one run when that run ends in any way (an answer, a panic, a cancelled task): only the entry that run
/// put there, a newer one under the same key stays. The `.finally` of git.ts.
struct Release {
    entries: Entries,
    key: String,
    id: u64,
}

impl Drop for Release {
    fn drop(&mut self) {
        let mut entries = self.entries.lock();
        if entries.get(&self.key).is_some_and(|(owner, _)| *owner == self.id) {
            entries.remove(&self.key);
        }
    }
}

fn panic_text(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "the shared work panicked".to_string())
}

type Run<T> = Shared<BoxFuture<'static, Result<T, WorkPanicked>>>;

/// Identical work that is still running is shared: the second caller with the same key gets the first one's answer. Like a
/// promise of git.ts, the work starts at once as its own tokio task and always settles, whether or not anyone still waits for
/// it; its entry goes when it ends, so a panic or callers that give up never leave a stale entry behind.
#[derive(Default, Clone)]
pub struct Inflight {
    entries: Entries,
    ids: Arc<AtomicU64>,
}

impl Inflight {
    /// `shared(key, work)` of git.ts. `work` is spawned when no identical work runs (and dropped unpolled otherwise); a panic
    /// of the work is [`WorkPanicked`] for every caller of that run. Must be called inside a tokio runtime.
    pub fn shared<T, F>(&self, key: &str, work: F) -> impl Future<Output = Result<T, WorkPanicked>> + Send + 'static
    where
        T: Clone + Send + Sync + 'static,
        F: Future<Output = T> + Send + 'static,
    {
        let mut entries = self.entries.lock();
        if let Some((_, running)) = entries.get(key)
            && let Some(running) = running.downcast_ref::<Run<T>>()
        {
            return running.clone();
        }
        let id = self.ids.fetch_add(1, Ordering::Relaxed);
        let release = Release { entries: self.entries.clone(), key: key.to_string(), id };
        // The entry is inserted below while the lock is held, so the task's release (it takes the lock) always comes after.
        let task = tokio::spawn(async move {
            let _release = release;
            work.await
        });
        let run: Run<T> = async move {
            task.await.map_err(|e| {
                if e.is_panic() {
                    WorkPanicked(panic_text(&*e.into_panic()))
                } else {
                    WorkPanicked("the shared work was cancelled".into())
                }
            })
        }
        .boxed()
        .shared();
        entries.insert(key.to_string(), (id, Box::new(run.clone())));
        run
    }

    /// How many keys are running (tests).
    pub fn running(&self) -> usize {
        self.entries.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[test]
    fn remember_keeps_the_newest_hundred_and_moves_a_set_key_to_the_end() {
        let mut lru: Lru<String, u32> = Lru::default();
        for i in 0..100 {
            lru.remember(format!("k{i}"), i);
        }
        // setting k0 again makes it the newest, so k1 is the oldest now
        lru.remember("k0".into(), 1000);
        lru.remember("k100".into(), 100);
        assert_eq!(lru.len(), 100);
        assert!(lru.get(&"k1".to_string()).is_none());
        assert_eq!(lru.get(&"k0".to_string()), Some(&1000));
        assert_eq!(lru.keys().next().map(String::as_str), Some("k2"));
        lru.retain(|k, _| !k.starts_with("k9"));
        assert_eq!(lru.len(), 100 - 11);
    }

    #[tokio::test]
    async fn identical_work_runs_once_while_it_is_running() {
        let inflight = Inflight::default();
        let runs = Arc::new(AtomicUsize::new(0));
        let make = |runs: Arc<AtomicUsize>| async move {
            runs.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
            42u32
        };
        let a = inflight.shared("status|1|dir", make(runs.clone()));
        let b = inflight.shared("status|1|dir", make(runs.clone()));
        let c = inflight.shared("status|2|dir", make(runs.clone()));
        assert_eq!(inflight.running(), 2);
        let (a, b, c) = tokio::join!(a, b, c);
        assert_eq!((a.unwrap(), b.unwrap(), c.unwrap()), (42, 42, 42));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(inflight.running(), 0);
        // a later call runs again
        assert_eq!(inflight.shared("status|1|dir", make(runs.clone())).await, Ok(42));
        assert_eq!(runs.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_panicking_run_settles_for_its_callers_and_the_next_call_runs_afresh() {
        let inflight = Inflight::default();
        let boom = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            if inflight_never() {
                return 1u32;
            }
            panic!("boom")
        };
        let a = inflight.shared("k", boom);
        let b = inflight.shared("k", async { 2u32 });
        let (a, b) = tokio::join!(a, b);
        assert_eq!(a, Err(WorkPanicked("boom".into())));
        assert_eq!(b, Err(WorkPanicked("boom".into())));
        assert_eq!(inflight.running(), 0);
        assert_eq!(inflight.shared("k", async { 3u32 }).await, Ok(3));
        assert_eq!(inflight.running(), 0);
    }

    fn inflight_never() -> bool {
        false
    }

    #[tokio::test]
    async fn a_run_nobody_waits_for_still_ends_and_leaves_no_entry() {
        let inflight = Inflight::default();
        let slow = |v: &'static str| async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            v
        };
        // the caller gives up (a timeout wrapper), and one never polls at all
        assert!(tokio::time::timeout(Duration::from_millis(5), inflight.shared("s", slow("old"))).await.is_err());
        drop(inflight.shared("t", slow("never polled")));
        assert_eq!(inflight.running(), 2);
        for _ in 0..100 {
            if inflight.running() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(inflight.running(), 0);
        assert_eq!(inflight.shared("s", async { "new" }).await, Ok("new"));
        assert_eq!(inflight.shared("t", async { "new" }).await, Ok("new"));
    }

    #[test]
    fn generation_counts_up() {
        let g = Generation::default();
        assert_eq!(g.get(), 0);
        assert_eq!(g.bump(), 1);
        assert_eq!(g.get(), 1);
    }
}
