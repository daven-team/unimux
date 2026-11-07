//! The wind-down registry (PLAN W6): what 1.1.4's `before-quit` handler did in one function (index.ts:2217) is a list of steps
//! here. Every service registers its own step with a phase and a time budget when it starts; the quit runs the phases in
//! order (the steps of one phase together, like the `Promise.all` of the hosts) and the whole run stays inside
//! [`SHUTDOWN_HARD_LIMIT`] (after that the app exits anyway: a running installer waits for it).
//!
//! Phases (1.1.4 order):
//! 1. [`phase::STOP_SERVICES`] usage.stop, the activation retry, login and install dispose (A5, A2, A4, H6);
//! 2. [`phase::BEFORE_QUIT`] `app:before-quit` to every window (the renderers push their last edits) (W6);
//! 3. [`phase::RENDERER_GRACE`] 150 ms for those edits (W6);
//! 4. [`phase::CLOSE_DETACHED`] closeAllDetached, the registry stays for the next start (W5);
//! 5. [`phase::SAVE`] saver.flush (W6);
//! 6. [`phase::SWAP_WAIT`] a running account swap or "Set as main" finishes first, 5 s (A2);
//! 7. [`phase::HOSTS`] terminals, SFTP and DB sessions shut down together (P3, T1, D1);
//! 8. [`phase::SWAP_AFTER_CELLS`] an activation that waited for a Claude Code lock a cell held, 3 s (A2);
//! 9. [`phase::FINAL_SAVE`] `flush_until_saved` 3 s (W6);
//! 10. [`phase::MCP`] then [`phase::HOOKS`] (M1, H1).
//!
//! Differences to 1.1.4, on purpose: a step that fails or overruns its budget is logged and the next one runs (1.1.4 skipped
//! the rest of the try block after a failed host shutdown, including the last save); a step that panics ends only itself.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// Longest time the process may spend winding down before it exits anyway (`SHUTDOWN_HARD_LIMIT_MS`).
pub const SHUTDOWN_HARD_LIMIT: Duration = Duration::from_secs(20);
/// The renderers' moment to push their final state after `app:before-quit`.
pub const RENDERER_GRACE: Duration = Duration::from_millis(150);
/// Longest time the wind-down waits for a running swap before it goes on anyway (quitWait.ts `QUIT_SWAP_WAIT_MS`).
pub const QUIT_SWAP_WAIT: Duration = Duration::from_millis(5000);
/// The second wait, after the cells were shut down (`QUIT_SWAP_AFTER_CELLS_MS`).
pub const QUIT_SWAP_AFTER_CELLS: Duration = Duration::from_millis(3000);
/// The last save retries a locked state.json this long (`flushUntilSaved(saver, 3000)`).
pub const FINAL_SAVE: Duration = Duration::from_millis(3000);

#[allow(dead_code, reason = "the phases of the steps later packages register (A2, A4, A5, H6, W5, P3, T1, D1, M1, H1)")]
pub mod phase {
    pub const STOP_SERVICES: u32 = 10;
    pub const BEFORE_QUIT: u32 = 20;
    pub const RENDERER_GRACE: u32 = 30;
    pub const CLOSE_DETACHED: u32 = 40;
    pub const SAVE: u32 = 50;
    pub const SWAP_WAIT: u32 = 60;
    pub const HOSTS: u32 = 70;
    pub const SWAP_AFTER_CELLS: u32 = 80;
    pub const FINAL_SAVE: u32 = 90;
    pub const MCP: u32 = 100;
    pub const HOOKS: u32 = 110;
}

pub type StepFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type StepFn = Box<dyn FnOnce() -> StepFuture + Send>;

