//! What the editor and the preview show of a file (1.1.4 `readFileAt`): text up to 256 KiB (8 MiB for the editor) decoded
//! like `new TextDecoder(enc, { fatal: true })` (UTF-8 or a UTF-16 file with its BOM; a cut character at the limit is held
//! back like `{ stream: true }`), images up to 20 MiB as raw bytes (the bridge makes the data URL), a Parquet table, or
//! "binary". Golden rows: test/golden/files-preview.jsonl.

use encoding_rs::{DecoderResult, Encoding, UTF_8, UTF_16BE, UTF_16LE};
use serde_json::{Value, json};

use crate::fserr::FsError;
use crate::fsx;

pub const PREVIEW_BYTES: usize = 256 * 1024;
/// The editor opens bigger files read-only: this much of the beginning is loaded.
pub const LARGE_VIEW_BYTES: usize = 8 * 1024 * 1024;
pub const IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// `ProjectFilePreview` of src/shared/types.ts.
#[derive(Debug, Clone, PartialEq)]
pub enum Preview {
    Text {
        text: String,
        size: u64,
        truncated: bool,
    },
    /// `{ kind: 'image', mime, dataUrl, size }`: the bytes travel raw; the bridge turns them into the `data:` URL.
    Image {
        mime: &'static str,
        bytes: Vec<u8>,
        size: u64,
    },
    /// `{ kind: 'table', format: 'parquet', ... }`, already as JSON.
    Table(Value),
    Binary {
        size: u64,
    },
    Error {
        message: String,
    },
}

impl Preview {
    pub fn error(message: impl Into<String>) -> Self {
        Preview::Error { message: message.into() }
    }
    pub fn is_error(&self) -> bool {
        matches!(self, Preview::Error { .. })
    }
    /// The JSON answer with the image bytes as a part (`unimux_ipc::binary`); the parts are empty for everything else.
    pub fn into_reply(self) -> (Value, Vec<Vec<u8>>) {
        match self {
            Preview::Text { text, size, truncated } => {
                (json!({ "kind": "text", "text": text, "size": size, "truncated": truncated }), vec![])
            }
            Preview::Image { mime, bytes, size } => {
                (json!({ "kind": "image", "mime": mime, "dataUrl": unimux_ipc::binary::part(0), "size": size }), vec![bytes])
            }
            Preview::Table(v) => (v, vec![]),
            Preview::Binary { size } => (json!({ "kind": "binary", "size": size }), vec![]),
            Preview::Error { message } => (json!({ "kind": "error", "message": message }), vec![]),
        }
    }
}

pub fn image_mime(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// `path.slice(path.lastIndexOf('.') + 1).toLowerCase()` (no dot: the whole path).
pub fn extension_of(path: &str) -> String {
    match path.rfind('.') {
        Some(at) => path[at + 1..].to_lowercase(),
        None => path.to_lowercase(),
    }
}

/// The encoding 1.1.4 picks by the first bytes: a UTF-16 BOM, else UTF-8.
pub fn encoding_of(data: &[u8]) -> &'static Encoding {
    match data {
        [0xff, 0xfe, ..] => UTF_16LE,
        [0xfe, 0xff, ..] => UTF_16BE,
        _ => UTF_8,
    }
}

/// `new TextDecoder(encoding, { fatal: true }).decode(data, { stream })`: the BOM of that encoding is dropped, a malformed
/// sequence is `None`, and with `stream` an incomplete sequence at the end is held back (left out) instead of failing.
pub fn decode_fatal(encoding: &'static Encoding, data: &[u8], stream: bool) -> Option<String> {
    let mut decoder = encoding.new_decoder_with_bom_removal();
    let mut out = String::with_capacity(decoder.max_utf8_buffer_length_without_replacement(data.len()).unwrap_or(data.len() * 3));
    let (result, read) = decoder.decode_to_string_without_replacement(data, &mut out, !stream);
    match result {
        DecoderResult::InputEmpty => {
            debug_assert_eq!(read, data.len());
            Some(out)
        }
        DecoderResult::Malformed(_, _) => None,
        DecoderResult::OutputFull => None,
    }
}

