//! One-shot timers of the SFTP service and the progress throttle (the injected `setTimer` / `clearTimer` of SftpService):
//! a trait so the ported tests drive time by hand like the TS tests do. The same shape as unimux-db's timers.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;

pub type TimerId = u64;
pub type TimerFn = Box<dyn FnOnce() + Send + 'static>;

pub trait Timers: Send + Sync {
    /// Runs `f` once after `ms` unless cancelled first.
    fn after(&self, ms: u64, f: TimerFn) -> TimerId;
    fn cancel(&self, id: TimerId);
}

/// The real timers: one tokio task per timer (aborted when cancelled).
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
    fn after(&self, ms: u64, f: TimerFn) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let live = self.live.clone();
        // Registered before the task can run, so a 0 ms timer still finds (and removes) its own entry.
        let mut guard = self.live.lock();
        let task = self.runtime.spawn(async move {
            if ms > 0 {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            } else {
                tokio::task::yield_now().await;
            }
            if live.lock().remove(&id).is_some() {
                f();
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

/// Test timers: they fire only when the test says so.
#[derive(Default)]
pub struct ManualTimers {
    next: AtomicU64,
    timers: Mutex<Vec<(TimerId, u64, Option<TimerFn>)>>,
}

impl ManualTimers {
    /// Fires every live timer of `ms` (in the order they were set), outside the lock; returns how many ran.
    pub fn fire(&self, ms: u64) -> usize {
        self.fire_where(|m| m == ms)
    }

    /// Fires every live timer.
    pub fn fire_all(&self) -> usize {
        self.fire_where(|_| true)
    }

    fn fire_where(&self, pick: impl Fn(u64) -> bool) -> usize {
        let due: Vec<TimerFn> = {
            let mut timers = self.timers.lock();
            let due = timers.iter_mut().filter(|t| pick(t.1)).filter_map(|t| t.2.take()).collect();
            timers.retain(|t| t.2.is_some());
            due
        };
        let n = due.len();
        for f in due {
            f();
        }
        n
    }

    /// The lengths of the live timers, in order.
    pub fn live(&self) -> Vec<u64> {
        self.timers.lock().iter().filter(|t| t.2.is_some()).map(|t| t.1).collect()
    }
}

impl Timers for ManualTimers {
    fn after(&self, ms: u64, f: TimerFn) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.timers.lock().push((id, ms, Some(f)));
        id
    }

    fn cancel(&self, id: TimerId) {
        if let Some(t) = self.timers.lock().iter_mut().find(|t| t.0 == id) {
            t.2 = None;
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
}
