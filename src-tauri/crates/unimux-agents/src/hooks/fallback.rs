//! The http hook fallback (port of src/main/hookFallback.ts, 1.1.4).
//!
//! Claude Code 2.1.63+ cells post their status hooks as `type: "http"` hooks. Two things can make them vanish without an
//! error: a managed `allowedHttpHookUrls` policy that does not allow 127.0.0.1, and a cell that runs an older `claude` than
//! the detected one. SessionStart stays a curl command in every form, so it still arrives. [`HttpHookWatch`] notices a cell
//! that works (output-driven "working") for [`HTTP_HOOK_GRACE_MS`] after its SessionStart without a single http hook,
//! switches every later Claude spawn back to command hooks and remembers that for this claude version in
//! `claude-hook-fallback.json` (a new version tries http hooks again); the app shows one `app:notice` per run.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use serde_json::Value;

use super::claude::ClaudeHookForm;
use super::payload::{js_parse, js_space, utf16_len};

/// How long a cell may work, after SessionStart, without one http hook before http hooks count as blocked.
pub const HTTP_HOOK_GRACE_MS: u64 = 20_000;

/// The file the fallback is remembered in (in the data dir).
pub const FALLBACK_FILE: &str = "claude-hook-fallback.json";

pub type TimerId = u64;

/// `setTimeout` / `clearTimeout` (the app runs them on the async runtime, the tests on a fake clock).
pub trait Timers: Send + Sync {
    fn set(&self, ms: u64, f: Box<dyn FnOnce() + Send>) -> TimerId;
    fn clear(&self, id: TimerId);
}

/// Reads the remembered version (None: nothing remembered or unreadable).
pub type LoadFallback = Box<dyn Fn() -> Option<String> + Send + Sync>;
/// Remembers the version that fell back.
pub type SaveFallback = Box<dyn Fn(&str) -> io::Result<()> + Send + Sync>;

/// What the watch needs from the app (`HttpHookWatchDeps`).
pub struct HttpHookWatchDeps {
    /// The version that fell back (persisted), or None; read once.
    pub load: LoadFallback,
    pub save: SaveFallback,
    /// Called once per app run, when http hooks are found blocked.
    pub on_fallback: Box<dyn Fn() + Send + Sync>,
    pub timers: Arc<dyn Timers>,
}

struct Watched {
    /// Which `spawned` made this entry (`this.cells.get(cellId) !== cell` of the timer).
    generation: u64,
    session_started: bool,
    timer: Option<TimerId>,
}

#[derive(Default)]
struct Inner {
    cells: HashMap<String, Watched>,
    /// The cell's claude version at its spawn (what a fallback is remembered for).
    versions: HashMap<String, Option<String>>,
    /// None = not loaded yet (`undefined`), Some(None) = nothing remembered (`null`).
    blocked_for: Option<Option<String>>,
    blocked_now: bool,
    hinted: bool,
    generation: u64,
}

/// `HttpHookWatch` (see the module doc). Thread-safe; the timer runs on the [`Timers`] it was given.
pub struct HttpHookWatch {
    deps: HttpHookWatchDeps,
    inner: Mutex<Inner>,
    me: Weak<HttpHookWatch>,
}

impl HttpHookWatch {
    pub fn new(deps: HttpHookWatchDeps) -> Arc<Self> {
        Arc::new_cyclic(|me| Self { deps, inner: Mutex::new(Inner::default()), me: me.clone() })
    }

    fn blocked(&self, inner: &mut Inner, version: Option<&str>) -> bool {
        if inner.blocked_now {
            return true;
        }
        let remembered = inner.blocked_for.get_or_insert_with(|| (self.deps.load)());
        remembered.as_deref() == Some(version.unwrap_or(""))
    }

    /// The hook form a Claude spawn gets: the version's form, or command hooks once http hooks were found blocked.
    pub fn form_for(&self, form: ClaudeHookForm, version: Option<&str>) -> ClaudeHookForm {
        if form != ClaudeHookForm::Shell && self.blocked(&mut self.inner.lock(), version) { ClaudeHookForm::Shell } else { form }
    }