/// `/[\x00-\x08\x0e-\x1f]/.test(text)`: the control characters that make a file count as binary.
pub fn has_binary_controls(text: &str) -> bool {
    text.bytes().any(|b| b <= 0x08 || (0x0e..=0x1f).contains(&b))
}

/// The part of `readFileAt` after the read: text or binary for the first bytes of a file.
pub fn text_preview(data: &[u8], size: u64, truncated: bool) -> Preview {
    let encoding = encoding_of(data);
    let utf16 = encoding != UTF_8;
    if !utf16 && data.contains(&0) {
        return Preview::Binary { size };
    }
    match decode_fatal(encoding, data, truncated) {
        Some(text) if !has_binary_controls(&text) => Preview::Text { text, size, truncated },
        _ => Preview::Binary { size },
    }
}

/// 1.1.4 `readFileAt(target, path, limit)`: `target` is the resolved file, `path` the name the extension is taken from.
pub fn read_file_at(target: &str, path: &str, limit: usize) -> Result<Preview, FsError> {
    let mut file = fsx::open_read(target)?;
    let stat = fsx::fstat(&file)?;
    if !stat.is_file {
        return Ok(Preview::error("Wybierz plik, aby zobaczyć jego treść."));
    }
    let extension = extension_of(path);
    if let Some(mime) = image_mime(&extension).filter(|_| limit > PREVIEW_BYTES) {
        if stat.size > IMAGE_BYTES {
            return Ok(Preview::Binary { size: stat.size });
        }
        // `file.readFile()`: everything there is now (the size may have changed since the stat).
        let mut bytes = Vec::with_capacity(stat.size as usize);
        std::io::Read::read_to_end(&mut file, &mut bytes).map_err(|e| FsError::io_handle(&e, "read"))?;
        return Ok(Preview::Image { mime, bytes, size: stat.size });
    }
    if extension == "parquet" && limit > PREVIEW_BYTES {
        drop(file);
        return Ok(crate::parquet::read_parquet(target, stat.size));
    }
    let cap = PREVIEW_BYTES.max(limit.min(LARGE_VIEW_BYTES));
    let want = (stat.size.min(cap as u64) as usize) + 1;
    let mut data = fsx::read_start(&mut file, want)?;
    let truncated = data.len() > cap;
    data.truncate(cap);
    Ok(text_preview(&data, stat.size, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_like_text_decoder() {
        assert_eq!(decode_fatal(UTF_8, b"\xef\xbb\xbfab", false).as_deref(), Some("ab"));
        assert_eq!(decode_fatal(UTF_8, b"a\xc4", false), None);
        assert_eq!(decode_fatal(UTF_8, b"a\xc4", true).as_deref(), Some("a"));
        assert_eq!(decode_fatal(UTF_8, b"\xc3\x28", true), None);
        assert_eq!(decode_fatal(UTF_8, b"\xed\xa0\x80", false), None);
        assert_eq!(decode_fatal(UTF_16LE, b"\xff\xfea\x00b", true).as_deref(), Some("a"));
        assert_eq!(decode_fatal(UTF_16LE, b"\xff\xfea\x00b", false), None);
        assert_eq!(decode_fatal(UTF_16BE, b"\xfe\xff\x00a", false).as_deref(), Some("a"));
        assert_eq!(decode_fatal(UTF_16LE, b"\xff\xfe\x00\xd8", false), None);
        assert_eq!(decode_fatal(UTF_16LE, b"\xff\xfe\x00\xd8", true).as_deref(), Some(""));
    }

    #[test]
    fn extension_rule() {
        assert_eq!(extension_of("a/B.PNG"), "png");
        assert_eq!(extension_of("Makefile"), "makefile");
        assert_eq!(extension_of("x.tar.gz"), "gz");
    }
}
