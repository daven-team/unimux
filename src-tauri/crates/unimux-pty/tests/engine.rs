//! P2 acceptance (cargo half) on real terminals: the output engine between PtyManager and the windows. Replay at the
//! recorded sizes on attach (also an early size taken at spawn), FlowGate pause and resume through byte acks with the
//! unacked bytes bounded, output before the exit frame, routing to a detached window, the in-flight cap of a gated
//! transport, and (Windows) the host-side DA1 answer while no window is attached.

#[cfg(windows)]
mod common;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::json;
use unimux_pty::batch::{MAX_IN_FLIGHT_SMALL, Transport};
use unimux_pty::engine::PtyEngine;
use unimux_pty::flow::{FLUSH_NOW_BYTES, HIGH_WATER};
use unimux_pty::frame::{self, KIND_DATA, KIND_EXIT, KIND_REPLAY, KIND_RESET};
use unimux_pty::manager::SpawnRequest;
use unimux_pty::shell::{Launch, ShellKind};

#[cfg(windows)]
fn init() {
    let dir = common::bundled_dir().expect("src-tauri/resources/conpty/x64");
    unimux_pty::conpty::ConptyApi::set_resource_dir(dir);
}

#[cfg(unix)]
fn init() {}

#[derive(Debug, Clone)]
#[allow(dead_code)]
enum Got {
    Data(String, Vec<u8>),
    Exit(String, i32),
    Replay(String, Vec<u8>, serde_json::Value),
    Reset(String),
}

#[derive(Default)]
struct Log {
    got: Vec<Got>,
    posts: u64,
}

/// A window's page: decodes what it is posted; a bound one answers DA1 like xterm.js, and a gated bound one releases
/// every message after the delay.
struct Page {
    log: Mutex<Log>,
    cv: Condvar,
    gated: bool,
    release: Mutex<Option<(PtyEngine, String, Duration)>>,
}

impl Page {
    fn new(gated: bool) -> Arc<Self> {
        Arc::new(Self { log: Mutex::new(Log::default()), cv: Condvar::new(), gated, release: Mutex::new(None) })
    }

    fn releasing(self: &Arc<Self>, engine: &PtyEngine, label: &str, delay: Duration) -> Arc<Self> {
        *self.release.lock() = Some((engine.clone(), label.to_string(), delay));
        self.clone()
    }

    fn wait(&self, timeout: Duration, mut f: impl FnMut(&Log) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut log = self.log.lock();
        while !f(&log) {
            if self.cv.wait_until(&mut log, deadline).timed_out() {
                return f(&log);
            }
        }
        true
    }

    fn data_of(&self, id: &str) -> Vec<u8> {
        bytes_in(&self.log.lock(), id)
    }
}

/// The data bytes of terminal `id` in a log (inside `Page::wait`, which holds the log's lock).
fn bytes_in(log: &Log, id: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for g in &log.got {
        if let Got::Data(i, d) = g
            && i == id
        {
            out.extend_from_slice(d);
        }
    }
    out
}

impl Transport for Page {
    fn post(&self, seq: u64, bytes: Vec<u8>) -> bool {
        let mut asked = Vec::new();
        {
            let mut log = self.log.lock();
            log.posts += 1;
            for f in frame::decode(&bytes).expect("well-formed message") {
                if f.kind == KIND_DATA && f.payload.windows(3).any(|w| w == b"\x1b[c") {
                    asked.push(f.id.to_string());
                }
                log.got.push(match f.kind {
                    KIND_DATA => Got::Data(f.id.to_string(), f.payload.to_vec()),
                    KIND_EXIT => Got::Exit(f.id.to_string(), i32::from_le_bytes(f.payload.try_into().unwrap())),
                    KIND_REPLAY => {
                        let n = u32::from_le_bytes(f.payload[..4].try_into().unwrap()) as usize;
                        let header: serde_json::Value = serde_json::from_slice(&f.payload[4..4 + n]).unwrap();
                        Got::Replay(f.id.to_string(), f.payload[4 + n..].to_vec(), header)
                    }
                    KIND_RESET => Got::Reset(f.id.to_string()),
                    k => panic!("unexpected frame kind {k}"),
                });
            }
        }
        self.cv.notify_all();
        if let Some((engine, label, delay)) = self.release.lock().clone() {
            // A shown terminal's DA1 is answered by the page's xterm.js, as a terminal reply.
            for id in asked {
                engine.post(&label, &json!({ "t": "write", "id": id, "data": "\u{1b}[?1;2c", "reply": true }));
            }
            if self.gated {
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    engine.post(&label, &json!({ "t": "released", "upto": seq }));
                });
            }
        }
        true
    }
    fn gated(&self) -> bool {
        self.gated
    }
    fn name(&self) -> &'static str {
        "test"
    }
}

