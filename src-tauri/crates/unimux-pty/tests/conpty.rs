//! SP5 acceptance (cargo half): the ConPTY wrapper on the bundled conpty.dll 1.23. Echo round trip, output after exit
//! (the shell's and a `start /b` child's that outlives the shell), kill under flood (50 iterations, reader paused by flow
//! control, no deadlock), close alone under flood, Job Object tree kill (and no tree kill on a normal exit), resize, 30
//! parallel kills. Windows only.
#![cfg(windows)]

mod common;

use std::time::{Duration, Instant};

use common::*;
use unimux_pty::conpty::Pty;

/// The flood helper of this crate (src/bin/unimux-pty-flood.rs) with optional rate and duration.
fn flood(args: &[&str]) -> unimux_pty::conpty::SpawnOptions {
    let mut o = unimux_pty::conpty::SpawnOptions::new(env!("CARGO_BIN_EXE_unimux-pty-flood"), args);
    o.cols = 120;
    o.rows = 30;
    o
}

#[test]
fn echo_round_trip_in_cmd() {
    let out = Collector::default();
    let pty = out.spawn(bundled(), &cmd(&[]));
    assert!(out.wait_text(Duration::from_secs(10), ">"), "no prompt: {:?}", out.text());
    pty.write(b"echo sp5-%OS:~0,0%marker\r");
    assert!(out.wait_text(Duration::from_secs(10), "sp5-marker"), "no echo: {:?}", out.text());
    // ConPTY asks its terminal for win32-input-mode and focus events at start (TerminalManager handles both).
    let text = out.text();
    assert!(text.contains("\x1b[?9001h"), "no win32-input-mode request: {text:?}");
    assert!(text.contains("\x1b[?1004h"), "no focus event request: {text:?}");
    pty.write(b"exit 7\r");
    assert_eq!(out.wait_exit(Duration::from_secs(10)), Some(7));
}

#[test]
fn win32_input_mode_keys_reach_the_shell() {
    let out = Collector::default();
    let pty = out.spawn(bundled(), &cmd(&[]));
    assert!(out.wait_text(Duration::from_secs(10), ">"));
    // "echo w32" + Enter as win32-input-mode sequences (CSI Vk;Sc;Uc;Kd;Cs;Rc _), what TerminalManager sends once ConPTY
    // asked for the mode (shared/win32input.ts encodeWin32Key: key down and key up per character).
    let mut seq = String::new();
    for c in "echo w32k".chars() {
        let vk = if c == ' ' {
            0x20
        } else if c.is_ascii_digit() {
            c as u32
        } else {
            c.to_ascii_uppercase() as u32
        };
        seq.push_str(&format!("\x1b[{vk};0;{};1;0;1_\x1b[{vk};0;{};0;0;1_", c as u32, c as u32));
    }
    seq.push_str("\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_");
    pty.write(seq.as_bytes());
    assert!(
        out.wait(Duration::from_secs(10), |o| String::from_utf8_lossy(&o.bytes).matches("w32k").count() >= 2),
        "{:?}",
        out.text()
    );
    pty.kill();
    assert!(out.wait_exit(Duration::from_secs(5)).is_some());
}

#[test]
fn output_after_exit_is_delivered_before_the_exit() {
    for round in 0..10 {
        let out = Collector::default();
        let _pty = out.spawn(bundled(), &cmd(&["/d", "/c", "for /L %i in (1,1,3000) do @echo line %i"]));
        // The limit is generous: 3000 cmd echoes took over 30 s on a fully loaded machine (the test is about completeness).
        let code = out.wait_exit(Duration::from_secs(120));
        assert_eq!(code, Some(0), "round {round}: {} bytes", out.len());
        let text = out.text();
        assert!(
            text.contains("line 3000"),
            "round {round}: last line missing, tail {:?}",
            &text[text.len().saturating_sub(200)..]
        );
    }
}

/// The shell ends at once, a `start /b` child stays attached to the console and keeps printing. node-pty 1.1.0 with the
/// dll (1.1.4) reports the exit only when the output pipe ends, so the child runs to its end and all its output arrives
/// before the exit (the shell's exit code). Before the fix the pseudoconsole was closed 1 s after the shell ended.
#[test]
fn background_child_keeps_running_and_printing_after_the_shell_exits() {
    let out = Collector::default();
    let started = Instant::now();
    let pty = out.spawn(bundled(), &cmd(&["/d", "/c", "start /b ping -n 4 127.0.0.1 & echo shell-done"]));
    assert_eq!(pty.wait_exit(Duration::from_secs(10)), Some(0), "shell exit");
    let shell_exit = started.elapsed();
    let code = out.wait_exit(Duration::from_secs(20));
    let reported = started.elapsed();
    assert_eq!(code, Some(0));
    let o = out.0.0.lock();
    let at_exit = String::from_utf8_lossy(&o.bytes[..o.at_exit]).into_owned();
    // "TTL=" is in every reply line whatever the system language.
    let replies = at_exit.matches("TTL=").count();
    println!(
        "SP5 start /b child: shell exit {} ms, exit reported {} ms, {replies} of 4 replies before the exit",
        shell_exit.as_millis(),
        reported.as_millis()
    );
    assert!(at_exit.contains("shell-done"), "{at_exit:?}");
    assert_eq!(replies, 4, "the background child was cut off: {at_exit:?}");
    assert!(reported >= Duration::from_millis(2500), "exit reported before the child ended ({} ms)", reported.as_millis());
}

