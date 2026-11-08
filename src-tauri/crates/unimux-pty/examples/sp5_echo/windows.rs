//! SP5: keystroke-to-echo latency at the pty layer (no renderer), the Rust side of scripts/sp5/echo-node-pty.mjs (same
//! method). cmd.exe in ConPTY, one character written, the time until that character comes back in the output (printable
//! bytes outside escape sequences, matched in order). Paces like scripts/perf-latency.mjs: "spaced" (one key every 120 ms)
//! and "burst" (runs of 6 keys 25 ms apart).
//!
//!   cargo run --release -p unimux-pty --example sp5_echo -- [keys=60] [mode=raw|plane] [batch_ms=16] [timer=1|0] [api=bundled|inbox]
//!
//! Prints one JSON line.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use unimux_pty::conpty::{ConptyApi, Pty, SpawnOptions, TimerResolution};
use unimux_pty::frame;
use unimux_pty::plane::{Plane, PlaneConfig};

#[derive(Default)]
struct Probe {
    all: Vec<u8>,
    /// 0 text, 1 after ESC, 2 in CSI, 3 in OSC / string
    vt: u8,
    queue: VecDeque<(u8, Instant)>,
    latencies: Vec<f64>,
}

impl Probe {
    fn feed(&mut self, d: &[u8]) {
        let now = Instant::now();
        if std::env::var_os("SP5_DEBUG").is_some() {
            let since = self.queue.front().map(|(_, t)| (now - *t).as_secs_f64() * 1000.0);
            eprintln!(
                "chunk {:?} pending={:?} since={since:?}",
                String::from_utf8_lossy(d),
                self.queue.iter().map(|(c, _)| *c as char).collect::<String>()
            );
        }
        self.all.extend_from_slice(d);
        for &b in d {
            match self.vt {
                0 if b == 0x1b => self.vt = 1,
                0 => {
                    if self.queue.front().is_some_and(|(c, _)| *c == b) {
                        let (_, t0) = self.queue.pop_front().unwrap();
                        self.latencies.push((now - t0).as_secs_f64() * 1000.0);
                    }
                }
                1 => {
                    self.vt = if b == b'[' {
                        2
                    } else if b == b']' || b == b'P' {
                        3
                    } else {
                        0
                    }
                }
                2 if (0x40..=0x7e).contains(&b) => self.vt = 0,
                3 if b == 0x07 => self.vt = 0,
                3 if b == 0x1b => self.vt = 1,
                _ => {}
            }
        }
    }
}

/// Sends input to the terminal under test.
type Writer = Box<dyn Fn(&[u8])>;

fn bundled_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("UNIMUX_CONPTY_DIR") {
        return d.into();
    }
    // conpty.dll 1.23 + OpenConsole.exe, committed (1.1.4 took them from node-pty).
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/conpty/x64")
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

fn wait(probe: &Mutex<Probe>, timeout: Duration, pred: impl Fn(&Probe) -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if pred(&probe.lock()) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    pred(&probe.lock())
}

pub fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let keys: usize = a.first().and_then(|s| s.parse().ok()).unwrap_or(60);
    let mode = a.get(1).cloned().unwrap_or_else(|| "raw".into());
    let batch_ms: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(16);
    let timer = a.get(3).map(|s| s != "0").unwrap_or(true);
    let api_name = a.get(4).cloned().unwrap_or_else(|| "bundled".into());
    let api: &'static ConptyApi = Box::leak(Box::new(
        ConptyApi::load(if api_name == "inbox" { None } else { Some(bundled_dir()) }.as_deref()).expect("conpty"),
    ));

    let probe = Arc::new(Mutex::new(Probe::default()));
    let mut opts = SpawnOptions::new("cmd.exe", &[]);
    opts.cols = 120;
    opts.rows = 30;

    let _timer = if mode == "raw" && timer { Some(TimerResolution::acquire()) } else { None };
    let (write, _keep): (Writer, Box<dyn std::any::Any>) = if mode == "plane" {
        let plane = Plane::new(api, PlaneConfig { batch_ms, focus_ms: 4, timer_1ms: timer, flow: true });
        let (sink_probe, acker) = (probe.clone(), Arc::downgrade(&plane));
        plane.attach(Arc::new(move |msg: Vec<u8>| {
            for f in frame::decode(&msg).unwrap_or_default() {
                if f.kind == frame::KIND_DATA {
                    sink_probe.lock().feed(f.payload);
                    if let Some(p) = acker.upgrade() {
                        p.ack(f.id, f.payload.len());
                    }
                }
            }
            true
        }));
        plane.spawn("echo", &opts).expect("spawn");
        plane.focus(Some("echo"));
        let p = plane.clone();
        (Box::new(move |d: &[u8]| p.write("echo", d)), Box::new(plane))
    } else {
        let cb = probe.clone();
        let pty = Pty::spawn(api, &opts, Box::new(move |d| cb.lock().feed(d)), Box::new(|_| {})).expect("spawn");
        let w = pty.writer().unwrap();
        (Box::new(move |d: &[u8]| w.write(d)), Box::new(pty))
    };

    // Answer DA1 like xterm (OpenConsole 1.23 waits for it).
    if wait(&probe, Duration::from_secs(4), |p| p.all.windows(3).any(|w| w == b"\x1b[c")) {
        write(b"\x1b[?1;2c");
    }
    assert!(wait(&probe, Duration::from_secs(10), |p| p.all.contains(&b'>')), "no prompt");
    std::thread::sleep(Duration::from_millis(1500));

    let letters = b"abcdefghijklmnopqrstuvwxyz";
    let mut i = 0usize;
    let mut run = |burst: usize| -> Vec<f64> {
        probe.lock().latencies.clear();
        while probe.lock().latencies.len() < keys {
            for k in 0..burst {
                let c = letters[i % letters.len()];
                i += 1;
                probe.lock().queue.push_back((c, Instant::now()));
                write(&[c]);
                if k + 1 < burst {
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
            assert!(wait(&probe, Duration::from_secs(5), |p| p.queue.is_empty()), "echo missing");
            std::thread::sleep(Duration::from_millis(60));
            write(&vec![0x08; burst]);
            std::thread::sleep(Duration::from_millis(120));
        }
        let mut l = probe.lock().latencies.clone();
        l.truncate(keys);
        l
    };
    let mut spaced = run(1);
    let mut burst = run(6);
    println!(
        "{{\"impl\":\"rust\",\"mode\":\"{mode}\",\"api\":\"{api_name}\",\"batchMs\":{batch_ms},\"timer1ms\":{timer},\"spaced\":{{\"p50\":{:.3},\"p95\":{:.3}}},\"burst\":{{\"p50\":{:.3},\"p95\":{:.3}}}}}",
        pct(&mut spaced, 0.5),
        pct(&mut spaced, 0.95),
        pct(&mut burst, 0.5),
        pct(&mut burst, 0.95)
    );
}
