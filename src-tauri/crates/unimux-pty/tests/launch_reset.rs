//! test/launch-reset.int.test.ts: the reset typed around the CLI (unimux-agents `with_reset_tail`, `start_clear`), run by
//! REAL shells in a REAL pty through the PtyManager (shell integration included): it must run however the CLI ends, the
//! exit post reaches the hook URL, the start clear erases the screen before the CLI, and the prompt mark carries the CLI's
//! exit code. Windows: powershell.exe and cmd.exe in ConPTY; elsewhere bash.

#[cfg(windows)]
mod common;

use std::collections::HashMap;
#[cfg(windows)]
use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
#[cfg(windows)]
use unimux_agents::launch::start_clear;
use unimux_agents::launch::{Shell, with_reset_tail};
use unimux_pty::manager::{PtyHandle, PtyManager, PtySink, SpawnRequest};
use unimux_pty::shell::ShellKind;

#[cfg(windows)]
fn init() {
    let dir = common::bundled_dir().expect("src-tauri/resources/conpty/x64");
    unimux_pty::conpty::ConptyApi::set_resource_dir(dir);
}

#[cfg(unix)]
fn init() {}

/// The reset as a shell writes it (Windows shells never clear ?1004).
fn has_reset(out: &str) -> bool {
    reset_at(out).is_some()
}

fn reset_at(out: &str) -> Option<usize> {
    ["\x1b[?1000;1002;1003;1005;1006;1015;2004l", "\x1b[?1000;1002;1003;1005;1006;1015;1004;2004l"]
        .iter()
        .filter_map(|r| out.find(r))
        .min()
}

#[derive(Default)]
struct Sink {
    out: Mutex<HashMap<String, Vec<u8>>>,
    cv: Condvar,
    handle: Mutex<Option<PtyHandle>>,
}

impl PtySink for Sink {
    fn data(&self, id: &str, data: &[u8]) {
        let asked = {
            let mut out = self.out.lock();
            let o = out.entry(id.to_string()).or_default();
            let from = o.len().saturating_sub(2);
            o.extend_from_slice(data);
            o[from..].windows(3).any(|w| w == b"\x1b[c")
        };
        self.cv.notify_all();
        // OpenConsole asks DA1 at start: answer like xterm.js does.
        if asked && let Some(h) = self.handle.lock().as_ref() {
            h.write(id, b"\x1b[?1;2c");
        }
    }
    fn exit(&self, _id: &str, _code: i64) {
        self.cv.notify_all();
    }
}

impl Sink {
    fn text(&self, id: &str) -> String {
        String::from_utf8_lossy(self.out.lock().get(id).map_or(&[][..], |v| v.as_slice())).into_owned()
    }
    fn clear(&self, id: &str) {
        self.out.lock().remove(id);
    }
    fn wait(&self, id: &str, timeout: Duration, what: impl Fn(&str) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut out = self.out.lock();
        loop {
            let text = String::from_utf8_lossy(out.get(id).map_or(&[][..], |v| v.as_slice())).into_owned();
            if what(&text) {
                return true;
            }
            if self.cv.wait_until(&mut out, deadline).timed_out() {
                return false;
            }
        }
    }
}

struct Typed {
    setup: Option<&'static str>,
    ctrl_c_after: Option<Duration>,
    wait: Duration,
}

impl Default for Typed {
    fn default() -> Self {
        Typed { setup: None, ctrl_c_after: None, wait: Duration::from_secs(15) }
    }
}

/// Starts `shell`, types `line` (after an optional setup line), optionally sends Ctrl+C once the CLI runs, and returns the
/// output once `until` holds.
fn type_line(shell: ShellKind, line: &str, opts: Typed, until: impl Fn(&str) -> bool) -> String {
    init();
    let sink = Arc::new(Sink::default());
    let m = PtyManager::new(sink.clone());
    *sink.handle.lock() = Some(m.handle());
    let dir = tempfile::Builder::new().prefix("unimux-reset-").tempdir().unwrap();
    let mut req = SpawnRequest::new("t", dir.path(), shell);
    req.cols = 160;
    req.rows = 30;
    req.env = std::env::vars().collect();
    req.command = Some(match opts.setup {
        Some(setup) => format!("{setup}\r{line}"),
        None => line.to_string(),
    });
    m.spawn(req).expect("spawn");
    if let Some(after) = opts.ctrl_c_after {
        assert!(sink.wait("t", Duration::from_secs(15), |o| o.contains("RUNNING")), "CLI started: {:?}", sink.text("t"));
        std::thread::sleep(after);
        sink.clear("t");
        m.write("t", b"\x03");
    }
    let ok = sink.wait("t", opts.wait, &until);
    let out = sink.text("t");
    assert!(m.kill_and_wait("t", Duration::from_secs(5)));
    let tail: String = out.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
    assert!(ok, "pattern not reached in {tail:?}");
    out
}

#[cfg(windows)]
mod windows {
    use super::*;

    fn ps(cli: &str) -> String {
        with_reset_tail(cli, Shell::Powershell, None)
    }

    fn cmd(cli: &str) -> String {
        with_reset_tail(cli, Shell::Cmd, None)
    }

    #[test]
    fn powershell_runs_the_cli_with_the_same_quoting_inside_try_as_outside_then_resets() {
        let cli = r#"[Console]::Out.WriteLine((@('a b', 'it''s', "x y") -join '|'))"#;
        let out = type_line(ShellKind::Powershell, &ps(cli), Typed::default(), |o| has_reset(o) && o.contains("a b|it's|x y"));
        assert!(out.find("a b|it's|x y").unwrap() < reset_at(&out).unwrap());
    }

