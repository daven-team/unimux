//! The output path of one terminal (port of src/ptyhost/output.ts): coalescing, replay tail, renderer back-pressure and the
//! exit drain. Shared by the pty terminals and (P5) the SSH channels; the source is paused and resumed through
//! [`OutputControl`].
//!
//! One difference to 1.1.4 that keeps the behaviour: 1.1.4 sent a keystroke's echo with `process.nextTick` (at the end of
//! the event-loop callback that received it, so the chunks of one read went together). Here every read of the source is
//! one [`OutputChannel::push`] on the reader's thread, so the echo leaves at the end of that push.

use std::sync::{Arc, Weak};

use parking_lot::{Mutex, RwLock};

use crate::flow::{
    ECHO_FLUSHES, EchoClock, FLUSH_NOW_BYTES, FlowGate, PTY_REPLAY_BYTES, ReplaySize, TailBuffer, aligned_delay, coalesce_delay,
};
use crate::timers::{Scheduler, TimerId};

/// A paused source is resumed anyway when no acknowledgement arrives for this long (renderer gone or stuck).
pub const PAUSE_WATCHDOG_MS: f64 = 3000.0;
/// How long the last output of a paused source that ended may still arrive.
pub const EXIT_DRAIN_MS: f64 = 80.0;

/// Where a channel's flushed output goes. False when nobody received it (no renderer window attached): such output is
/// not counted for flow control.
pub trait OutputSink: Send + Sync {
    fn data(&self, id: &str, data: Vec<u8>, echo: bool) -> bool;
}

pub trait OutputControl: Send + Sync {
    fn pause(&self);
    fn resume(&self);
}

/// The terminal the renderer reported as focused (its output keeps the bulk window instead of the background one).
#[derive(Default)]
pub struct Focus(RwLock<Option<String>>);

impl Focus {
    pub fn get(&self) -> Option<String> {
        self.0.read().clone()
    }
    pub fn is(&self, id: &str) -> bool {
        self.0.read().as_deref() == Some(id)
    }
    pub fn set(&self, id: Option<String>) {
        *self.0.write() = id;
    }
}

struct State {
    buf: Vec<u8>,
    timer: Option<TimerId>,
    /// Bumped by every arm of the flush timer. Its task compares it under the state lock, which `arm` holds until the id
    /// is stored: a timer that fires before `after` returned (the arming thread preempted) still finds itself current,
    /// and a cancelled or replaced one never does.
    timer_gen: u64,
    /// When the pending flush timer fires.
    due: f64,
    tail: TailBuffer,
    gate: FlowGate,
    watchdog: Option<TimerId>,
    /// The same for the pause watchdog.
    watchdog_gen: u64,
    last_write: f64,
    echo: EchoClock,
    /// Flushes the latest keystroke may still send without a timer (ECHO_FLUSHES).
    echo_flushes: u32,
    /// The source ended and its last output is being drained: never pause it again.
    exiting: bool,
    disposed: bool,
}

pub struct OutputChannel {
    id: String,
    me: Weak<OutputChannel>,
    state: Mutex<State>,
    sink: Arc<dyn OutputSink>,
    control: Arc<dyn OutputControl>,
    /// Back-pressure from the renderer is on (a main window is attached).
    flow: Arc<dyn Fn() -> bool + Send + Sync>,
    focus: Arc<Focus>,
    sched: Arc<dyn Scheduler>,
}

impl OutputChannel {
    pub fn new(
        id: impl Into<String>,
        sink: Arc<dyn OutputSink>,
        control: Arc<dyn OutputControl>,
        flow: Arc<dyn Fn() -> bool + Send + Sync>,
        focus: Arc<Focus>,
        sched: Arc<dyn Scheduler>,
    ) -> Arc<Self> {
        Self::with_tail(id, sink, control, flow, focus, sched, PTY_REPLAY_BYTES)
    }