/// A program the shell started into its own console (`start /min`) is in the job but must survive the shell ending by
/// itself (1.1.4 tree-kills only on a kill); the same program is ended by Pty::kill.
#[test]
fn detached_child_survives_a_normal_exit_and_dies_with_a_kill() {
    let find_ping = |shell: u32| -> Vec<u32> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let found: Vec<u32> = tree(shell).into_iter().skip(1).collect();
            if !found.is_empty() || Instant::now() > deadline {
                return found;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    // The shell waits for the child to show up before it exits (a 1 s ping), so the test sees its pid.
    let out = Collector::default();
    let pty = out.spawn(bundled(), &cmd(&["/d", "/c", "start /min ping -n 61 127.0.0.1 & ping -n 2 127.0.0.1 >nul"]));
    let detached = find_ping(pty.pid());
    assert!(!detached.is_empty(), "no detached child");
    assert_eq!(out.wait_exit(Duration::from_secs(20)), Some(0));
    drop(pty);
    std::thread::sleep(Duration::from_millis(500));
    let alive: Vec<u32> = detached.iter().copied().filter(|p| Pty::process_alive(*p)).collect();
    for p in &alive {
        let _ = std::process::Command::new("taskkill").args(["/PID", &p.to_string(), "/T", "/F"]).output();
    }
    assert!(!alive.is_empty(), "the detached child died with the shell's normal exit");

    let out = Collector::default();
    let pty = out.spawn(bundled(), &cmd(&[]));
    assert!(out.wait_text(Duration::from_secs(10), ">"));
    pty.write(b"start /min ping -n 61 127.0.0.1\r");
    let detached = find_ping(pty.pid());
    assert!(!detached.is_empty(), "no detached child");
    pty.kill();
    assert!(out.wait_exit(Duration::from_secs(5)).is_some());
    std::thread::sleep(Duration::from_millis(300));
    let alive: Vec<u32> = detached.iter().copied().filter(|p| Pty::process_alive(*p)).collect();
    for p in &alive {
        let _ = std::process::Command::new("taskkill").args(["/PID", &p.to_string(), "/T", "/F"]).output();
    }
    assert!(alive.is_empty(), "kill left the detached child alive: {alive:?}");
}

/// The graceful path: Pty::close alone (no terminate) while the reader is paused by flow control and the flood helper is
/// still writing. The close must return (the gate opens for the drain), and the program gets CTRL_CLOSE and ends.
#[test]
fn close_alone_under_flood_with_a_paused_reader() {
    for round in 0..10 {
        let out = Collector::default();
        let pty = out.spawn(bundled(), &flood(&[]));
        assert!(out.wait(Duration::from_secs(20), |o| o.bytes.len() > 64 * 1024), "round {round}: no flood");
        pty.set_paused(true);
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(pty.exit_code(), None, "round {round}: the flood helper ended by itself");
        pty.close();
        assert!(pty.wait_closed(Duration::from_secs(15)).is_some(), "round {round}: close did not return (deadlock)");
        assert!(pty.wait_exit(Duration::from_secs(10)).is_some(), "round {round}: the program did not end on CTRL_CLOSE");
        assert!(out.wait_exit(Duration::from_secs(10)).is_some(), "round {round}: no exit reported");
    }
}

/// The deadlock case: the reader is paused (flow control) while OpenConsole floods a full pipe, and the terminal is closed.
fn close_under_flood(api: &'static unimux_pty::conpty::ConptyApi, rounds: usize, pause: bool) -> Vec<f64> {
    let mut took = Vec::new();
    for round in 0..rounds {
        let out = Collector::default();
        let spawned = Instant::now();
        let pty = out.spawn(api, &flood(&[]));
        let flooding = out.wait(Duration::from_secs(20), |o| o.bytes.len() > 64 * 1024);
        if std::env::var_os("SP5_TRACE").is_some() {
            eprintln!(
                "round {round}: {} bytes after {} ms, openconsole {}",
                out.len(),
                spawned.elapsed().as_millis(),
                count_processes("OpenConsole.exe")
            );
        }
        assert!(
            flooding,
            "round {round}: no flood ({} bytes: {:?})",
            out.len(),
            out.text().chars().take(300).collect::<String>()
        );
        if pause {
            pty.set_paused(true);
            // Let the 128 KiB pipe and OpenConsole's own buffer fill up.
            std::thread::sleep(Duration::from_millis(150));
        }
        let started = Instant::now();
        pty.kill();
        let closed = pty.wait_closed(Duration::from_secs(15));
        assert!(closed.is_some(), "round {round}: ClosePseudoConsole did not return in 15 s (deadlock)");
        assert!(out.wait_exit(Duration::from_secs(15)).is_some(), "round {round}: no exit after close");
        took.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    took.sort_by(f64::total_cmp);
    took
}

#[test]
fn close_under_flood_50_rounds_no_deadlock() {
    let paused = close_under_flood(bundled(), 50, true);
    let reading = close_under_flood(bundled(), 10, false);
    println!(
        "SP5 close-under-flood bundled: paused reader p50 {:.1} ms p95 {:.1} ms max {:.1} ms; reading p50 {:.1} ms max {:.1} ms",
        percentile(&paused, 0.5),
        percentile(&paused, 0.95),
        paused.last().unwrap(),
        percentile(&reading, 0.5),
        reading.last().unwrap()
    );
    assert!(*paused.last().unwrap() < 5000.0);
}

#[test]
fn start_waits_for_the_da1_answer() {
    // OpenConsole 1.23 sends DA1 and holds the client's first output until the terminal answers (or a timeout).
    for (name, out) in [("answered", Collector::default()), ("unanswered", Collector::mute())] {
        let started = Instant::now();
        let _pty = out.spawn(bundled(), &cmd(&["/d", "/c", "echo started"]));
        assert!(out.wait_text(Duration::from_secs(10), "started"));
        println!("SP5 first output with DA1 {name}: {} ms", started.elapsed().as_millis());
    }
}

#[test]
fn flood_throughput() {
    for (name, api) in [("bundled", bundled()), ("inbox", inbox())] {
        let out = Collector::default();
        let started = Instant::now();
        let _pty = out.spawn(api, &flood(&["0", "3"]));
        assert!(out.wait_exit(Duration::from_secs(30)).is_some());
        let secs = started.elapsed().as_secs_f64();
        println!(
            "SP5 flood throughput {name}: {:.1} MB in {:.2} s = {:.1} MB/s through ConPTY",
            out.len() as f64 / 1e6,
            secs,
            out.len() as f64 / 1e6 / secs
        );
    }
}

#[test]
fn close_under_flood_inbox_api_for_comparison() {
    let paused = close_under_flood(inbox(), 10, true);
    println!(
        "SP5 close-under-flood inbox kernel32: paused reader p50 {:.1} ms max {:.1} ms",
        percentile(&paused, 0.5),
        paused.last().unwrap()
    );
}

#[test]
fn job_object_kills_the_whole_tree() {
    for job in [true, false] {
        let out = Collector::default();
        let mut opts = cmd(&[]);
        opts.job = job;
        let pty = out.spawn(bundled(), &opts);
        assert!(out.wait_text(Duration::from_secs(10), ">"));
        // A background grandchild (what a dev server started by an agent looks like).
        pty.write(b"start /b ping -n 120 127.0.0.1 >nul\r");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut descendants = Vec::new();
        while Instant::now() < deadline {
            descendants = tree(pty.pid()).into_iter().skip(1).collect();
            if !descendants.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!descendants.is_empty(), "no grandchild started");
        pty.kill();
        let exited = out.wait_exit(Duration::from_secs(5)).is_some();
        assert!(
            exited,
            "job={job}: no exit 5 s after kill (process exit {:?}, close took {:?}, {} bytes)",
            pty.exit_code(),
            pty.wait_closed(Duration::from_millis(10)),
            out.len()
        );
        std::thread::sleep(Duration::from_millis(300));
        let alive: Vec<u32> = descendants.iter().copied().filter(|p| Pty::process_alive(*p)).collect();
        if job {
            assert!(alive.is_empty(), "job: descendants still alive {alive:?}");
        } else {
            // Without a job only the shell ends (node-pty's kill); 1.1.4 needed taskkill /T for the rest.
            println!("SP5 without job: {} of {} descendants survive the kill", alive.len(), descendants.len());
            for p in alive {
                let _ = std::process::Command::new("taskkill").args(["/PID", &p.to_string(), "/T", "/F"]).output();
            }
        }
    }
}

#[test]
fn resize_reaches_the_console() {
    let out = Collector::default();
    let pty = out.spawn(bundled(), &cmd(&[]));
    assert!(out.wait_text(Duration::from_secs(10), ">"));
    pty.resize(97, 31).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    pty.write(b"powershell -NoProfile -Command \"Write-Output ('size=' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height)\"\r");
    assert!(out.wait_text(Duration::from_secs(20), "size=97x31"), "{:?}", out.text());
    pty.kill();
}

#[test]
fn thirty_parallel_kills_end_within_3_seconds() {
    let outs: Vec<Collector> = (0..30).map(|_| Collector::default()).collect();
    let ptys: Vec<Pty> = outs.iter().map(|o| o.spawn(bundled(), &cmd(&[]))).collect();
    for o in &outs {
        assert!(o.wait_text(Duration::from_secs(20), ">"));
    }
    let started = Instant::now();
    std::thread::scope(|s| {
        for p in &ptys {
            s.spawn(move || p.kill());
        }
    });
    for o in &outs {
        assert!(o.wait_exit(Duration::from_secs(3)).is_some());
    }
    let took = started.elapsed();
    println!("SP5 30 parallel kills: all exits in {} ms", took.as_millis());
    assert!(took < Duration::from_secs(3));
}
