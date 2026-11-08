//! `TargetRegistry` (1.1.4 src/sftphost/targets.ts): the targets being written on one side (the local disk across every
//! queue, one remote server per session). Two jobs never write the same file (or its part file) at once: a second one waits
//! until the first released it, then meets it as an existing file (a conflict). Keys are case-folded on case-insensitive
//! disks, so "A.txt" and "a.txt" are one target.

use std::collections::HashMap;

use parking_lot::Mutex;

type Waiter = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct State {
    held: HashMap<String, String>,
    waiters: HashMap<String, Vec<Waiter>>,
}

pub struct TargetRegistry {
    key: Box<dyn Fn(&str) -> String + Send + Sync>,
    st: Mutex<State>,
}

impl std::fmt::Debug for TargetRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TargetRegistry").field("held", &self.st.lock().held.len()).finish()
    }
}

impl TargetRegistry {
    pub fn new(key: impl Fn(&str) -> String + Send + Sync + 'static) -> TargetRegistry {
        TargetRegistry { key: Box::new(key), st: Mutex::new(State::default()) }
    }

    /// The registry's key of `path` (two paths with one key are one target).
    pub fn key(&self, path: &str) -> String {
        (self.key)(path)
    }

    pub fn is_held(&self, path: &str) -> bool {
        self.st.lock().held.contains_key(&self.key(path))
    }

    /// True when `owner` holds it now; false when someone else does.
    pub fn hold(&self, path: &str, owner: &str) -> bool {
        let k = self.key(path);
        let mut st = self.st.lock();
        if st.held.get(&k).is_some_and(|by| by != owner) {
            return false;
        }
        st.held.insert(k, owner.to_string());
        true
    }

    pub fn release(&self, path: &str, owner: &str) {
        let k = self.key(path);
        let waiting = {
            let mut st = self.st.lock();
            if st.held.get(&k).map(String::as_str) != Some(owner) {
                return;
            }
            st.held.remove(&k);
            st.waiters.remove(&k)
        };
        for w in waiting.unwrap_or_default() {
            w();
        }
    }

    /// Calls `f` once when `path` is released (at once when it is free).
    pub fn when_free(&self, path: &str, f: impl FnOnce() + Send + 'static) {
        let k = self.key(path);
        {
            let mut st = self.st.lock();
            if st.held.contains_key(&k) {
                st.waiters.entry(k).or_default().push(Box::new(f));
                return;
            }
        }
        f();
    }

    pub fn size(&self) -> usize {
        self.st.lock().held.len()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn holds_per_key_and_wakes_waiters_on_release() {
        let r = TargetRegistry::new(|p| p.to_lowercase());
        assert!(r.hold("/A.txt", "one"));
        assert!(r.hold("/a.txt", "one"));
        assert!(!r.hold("/a.TXT", "two"));
        assert!(r.is_held("/a.txt"));
        let woke = Arc::new(AtomicUsize::new(0));
        let w = woke.clone();
        r.when_free("/A.TXT", move || {
            w.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(woke.load(Ordering::SeqCst), 0);
        r.release("/a.txt", "two");
        assert_eq!(woke.load(Ordering::SeqCst), 0);
        r.release("/a.txt", "one");
        assert_eq!(woke.load(Ordering::SeqCst), 1);
        assert_eq!(r.size(), 0);
        let w = woke.clone();
        r.when_free("/b", move || {
            w.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(woke.load(Ordering::SeqCst), 2);
    }
}
