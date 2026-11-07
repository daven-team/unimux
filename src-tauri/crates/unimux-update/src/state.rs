//! `UpdateState` of src/shared/types.ts: what the status bar shows (`update:get`, `update:state`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
    Unavailable,
}

/// The fields TS sets per status; absent fields are left out of the JSON like `undefined` ones.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transferred: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<f64>,
    /// Always set by the coordinator (`portable ?? options.portable()`), absent only on the initial idle state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl UpdateState {
    pub fn new(status: Status) -> Self {
        Self { status, ..Default::default() }
    }

    pub fn with_version(status: Status, version: impl Into<String>) -> Self {
        Self { status, version: Some(version.into()), ..Default::default() }
    }

    pub fn version_is(&self, version: &str) -> bool {
        self.version.as_deref() == Some(version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_like_the_ts_object() {
        let mut s = UpdateState::with_version(Status::Downloading, "1.2.1");
        s.percent = Some(42.0);
        s.portable = Some(false);
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({"status": "downloading", "version": "1.2.1", "percent": 42.0, "portable": false})
        );
        assert_eq!(serde_json::to_value(UpdateState::default()).unwrap(), serde_json::json!({"status": "idle"}));
    }
}
