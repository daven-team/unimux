//! ssh2 1.17's `utils.parseKey` (lib/protocol/keyParser.js) as 1.1.4 runs it: which reader takes a text is decided by
//! ssh2's own regexes, ported as they are (anchored to the whole trimmed text, leftmost-first groups like the JS engine).
//! The readers behind them:
//!
//! - OpenSSH private keys: Node's lenient base64 of the captured body, then russh's `decode_openssh` (ssh-key, with
//!   3des-cbc through the `tdes` feature); chacha20-poly1305 key files are refused (Electron's BoringSSL has no
//!   chacha20, so ssh2 does not list the cipher);
//! - traditional PEM: [`legacy_pem`](super::legacy_pem) for the DEK-Info part, then russh on the plain DER; EC keys with
//!   explicit curve parameters are refused like ssh2 does;
//! - PPK v2 (ssh-rsa / ssh-dss only, the regex): ssh-key's PPK reader on a canonical copy of the captured parts (Node's
//!   base64, the line counts ssh2 ignores), after ssh2's own MAC rules: the MAC is compared as lower-case hex text and an
//!   unencrypted file read with a passphrase fails (ssh2's MAC key includes it);
//! - public keys (an OpenSSH line or RFC 4716): read field by field like ssh2 (no point or modulus validation), so
//!   `publicKeyMatches` and `keyMetaFromPublic` see the same blobs.
//!
//! Nothing in PKCS#8 is read: ssh2 has no PKCS#8 reader, so such a text falls through to "Unsupported key format".

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use russh::keys::PrivateKey;
use zeroize::Zeroizing;

use super::js::{self, js_regex, js_trim, node_base64, utf16_len};
use super::legacy_pem;
use super::wire::{read_string, skip_fields, ssh_string};

/// What ssh2's parseKey returns when it does not return an Error.
pub enum Loaded {
    Private(Box<PrivateKey>),
    /// `isPrivateKey()` false. `key_type` is ssh2's `type` (with a `-cert-v0x@openssh.com` suffix for certificates).
    Public {
        key_type: String,
        blob: Vec<u8>,
        comment: String,
    },
}

impl Loaded {
    /// ssh2's `getPublicSSH()`.
    pub fn blob(&self) -> Vec<u8> {
        match self {
            Loaded::Private(k) => k.public_key().to_bytes().unwrap_or_default(),
            Loaded::Public { blob, .. } => blob.clone(),
        }
    }

    /// ssh2's `type`.
    pub fn key_type(&self) -> String {
        match self {
            Loaded::Private(k) => k.algorithm().as_str().to_string(),
            Loaded::Public { key_type, .. } => key_type.clone(),
        }
    }

    /// ssh2's `comment` (raw, before the metaOf rule). Invalid UTF-8 becomes U+FFFD like Node's `utf8Slice`.
    pub fn comment(&self) -> String {
        match self {
            Loaded::Private(k) => String::from_utf8_lossy(k.comment().as_bytes()).into_owned(),
            Loaded::Public { comment, .. } => comment.clone(),
        }
    }
}

/// Why parseKey returned an Error. keys.ts tells only "no passphrase given" apart from the rest.
#[derive(Debug, PartialEq, Eq)]
pub enum Fail {
    NoPassphrase,
    Other(&'static str),
}

static OPENSSH_PRIVATE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(r"^-----BEGIN OPENSSH PRIVATE KEY-----(?:\r\n|\n)([\s\S]+)(?:\r\n|\n)-----END OPENSSH PRIVATE KEY-----$")
});
static OLD_PRIVATE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"^-----BEGIN (RSA|DSA|EC) PRIVATE KEY-----(?:\r\n|\n)((?:[^:]+:\s*[\S].*(?:\r\n|\n))*)([\s\S]+)(?:\r\n|\n)-----END (RSA|DSA|EC) PRIVATE KEY-----$",
    )
});
static PPK_PRIVATE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"^PuTTY-User-Key-File-2: (ssh-(?:rsa|dss))\r?\nEncryption: (aes256-cbc|none)\r?\nComment: ([^\r\n]*)\r?\nPublic-Lines: \d+\r?\n([\s\S]+?)\r?\nPrivate-Lines: \d+\r?\n([\s\S]+?)\r?\nPrivate-MAC: ([^\r\n]+)",
    )
});
static OPENSSH_PUBLIC: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"^(((?:ssh-(?:rsa|dss|ed25519))|ecdsa-sha2-nistp(?:256|384|521))(?:-cert-v0[01]@openssh.com)?) ([A-Z0-9a-z/+=]+)(?:$|\s+([\S].*)?)$",
    )
});
/// RFC4716_Public's RE_HEADER without its `^` (the line starts of the `m` flag are found by hand).
static RFC4716_HEADER: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^([\x21-\x39\x3B-\x7E]{1,64}): ((?:[^\\]*\\\r?\n)*[^\r\n]+)\r?\n"));
static RFC4716_HEADER_ENDS: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\\\r?\n"));

