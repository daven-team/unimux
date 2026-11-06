//! The editor's save (1.1.4 `writeFileWith` / `saveText`): only when the file still holds the text the editor started
//! from, keeping its encoding (UTF-8 with or without BOM, UTF-16 LE/BE) and every original line ending, staged in
//! `<file>.mc-save-<uuid>` with the file's mode, flushed, checked again and renamed over the file. Saves of one file run
//! one after the other.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::fserr::FsError;
use crate::fsx;
use crate::preview::{PREVIEW_BYTES, decode_fatal, encoding_of, has_binary_controls};
use crate::project::file_error;

pub const CONFLICT: &str = "Plik zmienił się poza edytorem. Twój szkic został zachowany.";
pub const INVALID_TEXT: &str = "Nieprawidłowa treść pliku.";
const TOO_BIG: &str = "Plik jest zbyt duży do bezpiecznej edycji.";

/// `ProjectFileWriteResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveResult {
    Ok,
    Conflict,
    Failed(String),
}

impl SaveResult {
    pub fn to_json(&self) -> Value {
        match self {
            SaveResult::Ok => json!({ "ok": true }),
            SaveResult::Conflict => json!({ "ok": false, "code": "conflict", "error": CONFLICT }),
            SaveResult::Failed(error) => json!({ "ok": false, "error": error }),
        }
    }
}

enum SaveError {
    Conflict,
    Fs(FsError),
}

impl From<FsError> for SaveError {
    fn from(e: FsError) -> Self {
        SaveError::Fs(e)
    }
}

/// One lock per target: a second save of the same file waits for the first (and then sees the new baseline).
fn lock_for(target: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock();
    // Drop the locks nobody holds any more (1.1.4 deletes its map entry when the save ends).
    locks.retain(|_, l| Arc::strong_count(l) > 1);
    locks.entry(target.to_string()).or_default().clone()
}

/// `writeFileWith(resolveTarget, text, expectedText)`: `text` / `expected` are `None` when the renderer sent no string.
pub fn write_file_with(
    resolve_target: &dyn Fn() -> Result<String, FsError>,
    text: Option<&str>,
    expected: Option<&str>,
) -> SaveResult {
    let (Some(text), Some(expected)) = (text, expected) else { return SaveResult::Failed(INVALID_TEXT.into()) };
    let target = match resolve_target() {
        Ok(t) => t,
        Err(e) => return SaveResult::Failed(file_error(&e)),
    };
    let lock = lock_for(&target);
    let _held = lock.lock();
    save_text(resolve_target, &target, text, expected)
}

/// `/\r\n|\r|\n/g` matches, in order.
fn line_breaks(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                out.push("\r\n");
                i += 2;
            }
            b'\r' => {
                out.push("\r");
                i += 1;
            }
            b'\n' => {
                out.push("\n");
                i += 1;
            }
            _ => i += 1,
        }
    }
    out
}

/// `text.replace(/\r\n|\r|\n/g, () => endings[index++] ?? endings[0] ?? '\n')`: the textarea's breaks get the file's own.
pub fn keep_line_endings(text: &str, baseline: &str) -> String {
    let endings = line_breaks(baseline);
    let mut index = 0;
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let len = match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => 2,
            b'\r' | b'\n' => 1,
            _ => 0,
        };
        if len == 0 {
            i += 1;
            continue;
        }
        out.push_str(&text[start..i]);
        out.push_str(endings.get(index).or(endings.first()).copied().unwrap_or("\n"));
        index += 1;
        i += len;
        start = i;
    }
    out.push_str(&text[start..]);
    out
}

/// The bytes of `normalized` in the file's encoding (BOM kept).
pub fn encode_like(bytes: &[u8], normalized: &str) -> Vec<u8> {
    let encoding = encoding_of(bytes);
    if encoding == encoding_rs::UTF_16LE || encoding == encoding_rs::UTF_16BE {
        let be = encoding == encoding_rs::UTF_16BE;
        let mut out = Vec::with_capacity(2 + normalized.len() * 2);
        for unit in std::iter::once(0xfeffu16).chain(normalized.encode_utf16()) {
            out.extend_from_slice(&if be { unit.to_be_bytes() } else { unit.to_le_bytes() });
        }
        out
    } else {
        let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        let mut out = Vec::with_capacity(normalized.len() + 3);
        if bom {
            out.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }
        out.extend_from_slice(normalized.as_bytes());
        out
    }
}

