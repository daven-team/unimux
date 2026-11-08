//! Pure helpers of the pty output path (port of src/ptyhost/flow.ts): a bounded replay tail with the sizes it was written
//! at, renderer back-pressure (FlowGate) and the coalescing delays (EchoClock, coalesce_delay, aligned_delay).
//!
//! Units: 1.1.4 counted UTF-16 characters of the strings node-pty decoded; the Rust host never decodes, so everything here
//! counts bytes of the pty's output (PLAN P2: TailBuffer 512 KiB in bytes, byte acks). Times are milliseconds of a
//! monotonic clock (`performance.now()` in 1.1.4, [`crate::timers::Scheduler::now`] here).

/// Bytes of recent output kept per terminal to replay into a reloaded renderer (1.1.4: PTY_REPLAY_CHARS, 512 Ki chars).
pub const PTY_REPLAY_BYTES: usize = 512 * 1024;
/// Size changes a tail remembers at most (a window drag resizes many times, mostly with little output in between).
pub const MAX_TAIL_SIZES: usize = 512;

/// Bytes the renderer may be behind before the pty is paused, and the level at which it is resumed.
pub const HIGH_WATER: usize = 1024 * 1024;
pub const LOW_WATER: usize = 256 * 1024;

/// Coalescing windows (ms): typing echoes, bulk output of the cell the user works in, output of cells nobody types in.
pub const ECHO_COALESCE_MS: f64 = 4.0;
pub const BULK_COALESCE_MS: f64 = 12.0;
pub const BACKGROUND_COALESCE_MS: f64 = 33.0;
/// A buffer this large is sent at once instead of waiting for the timer (1.1.4: 128 Ki characters).
pub const FLUSH_NOW_BYTES: usize = 128 * 1024;
/// Output this soon after a keystroke counts as its echo: the window of a local shell (EchoClock widens it).
pub const ECHO_WINDOW_MS: f64 = 150.0;
/// A cell that got input this recently counts as the one the user works in, even without the focus.
pub const ACTIVE_WINDOW_MS: f64 = 1000.0;
/// The longest echo window; an answer later than this is not taken for an echo (nor measured as one).
pub const ECHO_WINDOW_MAX_MS: f64 = ACTIVE_WINDOW_MS;
/// Flushes a keystroke may send without a timer: the echo and the redraws right after it.
pub const ECHO_FLUSHES: u32 = 4;
/// Weight of the newest keystroke -> answer time in the EchoClock's average.
pub const ECHO_EWMA_WEIGHT: f64 = 0.25;

/// From byte `at` of the replayed data on, the pty had `cols` x `rows` (shared/replay.ts ReplaySize, in bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplaySize {
    pub at: usize,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SizeMark {
    pos: u64,
    cols: u16,
    rows: u16,
}

/// Keeps the newest `limit` bytes of a stream (cut forward to the start of a UTF-8 character) and the pty sizes the kept
/// output was written at.
#[derive(Debug)]
pub struct TailBuffer {
    limit: usize,
    /// The stored bytes; the kept tail is the last `min(len, limit)` of them. Trimmed to `limit` once it doubles.
    buf: Vec<u8>,
    /// Bytes ever pushed: the absolute position of the tail's end.
    total: u64,
    sizes: Vec<SizeMark>,
}

impl TailBuffer {
    pub fn new(limit: usize) -> Self {
        Self { limit, buf: Vec::new(), total: 0, sizes: Vec::new() }
    }

    /// The terminal has `cols` x `rows` from now on: what follows was written at that size.
    pub fn size(&mut self, cols: u16, rows: u16) {
        if let Some(last) = self.sizes.last() {
            if last.cols == cols && last.rows == rows {
                return;
            }
            if last.pos == self.total {
                self.sizes.pop();
            }
        }
        let differs = self.sizes.last().is_none_or(|b| b.cols != cols || b.rows != rows);
        if differs {
            self.sizes.push(SizeMark { pos: self.total, cols, rows });
        }
        self.prune_sizes();
    }

    fn kept_start(&self) -> u64 {
        self.total - self.buf.len().min(self.limit) as u64
    }

