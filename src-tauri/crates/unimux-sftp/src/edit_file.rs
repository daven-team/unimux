//! Remote files in editor tabs (T4, port of 1.1.4 src/sftphost/editFile.ts and the pure helpers of
//! src/shared/editorSource.ts): reading one into memory (no temp file) and saving it back. A save never leaves a
//! half-written file under the real name: the bytes go to "<name>.unimux-part" next to it and are renamed into place, after
//! the server file was checked to still be the one the tab was opened from (size and modification time, the content hash
//! when the time cannot tell, or its text for a restored draft). The part file is created exclusively (never through an
//! existing name or link) and private (0600) while it is written; the file's permissions are put on it before the rename
//! and checked after it. A file owned by another user is not replaced by one of the SSH user unless the user agreed. A
//! symlink stays a symlink.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures::future::BoxFuture;
use futures::stream::{self, StreamExt, TryStreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::client::ClientError;
use crate::error::SftpErrorCode;
use crate::limits::{posix_basename, posix_join, posix_parent, valid_remote_path};
use crate::op::{EditorSave, RemoteStamp};
use crate::proto::{Attrs, open_flags};
use crate::remote::{CHUNK, DEPTH, RemoteSide};
use crate::sides::{EntryKind, FileSide, SideError, kind_from_mode};

/// `EDITOR_TEXT_BYTES`: remote text files up to this size open editable.
pub const EDITOR_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// `EDITOR_IMAGE_BYTES`: remote images up to this size open as a preview.
pub const EDITOR_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// `HASH_CHECK_WINDOW_MS`.
pub const HASH_CHECK_WINDOW_MS: f64 = 2000.0;
/// `HASH_CHECK_SMALL_BYTES`.
pub const HASH_CHECK_SMALL_BYTES: f64 = 64.0 * 1024.0;
/// `PART_SUFFIX`.
pub const PART_SUFFIX: &str = ".unimux-part";

/// `partName`.
pub fn part_name(name: &str) -> String {
    format!("{name}{PART_SUFFIX}")
}

/// `isPartName`.
pub fn is_part_name(name: &str) -> bool {
    name.ends_with(PART_SUFFIX) && name.len() > PART_SUFFIX.len()
}

/// `IMAGE_MIME`.
fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
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

/// `extensionOf`: after the last dot (not a leading one), lowercased.
fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// `OpenPlan`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenPlan {
    Image(&'static str),
    Text,
    TooLarge,
}

/// `remoteOpenPlan`: images preview, text up to the editor limit loads, the rest offers a download.
pub fn remote_open_plan(name: &str, size: u64) -> OpenPlan {
    if let Some(mime) = image_mime(&extension_of(name)) {
        return if size <= EDITOR_IMAGE_BYTES { OpenPlan::Image(mime) } else { OpenPlan::TooLarge };
    }
    if size <= EDITOR_TEXT_BYTES { OpenPlan::Text } else { OpenPlan::TooLarge }
}

/// `CONTROL`: control characters that never appear in a text file.
fn has_control(text: &str) -> bool {
    text.chars().any(|c| matches!(c, '\u{0}'..='\u{8}' | '\u{e}'..='\u{1f}'))
}

/// `validEditorText` (a Rust string has no lone surrogates, the other half of the rule).
pub fn valid_editor_text(text: &str) -> bool {
    !has_control(text)
}

/// `decodeText`: the text of a file's bytes with its encoding; None for a binary file or bytes that do not decode.
pub fn decode_text(bytes: &[u8]) -> Option<(String, &'static str)> {
    let encoding = if bytes.starts_with(&[0xff, 0xfe]) {
        "utf-16le"
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        "utf-16be"
    } else if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        "utf-8-bom"
    } else {
        "utf-8"
    };
    let text = match encoding {
        "utf-8" | "utf-8-bom" => {
            if bytes.contains(&0) {
                return None;
            }
            // The decoder drops the BOM; encode_text writes it back.
            let body = if encoding == "utf-8-bom" { &bytes[3..] } else { bytes };
            String::from_utf8(body.to_vec()).ok()?
        }
        _ => {
            let body = &bytes[2..];
            let (pairs, rest) = body.as_chunks::<2>();
            if !rest.is_empty() {
                return None;
            }
            let units: Vec<u16> = pairs
                .iter()
                .map(|p| if encoding == "utf-16le" { u16::from_le_bytes(*p) } else { u16::from_be_bytes(*p) })
                .collect();
            String::from_utf16(&units).ok()?
        }
    };
    if has_control(&text) { None } else { Some((text, encoding)) }
}

