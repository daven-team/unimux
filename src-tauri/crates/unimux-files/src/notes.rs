//! Files of the notes (1.0.7, src/main/noteFiles.ts): images pasted into a note (kept in `<data>/note-images`, named by a
//! random id) and a note (1.1.1: also a conversation) exported as a file through the save dialog. The renderer never names a
//! path: it sends bytes or a suggested file name.

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

/// src/shared/noteTools.ts NOTE_IMAGE_DIR / NOTE_IMAGE_MAX_BYTES / NOTE_IMAGE_TYPES.
pub const NOTE_IMAGE_DIR: &str = "note-images";
pub const NOTE_IMAGE_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const NOTE_IMAGE_TYPES: [(&str, &str); 4] =
    [("image/png", "png"), ("image/jpeg", "jpg"), ("image/gif", "gif"), ("image/webp", "webp")];
/// noteFiles.ts EXPORT_MAX (UTF-16 code units, `text.length`).
pub const EXPORT_MAX: usize = 4 * 1024 * 1024;
/// The longest suggested export name (UTF-16 code units, `name.length`).
pub const EXPORT_NAME_MAX: usize = 200;

fn ext_of_mime(mime: &str) -> Option<&'static str> {
    NOTE_IMAGE_TYPES.iter().find(|(m, _)| *m == mime).map(|(_, e)| *e)
}

fn mime_of_ext(ext: &str) -> Option<&'static str> {
    NOTE_IMAGE_TYPES.iter().find(|(_, e)| *e == ext).map(|(m, _)| *m)
}