    fn prune_sizes(&mut self) {
        // Only the newest size from before the kept bytes still matters: it is the size they start at.
        let start = self.kept_start();
        while self.sizes.len() > 1 && self.sizes[1].pos <= start {
            self.sizes.remove(0);
        }
        if self.sizes.len() > MAX_TAIL_SIZES {
            let extra = self.sizes.len() - MAX_TAIL_SIZES;
            self.sizes.drain(..extra);
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        self.total += data.len() as u64;
        if data.len() >= self.limit {
            self.buf.clear();
            self.buf.extend_from_slice(&data[data.len() - self.limit..]);
        } else {
            self.buf.extend_from_slice(data);
            if self.buf.len() >= self.limit.saturating_mul(2).max(4096) {
                let extra = self.buf.len() - self.limit;
                self.buf.drain(..extra);
            }
        }
        if self.sizes.len() > 1 {
            self.prune_sizes();
        }
    }

    /// Bytes of the kept tail before the cut moves to a character start.
    fn raw(&self) -> &[u8] {
        &self.buf[self.buf.len() - self.buf.len().min(self.limit)..]
    }

    /// The newest bytes (at most `limit`), starting at a UTF-8 character: up to 3 continuation bytes at the cut are left
    /// out, so a replay never starts with the second half of a character.
    pub fn bytes(&self) -> &[u8] {
        let raw = self.raw();
        // Only a real cut (older bytes were dropped) moves; a stream that itself began mid-character is kept as it came.
        if self.total == raw.len() as u64 {
            return raw;
        }
        let skip = raw.iter().take(3).take_while(|b| (**b & 0xC0) == 0x80).count();
        &raw[skip..]
    }

    /// The tail with the sizes it was written at, as byte offsets into it (the first one at 0 when a size is known).
    pub fn replay(&self) -> (Vec<u8>, Vec<ReplaySize>) {
        let data = self.bytes().to_vec();
        let start = self.total - data.len() as u64;
        let mut sizes: Vec<ReplaySize> = Vec::new();
        for s in &self.sizes {
            let at = s.pos.saturating_sub(start) as usize;
            if sizes.last().is_some_and(|l| l.at == at) {
                sizes.pop();
            }
            sizes.push(ReplaySize { at, cols: s.cols, rows: s.rows });
        }
        (data, sizes)
    }
}

/// Counts bytes sent to the renderer but not yet parsed there (acknowledged).
#[derive(Debug, Default)]
pub struct FlowGate {
    pending: usize,
    pub paused: bool,
}

impl FlowGate {
    pub fn in_flight(&self) -> usize {
        self.pending
    }

    /// True when the pty has to be paused now.
    pub fn sent(&mut self, n: usize) -> bool {
        self.pending = self.pending.saturating_add(n);
        if !self.paused && self.pending >= HIGH_WATER {
            self.paused = true;
            return true;
        }
        false
    }

    /// True when the pty may be resumed now.
    pub fn acked(&mut self, n: usize) -> bool {
        self.pending = self.pending.saturating_sub(n);
        if self.paused && self.pending <= LOW_WATER {
            self.paused = false;
            return true;
        }
        false
    }

    /// Lifts a pause without forgetting what is in flight (the renderer is slow, not gone).
    pub fn release(&mut self) {
        self.paused = false;
    }

    /// Forgets everything in flight (renderer reconnected). True when a pause has to be lifted.
    pub fn reset(&mut self) -> bool {
        let was = self.paused;
        self.pending = 0;
        self.paused = false;
        was
    }
}

/// How long a terminal takes to answer a keystroke: a moving average of keystroke -> first output (see flow.ts EchoClock
/// for the measuring rules, kept verbatim).
#[derive(Debug, Clone)]
pub struct EchoClock {
    waiting_since: Option<f64>,
    average: Option<f64>,
    last_key: f64,
    last_output: f64,
}

impl Default for EchoClock {
    fn default() -> Self {
        Self { waiting_since: None, average: None, last_key: f64::NEG_INFINITY, last_output: f64::NEG_INFINITY }
    }
}

/// JavaScript's Math.round (halves go up).
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

impl EchoClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// The user typed at `now`.
    pub fn keystroke(&mut self, now: f64) {
        if let Some(since) = self.waiting_since
            && now - since > ECHO_WINDOW_MAX_MS
        {
            self.waiting_since = None;
        }
        if self.waiting_since.is_none()
            && now - self.last_key >= self.window()
            && now - self.last_output >= self.average.unwrap_or(0.0)
        {
            self.waiting_since = Some(now);
        }
        self.last_key = now;
    }

