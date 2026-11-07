//! The algorithms the client offers: exactly 1.1.4's (ssh2 1.17 defaults under Electron 45, SP7 `ssh2_preferred()`), never
//! russh's `Preferred::DEFAULT` (no ecdh-sha2-* and no SHA-1 MACs: OpenSSH 5.x / 6.x fail). No SHA-1 kex and no CBC, which
//! 1.1.4 does not offer either.

use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

use russh::keys::{Algorithm, EcdsaCurve, HashAlg};
use russh::{Preferred, cipher, client, compression, kex, mac};

/// 1.1.4's offer, in ssh2's order, plus the ext-info-c / kex-strict-c markers ssh2 also sends (BoringSSL: no
/// chacha20-poly1305).
pub fn ssh2_preferred() -> Preferred {
    Preferred {
        kex: Cow::Owned(vec![
            kex::CURVE25519_PRE_RFC_8731,
            kex::CURVE25519,
            kex::ECDH_SHA2_NISTP256,
            kex::ECDH_SHA2_NISTP384,
            kex::ECDH_SHA2_NISTP521,
            kex::DH_GEX_SHA256,
            kex::DH_G14_SHA256,
            kex::DH_G15_SHA512,
            kex::DH_G16_SHA512,
            kex::DH_G17_SHA512,
            kex::DH_G18_SHA512,
            kex::EXTENSION_SUPPORT_AS_CLIENT,
            kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
        ]),
        key: Cow::Owned(vec![
            Algorithm::Ed25519,
            Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
            Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
            Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 },
            Algorithm::Rsa { hash: Some(HashAlg::Sha512) },
            Algorithm::Rsa { hash: Some(HashAlg::Sha256) },
            Algorithm::Rsa { hash: None },
        ]),
        host_key_certificates: Cow::Borrowed(&[]),
        cipher: Cow::Owned(vec![
            cipher::AES_128_GCM,
            cipher::AES_256_GCM,
            cipher::AES_128_CTR,
            cipher::AES_192_CTR,
            cipher::AES_256_CTR,
        ]),
        mac: Cow::Owned(vec![
            mac::HMAC_SHA256_ETM,
            mac::HMAC_SHA512_ETM,
            mac::HMAC_SHA1_ETM,
            mac::HMAC_SHA256,
            mac::HMAC_SHA512,
            mac::HMAC_SHA1,
        ]),
        compression: Cow::Owned(vec![compression::NONE, compression::ZLIB_LEGACY, compression::ZLIB]),
    }
}

/// The client configuration of every login: the 1.1.4 offer, keepalive every `keepalive` with `keepalive_max` unanswered
/// probes allowed (ssh2 keepaliveInterval / keepaliveCountMax), no inactivity timeout (ssh2 has none), Nagle off (an
/// interactive session sends every keystroke at once, like OpenSSH's client).
pub fn client_config(keepalive: Duration, keepalive_max: usize) -> Arc<client::Config> {
    Arc::new(client::Config {
        preferred: ssh2_preferred(),
        keepalive_interval: Some(keepalive),
        keepalive_max,
        inactivity_timeout: None,
        nodelay: true,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_the_ssh2_lists_and_no_legacy_algorithms() {
        let p = ssh2_preferred();
        let kex: Vec<&str> = p.kex.iter().map(|k| k.as_ref()).collect();
        assert!(kex.contains(&"ecdh-sha2-nistp256"));
        assert!(!kex.iter().any(|k| k.ends_with("sha1")));
        let ciphers: Vec<&str> = p.cipher.iter().map(|c| c.as_ref()).collect();
        assert!(!ciphers.iter().any(|c| c.ends_with("-cbc")));
        assert!(!ciphers.contains(&"chacha20-poly1305@openssh.com"));
        let macs: Vec<&str> = p.mac.iter().map(|m| m.as_ref()).collect();
        assert!(macs.contains(&"hmac-sha1"));
        let c = client_config(Duration::from_secs(15), 3);
        assert_eq!(c.keepalive_interval, Some(Duration::from_secs(15)));
        assert_eq!(c.keepalive_max, 3);
        assert!(c.inactivity_timeout.is_none());
    }
}
