//! The clipboard (W4): plain text read/write like Electron's `clipboard.readText` / `writeText`, and the copied private key
//! of 0.9.2 (port of src/shared/sshClipboard.ts): written so the OS keeps it out of the clipboard history and cloud sync
//! (Windows: `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory` = 0,
//! `CanUploadToCloudClipboard` = 0; macOS: `org.nspasteboard.ConcealedType`), and cleared after 60 s, or when the app quits,
//! only if the clipboard still holds that text. Only a SHA-256 of the copied text is kept while waiting.

use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::timers::{Scheduler, TimerId};

pub const CLIPBOARD_CLEAR_MS: u64 = 60_000;

/// Where the text goes (the OS clipboard, or the file-backed fake of an offscreen check run).
pub trait ClipboardIo: Send + Sync {
    fn read(&self) -> Result<String, String>;
    /// `secret`: keep it out of the clipboard history, cloud sync and clipboard monitors.
    fn write(&self, text: &str, secret: bool) -> Result<(), String>;
}

/// The OS clipboard.
pub struct OsClipboard;

impl ClipboardIo for OsClipboard {
    fn read(&self) -> Result<String, String> {
        read_text()
    }
    fn write(&self, text: &str, secret: bool) -> Result<(), String> {
        write_text(text, secret)
    }
}

pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

struct Waiting {
    timer: TimerId,
    generation: u64,
    digest: String,
}

#[derive(Default)]
struct Inner {
    waiting: Option<Waiting>,
    generation: u64,
    /// A flush is reading / clearing the clipboard right now (a quit waits for it).
    clearing: u32,
}

pub struct SecretClipboard {
    io: Arc<dyn ClipboardIo>,
    scheduler: Arc<dyn Scheduler>,
    clear_ms: u64,
    inner: Mutex<Inner>,
    /// Held across a copy's write and its bookkeeping, so the digest that waits is always the one of the text written
    /// last (two copies on two threads cannot record their digests in the other order).
    copying: Mutex<()>,
    me: Weak<SecretClipboard>,
}

impl SecretClipboard {
    pub fn new(io: Arc<dyn ClipboardIo>, scheduler: Arc<dyn Scheduler>) -> Arc<Self> {
        Self::with_clear_ms(io, scheduler, CLIPBOARD_CLEAR_MS)
    }

    pub fn with_clear_ms(io: Arc<dyn ClipboardIo>, scheduler: Arc<dyn Scheduler>, clear_ms: u64) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            io,
            scheduler,
            clear_ms,
            inner: Mutex::new(Inner::default()),
            copying: Mutex::new(()),
            me: me.clone(),
        })
    }

    /// Clears when the clipboard still holds the text with this digest (never on a read error).
    fn clear_if_still(&self, digest: &str) {
        if let Ok(current) = self.io.read()
            && !current.is_empty()
            && sha256_hex(&current) == digest
        {
            let _ = self.io.write("", true);
        }
    }

    /// Writes the text (as a secret) and starts (or restarts) the wait; an error when the clipboard could not be written
    /// (the window shows it), and then no wait starts.
    pub fn copy(&self, text: &str) -> Result<(), String> {
        let digest = sha256_hex(text);
        let _copying = self.copying.lock();
        self.io.write(text, true)?;
        let mut inner = self.inner.lock();
        // A newer copy restarts the wait; the older text is no longer in the clipboard anyway.
        if let Some(old) = inner.waiting.take() {
            self.scheduler.cancel(old.timer);
        }
        inner.generation += 1;
        let generation = inner.generation;
        let me = self.me.clone();
        let fired_digest = digest.clone();
        let timer = self.scheduler.after(
            self.clear_ms,
            Box::new(move || {
                let Some(this) = me.upgrade() else { return };
                {
                    let mut inner = this.inner.lock();
                    if inner.waiting.as_ref().map(|w| w.generation) != Some(generation) {
                        return;
                    }
                    inner.waiting = None;
                }
                this.clear_if_still(&fired_digest);
            }),
        );
        inner.waiting = Some(Waiting { timer, generation, digest });
        Ok(())
    }

    /// Whether a copied text still waits to be cleared (or is being cleared).
    pub fn pending(&self) -> bool {
        let inner = self.inner.lock();
        inner.waiting.is_some() || inner.clearing > 0
    }

    /// Clears now if the clipboard still holds the copied text (the app quits); nothing waits afterwards. Blocking.
    pub fn flush(&self) {
        let digest = {
            let mut inner = self.inner.lock();
            let Some(w) = inner.waiting.take() else { return };
            self.scheduler.cancel(w.timer);
            inner.clearing += 1;
            w.digest
        };
        self.clear_if_still(&digest);
        self.inner.lock().clearing -= 1;
    }
}

