//! The one swap slot of the app (the module state of src/main/accounts/swap.ts, activate.ts and codexActivate.ts):
//! "make main", its recoveries and the reconcile of the live login take it in turn; a pending unresolved swap and a
//! version-2 recovery waiting for Claude Code's locks are flags here too, so the background renewals can check them
//! synchronously. One `SwapSlot` per app run (tests make their own).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use tokio::sync::Notify;

#[derive(Default)]
pub struct SwapSlot {
    running: Mutex<bool>,
    idle: Condvar,
    idle_async: Notify,
    /// A swap or recovery left its journal and backups behind (`isSwapUnresolved`).
    unresolved: AtomicBool,
    /// A version-2 recovery waits for Claude Code's locks (`isActivationRecoveryPending`).
    recovery_pending: AtomicBool,
    /// A Codex "make main" moves files (`isCodexSwapRunning`).
    codex_running: AtomicBool,
    /// Held while a Codex "make main" or the reconcile of the live Codex login reads and writes the live auth.json and the
    /// Codex store, so the two never interleave (in 1.1.4 both were synchronous on Node's one thread).
    codex_files: Mutex<()>,
}

impl std::fmt::Debug for SwapSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SwapSlot")
            .field("running", &self.is_running())
            .field("unresolved", &self.is_unresolved())
            .field("recovery_pending", &self.is_recovery_pending())
            .finish()
    }
}

/// The held slot; released when dropped (also while a panic unwinds).
#[must_use = "the slot is released when the guard is dropped"]
pub struct SlotGuard<'a> {
    slot: &'a SwapSlot,
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        self.slot.release();
    }
}

impl SwapSlot {
    pub fn new() -> Self {
        Self::default()
    }

    /// `claimSwap`: takes the slot, or `None` while it is taken.
    pub fn try_claim(&self) -> Option<SlotGuard<'_>> {
        let mut running = self.running.lock();
        if *running {
            return None;
        }
        *running = true;
        Some(SlotGuard { slot: self })
    }

    /// `releaseSwap`: everyone waiting for the slot to be free learns it at once.
    fn release(&self) {
        *self.running.lock() = false;
        self.idle.notify_all();
        self.idle_async.notify_waiters();
    }

    /// `isSwapRunning`.
    pub fn is_running(&self) -> bool {
        *self.running.lock()
    }

    /// `swapIdle` for a blocking thread: true once no swap, activation, recovery or reconcile holds the slot (at once when
    /// none does), false when `timeout` passed first.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let until = Instant::now() + timeout;
        let mut running = self.running.lock();
        while *running {
            if self.idle.wait_until(&mut running, until).timed_out() {
                return !*running;
            }
        }
        true
    }

    /// `swapIdle`.
    pub async fn idle(&self) {
        loop {
            let notified = self.idle_async.notified();
            let mut notified = std::pin::pin!(notified);
            notified.as_mut().enable();
            if !self.is_running() {
                return;
            }
            notified.await;
        }
    }

    /// `isSwapUnresolved`.
    pub fn is_unresolved(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }

    /// `setSwapUnresolved`.
    pub fn set_unresolved(&self, value: bool) {
        self.unresolved.store(value, Ordering::SeqCst);
    }

    /// `isActivationRecoveryPending`.
    pub fn is_recovery_pending(&self) -> bool {
        self.recovery_pending.load(Ordering::SeqCst)
    }

    pub(crate) fn set_recovery_pending(&self, value: bool) {
        self.recovery_pending.store(value, Ordering::SeqCst);
    }

    /// `isCodexSwapRunning`.
    pub fn is_codex_running(&self) -> bool {
        self.codex_running.load(Ordering::SeqCst)
    }

    /// Takes the Codex flag (false while a Codex "make main" runs); cleared when the guard is dropped.
    pub(crate) fn claim_codex(&self) -> Option<CodexGuard<'_>> {
        (!self.codex_running.swap(true, Ordering::SeqCst)).then_some(CodexGuard { slot: self })
    }

    /// The Codex files lock for a "make main" that holds the Codex flag (waits for a reconcile in progress).
    pub(crate) fn lock_codex_files(&self) -> parking_lot::MutexGuard<'_, ()> {
        self.codex_files.lock()
    }

    /// The Codex files lock for the reconcile, or `None` while a "make main" holds it.
    pub(crate) fn try_lock_codex_files(&self) -> Option<parking_lot::MutexGuard<'_, ()>> {
        self.codex_files.try_lock()
    }
}

