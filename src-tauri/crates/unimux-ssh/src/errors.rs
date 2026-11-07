//! The SshErrorCode map (1.1.4 src/ptyhost/sshErrors.ts `mapSshError`) for russh and socket errors, the S3 table SP7
//! measured against ssh2 (docs/tauri/spikes/SP7.md: 104 / 104 logins with the same outcome and code), and the debug line
//! filter of unpackaged runs.
//!
//! ssh2's `isRecoverableAuthError` (a key that cannot sign is skipped by ssh2 itself) has no counterpart: the login core
//! skips a key it cannot use before it sends anything (login.rs).

use crate::session::SshErrorCode;

/// `mapSshError(err, override)`: the reason main or the login decided (a refused host key, a cancelled prompt) wins.
pub fn map_error(e: &russh::Error, override_code: Option<SshErrorCode>) -> SshErrorCode {
    if let Some(code) = override_code {
        return code;
    }
    use russh::Error as E;
    match e {
        E::IO(io) => io_code(io),
        E::ConnectionTimeout | E::KeepaliveTimeout | E::InactivityTimeout | E::Elapsed(_) => SshErrorCode::Timeout,
        // ssh2: level 'handshake' / 'protocol' or "no matching ..." -> protocol. A refused host key without an override
        // ("Host denied (verification failed)", level 'handshake') is one of them.
        E::NoCommonAlgo { .. }
        | E::KexInit
        | E::Kex
        | E::Version
        | E::UnknownAlgo
        | E::UnknownKey
        | E::WrongServerSig
        | E::StrictKeyExchangeViolation { .. }
        | E::DecryptionError
        | E::PacketAuth
        | E::PacketSize(_)
        | E::Inconsistent => SshErrorCode::Protocol,
        // ssh2: level 'client-authentication' -> auth.
        E::NotAuthenticated | E::NoAuthMethod | E::UnsupportedAuthMethod => SshErrorCode::Auth,
        // ssh2 ends with 'close' and no error event here (mapSshError(undefined) -> unknown).
        _ => SshErrorCode::Unknown,
    }
}

/// The socket half of `mapSshError` (Node's `err.code`).
pub fn io_code(e: &std::io::Error) -> SshErrorCode {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::ConnectionRefused => SshErrorCode::Refused,
        K::TimedOut => SshErrorCode::Timeout,
        K::HostUnreachable | K::NetworkUnreachable | K::NetworkDown => SshErrorCode::Unreachable,
        K::ConnectionReset | K::BrokenPipe | K::ConnectionAborted => SshErrorCode::Reset,
        // ENOTFOUND / EAI_AGAIN: getaddrinfo failures (WSAHOST_NOT_FOUND, WSATRY_AGAIN, WSANO_DATA on Windows).
        _ if is_dns_failure(e) => SshErrorCode::Dns,
        _ => match e.raw_os_error() {
            // EHOSTDOWN (Linux 112, macOS 64) and WSAEHOSTDOWN.
            Some(10064) if cfg!(windows) => SshErrorCode::Unreachable,
            Some(112) if cfg!(target_os = "linux") => SshErrorCode::Unreachable,
            Some(64) if cfg!(target_os = "macos") => SshErrorCode::Unreachable,
            _ => SshErrorCode::Unknown,
        },
    }
}

/// A name lookup that failed (as opposed to a connect that failed).
pub fn is_dns_failure(e: &std::io::Error) -> bool {
    if cfg!(windows) && matches!(e.raw_os_error(), Some(11001..=11004)) {
        return true;
    }
    let text = e.to_string();
    text.contains("lookup") || text.contains("nodename nor servname") || text.contains("Name or service not known")
}

/// `sshDebugFilter`: every line from the start of user authentication on is dropped (it may name methods and users).
#[derive(Debug, Default)]
pub struct DebugFilter {
    auth_started: bool,
}

impl DebugFilter {
    pub fn keep(&mut self, line: &str) -> bool {
        if line.to_ascii_uppercase().contains("USERAUTH") {
            self.auth_started = true;
        }
        !self.auth_started
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn the_override_wins() {
        assert_eq!(map_error(&russh::Error::NotAuthenticated, Some(SshErrorCode::Cancelled)), SshErrorCode::Cancelled);
        assert_eq!(map_error(&russh::Error::UnknownKey, Some(SshErrorCode::HostKeyChanged)), SshErrorCode::HostKeyChanged);
        assert_eq!(map_error(&russh::Error::UnknownKey, None), SshErrorCode::Protocol);
    }

    #[test]
    fn maps_socket_and_protocol_errors() {
        let io = |k| russh::Error::IO(Error::from(k));
        assert_eq!(map_error(&io(ErrorKind::ConnectionRefused), None), SshErrorCode::Refused);
        assert_eq!(map_error(&io(ErrorKind::TimedOut), None), SshErrorCode::Timeout);
        assert_eq!(map_error(&io(ErrorKind::ConnectionReset), None), SshErrorCode::Reset);
        assert_eq!(map_error(&io(ErrorKind::HostUnreachable), None), SshErrorCode::Unreachable);
        assert_eq!(map_error(&russh::Error::KeepaliveTimeout, None), SshErrorCode::Timeout);
        assert_eq!(map_error(&russh::Error::KexInit, None), SshErrorCode::Protocol);
        assert_eq!(map_error(&russh::Error::NoAuthMethod, None), SshErrorCode::Auth);
        assert_eq!(map_error(&russh::Error::Disconnect, None), SshErrorCode::Unknown);
        assert_eq!(io_code(&Error::other("failed to lookup address information")), SshErrorCode::Dns);
    }

    #[test]
    fn drops_every_debug_line_from_user_authentication_on() {
        let mut f = DebugFilter::default();
        assert!(f.keep("Handshake: KEX method: curve25519-sha256"));
        assert!(!f.keep("Outbound: Sending USERAUTH_REQUEST (none)"));
        assert!(!f.keep("Inbound: CHANNEL_DATA"));
    }
}
