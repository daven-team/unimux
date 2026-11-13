//! Files the OS asks unimux to open: Explorer's "Open with" / context menu / default app (`unimux.exe "<path>"`, at the start
//! or forwarded by a second start to the running instance) and Finder's Open With (`RunEvent::Opened`). They open in the
//! main window's editor (src/renderer/src/openFromOs.ts).
//!
//! Delivery without races: the paths wait in [`OpenFiles`] until the main window's renderer takes them
//! (`app:takeOpenFiles`); every new batch also sends `app:open-files` (no payload) to the main window, which takes them then.
//! The renderer takes once at boot after subscribing, so paths that came before the page (or while the startup gate held the
//! window back) and paths that come later are each taken exactly once. A reload finds the queue empty.

use std::path::Path;

use parking_lot::Mutex;
use unimux_ipc::Scope;

use crate::context::AppContext;

/// The push event to the main window: new paths wait in the queue.
pub const OPEN_FILES_EVENT: &str = "app:open-files";

/// At most this many paths wait at once (a selection of hundreds of files in Explorer is not an editing session).
const MAX_PENDING: usize = 64;

/// Arguments that make this exe something else than the app (update window, its cleanup, the 1.1.x eval call, check-build
/// tools): their values may be paths of existing files that are never to be opened. `main()` handles all of them before the
/// app starts; this is the second fence.
const ENTRY_FLAGS: &[&str] = &["--update-window", "--update-cleanup", "--launch-line", "--ipc-routes", "-e", "--eval"];

/// The files among a command line's arguments (`args[0]` is the program): existing regular files, relative ones resolved
/// against `cwd`. Flags (`-...`, macOS's `-psn_...` too), folders and missing paths are skipped; a command line of one of the
/// [`ENTRY_FLAGS`] gives none.
pub fn file_args(args: &[String], cwd: &Path) -> Vec<String> {
    let rest = args.get(1..).unwrap_or_default();
    if rest.iter().any(|a| ENTRY_FLAGS.iter().any(|f| a == f || a.strip_prefix(f).is_some_and(|v| v.starts_with('=')))) {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for arg in rest {
        if arg.is_empty() || arg.starts_with('-') {
            continue;
        }
        let path = Path::new(arg);
        let path = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
        if !path.is_file() {
            continue;
        }
        let text = path.to_string_lossy().into_owned();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out
}

/// The files a macOS Open With hands over (`file://` URLs; anything else is skipped).
#[cfg_attr(not(target_os = "macos"), allow(dead_code, reason = "RunEvent::Opened is macOS only"))]
pub fn file_urls(urls: &[tauri::Url]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for url in urls {
        if url.scheme() != "file" {
            continue;
        }
        let Ok(path) = url.to_file_path() else { continue };
        if !path.is_file() {
            continue;
        }
        let text = path.to_string_lossy().into_owned();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out
}

/// The arguments of a relaunch (W6): this run's own arguments without the files it was started with (they were opened), then
/// the files that are still waiting (a second start during the wind-down asked for them).
pub fn relaunch_args(own: &[String], cwd: &Path, waiting: Vec<String>) -> Vec<String> {
    let opened = file_args(own, cwd);
    let mut out: Vec<String> = own
        .iter()
        .skip(1)
        .filter(|a| {
            let p = Path::new(a.as_str());
            let p = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
            !opened.contains(&p.to_string_lossy().into_owned())
        })
        .cloned()
        .collect();
    out.extend(waiting);
    out
}

/// The paths waiting for the main window's renderer.
#[derive(Default)]
pub struct OpenFiles {
    pending: Mutex<Vec<String>>,
}

impl OpenFiles {
    /// Adds paths (each once, at most [`MAX_PENDING`] waiting). True when one was added.
    pub fn push(&self, paths: Vec<String>) -> bool {
        let mut pending = self.pending.lock();
        let mut added = false;
        for path in paths {
            if pending.len() >= MAX_PENDING {
                break;
            }
            if !pending.contains(&path) {
                pending.push(path);
                added = true;
            }
        }
        added
    }

    /// Every waiting path, oldest first; the queue is empty afterwards.
    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.pending.lock())
    }
}

/// Queues paths for the main window and tells it (the event is lost harmlessly while no page listens: the boot take finds
/// them).
pub fn deliver(ctx: &AppContext, paths: Vec<String>) {
    if ctx.open_files.push(paths) {
        ctx.events.emit(Scope::Main, OPEN_FILES_EVENT, vec![]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn only_existing_files_count_and_flags_folders_and_entry_calls_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a b.txt");
        std::fs::write(&a, "x").unwrap();
        std::fs::write(dir.path().join("rel.md"), "x").unwrap();
        let a = a.to_string_lossy().into_owned();
        let rel = dir.path().join("rel.md").to_string_lossy().into_owned();
        let folder = dir.path().to_string_lossy().into_owned();
        let missing = dir.path().join("nope.txt").to_string_lossy().into_owned();

        let args = s(&["unimux.exe", "--updated", "-psn_0_123", &a, "rel.md", &folder, &missing, &a, ""]);
        assert_eq!(file_args(&args, dir.path()), vec![a.clone(), rel]);
        // The program itself is never a file to open.
        assert!(file_args(&s(&[&a]), dir.path()).is_empty());
        // The update window's config and the cleanup's lock are files, but never documents.
        assert!(file_args(&s(&["unimux.exe", "--update-window", &a]), dir.path()).is_empty());
        assert!(file_args(&s(&["unimux.exe", "--update-window=x", &a]), dir.path()).is_empty());
        assert!(file_args(&s(&["unimux.exe", "-e", &a]), dir.path()).is_empty());
    }

    #[test]
    fn the_queue_keeps_each_path_once_until_taken() {
        let q = OpenFiles::default();
        assert!(q.push(s(&["a", "b"])));
        assert!(!q.push(s(&["a"])));
        assert!(!q.push(Vec::new()));
        assert_eq!(q.take(), s(&["a", "b"]));
        assert!(q.take().is_empty());
        assert!(q.push((0..100).map(|i| i.to_string()).collect()));
        assert_eq!(q.take().len(), MAX_PENDING);
    }

    #[test]
    fn a_relaunch_drops_the_files_it_was_started_with_and_adds_the_waiting_ones() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        std::fs::write(&a, "x").unwrap();
        let a = a.to_string_lossy().into_owned();
        let own = s(&["unimux.exe", "--flag", &a]);
        assert_eq!(relaunch_args(&own, dir.path(), s(&["new.txt"])), s(&["--flag", "new.txt"]));
    }

    #[test]
    fn file_urls_become_paths_of_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        std::fs::write(&a, "x").unwrap();
        let urls = vec![
            tauri::Url::from_file_path(&a).unwrap(),
            tauri::Url::parse("https://example.com/a.txt").unwrap(),
            tauri::Url::from_directory_path(dir.path()).unwrap(),
        ];
        assert_eq!(file_urls(&urls), vec![a.to_string_lossy().into_owned()]);
    }
}