/// `isNoteImageName`: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/`.
pub fn is_note_image_name(name: &str) -> bool {
    let Some((id, ext)) = name.split_once('.') else { return false };
    if !matches!(ext, "png" | "jpg" | "gif" | "webp") {
        return false;
    }
    let groups: Vec<&str> = id.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// `saveNoteImage`: writes a pasted image and answers its name (`<uuid>.<ext>`), or None for anything that is not a small image
/// of a known type (`bytes` is None when the argument was not a Uint8Array). A failed write is None too (the handler's catch).
pub fn save_note_image(data_dir: &Path, bytes: Option<&[u8]>, mime: &Value) -> Option<String> {
    let bytes = bytes?;
    if bytes.is_empty() || bytes.len() > NOTE_IMAGE_MAX_BYTES {
        return None;
    }
    let ext = ext_of_mime(mime.as_str()?)?;
    let dir = data_dir.join(NOTE_IMAGE_DIR);
    std::fs::create_dir_all(&dir).ok()?;
    let name = format!("{}.{ext}", uuid::Uuid::new_v4());
    // flag 'wx': never over an existing file.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(&name)).ok()?;
    file.write_all(bytes).ok()?;
    Some(name)
}

/// `readNoteImage`: an image of a note as a data URL (the page may show data: images only), or None when the name is not one
/// the app gave, the file is gone or it is larger than an image the app would have saved.
pub fn read_note_image(data_dir: &Path, name: &Value) -> Option<String> {
    let name = name.as_str().filter(|n| is_note_image_name(n))?;
    let bytes = std::fs::read(data_dir.join(NOTE_IMAGE_DIR).join(name)).ok()?;
    if bytes.len() > NOTE_IMAGE_MAX_BYTES {
        return None;
    }
    let mime = mime_of_ext(name.rsplit('.').next()?)?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// A checked `notes:export` request.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportRequest {
    pub name: String,
    pub text: String,
    /// 1.1.1: `kind === 'conversation'` (only the dialog's title differs).
    pub conversation: bool,
}

/// The argument checks of `notes:export`: a non-empty name of at most 200 units without `\`, `/` or NUL, a text of at most
/// 4 Mi units. None is the handler's `{ ok: false }`.
pub fn export_request(name: &Value, text: &Value, kind: &Value) -> Option<ExportRequest> {
    let name = name.as_str()?;
    if name.is_empty() || unimux_core::utf16::len(name) > EXPORT_NAME_MAX || name.contains(['\\', '/', '\0']) {
        return None;
    }
    let text = text.as_str()?;
    if unimux_core::utf16::len(text) > EXPORT_MAX {
        return None;
    }
    Some(ExportRequest { name: name.to_string(), text: text.to_string(), conversation: kind.as_str() == Some("conversation") })
}

/// Node's `path.basename(name)` for a name without separators: on Windows a drive prefix (`C:x.md`) is dropped.
pub fn export_basename(name: &str) -> &str {
    let b = name.as_bytes();
    if cfg!(windows) && b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' { &name[2..] } else { name }
}

/// The save dialog's settings: the extension is the part after the last dot (the whole name without one), the filter is
/// named after it in capitals (`name.split('.').pop()`, `ext.toUpperCase()`).
pub fn export_filter(name: &str) -> (String, String) {
    let ext = name.rsplit('.').next().unwrap_or("md").to_string();
    (ext.to_uppercase(), ext)
}

/// The answer once the target is known: `{ ok: false, cancelled: true }` without one, else the write's result.
pub fn write_export(path: Option<PathBuf>, text: &str) -> Value {
    let Some(path) = path else { return json!({ "ok": false, "cancelled": true }) };
    match std::fs::write(&path, text.as_bytes()) {
        Ok(()) => json!({ "ok": true, "path": path.to_string_lossy() }),
        Err(_) => json!({ "ok": false }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: [u8; 7] = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];

    #[test]
    fn saves_a_pasted_image_under_a_random_name_and_reads_it_back_as_a_data_url() {
        let data = tempfile::tempdir().unwrap();
        let name = save_note_image(data.path(), Some(&PNG), &json!("image/png")).unwrap();
        assert!(is_note_image_name(&name), "{name}");
        assert!(name.ends_with(".png"));
        let listed: Vec<String> = std::fs::read_dir(data.path().join("note-images"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(listed, vec![name.clone()]);
        assert_eq!(
            read_note_image(data.path(), &json!(name)).unwrap(),
            format!("data:image/png;base64,{}", STANDARD.encode(PNG))
        );
        let jpg = save_note_image(data.path(), Some(&PNG), &json!("image/jpeg")).unwrap();
        assert!(read_note_image(data.path(), &json!(jpg)).unwrap().starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn refuses_what_is_not_a_small_image_of_a_known_type() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(save_note_image(data.path(), Some(&PNG), &json!("image/svg+xml")), None);
        assert_eq!(save_note_image(data.path(), None, &json!("image/png")), None);
        assert_eq!(save_note_image(data.path(), Some(&[]), &json!("image/png")), None);
        assert_eq!(save_note_image(data.path(), Some(&vec![0u8; NOTE_IMAGE_MAX_BYTES + 1]), &json!("image/png")), None);
        assert_eq!(save_note_image(data.path(), Some(&PNG), &json!(null)), None);
        assert!(save_note_image(data.path(), Some(&vec![0u8; NOTE_IMAGE_MAX_BYTES]), &json!("image/webp")).is_some());
        // A data folder that cannot hold the image folder: null, not an error (the handler's catch).
        let file = data.path().join("plain");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(save_note_image(&file, Some(&PNG), &json!("image/png")), None);
    }

    #[test]
    fn reads_only_names_the_app_gave_never_a_path() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("secret.png"), "x").unwrap();
        assert_eq!(read_note_image(data.path(), &json!("../secret.png")), None);
        assert_eq!(read_note_image(data.path(), &json!(42)), None);
        assert_eq!(read_note_image(data.path(), &json!("0f8fad5b-d9cb-469f-a165-70867728950e.png")), None);
        for bad in [
            "0F8FAD5B-d9cb-469f-a165-70867728950e.png",
            "0f8fad5b-d9cb-469f-a165-70867728950e.svg",
            "0f8fad5b-d9cb-469f-a165-70867728950e.png.png",
            "0f8fad5bd9cb-469f-a165-70867728950e1.png",
            "0f8fad5b-d9cb-469f-a165-70867728950.png",
        ] {
            assert!(!is_note_image_name(bad), "{bad}");
        }
        // A file the app did not write that is larger than any image it saves.
        std::fs::create_dir(data.path().join("note-images")).unwrap();
        let big = "0f8fad5b-d9cb-469f-a165-70867728950e.gif";
        std::fs::write(data.path().join("note-images").join(big), vec![0u8; NOTE_IMAGE_MAX_BYTES + 1]).unwrap();
        assert_eq!(read_note_image(data.path(), &json!(big)), None);
    }

    #[test]
    fn writes_the_note_where_the_dialog_points_and_refuses_names_with_a_path() {
        let data = tempfile::tempdir().unwrap();
        let request = export_request(&json!("Plan.md"), &json!("# Plan"), &Value::Null).unwrap();
        assert_eq!(request, ExportRequest { name: "Plan.md".into(), text: "# Plan".into(), conversation: false });
        let out = data.path().join("out.md");
        assert_eq!(write_export(Some(out.clone()), &request.text), json!({ "ok": true, "path": out.to_string_lossy() }));
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "# Plan");
        assert_eq!(export_request(&json!("../x.md"), &json!("x"), &Value::Null), None);
        assert_eq!(write_export(None, "x"), json!({ "ok": false, "cancelled": true }));
        // A target that cannot be written.
        assert_eq!(write_export(Some(data.path().to_path_buf()), "x"), json!({ "ok": false }));
    }

    #[test]
    fn export_checks_follow_1_1_4() {
        let null = Value::Null;
        assert_eq!(export_request(&json!(""), &json!("x"), &null), None);
        assert_eq!(export_request(&json!("a\\b.md"), &json!("x"), &null), None);
        assert_eq!(export_request(&json!("a\0.md"), &json!("x"), &null), None);
        assert_eq!(export_request(&json!(5), &json!("x"), &null), None);
        assert_eq!(export_request(&json!("a.md"), &json!(5), &null), None);
        // Lengths in UTF-16 units: 100 astral characters are 200 units (allowed), 101 are 202.
        assert!(export_request(&json!("😀".repeat(100)), &json!(""), &null).is_some());
        assert_eq!(export_request(&json!("😀".repeat(101)), &json!(""), &null), None);
        assert!(export_request(&json!("a.md"), &json!("x".repeat(EXPORT_MAX)), &null).is_some());
        assert_eq!(export_request(&json!("a.md"), &json!("x".repeat(EXPORT_MAX + 1)), &null), None);
        assert!(export_request(&json!("c.md"), &json!(""), &json!("conversation")).unwrap().conversation);
        assert!(!export_request(&json!("c.md"), &json!(""), &json!("other")).unwrap().conversation);
        assert_eq!(export_filter("Plan.md"), ("MD".to_string(), "md".to_string()));
        assert_eq!(export_filter("README"), ("README".to_string(), "README".to_string()));
        assert_eq!(export_filter("a.tar.gz"), ("GZ".to_string(), "gz".to_string()));
        assert_eq!(export_basename("Plan.md"), "Plan.md");
        if cfg!(windows) {
            assert_eq!(export_basename("C:Plan.md"), "Plan.md");
        }
    }
}