    /// The terminal printed something at `now`: the answer to the keystroke that waits, if any.
    pub fn output(&mut self, now: f64) {
        self.last_output = now;
        let Some(since) = self.waiting_since.take() else { return };
        let sample = now - since;
        if !(0.0..=ECHO_WINDOW_MAX_MS).contains(&sample) {
            return;
        }
        self.average = Some(match self.average {
            None => sample,
            Some(avg) => avg + (sample - avg) * ECHO_EWMA_WEIGHT,
        });
    }

    /// A first estimate before any key was measured (an SSH session: one round trip of its shell request).
    pub fn seed(&mut self, ms: f64) {
        if self.average.is_none() && (0.0..=ECHO_WINDOW_MAX_MS).contains(&ms) {
            self.average = Some(ms);
        }
    }

    /// Average keystroke -> answer time in ms (None before the first answer).
    pub fn answer_ms(&self) -> Option<f64> {
        self.average
    }

    pub fn window(&self) -> f64 {
        match self.average {
            None => ECHO_WINDOW_MS,
            Some(avg) => ECHO_WINDOW_MAX_MS.min(ECHO_WINDOW_MS.max(js_round(2.0 * avg + 20.0))),
        }
    }
}

/// The coalescing window of the next flush: `focused` = the renderer reported this terminal as the focused one,
/// `echo_window` = how long after a keystroke output still counts as its echo.
pub fn coalesce_delay(now: f64, last_write: f64, focused: bool, echo_window: f64) -> f64 {
    let since_write = now - last_write;
    if since_write < echo_window {
        return ECHO_COALESCE_MS;
    }
    if focused || since_write < ACTIVE_WINDOW_MS { BULK_COALESCE_MS } else { BACKGROUND_COALESCE_MS }
}