fn flood_req(id: &str, dir: &std::path::Path, args: &[&str]) -> SpawnRequest {
    let mut r = SpawnRequest::new(id, dir, ShellKind::Cmd);
    r.launch = Some(Launch::new(env!("CARGO_BIN_EXE_unimux-pty-flood"), args));
    r
}

fn stats_of(engine: &PtyEngine, id: &str) -> serde_json::Value {
    engine.stats_json()["terminals"][id].clone()
}

#[test]
fn a_window_that_attaches_gets_the_replay_at_the_recorded_sizes() {
    init();
    let dir = tempfile::tempdir().unwrap();
    let engine = PtyEngine::new();
    // A size the renderer reported before the spawn (its port is faster than the spawn request).
    engine.post("main", &json!({ "t": "resize", "id": "r", "cols": 90, "rows": 20 }));
    let started = Instant::now();
    engine.spawn(flood_req("r", dir.path(), &["4000", "0"])).unwrap();
    // No window yet: nothing is delivered, the tail fills.
    let deadline = Instant::now() + Duration::from_secs(20);
    while engine.replay("r").is_none_or(|(d, _)| d.len() < 500) {
        assert!(Instant::now() < deadline, "no output without a window");
        std::thread::sleep(Duration::from_millis(20));
    }
    let first_output = started.elapsed();
    engine.resize("r", 120, 30);
    std::thread::sleep(Duration::from_millis(400));
    let page = Page::new(false);
    engine.attach("main", page.clone());
    assert!(page.wait(Duration::from_secs(5), |l| l.got.iter().any(|g| matches!(g, Got::Replay(..)))));
    let replay = page.log.lock().got.iter().find_map(|g| match g {
        Got::Replay(id, data, header) => Some((id.clone(), data.clone(), header.clone())),
        _ => None,
    });
    let (id, data, header) = replay.unwrap();
    assert_eq!(id, "r");
    let sizes = header["sizes"].as_array().unwrap();
    assert_eq!(sizes[0], json!({ "at": 0, "cols": 90, "rows": 20 }), "{header}");
    let last = sizes.last().unwrap();
    assert_eq!((last["cols"].as_u64(), last["rows"].as_u64()), (Some(120), Some(30)), "{header}");
    let at = last["at"].as_u64().unwrap() as usize;
    assert!(at > 0 && at <= data.len(), "{at} of {}", data.len());
    // Live output follows the replay.
    assert!(page.wait(Duration::from_secs(10), |l| l.got.iter().any(|g| matches!(g, Got::Data(..)))));
    if cfg!(windows) {
        // OpenConsole held the start for the DA1 answer: the engine gave it at once (1.1.4 without a renderer: 3 s).
        assert_eq!(engine.stats_json()["da1Answers"], 1);
        assert!(first_output < Duration::from_millis(2500), "first output after {first_output:?}");
    }
    assert!(engine.kill_and_wait("r", Duration::from_secs(5)));
}

