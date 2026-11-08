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

    // alerts "defaults: everything on, ...", "keeps valid values", "falls back field by field for garbage", "clamps and rounds
    // the volume", "raises nothing at all while the master switch is off, and keeps the rest of the settings" (the
    // normalization half), "only local absolute paths survive normalization"
    #[test]
    fn alerts_normalize_field_by_field() {
        use settings::{default_alerts, normalize_alerts};
        let d = default_alerts();
        assert_eq!((d["volume"].clone(), d["notifyWhenFocused"].clone()), (json!(0.7), json!(false)));
        assert_eq!(d["quietHours"], json!({"enabled": false, "start": "22:00", "end": "07:00"}));
        for e in ["done", "attention", "error"] {
            assert_eq!(d["events"][e]["notify"], true);
        }
        assert_eq!(state::default_state(Platform::Win32)["settings"]["alerts"], d);
        let mut off = d.clone();
        off["enabled"] = json!(false);
        assert_eq!(normalize_alerts(Some(&off))["enabled"], false);
        assert_eq!(normalize_alerts(Some(&json!({})))["enabled"], true);

        let raw = json!({
            "enabled": false, "volume": 0.35, "notifyWhenFocused": true, "quietHours": {"enabled": true, "start": "23:15", "end": "06:45"},
            "events": {
                "done": {"notify": false, "sound": {"kind": "file", "path": "C:\\a\\b.wav"}},
                "attention": {"notify": true, "sound": {"kind": "system"}},
                "error": {"notify": true, "sound": {"kind": "preset", "id": "retro"}},
            },
            "notificationActions": false, "flashWindow": false, "taskbarBadge": false,
            "limits": {"enabled": false, "fiveHour": {"enabled": false, "percent": 65}, "sevenDay": {"enabled": true, "percent": 100}, "resets": true},
        });
        assert_eq!(normalize_alerts(Some(&raw)), raw);

        for garbage in [None, Some(json!("x")), Some(json!([]))] {
            assert_eq!(normalize_alerts(garbage.as_ref()), d);
        }
        let bad = normalize_alerts(Some(&json!({
            "volume": "loud", "notifyWhenFocused": 1, "notificationActions": "no", "taskbarBadge": 0,
            "quietHours": {"enabled": "yes", "start": "7pm", "end": 5},
            "events": {
                "done": {"notify": "x", "sound": {"kind": "preset", "id": "nope"}},
                "attention": {"notify": false, "sound": {"kind": "file", "path": 5}},
                "error": {"sound": {"kind": "file", "path": ""}},
            },
        })));
        let mut want = d.clone();
        want["events"]["attention"]["notify"] = json!(false);
        assert_eq!(bad, want);
        let nul = json!({"events": {"done": {"sound": {"kind": "file", "path": "a\u{0}.wav"}}}});
        assert_eq!(normalize_alerts(Some(&nul))["events"]["done"]["sound"], d["events"]["done"]["sound"]);

        let volume = |v: Value| normalize_alerts(Some(&json!({"volume": v})))["volume"].clone();
        assert_eq!((volume(json!(5)), volume(json!(-2)), volume(json!(0.333))), (json!(1), json!(0), json!(0.33)));
        assert_eq!(normalize_alerts(Some(&json!({"volume": f64::NAN})))["volume"], json!(0.7));

        let choose = |path: &str| {
            normalize_alerts(Some(&json!({"events": {"done": {"sound": {"kind": "file", "path": path}}}})))["events"]["done"]["sound"]
                .clone()
        };
        for ok in ["C:\\sounds\\a.wav", "D:/s/a.mp3", "/Users/me/a.wav"] {
            assert_eq!(choose(ok), json!({"kind": "file", "path": ok}));
        }
        for bad in [
            "a.wav",
            "./a.wav",
            "..\\a.wav",
            "\\\\host\\share\\a.wav",
            "//host/share/a.wav",
            "\\\\?\\UNC\\h\\s\\a.wav",
            "\\\\?\\C:\\a.wav",
            "\\\\.\\pipe\\x",
        ] {
            assert_eq!(choose(bad), d["events"]["done"]["sound"], "{bad}");
        }
    }

    // alerts "a fresh install (no retired keys) gets the defaults", "off stays off for every event; ...", "the system sound
    // moves to every event ...", "an own file moves to every event with its volume ...", "custom without a file used to beep,
    // ...", "missing or garbage legacy values behave like the old defaults ...", "never keeps or writes the retired keys, and
    // saved alerts win over them"
    #[test]
    fn retired_alert_settings_migrate_once() {
        let d = settings::default_alerts();
        let migrate = |settings: Value| {
            let mut s = state::default_state(Platform::Win32);
            s["settings"] = settings;
            StateNormalizer.normalize(s, Platform::Win32).unwrap()["settings"].clone()
        };
        let events = |a: &Value, want: Value| {
            for e in ["done", "attention", "error"] {
                assert_eq!(a["events"][e], want, "{e}");
            }
        };
        assert_eq!(migrate(json!({"language": "en"}))["alerts"], d);
        assert_eq!(settings::read_alerts(Some(&json!({}))).unwrap(), d);
        let off = migrate(
            json!({"notifications": false, "waitingSound": "off", "waitingSoundFile": "", "waitingSoundVolume": 70, "notifyWhenFocused": true}),
        );
        assert_eq!((off["alerts"]["volume"].clone(), off["alerts"]["notifyWhenFocused"].clone()), (json!(0.7), json!(true)));
        events(&off["alerts"], json!({"notify": false, "sound": {"kind": "off"}}));
        let system =
            migrate(json!({"notifications": true, "waitingSound": "system", "waitingSoundFile": "", "waitingSoundVolume": 70}));
        events(&system["alerts"], json!({"notify": true, "sound": {"kind": "system"}}));
        let file = migrate(
            json!({"notifications": true, "waitingSound": "custom", "waitingSoundFile": "C:\\s\\ding.mp3", "waitingSoundVolume": 30}),
        );
        assert_eq!(file["alerts"]["volume"], json!(0.3));
        events(&file["alerts"], json!({"notify": true, "sound": {"kind": "file", "path": "C:\\s\\ding.mp3"}}));
        let beep = migrate(json!({"notifications": true, "waitingSound": "custom", "waitingSoundFile": ""}));
        assert_eq!(beep["alerts"]["events"]["done"]["sound"], json!({"kind": "system"}));
        let missing = migrate(json!({"notifications": true}));
        assert_eq!(missing["alerts"]["volume"], json!(0.7));
        events(&missing["alerts"], json!({"notify": true, "sound": {"kind": "off"}}));
        let garbage = migrate(
            json!({"notifications": "maybe", "waitingSound": "loud", "waitingSoundFile": 5, "waitingSoundVolume": "x", "notifyWhenFocused": "yes"}),
        );
        assert_eq!(
            (garbage["alerts"]["volume"].clone(), garbage["alerts"]["notifyWhenFocused"].clone()),
            (json!(0.7), json!(false))
        );
        events(&garbage["alerts"], json!({"notify": true, "sound": {"kind": "off"}}));
        let loud = migrate(
            json!({"notifications": true, "waitingSound": "custom", "waitingSoundFile": "x.wav", "waitingSoundVolume": 900}),
        );
        assert_eq!(loud["alerts"]["volume"], json!(1));

        let settings = migrate(
            json!({"notifications": false, "waitingSound": "system", "waitingSoundFile": "a.wav", "waitingSoundVolume": 10, "notifyWhenFocused": true}),
        );
        for key in settings::LEGACY_ALERT_KEYS {
            assert!(settings.get(key).is_none(), "{key}");
        }
        let mixed = migrate(json!({"notifications": false, "waitingSound": "system", "alerts": {"volume": 0.2}}));
        assert_eq!(mixed["alerts"]["volume"], json!(0.2));
        assert_eq!(mixed["alerts"]["events"]["done"], d["events"]["done"]);
        assert_eq!(migrate(settings.clone())["alerts"], settings["alerts"]);
    }

    // automation-retention "runs on load and when a project is removed" (the load half; removeProject is a renderer edit of
    // src/shared/state.ts), automation "migrates existing app data without losing snippets, projects or language"
    #[test]
    fn loading_prunes_the_inboxes_and_gives_an_old_state_an_empty_automation() {
        let task = |id: &str, project: &str| {
            json!({ "id": id, "projectId": project, "cellId": "c", "title": id, "prompt": "p",
            "status": "queued", "delivery": "startup", "createdAt": 1, "updatedAt": 1 })
        };
        let mut s = state::default_state(Platform::Win32);
        s["projects"] = json!([
            { "id": "p1", "name": "A", "path": "D:/a", "tabs": [], "archive": [] },
            { "id": "p2", "name": "B", "path": "D:/b", "tabs": [], "archive": [] }
        ]);
        s["automation"]["tasks"] = json!([task("t1", "p1"), task("t2", "p2"), task("orphan", "nowhere")]);
        let loaded = StateNormalizer.normalize(s, Platform::Win32).unwrap();
        let ids: Vec<&str> =
            loaded["automation"]["tasks"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["t1", "t2"]);

        let mut legacy = state::default_state(Platform::Win32);
        legacy.as_object_mut().unwrap().remove("automation");
        legacy["settings"]["language"] = json!("pl");
        let restored = StateNormalizer.normalize(legacy, Platform::Win32).unwrap();
        assert_eq!(restored["automation"], json!({ "paused": false, "tasks": [], "messages": [], "events": [] }));
        assert_eq!(restored["settings"]["language"], "pl");
    }

    // team-start "defaults to "auto" with 4 agents, also for a state.json of 1.1.3", "clamps and repairs bad values"
    #[test]
    fn the_delegation_setting_defaults_to_auto_with_4_agents_and_repairs_bad_values() {
        let auto4 = json!({ "mode": "auto", "maxAgents": 4 });
        assert_eq!(state::default_state(Platform::Win32)["settings"]["delegation"], auto4);
        let mut old = state::default_state(Platform::Win32);
        old["settings"].as_object_mut().unwrap().remove("delegation");
        assert_eq!(StateNormalizer.normalize(old.clone(), Platform::Win32).unwrap()["settings"]["delegation"], auto4);
        old["settings"]["delegation"] = json!({ "mode": "ask", "maxAgents": 7 });
        assert_eq!(
            StateNormalizer.normalize(old, Platform::Win32).unwrap()["settings"]["delegation"],
            json!({ "mode": "ask", "maxAgents": 7 })
        );
        let n = |v: Value| settings::normalize_delegation(Some(&v));
        assert_eq!(n(json!({ "mode": "sometimes", "maxAgents": 99 })), json!({ "mode": "auto", "maxAgents": 20 }));
        assert_eq!(n(json!({ "mode": "ask", "maxAgents": 0 })), json!({ "mode": "ask", "maxAgents": 1 }));
        assert_eq!(n(json!({ "maxAgents": "x" })), auto4);
        assert_eq!(n(Value::Null), auto4);
        assert_eq!(settings::normalize_delegation(None), auto4);
    }

    // agent-work "keeps the "do not ask again" setting through a save and defaults to asking"
    #[test]
    fn the_quit_question_setting_survives_a_save_and_defaults_to_asking() {
        let fresh = state::default_state(Platform::Win32);
        assert_eq!(fresh["settings"]["confirmCloseWorking"], true);
        let load = |confirm: Option<Value>| {
            let mut s = fresh.clone();
            match confirm {
                Some(v) => s["settings"]["confirmCloseWorking"] = v,
                None => {
                    s["settings"].as_object_mut().unwrap().remove("confirmCloseWorking");
                }
            }
            StateNormalizer.normalize(s, Platform::Win32).unwrap()["settings"]["confirmCloseWorking"].clone()
        };
        assert_eq!(load(Some(json!(false))), false);
        assert_eq!(load(Some(json!("no"))), true);
        assert_eq!(load(None), true);
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
