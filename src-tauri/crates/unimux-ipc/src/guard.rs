//! The sender guard (port of src/main/ipcGuard.ts + safeWindow.ts isFromWindow). Every channel that changes something runs
//! only for the app's own windows: the label `main` or a registered `detached-<uuid>`, loaded from the app origin, top-level
//! frame. Tauri capabilities already grant the mc_* commands only to those labels (an update window cannot call them at all);
//! this check is the second line and also covers windows that were closed or never registered.

use std::collections::HashSet;

use parking_lot::RwLock;

/// Who called: the webview label, the URL of the calling document and whether it is the top-level frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub label: String,
    pub url: String,
    pub main_frame: bool,
}

impl Caller {
    pub fn new(label: impl Into<String>, url: impl Into<String>) -> Self {
        Self { label: label.into(), url: url.into(), main_frame: true }
    }
    /// The origin of the calling document (`scheme://host[:port]`), empty when it has none.
    pub fn origin(&self) -> &str {
        origin_of(&self.url)
    }
    /// True for the main window.
    pub fn is_main(&self) -> bool {
        self.label == "main"
    }
}

/// `scheme://host[:port]` of a URL ("" for anything without `://`).
pub fn origin_of(url: &str) -> &str {
    let Some(scheme_end) = url.find("://") else { return "" };
    let rest = &url[scheme_end + 3..];
    let end = rest.find(['/', '?', '#']).map(|i| scheme_end + 3 + i).unwrap_or(url.len());
    &url[..end]
}

/// Decides whether a caller may run a guarded command.
pub trait Guard: Send + Sync {
    fn allowed(&self, caller: &Caller) -> bool;
}

/// Read-only channels open to any window that can reach mc_invoke at all (OPEN_IPC_CHANNELS of 1.1.4, with the reason).
pub const OPEN_COMMANDS: &[(&str, &str)] = &[
    ("state:load", "reads the state in memory"),
    ("state:snapshot", "reads the state in memory"),
    ("mcp:info", "reads the MCP server status"),
    ("cell:alive", "lists running cell ids"),
    ("cli:status", "reads the cached CLI detection"),
    ("install:options", "lists the install methods of a CLI"),
    ("install:current", "reads the running install, if any"),
    ("sound:load", "reads the sound file saved in the settings (the path never comes from the renderer)"),
    ("fs:exists", "checks whether a path exists"),
    ("fs:pathKinds", "stats dropped paths"),
    ("fs:listProjectDirectory", "lists a project folder"),
    ("fs:listProjectDirectoryBatch", "lists project folders"),
    ("fs:listProjectDirectories", "lists project folders"),
    ("fs:searchProject", "searches project files (the running search is kept per sender)"),
    ("fs:readProjectFile", "reads a project file"),
    ("fs:statProjectFile", "size and modification time of a project file"),
    ("sessions:list", "lists conversation files of a project"),
    ("git:isRepo", "checks whether a folder is a git repository"),
    ("git:probe", "checks whether the project is a repository"),
    ("git:worktrees", "lists the worktrees of the project"),
    ("git:status", "read-only git channel"),
    ("git:log", "read-only git channel"),
    ("git:show", "read-only git channel"),
    ("git:diff", "read-only git channel"),
    ("git:branches", "read-only git channel"),
    ("git:trust", "read-only git channel (trust info)"),
    ("update:get", "reads the update state"),
];

pub fn is_open(command: &str) -> bool {
    OPEN_COMMANDS.iter().any(|(c, _)| *c == command)
}

/// The production guard: `main` or a registered detached window, from one of the app origins, top-level frame only.
#[derive(Debug)]
pub struct WindowGuard {
    app_origins: Vec<String>,
    detached: RwLock<HashSet<String>>,
}