/// Reads the first PREVIEW_BYTES + 1 bytes of `target` with its stat (1.1.4 reads once through one handle).
fn read_for_save(target: &str) -> Result<(Vec<u8>, fsx::Stat), FsError> {
    let mut file = fsx::open_read(target)?;
    let stat = fsx::fstat(&file, target)?;
    if !stat.is_file {
        return Err(FsError::plain("Wybierz plik, aby zapisać jego treść."));
    }
    if stat.size > PREVIEW_BYTES as u64 {
        return Err(FsError::plain(TOO_BIG));
    }
    let bytes = fsx::read_start(&mut file, PREVIEW_BYTES + 1, target)?;
    if bytes.len() > PREVIEW_BYTES {
        return Err(FsError::plain(TOO_BIG));
    }
    Ok((bytes, stat))
}

/// Creates `path` exclusively (`open(path, 'wx', mode)`), writes `data` and flushes it to disk.
fn write_staged(path: &str, data: &[u8], stat: &fsx::Stat) -> Result<(), FsError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(stat.mode & 0o7777);
    }
    #[cfg(windows)]
    {
        // libuv creates the file read-only when the mode has no write bit (a read-only original stays read-only).
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_ATTRIBUTE_READONLY: u32 = 0x1;
        if stat.readonly {
            options.attributes(FILE_ATTRIBUTE_READONLY);
        }
    }
    let mut file = options.open(path).map_err(|e| FsError::io(&e, "open", path))?;
    file.write_all(data).map_err(|e| FsError::io(&e, "write", path))?;
    file.sync_all().map_err(|e| FsError::io(&e, "fsync", path))?;
    Ok(())
}

fn save_text(resolve_target: &dyn Fn() -> Result<String, FsError>, target: &str, text: &str, expected: &str) -> SaveResult {
    let mut temporary: Option<String> = None;
    let result = (|| -> Result<(), SaveError> {
        let (bytes, stat) = read_for_save(target)?;
        let baseline = decode_fatal(encoding_of(&bytes), &bytes, false)
            .ok_or_else(|| FsError::plain("Nie można edytować pliku binarnego lub nieobsługiwanego kodowania."))?;
        if has_binary_controls(&baseline) {
            return Err(FsError::plain("Nie można edytować pliku binarnego.").into());
        }
        if baseline != expected {
            return Err(SaveError::Conflict);
        }
        // A lone surrogate cannot reach Rust (the bridge refuses such a save, see transport.ts), so only the controls remain.
        if has_binary_controls(text) {
            return Err(FsError::plain(INVALID_TEXT).into());
        }
        let normalized = keep_line_endings(text, &baseline);
        let output = encode_like(&bytes, &normalized);
        if output.len() > PREVIEW_BYTES {
            return Err(FsError::plain(TOO_BIG).into());
        }
        let staged = format!("{target}.mc-save-{}", uuid::Uuid::new_v4());
        temporary = Some(staged.clone());
        write_staged(&staged, &output, &stat)?;
        if resolve_target()? != target {
            return Err(SaveError::Conflict);
        }
        // Unchanged since the read: same size and the same bytes.
        let unchanged = match read_for_compare(target) {
            Ok(Some(now)) => now == bytes,
            Ok(None) => false,
            Err(e) => return Err(e.into()),
        };
        if !unchanged {
            return Err(SaveError::Conflict);
        }
        fsx::rename(&staged, target)?;
        temporary = None;
        Ok(())
    })();
    if let Some(t) = temporary {
        let _ = fsx::unlink(&t);
    }
    match result {
        Ok(()) => SaveResult::Ok,
        Err(SaveError::Conflict) => SaveResult::Conflict,
        Err(SaveError::Fs(e)) => SaveResult::Failed(file_error(&e)),
    }
}

/// The bytes of `target` when it is a file of the same size class as an editable one, else `None`.
fn read_for_compare(target: &str) -> Result<Option<Vec<u8>>, FsError> {
    let mut file = fsx::open_read(target)?;
    let stat = fsx::fstat(&file, target)?;
    if !stat.is_file || stat.size > PREVIEW_BYTES as u64 {
        return Ok(None);
    }
    Ok(Some(fsx::read_start(&mut file, PREVIEW_BYTES + 1, target)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endings_follow_the_file() {
        assert_eq!(keep_line_endings("ONE\nTWO\nTHREE\n", "one\r\ntwo\nthree\r"), "ONE\r\nTWO\nTHREE\r");
        assert_eq!(keep_line_endings("a\nb\nc\nd", "x\r\ny"), "a\r\nb\r\nc\r\nd");
        assert_eq!(keep_line_endings("a\r\nb", ""), "a\nb");
        assert_eq!(keep_line_endings("a\r\r\nb", "x\ny"), "a\n\nb");
    }
}
