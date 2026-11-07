//! update coordinator, startup gate flow, feed + minisign verify, progress model, install (U1-U5)
//!
//! Skeleton created by wave 0 (F1/F2). The owning packages fill it in (see docs/tauri/PLAN.md); its commands are registered in
//! `unimux-app/src/commands/update.rs`, which calls into this crate.
//!
//! SP6 added [`progress`] (UpdateProgressModel port) and [`window`] (the update window hand-over and file protocol); the
//! window process itself is `unimux-app/src/update_window.rs`.
//!
//! U1 added [`coordinator`] (UpdateCoordinator port), [`gate`] (the startup gate and install window flow, update-gate.json),
//! [`feed`] (latest.json + minisign) and [`net`] (the backend over unimux-net).
//!
//! U5 added [`mac`] (the macOS engine and the bundle swap the update window runs) and [`version`] (compareVersions).

pub mod coordinator;
pub mod feed;
pub mod gate;
pub mod mac;
pub mod net;
pub mod progress;
pub mod settled;
pub mod state;
pub mod version;
pub mod window;

/// Where a build that cannot install by itself sends the user (updater.ts RELEASES_URL).
pub const RELEASES_URL: &str = "https://github.com/daven-team/unimux/releases/latest";

/// The updater public key (minisign, key id 817A07BB564AC8D0) exactly as `tauri signer generate` wrote it to
/// `unimux-updater.key.pub`: base64 of the two-line minisign public key file. Embedded at build time; the downloaded artifact of a
/// Tauri -> Tauri update is verified against it (U1). The private key exists only as the GitHub secret TAURI_SIGNING_PRIVATE_KEY.
pub const UPDATER_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDgxN0EwN0JCNTY0QUM4RDAKUldUUXlFcFd1d2Q2Z1ZRNXN5VVZnaUMzVE9PcUhkaWRpYnJON0RzUFN5K2F0eVJHUGJvRjIrNFcK";

/// The minisign key id of [`UPDATER_PUBLIC_KEY`].
pub const UPDATER_KEY_ID: &str = "817A07BB564AC8D0";

/// Where Tauri clients look for updates (U1).
pub const FEED_URL: &str = "https://github.com/daven-team/unimux/releases/latest/download/latest.json";

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn public_key_decodes_to_the_minisign_file_with_the_expected_id() {
        let text = base64::engine::general_purpose::STANDARD.decode(UPDATER_PUBLIC_KEY).unwrap();
        let text = String::from_utf8(text).unwrap();
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some(format!("untrusted comment: minisign public key: {UPDATER_KEY_ID}").as_str()));
        let key = base64::engine::general_purpose::STANDARD.decode(lines.next().unwrap()).unwrap();
        // "Ed" + 8-byte key id (little endian) + 32-byte Ed25519 key.
        assert_eq!(key.len(), 42);
        assert_eq!(&key[..2], b"Ed");
        let id: String = key[2..10].iter().rev().map(|b| format!("{b:02X}")).collect();
        assert_eq!(id, UPDATER_KEY_ID);
    }
}
