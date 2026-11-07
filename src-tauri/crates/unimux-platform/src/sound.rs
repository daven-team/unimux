//! Own alert sound files (port of src/shared/sound.ts limits and src/main/alertSound.ts). The renderer may not load file://
//! URLs, so the bytes of the sound the user picked for an event are read here and sent as one raw IPC answer. The path is
//! never taken from the renderer: only the saved setting of the asked event (set from the native dialog result) is read.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde_json::Value;

pub const SOUND_EXTENSIONS: [&str; 6] = ["wav", "mp3", "ogg", "m4a", "aac", "flac"];
/// Custom sound files above this size are refused (they are read whole and sent over IPC).
pub const SOUND_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// `ALERT_EVENTS` of src/shared/alerts.ts.
pub const ALERT_EVENTS: [&str; 3] = ["done", "attention", "error"];

/// `isSoundFile`: `/\.([a-z0-9]+)$/i` with a whitelisted extension.
pub fn is_sound_file(path: &str) -> bool {
    let Some(dot) = path.rfind('.') else { return false };
    let ext = &path[dot + 1..];
    !ext.is_empty()
        && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        && SOUND_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext))
}

/// `isLocalAbsolutePath`: a drive path (`C:\x`, `C:/x`) or a POSIX path; anything starting with two separators (UNC,
/// `\\?\`, `\\.\`, `//host/share`) and relative paths are refused.
pub fn is_local_absolute_path(path: &str) -> bool {
    let b = path.as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    if b.len() >= 2 && sep(b[0]) && sep(b[1]) {
        return false;
    }
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && sep(b[2])) || path.starts_with('/')
}

/// `isAlertEvent`.
pub fn is_alert_event(value: &Value) -> bool {
    value.as_str().is_some_and(|s| ALERT_EVENTS.contains(&s))
}

/// The answer of `sound:load`: `{ ok: true, key, data }` (data None = the renderer's key is still current) or `{ ok: false }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SoundLoad {
    Loaded { key: String, data: Option<Vec<u8>> },
    Refused,
}

/// `${path}|${size}|${mtimeMs}` with Node's mtimeMs (`sec * 1e3 + nsec / 1e6` as a double, printed like JS).
fn sound_key(path: &str, size: u64, modified: std::time::SystemTime) -> String {
    let mtime_ms = match modified.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6,
        Err(e) => {
            let d = e.duration();
            -(d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6)
        }
    };
    let mut buf = ryu_js::Buffer::new();
    format!("{path}|{size}|{}", buf.format(mtime_ms))
}

/// `loadSoundFile`: only local absolute paths with a sound extension, no symbolic links (or junctions), a regular file of
/// 1 byte to 5 MiB. Never fails: any problem is `Refused`. `known_key` unchanged -> no bytes.
pub fn load_sound_file(path: &str, known_key: Option<&str>) -> SoundLoad {
    if path.is_empty() || !is_local_absolute_path(path) || !is_sound_file(path) {
        return SoundLoad::Refused;
    }
    let p = Path::new(path);
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => return SoundLoad::Refused,
        Ok(_) => {}
        Err(_) => return SoundLoad::Refused,
    }
    let Ok(info) = std::fs::metadata(p) else { return SoundLoad::Refused };
    if !info.is_file() || info.len() == 0 || info.len() > SOUND_MAX_BYTES {
        return SoundLoad::Refused;
    }
    let Ok(modified) = info.modified() else { return SoundLoad::Refused };
    let key = sound_key(path, info.len(), modified);
    if known_key == Some(key.as_str()) {
        return SoundLoad::Loaded { key, data: None };
    }
    match std::fs::read(p) {
        Ok(data) if data.len() as u64 <= SOUND_MAX_BYTES => SoundLoad::Loaded { key, data: Some(data) },
        _ => SoundLoad::Refused,
    }
}

