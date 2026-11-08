//! `SftpOp` of src/shared/sftpHostIpc.ts: one operation of a session (or of the local queue), already validated by the IPC
//! layer ([`crate::ipc`]), and `opTimeoutMs` of src/main/sftpHostClient.ts.

use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::limits::TransferDirection;

/// `ConflictChoice`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictChoice {
    Overwrite,
    Skip,
    KeepBoth,
}

impl ConflictChoice {
    pub fn parse(s: &str) -> Option<ConflictChoice> {
        Some(match s {
            "overwrite" => ConflictChoice::Overwrite,
            "skip" => ConflictChoice::Skip,
            "keepBoth" => ConflictChoice::KeepBoth,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ConflictChoice::Overwrite => "overwrite",
            ConflictChoice::Skip => "skip",
            ConflictChoice::KeepBoth => "keepBoth",
        }
    }
}

/// `TransferRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferRequest {
    pub direction: TransferDirection,
    pub sources: Vec<String>,
    pub target_dir: String,
    pub policy: Option<ConflictChoice>,
    pub batch_id: Option<String>,
}

/// `ConflictAnswer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConflictAnswer {
    pub choice: ConflictChoice,
    pub apply_to_rest: bool,
}

/// `DeleteCount`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DeleteCount {
    pub files: u64,
    pub dirs: u64,
}

impl DeleteCount {
    pub fn to_json(self) -> Value {
        json!({ "files": self.files, "dirs": self.dirs })
    }
}

/// `ChmodRequest`: `set` (bits under a mask) and / or `recursive` (one value for folders, one for files).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChmodRequest {
    pub paths: Vec<String>,
    /// `{bits, mask}`.
    pub set: Option<(u32, u32)>,
    /// `{dirMode, fileMode}`.
    pub recursive: Option<(u32, u32)>,
    pub op_id: Option<String>,
    pub total: Option<u64>,
}

/// `RemoteStamp` after `cleanStamp`: only the known fields.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteStamp {
    pub size: f64,
    pub mtime_ms: f64,
    pub hash: Option<String>,
    pub read_at: Option<f64>,
}

impl RemoteStamp {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("size".into(), num(self.size));
        m.insert("mtimeMs".into(), num(self.mtime_ms));
        if let Some(h) = &self.hash {
            m.insert("hash".into(), json!(h));
        }
        if let Some(r) = self.read_at {
            m.insert("readAt".into(), num(r));
        }
        Value::Object(m)
    }
}

/// A JS number as JSON (whole values as integers, like JSON.stringify).
pub(crate) fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 { json!(n as i64) } else { json!(n) }
}

/// `TextEncodingName`.
pub const TEXT_ENCODINGS: [&str; 4] = ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"];

/// `EditorSave` as the IPC passes it on (`expected` cleaned, `allowOwnerChange` only when true).
#[derive(Debug, Clone, PartialEq)]
pub struct EditorSave {
    pub text: String,
    pub baseline: String,
    pub encoding: String,
    pub expected: Option<RemoteStamp>,
    pub allow_owner_change: bool,
}

/// `SftpOp`.
#[derive(Debug, Clone, PartialEq)]
pub enum SftpOp {
    List { path: String },
    Stat { path: String },
    Realpath { path: String },
    Mkdir { path: String },
    Rename { from: String, to: String },
    DeleteCount { paths: Vec<String> },
    Delete { paths: Vec<String>, confirmed: DeleteCount },
    Enqueue { req: TransferRequest },
    Cancel { item_ids: Option<Vec<String>>, batch_id: Option<String> },
    AnswerConflict { item_id: String, answer: ConflictAnswer },
    Retry { item_ids: Vec<String> },
    ClearFinished,
    ChmodCount { paths: Vec<String>, recursive: bool },
    Chmod { req: ChmodRequest },
    CancelOp { op_id: String },
    ReadFile { path: String },
    StatFile { path: String },
    WriteFile { path: String, save: EditorSave },
}

impl SftpOp {
    /// The `op` name of the TS union.
    pub fn name(&self) -> &'static str {
        match self {
            SftpOp::List { .. } => "list",
            SftpOp::Stat { .. } => "stat",
            SftpOp::Realpath { .. } => "realpath",
            SftpOp::Mkdir { .. } => "mkdir",
            SftpOp::Rename { .. } => "rename",
            SftpOp::DeleteCount { .. } => "deleteCount",
            SftpOp::Delete { .. } => "delete",
            SftpOp::Enqueue { .. } => "enqueue",
            SftpOp::Cancel { .. } => "cancel",
            SftpOp::AnswerConflict { .. } => "answerConflict",
            SftpOp::Retry { .. } => "retry",
            SftpOp::ClearFinished => "clearFinished",
            SftpOp::ChmodCount { .. } => "chmodCount",
            SftpOp::Chmod { .. } => "chmod",
            SftpOp::CancelOp { .. } => "cancelOp",
            SftpOp::ReadFile { .. } => "readFile",
            SftpOp::StatFile { .. } => "statFile",
            SftpOp::WriteFile { .. } => "writeFile",
        }
    }

    /// The operations of a transfer queue (they also work for the local queue and before a session is connected).
    pub fn is_queue_op(&self) -> bool {
        matches!(
            self,
            SftpOp::Enqueue { .. }
                | SftpOp::Cancel { .. }
                | SftpOp::AnswerConflict { .. }
                | SftpOp::Retry { .. }
                | SftpOp::ClearFinished
        )
    }
}

/// `opTimeoutMs`: how long the service waits for an operation; None: no limit. An enqueue walks a folder and may take long
/// (it ends with the session, a crash or `cancel({batchId})`); a recursive chmod is stopped by its op id.
pub fn op_timeout(op: &SftpOp) -> Option<Duration> {
    match op {
        SftpOp::Enqueue { .. } | SftpOp::Chmod { .. } => None,
        SftpOp::Delete { .. } | SftpOp::DeleteCount { .. } | SftpOp::ChmodCount { .. } => Some(Duration::from_secs(600)),
        // An editor tab reads or writes up to 8 MB in one request (a slow link needs minutes).
        SftpOp::ReadFile { .. } | SftpOp::WriteFile { .. } => Some(Duration::from_secs(300)),
        _ => Some(Duration::from_secs(60)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeouts_follow_the_client() {
        let list = SftpOp::List { path: "/".into() };
        assert_eq!(op_timeout(&list), Some(Duration::from_secs(60)));
        assert_eq!(op_timeout(&SftpOp::ClearFinished), Some(Duration::from_secs(60)));
        assert_eq!(op_timeout(&SftpOp::DeleteCount { paths: vec![] }), Some(Duration::from_secs(600)));
        assert_eq!(op_timeout(&SftpOp::ReadFile { path: "/a".into() }), Some(Duration::from_secs(300)));
        let req = ChmodRequest { paths: vec![], set: None, recursive: Some((0o755, 0o644)), op_id: None, total: None };
        assert_eq!(op_timeout(&SftpOp::Chmod { req }), None);
        assert!(SftpOp::ClearFinished.is_queue_op());
        assert!(!list.is_queue_op());
    }

    #[test]
    fn stamps_serialize_like_clean_stamp() {
        let s = RemoteStamp { size: 3.0, mtime_ms: 1.5, hash: None, read_at: Some(7.0) };
        assert_eq!(s.to_json().to_string(), r#"{"size":3,"mtimeMs":1.5,"readAt":7}"#);
    }
}
