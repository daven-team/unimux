//! Port of src/main/stateBroadcast.ts: `state:changed`. Changes marked `batch` (an agent's MCP call) wait up to 16 ms and go
//! out as one patch against the last state sent; every other change is sent at once and takes a waiting batch with it.
//! `flush` sends what waits (it runs before any other event leaves, see unimux_ipc::Events::before_emit).

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::controller::Snapshot;
use crate::patch::state_change;

pub const STATE_BATCH: Duration = Duration::from_millis(16);

type SendFn = Arc<dyn Fn(Value) + Send + Sync>;

struct Inner {
    /// What the windows have: the last change sent.
    sent: Snapshot,
    pending: Option<Snapshot>,
    waiting: usize,
    timer_armed: bool,
}

pub struct StateBroadcaster {
    inner: Arc<Mutex<Inner>>,
    send: SendFn,
    delay: Duration,
}

impl StateBroadcaster {
    pub fn new(initial: Snapshot, send: SendFn) -> Arc<Self> {
        Self::with_delay(initial, send, STATE_BATCH)
    }

    pub fn with_delay(initial: Snapshot, send: SendFn, delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(Mutex::new(Inner { sent: initial, pending: None, waiting: 0, timer_armed: false })),
            send,
            delay,
        })
    }

    fn send_up_to(inner: &mut Inner, snapshot: Snapshot, send: &SendFn) {
        let base = std::mem::replace(&mut inner.sent, snapshot.clone());
        inner.pending = None;
        inner.waiting = 0;
        let change = state_change(&base.state, &snapshot.state, snapshot.revision, base.revision, snapshot.edit_id.as_deref());
        send(change);
    }

    /// A change applied by the controller; `batch` lets it wait for the next ones.
    pub fn changed(self: &Arc<Self>, snapshot: &Snapshot, batch: bool) {
        let mut inner = self.inner.lock();
        if !batch {
            Self::send_up_to(&mut inner, snapshot.clone(), &self.send);
            return;
        }
        inner.pending = Some(snapshot.clone());
        inner.waiting += 1;
        if !inner.timer_armed {
            inner.timer_armed = true;
            let me = self.clone();
            let delay = self.delay;
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                let mut inner = me.inner.lock();
                inner.timer_armed = false;
                if let Some(p) = inner.pending.take() {
                    Self::send_up_to(&mut inner, p, &me.send);
                }
            });
        }
    }

    /// Sends a waiting batch now (no-op when nothing waits).
    pub fn flush(&self) {
        let mut inner = self.inner.lock();
        if let Some(p) = inner.pending.take() {
            Self::send_up_to(&mut inner, p, &self.send);
        }
    }

    /// Changes waiting to be sent (tests).
    pub fn waiting(&self) -> usize {
        self.inner.lock().waiting
    }

    /// A full snapshot message (`{full: snapshot}`), for a window that fell behind.
    pub fn full(snapshot: &Snapshot) -> Value {
        json!({ "full": snapshot.to_json() })
    }
}

#[cfg(test)]
mod tests {
    //! Cases of test/state-broadcast.test.ts.
    use super::*;

    fn snap(rev: u64, v: Value) -> Snapshot {
        Snapshot { state: Arc::new(v), revision: rev, edit_id: None }
    }

    fn recorder() -> (Arc<Mutex<Vec<Value>>>, SendFn) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let s = sent.clone();
        (sent, Arc::new(move |v| s.lock().push(v)))
    }

    #[test]
    fn immediate_changes_go_out_at_once() {
        let (sent, send) = recorder();
        let b = StateBroadcaster::new(snap(0, json!({"a": 0})), send);
        b.changed(&snap(1, json!({"a": 1})), false);
        assert_eq!(*sent.lock(), vec![json!({"revision": 1, "base": 0, "patch": {"o": {"a": {"v": 1}}}})]);
    }

    #[test]
    fn batched_changes_coalesce_and_an_immediate_one_takes_them_along() {
        let (sent, send) = recorder();
        let b = StateBroadcaster::with_delay(snap(0, json!({"a": 0})), send, Duration::from_secs(10));
        b.changed(&snap(1, json!({"a": 1})), true);
        b.changed(&snap(2, json!({"a": 2})), true);
        assert_eq!(b.waiting(), 2);
        assert!(sent.lock().is_empty());
        b.changed(&snap(3, json!({"a": 3, "b": 1})), false);
        assert_eq!(*sent.lock(), vec![json!({"revision": 3, "base": 0, "patch": {"o": {"a": {"v": 3}, "b": {"v": 1}}}})]);
        assert_eq!(b.waiting(), 0);
    }

    #[test]
    fn flush_sends_what_waits_and_the_timer_does_too() {
        let (sent, send) = recorder();
        let b = StateBroadcaster::with_delay(snap(0, json!({"a": 0})), send, Duration::from_millis(16));
        b.changed(&snap(1, json!({"a": 1})), true);
        b.flush();
        assert_eq!(sent.lock().len(), 1);
        b.flush();
        assert_eq!(sent.lock().len(), 1);
        b.changed(&snap(2, json!({"a": 2})), true);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(sent.lock()[1], json!({"revision": 2, "base": 1, "patch": {"o": {"a": {"v": 2}}}}));
    }
}
