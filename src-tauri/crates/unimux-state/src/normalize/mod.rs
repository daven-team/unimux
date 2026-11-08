//! The normalization of the state (PLAN F8). 1.1.4 runs `normalizeState` (src/shared/state.ts and the normalizers it calls)
//! on load and `normalizeEditedState` (src/main/stateController.ts) on every renderer edit. Both are ported here with the
//! JavaScript semantics they depend on ([`js`]): key order of spreads, `undefined` fields dropped by JSON.stringify, UTF-16
//! lengths, names inherited from Object.prototype, and the places where the TS code throws (the file then counts as corrupt).
//! The golden corpus (test/golden/normalize-state.jsonl, state-after-edit.jsonl, written by scripts/dump-goldens.mjs from the
//! TS code) checks every answer byte for byte; the TS copies stay for the renderer and CI fails when they drift apart.
//!
//! - [`state`]: defaultState, normalizeState (profiles, settings, projects / tabs / cells, unique grid ids, active fallbacks,
//!   strip order, detached windows, inbox retention) and the edit normalization.
//! - [`settings`], [`shortcuts`]: the settings normalizers. [`grid`]: layouts, templates, prompt queues, notes.
//!   [`remote`]: SSH hosts / identities / cell refs, SFTP places, database connections and folder colours.
//!   [`windows`]: workspace order, detached windows, pruneAutomation. [`timsort`]: V8's Array.prototype.sort.

pub mod grid;
pub mod js;
pub mod remote;
pub mod settings;
pub mod shortcuts;
pub mod state;
pub mod timsort;
pub mod windows;

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

/// The 1.1.4 rules ([`state::normalize_state`], [`state::normalize_edited_state`]) with the real clock and random grid ids.
#[derive(Debug, Default, Clone, Copy)]
pub struct StateNormalizer;

impl Normalizer for StateNormalizer {
    fn normalize(&self, raw: Value, platform: Platform) -> Option<Value> {
        let mut uid = || uuid::Uuid::new_v4().to_string();
        let mut env = state::Env { now_ms: unimux_core::time::now_ms() as f64, uid: &mut uid };
        state::normalize_state(&raw, platform, &mut env)
    }
    fn default_state(&self, platform: Platform) -> Value {
        state::default_state(platform)
    }
    fn after_edit(&self, merged: Value, previous: &Value) -> Result<Value, String> {
        state::normalize_edited_state(merged, previous)
    }
}

/// Valid states pass unchanged (a test seam for the store and the controller); detached windows stay main's.
#[derive(Debug, Default, Clone, Copy)]
pub struct PassThrough;

impl Normalizer for PassThrough {
    fn normalize(&self, raw: Value, _platform: Platform) -> Option<Value> {
        let o = raw.as_object()?;
        if o.get("version") != Some(&Value::from(1)) || !o.get("projects").is_some_and(Value::is_array) {
            return None;
        }
        Some(raw)
    }
    fn default_state(&self, platform: Platform) -> Value {
        state::default_state(platform)
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
    fn defaults_match_the_ts_code() {
        let golden: Value = serde_json::from_str(include_str!("../../../../../test/golden/default-state.json")).unwrap();
        for platform in [Platform::Win32, Platform::Darwin] {
            let ours = state::default_state(platform);
            assert_eq!(unimux_core::js_json::stringify(&ours), unimux_core::js_json::stringify(&golden[platform.as_str()]));
            assert_eq!(StateNormalizer.default_state(platform), ours);
        }
        assert_eq!(state::default_state(Platform::Darwin)["profiles"][2]["name"], "Terminal");
    }

    /// test/perf-098.test.ts "scrollback setting": the choices, the default and the normalization of a saved value.
    #[test]
    fn the_scrollback_setting_offers_its_choices_with_5000_as_the_default() {
        assert_eq!(state::default_state(Platform::Win32)["settings"]["scrollbackLines"], 5000);
        for ok in [1000, 2500, 5000, 10_000, 25_000] {
            assert_eq!(settings::normalize_scrollback(Some(&json!(ok))), json!(ok));
        }
        for bad in [Value::Null, json!(0), json!(-5), json!(7000), json!("5000"), json!(1e9), json!(f64::NAN)] {
            assert_eq!(settings::normalize_scrollback(Some(&bad)), json!(5000), "{bad}");
        }
        assert_eq!(settings::normalize_scrollback(None), json!(5000));
        let with = |settings: Value| {
            StateNormalizer.normalize(json!({"version": 1, "projects": [], "settings": settings}), Platform::Win32).unwrap()
        };
        assert_eq!(with(json!({}))["settings"]["scrollbackLines"], 5000, "an older state without the setting");
        assert_eq!(with(json!({"scrollbackLines": 123}))["settings"]["scrollbackLines"], 5000);
        assert_eq!(with(json!({"scrollbackLines": 10_000}))["settings"]["scrollbackLines"], 10_000);
    }

    #[test]
    fn the_language_rule_of_existing_installations() {
        // A state without a language (an installation from before the language choice) keeps Polish; an unknown one asks again.
        let s = |settings: Value| {
            StateNormalizer.normalize(json!({"version": 1, "projects": [], "settings": settings}), Platform::Win32).unwrap()
        };
        assert_eq!(s(json!({}))["settings"]["language"], "pl");
        assert_eq!(s(json!({"language": "de"}))["settings"]["language"], "de");
        assert_eq!(s(json!({"language": "xx"}))["settings"]["language"], Value::Null);
        assert_eq!(s(json!({"language": null}))["settings"]["language"], Value::Null);
        assert_eq!(
            StateNormalizer.normalize(json!({"version": 1, "projects": []}), Platform::Darwin).unwrap()["settings"]["shell"],
            "zsh"
        );
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
