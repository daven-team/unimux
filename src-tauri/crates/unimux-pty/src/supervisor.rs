//! The supervised actor that replaces the Pty Host utility process of 1.1.4 (src/main/ptyHostClient.ts): commands run in
//! order on one thread against a state built by a factory; a panic ends only that state (the terminals of a pty manager are
//! killed with it, like the host process dying took its ConPTYs along) and counts as a crash. More than 5 crashes within
//! 60 s are fatal (nothing runs until [`Supervisor::restart_after_fatal`], the "Restart terminals" button); otherwise the
//! state is built again after 500 * 2^(n-1) ms. Commands sent between a crash and the restart are kept (up to 500) and run
//! after it; commands that were queued when the crash happened are lost, as messages posted to the dead host were.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

use crate::manager::panic_message;

/// Messages kept while the actor restarts; more are dropped (RESTART_QUEUE_LIMIT).
pub const RESTART_QUEUE_LIMIT: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CrashPolicy {
    /// Crashes older than this are forgotten.
    pub window: Duration,
    /// More crashes than this within the window are fatal.
    pub max_crashes: usize,
    /// The first restart waits this long, every further one twice as long.
    pub base_delay: Duration,
}

impl Default for CrashPolicy {
    fn default() -> Self {
        Self { window: Duration::from_secs(60), max_crashes: 5, base_delay: Duration::from_millis(500) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashOutcome {
    /// Restart after this delay; `count` crashes are in the window (this one included).
    Restart {
        after: Duration,
        count: usize,
    },
    Fatal {
        count: usize,
    },
}

/// The crash bookkeeping of PtyHostClient (`crashes` filtered to the last 60 s).
#[derive(Debug, Clone, Default)]
pub struct CrashCounter {
    policy: CrashPolicy,
    crashes: Vec<Instant>,
}

impl CrashCounter {
    pub fn new(policy: CrashPolicy) -> Self {
        Self { policy, crashes: Vec::new() }
    }

    pub fn record(&mut self, now: Instant) -> CrashOutcome {
        let window = self.policy.window;
        self.crashes.retain(|t| now.saturating_duration_since(*t) < window);
        self.crashes.push(now);
        let count = self.crashes.len();
        if count > self.policy.max_crashes {
            return CrashOutcome::Fatal { count };
        }
        let factor = 1u32.checked_shl(count as u32 - 1).unwrap_or(u32::MAX);
        CrashOutcome::Restart { after: self.policy.base_delay.saturating_mul(factor), count }
    }

    pub fn reset(&mut self) {
        self.crashes.clear();
    }
}

/// What the supervisor reports (P3 maps them to `ptyhost:crashed` / `ptyhost:fatal`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisorEvent {
    /// The state panicked and will be built again after `restart_in`; `message` is the panic text (the stderr tail of 1.1.4).
    Crashed { message: String, count: usize, restart_in: Duration },
    /// Too many crashes: nothing runs until `restart_after_fatal`.
    Fatal { message: String, count: usize },
    /// A new state was built after a crash.
    Restarted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Running,
    Restarting,
    Fatal,
    Stopped,
}

struct State<M> {
    phase: Phase,
    queue: VecDeque<M>,
    /// A crash raised from outside the actor thread (a panic in a terminal's reader callback).
    injected: Option<String>,
    restart_after_fatal: bool,
}

struct Shared<M> {
    state: Mutex<State<M>>,
    cv: Condvar,
}

/// Commands of type `M`, run one at a time by a supervised thread.
pub struct Supervisor<M: Send + 'static> {
    shared: Arc<Shared<M>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

/// Raises a crash in the actor from another thread (see [`Supervisor::crash_injector`]).
pub struct CrashInjector<M: Send + 'static>(std::sync::Weak<Shared<M>>);

impl<M: Send + 'static> Clone for CrashInjector<M> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<M: Send + 'static> CrashInjector<M> {
    pub fn crash(&self, message: String) {
        if let Some(shared) = self.0.upgrade() {
            let mut st = shared.state.lock();
            if st.phase == Phase::Running && st.injected.is_none() {
                st.injected = Some(message);
                shared.cv.notify_all();
            }
        }
    }
}

impl<M: Send + 'static> Supervisor<M> {
    /// Starts the actor thread. `factory` builds the state (again after every crash) and gets an injector for crashes found
    /// outside the thread; `handle` runs one command; `events` gets crash reports (on the actor thread).
    pub fn start<S, F, H, E>(name: &str, policy: CrashPolicy, factory: F, handle: H, events: E) -> Self
    where
        S: 'static,
        F: Fn(CrashInjector<M>) -> S + Send + 'static,
        H: Fn(&mut S, M) + Send + 'static,
        E: Fn(SupervisorEvent) + Send + 'static,
    {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                phase: Phase::Running,
                queue: VecDeque::new(),
                injected: None,
                restart_after_fatal: false,
            }),
            cv: Condvar::new(),
        });
        let actor = shared.clone();
        let thread = std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || run(actor, policy, factory, handle, events))
            .expect("supervisor thread");
        Self { shared, thread: Mutex::new(Some(thread)) }
    }

    /// Queues a command. False when it was dropped: the actor is fatal or stopped, or the restart queue is full.
    pub fn send(&self, m: M) -> bool {
        let mut st = self.shared.state.lock();
        match st.phase {
            Phase::Fatal | Phase::Stopped => return false,
            Phase::Restarting if st.queue.len() >= RESTART_QUEUE_LIMIT => return false,
            _ => {}
        }
        st.queue.push_back(m);
        self.shared.cv.notify_all();
        true
    }

    pub fn is_fatal(&self) -> bool {
        self.shared.state.lock().phase == Phase::Fatal
    }

    /// The user chose "Restart terminals" after a fatal crash: the count starts again and a new state is built.
    pub fn restart_after_fatal(&self) {
        let mut st = self.shared.state.lock();
        if st.phase == Phase::Fatal {
            st.restart_after_fatal = true;
            self.shared.cv.notify_all();
        }
    }

    pub fn crash_injector(&self) -> CrashInjector<M> {
        CrashInjector(Arc::downgrade(&self.shared))
    }

    /// Stops the actor: queued commands are dropped, the state is dropped on the actor thread, and this waits for it.
    pub fn stop(&self) {
        {
            let mut st = self.shared.state.lock();
            st.phase = Phase::Stopped;
            st.queue.clear();
            self.shared.cv.notify_all();
        }
        if let Some(t) = self.thread.lock().take()
            && t.thread().id() != std::thread::current().id()
        {
            let _ = t.join();
        }
    }
}