    #[test]
    fn powershell_resets_after_a_real_ctrl_c_of_a_long_running_native_command() {
        let started = Instant::now();
        let cli = "[Console]::Out.WriteLine('RUN'+'NING'); ping -n 25 127.0.0.1";
        let opts = Typed { ctrl_c_after: Some(Duration::from_millis(1500)), wait: Duration::from_secs(12), ..Typed::default() };
        type_line(ShellKind::Powershell, &ps(cli), opts, has_reset);
        assert!(started.elapsed() < Duration::from_secs(25), "far sooner than the ping would have ended on its own");
    }

    #[test]
    fn powershell_resets_after_a_non_zero_exit_and_a_terminating_error_also_with_stop() {
        type_line(ShellKind::Powershell, &ps("cmd /c exit 3"), Typed::default(), has_reset);
        let opts = Typed { setup: Some("$ErrorActionPreference = 'Stop'"), ..Typed::default() };
        type_line(ShellKind::Powershell, &ps("this-command-does-not-exist-xyz"), opts, has_reset);
    }

    #[test]
    fn cmd_resets_after_a_non_zero_exit_and_after_ctrl_c_of_a_long_running_command() {
        type_line(ShellKind::Cmd, &cmd("cmd /c exit 3"), Typed::default(), has_reset);
        let opts = Typed { ctrl_c_after: Some(Duration::from_millis(1500)), wait: Duration::from_secs(12), ..Typed::default() };
        type_line(ShellKind::Cmd, &cmd("echo RUN^NING & ping -n 25 127.0.0.1"), opts, has_reset);
    }

    /// A local HTTP server that records the request lines and answers 204.
    fn hook_server() -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let posts: Arc<Mutex<Vec<String>>> = Arc::default();
        let p = posts.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                if reader.read_line(&mut first).is_err() {
                    continue;
                }
                let mut line = String::new();
                while reader.read_line(&mut line).is_ok_and(|n| n > 2) {
                    line.clear();
                }
                let parts: Vec<&str> = first.split_whitespace().collect();
                if parts.len() >= 2 {
                    p.lock().push(format!("{} {}", parts[0], parts[1]));
                }
                let mut stream = stream;
                let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
            }
        });
        (format!("http://127.0.0.1:{port}/x/cell-1/0123456789abcdef"), posts)
    }

    fn curl_present() -> bool {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        std::path::Path::new(&root).join("System32").join("curl.exe").exists()
    }

    #[test]
    fn the_exit_post_follows_the_cli_and_the_reset_still_runs_in_powershell_and_cmd() {
        if !curl_present() {
            eprintln!("no curl.exe: skipped");
            return;
        }
        for (kind, shell) in [(ShellKind::Powershell, Shell::Powershell), (ShellKind::Cmd, Shell::Cmd)] {
            let (url, posts) = hook_server();
            type_line(kind, &with_reset_tail("cmd /c exit 3", shell, Some(&url)), Typed::default(), has_reset);
            let deadline = Instant::now() + Duration::from_secs(10);
            while posts.lock().is_empty() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert_eq!(*posts.lock(), ["POST /x/cell-1/0123456789abcdef/3"], "{shell:?}");
        }
    }

    #[test]
    fn the_start_clear_erases_the_screen_and_the_scrollback_between_the_typed_line_and_the_cli() {
        for (kind, shell, cli) in [
            (ShellKind::Powershell, Shell::Powershell, "[Console]::Out.WriteLine('CLI-OUT-'+'1')"),
            (ShellKind::Cmd, Shell::Cmd, "echo CLI-OUT-^1"),
        ] {
            let clear = start_clear(shell);
            let line = format!("{clear}{}", with_reset_tail(cli, shell, None));
            let out = type_line(kind, &line, Typed::default(), |o| has_reset(o) && o.contains("CLI-OUT-1"));
            let cleared = out.rfind("\x1b[3J").expect("ED 3");
            assert!(out[..cleared].contains("\x1b[2J"), "ED 2 before ED 3 ({shell:?})");
            // PSReadLine colours the echo of the typed line: the command name and its separator come apart.
            let needle = clear.trim().trim_end_matches(';');
            let typed = out.find(needle).unwrap_or_else(|| panic!("the typed clear {needle:?} in {out:?}"));
            assert!(cleared > typed, "{shell:?}");
            let cli_out = out.find("CLI-OUT-1").unwrap();
            assert!(cleared < cli_out, "{shell:?}");
            assert!(cli_out < reset_at(&out).unwrap(), "{shell:?}");
        }
    }

    #[test]
    fn the_prompt_mark_reports_the_code_of_the_cli_not_the_success_of_the_reset_tail() {
        let line = format!("{}\recho next", ps("cmd /c exit 3"));
        let out = type_line(ShellKind::Powershell, &line, Typed::default(), |o| {
            o.find("\x1b]133;D;3\x07").is_some_and(|i| o[i..].contains("\x1b]133;D;0\x07"))
        });
        assert!(out.contains("\x1b]133;D;3\x07"));
    }
}

#[cfg(unix)]
mod posix {
    use super::*;

    fn sh(cli: &str) -> String {
        with_reset_tail(cli, Shell::Bash, None)
    }

    #[test]
    fn bash_resets_after_a_failing_command_and_after_ctrl_c_of_a_long_running_command() {
        type_line(ShellKind::Bash, &sh("false"), Typed::default(), has_reset);
        let opts = Typed { ctrl_c_after: Some(Duration::from_millis(1000)), wait: Duration::from_secs(8), ..Typed::default() };
        type_line(ShellKind::Bash, &sh("echo RUN''NING; sleep 25"), opts, has_reset);
    }
}
