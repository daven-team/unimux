//! The `sftp:*` channels (port of 1.1.4 src/main/sftp/ipc.ts `createSftpHandlers`): zod-equivalent validation, fixed error
//! codes only. Remote paths must be absolute POSIX paths, local ones absolute local paths. Every function takes the
//! renderer's positional arguments as JSON and answers the JSON 1.1.4 answered.

use serde_json::{Map, Value, json};
use unimux_ssh::protocol::{HostKeyChoice, PromptAnswer};
use zeroize::Zeroizing;

use crate::error::{SftpResult, invalid, result_json};
use crate::limits::{PATHS_MAX, TransferDirection, is_sftp_session_id, valid_remote_path};
use crate::op::{
    ChmodRequest, ConflictAnswer, ConflictChoice, DeleteCount, EditorSave, RemoteStamp, SftpOp, TEXT_ENCODINGS, TransferRequest,
};
use crate::service::SftpService;

/// `SSH_LIMITS.password` (zod 4 counts code points in `z.string().max`).
const PASSWORD_MAX: usize = 1024;
/// `EDITOR_TEXT_BYTES` (compared with the UTF-16 length, like `text.length`).
const EDITOR_TEXT_BYTES: usize = 8 * 1024 * 1024;
/// Hosts one window may pin.
const PIN_HOSTS_MAX: usize = 200;
/// `Number.MAX_SAFE_INTEGER`: zod 4's `.int()` accepts safe integers only.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `z.guid()`: 8-4-4-4-12 hex digits, any version, either case.
pub fn is_guid(v: &Value) -> bool {
    v.as_str().is_some_and(guid_str)
}

fn guid_str(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `z.string().refine(isSftpSessionId)`.
fn session_id(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| is_sftp_session_id(s))
}

fn remote_path(v: &Value) -> Option<String> {
    v.as_str().filter(|p| valid_remote_path(p)).map(str::to_string)
}

/// `remotePaths`: 1 to 1000 absolute POSIX paths.
fn remote_paths(v: &Value) -> Option<Vec<String>> {
    let list = v.as_array()?;
    if list.is_empty() || list.len() > PATHS_MAX {
        return None;
    }
    list.iter().map(remote_path).collect()
}

/// `z.number().int().min(lo).max(hi)`.
fn int_in(v: &Value, lo: f64, hi: f64) -> Option<u64> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && n >= lo && n <= hi && n.abs() <= MAX_SAFE).then_some(n as u64)
}

/// `.strict()`: only these keys.
fn only_keys(o: &Map<String, Value>, keys: &[&str]) -> bool {
    o.keys().all(|k| keys.contains(&k.as_str()))
}

/// `z.boolean().optional()`: Some(false) when absent.
fn opt_bool(o: &Map<String, Value>, key: &str) -> Option<bool> {
    match o.get(key) {
        None => Some(false),
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => None,
    }
}

/// An optional key of a strict object: `Some(None)` when absent, `None` when present with a bad value.
fn optional<T>(o: &Map<String, Value>, key: &str, parse: impl Fn(&Value) -> Option<T>) -> Option<Option<T>> {
    match o.get(key) {
        None => Some(None),
        Some(v) => parse(v).map(Some),
    }
}

fn guid_list(v: &Value, min: usize, max: usize) -> Option<Vec<String>> {
    let list = v.as_array()?;
    if list.len() < min || list.len() > max {
        return None;
    }
    list.iter().map(|x| x.as_str().filter(|s| guid_str(s)).map(str::to_string)).collect()
}

/// `validLocalPath` of src/main/localFiles.ts.
fn local_path(p: &str) -> bool {
    unimux_files::local::valid_local_path(p)
}

/// `count`: `{files, dirs}` non-negative integers, strict.
fn delete_count(v: &Value) -> Option<DeleteCount> {
    let o = v.as_object()?;
    if !only_keys(o, &["files", "dirs"]) {
        return None;
    }
    Some(DeleteCount { files: int_in(o.get("files")?, 0.0, MAX_SAFE)?, dirs: int_in(o.get("dirs")?, 0.0, MAX_SAFE)? })
}