pub(crate) struct CodexGuard<'a> {
    slot: &'a SwapSlot,
}

impl Drop for CodexGuard<'_> {
    fn drop(&mut self) {
        self.slot.codex_running.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn one_holder_at_a_time_and_waiters_learn_the_release_at_once() {
        let slot = Arc::new(SwapSlot::new());
        let guard = slot.try_claim().unwrap();
        assert!(slot.try_claim().is_none());
        assert!(slot.is_running());
        assert!(!slot.wait_idle(Duration::from_millis(30)));
        let s = slot.clone();
        let waiter = std::thread::spawn(move || {
            let t = Instant::now();
            assert!(s.wait_idle(Duration::from_secs(5)));
            t.elapsed()
        });
        std::thread::sleep(Duration::from_millis(100));
        drop(guard);
        assert!(waiter.join().unwrap() < Duration::from_secs(2));
        assert!(slot.wait_idle(Duration::ZERO));
        assert!(slot.try_claim().is_some());
    }

    /// test/quit-wait.test.ts: the quit's wait (`timeout(QUIT_SWAP_WAIT, slot.idle())` in unimux-app commands/accounts.rs).
    #[test]
    fn a_release_followed_at_once_by_a_new_claim_keeps_the_quit_waiting_within_the_bound() {
        let slot = SwapSlot::new();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let short = Duration::from_millis(60);
            let guard = slot.try_claim().unwrap();
            let mut idle = std::pin::pin!(slot.idle());
            assert!(tokio::time::timeout(short, idle.as_mut()).await.is_err());
            // The startup recovery between two attempts: the slot is free for a moment only.
            drop(guard);
            let guard = slot.try_claim().unwrap();
            assert!(tokio::time::timeout(short, idle.as_mut()).await.is_err());
            drop(guard);
            tokio::time::timeout(Duration::from_secs(5), idle).await.unwrap();

            // A holder that never lets go for good: the bound still ends the wait.
            let mut guard = Some(slot.try_claim().unwrap());
            let started = Instant::now();
            let bound = Duration::from_millis(300);
            let waiting = tokio::time::timeout(bound, slot.idle());
            let churn = async {
                for _ in 0..4 {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    drop(guard.take());
                    guard = slot.try_claim();
                }
            };
            let (waited, ()) = tokio::join!(waiting, churn);
            assert!(waited.is_err());
            assert!(started.elapsed() >= bound);
            drop(guard);
            // With the swap ending inside the bound, the wait ends with it.
            let guard = slot.try_claim().unwrap();
            let ending = async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                drop(guard);
            };
            let (waited, ()) = tokio::join!(tokio::time::timeout(Duration::from_secs(5), slot.idle()), ending);
            assert!(waited.is_ok());
        });
    }

    #[test]
    fn the_async_idle_wait_resolves_on_release() {
        let slot = Arc::new(SwapSlot::new());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            slot.idle().await; // free: at once
            let s = slot.clone();
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let holder = std::thread::spawn(move || {
                let _g = s.try_claim().unwrap();
                tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(80));
            });
            rx.recv().unwrap();
            assert!(slot.is_running());
            tokio::time::timeout(Duration::from_secs(5), slot.idle()).await.unwrap();
            holder.join().unwrap();
        });
    }
}
