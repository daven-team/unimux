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

/// Identical work that is still running is shared: the second caller with the same key gets the first one's answer. The entry
/// goes when the work ends (only the entry that work put there: a newer one under the same key stays).
#[derive(Default, Clone)]
pub struct Inflight {
    entries: Entries,
    ids: Arc<AtomicU64>,
}

impl Inflight {
    /// `shared(key, work)` of git.ts. `work` is only polled when no identical work runs.
    pub fn shared<T, F>(&self, key: &str, work: F) -> impl Future<Output = T> + Send + 'static
    where
        T: Clone + Send + Sync + 'static,
        F: Future<Output = T> + Send + 'static,
    {
        let mut entries = self.entries.lock();
        if let Some((_, running)) = entries.get(key)
            && let Some(running) = running.downcast_ref::<Shared<BoxFuture<'static, T>>>()
        {
            return running.clone();
        }
        let id = self.ids.fetch_add(1, Ordering::Relaxed);
        let map = self.entries.clone();
        let owned_key = key.to_string();
        let future: BoxFuture<'static, T> = async move {
            let out = work.await;
            let mut entries = map.lock();
            if entries.get(&owned_key).is_some_and(|(owner, _)| *owner == id) {
                entries.remove(&owned_key);
            }
            out
        }
        .boxed();
        let shared = future.shared();
        entries.insert(key.to_string(), (id, Box::new(shared.clone())));
        shared
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
        assert_eq!((a, b, c), (42, 42, 42));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(inflight.running(), 0);
        // a later call runs again
        assert_eq!(inflight.shared("status|1|dir", make(runs.clone())).await, 42);
        assert_eq!(runs.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn generation_counts_up() {
        let g = Generation::default();
        assert_eq!(g.get(), 0);
        assert_eq!(g.bump(), 1);
        assert_eq!(g.get(), 1);
    }
}