/// `loadEventSound(alerts, event, knownKey)`: `alerts` is `state.settings.alerts` (normalized); the event must be one of
/// [`ALERT_EVENTS`] and its saved sound an own file. A key that is not a string counts as none.
pub fn load_event_sound(alerts: &Value, event: &Value, known_key: &Value) -> SoundLoad {
    if !is_alert_event(event) {
        return SoundLoad::Refused;
    }
    let event = event.as_str().unwrap_or_default();
    let sound = alerts.get("events").and_then(|e| e.get(event)).and_then(|e| e.get("sound"));
    let Some(sound) = sound else { return SoundLoad::Refused };
    if sound.get("kind").and_then(Value::as_str) != Some("file") {
        return SoundLoad::Refused;
    }
    let Some(path) = sound.get("path").and_then(Value::as_str) else { return SoundLoad::Refused };
    load_sound_file(path, known_key.as_str())
}

#[cfg(test)]
mod tests {
    //! Ports of test/alert-sound-file.test.ts and the isSoundFile case of test/sound.test.ts.
    use super::*;
    use serde_json::json;

    fn dir() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("mc-sound-").tempdir().unwrap()
    }
    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }
    fn alerts(patch: Value) -> Value {
        let mut events = json!({
            "done": { "notify": true, "sound": { "kind": "preset", "id": "chime" } },
            "attention": { "notify": true, "sound": { "kind": "preset", "id": "ping" } },
            "error": { "notify": true, "sound": { "kind": "preset", "id": "low" } },
        });
        for (k, v) in patch.as_object().unwrap() {
            events[k] = v.clone();
        }
        json!({ "events": events, "notificationActions": true, "flashWindow": true })
    }

    #[test]
    fn reads_a_small_whitelisted_file_and_skips_bytes_for_a_known_key() {
        let d = dir();
        let file = d.path().join("a.wav");
        std::fs::write(&file, [1, 2, 3]).unwrap();
        let SoundLoad::Loaded { key, data } = load_sound_file(&s(&file), None) else { panic!() };
        assert_eq!(data.unwrap(), vec![1, 2, 3]);
        assert!(key.starts_with(&format!("{}|3|", s(&file))));
        assert_eq!(load_sound_file(&s(&file), Some(&key)), SoundLoad::Loaded { key, data: None });
    }

    #[test]
    fn refuses_missing_empty_oversized_wrong_extension_files_and_directories_without_throwing() {
        let d = dir();
        let big = d.path().join("big.mp3");
        std::fs::write(&big, vec![0u8; SOUND_MAX_BYTES as usize + 1]).unwrap();
        let empty = d.path().join("empty.ogg");
        std::fs::write(&empty, b"").unwrap();
        let exe = d.path().join("x.exe");
        std::fs::write(&exe, b"x").unwrap();
        for path in [s(&d.path().join("missing.wav")), s(&big), s(&empty), s(&exe), s(d.path()), String::new()] {
            assert_eq!(load_sound_file(&path, None), SoundLoad::Refused, "{path}");
        }
    }

    #[test]
    fn reads_the_saved_file_of_the_asked_event_only() {
        let d = dir();
        let file = d.path().join("done.wav");
        std::fs::write(&file, [9, 8, 7]).unwrap();
        let a = alerts(json!({ "done": { "notify": true, "sound": { "kind": "file", "path": s(&file) } } }));
        let SoundLoad::Loaded { key, data } = load_event_sound(&a, &json!("done"), &Value::Null) else { panic!() };
        assert_eq!(data.unwrap(), vec![9, 8, 7]);
        assert_eq!(load_event_sound(&a, &json!("done"), &json!(key.clone())), SoundLoad::Loaded { key, data: None });
        assert_eq!(load_event_sound(&a, &json!("attention"), &Value::Null), SoundLoad::Refused);
        assert_eq!(load_event_sound(&a, &json!("error"), &Value::Null), SoundLoad::Refused);
    }

    #[test]
    fn keeps_every_file_check_per_event() {
        let d = dir();
        let exe = d.path().join("y.exe");
        std::fs::write(&exe, b"x").unwrap();
        let big = d.path().join("big2.flac");
        std::fs::write(&big, vec![0u8; SOUND_MAX_BYTES as usize + 1]).unwrap();
        let empty = d.path().join("empty2.wav");
        std::fs::write(&empty, b"").unwrap();
        for path in [s(&exe), s(&big), s(&empty), s(d.path()), s(&d.path().join("nope.wav"))] {
            let a = alerts(json!({ "error": { "notify": true, "sound": { "kind": "file", "path": path } } }));
            assert_eq!(load_event_sound(&a, &json!("error"), &Value::Null), SoundLoad::Refused);
        }
    }

    #[test]
    fn never_accepts_a_path_or_an_unknown_event_from_the_caller() {
        let d = dir();
        let file = d.path().join("safe.wav");
        std::fs::write(&file, [1]).unwrap();
        let a = alerts(json!({ "done": { "notify": true, "sound": { "kind": "file", "path": s(&file) } } }));
        for event in [
            json!(s(&file)),
            json!("__proto__"),
            json!("constructor"),
            json!("toString"),
            json!(""),
            Value::Null,
            json!(5),
            json!({ "path": s(&file) }),
        ] {
            assert_eq!(load_event_sound(&a, &event, &Value::Null), SoundLoad::Refused);
        }
        // A path smuggled in as the known key is only compared, never read.
        assert!(matches!(
            load_event_sound(&a, &json!("done"), &json!(s(&d.path().join("other.wav")))),
            SoundLoad::Loaded { data: Some(_), .. }
        ));
    }

    #[test]
    fn refuses_preset_system_and_off_choices() {
        for sound in [json!({ "kind": "off" }), json!({ "kind": "system" }), json!({ "kind": "preset", "id": "retro" })] {
            let a = alerts(json!({ "done": { "notify": true, "sound": sound } }));
            assert_eq!(load_event_sound(&a, &json!("done"), &Value::Null), SoundLoad::Refused);
        }
    }

    #[test]
    fn refuses_relative_unc_and_device_paths_even_when_the_extension_is_fine() {
        for path in [
            "a.wav",
            "./a.wav",
            "..\\a.wav",
            "sounds/a.wav",
            "\\\\host\\share\\a.wav",
            "//host/share/a.wav",
            "\\\\?\\UNC\\host\\share\\a.wav",
            "\\\\?\\C:\\a.wav",
            "\\\\.\\pipe\\a.wav",
        ] {
            assert_eq!(load_sound_file(path, None), SoundLoad::Refused, "{path}");
        }
    }

    #[test]
    fn refuses_a_symbolic_link_to_a_sound_file() {
        let d = dir();
        let target = d.path().join("real.wav");
        std::fs::write(&target, [1, 2]).unwrap();
        let link = d.path().join("link.wav");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&target, &link).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link).is_ok();
        assert!(matches!(load_sound_file(&s(&target), None), SoundLoad::Loaded { .. }));
        if made {
            assert_eq!(load_sound_file(&s(&link), None), SoundLoad::Refused);
        }
        // A junction (Node's lstat calls it a symbolic link too) on the way is followed only by the stat, the file itself
        // is what counts; a junction named like a sound file is refused.
        #[cfg(windows)]
        {
            let folder = d.path().join("folder");
            std::fs::create_dir(&folder).unwrap();
            let j = d.path().join("j.wav");
            if junction::create(&folder, &j).is_ok() {
                assert_eq!(load_sound_file(&s(&j), None), SoundLoad::Refused);
            }
        }
    }

    #[test]
    fn whitelists_sound_extensions_case_insensitively() {
        assert!(is_sound_file("C:\\a\\b.WAV"));
        assert!(is_sound_file("/x/y.flac"));
        assert!(!is_sound_file("/x/y.wav.exe"));
        assert!(!is_sound_file("/x/y."));
        assert!(!is_sound_file("/x/wav"));
        assert!(!is_sound_file("/x/y.wa v"));
        assert!(is_local_absolute_path("C:/a.wav"));
        assert!(is_local_absolute_path("/a.wav"));
        assert!(!is_local_absolute_path("C:a.wav"));
    }

    #[test]
    fn the_key_follows_node_mtime_ms() {
        let t = UNIX_EPOCH + std::time::Duration::new(1_762_430_400, 123_456_789);
        assert_eq!(sound_key("C:\\a.wav", 3, t), "C:\\a.wav|3|1762430400123.4568");
        assert_eq!(sound_key("/a", 1, UNIX_EPOCH + std::time::Duration::from_secs(5)), "/a|1|5000");
    }
}
