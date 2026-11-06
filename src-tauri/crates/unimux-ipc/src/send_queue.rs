//! `ipcRenderer.send` ordering. Tauri runs invokes concurrently, so the bridge numbers every send of a page load (`session`,
//! `seq` from 1) and this queue hands them to the router strictly in that order, one at a time per window. A sequence number
//! that never arrives (a call lost while the page unloaded) holds the window's later sends for at most `gap_timeout`, then
//! they run anyway. A new session of a window (a reload) starts over.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::mpsc;

/// One delivery: the item queued by the caller.
type Deliver<T> = Arc<dyn Fn(T) -> futures::future::BoxFuture<'static, ()> + Send + Sync>;

struct Lane<T> {
    session: String,
    next: u64,
    pending: BTreeMap<u64, T>,
    tx: mpsc::UnboundedSender<T>,
    /// Bumped whenever the lane moves on; a gap timer only acts when nothing moved since it was armed.
    epoch: u64,
}

/// Ordered per-window delivery of fire-and-forget calls.
pub struct SendQueue<T: Send + 'static> {
    lanes: Arc<Mutex<HashMap<String, Lane<T>>>>,
    deliver: Deliver<T>,
    gap_timeout: Duration,
}

impl<T: Send + 'static> SendQueue<T> {
    pub fn new(gap_timeout: Duration, deliver: Deliver<T>) -> Self {
        Self { lanes: Arc::new(Mutex::new(HashMap::new())), deliver, gap_timeout }
    }

    /// Queues `item` with its sequence number. Must run inside a tokio runtime.
    pub fn submit(&self, label: &str, session: &str, seq: u64, item: T) {
        let mut lanes = self.lanes.lock();
        match lanes.get_mut(label) {
            None => {
                let (tx, mut rx) = mpsc::unbounded_channel::<T>();
                let deliver = self.deliver.clone();
                // One worker per window: deliveries run one after another, in order, across reloads too.
                tokio::spawn(async move {
                    while let Some(item) = rx.recv().await {
                        deliver(item).await;
                    }
                });
                lanes.insert(
                    label.to_string(),
                    Lane { session: session.to_string(), next: 1, pending: BTreeMap::new(), tx, epoch: 0 },
                );
            }
            Some(lane) if lane.session != session => {
                // A reload: the new page numbers from 1; what the old page left undelivered (gaps) is dropped.
                lane.session = session.to_string();
                lane.next = 1;
                lane.pending.clear();
                lane.epoch += 1;
            }
            Some(_) => {}
        }
        let lane = lanes.get_mut(label).expect("lane exists");
        if seq < lane.next {
            return; // a duplicate of something already delivered
        }
        lane.pending.insert(seq, item);
        Self::drain(lane);
        if !lane.pending.is_empty() {
            self.arm_gap_timer(label, lane.epoch);
        }
    }

    fn drain(lane: &mut Lane<T>) {
        while let Some(item) = lane.pending.remove(&lane.next) {
            let _ = lane.tx.send(item);
            lane.next += 1;
            lane.epoch += 1;
        }
    }

    fn arm_gap_timer(&self, label: &str, epoch: u64) {
        let lanes = self.lanes.clone();
        let label = label.to_string();
        let timeout = self.gap_timeout;
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            let mut lanes = lanes.lock();
            let Some(lane) = lanes.get_mut(&label) else { return };
            if lane.epoch != epoch || lane.pending.is_empty() {
                return;
            }
            // Skip the missing numbers up to the first one that arrived.
            if let Some((&first, _)) = lane.pending.iter().next() {
                lane.next = first;
                lane.epoch += 1;
                Self::drain(lane);
            }
        });
    }

    /// Forgets a closed window's lane.
    pub fn forget(&self, label: &str) {
        self.lanes.lock().remove(label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Seen = Arc<Mutex<Vec<(String, u64)>>>;

    fn collecting() -> (Seen, Deliver<(String, u64)>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let deliver: Deliver<(String, u64)> = Arc::new(move |item| {
            let s = s.clone();
            Box::pin(async move {
                // A delivery that takes a moment must still not be overtaken by the next one.
                tokio::task::yield_now().await;
                s.lock().push(item);
            })
        });
        (seen, deliver)
    }

    #[tokio::test]
    async fn thousand_interleaved_sends_from_two_windows_arrive_in_order_per_window() {
        let (seen, deliver) = collecting();
        let q = Arc::new(SendQueue::new(Duration::from_secs(5), deliver));
        // Submitted from many tasks in a scrambled order, as concurrent Tauri invokes would arrive.
        let mut order: Vec<(String, u64)> =
            (1..=500).flat_map(|i| [("main".to_string(), i), ("detached-a".to_string(), i)]).collect();
        let mut x: u64 = 7;
        for i in (1..order.len()).rev() {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            order.swap(i, (x >> 33) as usize % (i + 1));
        }
        let mut tasks = Vec::new();
        for (label, seq) in order {
            let q = q.clone();
            tasks.push(tokio::spawn(async move { q.submit(&label, "s1", seq, (label.clone(), seq)) }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        for _ in 0..200 {
            if seen.lock().len() == 1000 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let seen = seen.lock();
        assert_eq!(seen.len(), 1000);
        for label in ["main", "detached-a"] {
            let seqs: Vec<u64> = seen.iter().filter(|(l, _)| l == label).map(|(_, s)| *s).collect();
            assert_eq!(seqs, (1..=500).collect::<Vec<_>>(), "{label}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_lost_number_holds_later_sends_only_until_the_gap_timeout() {
        let (seen, deliver) = collecting();
        let q = SendQueue::new(Duration::from_millis(2000), deliver);
        q.submit("main", "s1", 1, ("main".into(), 1));
        q.submit("main", "s1", 3, ("main".into(), 3));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(seen.lock().iter().map(|x| x.1).collect::<Vec<_>>(), vec![1]);
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert_eq!(seen.lock().iter().map(|x| x.1).collect::<Vec<_>>(), vec![1, 3]);
        // A late 2 is dropped (it was skipped), 4 follows at once.
        q.submit("main", "s1", 2, ("main".into(), 2));
        q.submit("main", "s1", 4, ("main".into(), 4));
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(seen.lock().iter().map(|x| x.1).collect::<Vec<_>>(), vec![1, 3, 4]);
    }

    #[tokio::test]
    async fn a_reload_starts_a_new_session() {
        let (seen, deliver) = collecting();
        let q = SendQueue::new(Duration::from_secs(5), deliver);
        q.submit("main", "s1", 1, ("main".into(), 1));
        q.submit("main", "s2", 1, ("main".into(), 10));
        q.submit("main", "s2", 2, ("main".into(), 11));
        for _ in 0..100 {
            if seen.lock().len() == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(seen.lock().iter().map(|x| x.1).collect::<Vec<_>>(), vec![1, 10, 11]);
    }
}
