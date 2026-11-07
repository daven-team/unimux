//! Quitting while agents work (port of src/main/quitConfirm.ts): the window close or the quit is held while the renderer asks
//! the user (it knows the cells and their labels). The renderer tells beforehand whether there is anything to ask about (the
//! guard, `app:quitGuard`), so a quit with no working agent never waits for it. The question can never trap the user:
//! - a renderer that does not acknowledge within [`QUIT_ACK_MS`] does not keep the app open (every further Close asks again
//!   and re-arms it);
//! - an acknowledged question has an upper bound ([`QUIT_ANSWER_MS`]), after which the app quits as requested;
//! - whatever is exempt (the OS session ending, an update hand-over, the app already winding down) is never held, and a session
//!   end that arrives while the question is open releases the quit at once ([`QuitConfirm::release`]).
//!
//! The TS version calls its dependencies (ask, quit, timers) directly. Here every call returns the [`Effect`]s to run, so the
//! caller runs them after it let go of the lock (a quit re-enters `hold` through the before-quit path). A timer is identified by
//! a number: clearing one only forgets the number, and a timer that fires with a number that is no longer current does nothing.

/// The answer of the renderer to `app:confirm-quit` (`isQuitAnswer`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitAnswer {
    Asking,
    Quit,
    Cancel,
}

impl QuitAnswer {
    pub fn parse(value: &serde_json::Value) -> Option<Self> {
        match value.as_str()? {
            "asking" => Some(Self::Asking),
            "quit" => Some(Self::Quit),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }
}

pub const QUIT_ACK_MS: u64 = 3000;
/// The longest an open, acknowledged quit question holds the quit; then the app quits as the user asked.
pub const QUIT_ANSWER_MS: u64 = 120_000;
/// How long after the OS announced a session end (shutdown, log-off) quits are never held; a cancelled shutdown re-enables the
/// question.
pub const SESSION_END_WINDOW_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timer {
    /// The renderer must acknowledge the question ('asking') before this fires.
    Ack,
    /// The upper bound of an acknowledged question.
    Answer,
}

/// What the caller does after a call, in this order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Show the window and send `app:confirm-quit` to the renderer.
    Ask,
    /// Quit for real (the before-quit path; `hold` answers false from now on).
    Quit,
    /// Start a timer; when it fires, call [`QuitConfirm::fire`] with the same kind and id.
    Arm { timer: Timer, id: u64, ms: u64 },
}

#[derive(Debug)]
pub struct QuitConfirm {
    ack_ms: u64,
    answer_ms: u64,
    guard: bool,
    confirmed: bool,
    pending: bool,
    ack: Option<u64>,
    answer: Option<u64>,
    next_id: u64,
}

impl Default for QuitConfirm {
    fn default() -> Self {
        Self::new(QUIT_ACK_MS, QUIT_ANSWER_MS)
    }
}

impl QuitConfirm {
    pub fn new(ack_ms: u64, answer_ms: u64) -> Self {
        Self { ack_ms, answer_ms, guard: false, confirmed: false, pending: false, ack: None, answer: None, next_id: 0 }
    }

    fn arm(&mut self, timer: Timer, ms: u64, out: &mut Vec<Effect>) -> u64 {
        self.next_id += 1;
        out.push(Effect::Arm { timer, id: self.next_id, ms });
        self.next_id
    }

    fn stop_all(&mut self) {
        self.ack = None;
        self.answer = None;
    }

    fn go(&mut self, out: &mut Vec<Effect>) {
        self.pending = false;
        self.stop_all();
        self.confirmed = true;
        out.push(Effect::Quit);
    }

    fn ask(&mut self, out: &mut Vec<Effect>) {
        self.ack = None;
        out.push(Effect::Ask);
        let id = self.arm(Timer::Ack, self.ack_ms, out);
        self.ack = Some(id);
    }

    pub fn set_guard(&mut self, value: bool) {
        self.guard = value;
    }

    #[cfg(feature = "test-bridge")]
    pub fn guard(&self) -> bool {
        self.guard
    }

    /// Called from the window close and the quit: true means "hold it, the user is asked". A repeated Close asks again.
    /// `exempt`: this quit must not be held (session end, update hand-over, already quitting, no live renderer).
    pub fn hold(&mut self, exempt: bool) -> (bool, Vec<Effect>) {
        let mut out = Vec::new();
        if self.confirmed || !self.guard || exempt {
            return (false, out);
        }
        self.pending = true;
        self.ask(&mut out);
        (true, out)
    }

