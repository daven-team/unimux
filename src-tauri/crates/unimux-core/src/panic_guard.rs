//! Panics a caller expects and turns into an ordinary failure (a third-party decoder that asserts on a damaged file). The
//! app's panic hook (unimux-app startup.rs) runs before any unwinding, so a plain `catch_unwind` would still write
//! `panic: ...` to crash.log and open the unexpected-error dialog. [`catch_expected`] marks the current thread while it
//! runs; the hook asks [`panic_expected`] and stays quiet for such a panic (1.1.4 caught these errors silently).

use std::cell::Cell;
use std::panic::{UnwindSafe, catch_unwind};

thread_local! {
    static EXPECTED: Cell<u32> = const { Cell::new(0) };
}

/// `catch_unwind(f)`, with a panic inside `f` (on this thread) marked as expected for the panic hook.
pub fn catch_expected<R>(f: impl FnOnce() -> R + UnwindSafe) -> std::thread::Result<R> {
    struct Mark;
    impl Drop for Mark {
        fn drop(&mut self) {
            EXPECTED.with(|c| c.set(c.get().saturating_sub(1)));
        }
    }
    EXPECTED.with(|c| c.set(c.get() + 1));
    let _mark = Mark;
    catch_unwind(f)
}

/// True inside [`catch_expected`] on this thread: the panic hook neither logs it nor shows a dialog.
pub fn panic_expected() -> bool {
    EXPECTED.with(|c| c.get() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_only_inside() {
        assert!(!panic_expected());
        let seen = catch_expected(panic_expected);
        assert_eq!(seen.ok(), Some(true));
        let nested = catch_expected(|| catch_expected(panic_expected).ok() == Some(true) && panic_expected());
        assert_eq!(nested.ok(), Some(true));
        assert!(!panic_expected());
        // (The default hook prints this one; the app's hook would stay quiet.)
        assert!(catch_expected(|| panic!("expected panic of panic_guard::marks_only_inside")).is_err());
        assert!(!panic_expected());
        // On another thread nothing is marked.
        let other = catch_expected(|| std::thread::spawn(panic_expected).join().unwrap());
        assert_eq!(other.ok(), Some(false));
    }
}
