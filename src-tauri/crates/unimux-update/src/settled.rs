//! A value many waiters can await once it is settled (the shared promise of the TS code: one download that later callers
//! join, one lookup every concurrent check waits for).

use tokio::sync::watch;

#[derive(Debug)]
pub struct Settled<T: Clone>(watch::Receiver<Option<T>>);

impl<T: Clone> Clone for Settled<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

/// Resolves the [`Settled`] it was made with. Dropping it unresolved settles the waiters with None.
pub struct Settle<T: Clone>(watch::Sender<Option<T>>);

impl<T: Clone> Settle<T> {
    pub fn settle(self, value: T) {
        let _ = self.0.send(Some(value));
    }
}

pub fn pending<T: Clone>() -> (Settle<T>, Settled<T>) {
    let (tx, rx) = watch::channel(None);
    (Settle(tx), Settled(rx))
}

pub fn ready<T: Clone>(value: T) -> Settled<T> {
    let (tx, rx) = watch::channel(Some(value));
    drop(tx);
    Settled(rx)
}

impl<T: Clone> Settled<T> {
    /// The value, once settled; None when its [`Settle`] was dropped without a value.
    pub async fn wait(mut self) -> Option<T> {
        loop {
            if let Some(value) = self.0.borrow_and_update().clone() {
                return Some(value);
            }
            if self.0.changed().await.is_err() {
                return self.0.borrow().clone();
            }
        }
    }

    /// The value if it is settled already.
    pub fn peek(&self) -> Option<T> {
        self.0.borrow().clone()
    }
}
