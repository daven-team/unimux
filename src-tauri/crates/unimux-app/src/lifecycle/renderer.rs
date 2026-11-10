//! Rules of the renderer crash and hang handling (src/main/stability.ts and index.ts:1036-1090), free of Tauri so they are
//! unit-tested: the reload limiter and the heartbeat that stands in for Electron's `unresponsive` / `responsive` events.
//!
//! Electron learns that a renderer hangs from Chromium's hang monitor (an input event not handled for 15 s) and then gives it
//! [`UNRESPONSIVE_GRACE`] before it asks. WebView2 has no such event that fires reliably (ProcessFailed with
//! RENDER_PROCESS_UNRESPONSIVE needs input too and is fed in as well), so Rust asks the page itself: every
//! [`HEARTBEAT_INTERVAL`] it runs a no-op script and waits for the answer (one at a time). A heartbeat without an answer for
//! [`UNRESPONSIVE_AFTER`] makes the renderer unresponsive (the same 15 s as Chromium, so the question comes no earlier than in
//! 1.1.4); any answer makes it responsive again. A page that navigates (reload, crash) starts over.

use std::time::Duration;

/// How often Rust checks that the page still runs scripts.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
/// A heartbeat unanswered this long: the renderer is unresponsive (Chromium's `kHungRendererDelay`).
pub const UNRESPONSIVE_AFTER: Duration = Duration::from_secs(15);
/// How long a hung renderer gets before the user is asked whether to wait or reload (`UNRESPONSIVE_GRACE_MS`).
pub const UNRESPONSIVE_GRACE: Duration = Duration::from_secs(10);

/// Renderer crashes reloaded by themselves, at most `max` within `window_ms`; after that the user decides (Reload / Quit).
#[derive(Debug, Clone)]
pub struct ReloadLimiter {
    max: usize,
    window_ms: u64,
    times: Vec<u64>,
}

impl Default for ReloadLimiter {
    fn default() -> Self {
        Self::new(3, 60_000)
    }
}

impl ReloadLimiter {
    pub fn new(max: usize, window_ms: u64) -> Self {
        Self { max, window_ms, times: Vec::new() }
    }

    pub fn allow(&mut self, now: u64) -> bool {
        self.times.retain(|t| now.saturating_sub(*t) < self.window_ms);
        if self.times.len() >= self.max {
            return false;
        }
        self.times.push(now);
        true
    }
}

/// What the heartbeat loop does on a tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tick {
    Nothing,
    /// Run the no-op script with this id; its answer calls [`Heartbeat::answered`] with it.
    Ping(u64),
    /// Electron's `unresponsive`.
    Unresponsive,
}

/// The heartbeat of one page, in milliseconds of a monotonic clock.
#[derive(Debug, Default, Clone)]
pub struct Heartbeat {
    outstanding: Option<(u64, u64)>,
    last_sent: Option<u64>,
    next_id: u64,
    unresponsive: bool,
}

impl Heartbeat {
    pub fn tick(&mut self, now: u64) -> Tick {
        match self.outstanding {
            Some((_, sent)) => {
                if !self.unresponsive && now.saturating_sub(sent) >= UNRESPONSIVE_AFTER.as_millis() as u64 {
                    self.unresponsive = true;
                    return Tick::Unresponsive;
                }
                Tick::Nothing
            }
            None => {
                if self.last_sent.is_some_and(|t| now.saturating_sub(t) < HEARTBEAT_INTERVAL.as_millis() as u64) {
                    return Tick::Nothing;
                }
                self.next_id += 1;
                self.outstanding = Some((self.next_id, now));
                self.last_sent = Some(now);
                Tick::Ping(self.next_id)
            }
        }
    }

    /// The earliest time at which [`Heartbeat::tick`] can do something (the next heartbeat or the end of the wait for an
    /// answer); `None` while an unanswered heartbeat already made the renderer unresponsive (only an answer or a reset
    /// changes that). The heartbeat loop sleeps until then instead of polling.
    pub fn next_due(&self, now: u64) -> Option<u64> {
        match self.outstanding {
            Some((_, sent)) => (!self.unresponsive).then(|| sent + UNRESPONSIVE_AFTER.as_millis() as u64),
            None => Some(self.last_sent.map_or(now, |t| t + HEARTBEAT_INTERVAL.as_millis() as u64)),
        }
    }

    /// The page answered heartbeat `id`. True when this ends an unresponsive phase (Electron's `responsive`).
    pub fn answered(&mut self, id: u64) -> bool {
        if self.outstanding.is_none_or(|(current, _)| current != id) {
            return false;
        }
        self.outstanding = None;
        std::mem::replace(&mut self.unresponsive, false)
    }

