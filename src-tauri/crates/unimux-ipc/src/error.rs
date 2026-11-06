//! The error every window.mc call can reject with. Serialized as `{code, message, command}`; the renderer bridge turns
//! `MC_NOT_YET` into an `McNotYetError` and every other code into a plain `Error(message)` (what an Electron invoke rejection
//! looked like to the renderer).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IpcError {
    /// In the contract, not implemented yet by its package (wave 0..6 of the migration).
    #[error("{command} is not available yet in this build")]
    NotYet { command: String },
    /// Not in the contract at all (a typo or a removed channel).
    #[error("unknown command {command}")]
    Unknown { command: String },
    /// The sender guard refused the caller (not the app window, a foreign origin or frame).
    #[error("{command} refused for this window")]
    Refused { command: String },
    /// The arguments do not have the shape the handler expects.
    #[error("{command}: bad arguments: {message}")]
    BadArgs { command: String, message: String },
    /// The handler failed.
    #[error("{message}")]
    Failed { command: String, message: String },
}

impl IpcError {
    pub fn code(&self) -> &'static str {
        match self {
            IpcError::NotYet { .. } => "MC_NOT_YET",
            IpcError::Unknown { .. } => "MC_UNKNOWN",
            IpcError::Refused { .. } => "MC_REFUSED",
            IpcError::BadArgs { .. } => "MC_BAD_ARGS",
            IpcError::Failed { .. } => "MC_FAILED",
        }
    }
    pub fn command(&self) -> &str {
        match self {
            IpcError::NotYet { command }
            | IpcError::Unknown { command }
            | IpcError::Refused { command }
            | IpcError::BadArgs { command, .. }
            | IpcError::Failed { command, .. } => command,
        }
    }
    pub fn failed(command: &str, message: impl Into<String>) -> Self {
        IpcError::Failed { command: command.to_string(), message: message.into() }
    }
}

#[derive(Serialize)]
struct Wire<'a> {
    code: &'static str,
    message: String,
    command: &'a str,
}

impl Serialize for IpcError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Wire { code: self.code(), message: self.to_string(), command: self.command() }.serialize(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_yet_shape() {
        let e = IpcError::NotYet { command: "git:status".into() };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({"code": "MC_NOT_YET", "message": "git:status is not available yet in this build", "command": "git:status"})
        );
    }
}
