//! SP5 data plane over the bundled conpty.dll: a respawn under the same id gets no stale frame of the old process, and
//! terminals that end at once never stay in the plane. Windows only.
#![cfg(windows)]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use common::*;
use parking_lot::Mutex;
use unimux_pty::conpty::SpawnOptions;
use unimux_pty::frame::{self, KIND_DATA, KIND_EXIT};
use unimux_pty::plane::{Plane, PlaneConfig};

/// (kind, id, payload, phase: 0 before the respawn, 1 while it runs, 2 after it returned)
type Frames = Arc<Mutex<Vec<(u8, String, Vec<u8>, u8)>>>;

fn plane() -> (Arc<Plane>, Frames, Arc<AtomicU8>) {
    // No batching: the sink runs inside the push, so the phase of a frame is exact.
    let plane = Plane::new(bundled(), PlaneConfig { batch_ms: 0, focus_ms: 0, timer_1ms: true, flow: false });
    let frames: Frames = Arc::default();
    let phase = Arc::new(AtomicU8::new(0));
    let (f, p) = (frames.clone(), phase.clone());
    plane.attach(Arc::new(move |msg: Vec<u8>| {
        let at = p.load(Ordering::SeqCst);
        let mut f = f.lock();
        for fr in frame::decode(&msg).expect("well-formed message") {
            f.push((fr.kind, fr.id.to_string(), fr.payload.to_vec(), at));
        }
        true
    }));
    (plane, frames, phase)
}

fn wait_until(timeout: Duration, mut pred: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    pred()
}

fn exit_codes(frames: &Frames, min_phase: u8) -> Vec<i32> {
    frames
        .lock()
        .iter()
        .filter(|x| x.3 >= min_phase && x.0 == KIND_EXIT)
        .map(|x| i32::from_le_bytes(x.2[..4].try_into().unwrap()))
        .collect()
}

#[test]
fn respawn_under_the_same_id_gets_no_stale_frames() {
    for round in 0..5 {
        let (plane, frames, phase) = plane();
        // The old terminal floods (it never ends by itself), so it has output in flight when it is replaced.
        let mut old = SpawnOptions::new(env!("CARGO_BIN_EXE_unimux-pty-flood"), &[]);
        old.cols = 120;
        old.rows = 30;
        plane.spawn("a", &old).expect("spawn old");
        assert!(
            wait_until(Duration::from_secs(10), || frames.lock().iter().any(|f| f.0 == KIND_DATA && f.2.len() > 100)),
            "round {round}: no output from the old terminal"
        );
        // From here on an exit of the old 'a' is stale: the renderer already asked for the new one.
        phase.store(1, Ordering::SeqCst);
        plane.spawn("a", &cmd(&["/d", "/c", "ping -n 4 127.0.0.1 >nul"])).expect("spawn new");
        phase.store(2, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(exit_codes(&frames, 1), Vec::<i32>::new(), "round {round}: an exit frame for 'a' while the new 'a' runs");
        let stale_data =
            frames.lock().iter().filter(|x| x.3 == 2 && x.0 == KIND_DATA && x.2.windows(5).any(|w| w == b"lorem")).count();
        assert_eq!(stale_data, 0, "round {round}: flood output of the old 'a' after the respawn");
        assert_eq!(plane.count(), 1, "round {round}");
        // The new terminal's own exit still arrives, and then the plane is empty.
        assert!(
            wait_until(Duration::from_secs(20), || !exit_codes(&frames, 1).is_empty()),
            "round {round}: the new terminal's exit never came"
        );
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(exit_codes(&frames, 1), vec![0], "round {round}");
        assert!(wait_until(Duration::from_secs(2), || plane.count() == 0), "round {round}: entry left behind");
    }
}

#[test]
fn terminals_that_end_at_once_never_stay_in_the_plane() {
    let (plane, frames, _) = plane();
    let n = 40;
    for i in 0..n {
        plane.spawn(&format!("t{i}"), &cmd(&["/d", "/c", "exit 3"])).expect("spawn");
    }
    assert!(wait_until(Duration::from_secs(30), || exit_codes(&frames, 0).len() == n), "not all exits reported");
    assert!(wait_until(Duration::from_secs(2), || plane.count() == 0), "{} entries left behind", plane.count());
    assert!(exit_codes(&frames, 0).iter().all(|c| *c == 3));
}