    /// A Claude cell starts (again) with `form`; only http forms are watched.
    pub fn spawned(&self, cell_id: &str, form: ClaudeHookForm, version: Option<&str>) {
        let mut inner = self.inner.lock();
        self.forget_locked(&mut inner, cell_id);
        if form == ClaudeHookForm::Shell {
            return;
        }
        inner.generation += 1;
        let generation = inner.generation;
        inner.cells.insert(cell_id.to_string(), Watched { generation, session_started: false, timer: None });
        inner.versions.insert(cell_id.to_string(), version.map(str::to_string));
    }

    /// A hook of the cell arrived; everything but SessionStart travels as an http hook in the http forms.
    pub fn hook(&self, cell_id: &str, event: &str) {
        let mut inner = self.inner.lock();
        let Some(cell) = inner.cells.get_mut(cell_id) else { return };
        if event == "session" {
            cell.session_started = true;
            return;
        }
        // http hooks work for this process: nothing more to watch.
        self.forget_locked(&mut inner, cell_id);
    }

    /// The renderer's status of the cell. Output-driven "working" (`hooked` false) after SessionStart starts the grace timer;
    /// any other status stops it (a menu or a short redraw is not a working agent).
    pub fn status(&self, cell_id: &str, status: &str, hooked: bool) {
        let mut inner = self.inner.lock();
        let Some(cell) = inner.cells.get_mut(cell_id) else { return };
        let working = status == "working" && !hooked && cell.session_started;
        if !working {
            if let Some(timer) = cell.timer.take() {
                self.deps.timers.clear(timer);
            }
            return;
        }
        if cell.timer.is_some() {
            return;
        }
        let generation = cell.generation;
        let me = self.me.clone();
        let id = cell_id.to_string();
        let timer = self.deps.timers.set(
            HTTP_HOOK_GRACE_MS,
            Box::new(move || {
                if let Some(watch) = me.upgrade() {
                    watch.grace_over(&id, generation);
                }
            }),
        );
        if let Some(cell) = inner.cells.get_mut(cell_id) {
            cell.timer = Some(timer);
        }
    }

    fn grace_over(&self, cell_id: &str, generation: u64) {
        let (version, hint) = {
            let mut inner = self.inner.lock();
            match inner.cells.get_mut(cell_id) {
                Some(cell) if cell.generation == generation => cell.timer = None,
                _ => return,
            }
            let version = inner.versions.get(cell_id).cloned().flatten().unwrap_or_default();
            inner.blocked_now = true;
            inner.blocked_for = Some(Some(version.clone()));
            let hint = !inner.hinted;
            inner.hinted = true;
            self.forget_locked(&mut inner, cell_id);
            (version, hint)
        };
        // Remembered for this run only when the file cannot be written.
        let _ = (self.deps.save)(&version);
        if hint {
            (self.deps.on_fallback)();
        }
    }

    fn forget_locked(&self, inner: &mut Inner, cell_id: &str) {
        if let Some(timer) = inner.cells.remove(cell_id).and_then(|c| c.timer) {
            self.deps.timers.clear(timer);
        }
        inner.versions.remove(cell_id);
    }

    /// The cell's process is gone.
    pub fn forget(&self, cell_id: &str) {
        self.forget_locked(&mut self.inner.lock(), cell_id);
    }
}