#[test]
fn byte_acks_pause_a_flood_at_the_high_watermark_and_resume_it() {
    init();
    let dir = tempfile::tempdir().unwrap();
    let engine = PtyEngine::new();
    let page = Page::new(true).releasing(&engine, "main", Duration::ZERO);
    engine.attach("main", page.clone());
    let total = 6_000_000;
    engine.spawn(flood_req("f", dir.path(), &["0", "0", &total.to_string()])).unwrap();
    // The page never acks: the reader is paused once a megabyte is unacknowledged.
    assert!(
        page.wait(Duration::from_secs(60), |_| stats_of(&engine, "f")["paused"] == true),
        "never paused: {}",
        engine.stats_json()
    );
    std::thread::sleep(Duration::from_millis(700));
    let held = page.data_of("f").len();
    std::thread::sleep(Duration::from_millis(700));
    let later = page.data_of("f").len();
    let bound = HIGH_WATER + FLUSH_NOW_BYTES + 128 * 1024;
    assert!(later - held < 64 * 1024, "still flowing while paused: {held} -> {later}");
    let unacked = stats_of(&engine, "f")["unacked"].as_u64().unwrap() as usize;
    assert!(unacked >= HIGH_WATER && unacked <= bound, "unacked {unacked}");
    // Acks of everything received: it flows again, to the end, and the exit comes after the output.
    let mut acked = 0usize;
    let deadline = Instant::now() + Duration::from_secs(240);
    let mut max_unacked = unacked;
    loop {
        let got = page.data_of("f").len();
        if got > acked {
            engine.post("main", &json!({ "t": "ack", "id": "f", "chars": got - acked }));
            acked = got;
        }
        if let Some(u) = stats_of(&engine, "f")["unacked"].as_u64() {
            max_unacked = max_unacked.max(u as usize);
        }
        if page.log.lock().got.iter().any(|g| matches!(g, Got::Exit(..))) {
            break;
        }
        assert!(Instant::now() < deadline, "flood did not finish: {} bytes", got);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(max_unacked <= bound, "unacked bytes reached {max_unacked}");
    let text = String::from_utf8_lossy(&page.data_of("f")).to_string();
    assert!(text.contains("FLOOD-DONE"), "no end marker in {} bytes", text.len());
    let log = page.log.lock();
    let exit_at = log.got.iter().position(|g| matches!(g, Got::Exit(..))).unwrap();
    assert!(log.got[exit_at + 1..].iter().all(|g| !matches!(g, Got::Data(..))), "output after the exit frame");
    assert!(matches!(log.got[exit_at], Got::Exit(_, 0)));
}

#[test]
fn a_terminal_routed_to_a_detached_window_goes_there_only() {
    init();
    let dir = tempfile::tempdir().unwrap();
    let engine = PtyEngine::new();
    let main = Page::new(false).releasing(&engine, "main", Duration::ZERO);
    let detached = Page::new(false).releasing(&engine, "detached-x", Duration::ZERO);
    engine.attach("main", main.clone());
    engine.attach("detached-x", detached.clone());
    engine.spawn(flood_req("a", dir.path(), &["20000", "0"])).unwrap();
    engine.spawn(flood_req("b", dir.path(), &["20000", "0"])).unwrap();
    assert!(main.wait(Duration::from_secs(20), |l| !bytes_in(l, "b").is_empty() && !bytes_in(l, "a").is_empty()));
    engine.route("b", Some("detached-x"));
    assert!(detached.wait(Duration::from_secs(5), |l| l.got.iter().any(|g| matches!(g, Got::Replay(id, ..) if id == "b"))));
    let main_b = main.data_of("b").len();
    assert!(detached.wait(Duration::from_secs(10), |l| bytes_in(l, "b").len() > 2000));
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(main.data_of("b").len(), main_b, "main still got b's output");
    assert!(detached.data_of("a").is_empty());
    // Main may no longer speak for b (its acks, writes and resizes are ignored).
    engine.post("main", &json!({ "t": "resize", "id": "b", "cols": 33, "rows": 7 }));
    engine.post("detached-x", &json!({ "t": "resize", "id": "b", "cols": 44, "rows": 9 }));
    std::thread::sleep(Duration::from_millis(100));
    let (_, sizes) = engine.replay("b").unwrap();
    assert!(sizes.iter().all(|s| s.cols != 33));
    assert_eq!(sizes.last().map(|s| (s.cols, s.rows)), Some((44, 9)));
    engine.kill_all(Duration::from_secs(5));
}

#[test]
fn a_gated_window_never_has_more_than_the_cap_in_flight() {
    init();
    let dir = tempfile::tempdir().unwrap();
    let engine = PtyEngine::new();
    // A slow page: each message is released 30 ms after it arrived.
    let page = Page::new(true).releasing(&engine, "main", Duration::from_millis(30));
    engine.attach("main", page.clone());
    let ids: Vec<String> = (0..4).map(|i| format!("g{i}")).collect();
    for id in &ids {
        engine.spawn(flood_req(id, dir.path(), &["1000000", "0"])).unwrap();
    }
    let mut acked: HashMap<String, usize> = HashMap::new();
    let end = Instant::now() + Duration::from_secs(4);
    while Instant::now() < end {
        for id in &ids {
            let got = page.data_of(id).len();
            let a = acked.entry(id.clone()).or_default();
            if got > *a {
                engine.post("main", &json!({ "t": "ack", "id": id, "chars": got - *a }));
                *a = got;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let stats = engine.stats_json();
    let w = &stats["windows"]["main"];
    assert!(w["maxInFlight"].as_u64().unwrap() <= MAX_IN_FLIGHT_SMALL, "{w}");
    assert!(w["posts"].as_u64().unwrap() > 10, "{w}");
    // Fewer messages than frames: batches grew while the page was busy.
    assert!(w["frames"].as_u64().unwrap() > w["posts"].as_u64().unwrap(), "{w}");
    engine.kill_all(Duration::from_secs(5));
}

#[test]
fn a_reload_replaces_the_window_and_flow_control_follows_the_main_window() {
    init();
    let dir = tempfile::tempdir().unwrap();
    let engine = PtyEngine::new();
    assert_eq!(engine.stats_json()["flowControl"], false);
    let first = Page::new(false).releasing(&engine, "main", Duration::ZERO);
    engine.attach("main", first.clone());
    assert_eq!(engine.stats_json()["flowControl"], true);
    engine.spawn(flood_req("z", dir.path(), &["20000", "0"])).unwrap();
    assert!(first.wait(Duration::from_secs(20), |l| bytes_in(l, "z").len() > 1000));
    let second = Page::new(false).releasing(&engine, "main", Duration::ZERO);
    engine.attach("main", second.clone());
    assert!(second.wait(Duration::from_secs(5), |l| matches!(l.got.first(), Some(Got::Replay(..)))));
    let before = first.data_of("z").len();
    std::thread::sleep(Duration::from_millis(300));
    assert!(first.data_of("z").len() <= before + 4096, "the old page still gets output");
    assert!(second.wait(Duration::from_secs(5), |l| !bytes_in(l, "z").is_empty()));
    engine.detach("main");
    assert_eq!(engine.stats_json()["flowControl"], false);
    engine.kill_all(Duration::from_secs(5));
}

/// A resize posted while the spawn is still running (PtyManager's slot exists, its pty not yet; a loaded machine) reaches
/// the pty, and the replay records the size the pty has.
#[test]
fn a_resize_during_the_spawn_reaches_the_pty() {
    init();
    let dir = tempfile::tempdir().unwrap();
    let engine = PtyEngine::new();
    engine.manager().set_spawn_hold(Some(Duration::from_millis(800)));
    let mut req = SpawnRequest::new("rs", dir.path(), if cfg!(windows) { ShellKind::Cmd } else { ShellKind::Bash });
    req.env = std::env::vars().collect();
    let spawner = {
        let engine = engine.clone();
        std::thread::spawn(move || engine.spawn(req))
    };
    std::thread::sleep(Duration::from_millis(300));
    engine.post("main", &json!({ "t": "resize", "id": "rs", "cols": 100, "rows": 40 }));
    spawner.join().unwrap().unwrap();
    engine.manager().set_spawn_hold(None);
    let text = |engine: &PtyEngine| String::from_utf8_lossy(&engine.replay("rs").unwrap().0).replace(' ', "");
    let deadline = Instant::now() + Duration::from_secs(30);
    while text(&engine).is_empty() {
        assert!(Instant::now() < deadline, "no prompt");
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(300));
    engine.write("rs", if cfg!(windows) { b"mode con\r" } else { b"stty size\r" });
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let t = text(&engine);
        let ok = if cfg!(windows) { t.contains("Lines:40") && t.contains("Columns:100") } else { t.contains("40100") };
        if ok {
            break;
        }
        assert!(Instant::now() < deadline, "the pty did not get 100 x 40: {t:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
    let (_, sizes) = engine.replay("rs").unwrap();
    assert_eq!(sizes.last().map(|s| (s.cols, s.rows)), Some((100, 40)));
    assert!(engine.kill_and_wait("rs", Duration::from_secs(5)));
}

/// A spawn under an id the window shows starts with a reset frame (the renderer's UTF-8 decoder of the id starts clean),
/// queued before any output of the new terminal.
#[test]
fn a_respawn_starts_with_a_reset_frame() {
    init();
    let dir = tempfile::tempdir().unwrap();
    let engine = PtyEngine::new();
    let page = Page::new(false).releasing(&engine, "main", Duration::ZERO);
    engine.attach("main", page.clone());
    engine.spawn(flood_req("k", dir.path(), &["20000", "0"])).unwrap();
    assert!(page.wait(Duration::from_secs(20), |l| bytes_in(l, "k").len() > 500));
    engine.spawn(flood_req("k", dir.path(), &["20000", "0"])).unwrap();
    assert!(page.wait(Duration::from_secs(20), |l| {
        let second = l.got.iter().rposition(|g| matches!(g, Got::Reset(id) if id == "k"));
        second.is_some_and(|at| l.got[at + 1..].iter().any(|g| matches!(g, Got::Data(id, _) if id == "k")))
    }));
    let log = page.log.lock();
    let resets: Vec<usize> =
        log.got.iter().enumerate().filter(|(_, g)| matches!(g, Got::Reset(id) if id == "k")).map(|(i, _)| i).collect();
    assert_eq!(resets.len(), 2, "{resets:?}");
    // The first terminal's reset comes before any of its output.
    let first_data = log.got.iter().position(|g| matches!(g, Got::Data(id, _) if id == "k")).unwrap();
    assert!(resets[0] < first_data);
    drop(log);
    engine.kill_all(Duration::from_secs(5));
}
