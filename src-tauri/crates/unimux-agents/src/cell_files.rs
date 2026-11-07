//! Per-cell files in the data folder (port of src/main/cellFiles.ts, 1.1.4): the Claude hook settings
//! (`hooks/claude-<cell>.json`, they carry the hook token), the MCP config (`mcp/<cell>.json`, it carries the cell's MCP
//! token) and the startup prompts (`prompts/<cell>-<seq36>.txt`, the whole first task in plain text).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::hooks::payload::is_cell_id;

/// The three folders (`CellFileDirs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellFileDirs {
    pub hooks: PathBuf,
    pub prompts: PathBuf,
    pub mcp: PathBuf,
}

impl CellFileDirs {
    /// `<data dir>/hooks`, `<data dir>/prompts`, `<data dir>/mcp`.
    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self { hooks: data_dir.join("hooks"), prompts: data_dir.join("prompts"), mcp: data_dir.join("mcp") }
    }

    fn dir(&self, kind: Kind) -> &Path {
        match kind {
            Kind::Hooks => &self.hooks,
            Kind::Prompts => &self.prompts,
            Kind::Mcp => &self.mcp,
        }
    }
}

/// Which folder (`keyof CellFileDirs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Hooks,
    Prompts,
    Mcp,
}

impl Kind {
    pub const ALL: [Kind; 3] = [Kind::Hooks, Kind::Prompts, Kind::Mcp];

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "hooks" => Some(Self::Hooks),
            "prompts" => Some(Self::Prompts),
            "mcp" => Some(Self::Mcp),
            _ => None,
        }
    }
}

/// The cell a file in one of the folders belongs to, or None for anything else (never touched) (`cellOfFile`):
/// `claude-<cell>.json`, `<cell>.json`, `<cell>.txt` with a `[\w-]{1,64}` cell id.
pub fn cell_of_file(kind: Kind, name: &str) -> Option<&str> {
    let id = match kind {
        Kind::Hooks => name.strip_prefix("claude-")?.strip_suffix(".json")?,
        Kind::Mcp => name.strip_suffix(".json")?,
        Kind::Prompts => name.strip_suffix(".txt")?,
    };
    is_cell_id(id).then_some(id)
}

fn file_of(dirs: &CellFileDirs, kind: Kind, cell_id: &str) -> PathBuf {
    dirs.dir(kind).join(match kind {
        Kind::Hooks => format!("claude-{cell_id}.json"),
        Kind::Mcp => format!("{cell_id}.json"),
        Kind::Prompts => format!("{cell_id}.txt"),
    })
}

/// Startup prompt files (one name per spawn) of each cell's processes, oldest first; None for a spawn without one. An exit or
/// a failed spawn always belongs to the oldest process of the cell, so it removes that one's file and never a respawn's new
/// prompt (`PromptFiles`).
pub struct PromptFiles {
    files: HashMap<String, Vec<Option<PathBuf>>>,
    /// Insertion order of the cells (a JS Map iterates in that order).
    order: Vec<String>,
    remove: Box<dyn Fn(&Path) + Send + Sync>,
}

impl PromptFiles {
    pub fn new(remove: impl Fn(&Path) + Send + Sync + 'static) -> Self {
        Self { files: HashMap::new(), order: Vec::new(), remove: Box::new(remove) }
    }

    pub fn queue(&mut self, cell_id: &str, file: Option<PathBuf>) {
        if !self.files.contains_key(cell_id) {
            self.order.push(cell_id.to_string());
        }
        self.files.entry(cell_id.to_string()).or_default().push(file);
    }

    pub fn release(&mut self, cell_id: &str) {
        let Some(queue) = self.files.get_mut(cell_id) else { return };
        if queue.is_empty() {
            return;
        }
        let file = queue.remove(0);
        if queue.is_empty() {
            self.files.remove(cell_id);
            self.order.retain(|c| c != cell_id);
        }
        if let Some(file) = file {
            (self.remove)(&file);
        }
    }

    /// The terminal process is gone: none of its processes will report an exit any more.
    pub fn release_all(&mut self) {
        for cell_id in self.order.clone() {
            while self.files.contains_key(&cell_id) {
                self.release(&cell_id);
            }
        }
    }
}