/// ssh2's `parseKey(data, passphrase)` for a string. `pass` is what 1.1.4 hands over: `Some("")` is a passphrase to ssh2
/// (an empty Buffer is truthy there).
pub fn parse_key(text: &str, pass: Option<&str>) -> Result<Loaded, Fail> {
    let s = js_trim(text);
    if let Some(m) = OPENSSH_PRIVATE.captures(s) {
        return openssh_private(&m[1], pass);
    }
    if let Some(m) = OLD_PRIVATE.captures(s) {
        return old_private(&m[1], m.get(2).map_or("", |g| g.as_str()), &m[3], pass);
    }
    if let Some(m) = PPK_PRIVATE.captures(s) {
        return ppk_private(&m, pass);
    }
    if let Some(m) = OPENSSH_PUBLIC.captures(s) {
        return openssh_public(&m[1], &m[2], &m[3], m.get(4).map_or("", |g| g.as_str()));
    }
    if let Some(r) = rfc4716_public(s) {
        return r;
    }
    Err(Fail::Other("Unsupported key format"))
}

fn russh_secret(text: &str, pass: Option<&str>) -> Result<PrivateKey, Fail> {
    match std::panic::catch_unwind(|| russh::keys::decode_secret_key(text, pass)) {
        Ok(Ok(k)) => Ok(k),
        Ok(Err(russh::keys::Error::KeyIsEncrypted)) => Err(Fail::NoPassphrase),
        _ => Err(Fail::Other("key reader")),
    }
}

fn openssh_private(body: &str, pass: Option<&str>) -> Result<Loaded, Fail> {
    let data = Zeroizing::new(node_base64(body));
    let magic = b"openssh-key-v1\0".len();
    if data.len() < 31 || &data[..magic] != b"openssh-key-v1\0" {
        return Err(Fail::Other("Malformed OpenSSH private key"));
    }
    // ssh2 lists the ciphers Electron's crypto has; BoringSSL has no chacha20.
    if read_string(&data, magic).is_some_and(|(name, _)| name == b"chacha20-poly1305@openssh.com") {
        return Err(Fail::Other("Unsupported cipher for OpenSSH key"));
    }
    match std::panic::catch_unwind(|| russh::keys::decode_openssh(&data, pass)) {
        Ok(Ok(k)) => Ok(Loaded::Private(Box::new(k))),
        Ok(Err(russh::keys::Error::KeyIsEncrypted)) => Err(Fail::NoPassphrase),
        _ => Err(Fail::Other("Malformed OpenSSH private key")),
    }
}

fn old_private(label: &str, headers: &str, body: &str, pass: Option<&str>) -> Result<Loaded, Fail> {
    let pem = legacy_pem::read(label, headers, body, pass).map_err(|e| match e {
        legacy_pem::Error::NoPassphrase => Fail::NoPassphrase,
        _ => Fail::Other("Malformed OpenSSH private key"),
    })?;
    if pem.label == "EC" && legacy_pem::ec_explicit_curve(&pem.der) {
        return Err(Fail::Other("Unsupported private key EC OID"));
    }
    // The plain DER never needs a passphrase: russh must not try to decrypt it.
    russh_secret(&legacy_pem::armor(&pem), None)
        .map(|k| Loaded::Private(Box::new(k)))
        .map_err(|_| Fail::Other("Malformed OpenSSH private key"))
}

