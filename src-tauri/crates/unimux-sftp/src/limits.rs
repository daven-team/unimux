//! The pure parts of src/shared/sftp.ts the service, the IPC validation and the host share: session ids, `SFTP_LIMITS`,
//! the session status of an SSH phase, transfer directions and the POSIX path rules of remote paths.

use std::time::Duration;

use unimux_ssh::session::SshPhase;

pub use unimux_ssh::session::{is_sftp_session_id, valid_remote_path};

/// `SFTP_SESSION_PREFIX`: SFTP session ids live in their own namespace next to cell ids.
pub const SFTP_SESSION_PREFIX: &str = "sftp:";
/// `LOCAL_QUEUE_ID`: the queue of copies from the OS into a local folder (no connection needed).
pub const LOCAL_QUEUE_ID: &str = "local";

/// `SFTP_LIMITS.path` (UTF-16 units).
pub const PATH_MAX: usize = 4096;
/// `SFTP_LIMITS.name`.
pub const NAME_MAX: usize = 255;
/// `SFTP_LIMITS.paths`: paths in one delete / enqueue call.
pub const PATHS_MAX: usize = 1000;
/// `SFTP_LIMITS.listEntries`: entries returned by one listing.
pub const LIST_ENTRIES: usize = 20_000;
/// `SFTP_LIMITS.batchFiles`: files one enqueue may expand to.
pub const BATCH_FILES: usize = 50_000;
/// `SFTP_LIMITS.concurrentFiles`: files moving at the same time per session.
pub const CONCURRENT_FILES: usize = 3;
/// `SFTP_LIMITS.progressPerSecond`: progress events per running item per second (about).
pub const PROGRESS_PER_SECOND: u64 = 10;
/// `1000 / progressPerSecond`: the ItemThrottle interval.
pub const PROGRESS_INTERVAL_MS: u64 = 1000 / PROGRESS_PER_SECOND;
/// `SFTP_LIMITS.idleDisconnectMs`: idle disconnect after the view closed and the queue is empty.
pub const IDLE_DISCONNECT_MS: u64 = 2 * 60_000;

/// `SFTP_TIMERS` of the SFTP Host (sftphost/host.ts): the SFTP channel, the grace of a hard close and sudo's prompt grace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SftpTimers {
    pub sftp: Duration,
    pub kill_grace: Duration,
    pub sudo_prompt_grace: Duration,
}

pub const SFTP_TIMERS: SftpTimers =
    SftpTimers { sftp: Duration::from_secs(20), kill_grace: Duration::from_secs(2), sudo_prompt_grace: Duration::from_secs(3) };

/// `SFTP_SHUTDOWN_WAIT_MS`: how long the app waits for the sessions to close at quit.
pub const SHUTDOWN_WAIT: Duration = Duration::from_secs(4);

/// `sftpSessionId(uuid)`.
pub fn sftp_session_id(uuid: &str) -> String {
    format!("{SFTP_SESSION_PREFIX}{uuid}")
}

/// `SftpSessionStatus` of an SSH phase (`sftpStatusOf`).
pub fn status_of(phase: SshPhase) -> &'static str {
    match phase {
        SshPhase::Connected => "connected",
        SshPhase::Error => "error",
        SshPhase::Closed | SshPhase::Idle => "closed",
        _ => "connecting",
    }
}

/// `TransferDirection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferDirection {
    Upload,
    Download,
    LocalCopy,
    Move,
    LocalMove,
}

impl TransferDirection {
    pub fn parse(s: &str) -> Option<TransferDirection> {
        Some(match s {
            "upload" => TransferDirection::Upload,
            "download" => TransferDirection::Download,
            "local-copy" => TransferDirection::LocalCopy,
            "move" => TransferDirection::Move,
            "local-move" => TransferDirection::LocalMove,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            TransferDirection::Upload => "upload",
            TransferDirection::Download => "download",
            TransferDirection::LocalCopy => "local-copy",
            TransferDirection::Move => "move",
            TransferDirection::LocalMove => "local-move",
        }
    }

    /// `isLocalDirection`: directions of the local queue (no connection needed).
    pub fn is_local(self) -> bool {
        matches!(self, TransferDirection::LocalCopy | TransferDirection::LocalMove)
    }

    /// `isMoveDirection`.
    pub fn is_move(self) -> bool {
        matches!(self, TransferDirection::Move | TransferDirection::LocalMove)
    }
}

/// `posixNormalize`: resolves "." and "..", collapses slashes; never produces a Windows separator. Relative input stays
/// relative.
pub fn posix_normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if out.last().is_some_and(|l| *l != "..") {
                out.pop();
            } else if !absolute {
                out.push("..");
            }
            continue;
        }
        out.push(part);
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// `posixContains`: `child` is `parent` itself or inside it (both normalized, absolute).
pub fn posix_contains(parent: &str, child: &str) -> bool {
    let (p, c) = (posix_normalize(parent), posix_normalize(child));
    c == p || c.starts_with(&if p == "/" { "/".to_string() } else { format!("{p}/") })
}

/// `validRemoteName`: one remote name (no separator, not "." or ".."). Backslashes are allowed: they are ordinary
/// characters on POSIX.
pub fn valid_remote_name(name: &str) -> bool {
    let units = unimux_core::utf16::len(name);
    units > 0 && units <= NAME_MAX && name != "." && name != ".." && !name.contains(['/', '\0'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_matches_the_ts_helper() {
        assert_eq!(posix_normalize("/a//b/./c/../d/"), "/a/b/d");
        assert_eq!(posix_normalize("/.."), "/");
        assert_eq!(posix_normalize("a/../../b"), "../b");
        assert_eq!(posix_normalize(""), ".");
        assert_eq!(posix_normalize("./"), ".");
        assert!(posix_contains("/a", "/a/b"));
        assert!(posix_contains("/", "/x"));
        assert!(!posix_contains("/a", "/ab"));
    }

    #[test]
    fn statuses_and_names() {
        assert_eq!(status_of(SshPhase::Verifying), "connecting");
        assert_eq!(status_of(SshPhase::Idle), "closed");
        assert!(valid_remote_name("a\\b"));
        assert!(!valid_remote_name(".."));
        assert!(!valid_remote_name("a/b"));
        assert!(!valid_remote_name(&"x".repeat(256)));
        assert!(TransferDirection::parse("local-move").is_some_and(|d| d.is_local() && d.is_move()));
        assert_eq!(sftp_session_id("u"), "sftp:u");
    }
}