    pub fn answer(&mut self, answer: QuitAnswer) -> Vec<Effect> {
        let mut out = Vec::new();
        if !self.pending {
            return out;
        }
        match answer {
            QuitAnswer::Asking => {
                self.ack = None;
                // The bound is set by the first acknowledgement and never extended.
                if self.answer.is_none() {
                    let id = self.arm(Timer::Answer, self.answer_ms, &mut out);
                    self.answer = Some(id);
                }
            }
            QuitAnswer::Quit => self.go(&mut out),
            QuitAnswer::Cancel => {
                self.pending = false;
                self.stop_all();
            }
        }
        out
    }

    /// A timer fired. Stale timers (cleared, or replaced by a newer one) do nothing.
    pub fn fire(&mut self, timer: Timer, id: u64) -> Vec<Effect> {
        let mut out = Vec::new();
        let slot = match timer {
            Timer::Ack => &mut self.ack,
            Timer::Answer => &mut self.answer,
        };
        if *slot != Some(id) {
            return out;
        }
        *slot = None;
        if self.pending {
            self.go(&mut out);
        }
        out
    }

    /// A quit already decided elsewhere (the user chose to quit in a crash dialog): never asked again.
    pub fn confirm(&mut self) {
        self.confirmed = true;
    }

    /// The OS session ends while the question may be open: a held quit goes on now; later ones are exempt by the caller.
    pub fn release(&mut self) -> Vec<Effect> {
        let mut out = Vec::new();
        if self.pending {
            self.go(&mut out);
        }
        out
    }

    /// The renderer reloaded or died: its guard and an open question are gone with it.
    pub fn renderer_gone(&mut self) {
        self.guard = false;
        self.pending = false;
        self.stop_all();
    }

    /// The question is open (a quit is held).
    pub fn is_pending(&self) -> bool {
        self.pending
    }

    /// Timers that are still current (a cleared one is not counted even if it has not fired yet).
    #[cfg(test)]
    pub fn armed_timers(&self) -> usize {
        usize::from(self.ack.is_some()) + usize::from(self.answer.is_some())
    }
}

/// True for about a minute after the OS announced a session end (`sessionEndingNow`).
pub fn session_ending_now(ending_at: Option<u64>, now: u64, window_ms: u64) -> bool {
    ending_at.is_some_and(|at| now >= at && now - at < window_ms)
}

#[cfg(test)]
mod tests {
    //! Cases of test/agent-work.test.ts "quit confirmation" (PORTING rows), with a fake clock that runs the effects.
    use super::*;

    /// The fake clock of the TS tests: armed timers fire when the time passes them; effects are counted.
    struct Setup {
        confirm: QuitConfirm,
        now: u64,
        timers: Vec<(u64, Timer, u64)>,
        asks: usize,
        quits: usize,
        exempt: bool,
    }

    impl Setup {
        fn new(exempt: bool) -> Self {
            Self { confirm: QuitConfirm::new(3000, 120_000), now: 0, timers: vec![], asks: 0, quits: 0, exempt }
        }
        fn run(&mut self, effects: Vec<Effect>) {
            for e in effects {
                match e {
                    Effect::Ask => self.asks += 1,
                    Effect::Quit => self.quits += 1,
                    Effect::Arm { timer, id, ms } => self.timers.push((self.now + ms, timer, id)),
                }
            }
        }
        fn hold(&mut self) -> bool {
            let (held, effects) = self.confirm.hold(self.exempt);
            self.run(effects);
            held
        }
        fn answer(&mut self, a: QuitAnswer) {
            let effects = self.confirm.answer(a);
            self.run(effects);
        }
        fn advance(&mut self, ms: u64) {
            let end = self.now + ms;
            loop {
                self.timers.sort_by_key(|t| t.0);
                let Some(pos) = self.timers.iter().position(|t| t.0 <= end) else { break };
                let (at, timer, id) = self.timers.remove(pos);
                self.now = at;
                let effects = self.confirm.fire(timer, id);
                self.run(effects);
            }
            self.now = end;
        }
    }

    #[test]
    fn does_not_hold_a_quit_when_no_agent_works() {
        let mut s = Setup::new(false);
        assert!(!s.hold());
        assert_eq!(s.asks, 0);
    }