fn ppk_private(m: &regex::Captures<'_>, pass: Option<&str>) -> Result<Loaded, Fail> {
    let (key_type, cipher, comment, mac) = (&m[1], &m[2], &m[3], &m[6]);
    let encrypted = cipher != "none";
    let pass = match (encrypted, pass) {
        (true, None) => return Err(Fail::NoPassphrase),
        // ssh2's MAC key is SHA-1("putty-private-key-file-mac-key" + passphrase): only an empty one matches an unencrypted file.
        (false, Some(p)) if !p.is_empty() => return Err(Fail::Other("PPK private key integrity check failed")),
        (false, _) => None,
        (true, p) => p,
    };
    // ssh2 compares the MAC with its lower-case hex digest as text.
    if mac.len() != 40 || !mac.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(Fail::Other("PPK private key integrity check failed"));
    }
    let public = STANDARD.encode(node_base64(&m[4]));
    let private = Zeroizing::new(STANDARD.encode(Zeroizing::new(node_base64(&m[5]))));
    let canonical = Zeroizing::new(format!(
        "PuTTY-User-Key-File-2: {key_type}\nEncryption: {cipher}\nComment: {comment}\nPublic-Lines: 1\n{public}\nPrivate-Lines: 1\n{}\nPrivate-MAC: {mac}\n",
        *private
    ));
    match std::panic::catch_unwind(|| PrivateKey::from_ppk(&canonical, pass.map(str::to_string))) {
        Ok(Ok(k)) => Ok(Loaded::Private(Box::new(k))),
        _ => Err(Fail::Other("PPK private key integrity check failed")),
    }
}

/// ssh2's `OpenSSH_Public.parse` + `parseDER`: the blob is rebuilt from the fields that follow the type.
fn openssh_public(full_type: &str, base_type: &str, b64: &str, comment: &str) -> Result<Loaded, Fail> {
    const MALFORMED: Fail = Fail::Other("Malformed OpenSSH public key");
    let data = node_base64(b64);
    let (ty, pos) = read_string(&data, 0).ok_or(MALFORMED)?;
    if !String::from_utf8_lossy(ty).starts_with(base_type) {
        return Err(MALFORMED);
    }
    let field = |at: usize| read_string(&data, at).ok_or(MALFORMED);
    let blob = match base_type {
        "ssh-rsa" => {
            let (e, at) = field(pos)?;
            let (n, _) = field(at)?;
            [ssh_string(b"ssh-rsa"), ssh_string(e), ssh_string(n)].concat()
        }
        "ssh-dss" => {
            let (p, at) = field(pos)?;
            let (q, at) = field(at)?;
            let (g, at) = field(at)?;
            let (y, _) = field(at)?;
            [ssh_string(b"ssh-dss"), ssh_string(p), ssh_string(q), ssh_string(g), ssh_string(y)].concat()
        }
        "ssh-ed25519" => {
            let (pk, _) = field(pos)?;
            if pk.len() != 32 {
                return Err(MALFORMED);
            }
            [ssh_string(b"ssh-ed25519"), ssh_string(pk)].concat()
        }
        _ => {
            let curve = &base_type["ecdsa-sha2-".len()..];
            let at = skip_fields(&data, pos, 1).ok_or(MALFORMED)?;
            let (q, _) = field(at)?;
            [ssh_string(base_type.as_bytes()), ssh_string(curve.as_bytes()), ssh_string(q)].concat()
        }
    };
    Ok(Loaded::Public { key_type: full_type.to_string(), blob, comment: comment.to_string() })
}

