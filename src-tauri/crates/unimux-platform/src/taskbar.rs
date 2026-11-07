//! The Dock badge (port of src/shared/taskbarState.ts and src/main/taskbar.ts): on macOS the number of agents waiting for
//! the user; nothing on Windows since 1.1.2 (the taskbar overlay was dropped, the progress bar in 1.1.0). Statuses only mark
//! the view dirty, one debounced pass (200 ms) computes it, and the OS is called only when what it shows changes.
//! The statuses arrive through `cell:runtime` (W7 feeds them); this module owns the counting and the debounce.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;

use crate::timers::{Scheduler, TimerId};

/// Statuses flip in bursts (a turn end, a grid start): the badge follows them once per this window.
pub const TASKBAR_DEBOUNCE_MS: u64 = 200;

const STATUSES: [&str; 4] = ["idle", "working", "waiting", "exited"];
const REASONS: [&str; 3] = ["done", "attention", "error"];

pub fn is_cell_status(value: &str) -> bool {
    STATUSES.contains(&value)
}
pub fn is_status_reason(value: &str) -> bool {
    REASONS.contains(&value)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellRuntime {
    pub status: String,
    pub reason: Option<String>,
}

impl CellRuntime {
    pub fn new(status: &str, reason: Option<&str>) -> Self {
        Self { status: status.to_string(), reason: reason.map(str::to_string) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskbarCell {
    pub id: String,
    pub muted: bool,
    pub agent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TaskbarCounts {
    /// Agent cells that need the user (a permission, a question, an input request), muted cells left out.
    pub attention: u32,
    /// Agent cells working right now.
    pub working: u32,
}

/// `taskbarCounts`: only running agent cells count; a muted cell still counts as working, it only never asks for you.
pub fn taskbar_counts(cells: &[TaskbarCell], runtime: &HashMap<String, CellRuntime>, alive: &HashSet<String>) -> TaskbarCounts {
    let mut counts = TaskbarCounts::default();
    for cell in cells {
        if !cell.agent || !alive.contains(&cell.id) {
            continue;
        }
        let Some(r) = runtime.get(&cell.id) else { continue };
        if r.status == "working" {
            counts.working += 1;
        } else if r.status == "waiting" && r.reason.as_deref() == Some("attention") && !cell.muted {
            counts.attention += 1;
        }
    }
    counts
}

/// What the Dock shows ('' = no badge). Only macOS has one.
pub fn taskbar_view(counts: TaskbarCounts, taskbar_badge: bool, platform: &str) -> String {
    let count = if taskbar_badge { counts.attention } else { 0 };
    if platform == "darwin" && count > 0 { count.to_string() } else { String::new() }
}

/// What the taskbar reads from the app when it computes the view.
pub struct TaskbarDeps {
    pub platform: String,
    pub cells: Box<dyn Fn() -> Vec<TaskbarCell> + Send + Sync>,
    pub alive: Box<dyn Fn() -> HashSet<String> + Send + Sync>,
    /// `settings.alerts.taskbarBadge`.
    pub taskbar_badge: Box<dyn Fn() -> bool + Send + Sync>,
    /// macOS: the Dock badge.
    pub set_dock_badge: Box<dyn Fn(&str) + Send + Sync>,
    pub scheduler: Arc<dyn Scheduler>,
}

struct Inner {
    runtime: HashMap<String, CellRuntime>,
    reporter: HashMap<String, String>,
    applied: String,
    timer: Option<TimerId>,
    disposed: bool,
}

pub struct Taskbar {
    deps: TaskbarDeps,
    inner: Mutex<Inner>,
    me: Weak<Taskbar>,
}

impl Taskbar {
    pub fn new(deps: TaskbarDeps) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            deps,
            inner: Mutex::new(Inner {
                runtime: HashMap::new(),
                reporter: HashMap::new(),
                applied: String::new(),
                timer: None,
                disposed: false,
            }),
            me: me.clone(),
        })
    }

    fn compute(&self, runtime: &HashMap<String, CellRuntime>) -> String {
        let counts = taskbar_counts(&(self.deps.cells)(), runtime, &(self.deps.alive)());
        taskbar_view(counts, (self.deps.taskbar_badge)(), &self.deps.platform)
    }

    /// Applies `next` when it differs (or always with `force`); the OS call happens outside the lock.
    fn apply(&self, force: bool) {
        let call = {
            let mut inner = self.inner.lock();
            let next = self.compute(&inner.runtime);
            if !force && next == inner.applied {
                return;
            }
            let changed = force || next != inner.applied;
            inner.applied = next.clone();
            changed.then_some(next)
        };
        if let Some(text) = call {
            (self.deps.set_dock_badge)(&text);
        }
    }

    fn run(&self) {
        {
            let mut inner = self.inner.lock();
            inner.timer = None;
            if inner.disposed {
                return;
            }
        }
        self.apply(false);
    }

    fn schedule(&self, inner: &mut Inner) {
        if inner.disposed || inner.timer.is_some() {
            return;
        }
        let me = self.me.clone();
        inner.timer = Some(self.deps.scheduler.after(
            TASKBAR_DEBOUNCE_MS,
            Box::new(move || {
                if let Some(t) = me.upgrade() {
                    t.run();
                }
            }),
        ));
    }

    /// A cell reported its status; `window` is the reporting window (`main` or a detached window's id).
    pub fn status(&self, cell_id: &str, runtime: CellRuntime, window: Option<&str>) {
        let mut inner = self.inner.lock();
        inner.reporter.insert(cell_id.to_string(), window.unwrap_or("main").to_string());
        if let Some(prev) = inner.runtime.get(cell_id)
            && prev.status == runtime.status
            && prev.reason == runtime.reason
        {
            return;
        }
        inner.runtime.insert(cell_id.to_string(), runtime);
        self.schedule(&mut inner);
    }

    /// A cell is gone (killed, removed): its status no longer counts.
    pub fn forget(&self, cell_id: &str) {
        let mut inner = self.inner.lock();
        inner.reporter.remove(cell_id);
        if inner.runtime.remove(cell_id).is_some() {
            self.schedule(&mut inner);
        }
    }

    /// A window's page went away (reload, crash, closed): the statuses it reported are forgotten until it reports again.
    pub fn forget_window(&self, window: &str) {
        let mut inner = self.inner.lock();
        let cells: Vec<String> = inner.reporter.iter().filter(|(_, w)| *w == window).map(|(c, _)| c.clone()).collect();
        let mut changed = false;
        for cell in cells {
            inner.reporter.remove(&cell);
            changed = inner.runtime.remove(&cell).is_some() || changed;
        }
        if changed {
            self.schedule(&mut inner);
        }
    }

    /// Cells, mutes or the settings may have changed.
    pub fn invalidate(&self) {
        let mut inner = self.inner.lock();
        self.schedule(&mut inner);
    }

    /// The Dock tile was recreated (window shown again): show the current view again.
    pub fn reapply(&self) {
        {
            let mut inner = self.inner.lock();
            if inner.disposed {
                return;
            }
            if let Some(t) = inner.timer.take() {
                self.deps.scheduler.cancel(t);
            }
        }
        self.apply(true);
    }

    /// Runs a pending update now (tests, quit).
    pub fn flush(&self) {
        let timer = self.inner.lock().timer.take();
        let Some(t) = timer else { return };
        self.deps.scheduler.cancel(t);
        self.run();
    }

    pub fn view(&self) -> String {
        self.inner.lock().applied.clone()
    }

    pub fn dispose(&self) {
        let mut inner = self.inner.lock();
        inner.disposed = true;
        if let Some(t) = inner.timer.take() {
            self.deps.scheduler.cancel(t);
        }
    }
}

#[cfg(test)]
mod tests {
    //! Port of test/taskbar.test.ts.
    use super::*;
    use crate::timers::ManualScheduler;

    fn cell(id: &str, agent: bool, muted: bool) -> TaskbarCell {
        TaskbarCell { id: id.into(), agent, muted }
    }
    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn counts_running_agent_cells_attention_without_muted_ones_working_with_them_shells_and_dead_cells_never() {
        let cells = vec![
            cell("a", true, false),
            cell("b", true, false),
            cell("c", true, true),
            cell("sh", false, false),
            cell("gone", true, false),
        ];
        let mut runtime: HashMap<String, CellRuntime> = [
            ("a", CellRuntime::new("waiting", Some("attention"))),
            ("b", CellRuntime::new("working", None)),
            ("c", CellRuntime::new("waiting", Some("attention"))),
            ("sh", CellRuntime::new("working", None)),
            ("gone", CellRuntime::new("waiting", Some("attention"))),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let alive = set(&["a", "b", "c", "sh"]);
        assert_eq!(taskbar_counts(&cells, &runtime, &alive), TaskbarCounts { attention: 1, working: 1 });
        runtime.insert("c".into(), CellRuntime::new("working", None));
        assert_eq!(taskbar_counts(&cells, &runtime, &alive), TaskbarCounts { attention: 1, working: 2 });
    }

    #[test]
    fn a_finished_turn_or_an_error_is_not_waiting_for_you() {
        let cells = vec![cell("a", true, false), cell("b", true, false)];
        let runtime: HashMap<String, CellRuntime> = [
            ("a".to_string(), CellRuntime::new("waiting", Some("done"))),
            ("b".to_string(), CellRuntime::new("waiting", Some("error"))),
        ]
        .into_iter()
        .collect();
        assert_eq!(taskbar_counts(&cells, &runtime, &set(&["a", "b"])), TaskbarCounts::default());
    }

    #[test]
    fn only_the_macos_dock_gets_a_badge() {
        let c = |attention| TaskbarCounts { attention, working: 1 };
        assert_eq!(taskbar_view(c(2), true, "win32"), "");
        assert_eq!(taskbar_view(c(12), true, "darwin"), "12");
        assert_eq!(taskbar_view(c(2), false, "darwin"), "");
        assert_eq!(taskbar_view(c(2), true, "linux"), "");
    }

    #[test]
    fn validates_reported_statuses() {
        assert!(is_cell_status("waiting"));
        assert!(!is_cell_status("busy"));
        assert!(is_status_reason("attention"));
        assert!(!is_status_reason(""));
    }

    struct Harness {
        taskbar: Arc<Taskbar>,
        calls: Arc<Mutex<Vec<String>>>,
        sched: Arc<ManualScheduler>,
        cells: Arc<Mutex<Vec<TaskbarCell>>>,
    }

    fn harness(platform: &str) -> Harness {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let sched = Arc::new(ManualScheduler::default());
        let cells = Arc::new(Mutex::new(vec![cell("a", true, false), cell("b", true, false)]));
        let c = calls.clone();
        let list = cells.clone();
        let taskbar = Taskbar::new(TaskbarDeps {
            platform: platform.into(),
            cells: Box::new(move || list.lock().clone()),
            alive: Box::new(|| set(&["a", "b"])),
            taskbar_badge: Box::new(|| true),
            set_dock_badge: Box::new(move |t| c.lock().push(format!("dock:{t}"))),
            scheduler: sched.clone(),
        });
        Harness { taskbar, calls, sched, cells }
    }

    fn tick(h: &Harness) {
        h.sched.fire();
        h.sched.clear_log();
    }

    #[test]
    fn debounces_a_burst_of_statuses_into_one_update_and_calls_the_os_only_for_what_changed() {
        let h = harness("darwin");
        h.taskbar.status("a", CellRuntime::new("working", None), None);
        h.taskbar.status("b", CellRuntime::new("working", None), None);
        h.taskbar.status("a", CellRuntime::new("waiting", Some("attention")), None);
        assert_eq!(h.sched.timers(), vec![(TASKBAR_DEBOUNCE_MS, false)]);
        assert!(h.calls.lock().is_empty());
        tick(&h);
        assert_eq!(*h.calls.lock(), vec!["dock:1"]);
        h.taskbar.status("a", CellRuntime::new("waiting", Some("attention")), None);
        assert!(h.sched.timers().is_empty());
        h.taskbar.status("b", CellRuntime::new("waiting", Some("done")), None);
        h.taskbar.status("b", CellRuntime::new("working", None), None);
        tick(&h);
        assert_eq!(h.calls.lock().len(), 1);
    }

    #[test]
    fn forgets_the_statuses_of_a_reloaded_window_follows_mutes_and_settings_and_reapplies_on_demand() {
        let h = harness("darwin");
        h.taskbar.status("a", CellRuntime::new("waiting", Some("attention")), Some("w1"));
        h.taskbar.status("b", CellRuntime::new("waiting", Some("attention")), Some("main"));
        tick(&h);
        assert_eq!(*h.calls.lock(), vec!["dock:2"]);
        h.calls.lock().clear();
        h.taskbar.forget_window("w1");
        tick(&h);
        assert_eq!(*h.calls.lock(), vec!["dock:1"]);
        h.calls.lock().clear();
        h.cells.lock()[1] = cell("b", true, true);
        h.taskbar.invalidate();
        tick(&h);
        assert_eq!(*h.calls.lock(), vec!["dock:"]);
        h.calls.lock().clear();
        h.taskbar.reapply();
        assert_eq!(*h.calls.lock(), vec!["dock:"]);
    }

    #[test]
    fn windows_never_touches_the_os() {
        let h = harness("win32");
        h.taskbar.status("a", CellRuntime::new("waiting", Some("attention")), None);
        tick(&h);
        assert!(h.calls.lock().is_empty());
        assert_eq!(h.taskbar.view(), "");
    }

    #[test]
    fn stops_after_dispose() {
        let h = harness("darwin");
        h.taskbar.dispose();
        h.taskbar.status("a", CellRuntime::new("waiting", Some("attention")), None);
        tick(&h);
        assert!(h.calls.lock().is_empty());
    }

    #[test]
    fn flush_runs_a_pending_update_now() {
        let h = harness("darwin");
        h.taskbar.status("a", CellRuntime::new("waiting", Some("attention")), None);
        h.taskbar.flush();
        assert_eq!(*h.calls.lock(), vec!["dock:1"]);
        assert_eq!(h.sched.pending(), 0);
    }
}