/// The line breaks of a text in order (`/\r\n|\r|\n/g`).
fn line_breaks(text: &str) -> Vec<&str> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\r' if b.get(i + 1) == Some(&b'\n') => {
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

/// `restoreLineEndings`: the editor's text with each line break of `baseline` back in place (mixed files too).
pub fn restore_line_endings(text: &str, baseline: &str) -> String {
    let endings = line_breaks(baseline);
    let mut index = 0;
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find(['\r', '\n']) {
        out.push_str(&rest[..pos]);
        let len = if rest[pos..].starts_with("\r\n") { 2 } else { 1 };
        let ending = endings.get(index).or(endings.first()).copied().unwrap_or("\n");
        index += 1;
        out.push_str(ending);
        rest = &rest[pos + len..];
    }
    out.push_str(rest);
    out
}

/// `encodeText`: the bytes to write for `text` in the file's encoding and line endings.
pub fn encode_text(text: &str, baseline: &str, encoding: &str) -> Vec<u8> {
    let body = restore_line_endings(text, baseline);
    match encoding {
        "utf-16le" | "utf-16be" => {
            let mut out = Vec::with_capacity((body.len() + 1) * 2);
            for unit in std::iter::once(0xfeffu16).chain(body.encode_utf16()) {
                out.extend_from_slice(&if encoding == "utf-16le" { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
            out
        }
        "utf-8-bom" => {
            let mut out = vec![0xef, 0xbb, 0xbf];
            out.extend_from_slice(body.as_bytes());
            out
        }
        _ => body.into_bytes(),
    }
}

/// `sameStamp`.
pub fn same_stamp(a: (f64, f64), b: (f64, f64)) -> bool {
    a.0 == b.0 && a.1 == b.1
}

/// `needsHashCheck`: the save compares the content hash when the time cannot tell a change apart.
pub fn needs_hash_check(s: &RemoteStamp) -> bool {
    s.hash.is_some()
        && match s.read_at {
            None => true,
            Some(read_at) => (read_at - s.mtime_ms).abs() <= HASH_CHECK_WINDOW_MS || s.size <= HASH_CHECK_SMALL_BYTES,
        }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn code(e: SideError) -> SftpErrorCode {
    e.code
}

fn client_code(e: ClientError) -> SftpErrorCode {
    e.code()
}

/// `metaOf` of editFile.ts: kind, size (whatever the server sent) and mtime in ms.
struct RawMeta {
    kind: EntryKind,
    size: f64,
    mtime: f64,
}

fn meta_of(a: &Attrs) -> RawMeta {
    RawMeta {
        kind: kind_from_mode(a.mode),
        size: a.size.map(|s| s as f64).unwrap_or(0.0),
        mtime: a.mtime.map(|m| m as f64 * 1000.0).unwrap_or(0.0),
    }
}

fn stamp_of(m: &RawMeta) -> (f64, f64) {
    (m.size, m.mtime)
}

fn stamp_json(size: f64, mtime: f64, hash: &str, read_at: f64) -> Value {
    RemoteStamp { size, mtime_ms: mtime, hash: Some(hash.to_string()), read_at: Some(read_at) }.to_json()
}

/// `readAll`: the whole file, or None when it has more than `limit` bytes (the read stops there).
async fn read_all(side: &RemoteSide, path: &str, limit: u64) -> Result<Option<Vec<u8>>, SftpErrorCode> {
    let mut reader = side.open_read(path).await.map_err(code)?;
    let mut out = Vec::new();
    let result = loop {
        match reader.next_chunk().await {
            Err(e) => break Err(e.code),
            Ok(None) => break Ok(Some(())),
            Ok(Some(chunk)) => {
                if (out.len() + chunk.len()) as u64 > limit {
                    break Ok(None);
                }
                out.extend_from_slice(&chunk);
            }
        }
    };
    reader.close().await;
    Ok(result?.map(|()| out))
}

/// `attrsAt`: the raw attributes (owner, mode) of a path, following links; None when nothing is there.
async fn attrs_at(side: &RemoteSide, path: &str) -> Result<Option<Attrs>, SftpErrorCode> {
    match side.client().stat(path).await {
        Ok(a) => Ok(Some(a)),
        Err(e) if e.code() == SftpErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.code()),
    }
}

/// `FileOwner` of attributes (both ids or none).
fn owner_of(a: &Attrs) -> Option<(u32, u32)> {
    match (a.uid, a.gid) {
        (Some(u), Some(g)) => Some((u, g)),
        _ => None,
    }
}

fn same_owner(a: Option<(u32, u32)>, b: Option<(u32, u32)>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

fn owner_json(o: (u32, u32)) -> Value {
    json!({ "uid": o.0, "gid": o.1 })
}

/// `readForEditor`.
pub async fn read_for_editor(side: &RemoteSide, path: &str) -> Result<Value, SftpErrorCode> {
    if !valid_remote_path(path) {
        return Err(SftpErrorCode::Invalid);
    }
    // Taken before the read: a write during the read shows up as a change at the next check.
    let meta = side.stat(path).await.map_err(code)?.ok_or(SftpErrorCode::NotFound)?;
    match meta.kind {
        EntryKind::Dir => return Err(SftpErrorCode::IsADirectory),
        EntryKind::File => {}
        _ => return Err(SftpErrorCode::Invalid),
    }
    let plan = remote_open_plan(&posix_basename(path), meta.size);
    if plan == OpenPlan::TooLarge {
        return Ok(json!({ "kind": "tooLarge", "size": meta.size }));
    }
    let read_at = now_ms();
    let limit = if matches!(plan, OpenPlan::Image(_)) { EDITOR_IMAGE_BYTES } else { EDITOR_TEXT_BYTES };
    let Some(bytes) = read_all(side, path, limit).await? else {
        return Ok(json!({ "kind": "tooLarge", "size": meta.size }));
    };
    let stamp = stamp_json(meta.size as f64, meta.mtime as f64, &sha256_hex(&bytes), read_at);
    if let OpenPlan::Image(mime) = plan {
        let data_url = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));
        return Ok(json!({ "kind": "image", "mime": mime, "dataUrl": data_url, "size": bytes.len(), "stamp": stamp }));
    }
    Ok(match decode_text(&bytes) {
        Some((text, encoding)) => {
            json!({ "kind": "text", "text": text, "encoding": encoding, "size": bytes.len(), "stamp": stamp })
        }
        None => json!({ "kind": "binary", "size": meta.size }),
    })
}

/// `statForEditor`: size and time of a file (following links), for the focus check of a tab.
pub async fn stat_for_editor(side: &RemoteSide, path: &str) -> Result<Value, SftpErrorCode> {
    if !valid_remote_path(path) {
        return Err(SftpErrorCode::Invalid);
    }
    let meta = side.stat(path).await.map_err(code)?.ok_or(SftpErrorCode::NotFound)?;
    if meta.kind != EntryKind::File {
        return Err(SftpErrorCode::Invalid);
    }
    Ok(json!({ "size": meta.size, "mtimeMs": meta.mtime }))
}

/// `openPart`: creates the part file exclusively with mode 0600. Something already under that name (a leftover, or a link
/// someone planted) is removed (unlink never follows a link) and the exclusive create is tried once more; nothing is ever
/// written through it.
async fn open_part(side: &RemoteSide, part: &str) -> Result<Vec<u8>, SftpErrorCode> {
    let flags = open_flags::WRITE | open_flags::CREAT | open_flags::TRUNC | open_flags::EXCL;
    let attrs = Attrs::mode(0o600);
    match side.client().open(part, flags, &attrs).await {
        Ok(h) => Ok(h),
        Err(e) => {
            if !matches!(side.lstat(part).await, Ok(Some(_))) {
                // The folder does not let the SSH user create a file (a root-owned folder): its own text, the file itself
                // may be writable.
                if e.code() == SftpErrorCode::Permission {
                    return Err(SftpErrorCode::PartDenied);
                }
                return Err(e.code());
            }
            side.unlink(part).await.map_err(code)?;
            side.client().open(part, flags, &attrs).await.map_err(client_code)
        }
    }
}

/// The aside copy a failed overwrite left ("<name>.unimux-old", "<name>.unimux-old1" ...): the newest one.
async fn find_aside(side: &RemoteSide, target: &str) -> Option<String> {
    let name = posix_basename(target);
    let parent = posix_parent(target);
    let prefix = format!("{name}.unimux-old");
    let mut found: Vec<(i64, String)> = side
        .readdir(&parent)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.name.strip_prefix(&prefix).is_some_and(|rest| rest.bytes().all(|b| b.is_ascii_digit())))
        .map(|e| (e.meta.mtime, e.name))
        .collect();
    // Newest first; a stable sort keeps the listing order among equal times (like 1.1.4's sort).
    found.sort_by_key(|a| std::cmp::Reverse(a.0));
    found.into_iter().next().map(|(_, n)| posix_join(&[&parent, &n]))
}

/// Writes `data` to an open handle (16 writes of 32 KB in flight), gives it `mode` through FSETSTAT on that same handle
/// (T4: a path-based SETSTAT could follow a link someone swapped in under the part's name) and closes it. The answer tells
/// whether the mode was set (no `mode`: nothing to set).
async fn write_handle(side: &RemoteSide, handle: &[u8], data: &[u8], mode: Option<u32>) -> Result<bool, SftpErrorCode> {
    let client = side.client();
    // Boxed futures made up front (a closure that borrows the client would not be Send for every lifetime).
    let writes: Vec<BoxFuture<'_, Result<(), ClientError>>> = data
        .chunks(CHUNK)
        .enumerate()
        .map(|(i, piece)| Box::pin(client.write(handle, (i * CHUNK) as u64, piece)) as BoxFuture<'_, _>)
        .collect();
    let result = stream::iter(writes).buffer_unordered(DEPTH).try_collect::<Vec<()>>().await.map(|_| ());
    match result {
        Ok(()) => {
            let mode_set = match mode {
                Some(mode) => client.fsetstat(handle, &Attrs::mode(mode)).await.is_ok(),
                None => true,
            };
            client.close(handle).await.map_err(client_code)?;
            Ok(mode_set)
        }
        Err(e) => {
            let _ = client.close(handle).await;
            Err(e.code())
        }
    }
}

/// Puts `mode` on the saved file after the rename without ever following a link (T4): lsetstat when the server has it.
/// Without it there is no SETSTAT that leaves a link alone, so nothing is changed by path: the fix-up is skipped when
/// someone else could swap the name for a link (the folder is writable by group or others, or its mode is unknown), and
/// otherwise goes through a handle: an lstat shows a regular file of the size just written, the file is opened, FSTAT on
/// that handle shows a regular file of that size again, and FSETSTAT changes the mode of exactly what was opened.
pub(crate) async fn set_mode_no_follow(side: &RemoteSide, path: &str, mode: u32, size: u64) -> bool {
    let client = side.client();
    if side.lsetstat() {
        return client.lsetstat(path, &Attrs::mode(mode)).await.is_ok();
    }
    match side.lstat(&posix_parent(path)).await {
        Ok(Some(dir)) if dir.kind == EntryKind::Dir && dir.mode.is_some_and(|m| m & 0o022 == 0) => {}
        _ => return false,
    }
    match side.lstat(path).await {
        Ok(Some(m)) if m.kind == EntryKind::File && m.size == size => {}
        _ => return false,
    }
    let Ok(handle) = client.open_read(path).await else { return false };
    let same = client.fstat(&handle).await.is_ok_and(|a| kind_from_mode(a.mode) == EntryKind::File && a.size == Some(size));
    let set = same && client.fsetstat(&handle, &Attrs::mode(mode)).await.is_ok();
    let closed = client.close(&handle).await.is_ok();
    set && closed
}

/// What happens to the part file and the target hold when a save ends, however it ends.
struct SaveGuard<'a> {
    side: &'a RemoteSide,
    target: String,
    owner: String,
    /// The part's handle while it is open (closed first).
    handle: Option<Vec<u8>>,
    /// The part file exists and is not the only copy of the new text.
    part: Option<String>,
    released: bool,
}

impl SaveGuard<'_> {
    async fn finish(mut self) {
        if let Some(h) = self.handle.take() {
            let _ = self.side.client().close(&h).await;
        }
        if let Some(p) = self.part.take() {
            let _ = self.side.unlink(&p).await;
        }
        self.side.inflight().release(&self.target, &self.owner);
        self.released = true;
    }
}