    /// WebView2 reported the renderer unresponsive itself: the same as a heartbeat that ran out. True when it is new.
    pub fn mark_unresponsive(&mut self) -> bool {
        !std::mem::replace(&mut self.unresponsive, true)
    }

    /// The page navigates (reload, crash): an unanswered heartbeat is lost with it. True when this ends an unresponsive phase.
    pub fn reset(&mut self) -> bool {
        self.outstanding = None;
        self.last_sent = None;
        std::mem::replace(&mut self.unresponsive, false)
    }

    #[cfg(any(test, feature = "test-bridge"))]
    pub fn is_unresponsive(&self) -> bool {
        self.unresponsive
    }
}

/// Electron's `render-process-gone` reasons for WebView2's ProcessFailed reasons (crash.log keeps 1.1.4's words).
pub fn gone_reason(reason: i32) -> &'static str {
    // COREWEBVIEW2_PROCESS_FAILED_REASON: 0 unexpected, 1 unresponsive, 2 terminated, 3 crashed, 4 launch failed,
    // 5 out of memory, 6 profile deleted.
    match reason {
        1 => "unresponsive",
        2 => "killed",
        3 => "crashed",
        4 => "launch-failed",
        5 => "oom",
        6 => "profile-deleted",
        _ => "abnormal-exit",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloads_a_crashed_renderer_3_times_a_minute_then_leaves_it_to_the_user() {
        let mut allow = ReloadLimiter::default();
        assert_eq!([0, 1000, 2000].map(|t| allow.allow(t)), [true, true, true]);
        assert!(!allow.allow(3000));
        assert!(!allow.allow(59_999));
        // The first crash left the window: one more automatic reload.
        assert!(allow.allow(60_000));
        assert!(!allow.allow(60_500));
    }

    #[test]
    fn one_heartbeat_at_a_time_every_two_seconds() {
        let mut h = Heartbeat::default();
        assert_eq!(h.tick(0), Tick::Ping(1));
        assert_eq!(h.tick(1000), Tick::Nothing);
        assert!(!h.answered(1));
        assert_eq!(h.tick(1500), Tick::Nothing);
        assert_eq!(h.tick(2000), Tick::Ping(2));
        // A late answer of an old heartbeat changes nothing.
        assert!(!h.answered(1));
        assert_eq!(h.tick(4500), Tick::Nothing);
        assert!(!h.answered(2));
        assert_eq!(h.tick(4500), Tick::Ping(3));
    }

    #[test]
    fn an_unanswered_heartbeat_makes_the_renderer_unresponsive_once_and_an_answer_responsive() {
        let mut h = Heartbeat::default();
        assert_eq!(h.tick(0), Tick::Ping(1));
        assert_eq!(h.tick(14_999), Tick::Nothing);
        assert_eq!(h.tick(15_000), Tick::Unresponsive);
        assert!(h.is_unresponsive());
        assert_eq!(h.tick(30_000), Tick::Nothing);
        assert!(h.answered(1));
        assert!(!h.is_unresponsive());
        assert_eq!(h.tick(30_000), Tick::Ping(2));
    }

    #[test]
    fn the_next_due_time_is_the_next_heartbeat_or_the_end_of_the_wait() {
        let mut h = Heartbeat::default();
        assert_eq!(h.next_due(7), Some(7));
        assert_eq!(h.tick(0), Tick::Ping(1));
        assert_eq!(h.next_due(10), Some(15_000));
        assert!(!h.answered(1));
        assert_eq!(h.next_due(10), Some(2000));
        assert_eq!(h.tick(1999), Tick::Nothing);
        assert_eq!(h.tick(2000), Tick::Ping(2));
        assert_eq!(h.tick(17_000), Tick::Unresponsive);
        assert_eq!(h.next_due(17_000), None);
        assert!(h.answered(2));
        // The answer came long after the interval: the next heartbeat is due at once.
        assert_eq!(h.next_due(20_000), Some(4000));
        h.reset();
        assert_eq!(h.next_due(20_000), Some(20_000));
    }

    #[test]
    fn webview2s_own_report_and_a_navigation_count_too() {
        let mut h = Heartbeat::default();
        assert!(h.mark_unresponsive());
        assert!(!h.mark_unresponsive());
        assert!(h.reset());
        assert!(!h.reset());
        assert_eq!(h.tick(0), Tick::Ping(1));
        // The page reloads: its heartbeat never comes back, and a new one goes out at once.
        h.reset();
        assert_eq!(h.tick(100), Tick::Ping(2));
    }

    #[test]
    fn reasons_keep_electrons_words() {
        assert_eq!(gone_reason(2), "killed");
        assert_eq!(gone_reason(3), "crashed");
        assert_eq!(gone_reason(5), "oom");
        assert_eq!(gone_reason(0), "abnormal-exit");
    }
}