struct Step {
    phase: u32,
    name: String,
    budget: Duration,
    run: StepFn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    /// Ran longer than its budget; abandoned (a blocking part may still run in the background).
    OverBudget,
    Panicked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepReport {
    pub phase: u32,
    pub name: String,
    pub outcome: Outcome,
    pub elapsed: Duration,
}

/// The whole run did not finish within the hard limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverLimit;

#[derive(Default)]
pub struct WindDown {
    steps: Mutex<Vec<Step>>,
    force: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl WindDown {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a step. Steps of the same phase run together; a step longer than `budget` is abandoned and logged.
    pub fn register<F, Fut>(&self, phase: u32, name: &str, budget: Duration, run: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.steps.lock().push(Step { phase, name: name.to_string(), budget, run: Box::new(move || Box::pin(run())) });
    }

    /// What must happen when the hard limit is reached (1.1.4: `ptyHost.forceKill()`, `sftpHost.forceKill()`, ...).
    #[allow(dead_code, reason = "P3, T1 and D1 register the force kills of their sessions")]
    pub fn on_force_exit(&self, f: impl FnOnce() + Send + 'static) {
        self.force.lock().push(Box::new(f));
    }

    /// The registered steps as `(phase, name)`, in run order.
    #[cfg(any(test, feature = "test-bridge"))]
    pub fn plan(&self) -> Vec<(u32, String)> {
        let mut plan: Vec<(u32, String)> = self.steps.lock().iter().map(|s| (s.phase, s.name.clone())).collect();
        plan.sort_by_key(|(p, _)| *p);
        plan
    }

    /// Runs the force-exit actions (once).
    pub fn force_exit(&self) {
        let actions = std::mem::take(&mut *self.force.lock());
        for action in actions {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(action));
        }
    }

    /// Runs every registered step once, phase by phase (needs a tokio runtime). Steps registered while it runs wait for the
    /// next run (there is none: the app exits).
    pub async fn run(&self, log: &(dyn Fn(&str) + Sync)) -> Vec<StepReport> {
        let mut steps = std::mem::take(&mut *self.steps.lock());
        // Stable: within a phase, the registration order.
        steps.sort_by_key(|s| s.phase);
        let mut reports = Vec::with_capacity(steps.len());
        let mut iter = steps.into_iter().peekable();
        while let Some(first) = iter.next() {
            let phase = first.phase;
            let mut group = vec![first];
            while iter.peek().is_some_and(|s| s.phase == phase) {
                group.extend(iter.next());
            }
            let running: Vec<_> = group
                .into_iter()
                .map(|step| {
                    let started = Instant::now();
                    let handle = tokio::spawn((step.run)());
                    let budget = step.budget;
                    let name = step.name;
                    async move {
                        let abort = handle.abort_handle();
                        let outcome = match tokio::time::timeout(budget, handle).await {
                            Ok(Ok(())) => Outcome::Done,
                            Ok(Err(e)) if e.is_panic() => Outcome::Panicked,
                            Ok(Err(_)) => Outcome::Panicked,
                            Err(_) => {
                                abort.abort();
                                Outcome::OverBudget
                            }
                        };
                        StepReport { phase, name, outcome, elapsed: started.elapsed() }
                    }
                })
                .collect();
            for report in futures::future::join_all(running).await {
                match report.outcome {
                    Outcome::Done => {}
                    Outcome::OverBudget => log(&format!("quit step {} did not finish within its budget", report.name)),
                    Outcome::Panicked => log(&format!("quit step {} failed", report.name)),
                }
                reports.push(report);
            }
        }
        reports
    }

