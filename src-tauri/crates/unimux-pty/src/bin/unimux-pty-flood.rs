//! Test helper of SP5 / P1 (never bundled): prints colored terminal lines, like an agent streaming a diff.
//!
//!   unimux-pty-flood [bytes per second, 0 = as fast as possible] [seconds, 0 = forever]
//!
//! Lines are about 100 bytes: a counter, SGR colors and text, CRLF. Paced in 10 ms steps.

use std::io::Write;
use std::time::{Duration, Instant};

fn main() {
    let mut args = std::env::args().skip(1);
    let rate: u64 = args.next().and_then(|a| a.parse().ok()).unwrap_or(0);
    let seconds: u64 = args.next().and_then(|a| a.parse().ok()).unwrap_or(0);
    let colors = [31, 32, 33, 34, 35, 36, 90];
    let started = Instant::now();
    let mut stdout = std::io::stdout().lock();
    let mut n: u64 = 0;
    let mut sent: u64 = 0;
    let mut chunk = Vec::with_capacity(64 * 1024);
    loop {
        let elapsed = started.elapsed();
        if seconds > 0 && elapsed >= Duration::from_secs(seconds) {
            break;
        }
        let target = if rate == 0 { sent + 32 * 1024 } else { (rate as f64 * elapsed.as_secs_f64()) as u64 };
        chunk.clear();
        while sent + (chunk.len() as u64) < target {
            let _ = write!(
                chunk,
                "\x1b[{}m{:>8}\x1b[0m lorem ipsum dolor sit amet, consectetur \x1b[1madipiscing\x1b[22m elit sed do eiusmod\r\n",
                colors[(n % colors.len() as u64) as usize],
                n
            );
            n += 1;
        }
        if !chunk.is_empty() {
            if stdout.write_all(&chunk).is_err() || stdout.flush().is_err() {
                return;
            }
            sent += chunk.len() as u64;
        }
        if rate > 0 {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