/// Claude Code settings files that can carry `allowedHttpHookUrls`: the managed policy, the user's settings and the project's
/// (`claudeSettingsFiles`). `platform` is Node's `process.platform`; `env` is looked up by exact key, as a JS object is.
pub fn claude_settings_files(platform: &str, home: &str, env: &[(String, String)], cwd: &str) -> Vec<String> {
    let sep = if platform == "win32" { "\\" } else { "/" };
    let join = |parts: &[&str]| parts.join(sep);
    let var = |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    let mut files = match platform {
        "win32" => vec![
            join(&[var("ProgramFiles").unwrap_or("C:\\Program Files"), "ClaudeCode", "managed-settings.json"]),
            join(&[var("ProgramData").unwrap_or("C:\\ProgramData"), "ClaudeCode", "managed-settings.json"]),
        ],
        "darwin" => vec!["/Library/Application Support/ClaudeCode/managed-settings.json".to_string()],
        _ => vec!["/etc/claude-code/managed-settings.json".to_string()],
    };
    let configured = var("CLAUDE_CONFIG_DIR").map(|v| v.trim_matches(js_space)).filter(|v| !v.is_empty());
    let user = configured.map_or_else(|| join(&[home, ".claude"]), str::to_string);
    files.push(join(&[&user, "settings.json"]));
    files.push(join(&[cwd, ".claude", "settings.json"]));
    files.push(join(&[cwd, ".claude", "settings.local.json"]));
    files
}

/// Whether the settings (file texts; None = missing) let an http hook post to `url` (`httpHookUrlAllowed`). No list anywhere
/// allows everything; once a list exists, the URL must match one of the patterns of the lists.
pub fn http_hook_url_allowed(texts: &[Option<String>], url: &str) -> bool {
    let mut patterns: Vec<&str> = Vec::new();
    let mut parsed = Vec::new();
    for text in texts.iter().flatten() {
        if text.is_empty() {
            continue;
        }
        // `JSON.parse(text)?.allowedHttpHookUrls`: only an object can carry it.
        if let Some(Value::Object(mut o)) = js_parse(text)
            && let Some(Value::Array(list)) = o.remove("allowedHttpHookUrls")
        {
            parsed.push(list);
        }
    }
    if parsed.is_empty() {
        return true;
    }
    for list in &parsed {
        patterns.extend(list.iter().filter_map(Value::as_str));
    }
    // Patterns come from settings files (a project's too): a linear glob match, never a regex built from them.
    patterns.iter().any(|p| utf16_len(p) <= 2048 && glob_match(p, url))
}

/// `*` matches any run of characters (also `/`); linear time (greedy with one backtrack point, no regex). Compared in UTF-16
/// code units like the JS original.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<u16> = pattern.encode_utf16().collect();
    let text: Vec<u16> = text.encode_utf16().collect();
    let star_unit = u16::from(b'*');
    let (mut p, mut t) = (0, 0);
    let mut star: Option<usize> = None;
    let mut mark = 0;
    while t < text.len() {
        if p < pattern.len() && pattern[p] != star_unit && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == star_unit {
            star = Some(p);
            p += 1;
            mark = t;
        } else if let Some(s) = star {
            p = s + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == star_unit {
        p += 1;
    }
    p == pattern.len()
}

/// Reads the settings files (`readFileSync(file, 'utf8')`: invalid UTF-8 becomes U+FFFD; a missing or unreadable one is None).
pub fn read_settings_texts(files: &[String]) -> Vec<Option<String>> {
    files.iter().map(|f| std::fs::read(f).ok().map(|b| String::from_utf8_lossy(&b).into_owned())).collect()
}

/// `hookFallbackFile(file).load`: the remembered version (`{ "claudeVersion": "2.1.310" }`), or None.
pub fn load_fallback(file: &Path) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    match js_parse(&String::from_utf8_lossy(&bytes))? {
        Value::Object(mut o) => match o.remove("claudeVersion") {
            Some(Value::String(v)) => Some(v),
            _ => None,
        },
        _ => None,
    }
}

/// `hookFallbackFile(file).save`: `JSON.stringify({ claudeVersion })`, written atomically.
pub fn save_fallback(file: &Path, version: &str) -> io::Result<()> {
    let text = serde_json::to_string(&serde_json::json!({ "claudeVersion": version })).expect("a string serializes");
    unimux_core::atomic_write::atomic_write(file, text.as_bytes(), &Default::default())
}

