//! P3 (cargo half) on real terminals: the pty service's events (spawned, exit after the output, tap, interrupt, spawn
//! errors), kill with an answer, kill all, and the crash flow of the 1.1.4 Pty Host (terminals forgotten without exit
//! reports, restart with the commands sent meanwhile, fatal after more than 5 crashes, restart after fatal).

#[cfg(windows)]
mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::json;
use unimux_pty::engine::PtyEngine;
use unimux_pty::manager::SpawnRequest;
use unimux_pty::service::{HostEvent, PtyService};
use unimux_pty::shell::{Launch, ShellKind};
use unimux_pty::supervisor::CrashPolicy;

#[cfg(windows)]
fn init() {
    let dir = common::bundled_dir().expect("src-tauri/resources/conpty/x64");
    unimux_pty::conpty::ConptyApi::set_resource_dir(dir);
}

#[cfg(unix)]
fn init() {}

#[derive(Default)]
struct Events {
    list: Mutex<Vec<HostEvent>>,
    cv: Condvar,
}

impl Events {
    fn wait_for(&self, what: &str, f: impl Fn(&[HostEvent]) -> bool) -> Vec<HostEvent> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut list = self.list.lock();
        while !f(&list) {
            assert!(!self.cv.wait_until(&mut list, deadline).timed_out(), "timed out waiting for {what}: {:?}", *list);
        }
        list.clone()
    }
}

fn service(policy: CrashPolicy) -> (PtyService, Arc<Events>) {
    init();
    let svc = PtyService::with_policy(PtyEngine::new(), policy);
    let events = Arc::new(Events::default());
    let e = events.clone();
    svc.set_listener(move |ev| {
        // Taps come in many pieces; tests only look at whether some arrived.
        e.list.lock().push(ev);
        e.cv.notify_all();
    });
    (svc, events)
}

fn quick() -> CrashPolicy {
    CrashPolicy { window: Duration::from_secs(60), max_crashes: 5, base_delay: Duration::from_millis(10) }
}

fn flood(id: &str, dir: &std::path::Path, args: &[&str]) -> SpawnRequest {
    let mut r = SpawnRequest::new(id, dir, ShellKind::Cmd);
    r.launch = Some(Launch::new(env!("CARGO_BIN_EXE_unimux-pty-flood"), args));
    r
}

fn spawned(list: &[HostEvent], id: &str) -> bool {
    list.iter().any(|e| matches!(e, HostEvent::Spawned { id: i, .. } if i == id))
}

fn exited(list: &[HostEvent], id: &str) -> bool {
    list.iter().any(|e| matches!(e, HostEvent::Exit { id: i, .. } if i == id))
}