impl<M: Send + 'static> Drop for Supervisor<M> {
    fn drop(&mut self) {
        self.stop();
    }
}

enum Next<M> {
    Run(M),
    Crash(String),
    Stop,
}

fn run<M, S, F, H, E>(shared: Arc<Shared<M>>, policy: CrashPolicy, factory: F, handle: H, events: E)
where
    M: Send + 'static,
    F: Fn(CrashInjector<M>) -> S,
    H: Fn(&mut S, M),
    E: Fn(SupervisorEvent),
{
    let mut counter = CrashCounter::new(policy);
    let injector = || CrashInjector(Arc::downgrade(&shared));
    let mut state = match catch_unwind(AssertUnwindSafe(|| factory(injector()))) {
        Ok(s) => Some(s),
        Err(p) => {
            // A factory that panics counts as a crash like any other.
            crash(&shared, &mut counter, &events, panic_message(p.as_ref()), &factory, injector)
        }
    };
    loop {
        let Some(s) = state.as_mut() else { return };
        let next = {
            let mut st = shared.state.lock();
            loop {
                if st.phase == Phase::Stopped {
                    break Next::Stop;
                }
                if let Some(message) = st.injected.take() {
                    break Next::Crash(message);
                }
                if let Some(m) = st.queue.pop_front() {
                    break Next::Run(m);
                }
                shared.cv.wait(&mut st);
            }
        };
        let crashed = match next {
            Next::Stop => {
                drop(state.take());
                return;
            }
            Next::Crash(message) => Some(message),
            Next::Run(m) => catch_unwind(AssertUnwindSafe(|| handle(s, m))).err().map(|p| panic_message(p.as_ref())),
        };
        if let Some(message) = crashed {
            // The broken state goes first (its terminals are killed), as the dead host took its ConPTYs along.
            drop(state.take());
            state = crash(&shared, &mut counter, &events, message, &factory, injector);
        }
    }
}