impl WindowGuard {
    /// `app_origins`: `http://tauri.localhost` (Windows), `tauri://localhost` (macOS) and the dev server in dev builds.
    pub fn new(app_origins: Vec<String>) -> Self {
        Self { app_origins, detached: RwLock::new(HashSet::new()) }
    }
    /// A detached window was created by the app (W5 calls this; its label is `detached-<uuid>`).
    pub fn register_detached(&self, label: &str) {
        if label.starts_with("detached-") {
            self.detached.write().insert(label.to_string());
        }
    }
    pub fn forget_detached(&self, label: &str) {
        self.detached.write().remove(label);
    }
}

impl Guard for WindowGuard {
    fn allowed(&self, caller: &Caller) -> bool {
        if !caller.main_frame {
            return false;
        }
        let origin = caller.origin();
        if !self.app_origins.iter().any(|o| o.eq_ignore_ascii_case(origin)) {
            return false;
        }
        caller.label == "main" || self.detached.read().contains(&caller.label)
    }
}

#[cfg(test)]
mod tests {
    //! Cases of test/ipc-guard.test.ts and test/safe-window.test.ts (isFromWindow) in their 1.2.0 form.
    use super::*;

    fn guard() -> WindowGuard {
        WindowGuard::new(vec!["http://tauri.localhost".into(), "tauri://localhost".into()])
    }

    #[test]
    fn origin_parsing() {
        assert_eq!(origin_of("http://tauri.localhost/index.html?detached=x"), "http://tauri.localhost");
        assert_eq!(origin_of("tauri://localhost"), "tauri://localhost");
        assert_eq!(origin_of("http://localhost:5174/#a"), "http://localhost:5174");
        assert_eq!(origin_of("about:blank"), "");
    }

    #[test]
    fn the_main_window_is_allowed() {
        assert!(guard().allowed(&Caller::new("main", "http://tauri.localhost/index.html")));
        assert!(guard().allowed(&Caller::new("main", "tauri://localhost/index.html")));
    }

    #[test]
    fn an_unknown_label_is_refused() {
        assert!(!guard().allowed(&Caller::new("login", "http://tauri.localhost/index.html")));
        assert!(!guard().allowed(&Caller::new("detached-1", "http://tauri.localhost/index.html")));
    }

    #[test]
    fn the_update_gate_and_update_window_are_refused() {
        assert!(!guard().allowed(&Caller::new("update-gate", "http://tauri.localhost/update-splash/index.html")));
        assert!(!guard().allowed(&Caller::new("update-window", "http://tauri.localhost/update-splash/index.html")));
    }

    #[test]
    fn a_registered_detached_window_is_allowed_until_forgotten() {
        let g = guard();
        g.register_detached("detached-abc");
        g.register_detached("main-imposter");
        assert!(g.allowed(&Caller::new("detached-abc", "http://tauri.localhost/index.html?detached=abc")));
        assert!(!g.allowed(&Caller::new("main-imposter", "http://tauri.localhost/index.html")));
        g.forget_detached("detached-abc");
        assert!(!g.allowed(&Caller::new("detached-abc", "http://tauri.localhost/index.html?detached=abc")));
    }

    #[test]
    fn a_foreign_origin_is_refused() {
        assert!(!guard().allowed(&Caller::new("main", "https://example.com/")));
        assert!(!guard().allowed(&Caller::new("main", "http://tauri.localhost.evil.com/")));
        assert!(!guard().allowed(&Caller::new("main", "")));
    }

    #[test]
    fn a_subframe_is_refused() {
        let mut c = Caller::new("main", "http://tauri.localhost/index.html");
        c.main_frame = false;
        assert!(!guard().allowed(&c));
    }

    #[test]
    fn open_commands_are_reads_only() {
        assert!(is_open("state:snapshot"));
        assert!(is_open("git:status"));
        assert!(!is_open("state:edit"));
        assert!(!is_open("git:commit"));
        assert!(!is_open("clipboard:writeSecret"));
        // Every open command is a channel of the contract.
        let contract = crate::Contract::embedded();
        for (c, _) in OPEN_COMMANDS {
            assert!(contract.channel(c).is_some(), "{c} is not in the contract");
        }
    }
}