/// Bulk and background delays moved onto a shared grid of their own period (between half and one and a half periods),
/// so busy terminals flush in the same timer turn and their output leaves the host as one message.
pub fn aligned_delay(now: f64, delay: f64) -> f64 {
    if delay != BULK_COALESCE_MS && delay != BACKGROUND_COALESCE_MS {
        return delay;
    }
    let next = delay - (now % delay);
    if next < delay / 2.0 { next + delay } else { next }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &TailBuffer) -> String {
        String::from_utf8(t.bytes().to_vec()).unwrap()
    }

    #[test]
    fn tail_matches_the_naive_slice_for_random_chunks() {
        for limit in [1usize, 7, 100, 1000] {
            let mut buf = TailBuffer::new(limit);
            let mut naive: Vec<u8> = Vec::new();
            let mut seed: i64 = limit as i64;
            for i in 0..300 {
                seed = (seed.wrapping_mul(1103515245).wrapping_add(12345)) & 0x7fffffff;
                let chunk = vec![b'a' + (i % 26) as u8; (seed % 40) as usize];
                buf.push(&chunk);
                naive.extend_from_slice(&chunk);
                if naive.len() > limit {
                    naive.drain(..naive.len() - limit);
                }
                if i % 17 == 0 {
                    assert_eq!(buf.bytes(), &naive[..]);
                }
            }
            assert_eq!(buf.bytes(), &naive[..]);
        }
    }

    #[test]
    fn a_chunk_larger_than_the_limit_keeps_the_newest_bytes() {
        let mut buf = TailBuffer::new(4);
        buf.push(b"abcdefgh");
        assert_eq!(text(&buf), "efgh");
        buf.push(b"ij");
        assert_eq!(text(&buf), "ghij");
    }

    #[test]
    fn the_store_does_not_grow_without_bound() {
        let mut buf = TailBuffer::new(1000);
        for _ in 0..10_000 {
            buf.push(&[b'x'; 100]);
        }
        assert!(buf.buf.len() <= 4096 + 100, "{}", buf.buf.len());
        assert_eq!(buf.bytes().len(), 1000);
    }

    #[test]
    fn empty_pushes_are_ignored() {
        let mut buf = TailBuffer::new(5);
        buf.push(b"");
        assert_eq!(text(&buf), "");
    }

    #[test]
    fn the_cut_moves_to_the_start_of_a_character() {
        // "zażółć" is 10 bytes; cut 7 from the end: "żółć" would start inside "ż"? Check every limit.
        let s = "zażółć gęślą jaźń".as_bytes();
        for limit in 1..=s.len() {
            let mut buf = TailBuffer::new(limit);
            buf.push(s);
            let kept = buf.bytes();
            assert!(std::str::from_utf8(kept).is_ok(), "limit {limit}: {kept:?}");
            assert!(kept.len() <= limit && kept.len() + 3 >= limit.min(s.len()));
            assert!(s.ends_with(kept));
        }
        // Pushed in pieces split inside characters: the same.
        for limit in 1..=s.len() {
            let mut buf = TailBuffer::new(limit);
            for piece in s.chunks(3) {
                buf.push(piece);
            }
            assert!(std::str::from_utf8(buf.bytes()).is_ok(), "limit {limit}");
        }
        // Nothing was cut: an incomplete start (a stream that began mid-character) is kept as it came.
        let mut buf = TailBuffer::new(100);
        buf.push(&[0x80, b'a']);
        assert_eq!(buf.bytes(), &[0x80, b'a']);
    }

    #[test]
    fn many_tiny_chunks_keep_the_same_text() {
        let mut buf = TailBuffer::new(100_000);
        let mut naive = String::new();
        for i in 0..5000 {
            let piece = format!("x{}", i % 10);
            buf.push(piece.as_bytes());
            naive.push_str(&piece);
        }
        assert_eq!(text(&buf), naive[naive.len() - 10_000.min(naive.len())..]);
        let mut small = TailBuffer::new(50);
        let mut tail = String::new();
        for i in 0..2000 {
            let piece = i.to_string();
            small.push(piece.as_bytes());
            tail.push_str(&piece);
            if tail.len() > 50 {
                tail.drain(..tail.len() - 50);
            }
        }
        assert_eq!(text(&small), tail);
    }

    #[test]
    fn flow_gate_pauses_at_the_high_watermark_and_resumes_at_the_low_one() {
        let mut g = FlowGate::default();
        assert!(!g.sent(HIGH_WATER - 1));
        assert!(g.sent(1));
        assert!(g.paused);
        assert!(!g.sent(500));
        assert!(!g.acked(HIGH_WATER - LOW_WATER - 1));
        assert!(g.acked(600));
        assert!(!g.paused);
    }

    #[test]
    fn flow_gate_never_goes_negative() {
        let mut g = FlowGate::default();
        assert!(!g.acked(10_000));
        assert_eq!(g.in_flight(), 0);
        assert!(!g.sent(10));
        assert_eq!(g.in_flight(), 10);
    }

    #[test]
    fn release_lifts_a_pause_but_keeps_the_count() {
        let mut g = FlowGate::default();
        g.sent(HIGH_WATER);
        g.release();
        assert!(!g.paused);
        assert_eq!(g.in_flight(), HIGH_WATER);
        assert!(g.sent(1));
    }

    #[test]
    fn reset_reports_a_pause_that_has_to_be_lifted() {
        let mut g = FlowGate::default();
        g.sent(HIGH_WATER);
        assert!(g.reset());
        assert!(!g.paused);
        assert!(!g.reset());
        assert!(!g.sent(HIGH_WATER - 1));
    }

    #[test]
    fn coalesce_delay_is_short_after_typing_and_longer_for_bulk() {
        assert_eq!(coalesce_delay(1000.0, 900.0, true, ECHO_WINDOW_MS), ECHO_COALESCE_MS);
        assert_eq!(coalesce_delay(1000.0, 900.0, false, ECHO_WINDOW_MS), ECHO_COALESCE_MS);
        assert_eq!(coalesce_delay(1000.0, 100.0, true, ECHO_WINDOW_MS), BULK_COALESCE_MS);
        assert_eq!(coalesce_delay(1000.0, f64::NEG_INFINITY, true, ECHO_WINDOW_MS), BULK_COALESCE_MS);
        assert_eq!(coalesce_delay(1000.0, f64::NEG_INFINITY, false, ECHO_WINDOW_MS), BACKGROUND_COALESCE_MS);
        assert_eq!(coalesce_delay(1000.0, 700.0, true, ECHO_WINDOW_MS), BULK_COALESCE_MS);
        assert_eq!(coalesce_delay(1000.0, 700.0, true, 420.0), ECHO_COALESCE_MS);
        assert_eq!(coalesce_delay(1000.0, 500.0, true, 420.0), BULK_COALESCE_MS);
    }

    fn type_answered(clock: &mut EchoClock, start: f64, keys: usize, answer: f64, gap: f64) -> f64 {
        let mut t = start;
        for _ in 0..keys {
            clock.keystroke(t);
            clock.output(t + answer);
            t += gap;
        }
        t
    }

    #[test]
    fn echo_clock_keeps_the_local_window_for_quick_terminals() {
        let mut clock = EchoClock::new();
        assert_eq!(clock.window(), ECHO_WINDOW_MS);
        type_answered(&mut clock, 0.0, 20, 3.0, 1000.0);
        assert!((clock.answer_ms().unwrap() - 3.0).abs() < 0.01);
        assert_eq!(clock.window(), ECHO_WINDOW_MS);
        let mut nearby = EchoClock::new();
        type_answered(&mut nearby, 0.0, 20, 60.0, 1000.0);
        assert_eq!(nearby.window(), ECHO_WINDOW_MS);
    }

    #[test]
    fn echo_clock_widens_for_a_slow_server_and_narrows_again() {
        let mut clock = EchoClock::new();
        let mut t = type_answered(&mut clock, 0.0, 1, 200.0, 1000.0);
        assert_eq!(clock.window(), 420.0);
        t = type_answered(&mut clock, t, 30, 120.0, 1000.0);
        assert!((clock.answer_ms().unwrap() - 120.0).abs() < 0.5);
        assert!(clock.window() > 170.0);
        type_answered(&mut clock, t, 30, 5.0, 1000.0);
        assert_eq!(clock.window(), ECHO_WINDOW_MS);
    }

    fn bursts(words: usize, per_word: usize, gap: f64, pause: f64) -> Vec<f64> {
        let mut keys = Vec::new();
        let mut t = 0.0;
        for _ in 0..words {
            for k in 0..per_word {
                keys.push(t + k as f64 * gap);
            }
            t += (per_word - 1) as f64 * gap + pause;
        }
        keys
    }

    fn type_overlapping(clock: &mut EchoClock, keys: &[f64], answer: f64) -> usize {
        let mut events: Vec<(f64, u8)> = keys.iter().map(|t| (*t, 1)).chain(keys.iter().map(|t| (t + answer, 0))).collect();
        events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
        let (mut last_key, mut late) = (f64::NEG_INFINITY, 0);
        for (t, key) in events {
            if key == 1 {
                clock.keystroke(t);
                last_key = t;
                continue;
            }
            if t - last_key >= clock.window() {
                late += 1;
            }
            clock.output(t);
        }
        late
    }

    #[test]
    fn echo_clock_learns_the_round_trip_of_a_fast_typist() {
        for (answer, gap, pause) in [
            (160.0, 120.0, 1500.0),
            (160.0, 150.0, 1500.0),
            (200.0, 150.0, 1500.0),
            (250.0, 120.0, 1500.0),
            (300.0, 120.0, 1500.0),
            (200.0, 100.0, 400.0),
        ] {
            let mut clock = EchoClock::new();
            let late = type_overlapping(&mut clock, &bursts(10, 8, gap, pause), answer);
            assert_eq!(late, 0, "{answer} {gap} {pause}");
            assert_eq!(clock.answer_ms(), Some(answer));
            assert_eq!(clock.window(), 2.0 * answer + 20.0);
        }
    }

    #[test]
    fn echo_clock_measures_only_keys_after_a_pause() {
        let mut clock = EchoClock::new();
        clock.keystroke(0.0);
        clock.keystroke(150.0);
        clock.output(200.0);
        clock.keystroke(300.0);
        clock.output(350.0);
        clock.output(500.0);
        assert_eq!(clock.answer_ms(), Some(200.0));
        clock.keystroke(1300.0);
        clock.output(1490.0);
        assert!((clock.answer_ms().unwrap() - 197.5).abs() < 1e-9);
    }

    #[test]
    fn echo_clock_ignores_keys_into_a_terminal_printing_on_its_own() {
        let mut clock = EchoClock::new();
        type_answered(&mut clock, 0.0, 1, 200.0, 1000.0);
        let mut t = 2050.0;
        while t < 20_000.0 {
            let mut frame = t - 1000.0;
            while frame < t {
                clock.output(frame);
                frame += 90.0;
            }
            clock.keystroke(t);
            clock.output(t + 40.0);
            t += 1000.0;
        }
        assert_eq!(clock.answer_ms(), Some(200.0));
    }

    #[test]
    fn echo_clock_caps_the_window_and_skips_late_output() {
        let mut clock = EchoClock::new();
        clock.keystroke(0.0);
        clock.output(5000.0);
        assert_eq!(clock.answer_ms(), None);
        clock.keystroke(6000.0);
        clock.keystroke(6000.0 + ECHO_WINDOW_MAX_MS + 1.0);
        clock.output(6000.0 + ECHO_WINDOW_MAX_MS + 101.0);
        assert_eq!(clock.answer_ms(), Some(100.0));
        type_answered(&mut clock, 20_000.0, 50, ECHO_WINDOW_MAX_MS - 1.0, 2.0 * ECHO_WINDOW_MAX_MS);
        assert_eq!(clock.window(), ECHO_WINDOW_MAX_MS);
    }

    #[test]
    fn echo_clock_ignores_an_answer_before_its_key() {
        let mut clock = EchoClock::new();
        type_answered(&mut clock, 0.0, 1, 200.0, 1000.0);
        clock.keystroke(5000.0);
        clock.output(1000.0);
        assert_eq!(clock.answer_ms(), Some(200.0));
    }

    #[test]
    fn echo_clock_starts_from_a_seed() {
        let mut clock = EchoClock::new();
        clock.seed(-1.0);
        clock.seed(ECHO_WINDOW_MAX_MS + 1.0);
        assert_eq!(clock.answer_ms(), None);
        clock.seed(200.0);
        assert_eq!(clock.window(), 420.0);
        type_answered(&mut clock, 0.0, 1, 100.0, 1000.0);
        assert_eq!(clock.answer_ms(), Some(175.0));
        clock.seed(5.0);
        assert_eq!(clock.answer_ms(), Some(175.0));
    }

    /// The vectors of test/perf-098.test.ts ("output coalescing window").
    #[test]
    fn perf_098_windows_echo_bulk_and_background_on_their_own_grid() {
        let echo = ECHO_WINDOW_MS;
        // the echo window right after typing, focused or not
        assert_eq!(coalesce_delay(10_000.0, 9_950.0, false, echo), ECHO_COALESCE_MS);
        assert_eq!(coalesce_delay(10_000.0, 9_950.0, true, echo), ECHO_COALESCE_MS);
        // the short bulk window for the focused cell and a cell typed into within the last second
        assert_eq!(coalesce_delay(10_000.0, f64::NEG_INFINITY, true, echo), BULK_COALESCE_MS);
        assert_eq!(coalesce_delay(10_000.0, 10_000.0 - ACTIVE_WINDOW_MS + 1.0, false, echo), BULK_COALESCE_MS);
        // longer for cells nobody types in
        assert!((30.0..=40.0).contains(&BACKGROUND_COALESCE_MS));
        assert_eq!(coalesce_delay(10_000.0, f64::NEG_INFINITY, false, echo), BACKGROUND_COALESCE_MS);
        assert_eq!(coalesce_delay(10_000.0, 10_000.0 - ACTIVE_WINDOW_MS, false, echo), BACKGROUND_COALESCE_MS);
        // background flushes on their own shared grid
        for now in 0..100 {
            let now = now as f64;
            let delay = aligned_delay(now, BACKGROUND_COALESCE_MS);
            assert_eq!((now + delay) % BACKGROUND_COALESCE_MS, 0.0);
            assert!((BACKGROUND_COALESCE_MS / 2.0..=BACKGROUND_COALESCE_MS * 1.5).contains(&delay));
        }
    }

    #[test]
    fn aligned_delay_puts_bulk_flushes_on_a_grid() {
        assert_eq!(aligned_delay(1000.0, ECHO_COALESCE_MS), ECHO_COALESCE_MS);
        for now in 0..50 {
            let now = now as f64;
            let delay = aligned_delay(now, BULK_COALESCE_MS);
            assert_eq!((now + delay) % BULK_COALESCE_MS, 0.0);
            assert!((BULK_COALESCE_MS / 2.0..=BULK_COALESCE_MS * 1.5).contains(&delay));
        }
    }

    // replay-sizes.test.ts, TailBuffer sizes (byte offsets; ASCII, so the same numbers as the TS character offsets).
    fn rs(at: usize, cols: u16, rows: u16) -> ReplaySize {
        ReplaySize { at, cols, rows }
    }

    #[test]
    fn sizes_are_recorded_at_their_position() {
        let mut t = TailBuffer::new(1000);
        t.size(33, 20);
        t.push(b"narrow ");
        t.size(33, 20);
        t.push(b"output");
        t.size(100, 30);
        t.push(b"wide");
        assert_eq!(t.replay(), (b"narrow outputwide".to_vec(), vec![rs(0, 33, 20), rs(13, 100, 30)]));
    }

    #[test]
    fn of_several_sizes_without_output_the_last_is_kept() {
        let mut t = TailBuffer::new(1000);
        t.size(33, 20);
        t.push(b"a");
        t.size(40, 20);
        t.size(50, 20);
        t.size(60, 20);
        t.push(b"b");
        assert_eq!(t.replay().1, vec![rs(0, 33, 20), rs(1, 60, 20)]);
    }

    #[test]
    fn a_size_back_to_the_previous_one_cancels_out() {
        let mut t = TailBuffer::new(1000);
        t.size(33, 20);
        t.push(b"a");
        t.size(40, 20);
        t.size(33, 20);
        t.push(b"b");
        assert_eq!(t.replay().1, vec![rs(0, 33, 20)]);
    }

    #[test]
    fn the_size_where_a_trimmed_tail_starts_moves_to_its_start() {
        let mut t = TailBuffer::new(10);
        t.size(33, 20);
        t.push(b"0123456789");
        t.size(80, 24);
        t.push(b"abcdef");
        t.size(90, 24);
        t.push(b"ghij");
        assert_eq!(t.replay(), (b"abcdefghij".to_vec(), vec![rs(0, 80, 24), rs(6, 90, 24)]));
    }

    #[test]
    fn a_partly_trimmed_size_still_applies_from_the_start() {
        let mut t = TailBuffer::new(4);
        t.size(33, 20);
        t.push(b"0123456789");
        assert_eq!(t.replay(), (b"6789".to_vec(), vec![rs(0, 33, 20)]));
    }

    #[test]
    fn a_bounded_number_of_sizes_is_kept() {
        let mut t = TailBuffer::new(1_000_000);
        for i in 0..MAX_TAIL_SIZES * 2 {
            t.size(20 + (i % 50) as u16, 10 + (i % 7) as u16);
            t.push(b"x");
        }
        assert!(t.replay().1.len() <= MAX_TAIL_SIZES);
    }

    #[test]
    fn no_size_known_none_is_reported() {
        let mut t = TailBuffer::new(100);
        t.push(b"abc");
        assert_eq!(t.replay(), (b"abc".to_vec(), vec![]));
    }

    #[test]
    fn a_size_after_a_cut_character_is_relative_to_the_kept_start() {
        // "ż" (2 bytes) cut in half by the limit: the kept tail starts after it and the size offsets follow.
        let mut t = TailBuffer::new(6);
        t.size(10, 5);
        t.push("aż".as_bytes()); // a, c5, bc
        t.push(b"bcd");
        t.size(20, 5);
        t.push(b"e");
        // 7 bytes: a c5 bc b c d e; limit 6 keeps c5 bc b c d e (whole ż); limit 5 would cut it.
        assert_eq!(t.replay(), ("żbcde".as_bytes().to_vec(), vec![rs(0, 10, 5), rs(5, 20, 5)]));
        let mut t = TailBuffer::new(5);
        t.size(10, 5);
        t.push("aż".as_bytes());
        t.push(b"bcd");
        t.size(20, 5);
        t.push(b"e");
        assert_eq!(t.replay(), (b"bcde".to_vec(), vec![rs(0, 10, 5), rs(3, 20, 5)]));
    }
}
