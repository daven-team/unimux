//! A damaged Parquet file that makes the parquet crate panic (test/golden/parquet/panic-negative-chunk.parquet: a column
//! chunk with a negative start, 'column start and length should not be negative') is a failed read, and the panic is
//! marked as expected, so the app's panic hook (unimux-app startup.rs) neither logs it to crash.log nor opens the
//! unexpected-error dialog. Its own test binary: the panic hook is process-wide.
#![cfg(feature = "parquet")]

use std::sync::atomic::{AtomicUsize, Ordering};

use unimux_files::parquet::{PARQUET_FAILED, read_parquet};
use unimux_files::preview::Preview;

static EXPECTED: AtomicUsize = AtomicUsize::new(0);
static UNEXPECTED: AtomicUsize = AtomicUsize::new(0);

#[test]
fn a_panicking_file_is_a_quiet_failed_read() {
    // The app's hook asks the same question first (startup.rs install_crash_handling).
    std::panic::set_hook(Box::new(|_| {
        if unimux_core::panic_guard::panic_expected() {
            EXPECTED.fetch_add(1, Ordering::SeqCst);
        } else {
            UNEXPECTED.fetch_add(1, Ordering::SeqCst);
        }
    }));
    let dir = format!("{}/../../../test/golden/parquet", env!("CARGO_MANIFEST_DIR"));
    let path = format!("{dir}/panic-negative-chunk.parquet");
    let size = std::fs::metadata(&path).unwrap().len();
    let out = read_parquet(&path, size);
    let _ = std::panic::take_hook();
    assert!(matches!(&out, Preview::Error { message } if message == PARQUET_FAILED), "{out:?}");
    // The file really panics inside the reader (so this checks the guard), and only as an expected panic.
    assert!(EXPECTED.load(Ordering::SeqCst) >= 1);
    assert_eq!(UNEXPECTED.load(Ordering::SeqCst), 0);
}
