//! `ItemThrottle` (sftphost/throttle.ts): coalesces item updates for the transfer port. A state change goes out at once
//! (on the next turn), progress of one item at most every `interval` ms (about 10 a second), always with the latest
//! values. Updates of one turn travel as one `items` message.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::Value;

use crate::timers::{TimerId, Timers};

pub type SendItems = Box<dyn Fn(Vec<Value>) + Send + Sync>;
pub type Now = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Default)]
struct State {
    dirty: IndexMap<String, (Value, bool)>,
    last_sent: HashMap<String, i64>,
    timer: Option<TimerId>,
    immediate: Option<TimerId>,
}

pub struct ItemThrottle {
    me: Weak<ItemThrottle>,
    send: SendItems,
    interval: i64,
    now: Now,
    timers: Arc<dyn Timers>,
    state: Mutex<State>,
}

fn id_of(item: &Value) -> String {
    item.get("id").and_then(Value::as_str).unwrap_or_default().to_string()
}

impl ItemThrottle {
    pub fn new(send: SendItems, interval_ms: u64, now: Now, timers: Arc<dyn Timers>) -> Arc<ItemThrottle> {
        Arc::new_cyclic(|me| ItemThrottle {
            me: me.clone(),
            send,
            interval: interval_ms as i64,
            now,
            timers,
            state: Mutex::new(State::default()),
        })
    }

    /// A changed item (the full object); `force`: a state change, sent on the next turn whatever the interval.
    pub fn push(&self, item: Value, force: bool) {
        let id = id_of(&item);
        let mut st = self.state.lock();
        let prev_force = st.dirty.get(&id).is_some_and(|(_, f)| *f);
        // A newer value replaces the older one in place (the message keeps the first change's order).
        st.dirty.insert(id.clone(), (item, force || prev_force));
        if force {
            self.flush_soon(&mut st);
            return;
        }
        match st.last_sent.get(&id) {
            Some(last) if self.now() - last < self.interval => {
                let wait = self.interval - (self.now() - last);
                self.arm(&mut st, wait);
            }
            _ => self.flush_soon(&mut st),
        }
    }

    /// Items that left the queue: no update of theirs goes out any more.
    pub fn forget(&self, ids: &[String]) {
        let mut st = self.state.lock();
        for id in ids {
            st.dirty.shift_remove(id);
            st.last_sent.remove(id);
        }
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    fn flush_soon(&self, st: &mut State) {
        if st.immediate.is_some() {
            return;
        }
        let me = self.me.clone();
        st.immediate = Some(self.timers.after(
            0,
            Box::new(move || {
                if let Some(t) = me.upgrade() {
                    t.state.lock().immediate = None;
                    t.flush();
                }
            }),
        ));
    }

    fn arm(&self, st: &mut State, ms: i64) {
        if st.timer.is_some() {
            return;
        }
        let me = self.me.clone();
        st.timer = Some(self.timers.after(
            ms.max(1) as u64,
            Box::new(move || {
                if let Some(t) = me.upgrade() {
                    t.state.lock().timer = None;
                    t.flush();
                }
            }),
        ));
    }

    /// Sends what is due now and arms the timer for the rest. The message goes out under the lock, so two flushes never
    /// overtake each other.
    pub fn flush(&self) {
        let now = self.now();
        let mut st = self.state.lock();
        let mut out = Vec::new();
        let mut wait: Option<i64> = None;
        let ids: Vec<String> = st.dirty.keys().cloned().collect();
        for id in ids {
            let force = st.dirty.get(&id).is_some_and(|(_, f)| *f);
            let since = st.last_sent.get(&id).map(|l| now - l);
            if force || since.is_none_or(|s| s >= self.interval) {
                if let Some((item, _)) = st.dirty.shift_remove(&id) {
                    out.push(item);
                }
                st.last_sent.insert(id, now);
            } else if let Some(s) = since {
                let w = self.interval - s;
                wait = Some(wait.map_or(w, |x| x.min(w)));
            }
        }
        if !out.is_empty() {
            (self.send)(out);
        }
        if let Some(w) = wait {
            self.arm(&mut st, w);
        }
    }

    pub fn dispose(&self) {
        let mut st = self.state.lock();
        for id in [st.timer.take(), st.immediate.take()].into_iter().flatten() {
            self.timers.cancel(id);
        }
        st.dirty.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timers::ManualTimers;
    use serde_json::json;
    use std::sync::atomic::{AtomicI64, Ordering};

    type Sent = Arc<Mutex<Vec<Vec<Value>>>>;

    fn setup() -> (Arc<ItemThrottle>, Arc<ManualTimers>, Arc<AtomicI64>, Sent) {
        let timers = Arc::new(ManualTimers::default());
        let clock = Arc::new(AtomicI64::new(1000));
        let sent = Arc::new(Mutex::new(Vec::new()));
        let (c, s) = (clock.clone(), sent.clone());
        let t = ItemThrottle::new(
            Box::new(move |items| s.lock().push(items)),
            100,
            Arc::new(move || c.load(Ordering::SeqCst)),
            timers.clone(),
        );
        (t, timers, clock, sent)
    }

    fn item(id: &str, done: u64) -> Value {
        json!({ "id": id, "bytesDone": done })
    }

    #[test]
    fn updates_of_one_turn_go_out_together_and_progress_at_most_every_interval() {
        let (t, timers, clock, sent) = setup();
        t.push(item("a", 1), false);
        t.push(item("b", 1), false);
        t.push(item("a", 2), false);
        assert_eq!(timers.live(), vec![0]);
        timers.fire_all();
        assert_eq!(*sent.lock(), vec![vec![item("a", 2), item("b", 1)]]);
        // Progress 40 ms later waits for the rest of the interval, then goes out with the latest value.
        clock.fetch_add(40, Ordering::SeqCst);
        t.push(item("a", 3), false);
        t.push(item("a", 4), false);
        assert_eq!(timers.live(), vec![60]);
        clock.fetch_add(60, Ordering::SeqCst);
        timers.fire_all();
        assert_eq!(sent.lock().last().unwrap(), &vec![item("a", 4)]);
    }

    #[test]
    fn a_state_change_is_not_held_back_and_forgotten_items_never_go_out() {
        let (t, timers, clock, sent) = setup();
        t.push(item("a", 1), false);
        timers.fire_all();
        clock.fetch_add(10, Ordering::SeqCst);
        t.push(json!({ "id": "a", "state": "done" }), true);
        t.push(item("b", 1), false);
        t.forget(&["b".to_string()]);
        timers.fire(0);
        assert_eq!(sent.lock().last().unwrap(), &vec![json!({ "id": "a", "state": "done" })]);
        assert_eq!(sent.lock().len(), 2);
        t.push(item("c", 1), false);
        t.dispose();
        assert_eq!(timers.fire_all(), 0);
        assert_eq!(sent.lock().len(), 2);
    }
}