/// `transfer`: the strict request with the refine on which side every path is.
pub fn transfer_request(v: &Value) -> Option<TransferRequest> {
    let o = v.as_object()?;
    if !only_keys(o, &["direction", "sources", "targetDir", "policy", "batchId"]) {
        return None;
    }
    let direction = TransferDirection::parse(o.get("direction")?.as_str()?)?;
    let sources = o.get("sources")?.as_array()?;
    if sources.is_empty() || sources.len() > PATHS_MAX {
        return None;
    }
    let sources: Vec<String> = sources.iter().map(|s| s.as_str().map(str::to_string)).collect::<Option<_>>()?;
    let target_dir = o.get("targetDir")?.as_str()?.to_string();
    let policy = optional(o, "policy", |p| p.as_str().and_then(ConflictChoice::parse))?;
    let batch_id = optional(o, "batchId", |b| b.as_str().filter(|s| guid_str(s)).map(str::to_string))?;
    let source_remote = matches!(direction, TransferDirection::Download | TransferDirection::Move);
    let target_remote = matches!(direction, TransferDirection::Upload | TransferDirection::Move);
    let side_ok = |p: &str, remote: bool| if remote { valid_remote_path(p) } else { local_path(p) };
    if !sources.iter().all(|s| side_ok(s, source_remote)) || !side_ok(&target_dir, target_remote) {
        return None;
    }
    Some(TransferRequest { direction, sources, target_dir, policy, batch_id })
}

fn mode(v: &Value) -> Option<u32> {
    int_in(v, 0.0, 0o7777 as f64).map(|n| n as u32)
}

/// `chmodRequest`: `set` and `recursive` are required keys (nullable), at least one of them set.
pub fn chmod_request(v: &Value) -> Option<ChmodRequest> {
    let o = v.as_object()?;
    if !only_keys(o, &["paths", "set", "recursive", "opId", "total"]) {
        return None;
    }
    let paths = remote_paths(o.get("paths")?)?;
    let pair = |v: &Value, a: &str, b: &str| -> Option<Option<(u32, u32)>> {
        if v.is_null() {
            return Some(None);
        }
        let p = v.as_object()?;
        if !only_keys(p, &[a, b]) {
            return None;
        }
        Some(Some((mode(p.get(a)?)?, mode(p.get(b)?)?)))
    };
    let set = pair(o.get("set")?, "bits", "mask")?;
    let recursive = pair(o.get("recursive")?, "dirMode", "fileMode")?;
    let op_id = optional(o, "opId", |x| x.as_str().filter(|s| guid_str(s)).map(str::to_string))?;
    let total = optional(o, "total", |x| int_in(x, 0.0, 10_000_000.0))?;
    if set.is_none() && recursive.is_none() {
        return None;
    }
    Some(ChmodRequest { paths, set, recursive, op_id, total })
}

/// `answer`: the union of cancel / values / hostKey, each strict, keyed by `sessionId`.
pub fn prompt_answer(v: &Value) -> Option<PromptAnswer> {
    let o = v.as_object()?;
    let cell_id = session_id(o.get("sessionId")?)?.to_string();
    let prompt_id = o.get("promptId")?.as_str().filter(|s| guid_str(s))?.to_string();
    if only_keys(o, &["sessionId", "promptId", "cancel"]) && o.get("cancel") == Some(&Value::Bool(true)) {
        return Some(PromptAnswer::Cancel { cell_id, prompt_id });
    }
    if only_keys(o, &["sessionId", "promptId", "values", "remember", "useSaved"])
        && let Some(list) = o.get("values").and_then(Value::as_array)
        && list.len() <= 10
        && let Some(remember) = opt_bool(o, "remember")
        && let Some(use_saved) = opt_bool(o, "useSaved")
        && let Some(values) = list
            .iter()
            .map(|v| v.as_str().filter(|s| s.chars().count() <= PASSWORD_MAX).map(|s| Zeroizing::new(s.to_string())))
            .collect::<Option<Vec<_>>>()
    {
        return Some(PromptAnswer::Values { cell_id, prompt_id, values, remember, use_saved });
    }
    if only_keys(o, &["sessionId", "promptId", "hostKey"])
        && let Some(choice) = o.get("hostKey").and_then(Value::as_str).and_then(HostKeyChoice::parse)
    {
        return Some(PromptAnswer::HostKey { cell_id, prompt_id, choice });
    }
    None
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|n| n.is_finite())
}

