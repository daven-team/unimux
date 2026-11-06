//! The normalization seam. 1.1.4 runs `normalizeState` (src/shared/state.ts and the normalizers it calls) on load and a part
//! of it on every renderer edit (stateController.ts apply). Package F8 ports all of it behind [`Normalizer`], gated by the
//! golden corpus. Until then [`PassThrough`] keeps a valid state (version 1 with a projects list) exactly as it is, and the
//! default state comes from the golden corpus written by the TS code itself (test/golden/default-state.json), so a fresh
//! start gets the same defaults as 1.1.4.

use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Win32,
    Darwin,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") { Platform::Darwin } else { Platform::Win32 }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Win32 => "win32",
            Platform::Darwin => "darwin",
        }
    }
}

pub trait Normalizer: Send + Sync {
    /// `normalizeState(raw, platform)`: None for something that is not a state (corrupt).
    fn normalize(&self, raw: Value, platform: Platform) -> Option<Value>;
    /// `defaultState(platform)`.
    fn default_state(&self, platform: Platform) -> Value;
    /// The normalization of a renderer edit (stateController.ts apply), after the merge. `previous` is the state before.
    fn after_edit(&self, merged: Value, previous: &Value) -> Result<Value, String>;
}

/// Wave 0: valid states pass unchanged; detached windows stay main's (a renderer edit never adds, moves or removes one).
#[derive(Debug, Default, Clone, Copy)]
pub struct PassThrough;

static DEFAULTS: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../test/golden/default-state.json")).unwrap_or(Value::Null)
});

/// `defaultState(platform)` as 1.1.4 computes it (from the golden corpus).
pub fn golden_default_state(platform: Platform) -> Value {
    DEFAULTS.get(platform.as_str()).cloned().unwrap_or_else(|| {
        let mut m = Map::new();
        m.insert("version".into(), Value::from(1));
        m.insert("projects".into(), Value::Array(vec![]));
        Value::Object(m)
    })
}

impl Normalizer for PassThrough {
    fn normalize(&self, raw: Value, _platform: Platform) -> Option<Value> {
        let o = raw.as_object()?;
        if o.get("version") != Some(&Value::from(1)) || !o.get("projects").is_some_and(Value::is_array) {
            return None;
        }
        Some(raw)
    }
    fn default_state(&self, platform: Platform) -> Value {
        golden_default_state(platform)
    }
    fn after_edit(&self, mut merged: Value, previous: &Value) -> Result<Value, String> {
        let Some(out) = merged.as_object_mut() else { return Err("the edited state is not an object".into()) };
        match previous.get("detachedWindows") {
            Some(d) => {
                out.insert("detachedWindows".into(), d.clone());
            }
            None => {
                out.shift_remove("detachedWindows");
            }
        }
        Ok(merged)
    }
}

/// `unlessRestoring`: with the SSH session restore off, no cell keeps the "connected at close" mark of the last run.
pub fn unless_restoring(mut state: Value) -> Value {
    if state.pointer("/settings/sshRestoreSessions") == Some(&Value::Bool(true)) {
        return state;
    }
    let Some(projects) = state.get_mut("projects").and_then(Value::as_array_mut) else { return state };
    for project in projects {
        let Some(tabs) = project.get_mut("tabs").and_then(Value::as_array_mut) else { continue };
        for tab in tabs {
            let Some(cells) = tab.get_mut("cells").and_then(Value::as_array_mut) else { continue };
            for cell in cells {
                let Some(ssh) = cell.get_mut("ssh").and_then(Value::as_object_mut) else { continue };
                if ssh.get("resume").is_some_and(|r| !r.is_null() && r != &Value::Bool(false)) {
                    // patchSshCellRef(ref, {resume: false}) -> { hostId, ...(cwd ? {cwd} : {}) }
                    let mut next = Map::new();
                    if let Some(h) = ssh.get("hostId") {
                        next.insert("hostId".into(), h.clone());
                    }
                    if let Some(cwd) = ssh.get("cwd").filter(|c| c.as_str().is_some_and(|s| !s.is_empty())) {
                        next.insert("cwd".into(), cwd.clone());
                    }
                    *ssh = next;
                }
            }
        }
    }
    state
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pass_through_rejects_non_states() {
        assert!(PassThrough.normalize(json!({"version": 2, "projects": []}), Platform::Win32).is_none());
        assert!(PassThrough.normalize(json!({"version": 1}), Platform::Win32).is_none());
        assert!(PassThrough.normalize(json!([]), Platform::Win32).is_none());
        assert!(PassThrough.normalize(json!({"version": 1, "projects": []}), Platform::Win32).is_some());
    }

    #[test]
    fn defaults_come_from_the_ts_code() {
        let d = golden_default_state(Platform::Win32);
        assert_eq!(d["version"], 1);
        assert_eq!(d["settings"]["fontSize"], 13);
        assert!(d["profiles"].as_array().is_some_and(|p| !p.is_empty()));
        assert_ne!(golden_default_state(Platform::Darwin)["settings"]["shell"], d["settings"]["shell"]);
    }

    #[test]
    fn detached_windows_stay_mains() {
        let prev = json!({"detachedWindows": [{"id": "w"}], "a": 1});
        let merged = json!({"a": 2, "detachedWindows": []});
        assert_eq!(PassThrough.after_edit(merged, &prev).unwrap(), json!({"a": 2, "detachedWindows": [{"id": "w"}]}));
        assert_eq!(PassThrough.after_edit(json!({"a": 2, "detachedWindows": []}), &json!({})).unwrap(), json!({"a": 2}));
    }

    #[test]
    fn strips_ssh_resume_marks_unless_restoring() {
        let s = json!({"settings": {}, "projects": [{"tabs": [{"cells": [{"ssh": {"hostId": "h", "cwd": "/x", "resume": true}}, {"ssh": {"hostId": "g"}}]}]}]});
        let out = unless_restoring(s.clone());
        assert_eq!(out["projects"][0]["tabs"][0]["cells"][0]["ssh"], json!({"hostId": "h", "cwd": "/x"}));
        assert_eq!(out["projects"][0]["tabs"][0]["cells"][1]["ssh"], json!({"hostId": "g"}));
        let mut keep = s.clone();
        keep["settings"]["sshRestoreSessions"] = json!(true);
        assert_eq!(unless_restoring(keep.clone()), keep);
    }
}