/// The load / save pair of [`HttpHookWatchDeps`] over `<data dir>/claude-hook-fallback.json`.
pub fn fallback_store(file: PathBuf) -> (LoadFallback, SaveFallback) {
    let load_file = file.clone();
    (Box::new(move || load_fallback(&load_file)), Box::new(move |v| save_fallback(&file, v)))
}

#[cfg(test)]
pub(crate) mod fake {
    //! `vi.useFakeTimers()` for the watch: timers fire in due order when the clock is advanced.
    use super::*;

    type Due = (u64, TimerId, Box<dyn FnOnce() + Send>);

    #[derive(Default)]
    pub struct FakeTimers {
        state: Mutex<(u64, TimerId, Vec<Due>)>,
    }

    impl FakeTimers {
        pub fn advance(&self, ms: u64) {
            let target = self.state.lock().0 + ms;
            loop {
                let next = {
                    let mut s = self.state.lock();
                    let pos =
                        s.2.iter().enumerate().filter(|(_, d)| d.0 <= target).min_by_key(|(_, d)| (d.0, d.1)).map(|(i, _)| i);
                    match pos {
                        Some(i) => {
                            let due = s.2.remove(i);
                            s.0 = due.0;
                            Some(due.2)
                        }
                        None => {
                            s.0 = target;
                            None
                        }
                    }
                };
                match next {
                    Some(f) => f(),
                    None => return,
                }
            }
        }

        pub fn pending(&self) -> usize {
            self.state.lock().2.len()
        }
    }

    impl Timers for FakeTimers {
        fn set(&self, ms: u64, f: Box<dyn FnOnce() + Send>) -> TimerId {
            let mut s = self.state.lock();
            s.1 += 1;
            let (now, id) = (s.0, s.1);
            s.2.push((now + ms, id, f));
            id
        }