/// ssh2's `RFC4716_Public.parse`: None when the outer regex does not match.
fn rfc4716_public(s: &str) -> Option<Result<Loaded, Fail>> {
    const MALFORMED: Fail = Fail::Other("Malformed RFC4716 public key");
    // /^---- BEGIN SSH2 PUBLIC KEY ----(?:\r?\n)((?:.{0,72}\r?\n)+)---- END SSH2 PUBLIC KEY ----$/, with `.{0,72}`
    // counted in UTF-16 units like JS.
    let rest = s.strip_prefix("---- BEGIN SSH2 PUBLIC KEY ----")?;
    let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n'))?;
    let body = rest.strip_suffix("---- END SSH2 PUBLIC KEY ----")?;
    let lines = body.strip_suffix('\n')?;
    let line_ok = |l: &str| {
        let l = l.strip_suffix('\r').unwrap_or(l);
        !l.chars().any(js::is_line_terminator) && utf16_len(l) <= 72
    };
    if !lines.split('\n').all(line_ok) {
        return None;
    }
    let mut data_start = 0;
    let mut comment = String::new();
    let mut last_index = 0;
    // RE_HEADER with the g and m flags: the next match at a line start at or after lastIndex.
    'scan: while last_index <= body.len() {
        let mut at = last_index;
        loop {
            let line_start = at == 0 || body[..at].chars().next_back().is_some_and(js::is_line_terminator);
            if line_start && let Some(m) = RFC4716_HEADER.captures(&body[at..]) {
                let value = RFC4716_HEADER_ENDS.replace_all(&m[2], "");
                if utf16_len(&value) > 1024 {
                    return Some(Err(MALFORMED));
                }
                last_index = at + m[0].len();
                data_start = last_index;
                if m[1].to_lowercase() == "comment" {
                    comment = value.into_owned();
                    if comment.len() > 1 && comment.starts_with('"') && comment.ends_with('"') {
                        comment = comment[1..comment.len() - 1].to_string();
                    }
                }
                continue 'scan;
            }
            match body[at..].chars().next() {
                Some(c) => at += c.len_utf8(),
                None => break 'scan,
            }
        }
    }
    let data = &body[data_start..];
    if data.is_empty() || !data.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'+' | b'=' | b'\r' | b'\n')) {
        return Some(Err(MALFORMED));
    }
    let data = node_base64(data);
    let Some((ty, mut pos)) = read_string(&data, 0) else { return Some(Err(MALFORMED)) };
    let count = match ty {
        b"ssh-rsa" => 2,
        b"ssh-dss" => 4,
        _ => return Some(Err(MALFORMED)),
    };
    let mut blob = ssh_string(ty);
    for _ in 0..count {
        let Some((f, end)) = read_string(&data, pos) else { return Some(Err(MALFORMED)) };
        blob.extend(ssh_string(f));
        pos = end;
    }
    let key_type = String::from_utf8_lossy(ty).into_owned();
    Some(Ok(Loaded::Public { key_type, blob, comment }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public(text: &str) -> (String, Vec<u8>, String) {
        match parse_key(text, None) {
            Ok(Loaded::Public { key_type, blob, comment }) => (key_type, blob, comment),
            Ok(Loaded::Private(_)) => panic!("private"),
            Err(e) => panic!("{e:?}"),
        }
    }

    const ED: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIBDKHaAaWG3OfcuAq+8u4pXKGs9AeyZjCyNuWwcCzLEz";

    #[test]
    fn openssh_public_lines_follow_the_ssh2_regex() {
        let blob = node_base64(ED);
        assert_eq!(public(&format!("ssh-ed25519 {ED}")), ("ssh-ed25519".into(), blob.clone(), String::new()));
        assert_eq!(public(&format!("ssh-ed25519 {ED} me@host  x")).2, "me@host  x");
        // `\s+` crosses a line end, `.` does not.
        assert_eq!(public(&format!("ssh-ed25519 {ED}\nnext")).2, "next");
        assert_eq!(parse_key(&format!("ssh-ed25519 {ED} a\nb"), None).err(), Some(Fail::Other("Unsupported key format")));
        // The type inside the blob must start with the one in the text.
        assert_eq!(parse_key(&format!("ssh-rsa {ED}"), None).err(), Some(Fail::Other("Malformed OpenSSH public key")));
    }

    #[test]
    fn rfc4716_keys_are_read_with_their_headers() {
        let rsa = [ssh_string(b"ssh-rsa"), ssh_string(&[1, 0, 1]), ssh_string(&[0, 0xc1, 2, 3])].concat();
        let b64 = STANDARD.encode(&rsa);
        let text = format!(
            "---- BEGIN SSH2 PUBLIC KEY ----\nComment: \"two \\\nlines\"\nx-other: y\n{b64}\n---- END SSH2 PUBLIC KEY ----"
        );
        assert_eq!(public(&text), ("ssh-rsa".into(), rsa, "two lines".into()));
        let long = format!("---- BEGIN SSH2 PUBLIC KEY ----\n{}\n---- END SSH2 PUBLIC KEY ----", "\u{1F600}".repeat(37));
        assert_eq!(parse_key(&long, None).err(), Some(Fail::Other("Unsupported key format")));
        let ed = format!("---- BEGIN SSH2 PUBLIC KEY ----\n{ED}\n---- END SSH2 PUBLIC KEY ----");
        assert_eq!(parse_key(&ed, None).err(), Some(Fail::Other("Malformed RFC4716 public key")));
    }

    #[test]
    fn private_key_regexes_are_anchored_to_the_whole_text() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";
        assert!(OLD_PRIVATE.is_match(pem));
        assert!(!OLD_PRIVATE.is_match(&format!("x\n{pem}")));
        assert!(!OLD_PRIVATE.is_match(&format!("{pem}\nx")));
        let m = OLD_PRIVATE
            .captures(
                "-----BEGIN EC PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: A,B\n\nAAAA\n-----END RSA PRIVATE KEY-----",
            )
            .unwrap();
        assert_eq!((&m[1], &m[2], &m[3]), ("EC", "Proc-Type: 4,ENCRYPTED\nDEK-Info: A,B\n", "\nAAAA"));
    }
}