fn tapped_text(list: &[HostEvent], id: &str) -> String {
    list.iter()
        .filter_map(|e| match e {
            HostEvent::Tap { id: i, data } if i == id => Some(data.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_terminal_reports_spawned_then_its_exit_and_a_tapped_one_its_text() {
    let dir = tempfile::tempdir().unwrap();
    let (svc, events) = service(CrashPolicy::default());
    assert!(svc.spawn(flood("install:a", dir.path(), &["0", "0", "3000"]), true));
    let list = events.wait_for("exit", |l| exited(l, "install:a"));
    let first_spawned = list.iter().position(|e| matches!(e, HostEvent::Spawned { id, pid } if id == "install:a" && *pid > 0));
    let first_exit = list.iter().position(|e| matches!(e, HostEvent::Exit { id, .. } if id == "install:a"));
    assert!(first_spawned.unwrap() < first_exit.unwrap(), "{list:?}");
    assert!(tapped_text(&list, "install:a").contains("FLOOD-DONE"), "{list:?}");
    // The exit removed the terminal.
    assert!(svc.ids().is_empty());
    svc.stop();
}

#[test]
fn an_untapped_terminal_sends_no_tap_and_a_kill_reports_no_exit() {
    let dir = tempfile::tempdir().unwrap();
    let (svc, events) = service(CrashPolicy::default());
    svc.spawn(flood("c1", dir.path(), &["2000", "0"]), false);
    events.wait_for("spawned", |l| spawned(l, "c1"));
    let done = svc.kill_and_wait("c1", Duration::from_secs(4)).expect("a host runs");
    assert!(done.recv_timeout(Duration::from_secs(6)).unwrap(), "the terminal ended within the wait");
    std::thread::sleep(Duration::from_millis(300));
    let list = events.list.lock().clone();
    assert!(!exited(&list, "c1"), "{list:?}");
    assert!(tapped_text(&list, "c1").is_empty());
    svc.stop();
}

#[test]
fn ctrl_c_typed_into_a_tapped_terminal_by_its_window_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let (svc, events) = service(CrashPolicy::default());
    svc.spawn(flood("install:i", dir.path(), &["2000", "0"]), true);
    svc.spawn(flood("plain", dir.path(), &["2000", "0"]), false);
    events.wait_for("spawned", |l| spawned(l, "install:i") && spawned(l, "plain"));
    // Another window does not own it; an untapped terminal never reports.
    svc.post("detached-x", &json!({ "t": "write", "id": "install:i", "data": "\u{3}" }));
    svc.post("main", &json!({ "t": "write", "id": "plain", "data": "\u{3}" }));
    svc.post("main", &json!({ "t": "write", "id": "install:i", "data": "a\u{3}" }));
    let list = events.wait_for("interrupt", |l| l.iter().any(|e| matches!(e, HostEvent::Interrupt { .. })));
    let interrupts: Vec<&HostEvent> = list.iter().filter(|e| matches!(e, HostEvent::Interrupt { .. })).collect();
    assert_eq!(interrupts, [&HostEvent::Interrupt { id: "install:i".into() }]);
    assert!(svc.kill_all(Duration::from_secs(3)));
    svc.stop();
}

#[cfg(windows)]
#[test]
fn a_spawn_in_a_missing_folder_reports_a_spawn_error() {
    let dir = tempfile::tempdir().unwrap();
    let (svc, events) = service(CrashPolicy::default());
    svc.spawn(flood("bad", &dir.path().join("missing"), &["0", "0", "10"]), true);
    let list = events.wait_for("spawnError", |l| l.iter().any(|e| matches!(e, HostEvent::SpawnError { .. })));
    assert!(matches!(&list[0], HostEvent::SpawnError { id, message } if id == "bad" && !message.is_empty()), "{list:?}");
    assert!(svc.ids().is_empty());
    svc.stop();
}

#[test]
fn a_crash_forgets_every_terminal_and_the_restarted_service_runs_what_was_sent_meanwhile() {
    let dir = tempfile::tempdir().unwrap();
    let policy = CrashPolicy { base_delay: Duration::from_millis(400), ..quick() };
    let (svc, events) = service(policy);
    svc.spawn(flood("a", dir.path(), &["2000", "0"]), false);
    svc.spawn(flood("b", dir.path(), &["2000", "0"]), true);
    events.wait_for("spawned", |l| spawned(l, "a") && spawned(l, "b"));
    assert!(svc.inject_panic("injected"));
    let list = events.wait_for("crashed", |l| l.iter().any(|e| matches!(e, HostEvent::Crashed { .. })));
    assert!(list.iter().any(|e| matches!(e, HostEvent::Crashed { message, count: 1 } if message == "injected")));
    assert!(svc.ids().is_empty(), "the terminals went with the crash");
    assert!(!svc.is_running());
    // killAndWait while no host runs answers at once; a spawn waits for the restart.
    assert!(svc.kill_and_wait("a", Duration::from_secs(1)).is_none());
    assert!(svc.spawn(flood("c", dir.path(), &["0", "0", "100"]), false));
    let list = events.wait_for("restart and c", |l| exited(l, "c"));
    let restarted = list.iter().position(|e| *e == HostEvent::Restarted).unwrap();
    let c = list.iter().position(|e| matches!(e, HostEvent::Spawned { id, .. } if id == "c")).unwrap();
    assert!(restarted < c);
    assert!(!exited(&list, "a") && !exited(&list, "b"), "killed by the crash: no exit reports {list:?}");
    svc.stop();
}

#[test]
fn a_crash_from_a_reader_thread_counts_like_one_on_the_actor() {
    let (svc, events) = service(quick());
    svc.inject_reader_crash("reader");
    events.wait_for("crashed", |l| l.iter().any(|e| matches!(e, HostEvent::Crashed { message, .. } if message == "reader")));
    events.wait_for("restarted", |l| l.contains(&HostEvent::Restarted));
    assert!(svc.is_running());
    svc.stop();
}

#[test]
fn more_than_five_crashes_are_fatal_until_the_user_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let (svc, events) = service(quick());
    for n in 1..=6 {
        // Each crash waits for the restart of the previous one (a command sent while restarting is kept, a panic too).
        events.wait_for("running", |l| l.iter().filter(|e| **e == HostEvent::Restarted).count() + 1 >= n);
        assert!(svc.inject_panic(&format!("crash {n}")));
    }
    let list = events.wait_for("fatal", |l| l.iter().any(|e| matches!(e, HostEvent::Fatal { .. })));
    assert!(list.iter().any(|e| matches!(e, HostEvent::Fatal { count: 6, .. })), "{list:?}");
    assert!(svc.is_fatal());
    assert!(!svc.spawn(flood("x", dir.path(), &["0", "0", "10"]), false), "a fatal service drops spawns");
    assert!(svc.kill_all(Duration::from_secs(1)), "nothing to wait for");
    svc.restart_after_fatal();
    events.wait_for("restart after fatal", |l| l.iter().filter(|e| **e == HostEvent::Restarted).count() >= 6);
    assert!(!svc.is_fatal());
    assert!(svc.spawn(flood("y", dir.path(), &["0", "0", "10"]), false));
    events.wait_for("y exit", |l| exited(l, "y"));
    svc.stop();
}

#[test]
fn kill_all_ends_every_terminal_and_answers() {
    let dir = tempfile::tempdir().unwrap();
    let (svc, events) = service(CrashPolicy::default());
    for i in 0..4 {
        svc.spawn(flood(&format!("k{i}"), dir.path(), &["2000", "0"]), false);
    }
    events.wait_for("spawned", |l| (0..4).all(|i| spawned(l, &format!("k{i}"))));
    let started = Instant::now();
    assert!(svc.kill_all(Duration::from_secs(3)));
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(svc.ids().is_empty());
    svc.stop();
}