/// `validStampShape` + `cleanStamp`.
fn stamp(v: &Value) -> Option<RemoteStamp> {
    let o = v.as_object()?;
    let size = finite(o.get("size"))?;
    let mtime_ms = finite(o.get("mtimeMs"))?;
    let hash = match o.get("hash") {
        None => None,
        Some(Value::String(h)) if h.len() == 64 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) => {
            Some(h.clone())
        }
        Some(_) => return None,
    };
    let read_at = match o.get("readAt") {
        None => None,
        Some(r) => Some(finite(Some(r))?),
    };
    // `cleanStamp` keeps a hash only when it is non-empty (it always is here: 64 digits).
    Some(RemoteStamp { size, mtime_ms, hash, read_at })
}

/// `validEditorSave` (not strict: other keys are ignored) and the save main passes on.
pub fn editor_save(v: &Value) -> Option<EditorSave> {
    let o = v.as_object()?;
    let text = o.get("text")?.as_str()?;
    let baseline = o.get("baseline")?.as_str()?;
    if unimux_core::utf16::len(text) > EDITOR_TEXT_BYTES || unimux_core::utf16::len(baseline) > EDITOR_TEXT_BYTES {
        return None;
    }
    let encoding = o.get("encoding")?.as_str().filter(|e| TEXT_ENCODINGS.contains(e))?;
    let expected = match o.get("expected")? {
        Value::Null => None,
        s => Some(stamp(s)?),
    };
    let allow_owner_change = match o.get("allowOwnerChange") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return None,
    };
    Some(EditorSave {
        text: text.to_string(),
        baseline: baseline.to_string(),
        encoding: encoding.to_string(),
        expected,
        allow_owner_change,
    })
}

async fn run(service: &SftpService, id: &Value, op: SftpOp) -> Value {
    match session_id(id) {
        Some(id) => result_json(&service.op(Some(id), op).await),
        None => invalid(),
    }
}

/// `queueId`: an `sftp:` session or null (the local queue).
fn queue_id(v: &Value) -> Option<Option<&str>> {
    if v.is_null() {
        return Some(None);
    }
    session_id(v).map(Some)
}

async fn queue_op(service: &SftpService, id: &Value, op: SftpOp) -> Value {
    let Some(q) = queue_id(id) else { return json!({ "ok": false }) };
    let r: SftpResult = service.op(q, op).await;
    json!({ "ok": matches!(r, Ok(v) if v != Value::Bool(false)) })
}

/// `sftp:connect(hostId, initialPath?, opts?)`.
pub fn connect(service: &SftpService, host_id: &Value, initial_path: &Value, opts: &Value) -> Value {
    let unknown = || json!({ "ok": false, "error": "unknown" });
    if !is_guid(host_id) {
        return unknown();
    }
    let initial = match initial_path {
        Value::Null => None,
        p => match remote_path(p) {
            Some(p) => Some(p),
            None => return unknown(),
        },
    };
    let plain = match opts {
        Value::Null => false,
        Value::Object(o) if only_keys(o, &["plain"]) => match opt_bool(o, "plain") {
            Some(p) => p,
            None => return unknown(),
        },
        _ => return unknown(),
    };
    service.connect(host_id.as_str().unwrap_or_default(), initial, plain)
}

/// `sftp:disconnect(id)`.
pub fn disconnect(service: &SftpService, id: &Value) -> Value {
    json!({ "ok": session_id(id).is_some_and(|id| service.disconnect(id)) })
}