    /// [`run`](Self::run) within `limit` (the caller exits either way).
    pub async fn run_bounded(&self, limit: Duration, log: &(dyn Fn(&str) + Sync)) -> Result<Vec<StepReport>, OverLimit> {
        tokio::time::timeout(limit, self.run(log)).await.map_err(|_| OverLimit)
    }
}

/// Waits until the work is idle, at most `bound` (quitWait.ts `waitUntilIdle`). True when it is idle (at once when it already
/// was), false when the bound ran out first. `idle` resolves when the current holder lets go; one release is not enough (a
/// retry may claim the slot again at once), so `busy` is checked again each time.
#[allow(dead_code, reason = "A2 waits for a running swap with it")]
pub async fn wait_until_idle<B, I, Fut>(busy: B, idle: I, bound: Duration) -> bool
where
    B: Fn() -> bool,
    I: Fn() -> Fut,
    Fut: Future<Output = ()>,
{
    if !busy() {
        return true;
    }
    let watch = async {
        while busy() {
            idle().await;
        }
    };
    match tokio::time::timeout(bound, watch).await {
        Ok(()) => true,
        Err(_) => !busy(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;

    /// A piece of work like the account swap slot: busy until `finish`.
    struct Work {
        running: AtomicBool,
        done: Notify,
    }

    impl Work {
        fn new(busy: bool) -> Arc<Self> {
            Arc::new(Self { running: AtomicBool::new(busy), done: Notify::new() })
        }
        fn finish(&self) {
            self.running.store(false, Ordering::SeqCst);
            self.done.notify_waiters();
        }
        async fn wait(self: Arc<Self>, bound: Duration) -> bool {
            let w = self.clone();
            let w2 = self.clone();
            wait_until_idle(
                move || w.running.load(Ordering::SeqCst),
                move || {
                    let w = w2.clone();
                    async move { w.done.notified().await }
                },
                bound,
            )
            .await
        }
    }

    #[tokio::test(start_paused = true)]
    async fn never_waits_and_sets_no_timer_when_nothing_runs() {
        let started = tokio::time::Instant::now();
        assert!(Work::new(false).wait(Duration::from_millis(5000)).await);
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn resolves_true_as_soon_as_the_work_ends() {
        let work = Work::new(true);
        let w = work.clone();
        let started = tokio::time::Instant::now();
        let waiting = tokio::spawn(w.wait(Duration::from_millis(5000)));
        tokio::time::sleep(Duration::from_millis(1200)).await;
        work.finish();
        assert!(waiting.await.unwrap());
        assert_eq!(started.elapsed(), Duration::from_millis(1200));
    }

    #[tokio::test(start_paused = true)]
    async fn resolves_false_once_the_bound_runs_out_while_the_work_still_runs() {
        let work = Work::new(true);
        let started = tokio::time::Instant::now();
        assert!(!work.clone().wait(Duration::from_millis(5000)).await);
        assert_eq!(started.elapsed(), Duration::from_millis(5000));
        // A late end changes nothing.
        work.finish();
    }

    #[tokio::test(start_paused = true)]
    async fn a_release_followed_at_once_by_a_new_claim_keeps_waiting_within_the_bound() {
        let work = Work::new(true);
        let w = work.clone();
        let waiting = tokio::spawn(w.wait(Duration::from_millis(5000)));
        tokio::time::sleep(Duration::from_millis(1000)).await;
        // The slot is free for a moment only (a retry claims it again).
        work.done.notify_waiters();
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert!(!waiting.is_finished());
        work.finish();
        assert!(waiting.await.unwrap());
    }

    #[test]
    fn the_bounds_stay_well_inside_the_hard_shutdown_limit() {
        assert_eq!(QUIT_SWAP_WAIT, Duration::from_millis(5000));
        assert_eq!(QUIT_SWAP_AFTER_CELLS, Duration::from_millis(3000));
        // 0.15 s + both waits + terminals (about 4 s) + the last save (3 s) leave a margin to the hard limit.
        let sum = RENDERER_GRACE + QUIT_SWAP_WAIT + QUIT_SWAP_AFTER_CELLS + Duration::from_secs(4) + FINAL_SAVE;
        assert!(sum < SHUTDOWN_HARD_LIMIT - Duration::from_secs(3));
        // safe-window.test.ts "leaves the wind-down a bounded time".
        assert!(SHUTDOWN_HARD_LIMIT > Duration::from_secs(10) && SHUTDOWN_HARD_LIMIT <= Duration::from_secs(30));
    }

    type Events = Arc<Mutex<Vec<String>>>;

    #[tokio::test(start_paused = true)]
    async fn phases_run_in_order_and_the_steps_of_a_phase_together() {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let rec = |_: &str| events.clone();
        let wd = WindDown::new();
        let t0 = tokio::time::Instant::now();
        let push = move |e: &Events, what: &str| {
            e.lock().push(format!("{what}@{}", t0.elapsed().as_millis()));
        };
        // Registered out of order, as services start in any order.
        let e = rec("");
        wd.register(phase::FINAL_SAVE, "final-save", FINAL_SAVE, move || async move { push(&e, "final-save") });
        let e = rec("");
        wd.register(phase::HOSTS, "pty", Duration::from_secs(5), move || async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            push(&e, "pty");
        });
        let e = rec("");
        wd.register(phase::HOSTS, "db", Duration::from_secs(5), move || async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            push(&e, "db");
        });
        let e = rec("");
        wd.register(phase::BEFORE_QUIT, "before-quit", Duration::from_secs(1), move || async move { push(&e, "before-quit") });
        let e = rec("");
        wd.register(phase::RENDERER_GRACE, "grace", Duration::from_secs(1), move || async move {
            tokio::time::sleep(RENDERER_GRACE).await;
            push(&e, "grace");
        });
        assert_eq!(
            wd.plan().into_iter().map(|(_, n)| n).collect::<Vec<_>>(),
            ["before-quit", "grace", "pty", "db", "final-save"]
        );
        let reports = wd.run(&|_| {}).await;
        assert!(reports.iter().all(|r| r.outcome == Outcome::Done));
        // The hosts ran together: both done 400 ms after the grace, not 500.
        assert_eq!(*events.lock(), ["before-quit@0", "grace@150", "db@250", "pty@550", "final-save@550"]);
        // A second run has nothing left.
        assert!(wd.run(&|_| {}).await.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_step_over_its_budget_or_panicking_is_logged_and_the_rest_still_runs() {
        let wd = WindDown::new();
        let saved = Arc::new(AtomicBool::new(false));
        wd.register(phase::HOSTS, "stuck-host", Duration::from_secs(4), || async {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        });
        wd.register(phase::HOSTS, "broken-host", Duration::from_secs(4), || async { panic!("host shutdown failed") });
        let s = saved.clone();
        wd.register(phase::FINAL_SAVE, "final-save", FINAL_SAVE, move || async move { s.store(true, Ordering::SeqCst) });
        let logs = Mutex::new(Vec::new());
        let started = tokio::time::Instant::now();
        let reports = wd.run(&|m| logs.lock().push(m.to_string())).await;
        assert!(saved.load(Ordering::SeqCst), "the last save runs after a failed host shutdown (1.1.4 skipped it)");
        assert_eq!(started.elapsed(), Duration::from_secs(4));
        let outcomes: Vec<_> = reports.iter().map(|r| (r.name.as_str(), r.outcome)).collect();
        assert_eq!(
            outcomes,
            [("stuck-host", Outcome::OverBudget), ("broken-host", Outcome::Panicked), ("final-save", Outcome::Done)]
        );
        assert_eq!(*logs.lock(), ["quit step stuck-host did not finish within its budget", "quit step broken-host failed"]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_hard_limit_ends_a_wind_down_that_overruns_and_force_exit_runs_once() {
        let wd = WindDown::new();
        // Budgets that add up beyond the limit (each step alone is within its own).
        for (i, p) in [phase::SWAP_WAIT, phase::HOSTS, phase::SWAP_AFTER_CELLS].into_iter().enumerate() {
            wd.register(p, &format!("slow-{i}"), Duration::from_secs(9), || async {
                tokio::time::sleep(Duration::from_secs(8)).await;
            });
        }
        let forced = Arc::new(Mutex::new(0));
        let f = forced.clone();
        wd.on_force_exit(move || *f.lock() += 1);
        let started = tokio::time::Instant::now();
        assert_eq!(wd.run_bounded(SHUTDOWN_HARD_LIMIT, &|_| {}).await, Err(OverLimit));
        assert_eq!(started.elapsed(), SHUTDOWN_HARD_LIMIT);
        wd.force_exit();
        wd.force_exit();
        assert_eq!(*forced.lock(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn an_empty_registry_finishes_at_once() {
        let wd = WindDown::new();
        let started = tokio::time::Instant::now();
        assert_eq!(wd.run_bounded(SHUTDOWN_HARD_LIMIT, &|_| {}).await, Ok(vec![]));
        assert_eq!(started.elapsed(), Duration::ZERO);
    }
}
