//! test/host-router.test.ts on the 1.2.0 design: 1.1.4's HostRouter sent each call to the backend (node-pty or SSH) that owned
//! the id and fanned killAll out to both. In 1.2.0 one PtyEngine holds both kinds (ptys and P5's external terminals, the SSH
//! shell cells) and sends input, sizes and kills to the source of the id; kill_all ends every terminal of both kinds and
//! waits for all of them within one deadline, also when one of them never ends.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::json;
use unimux_pty::engine::{ExternalTerm, PtyEngine};
use unimux_pty::manager::{DoneFlag, KillWait};

/// An external terminal that records the calls that reach it; its kill ends it after `end_after` (None: never).
struct Source {
    calls: Mutex<Vec<String>>,
    done: Arc<DoneFlag>,
    end_after: Option<Duration>,
}

impl Source {
    fn new(end_after: Option<Duration>) -> Arc<Self> {
        Arc::new(Self { calls: Mutex::new(Vec::new()), done: DoneFlag::new(), end_after })
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().clone()
    }
}

impl ExternalTerm for Source {
    fn write(&self, data: &[u8]) {
        self.calls.lock().push(format!("write {}", String::from_utf8_lossy(data)));
    }
    fn resize(&self, cols: u16, rows: u16) {
        self.calls.lock().push(format!("resize {cols}x{rows}"));
    }
    fn pause(&self) {
        self.calls.lock().push("pause".into());
    }
    fn resume(&self) {
        self.calls.lock().push("resume".into());
    }
    fn kill(&self) -> KillWait {
        self.calls.lock().push("kill".into());
        if let Some(after) = self.end_after {
            let done = self.done.clone();
            std::thread::spawn(move || {
                std::thread::sleep(after);
                done.set();
            });
        }
        KillWait::flag(self.done.clone())
    }
}

#[test]
fn sends_every_call_to_the_terminal_that_owns_the_id_and_unknown_ids_resolve() {
    let engine = PtyEngine::new();
    let s = Source::new(Some(Duration::ZERO));
    let other = Source::new(Some(Duration::ZERO));
    let _s = engine.open_external("s", 80, 24, s.clone());
    let _o = engine.open_external("o", 80, 24, other.clone());
    engine.write("s", b"ls");
    engine.resize("s", 90, 30);
    // The renderer's messages reach the terminal its window owns; another window speaks only for its own terminals.
    engine.post("main", &json!({ "t": "write", "id": "s", "data": "pwd" }));
    engine.post("detached-1", &json!({ "t": "write", "id": "s", "data": "foreign" }));
    engine.post("main", &json!({ "t": "resize", "id": "o", "cols": 100, "rows": 40 }));
    // Calls for a terminal that does not exist go nowhere (a size is kept for its spawn).
    engine.write("p", b"x");
    engine.resize("p", 120, 40);
    assert_eq!(s.calls(), ["write ls", "resize 90x30", "write pwd"]);
    assert_eq!(other.calls(), ["resize 100x40"]);
    assert!(engine.kill("s").wait(Duration::from_secs(5)));
    assert_eq!(s.calls().last().map(String::as_str), Some("kill"));
    assert!(!engine.has("s") && engine.has("o"));
    // Unknown ids resolve at once; a killed terminal hears nothing more.
    assert!(engine.kill("nobody").wait(Duration::ZERO));
    engine.write("s", b"late");
    assert_eq!(s.calls().len(), 4);
    assert!(engine.kill_all(Duration::from_secs(5)));
    assert_eq!(other.calls().last().map(String::as_str), Some("kill"));
    assert!(engine.ids().is_empty());
}

#[test]
fn kill_all_waits_for_every_terminal_even_when_one_never_ends() {
    let engine = PtyEngine::new();
    let stuck = Source::new(None);
    let slow = Source::new(Some(Duration::from_millis(80)));
    let _a = engine.open_external("stuck", 80, 24, stuck.clone());
    let _b = engine.open_external("slow", 80, 24, slow.clone());
    let started = Instant::now();
    assert!(!engine.kill_all(Duration::from_millis(400)), "one terminal never ended");
    assert!(started.elapsed() >= Duration::from_millis(350), "{:?}", started.elapsed());
    // The other one was killed too and its end was waited for.
    assert_eq!(stuck.calls(), ["kill"]);
    assert_eq!(slow.calls(), ["kill"]);
    assert!(slow.done.is_set());
    assert!(engine.ids().is_empty());
}