/// `sftp:prompt:answer(answer)`.
pub fn answer(service: &SftpService, raw: &Value) -> Value {
    json!({ "ok": prompt_answer(raw).is_some_and(|a| service.answer(a)) })
}

pub async fn list(service: &SftpService, id: &Value, path: &Value) -> Value {
    match remote_path(path) {
        Some(path) => run(service, id, SftpOp::List { path }).await,
        None => invalid(),
    }
}

pub async fn stat(service: &SftpService, id: &Value, path: &Value) -> Value {
    match remote_path(path) {
        Some(path) => run(service, id, SftpOp::Stat { path }).await,
        None => invalid(),
    }
}

/// `realpath` also takes `.` (the login folder).
pub async fn realpath(service: &SftpService, id: &Value, path: &Value) -> Value {
    match path.as_str().filter(|p| *p == "." || valid_remote_path(p)) {
        Some(path) => run(service, id, SftpOp::Realpath { path: path.to_string() }).await,
        None => invalid(),
    }
}

pub async fn mkdir(service: &SftpService, id: &Value, path: &Value) -> Value {
    match remote_path(path) {
        Some(path) => run(service, id, SftpOp::Mkdir { path }).await,
        None => invalid(),
    }
}

pub async fn rename(service: &SftpService, id: &Value, from: &Value, to: &Value) -> Value {
    match (remote_path(from), remote_path(to)) {
        (Some(from), Some(to)) => run(service, id, SftpOp::Rename { from, to }).await,
        _ => invalid(),
    }
}

pub async fn delete_count_op(service: &SftpService, id: &Value, paths: &Value) -> Value {
    match remote_paths(paths) {
        Some(paths) => run(service, id, SftpOp::DeleteCount { paths }).await,
        None => invalid(),
    }
}

pub async fn delete(service: &SftpService, id: &Value, paths: &Value, confirmed: &Value) -> Value {
    match (remote_paths(paths), delete_count(confirmed)) {
        (Some(paths), Some(confirmed)) => run(service, id, SftpOp::Delete { paths, confirmed }).await,
        _ => invalid(),
    }
}

/// `sftp:enqueue(id | null, request)`: the local queue (null) takes only local directions, a session only the others.
pub async fn enqueue(service: &SftpService, id: &Value, req: &Value) -> Value {
    let (Some(q), Some(req)) = (queue_id(id), transfer_request(req)) else { return invalid() };
    if q.is_none() != req.direction.is_local() {
        return invalid();
    }
    result_json(&service.op(q, SftpOp::Enqueue { req }).await)
}

pub async fn cancel(service: &SftpService, id: &Value, target: &Value) -> Value {
    let parsed = target.as_object().filter(|o| only_keys(o, &["itemIds", "batchId"])).and_then(|o| {
        let item_ids = optional(o, "itemIds", |v| guid_list(v, 0, PATHS_MAX))?;
        let batch_id = optional(o, "batchId", |v| v.as_str().filter(|s| guid_str(s)).map(str::to_string))?;
        Some((item_ids, batch_id))
    });
    match parsed {
        Some((item_ids, batch_id)) => queue_op(service, id, SftpOp::Cancel { item_ids, batch_id }).await,
        None => json!({ "ok": false }),
    }
}

pub async fn answer_conflict(service: &SftpService, id: &Value, item_id: &Value, a: &Value) -> Value {
    let answer = a.as_object().filter(|o| only_keys(o, &["choice", "applyToRest"])).and_then(|o| {
        Some(ConflictAnswer {
            choice: ConflictChoice::parse(o.get("choice")?.as_str()?)?,
            apply_to_rest: o.get("applyToRest")?.as_bool()?,
        })
    });
    match (item_id.as_str().filter(|s| guid_str(s)), answer) {
        (Some(item), Some(answer)) => queue_op(service, id, SftpOp::AnswerConflict { item_id: item.to_string(), answer }).await,
        _ => json!({ "ok": false }),
    }
}