/// After a crash: report it, wait for the restart (or for the user after a fatal one) and build a new state. None: stopped.
fn crash<M, S, F, E>(
    shared: &Arc<Shared<M>>,
    counter: &mut CrashCounter,
    events: &E,
    mut message: String,
    factory: &F,
    injector: impl Fn() -> CrashInjector<M>,
) -> Option<S>
where
    M: Send + 'static,
    F: Fn(CrashInjector<M>) -> S,
    E: Fn(SupervisorEvent),
{
    loop {
        let outcome = counter.record(Instant::now());
        {
            let mut st = shared.state.lock();
            if st.phase == Phase::Stopped {
                return None;
            }
            // What was posted to the crashed state is lost; what comes during the restart waits (RESTART_QUEUE_LIMIT).
            st.queue.clear();
            st.injected = None;
            st.phase = if matches!(outcome, CrashOutcome::Fatal { .. }) { Phase::Fatal } else { Phase::Restarting };
        }
        match outcome {
            CrashOutcome::Fatal { count } => {
                events(SupervisorEvent::Fatal { message: message.clone(), count });
                let mut st = shared.state.lock();
                while !st.restart_after_fatal && st.phase != Phase::Stopped {
                    shared.cv.wait(&mut st);
                }
                if st.phase == Phase::Stopped {
                    return None;
                }
                st.restart_after_fatal = false;
                st.phase = Phase::Restarting;
                counter.reset();
            }
            CrashOutcome::Restart { after, count } => {
                events(SupervisorEvent::Crashed { message: message.clone(), count, restart_in: after });
                let deadline = Instant::now() + after;
                let mut st = shared.state.lock();
                while st.phase != Phase::Stopped && !shared.cv.wait_until(&mut st, deadline).timed_out() {}
                if st.phase == Phase::Stopped {
                    return None;
                }
            }
        }
        match catch_unwind(AssertUnwindSafe(|| factory(injector()))) {
            Ok(s) => {
                let mut st = shared.state.lock();
                if st.phase == Phase::Stopped {
                    return None;
                }
                st.phase = Phase::Running;
                drop(st);
                events(SupervisorEvent::Restarted);
                return Some(s);
            }
            Err(p) => message = panic_message(p.as_ref()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn restart_delays_and_fatal_after_more_than_five_in_60_s() {
        let mut c = CrashCounter::new(CrashPolicy::default());
        let t0 = Instant::now();
        let delays: Vec<CrashOutcome> = (0..6).map(|i| c.record(t0 + Duration::from_secs(i))).collect();
        assert_eq!(
            delays,
            vec![
                CrashOutcome::Restart { after: Duration::from_millis(500), count: 1 },
                CrashOutcome::Restart { after: Duration::from_millis(1000), count: 2 },
                CrashOutcome::Restart { after: Duration::from_millis(2000), count: 3 },
                CrashOutcome::Restart { after: Duration::from_millis(4000), count: 4 },
                CrashOutcome::Restart { after: Duration::from_millis(8000), count: 5 },
                CrashOutcome::Fatal { count: 6 },
            ]
        );
        // Crashes older than 60 s are forgotten (`now - t < 60_000`: exactly 60 s old is gone too).
        let mut c = CrashCounter::new(CrashPolicy::default());
        for i in 0..5 {
            c.record(t0 + Duration::from_secs(i));
        }
        assert_eq!(c.record(t0 + Duration::from_secs(64)), CrashOutcome::Restart { after: Duration::from_millis(500), count: 1 });
        let mut c = CrashCounter::new(CrashPolicy::default());
        c.record(t0);
        assert_eq!(c.record(t0 + Duration::from_secs(60)), CrashOutcome::Restart { after: Duration::from_millis(500), count: 1 });
        c.reset();
        assert_eq!(c.record(t0 + Duration::from_secs(61)), CrashOutcome::Restart { after: Duration::from_millis(500), count: 1 });
    }

    enum Cmd {
        Push(u32),
        Panic,
        Report(mpsc::Sender<Vec<u32>>),
    }

    fn fast() -> CrashPolicy {
        CrashPolicy { base_delay: Duration::from_millis(20), ..CrashPolicy::default() }
    }

    fn actor(policy: CrashPolicy) -> (Supervisor<Cmd>, mpsc::Receiver<SupervisorEvent>, Arc<Mutex<u32>>) {
        let (tx, rx) = mpsc::channel();
        let builds = Arc::new(Mutex::new(0u32));
        let b = builds.clone();
        let tx = Mutex::new(tx);
        let sup = Supervisor::start(
            "test-actor",
            policy,
            move |_| {
                *b.lock() += 1;
                Vec::<u32>::new()
            },
            |s: &mut Vec<u32>, m| match m {
                Cmd::Push(n) => s.push(n),
                Cmd::Panic => panic!("boom {}", s.len()),
                Cmd::Report(r) => {
                    let _ = r.send(s.clone());
                }
            },
            move |e| {
                let _ = tx.lock().send(e);
            },
        );
        (sup, rx, builds)
    }

    fn report(sup: &Supervisor<Cmd>) -> Vec<u32> {
        let (tx, rx) = mpsc::channel();
        assert!(sup.send(Cmd::Report(tx)));
        rx.recv_timeout(Duration::from_secs(5)).expect("report")
    }

    #[test]
    fn a_panic_rebuilds_the_state_and_later_commands_run() {
        let (sup, events, builds) = actor(fast());
        sup.send(Cmd::Push(1));
        sup.send(Cmd::Push(2));
        assert_eq!(report(&sup), vec![1, 2]);
        sup.send(Cmd::Panic);
        let e = events.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(e, SupervisorEvent::Crashed { message: "boom 2".into(), count: 1, restart_in: Duration::from_millis(20) });
        // Sent during the restart: kept and run on the new state.
        sup.send(Cmd::Push(3));
        assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Restarted);
        assert_eq!(report(&sup), vec![3]);
        assert_eq!(*builds.lock(), 2);
    }

    #[test]
    fn six_crashes_are_fatal_until_restart_after_fatal() {
        let (sup, events, builds) = actor(CrashPolicy { base_delay: Duration::from_millis(1), ..CrashPolicy::default() });
        for i in 1..=5 {
            sup.send(Cmd::Panic);
            assert!(
                matches!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Crashed { count, .. } if count == i)
            );
            assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Restarted);
        }
        sup.send(Cmd::Panic);
        assert_eq!(
            events.recv_timeout(Duration::from_secs(5)).unwrap(),
            SupervisorEvent::Fatal { message: "boom 0".into(), count: 6 }
        );
        assert!(sup.is_fatal());
        assert!(!sup.send(Cmd::Push(9)), "a fatal actor takes no commands");
        sup.restart_after_fatal();
        assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Restarted);
        assert!(!sup.is_fatal());
        assert_eq!(report(&sup), Vec::<u32>::new());
        // The count started again: the next crash is the first.
        sup.send(Cmd::Panic);
        assert!(matches!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Crashed { count: 1, .. }));
        assert_eq!(*builds.lock(), 7);
    }

    #[test]
    fn the_restart_queue_is_bounded() {
        let (sup, events, _) = actor(CrashPolicy { base_delay: Duration::from_millis(400), ..CrashPolicy::default() });
        sup.send(Cmd::Panic);
        assert!(matches!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Crashed { .. }));
        let accepted = (0..RESTART_QUEUE_LIMIT as u32 + 10).filter(|n| sup.send(Cmd::Push(*n))).count();
        assert_eq!(accepted, RESTART_QUEUE_LIMIT);
        assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Restarted);
        assert_eq!(report(&sup).len(), RESTART_QUEUE_LIMIT);
    }

    #[test]
    fn an_injected_crash_counts_and_stop_ends_the_thread() {
        let (sup, events, builds) = actor(fast());
        sup.send(Cmd::Push(1));
        assert_eq!(report(&sup), vec![1]);
        sup.crash_injector().crash("reader callback panicked".into());
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(5)).unwrap(),
            SupervisorEvent::Crashed { ref message, count: 1, .. } if message == "reader callback panicked"
        ));
        assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Restarted);
        assert_eq!(report(&sup), Vec::<u32>::new());
        sup.stop();
        assert!(!sup.send(Cmd::Push(2)));
        assert_eq!(*builds.lock(), 2);
    }
}