/// `clipboard.readText()`: the Unicode text in the clipboard, '' when there is none.
pub fn read_text() -> Result<String, String> {
    #[cfg(windows)]
    {
        win::read_text()
    }
    #[cfg(target_os = "macos")]
    {
        mac::read_text()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err("no clipboard on this platform".into())
    }
}

/// `clipboard.writeText(text)`; `secret` adds the formats that keep it out of history, cloud and monitors.
pub fn write_text(text: &str, secret: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::write_text(text, secret)
    }
    #[cfg(target_os = "macos")]
    {
        mac::write_text(text, secret)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (text, secret);
        Err("no clipboard on this platform".into())
    }
}

/// The formats now in the clipboard by name (registered ones by their name, standard ones as `#<id>`). Tests only.
#[cfg(windows)]
pub fn format_names() -> Result<Vec<String>, String> {
    win::format_names()
}

#[cfg(windows)]
mod win {
    use std::time::Duration;

    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardFormatNameW,
        IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::core::HSTRING;

    /// Holds the clipboard open; another app may hold it for a moment, so opening is retried (Chromium tries 5 times).
    struct Open;

    impl Open {
        fn acquire() -> Result<Self, String> {
            let mut last = String::new();
            for attempt in 0..10 {
                // SAFETY: plain Win32 call; closed again by Drop.
                match unsafe { OpenClipboard(None) } {
                    Ok(()) => return Ok(Open),
                    Err(e) => last = e.to_string(),
                }
                std::thread::sleep(Duration::from_millis(5 + attempt * 5));
            }
            Err(format!("the clipboard is busy: {last}"))
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: we opened it.
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    fn global_from(bytes: &[u8]) -> Result<HGLOBAL, String> {
        // SAFETY: a fresh movable block of the right size, filled while locked.
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).map_err(|e| e.to_string())?;
            let p = GlobalLock(h) as *mut u8;
            if p.is_null() {
                let _ = GlobalFree(Some(h));
                return Err("GlobalLock failed".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            let _ = GlobalUnlock(h);
            Ok(h)
        }
    }

    fn set(format: u32, bytes: &[u8]) -> Result<(), String> {
        let h = global_from(bytes)?;
        // SAFETY: the clipboard is open and emptied by us; on success the system owns the block.
        unsafe {
            if let Err(e) = SetClipboardData(format, Some(HANDLE(h.0))) {
                let _ = GlobalFree(Some(h));
                return Err(e.to_string());
            }
        }
        Ok(())
    }

    fn register(name: &str) -> u32 {
        // SAFETY: a valid string.
        unsafe { RegisterClipboardFormatW(&HSTRING::from(name)) }
    }

    pub fn write_text(text: &str, secret: bool) -> Result<(), String> {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let bytes: Vec<u8> = wide.iter().flat_map(|u| u.to_le_bytes()).collect();
        let _open = Open::acquire()?;
        // SAFETY: the clipboard is open.
        unsafe { EmptyClipboard() }.map_err(|e| e.to_string())?;
        set(u32::from(CF_UNICODETEXT.0), &bytes)?;
        if secret {
            // https://learn.microsoft.com/windows/win32/dataxchg/clipboard-formats#cloud-clipboard-and-clipboard-history-formats
            let zero = 0u32.to_le_bytes();
            set(register("ExcludeClipboardContentFromMonitorProcessing"), &zero)?;
            set(register("CanIncludeInClipboardHistory"), &zero)?;
            set(register("CanUploadToCloudClipboard"), &zero)?;
        }
        Ok(())
    }

    pub fn read_text() -> Result<String, String> {
        let _open = Open::acquire()?;
        // SAFETY: the clipboard is open; the data handle is only read while locked and never freed by us.
        unsafe {
            if IsClipboardFormatAvailable(u32::from(CF_UNICODETEXT.0)).is_err() {
                return Ok(String::new());
            }
            let Ok(h) = GetClipboardData(u32::from(CF_UNICODETEXT.0)) else { return Ok(String::new()) };
            let g = HGLOBAL(h.0);
            let p = GlobalLock(g) as *const u16;
            if p.is_null() {
                return Ok(String::new());
            }
            let units = GlobalSize(g) / 2;
            let slice = std::slice::from_raw_parts(p, units);
            let end = slice.iter().position(|&u| u == 0).unwrap_or(units);
            let text = String::from_utf16_lossy(&slice[..end]);
            let _ = GlobalUnlock(g);
            Ok(text)
        }
    }

    pub fn format_names() -> Result<Vec<String>, String> {
        let _open = Open::acquire()?;
        let mut names = Vec::new();
        let mut format = 0u32;
        loop {
            // SAFETY: the clipboard is open.
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 {
                break;
            }
            let mut buf = [0u16; 128];
            // SAFETY: the buffer length is passed.
            let n = unsafe { GetClipboardFormatNameW(format, &mut buf) };
            names.push(if n > 0 { String::from_utf16_lossy(&buf[..n as usize]) } else { format!("#{format}") });
        }
        Ok(names)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::{NSArray, NSString};

    /// http://nspasteboard.org: clipboard managers skip items with this type.
    const CONCEALED: &str = "org.nspasteboard.ConcealedType";

    pub fn read_text() -> Result<String, String> {
        // SAFETY: an immutable static NSString of AppKit.
        let string_type = unsafe { NSPasteboardTypeString };
        let pb = NSPasteboard::generalPasteboard();
        Ok(pb.stringForType(string_type).map(|s| s.to_string()).unwrap_or_default())
    }

    pub fn write_text(text: &str, secret: bool) -> Result<(), String> {
        // SAFETY: an immutable static NSString of AppKit.
        let string_type = unsafe { NSPasteboardTypeString };
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let concealed = NSString::from_str(CONCEALED);
        let types = if secret { NSArray::from_slice(&[string_type, &*concealed]) } else { NSArray::from_slice(&[string_type]) };
        // SAFETY: no owner object (the data is set right below, no lazy provider).
        unsafe { pb.declareTypes_owner(&types, None) };
        if !pb.setString_forType(&NSString::from_str(text), string_type) {
            return Err("the clipboard could not be written".into());
        }
        if secret {
            pb.setString_forType(&NSString::from_str(""), &concealed);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! Port of test/ssh-secret-clipboard.test.ts (a fake clipboard, timers by hand), plus a check of the real Windows
    //! clipboard formats that runs only with UNIMUX_TEST_REAL_CLIPBOARD=1 (it puts back the text that was there).
    use super::*;
    use crate::timers::ManualScheduler;

    #[derive(Default)]
    struct Fake {
        content: Mutex<String>,
        fail: bool,
        secret_writes: Mutex<u32>,
    }
    impl ClipboardIo for Fake {
        fn read(&self) -> Result<String, String> {
            Ok(self.content.lock().clone())
        }
        fn write(&self, text: &str, secret: bool) -> Result<(), String> {
            if self.fail {
                return Err("no clipboard".into());
            }
            if secret {
                *self.secret_writes.lock() += 1;
            }
            *self.content.lock() = text.to_string();
            Ok(())
        }
    }

    fn fake() -> (Arc<SecretClipboard>, Arc<Fake>, Arc<ManualScheduler>) {
        let io = Arc::new(Fake::default());
        let sched = Arc::new(ManualScheduler::default());
        (SecretClipboard::new(io.clone(), sched.clone()), io, sched)
    }

    #[test]
    fn clears_the_clipboard_after_a_minute_if_it_still_holds_the_copied_key() {
        let (clip, io, sched) = fake();
        clip.copy("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret").unwrap();
        assert!(io.content.lock().contains("secret"));
        assert_eq!(sched.timers(), vec![(CLIPBOARD_CLEAR_MS, false)]);
        assert_eq!(CLIPBOARD_CLEAR_MS, 60_000);
        sched.fire();
        assert_eq!(*io.content.lock(), "");
        assert!(!clip.pending());
    }

    #[test]
    fn leaves_something_else_the_user_copied_meanwhile_alone() {
        let (clip, io, sched) = fake();
        clip.copy("secret").unwrap();
        *io.content.lock() = "a command the user copied later".into();
        sched.fire();
        assert_eq!(*io.content.lock(), "a command the user copied later");
    }

    #[test]
    fn restarts_the_wait_on_a_second_copy() {
        let (clip, io, sched) = fake();
        clip.copy("one").unwrap();
        clip.copy("two").unwrap();
        assert_eq!(sched.timers().iter().map(|t| t.1).collect::<Vec<_>>(), vec![true, false]);
        sched.fire();
        assert_eq!(*io.content.lock(), "");
    }

    #[test]
    fn flush_the_app_quits_clears_at_once_only_while_the_copied_text_is_still_there_and_cancels_the_wait() {
        let (clip, io, sched) = fake();
        clip.copy("secret").unwrap();
        assert!(clip.pending());
        clip.flush();
        assert_eq!(*io.content.lock(), "");
        assert_eq!(sched.timers(), vec![(CLIPBOARD_CLEAR_MS, true)]);
        assert!(!clip.pending());
        clip.copy("secret").unwrap();
        *io.content.lock() = "mine".into();
        clip.flush();
        assert_eq!(*io.content.lock(), "mine");
        // Nothing pending: a second flush does nothing.
        io.content.lock().clear();
        clip.flush();
        assert_eq!(*io.content.lock(), "");
        // A timer that fires after the flush finds nothing to do.
        sched.fire();
        assert!(!clip.pending());
    }

    /// Two copies on two threads (two `clipboard:writeSecret` calls): the first one's write is slow, so the second one
    /// would write and record its digest in between. The text left in the clipboard is still the one that gets cleared.
    #[test]
    fn concurrent_copies_clear_the_text_written_last() {
        struct Slow(Mutex<String>);
        impl ClipboardIo for Slow {
            fn read(&self) -> Result<String, String> {
                Ok(self.0.lock().clone())
            }
            fn write(&self, text: &str, _secret: bool) -> Result<(), String> {
                *self.0.lock() = text.to_string();
                if text == "A" {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Ok(())
            }
        }
        let io = Arc::new(Slow(Mutex::new(String::new())));
        let sched = Arc::new(ManualScheduler::default());
        let clip = SecretClipboard::new(io.clone(), sched.clone());
        let a = {
            let clip = clip.clone();
            std::thread::spawn(move || clip.copy("A").unwrap())
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        let b = {
            let clip = clip.clone();
            std::thread::spawn(move || clip.copy("B").unwrap())
        };
        a.join().unwrap();
        b.join().unwrap();
        assert_eq!(*io.0.lock(), "B");
        sched.fire();
        assert_eq!(*io.0.lock(), "", "the key left in the clipboard is cleared");
        assert!(!clip.pending());
    }

    #[test]
    fn rejects_when_the_clipboard_cannot_be_written_the_window_shows_an_error_and_starts_no_wait() {
        let io = Arc::new(Fake { fail: true, ..Default::default() });
        let sched = Arc::new(ManualScheduler::default());
        let clip = SecretClipboard::new(io, sched.clone());
        assert_eq!(clip.copy("secret"), Err("no clipboard".to_string()));
        assert!(sched.timers().is_empty());
        assert!(!clip.pending());
    }

    #[test]
    fn keeps_only_a_digest_of_the_copied_text() {
        let digest = sha256_hex("secret");
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(digest, "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b");
        let (clip, io, _) = fake();
        clip.copy("secret").unwrap();
        assert_eq!(*io.secret_writes.lock(), 1, "the key is written as a secret");
    }

    /// The real Windows clipboard: a secret carries the three exclusion formats and reads back; the user's text is put back
    /// afterwards. Opt-in (it touches the user's clipboard for a moment).
    #[cfg(windows)]
    #[test]
    fn real_windows_clipboard_formats() {
        if std::env::var("UNIMUX_TEST_REAL_CLIPBOARD").as_deref() != Ok("1") {
            return;
        }
        let before = read_text().unwrap();
        let only_text = format_names().unwrap().iter().all(|n| matches!(n.as_str(), "#13" | "#1" | "#7" | "#16"));
        if !only_text {
            eprintln!("skipped: the clipboard holds more than text");
            return;
        }
        write_text("unimux secret test", true).unwrap();
        let names = format_names().unwrap();
        let read = read_text().unwrap();
        // The user's text goes back as a secret too, so the clipboard history gets no second copy of it.
        write_text(&before, true).unwrap();
        assert_eq!(read, "unimux secret test");
        assert_eq!(read_text().unwrap(), before);
        for f in ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"] {
            assert!(names.iter().any(|n| n == f), "{f} missing in {names:?}");
        }
    }
}
