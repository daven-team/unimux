//! Timers of the output engine: the setTimeout of 1.1.4's Pty Host. [`ThreadScheduler`] runs every OutputChannel's
//! coalescing timer, pause watchdog and exit drain on one thread (a binary heap of due times; with timeBeginPeriod(1)
//! held by the engine its waits are about 1 ms precise on Windows). [`ManualScheduler`] is the fake clock of the tests
//! (vitest's fake timers): time moves only through `advance`.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

pub type Task = Box<dyn FnOnce() + Send>;

/// The id of a scheduled task (never 0).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TimerId(u64);

pub trait Scheduler: Send + Sync {
    /// Milliseconds of a monotonic clock (a wall-clock step never moves it).
    fn now(&self) -> f64;
    /// Runs `task` once `delay_ms` passed (on the scheduler's thread).
    fn after(&self, delay_ms: f64, task: Task) -> TimerId;
    /// Forgets a task that has not started yet.
    fn cancel(&self, id: TimerId);
}

/// The process-wide origin of [`ThreadScheduler::now`]: every terminal's aligned flush grid shares it.
fn origin() -> Instant {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    *ORIGIN.get_or_init(Instant::now)
}

#[derive(Default)]
struct Queue {
    heap: BinaryHeap<Reverse<(Instant, u64)>>,
    tasks: HashMap<u64, Task>,
    stop: bool,
}

struct Shared {
    queue: Mutex<Queue>,
    cv: Condvar,
    next: AtomicU64,
}

/// One timer thread; dropped with its last handle (the thread then ends).
pub struct ThreadScheduler {
    shared: Arc<Shared>,
}

impl ThreadScheduler {
    pub fn new(name: &str) -> Arc<Self> {
        let _ = origin();
        let shared = Arc::new(Shared { queue: Mutex::new(Queue::default()), cv: Condvar::new(), next: AtomicU64::new(1) });
        let worker = shared.clone();
        std::thread::Builder::new().name(name.into()).spawn(move || run(&worker)).expect("spawn the pty timer thread");
        Arc::new(Self { shared })
    }
}

fn run(shared: &Shared) {
    loop {
        let task = {
            let mut q = shared.queue.lock();
            loop {
                if q.stop {
                    return;
                }
                let now = Instant::now();
                match q.heap.peek().copied() {
                    Some(Reverse((due, id))) if due <= now => {
                        q.heap.pop();
                        if let Some(task) = q.tasks.remove(&id) {
                            break task;
                        }
                    }
                    Some(Reverse((due, _))) => {
                        let _ = shared.cv.wait_until(&mut q, due);
                    }
                    None => shared.cv.wait(&mut q),
                }
            }
        };
        // A panicking task must not end the timer thread of every terminal (the engine reports it as a crash itself).
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(task));
    }
}

impl Scheduler for ThreadScheduler {
    fn now(&self) -> f64 {
        origin().elapsed().as_secs_f64() * 1000.0
    }

    fn after(&self, delay_ms: f64, task: Task) -> TimerId {
        let id = self.shared.next.fetch_add(1, Ordering::Relaxed);
        let delay = Duration::from_secs_f64(delay_ms.max(0.0) / 1000.0);
        let mut q = self.shared.queue.lock();
        q.tasks.insert(id, task);
        q.heap.push(Reverse((Instant::now() + delay, id)));
        drop(q);
        self.shared.cv.notify_one();
        TimerId(id)
    }

    fn cancel(&self, id: TimerId) {
        self.shared.queue.lock().tasks.remove(&id.0);
    }
}

impl Drop for ThreadScheduler {
    fn drop(&mut self) {
        self.shared.queue.lock().stop = true;
        self.shared.cv.notify_all();
    }
}

/// Fake timers for tests: `now` starts at `start` and moves only in [`ManualScheduler::advance`], which runs every task
/// due by then in due order (tasks scheduled while advancing run too when they fall due).
pub struct ManualScheduler {
    state: Mutex<ManualState>,
}

struct ManualState {
    now: f64,
    next: u64,
    tasks: Vec<(f64, u64, Task)>,
}

impl ManualScheduler {
    pub fn new(start: f64) -> Arc<Self> {
        Arc::new(Self { state: Mutex::new(ManualState { now: start, next: 1, tasks: Vec::new() }) })
    }

    /// Moves the clock forward by `ms`, running the tasks due on the way.
    pub fn advance(&self, ms: f64) {
        let end = self.state.lock().now + ms;
        loop {
            let task = {
                let mut st = self.state.lock();
                let best = st
                    .tasks
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| t.0 <= end)
                    .min_by(|a, b| a.1.0.partial_cmp(&b.1.0).unwrap().then(a.1.1.cmp(&b.1.1)))
                    .map(|(i, _)| i);
                match best {
                    Some(i) => {
                        let (due, _, task) = st.tasks.remove(i);
                        st.now = st.now.max(due);
                        task
                    }
                    None => {
                        st.now = end;
                        return;
                    }
                }
            };
            task();
        }
    }

    /// Tasks still scheduled (vi.getTimerCount()).
    pub fn pending(&self) -> usize {
        self.state.lock().tasks.len()
    }
}

impl Scheduler for ManualScheduler {
    fn now(&self) -> f64 {
        self.state.lock().now
    }

    fn after(&self, delay_ms: f64, task: Task) -> TimerId {
        let mut st = self.state.lock();
        let id = st.next;
        st.next += 1;
        let due = st.now + delay_ms.max(0.0);
        st.tasks.push((due, id, task));
        TimerId(id)
    }

    fn cancel(&self, id: TimerId) {
        self.state.lock().tasks.retain(|t| t.1 != id.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn thread_scheduler_runs_in_due_order_and_cancels() {
        let s = ThreadScheduler::new("pty-timers-test");
        let (tx, rx) = mpsc::channel();
        let t = tx.clone();
        s.after(30.0, Box::new(move || t.send(30).unwrap()));
        let t = tx.clone();
        let cancelled = s.after(10.0, Box::new(move || t.send(10).unwrap()));
        let t = tx.clone();
        s.after(5.0, Box::new(move || t.send(5).unwrap()));
        s.cancel(cancelled);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 5);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 30);
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        let a = s.now();
        std::thread::sleep(Duration::from_millis(20));
        assert!(s.now() - a >= 19.0);
    }

    #[test]
    fn manual_scheduler_runs_tasks_scheduled_while_advancing() {
        let s = ManualScheduler::new(0.0);
        let log = Arc::new(Mutex::new(Vec::new()));
        let (l, s2) = (log.clone(), s.clone());
        s.after(
            10.0,
            Box::new(move || {
                l.lock().push(s2.now());
                let l2 = l.clone();
                let s3 = s2.clone();
                s2.after(5.0, Box::new(move || l2.lock().push(s3.now())));
            }),
        );
        s.advance(12.0);
        assert_eq!(*log.lock(), vec![10.0]);
        s.advance(3.0);
        assert_eq!(*log.lock(), vec![10.0, 15.0]);
        assert_eq!(s.now(), 15.0);
        assert_eq!(s.pending(), 0);
    }
}