impl Drop for SaveGuard<'_> {
    fn drop(&mut self) {
        // Dropped without `finish` (the operation was cancelled by its timeout): close and remove without waiting.
        if self.released {
            return;
        }
        let client = self.side.client().clone();
        if let Some(h) = self.handle.take() {
            client.close_nowait(&h);
        }
        if let Some(p) = self.part.take()
            && let Ok(rt) = tokio::runtime::Handle::try_current()
        {
            rt.spawn(async move {
                let _ = client.remove(&p).await;
            });
        }
        self.side.inflight().release(&self.target, &self.owner);
    }
}

/// `writeFromEditor`: saves an editor tab's text; `changed` when the server file is no longer the one the tab was opened
/// from.
pub async fn write_from_editor(side: &RemoteSide, path: &str, save: &EditorSave, owner: &str) -> Result<Value, SftpErrorCode> {
    if !valid_remote_path(path) || !valid_editor_text(&save.text) {
        return Err(SftpErrorCode::Invalid);
    }
    // A symlink keeps pointing where it did: the file it points to is the one written.
    let target = side.realpath(path).await.map_err(code)?;
    let Some(target) = target.filter(|t| valid_remote_path(t) && !is_part_name(&posix_basename(t))) else {
        return Err(SftpErrorCode::NotFound);
    };
    let attrs = attrs_at(side, &target).await?.ok_or(SftpErrorCode::NotFound)?;
    let meta = meta_of(&attrs);
    if meta.kind != EntryKind::File {
        return Err(SftpErrorCode::Invalid);
    }
    match &save.expected {
        Some(expected) => {
            if !same_stamp((expected.size, expected.mtime_ms), stamp_of(&meta)) {
                return Err(SftpErrorCode::Changed);
            }
            // Within the time resolution the stamp cannot tell a change apart: the content decides.
            if needs_hash_check(expected) {
                let bytes = read_all(side, &target, EDITOR_TEXT_BYTES).await?;
                if bytes.is_none_or(|b| Some(sha256_hex(&b)) != expected.hash) {
                    return Err(SftpErrorCode::Changed);
                }
            }
        }
        None => {
            let bytes = read_all(side, &target, EDITOR_TEXT_BYTES).await?;
            if bytes.and_then(|b| decode_text(&b)).is_none_or(|(text, _)| text != save.baseline) {
                return Err(SftpErrorCode::Changed);
            }
        }
    }
    let output = encode_text(&save.text, &save.baseline, &save.encoding);
    if output.len() as u64 > EDITOR_TEXT_BYTES {
        return Err(SftpErrorCode::Invalid);
    }
    // A transfer writing the same file right now: the file is changing under the tab.
    if !side.inflight().hold(&target, owner) {
        return Err(SftpErrorCode::Changed);
    }
    let part = posix_join(&[&posix_parent(&target), &part_name(&posix_basename(&target))]);
    let mut guard =
        SaveGuard { side, target: target.clone(), owner: owner.to_string(), handle: None, part: None, released: false };
    let result = save_part(side, &mut guard, &target, &part, &attrs, &meta, save, &output).await;
    guard.finish().await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn save_part(
    side: &RemoteSide,
    guard: &mut SaveGuard<'_>,
    target: &str,
    part: &str,
    attrs: &Attrs,
    meta: &RawMeta,
    save: &EditorSave,
    output: &[u8],
) -> Result<Value, SftpErrorCode> {
    let client = side.client();
    let mut warnings: Vec<Value> = Vec::new();
    let handle = open_part(side, part).await?;
    guard.part = Some(part.to_string());
    guard.handle = Some(handle.clone());
    // The owner of a new file is the SSH user: when the server file has another one, it is put back (fchown) or the user
    // decides.
    let theirs = owner_of(attrs);
    let mut mine = client.fstat(&handle).await.ok().and_then(|a| owner_of(&a));
    if let Some(theirs_id) = theirs
        && !same_owner(theirs, mine)
    {
        let chown = Attrs { uid: Some(theirs_id.0), gid: Some(theirs_id.1), ..Attrs::default() };
        let _ = client.fsetstat(&handle, &chown).await;
        mine = client.fstat(&handle).await.ok().and_then(|a| owner_of(&a));
        if let Some(mine_id) = mine
            && !same_owner(theirs, mine)
        {
            if !save.allow_owner_change {
                return Ok(json!({ "kind": "ownerChange", "from": owner_json(theirs_id), "to": owner_json(mine_id) }));
            }
            warnings.push(json!({ "kind": "owner", "from": owner_json(theirs_id), "to": owner_json(mine_id) }));
        }
    }
    guard.handle = None;
    // The part file stayed private while it was written; before it is closed it gets the permissions of the file it
    // replaces, on its own handle.
    let mode = attrs.mode.map(|m| m & 0o7777);
    let mode_set = write_handle(side, &handle, output, mode.filter(|m| *m != 0o600)).await?;
    if let Some(mode) = mode
        && !mode_set
    {
        warnings.push(json!({ "kind": "mode", "mode": mode }));
    }
    // Last look before the rename: a write that came in while the part file was written is a conflict too.
    let now = attrs_at(side, target).await?;
    if now.is_none_or(|n| !same_stamp(stamp_of(&meta_of(&n)), stamp_of(meta))) {
        return Err(SftpErrorCode::Changed);
    }
    if let Err(e) = side.rename(part, target, true).await {
        if e.keep_part {
            // The only copy of the new text: it stays.
            guard.part = None;
            let aside = find_aside(side, target).await;
            return Ok(json!({ "kind": "stranded", "part": part, "aside": aside }));
        }
        return Err(e.code);
    }
    guard.part = None;
    let mut after = attrs_at(side, target).await.ok().flatten();
    if let (Some(a), Some(mode)) = (&after, mode)
        && a.mode.is_some_and(|m| m & 0o7777 != mode)
        && !warnings.iter().any(|w| w["kind"] == "mode")
    {
        let mut current = a.clone();
        if set_mode_no_follow(side, target, mode, output.len() as u64).await
            && let Some(again) = attrs_at(side, target).await.ok().flatten()
        {
            current = again;
            after = Some(current.clone());
        }
        if current.mode.is_some_and(|m| m & 0o7777 != mode) {
            warnings.push(json!({ "kind": "mode", "mode": mode }));
        }
    }
    // Not read back: no stamp, so the next save compares the text instead of failing on a made-up one.
    let stamp = match &after {
        Some(a) => {
            let m = meta_of(a);
            stamp_json(m.size, m.mtime, &sha256_hex(output), now_ms())
        }
        None => Value::Null,
    };
    Ok(json!({ "kind": "saved", "stamp": stamp, "warnings": warnings }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_like_text_decoder() {
        assert_eq!(decode_text(b"a\r\nb"), Some(("a\r\nb".into(), "utf-8")));
        assert_eq!(decode_text(b"\xef\xbb\xbfx"), Some(("x".into(), "utf-8-bom")));
        assert_eq!(decode_text(b"\xff\xfea\x00"), Some(("a".into(), "utf-16le")));
        assert_eq!(decode_text(b"\xfe\xff\x00a"), Some(("a".into(), "utf-16be")));
        assert_eq!(decode_text(b"\xff\xfea"), None, "odd length");
        assert_eq!(decode_text(b"\xff\xfe\x00\xd8"), None, "lone surrogate");
        assert_eq!(decode_text(b"a\x00b"), None);
        assert_eq!(decode_text(b"a\x01b"), None);
        assert_eq!(decode_text(b"\xc3"), None);
        assert_eq!(decode_text(b""), Some((String::new(), "utf-8")));
        assert_eq!(decode_text(b"\x0c\t"), Some(("\x0c\t".into(), "utf-8")));
    }

    #[test]
    fn encodes_with_the_file_line_endings() {
        assert_eq!(restore_line_endings("a\nb\nc\nd", "x\r\ny\rz"), "a\r\nb\rc\r\nd");
        assert_eq!(restore_line_endings("a\r\nb", ""), "a\nb");
        assert_eq!(encode_text("a\nb", "x\r\n", "utf-8"), b"a\r\nb");
        assert_eq!(encode_text("a", "", "utf-8-bom"), b"\xef\xbb\xbfa");
        assert_eq!(encode_text("a", "", "utf-16le"), b"\xff\xfea\x00");
        assert_eq!(encode_text("a", "", "utf-16be"), b"\xfe\xff\x00a");
    }

    #[test]
    fn plans_and_hash_checks() {
        assert_eq!(remote_open_plan("x.PNG", 10), OpenPlan::Image("image/png"));
        assert_eq!(remote_open_plan("x.png", EDITOR_IMAGE_BYTES + 1), OpenPlan::TooLarge);
        assert_eq!(remote_open_plan(".png", 10), OpenPlan::Text);
        assert_eq!(remote_open_plan("a.txt", EDITOR_TEXT_BYTES + 1), OpenPlan::TooLarge);
        let s = |size: f64, read_at: Option<f64>| RemoteStamp { size, mtime_ms: 10_000.0, hash: Some("h".into()), read_at };
        assert!(needs_hash_check(&s(1e6, None)));
        assert!(needs_hash_check(&s(1e6, Some(12_000.0))));
        assert!(!needs_hash_check(&s(1e6, Some(12_001.0))));
        assert!(needs_hash_check(&s(100.0, Some(99_999.0))));
        assert!(!needs_hash_check(&RemoteStamp { hash: None, ..s(1.0, None) }));
        assert!(is_part_name("a.unimux-part") && !is_part_name(".unimux-part"));
        assert!(!valid_editor_text("a\u{1}") && valid_editor_text("a\tb\u{c}"));
    }
}