        fn clear(&self, id: TimerId) {
            self.state.lock().2.retain(|d| d.1 != id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeTimers;
    use super::*;
    use ClaudeHookForm::*;

    struct Watch {
        w: Arc<HttpHookWatch>,
        notices: Arc<Mutex<Vec<String>>>,
        saves: Arc<Mutex<Vec<String>>>,
        timers: Arc<FakeTimers>,
        loads: Arc<Mutex<usize>>,
    }

    fn watch(saved: Option<&str>) -> Watch {
        let notices = Arc::new(Mutex::new(Vec::new()));
        let saves = Arc::new(Mutex::new(Vec::new()));
        let loads = Arc::new(Mutex::new(0));
        let timers = Arc::new(FakeTimers::default());
        let saved = saved.map(str::to_string);
        let (n, s, l) = (notices.clone(), saves.clone(), loads.clone());
        let w = HttpHookWatch::new(HttpHookWatchDeps {
            load: Box::new(move || {
                *l.lock() += 1;
                saved.clone()
            }),
            save: Box::new(move |v| {
                s.lock().push(v.to_string());
                Ok(())
            }),
            on_fallback: Box::new(move || n.lock().push("hint".into())),
            timers: timers.clone(),
        });
        Watch { w, notices, saves, timers, loads }
    }

    // hook-fallback "http hook fallback"
    #[test]
    fn falls_back_to_command_hooks_when_a_cell_works_20_s_after_session_start_without_one_http_hook_and_hints_once() {
        let t = watch(None);
        let w = &t.w;
        assert_eq!(w.form_for(Exec, Some("2.1.310")), Exec);
        w.spawned("a", Exec, Some("2.1.310"));
        w.spawned("b", Exec, Some("2.1.310"));
        w.hook("a", "session");
        w.hook("b", "session");
        w.status("a", "working", false);
        w.status("b", "working", false);
        t.timers.advance(HTTP_HOOK_GRACE_MS - 1);
        assert!(t.notices.lock().is_empty());
        t.timers.advance(1);
        assert_eq!(*t.notices.lock(), ["hint"]);
        assert_eq!(*t.saves.lock(), ["2.1.310", "2.1.310"]);
        assert_eq!(w.form_for(Exec, Some("2.1.310")), Shell);
        assert_eq!(w.form_for(Http, Some("2.1.400")), Shell, "for the rest of this run, whatever the version");
        assert_eq!(w.form_for(Shell, None), Shell);
        assert_eq!(t.timers.pending(), 0);
    }

    #[test]
    fn does_not_fall_back_when_http_hooks_arrive_when_the_cell_stops_working_in_time_or_before_session_start() {
        let t = watch(None);
        let w = &t.w;
        // An http hook (UserPromptSubmit) proves http hooks work for that process.
        w.spawned("a", Http, Some("2.1.100"));
        w.hook("a", "session");
        w.status("a", "working", false);
        w.hook("a", "prompt");
        // A menu redraw after Enter is "working" only briefly.
        w.spawned("b", Http, Some("2.1.100"));
        w.hook("b", "session");
        w.status("b", "working", false);
        t.timers.advance(3000);
        w.status("b", "idle", false);
        // The trust dialog before SessionStart (Claude runs no hooks there).
        w.spawned("c", Http, Some("2.1.100"));
        w.status("c", "working", false);
        // A hooked status never counts.
        w.spawned("d", Http, Some("2.1.100"));
        w.hook("d", "session");
        w.status("d", "working", true);
        // A cell on command hooks is not watched, and an exited one is forgotten.
        w.spawned("e", Shell, Some("2.1.10"));
        w.hook("e", "session");
        w.status("e", "working", false);
        w.spawned("f", Http, Some("2.1.100"));
        w.hook("f", "session");
        w.status("f", "working", false);
        w.forget("f");
        t.timers.advance(HTTP_HOOK_GRACE_MS * 3);
        assert!(t.notices.lock().is_empty());
        assert_eq!(w.form_for(Http, Some("2.1.100")), Http);
        assert_eq!(t.timers.pending(), 0);
    }

    #[test]
    fn remembers_the_fallback_per_claude_version_across_app_runs_a_new_version_tries_http_hooks_again() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FALLBACK_FILE);
        assert_eq!(load_fallback(&file), None);
        save_fallback(&file, "2.1.200").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"claudeVersion":"2.1.200"}"#);
        let (load, save) = fallback_store(file);
        let next = HttpHookWatch::new(HttpHookWatchDeps {
            load,
            save,
            on_fallback: Box::new(|| {}),
            timers: Arc::new(FakeTimers::default()),
        });
        assert_eq!(next.form_for(Exec, Some("2.1.200")), Shell);
        assert_eq!(next.form_for(Exec, Some("2.1.201")), Exec);
    }

    #[test]
    fn the_file_is_read_once_and_a_respawn_restarts_the_watch() {
        let t = watch(Some(""));
        let w = &t.w;
        // A remembered fallback for an unknown version ("") matches a spawn without a version only.
        assert_eq!(w.form_for(Exec, None), Shell);
        assert_eq!(w.form_for(Exec, Some("2.1.1")), Exec);
        assert_eq!(*t.loads.lock(), 1);
        // A respawn during the grace time: the old process's timer never fires for the new one.
        w.spawned("a", Http, Some("2.1.100"));
        w.hook("a", "session");
        w.status("a", "working", false);
        t.timers.advance(10_000);
        w.spawned("a", Http, Some("2.1.100"));
        assert_eq!(t.timers.pending(), 0);
        w.hook("a", "session");
        w.status("a", "working", false);
        w.status("a", "working", false); // a second "working" keeps the running timer
        t.timers.advance(HTTP_HOOK_GRACE_MS - 1);
        assert!(t.notices.lock().is_empty());
        t.timers.advance(1);
        assert_eq!(*t.notices.lock(), ["hint"]);
        // A second blocked cell later in the run saves again but hints no more.
        w.spawned("b", Exec, Some("2.1.5"));
        w.hook("b", "session");
        w.status("b", "working", false);
        t.timers.advance(HTTP_HOOK_GRACE_MS);
        assert_eq!(*t.notices.lock(), ["hint"]);
        assert_eq!(*t.saves.lock(), ["2.1.100", "2.1.5"]);
        assert_eq!(*t.loads.lock(), 1);
    }