    #[test]
    fn quits_or_stays_as_the_user_chose() {
        let mut s = Setup::new(false);
        s.confirm.set_guard(true);
        assert!(s.hold());
        assert_eq!(s.asks, 1);
        s.answer(QuitAnswer::Asking);
        s.advance(60_000);
        assert_eq!(s.quits, 0);
        s.answer(QuitAnswer::Cancel);
        s.advance(200_000);
        assert_eq!(s.quits, 0);
        assert!(s.hold());
        s.answer(QuitAnswer::Asking);
        s.answer(QuitAnswer::Quit);
        assert_eq!(s.quits, 1);
        assert!(!s.hold());
        assert_eq!(s.confirm.armed_timers(), 0);
    }

    #[test]
    fn a_second_close_while_asking_asks_again_and_quits_when_the_renderer_stays_silent() {
        let mut s = Setup::new(false);
        s.confirm.set_guard(true);
        s.hold();
        s.answer(QuitAnswer::Asking);
        s.advance(10_000);
        // The dialog got lost: the renderer no longer acknowledges the repeated question.
        assert!(s.hold());
        assert_eq!(s.asks, 2);
        s.advance(2999);
        assert_eq!(s.quits, 0);
        s.advance(1);
        assert_eq!(s.quits, 1);
    }

    #[test]
    fn a_repeated_close_that_is_acknowledged_keeps_waiting_for_the_answer() {
        let mut s = Setup::new(false);
        s.confirm.set_guard(true);
        s.hold();
        s.answer(QuitAnswer::Asking);
        s.hold();
        s.answer(QuitAnswer::Asking);
        s.advance(5000);
        assert_eq!(s.quits, 0);
        s.answer(QuitAnswer::Cancel);
        assert_eq!(s.quits, 0);
    }

    #[test]
    fn an_acknowledged_question_holds_the_quit_at_most_two_minutes() {
        let mut s = Setup::new(false);
        s.confirm.set_guard(true);
        s.hold();
        s.answer(QuitAnswer::Asking);
        s.advance(60_000);
        s.hold();
        s.answer(QuitAnswer::Asking);
        // The bound is not extended by the repeated question.
        s.advance(59_999);
        assert_eq!(s.quits, 0);
        s.advance(1);
        assert_eq!(s.quits, 1);
    }

    #[test]
    fn a_session_end_releases_a_held_quit_at_once() {
        let mut s = Setup::new(false);
        s.confirm.set_guard(true);
        s.hold();
        s.answer(QuitAnswer::Asking);
        let effects = s.confirm.release();
        s.run(effects);
        assert_eq!(s.quits, 1);
        let mut idle = Setup::new(false);
        let effects = idle.confirm.release();
        idle.run(effects);
        assert_eq!(idle.quits, 0);
    }

    #[test]
    fn treats_a_session_end_as_exempt_for_about_a_minute_only() {
        let w = SESSION_END_WINDOW_MS;
        assert!(!session_ending_now(None, 1000, w));
        assert!(session_ending_now(Some(1000), 1000, w));
        assert!(session_ending_now(Some(1000), 60_999, w));
        assert!(!session_ending_now(Some(1000), 61_000, w));
        // A clock that went back never counts as "now".
        assert!(!session_ending_now(Some(1000), 999, w));
    }

    #[test]
    fn never_holds_a_session_end_or_update_and_does_not_wait_for_a_silent_renderer() {
        let mut exempt = Setup::new(true);
        exempt.confirm.set_guard(true);
        assert!(!exempt.hold());
        let mut silent = Setup::new(false);
        silent.confirm.set_guard(true);
        assert!(silent.hold());
        silent.advance(3000);
        assert_eq!(silent.quits, 1);
        let mut reloaded = Setup::new(false);
        reloaded.confirm.set_guard(true);
        reloaded.confirm.renderer_gone();
        assert!(!reloaded.hold());
    }

    #[test]
    fn a_confirmed_quit_is_never_asked_again_and_answers_need_a_question() {
        let mut s = Setup::new(false);
        s.confirm.set_guard(true);
        // No question open: answers change nothing.
        s.answer(QuitAnswer::Quit);
        assert_eq!(s.quits, 0);
        s.confirm.confirm();
        assert!(!s.hold());
        assert_eq!(s.asks, 0);
        assert_eq!(QuitAnswer::parse(&serde_json::json!("asking")), Some(QuitAnswer::Asking));
        assert_eq!(QuitAnswer::parse(&serde_json::json!("later")), None);
        assert_eq!(QuitAnswer::parse(&serde_json::json!(true)), None);
    }
}
