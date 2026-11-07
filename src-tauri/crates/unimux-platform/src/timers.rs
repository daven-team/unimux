//! One-shot timers for the OS services (W4): the 60 s clear of a copied key, the 200 ms taskbar debounce. A trait so the
//! ported tests drive time by hand, like the injected `setTimer` / `clearTimer` of the TS code.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;

pub type TimerId = u64;
pub type TimerFn = Box<dyn FnOnce() + Send + 'static>;

pub trait Scheduler: Send + Sync {
    /// Runs `f` once after `ms` unless cancelled first.
    fn after(&self, ms: u64, f: TimerFn) -> TimerId;
    fn cancel(&self, id: TimerId);
}

/// The real scheduler: a sleeping thread per timer (they are rare: one per copied key, one per status burst).
#[derive(Default)]
pub struct ThreadScheduler {
    next: AtomicU64,
    live: Arc<Mutex<HashMap<TimerId, Arc<AtomicBool>>>>,
}

impl Scheduler for ThreadScheduler {
    fn after(&self, ms: u64, f: TimerFn) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let cancelled = Arc::new(AtomicBool::new(false));
        self.live.lock().insert(id, cancelled.clone());
        let live = self.live.clone();
        let spawned = std::thread::Builder::new().name("unimux-timer".into()).spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            live.lock().remove(&id);
            if !cancelled.load(Ordering::SeqCst) {
                f();
            }
        });
        if spawned.is_err() {
            self.live.lock().remove(&id);
        }
        id
    }

    fn cancel(&self, id: TimerId) {
        if let Some(flag) = self.live.lock().remove(&id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// Test scheduler: timers fire only when the test says so.
#[derive(Default)]
pub struct ManualScheduler {
    next: AtomicU64,
    timers: Mutex<Vec<ManualTimer>>,
}

struct ManualTimer {
    id: TimerId,
    ms: u64,
    cleared: bool,
    f: Option<TimerFn>,
}

impl ManualScheduler {
    /// `(ms, cleared)` of every timer set so far, in order.
    pub fn timers(&self) -> Vec<(u64, bool)> {
        self.timers.lock().iter().map(|t| (t.ms, t.cleared)).collect()
    }
    /// Timers set and not yet fired or cleared.
    pub fn pending(&self) -> usize {
        self.timers.lock().iter().filter(|t| !t.cleared && t.f.is_some()).count()
    }
    /// Fires every live timer (in order), outside the lock; returns how many ran.
    pub fn fire(&self) -> usize {
        let due: Vec<TimerFn> = {
            let mut timers = self.timers.lock();
            timers.iter_mut().filter(|t| !t.cleared).filter_map(|t| t.f.take()).collect()
        };
        let n = due.len();
        for f in due {
            f();
        }
        n
    }
    /// Forgets fired and cleared timers (the TS harness `timers.splice(0)`).
    pub fn clear_log(&self) {
        self.timers.lock().clear();
    }
}

impl Scheduler for ManualScheduler {
    fn after(&self, ms: u64, f: TimerFn) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.timers.lock().push(ManualTimer { id, ms, cleared: false, f: Some(f) });
        id
    }
    fn cancel(&self, id: TimerId) {
        if let Some(t) = self.timers.lock().iter_mut().find(|t| t.id == id) {
            t.cleared = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_timers_fire_once_unless_cancelled() {
        let s = ThreadScheduler::default();
        let hits = Arc::new(AtomicU64::new(0));
        let h = hits.clone();
        s.after(
            10,
            Box::new(move || {
                h.fetch_add(1, Ordering::SeqCst);
            }),
        );
        // A long delay for the cancelled one, so a loaded test machine cannot fire it before `cancel` runs.
        let h = hits.clone();
        let cancelled = s.after(
            300,
            Box::new(move || {
                h.fetch_add(100, Ordering::SeqCst);
            }),
        );
        s.cancel(cancelled);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while hits.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
