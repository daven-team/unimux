//! One-shot timers of the DB layer (the injected `setTimer` / `clearTimer` of DbService and the 1.5 s history write): the
//! session idle disconnect, the prompt timeout, the test-connection limit, the batched history write. A trait so the ported
//! tests drive time by hand like the TS tests do.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;

pub type TimerId = u64;
pub type TimerFn = Box<dyn FnOnce() + Send + 'static>;
/// A timer callback that gets its own id. `cancel` cannot stop a callback that already started (it waits for a lock the
/// canceller holds), so such a callback checks that its owner still holds this id before acting (clearTimeout in
/// single-threaded JS never had this race).
pub type TimerIdFn = Box<dyn FnOnce(TimerId) + Send + 'static>;

pub trait Timers: Send + Sync {
    /// Runs `f` once after `ms` unless cancelled first, with the id this call returns.
    fn after_with_id(&self, ms: u64, f: TimerIdFn) -> TimerId;
    fn cancel(&self, id: TimerId);

    /// Runs `f` once after `ms` unless cancelled first.
    fn after(&self, ms: u64, f: TimerFn) -> TimerId {
        self.after_with_id(ms, Box::new(move |_| f()))
    }
}

/// The real timers: one tokio task per timer (aborted when cancelled), on the runtime given at construction.
pub struct TokioTimers {
    runtime: tokio::runtime::Handle,
    next: AtomicU64,
    live: Arc<Mutex<HashMap<TimerId, tokio::task::AbortHandle>>>,
}

impl TokioTimers {
    pub fn new(runtime: tokio::runtime::Handle) -> Self {
        Self { runtime, next: AtomicU64::new(0), live: Arc::new(Mutex::new(HashMap::new())) }
    }
}

impl Timers for TokioTimers {
    fn after_with_id(&self, ms: u64, f: TimerIdFn) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let live = self.live.clone();
        // Registered before the task can run, so a 0 ms timer still finds (and removes) its own entry.
        let mut guard = self.live.lock();
        let task = self.runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            if live.lock().remove(&id).is_some() {
                f(id);
            }
        });
        guard.insert(id, task.abort_handle());
        id
    }

    fn cancel(&self, id: TimerId) {
        if let Some(task) = self.live.lock().remove(&id) {
            task.abort();
        }
    }
}

/// Test timers: they fire only when the test says so (`fire(ms)` runs every live timer of that length, like the TS tests).
#[derive(Default)]
pub struct ManualTimers {
    next: AtomicU64,
    timers: Mutex<Vec<ManualTimer>>,
}

struct ManualTimer {
    id: TimerId,
    ms: u64,
    f: Option<TimerIdFn>,
}

impl ManualTimers {
    /// Fires every live timer of `ms` (in the order they were set), outside the lock; returns how many ran.
    pub fn fire(&self, ms: u64) -> usize {
        let due: Vec<(TimerId, TimerIdFn)> = {
            let mut timers = self.timers.lock();
            timers.iter_mut().filter(|t| t.ms == ms).filter_map(|t| t.f.take().map(|f| (t.id, f))).collect()
        };
        let n = due.len();
        for (id, f) in due {
            f(id);
        }
        n
    }

    /// Fires every live timer of `ms` the way a real timer can race: the callbacks start (so `cancel` no longer finds
    /// them), `between` runs (a reschedule that cancels them), then they run. Returns how many ran.
    pub fn fire_late(&self, ms: u64, between: impl FnOnce()) -> usize {
        let due: Vec<(TimerId, TimerIdFn)> = {
            let mut timers = self.timers.lock();
            let due = timers.iter_mut().filter(|t| t.ms == ms).filter_map(|t| t.f.take().map(|f| (t.id, f))).collect();
            timers.retain(|t| t.f.is_some());
            due
        };
        between();
        let n = due.len();
        for (id, f) in due {
            f(id);
        }
        n
    }

    /// The lengths of the live timers, in order.
    pub fn live(&self) -> Vec<u64> {
        self.timers.lock().iter().filter(|t| t.f.is_some()).map(|t| t.ms).collect()
    }
}

impl Timers for ManualTimers {
    fn after_with_id(&self, ms: u64, f: TimerIdFn) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.timers.lock().push(ManualTimer { id, ms, f: Some(f) });
        id
    }

    fn cancel(&self, id: TimerId) {
        if let Some(t) = self.timers.lock().iter_mut().find(|t| t.id == id) {
            t.f = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test(start_paused = true)]
    async fn tokio_timers_fire_once_and_never_after_cancel() {
        let timers = TokioTimers::new(tokio::runtime::Handle::current());
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        timers.after(
            100,
            Box::new(move || {
                h.fetch_add(1, Ordering::SeqCst);
            }),
        );
        let h = hits.clone();
        let cancelled = timers.after(
            100,
            Box::new(move || {
                h.fetch_add(10, Ordering::SeqCst);
            }),
        );
        timers.cancel(cancelled);
        tokio::time::sleep(Duration::from_millis(150)).await;
        tokio::task::yield_now().await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert!(timers.live.lock().is_empty());
    }

    #[test]
    fn manual_timers_fire_by_length() {
        let timers = ManualTimers::default();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        timers.after(
            5,
            Box::new(move || {
                h.fetch_add(1, Ordering::SeqCst);
            }),
        );
        let id = timers.after(5, Box::new(|| panic!("cancelled")));
        timers.cancel(id);
        assert_eq!(timers.fire(7), 0);
        assert_eq!(timers.fire(5), 1);
        assert_eq!(timers.fire(5), 0);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