    // hook-fallback "allowedHttpHookUrls in the Claude settings"
    #[test]
    fn matches_like_claude_code_2_1_310_does_star_spans_everything_also_the_port_and_the_path() {
        let url = "http://127.0.0.1:51234/k/cell-1/stop/0";
        let list = |p: &[&str]| Some(serde_json::json!({ "allowedHttpHookUrls": p }).to_string());
        assert!(http_hook_url_allowed(&[None, Some("{}".into()), Some("not json".into())], url));
        assert!(http_hook_url_allowed(&[list(&["http://127.0.0.1:*"])], url));
        assert!(http_hook_url_allowed(&[list(&["http://127.0.0.1:*/*"])], url));
        assert!(!http_hook_url_allowed(&[list(&["http://127.0.0.1/*"])], url));
        assert!(!http_hook_url_allowed(&[list(&["http://localhost:*"])], url));
        assert!(!http_hook_url_allowed(&[list(&["https://example.com/*"])], url));
        assert!(!http_hook_url_allowed(&[list(&[])], url));
        assert!(http_hook_url_allowed(&[list(&["https://example.com/*"]), list(&["http://127.0.0.1:*"])], url));
        assert!(!http_hook_url_allowed(&[list(&["http://127x0x0x1:*"])], url));
    }

    #[test]
    fn looks_at_the_managed_policy_the_user_settings_claude_config_dir_and_the_project_settings() {
        let env = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        assert_eq!(
            claude_settings_files(
                "win32",
                "C:\\Users\\a",
                &env(&[("ProgramFiles", "C:\\Program Files"), ("ProgramData", "C:\\ProgramData")]),
                "D:\\p"
            ),
            [
                "C:\\Program Files\\ClaudeCode\\managed-settings.json",
                "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
                "C:\\Users\\a\\.claude\\settings.json",
                "D:\\p\\.claude\\settings.json",
                "D:\\p\\.claude\\settings.local.json",
            ]
        );
        assert_eq!(
            claude_settings_files("darwin", "/Users/a", &env(&[("CLAUDE_CONFIG_DIR", "/cfg")]), "/p"),
            [
                "/Library/Application Support/ClaudeCode/managed-settings.json",
                "/cfg/settings.json",
                "/p/.claude/settings.json",
                "/p/.claude/settings.local.json",
            ]
        );
        assert_eq!(claude_settings_files("linux", "/home/a", &[], "/p")[0], "/etc/claude-code/managed-settings.json");
    }

    // hook-fallback "globMatch"
    #[test]
    fn matches_like_the_anchored_wildcard_patterns_of_allowed_http_hook_urls_in_linear_time() {
        assert!(glob_match("http://127.0.0.1:*", "http://127.0.0.1:5123/k/a"));
        assert!(!glob_match("https://*.example.com/*", "http://127.0.0.1:5123/k/a"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("http://127.0.0.1:5123/k/a", "http://127.0.0.1:5123/k/a"));
        assert!(glob_match("a*b*c", "axxbyyc"));
        assert!(!glob_match("a*b*c", "axxbyy"));
        let started = std::time::Instant::now();
        assert!(!glob_match(&format!("{}b", "*a".repeat(1000)), &"a".repeat(5000)));
        assert!(started.elapsed().as_millis() < 1000);
    }

    #[test]
    fn read_settings_texts_reads_lossily_and_misses_quietly() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.json");
        std::fs::write(&a, b"{\"x\":\"\xff\"}").unwrap();
        let files = [a.display().to_string(), dir.path().join("missing").display().to_string(), dir.path().display().to_string()];
        assert_eq!(read_settings_texts(&files), [Some("{\"x\":\"\u{fffd}\"}".to_string()), None, None]);
    }
}