pub async fn retry(service: &SftpService, id: &Value, item_ids: &Value) -> Value {
    match guid_list(item_ids, 1, PATHS_MAX) {
        Some(item_ids) => queue_op(service, id, SftpOp::Retry { item_ids }).await,
        None => json!({ "ok": false }),
    }
}

pub async fn clear_finished(service: &SftpService, id: &Value) -> Value {
    queue_op(service, id, SftpOp::ClearFinished).await
}

pub async fn chmod_count(service: &SftpService, id: &Value, paths: &Value, recursive: &Value) -> Value {
    match (remote_paths(paths), recursive.as_bool()) {
        (Some(paths), Some(recursive)) => run(service, id, SftpOp::ChmodCount { paths, recursive }).await,
        _ => invalid(),
    }
}

pub async fn chmod(service: &SftpService, id: &Value, req: &Value) -> Value {
    match chmod_request(req) {
        Some(req) => run(service, id, SftpOp::Chmod { req }).await,
        None => invalid(),
    }
}

/// `sftp:cancelOp(id, opId)`: `{ok}` true only when a running operation was stopped.
pub async fn cancel_op(service: &SftpService, id: &Value, op_id: &Value) -> Value {
    let Some(op_id) = op_id.as_str().filter(|s| guid_str(s)) else { return json!({ "ok": false }) };
    let r = run(service, id, SftpOp::CancelOp { op_id: op_id.to_string() }).await;
    json!({ "ok": r.get("ok") == Some(&Value::Bool(true)) && r.get("value") == Some(&Value::Bool(true)) })
}

pub async fn stat_file(service: &SftpService, id: &Value, path: &Value) -> Value {
    match remote_path(path) {
        Some(path) => run(service, id, SftpOp::StatFile { path }).await,
        None => invalid(),
    }
}

pub async fn read_file(service: &SftpService, id: &Value, path: &Value) -> Value {
    match remote_path(path) {
        Some(path) => run(service, id, SftpOp::ReadFile { path }).await,
        None => invalid(),
    }
}

pub async fn write_file(service: &SftpService, id: &Value, path: &Value, save: &Value) -> Value {
    match (remote_path(path), editor_save(save)) {
        (Some(path), Some(save)) => run(service, id, SftpOp::WriteFile { path, save }).await,
        _ => invalid(),
    }
}

/// `sftp:pinHosts(hostIds)` from `window` (`main` or a detached window's id).
pub fn pin_hosts(service: &SftpService, host_ids: &Value, window: &str) {
    if let Some(ids) = guid_list(host_ids, 0, PIN_HOSTS_MAX) {
        service.pin_hosts(ids, window);
    }
}