    pub fn with_tail(
        id: impl Into<String>,
        sink: Arc<dyn OutputSink>,
        control: Arc<dyn OutputControl>,
        flow: Arc<dyn Fn() -> bool + Send + Sync>,
        focus: Arc<Focus>,
        sched: Arc<dyn Scheduler>,
        tail: usize,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            id: id.into(),
            me: me.clone(),
            state: Mutex::new(State {
                buf: Vec::new(),
                timer: None,
                timer_gen: 0,
                due: f64::INFINITY,
                tail: TailBuffer::new(tail),
                gate: FlowGate::default(),
                watchdog: None,
                watchdog_gen: 0,
                last_write: f64::NEG_INFINITY,
                echo: EchoClock::new(),
                echo_flushes: 0,
                exiting: false,
                disposed: false,
            }),
            sink,
            control,
            flow,
            focus,
            sched,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// One read of the source.
    pub fn push(&self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let mut st = self.state.lock();
        if st.disposed {
            return;
        }
        let now = self.sched.now();
        // Judged by the window learnt so far, then measured: one late answer must not make itself an echo.
        let echo = st.echo_flushes > 0 && now - st.last_write < st.echo.window();
        st.echo.output(now);
        st.tail.push(data);
        st.buf.extend_from_slice(data);
        if st.buf.len() >= FLUSH_NOW_BYTES {
            self.flush_locked(&mut st, false);
        } else if echo {
            st.echo_flushes -= 1;
            self.flush_locked(&mut st, true);
        } else if st.timer.is_none() {
            self.arm(&mut st, now);
        }
    }

    /// The echo window of this terminal in ms.
    pub fn echo_window(&self) -> f64 {
        self.state.lock().echo.window()
    }

    /// A first estimate of how long this terminal takes to answer a keystroke, in ms.
    pub fn seed_echo(&self, ms: f64) {
        self.state.lock().echo.seed(ms);
    }

    fn delay(&self, st: &State, now: f64) -> f64 {
        aligned_delay(now, coalesce_delay(now, st.last_write, self.focus.is(&self.id), st.echo.window()))
    }

    fn arm(&self, st: &mut State, now: f64) {
        let delay = self.delay(st, now);
        if let Some(t) = st.timer.take() {
            self.sched.cancel(t);
        }
        st.due = now + delay;
        st.timer_gen += 1;
        let armed = st.timer_gen;
        let me = self.me.clone();
        let id = self.sched.after(
            delay,
            Box::new(move || {
                let Some(me) = me.upgrade() else { return };
                let mut st = me.state.lock();
                // A timer that was cancelled or replaced while it was already starting.
                if st.timer.is_none() || st.timer_gen != armed {
                    return;
                }
                me.flush_locked(&mut st, false);
            }),
        );
        st.timer = Some(id);
    }

    /// The window may have become shorter (the user typed, or the terminal got the focus): a pending flush armed with a
    /// longer window is moved up.
    pub fn rearm(&self) {
        let mut st = self.state.lock();
        if st.timer.is_none() || st.disposed {
            return;
        }
        let now = self.sched.now();
        if now + self.delay(&st, now) < st.due {
            self.arm(&mut st, now);
        }
    }

    /// The user typed into this terminal (its echoes are flushed faster).
    pub fn wrote(&self) {
        let mut st = self.state.lock();
        let now = self.sched.now();
        st.last_write = now;
        st.echo.keystroke(now);
        st.echo_flushes = ECHO_FLUSHES;
        if st.timer.is_some() && !st.disposed && now + self.delay(&st, now) < st.due {
            self.arm(&mut st, now);
        }
    }

    /// Sends what is buffered now. `echo`: typed output, which the window's batcher sends at once.
    pub fn flush(&self, echo: bool) {
        let mut st = self.state.lock();
        self.flush_locked(&mut st, echo);
    }

    fn flush_locked(&self, st: &mut State, echo: bool) {
        if let Some(t) = st.timer.take() {
            self.sched.cancel(t);
        }
        st.due = f64::INFINITY;
        if st.buf.is_empty() || st.disposed {
            return;
        }
        let out = std::mem::take(&mut st.buf);
        let len = out.len();
        let delivered = self.sink.data(&self.id, out, echo);
        if delivered && (self.flow)() && !st.exiting && st.gate.sent(len) {
            self.pause(st);
        }
    }

    fn pause(&self, st: &mut State) {
        self.control.pause();
        self.arm_watchdog(st);
    }

    fn arm_watchdog(&self, st: &mut State) {
        if let Some(w) = st.watchdog.take() {
            self.sched.cancel(w);
        }
        st.watchdog_gen += 1;
        let armed = st.watchdog_gen;
        let me = self.me.clone();
        let id = self.sched.after(
            PAUSE_WATCHDOG_MS,
            Box::new(move || {
                let Some(me) = me.upgrade() else { return };
                let mut st = me.state.lock();
                if st.watchdog.is_none() || st.watchdog_gen != armed {
                    return;
                }
                me.resume(&mut st, true);
            }),
        );
        st.watchdog = Some(id);
    }

    fn resume(&self, st: &mut State, force: bool) {
        if let Some(w) = st.watchdog.take() {
            self.sched.cancel(w);
        }
        if force {
            st.gate.release();
        }
        self.control.resume();
    }

    /// The renderer parsed `bytes` bytes of this terminal's output.
    pub fn ack(&self, bytes: usize) {
        let mut st = self.state.lock();
        if st.gate.acked(bytes) {
            self.resume(&mut st, false);
        } else if st.watchdog.is_some() {
            // Slow but alive: progress renews the watchdog.
            self.arm_watchdog(&mut st);
        }
    }

    /// A renderer (re)connected or flow control was switched: anything counted before is forgotten.
    pub fn reset_flow(&self) {
        let mut st = self.state.lock();
        if st.gate.reset() || st.watchdog.is_some() {
            self.resume(&mut st, false);
        }
    }

    /// Bytes sent to the renderer and not acknowledged yet.
    pub fn unacked(&self) -> usize {
        self.state.lock().gate.in_flight()
    }

    pub fn history(&self) -> Vec<u8> {
        self.state.lock().tail.bytes().to_vec()
    }

    /// The terminal has this size from now on; the replay tail records it.
    pub fn resized(&self, cols: u16, rows: u16) {
        self.state.lock().tail.size(cols, rows);
    }

    /// The replay tail with the sizes its output was written at (byte offsets).
    pub fn replay(&self) -> (Vec<u8>, Vec<ReplaySize>) {
        self.state.lock().tail.replay()
    }

    /// The replay tail handed to `send` while the channel's state is locked: a flush on another thread (reader, timer)
    /// comes either before the snapshot (its bytes are in it) or after `send` queued it, never between the two.
    pub fn replay_with(&self, send: impl FnOnce(Vec<u8>, Vec<ReplaySize>)) {
        let st = self.state.lock();
        let (data, sizes) = st.tail.replay();
        send(data, sizes);
        drop(st);
    }

    pub fn paused_or_watched(&self) -> bool {
        let st = self.state.lock();
        st.gate.paused || st.watchdog.is_some()
    }

    /// The source ended: a paused one is resumed and given EXIT_DRAIN_MS for its last output; `then` runs afterwards (or
    /// at once, on this thread).
    pub fn drain(&self, then: Box<dyn FnOnce() + Send>) {
        {
            let mut st = self.state.lock();
            if st.gate.paused || st.watchdog.is_some() {
                st.exiting = true;
                self.resume(&mut st, false);
                drop(st);
                self.sched.after(EXIT_DRAIN_MS, then);
                return;
            }
        }
        then();
    }

    pub fn dispose(&self) {
        let mut st = self.state.lock();
        st.disposed = true;
        if let Some(t) = st.timer.take() {
            self.sched.cancel(t);
        }
        if let Some(w) = st.watchdog.take() {
            self.sched.cancel(w);
        }
    }

    pub fn is_disposed(&self) -> bool {
        self.state.lock().disposed
    }
}

#[cfg(test)]
mod tests {
    //! test/output-channel.test.ts and the OutputChannel part of test/replay-sizes.test.ts, on the fake clock.
    use super::*;
    use crate::flow::{ACTIVE_WINDOW_MS, BACKGROUND_COALESCE_MS, ECHO_COALESCE_MS, ECHO_WINDOW_MS, HIGH_WATER, LOW_WATER};
    use crate::timers::ManualScheduler;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct Sink {
        sent: Mutex<Vec<(String, bool)>>,
        undelivered: AtomicBool,
    }
    impl OutputSink for Sink {
        fn data(&self, _id: &str, data: Vec<u8>, echo: bool) -> bool {
            self.sent.lock().push((String::from_utf8(data).unwrap(), echo));
            !self.undelivered.load(Ordering::SeqCst)
        }
    }
    #[derive(Default)]
    struct Control {
        pauses: AtomicUsize,
        resumes: AtomicUsize,
    }
    impl OutputControl for Control {
        fn pause(&self) {
            self.pauses.fetch_add(1, Ordering::SeqCst);
        }
        fn resume(&self) {
            self.resumes.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Setup {
        out: Arc<OutputChannel>,
        sink: Arc<Sink>,
        control: Arc<Control>,
        clock: Arc<ManualScheduler>,
    }
    impl Setup {
        fn sent(&self) -> Vec<String> {
            self.sink.sent.lock().iter().map(|s| s.0.clone()).collect()
        }
        fn echoes(&self) -> Vec<bool> {
            self.sink.sent.lock().iter().map(|s| s.1).collect()
        }
        fn pauses(&self) -> usize {
            self.control.pauses.load(Ordering::SeqCst)
        }
        fn resumes(&self) -> usize {
            self.control.resumes.load(Ordering::SeqCst)
        }
        fn advance(&self, ms: f64) {
            self.clock.advance(ms);
        }
    }

    fn setup_with(delivered: bool, flow: bool) -> Setup {
        let sink = Arc::new(Sink::default());
        sink.undelivered.store(!delivered, Ordering::SeqCst);
        let control = Arc::new(Control::default());
        // Not at 0: the aligned grid and the "never typed" (-inf) checks behave as with performance.now().
        let clock = ManualScheduler::new(10_000.0);
        let out = OutputChannel::new(
            "a",
            sink.clone(),
            control.clone(),
            Arc::new(move || flow),
            Arc::new(Focus::default()),
            clock.clone(),
        );
        Setup { out, sink, control, clock }
    }
    fn setup() -> Setup {
        setup_with(true, true)
    }

    #[test]
    fn coalesces_small_chunks_and_keeps_a_replay_tail() {
        let s = setup();
        s.out.push(b"a");
        s.out.push(b"b");
        s.advance(BACKGROUND_COALESCE_MS * 1.5);
        assert_eq!(s.sent(), vec!["ab"]);
        assert_eq!(s.out.history(), b"ab");
    }

    #[test]
    fn pauses_at_the_high_watermark_and_resumes_after_acks() {
        let s = setup();
        s.out.push(&vec![b'x'; HIGH_WATER]);
        assert_eq!(s.pauses(), 1);
        s.out.ack(HIGH_WATER - LOW_WATER);
        assert_eq!(s.resumes(), 1);
    }

    #[test]
    fn resumes_a_stuck_pause_after_the_watchdog() {
        let s = setup();
        s.out.push(&vec![b'x'; HIGH_WATER]);
        s.advance(PAUSE_WATCHDOG_MS + 1.0);
        assert!(s.resumes() >= 1);
    }

    #[test]
    fn never_pauses_while_nobody_receives_or_flow_is_off() {
        let a = setup_with(false, true);
        a.out.push(&vec![b'x'; HIGH_WATER]);
        assert_eq!(a.pauses(), 0);
        let b = setup_with(true, false);
        b.out.push(&vec![b'x'; HIGH_WATER]);
        assert_eq!(b.pauses(), 0);
    }

    #[test]
    fn drains_a_paused_source_before_reporting_its_end() {
        let s = setup();
        s.out.push(&vec![b'x'; HIGH_WATER]);
        let done = Arc::new(AtomicUsize::new(0));
        let d = done.clone();
        s.out.drain(Box::new(move || {
            d.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(s.resumes() >= 1);
        s.out.push(b"tail");
        s.advance(EXIT_DRAIN_MS);
        s.out.flush(false);
        assert_eq!(done.load(Ordering::SeqCst), 1);
        assert!(s.sent().concat().ends_with("tail"));
    }

    #[test]
    fn reports_the_end_at_once_when_not_paused_and_ignores_data_after_dispose() {
        let s = setup();
        let done = Arc::new(AtomicUsize::new(0));
        let d = done.clone();
        s.out.drain(Box::new(move || {
            d.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(done.load(Ordering::SeqCst), 1);
        s.out.dispose();
        s.out.push(b"late");
        s.advance(20.0);
        assert!(s.sent().is_empty());
    }

    #[test]
    fn the_first_output_after_a_keystroke_leaves_without_a_timer_marked_as_echo() {
        let s = setup();
        s.out.wrote();
        s.out.push(b"e");
        assert_eq!(s.sent(), vec!["e"]);
        assert_eq!(s.echoes(), vec![true]);
    }

    #[test]
    fn output_waiting_for_the_background_window_goes_with_the_echo() {
        let s = setup();
        s.out.push(b"stream ");
        s.out.wrote();
        s.out.push(b"echo");
        assert_eq!(s.sent(), vec!["stream echo"]);
        s.advance(BACKGROUND_COALESCE_MS * 2.0);
        assert_eq!(s.sent(), vec!["stream echo"]);
    }

    #[test]
    fn redraws_after_the_echo_skip_the_timer_then_coalesce_again() {
        let s = setup();
        s.out.wrote();
        for i in 0..ECHO_FLUSHES {
            s.out.push(format!("r{i}").as_bytes());
        }
        assert_eq!(s.sent(), (0..ECHO_FLUSHES).map(|i| format!("r{i}")).collect::<Vec<_>>());
        s.out.push(b"1");
        s.out.push(b"2");
        assert_eq!(s.sent().len(), ECHO_FLUSHES as usize);
        s.advance(ECHO_COALESCE_MS);
        assert_eq!(s.sent().last().unwrap(), "12");
        assert!(!s.echoes().last().unwrap());
    }

    #[test]
    fn every_keystroke_gets_its_fast_echo_when_echoes_overlap_typing() {
        let s = setup();
        s.out.wrote();
        s.advance(60.0);
        s.out.wrote();
        s.advance(60.0);
        s.out.push(b"a");
        s.advance(60.0);
        s.out.push(b"b");
        assert_eq!(s.sent(), vec!["a", "b"]);
    }

    #[test]
    fn a_keystroke_without_an_answer_does_not_make_late_output_an_echo() {
        let s = setup();
        s.out.wrote();
        s.advance(ECHO_WINDOW_MS);
        s.out.push(b"late");
        assert!(s.sent().is_empty());
        s.advance(BACKGROUND_COALESCE_MS * 1.5);
        assert_eq!(s.sent(), vec!["late"]);
    }

    #[test]
    fn learns_the_round_trip_of_a_slow_server() {
        let s = setup();
        assert_eq!(s.out.echo_window(), ECHO_WINDOW_MS);
        for i in 0..3 {
            s.out.wrote();
            s.advance(200.0);
            s.out.push(format!("k{i}").as_bytes());
            s.advance(BACKGROUND_COALESCE_MS * 2.0);
            s.advance(500.0);
        }
        assert!(s.out.echo_window() > 400.0);
        s.out.wrote();
        s.advance(200.0);
        s.out.push(b"fast");
        assert_eq!(s.sent().last().unwrap(), "fast");
    }

    #[test]
    fn every_echo_of_a_fast_typist_on_a_far_server_skips_the_timer() {
        for (gap, pause) in [(100.0, 400.0), (150.0, 1500.0)] {
            let s = setup();
            let mut keys = Vec::new();
            for word in 0..6 {
                for k in 0..6 {
                    keys.push(word as f64 * (5.0 * gap + pause) + k as f64 * gap);
                }
            }
            let mut events: Vec<(f64, usize, u8)> = keys
                .iter()
                .enumerate()
                .map(|(i, t)| (*t, i, 1))
                .chain(keys.iter().enumerate().map(|(i, t)| (t + 200.0, i, 0)))
                .collect();
            events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.2.cmp(&b.2)));
            let mut now = 0.0;
            for (t, i, key) in events {
                s.advance(t - now);
                now = t;
                if key == 1 {
                    s.out.wrote();
                } else {
                    s.out.push(format!("k{i} ").as_bytes());
                }
            }
            assert_eq!(s.sent().len(), keys.len());
            assert!(s.echoes().iter().all(|e| *e));
            assert_eq!(s.out.echo_window(), 420.0);
        }
    }

    #[test]
    fn a_seeded_round_trip_serves_the_first_key() {
        let s = setup();
        s.out.seed_echo(200.0);
        assert_eq!(s.out.echo_window(), 420.0);
        s.out.wrote();
        s.advance(200.0);
        s.out.push(b"first");
        assert_eq!(s.sent(), vec!["first"]);
        assert_eq!(s.echoes(), vec![true]);
    }

    #[test]
    fn a_keystroke_long_ago_leaves_the_background_window() {
        // The monotonic clock of 1.1.4's wall-clock-step case: a key more than ACTIVE_WINDOW_MS ago.
        let s = setup();
        s.out.wrote();
        s.advance(ACTIVE_WINDOW_MS + 1.0);
        s.out.push(b"x");
        s.advance(ECHO_COALESCE_MS + 1.0);
        assert!(s.sent().is_empty());
        s.advance(BACKGROUND_COALESCE_MS * 1.5);
        assert_eq!(s.sent(), vec!["x"]);
    }

    #[test]
    fn dispose_cancels_pending_flushes() {
        let s = setup();
        s.out.push(b"e");
        s.out.dispose();
        s.advance(100.0);
        assert!(s.sent().is_empty());
        assert_eq!(s.clock.pending(), 0);
    }

    #[test]
    fn a_focused_terminal_flushes_on_the_bulk_window() {
        let s = setup();
        s.out.focus.set(Some("a".into()));
        s.out.push(b"x");
        s.advance(crate::flow::BULK_COALESCE_MS * 1.5);
        assert_eq!(s.sent(), vec!["x"]);
    }

    /// A cell's channel and what it sent.
    type Cell = (Arc<OutputChannel>, Arc<Sink>);

    /// Two cells on one clock and one focus (test/perf-098.test.ts, "OutputChannel and the focus protocol").
    fn pair() -> (Arc<ManualScheduler>, Arc<Focus>, [Cell; 2]) {
        let clock = ManualScheduler::new(1_000_000.0);
        let focus = Arc::new(Focus::default());
        let make = |id: &str| {
            let sink = Arc::new(Sink::default());
            let out = OutputChannel::new(
                id,
                sink.clone(),
                Arc::new(Control::default()),
                Arc::new(|| true),
                focus.clone(),
                clock.clone(),
            );
            (out, sink)
        };
        let cells = [make("a"), make("b")];
        (clock, focus, cells)
    }

    fn sent_of(sink: &Sink) -> Vec<String> {
        sink.sent.lock().iter().map(|s| s.0.clone()).collect()
    }

    #[test]
    fn perf_098_the_focused_cell_flushes_on_the_short_window_and_a_background_one_on_the_long_one() {
        let (clock, focus, [(front, front_sent), (back, back_sent)]) = pair();
        focus.set(Some("a".into()));
        front.push(b"f");
        back.push(b"b");
        clock.advance(crate::flow::BULK_COALESCE_MS * 1.5);
        assert_eq!(sent_of(&front_sent), vec!["f"]);
        assert!(sent_of(&back_sent).is_empty());
        clock.advance(BACKGROUND_COALESCE_MS * 1.5);
        assert_eq!(sent_of(&back_sent), vec!["b"]);
    }

    #[test]
    fn perf_098_a_cell_that_just_got_input_is_treated_like_the_focused_one() {
        let s = setup();
        s.out.wrote();
        s.advance(400.0);
        s.out.push(b"x");
        s.advance(crate::flow::BULK_COALESCE_MS * 1.5);
        assert_eq!(s.sent(), vec!["x"]);
    }

    #[test]
    fn perf_098_the_focus_moves_a_pending_background_flush_up_and_leaves_other_cells_alone() {
        let (clock, focus, [(a, a_sent), (b, b_sent)]) = pair();
        a.push(b"A");
        b.push(b"B");
        clock.advance(1.0);
        focus.set(Some("a".into()));
        a.rearm();
        clock.advance(crate::flow::BULK_COALESCE_MS * 1.5);
        assert_eq!(sent_of(&a_sent), vec!["A"]);
        assert!(sent_of(&b_sent).is_empty());
        clock.advance(BACKGROUND_COALESCE_MS * 1.5);
        assert_eq!(sent_of(&b_sent), vec!["B"]);
    }

    #[test]
    fn focus_moves_a_background_flush_up() {
        let s = setup();
        s.out.push(b"x");
        s.out.focus.set(Some("a".into()));
        s.out.rearm();
        s.advance(crate::flow::BULK_COALESCE_MS * 1.5);
        assert_eq!(s.sent(), vec!["x"]);
    }

    // test/pty-flow.test.ts (PtyManager flow control over a fake pty): the same rules at the channel, which owns them here.
    const FLUSHED: f64 = BACKGROUND_COALESCE_MS * 1.5;
    fn output(s: &Setup, n: usize) {
        s.out.push(&vec![b'x'; n]);
        s.advance(FLUSHED);
    }

    #[test]
    fn pty_flow_pauses_resumes_and_pauses_again() {
        let s = setup();
        output(&s, HIGH_WATER);
        assert_eq!(s.pauses(), 1);
        s.out.ack(HIGH_WATER - LOW_WATER);
        assert_eq!(s.resumes(), 1);
        output(&s, HIGH_WATER);
        assert_eq!(s.pauses(), 2);
    }

    #[test]
    fn pty_flow_sends_128_kib_at_once() {
        let s = setup();
        s.out.push(&vec![b'x'; 128 * 1024]);
        assert_eq!(s.sent().len(), 1);
    }

    #[test]
    fn pty_flow_coalesces_small_chunks_into_one_message() {
        let s = setup();
        s.out.push(b"a");
        s.out.push(b"b");
        assert!(s.sent().is_empty());
        s.advance(FLUSHED);
        assert_eq!(s.sent(), vec!["ab"]);
    }

    #[test]
    fn pty_flow_watchdog_resumes_but_keeps_the_in_flight_count() {
        let s = setup();
        output(&s, HIGH_WATER);
        s.advance(3100.0);
        assert_eq!(s.resumes(), 1);
        output(&s, 10);
        assert_eq!(s.pauses(), 2);
        s.out.ack(HIGH_WATER + 10);
        assert_eq!(s.resumes(), 2);
    }

    #[test]
    fn pty_flow_every_ack_renews_the_watchdog() {
        let s = setup();
        output(&s, HIGH_WATER);
        for _ in 0..5 {
            s.advance(2000.0);
            s.out.ack(1000);
        }
        assert_eq!(s.resumes(), 0);
        s.advance(3100.0);
        assert_eq!(s.resumes(), 1);
    }

    #[test]
    fn pty_flow_never_goes_negative() {
        let s = setup();
        s.out.ack(1_000_000);
        output(&s, HIGH_WATER - 1);
        assert_eq!(s.pauses(), 0);
    }

    #[test]
    fn pty_flow_reset_lifts_a_pause_and_restarts_the_count() {
        let s = setup();
        output(&s, HIGH_WATER);
        s.out.reset_flow();
        assert_eq!(s.resumes(), 1);
        output(&s, HIGH_WATER - 1);
        assert_eq!(s.pauses(), 1);
        output(&s, 1);
        assert_eq!(s.pauses(), 2);
    }

    #[test]
    fn pty_flow_exit_while_paused_drains_then_reports() {
        let s = setup();
        output(&s, HIGH_WATER);
        let done = Arc::new(AtomicUsize::new(0));
        let (d, out) = (done.clone(), s.out.clone());
        s.out.drain(Box::new(move || {
            out.flush(false);
            out.dispose();
            d.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(s.resumes(), 1);
        assert_eq!(done.load(Ordering::SeqCst), 0);
        s.out.push(b"tail-output");
        s.advance(200.0);
        assert!(s.sent().concat().contains("tail-output"));
        assert_eq!(done.load(Ordering::SeqCst), 1);
        assert_eq!(s.clock.pending(), 0);
        // Output while draining is never paused again.
        assert_eq!(s.pauses(), 1);
    }

    #[test]
    fn pty_flow_dispose_of_a_paused_channel_clears_the_watchdog() {
        let s = setup();
        output(&s, HIGH_WATER);
        s.out.dispose();
        s.advance(5000.0);
        assert_eq!(s.resumes(), 0);
    }

    /// A real timer thread whose `after` returns late: the task is already due and running while the arming thread is
    /// still inside `after` (a preempted caller on a loaded machine).
    struct Preempted(Arc<crate::timers::ThreadScheduler>);
    impl Scheduler for Preempted {
        fn now(&self) -> f64 {
            self.0.now()
        }
        fn after(&self, _delay_ms: f64, task: crate::timers::Task) -> TimerId {
            let id = self.0.after(0.0, task);
            std::thread::sleep(std::time::Duration::from_millis(30));
            id
        }
        fn cancel(&self, id: TimerId) {
            self.0.cancel(id);
        }
    }

    fn eventually(f: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !f() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn a_timer_that_fires_before_its_arm_returned_still_flushes() {
        let sink = Arc::new(Sink::default());
        let out = OutputChannel::new(
            "a",
            sink.clone(),
            Arc::new(Control::default()),
            Arc::new(|| true),
            Arc::new(Focus::default()),
            Arc::new(Preempted(crate::timers::ThreadScheduler::new("pty-timers-preempted"))),
        );
        out.push(b"hello");
        eventually(|| !sink.sent.lock().is_empty());
        out.push(b" world");
        eventually(|| sink.sent.lock().len() >= 2);
        let sent: Vec<String> = sink.sent.lock().iter().map(|s| s.0.clone()).collect();
        assert_eq!(sent, vec!["hello", " world"]);
        // The watchdog has the same guard: the pause is still lifted.
        let control = Arc::new(Control::default());
        let paused = OutputChannel::new(
            "b",
            Arc::new(Sink::default()),
            control.clone(),
            Arc::new(|| true),
            Arc::new(Focus::default()),
            Arc::new(Preempted(crate::timers::ThreadScheduler::new("pty-timers-preempted-2"))),
        );
        paused.push(&vec![b'x'; HIGH_WATER]);
        eventually(|| control.resumes.load(Ordering::SeqCst) > 0);
        assert_eq!(control.pauses.load(Ordering::SeqCst), 1);
        assert_eq!(control.resumes.load(Ordering::SeqCst), 1);
        assert!(!paused.paused_or_watched());
    }

    #[test]
    fn replay_reports_the_sizes_its_terminal_had() {
        let s = setup_with(true, false);
        s.out.resized(33, 20);
        s.out.push(b"C:\\> echo long");
        s.out.resized(120, 30);
        s.out.push(b"\x1b[1;1H");
        let (data, sizes) = s.out.replay();
        assert_eq!(data, b"C:\\> echo long\x1b[1;1H");
        assert_eq!(sizes, vec![ReplaySize { at: 0, cols: 33, rows: 20 }, ReplaySize { at: 14, cols: 120, rows: 30 }]);
    }
}