/// `rm(file, { force: true })`: a missing file is fine; a folder or a locked file fails.
fn remove_file(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// Removes the cell's files of the given kinds (missing ones are fine; errors are ignored) (`removeCellFiles`).
pub fn remove_cell_files(dirs: &CellFileDirs, cell_id: &str, kinds: &[Kind]) {
    if !is_cell_id(cell_id) {
        return;
    }
    for kind in kinds {
        let _ = remove_file(&file_of(dirs, *kind, cell_id));
    }
}

/// At startup, before any cell runs: hook and MCP files of cells that no longer exist (in any grid or the archive) go, and
/// every startup prompt (a spawn writes its prompt again). Returns how many were removed (`pruneCellFiles`).
pub fn prune_cell_files(dirs: &CellFileDirs, keep: &HashSet<String>) -> usize {
    let mut removed = 0;
    for kind in Kind::ALL {
        let Ok(entries) = std::fs::read_dir(dirs.dir(kind)) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            // A name that is not Unicode can never be a cell file.
            let Some(name) = name.to_str() else { continue };
            let Some(cell_id) = cell_of_file(kind, name) else { continue };
            if kind != Kind::Prompts && keep.contains(cell_id) {
                continue;
            }
            // In use: the next start.
            if remove_file(&dirs.dir(kind).join(name)).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// `cellIdsOf(state, tabsOnly)` of index.ts: the ids of the cells in the projects' grids, plus the archived grids unless
/// `tabs_only`.
pub fn cell_ids_of(state: &Value, tabs_only: bool) -> HashSet<String> {
    let mut ids = HashSet::new();
    let list = |v: &Value, key: &str| v.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    for project in list(state, "projects") {
        let mut tabs = list(&project, "tabs");
        if !tabs_only {
            tabs.extend(list(&project, "archive"));
        }
        for tab in tabs {
            for cell in list(&tab, "cells") {
                if let Some(id) = cell.get("id").and_then(Value::as_str) {
                    ids.insert(id.to_string());
                }
            }
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::Arc;

    fn dirs() -> (tempfile::TempDir, CellFileDirs) {
        let root = tempfile::tempdir().unwrap();
        let d = CellFileDirs::in_data_dir(root.path());
        for dir in [&d.hooks, &d.prompts, &d.mcp] {
            std::fs::create_dir(dir).unwrap();
        }
        (root, d)
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut n: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        n.sort();
        n
    }

    // cell-files "per-cell files"
    #[test]
    fn names_only_the_files_the_app_writes() {
        assert_eq!(cell_of_file(Kind::Hooks, "claude-abc_1.json"), Some("abc_1"));
        assert_eq!(cell_of_file(Kind::Hooks, "hook-debug.log"), None);
        assert_eq!(cell_of_file(Kind::Mcp, "abc.json"), Some("abc"));
        assert_eq!(cell_of_file(Kind::Prompts, "abc.txt"), Some("abc"));
        assert_eq!(cell_of_file(Kind::Prompts, "..\\evil.txt"), None);
    }

    #[test]
    fn at_startup_removes_files_of_cells_that_are_gone_and_every_old_startup_prompt_and_leaves_other_files_alone() {
        let (_root, d) = dirs();
        for id in ["kept", "gone"] {
            std::fs::write(d.hooks.join(format!("claude-{id}.json")), "{}").unwrap();
            std::fs::write(d.mcp.join(format!("{id}.json")), "{}").unwrap();
            std::fs::write(d.prompts.join(format!("{id}.txt")), "secret task").unwrap();
        }
        std::fs::write(d.hooks.join("notes.txt"), "x").unwrap();
        let keep: HashSet<String> = ["kept".to_string()].into();
        assert_eq!(prune_cell_files(&d, &keep), 4);
        assert_eq!(names(&d.hooks), ["claude-kept.json", "notes.txt"]);
        assert_eq!(names(&d.mcp), ["kept.json"]);
        assert!(names(&d.prompts).is_empty());
    }

    #[test]
    fn an_exit_removes_the_prompt_of_the_process_that_ended_never_the_prompt_of_a_respawn_written_before_that_exit_arrived() {
        let removed = Arc::new(Mutex::new(Vec::<String>::new()));
        let r = removed.clone();
        let mut prompts = PromptFiles::new(move |f| r.lock().push(f.display().to_string()));
        let p = |s: &str| Some(PathBuf::from(s));
        prompts.queue("c1", p("c1-1.txt"));
        prompts.queue("c1", p("c1-2.txt")); // respawn wrote its prompt before the old process reported its exit
        prompts.release("c1");
        assert_eq!(*removed.lock(), ["c1-1.txt"]);
        prompts.queue("c2", None);
        prompts.release("c2");
        prompts.release("c2"); // a stray exit does nothing
        prompts.queue("c3", p("c3-1.txt"));
        prompts.release_all();
        assert_eq!(*removed.lock(), ["c1-1.txt", "c1-2.txt", "c3-1.txt"]);
    }

    #[test]
    fn removes_one_cells_files_on_request_and_ignores_a_missing_folder() {
        let (_root, d) = dirs();
        std::fs::write(d.prompts.join("c1.txt"), "task").unwrap();
        std::fs::write(d.hooks.join("claude-c1.json"), "{}").unwrap();
        remove_cell_files(&d, "c1", &[Kind::Prompts]);
        assert!(!d.prompts.join("c1.txt").exists());
        assert!(d.hooks.join("claude-c1.json").exists());
        remove_cell_files(&d, "c1", &Kind::ALL);
        assert!(!d.hooks.join("claude-c1.json").exists());
        std::fs::remove_dir_all(&d.mcp).unwrap();
        assert_eq!(prune_cell_files(&d, &HashSet::new()), 0);
    }

    #[test]
    fn prune_skips_folders_and_never_follows_a_bad_cell_id() {
        let (_root, d) = dirs();
        std::fs::create_dir(d.hooks.join("claude-dir.json")).unwrap();
        std::fs::write(d.prompts.join("a b.txt"), "x").unwrap();
        remove_cell_files(&d, "../x", &Kind::ALL);
        assert_eq!(prune_cell_files(&d, &HashSet::new()), 0);
        assert!(d.hooks.join("claude-dir.json").is_dir());
        assert!(d.prompts.join("a b.txt").exists());
    }

    #[test]
    fn cell_ids_of_reads_grids_and_the_archive() {
        let state = serde_json::json!({ "projects": [
            { "tabs": [{ "cells": [{ "id": "a" }, { "id": "b" }] }], "archive": [{ "cells": [{ "id": "z" }] }] },
            { "tabs": [] },
        ] });
        let all = cell_ids_of(&state, false);
        assert_eq!(all, ["a", "b", "z"].iter().map(|s| s.to_string()).collect());
        assert_eq!(cell_ids_of(&state, true).len(), 2);
    }
}