/// `sftp:viewOpened(shown)`: an id that is not a session id counts as none.
pub fn view_opened(service: &SftpService, shown: &Value) {
    service.view_opened(session_id(shown).map(str::to_string));
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "sftp:00000000-0000-4000-8000-000000000001";
    const P: &str = "00000000-0000-4000-8000-000000000009";

    fn local_dir() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    #[test]
    fn transfers_check_the_side_of_every_path() {
        let local = local_dir();
        let ok = |v: Value| transfer_request(&v).is_some();
        assert!(ok(json!({ "direction": "upload", "sources": [local], "targetDir": "/home" })));
        assert!(ok(
            json!({ "direction": "download", "sources": ["/home/x"], "targetDir": local, "policy": "skip", "batchId": P })
        ));
        assert!(!ok(json!({ "direction": "download", "sources": ["/home/x"], "targetDir": "relative" })));
        assert!(!ok(json!({ "direction": "upload", "sources": [local], "targetDir": "/home", "extra": 1 })));
        assert!(!ok(json!({ "direction": "upload", "sources": [], "targetDir": "/home" })));
        assert!(!ok(json!({ "direction": "move", "sources": ["/a"], "targetDir": "C:\\x" })));
        assert!(!ok(json!({ "direction": "upload", "sources": [local], "targetDir": "/home", "policy": null })));
        assert!(!ok(json!({ "direction": "sideways", "sources": [local], "targetDir": "/home" })));
    }

    #[test]
    fn chmod_requests_need_set_or_recursive() {
        let ok = |v: Value| chmod_request(&v).is_some();
        assert!(ok(json!({ "paths": ["/a"], "set": { "bits": 0o644, "mask": 0o777 }, "recursive": null })));
        assert!(ok(
            json!({ "paths": ["/a"], "set": null, "recursive": { "dirMode": 0o755, "fileMode": 0o644 }, "opId": P, "total": 3 })
        ));
        assert!(!ok(json!({ "paths": ["/a"], "set": null, "recursive": null })));
        assert!(!ok(json!({ "paths": ["/a"], "set": null })));
        assert!(!ok(json!({ "paths": ["/a"], "set": { "bits": 0o10000, "mask": 0 }, "recursive": null })));
        assert!(!ok(json!({ "paths": ["/a"], "set": { "bits": 1, "mask": 1, "x": 1 }, "recursive": null })));
        assert!(!ok(json!({ "paths": ["/a"], "set": null, "recursive": { "dirMode": 1, "fileMode": 1 }, "total": 10_000_001 })));
    }

    #[test]
    fn answers_follow_the_zod_union_with_session_ids() {
        assert!(matches!(
            prompt_answer(&json!({ "sessionId": ID, "promptId": P, "cancel": true })),
            Some(PromptAnswer::Cancel { .. })
        ));
        assert!(matches!(
            prompt_answer(&json!({ "sessionId": ID, "promptId": P, "values": ["x"], "useSaved": true })),
            Some(PromptAnswer::Values { use_saved: true, remember: false, .. })
        ));
        assert!(matches!(
            prompt_answer(&json!({ "sessionId": ID, "promptId": P, "hostKey": "once" })),
            Some(PromptAnswer::HostKey { .. })
        ));
        for bad in [
            json!({ "cellId": ID, "promptId": P, "cancel": true }),
            json!({ "sessionId": P, "promptId": P, "cancel": true }),
            json!({ "sessionId": ID, "promptId": P, "values": vec!["x"; 11] }),
            json!({ "sessionId": ID, "promptId": P, "hostKey": "always" }),
        ] {
            assert!(prompt_answer(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn editor_saves_take_only_well_formed_stamps() {
        let hash = "a".repeat(64);
        let save = editor_save(&json!({ "text": "x", "baseline": "x", "encoding": "utf-8", "expected": { "size": 1, "mtimeMs": 2, "hash": hash, "extra": 1 } })).unwrap();
        assert_eq!(save.expected.unwrap().to_json(), json!({ "size": 1, "mtimeMs": 2, "hash": hash }));
        assert!(
            editor_save(
                &json!({ "text": "x", "baseline": "x", "encoding": "utf-8", "expected": null, "allowOwnerChange": true })
            )
            .unwrap()
            .allow_owner_change
        );
        for bad in [
            json!({ "text": "x", "baseline": "x", "encoding": "utf-8" }),
            json!({ "text": "x", "baseline": "x", "encoding": "latin1", "expected": null }),
            json!({ "text": "x", "baseline": "x", "encoding": "utf-8", "expected": { "size": 1, "mtimeMs": 2, "hash": "ABC" } }),
            json!({ "text": "x", "baseline": "x", "encoding": "utf-8", "expected": null, "allowOwnerChange": 1 }),
        ] {
            assert!(editor_save(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn delete_counts_are_strict_non_negative_integers() {
        assert_eq!(delete_count(&json!({ "files": 1, "dirs": 0 })), Some(DeleteCount { files: 1, dirs: 0 }));
        assert!(delete_count(&json!({ "files": -1, "dirs": 0 })).is_none());
        assert!(delete_count(&json!({ "files": 1.5, "dirs": 0 })).is_none());
        assert!(delete_count(&json!({ "files": 1, "dirs": 0, "x": 0 })).is_none());
    }
}
