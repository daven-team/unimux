//! ssh2 1.17's `utils.parseKey` (lib/protocol/keyParser.js) as 1.1.4 runs it: which reader takes a text is decided by
//! ssh2's own regexes, ported as they are (anchored to the whole trimmed text, leftmost-first groups like the JS engine).
//! The readers behind them:
//!
//! - OpenSSH private keys: Node's lenient base64 of the captured body, then russh's `decode_openssh` (ssh-key, with
//!   3des-cbc through the `tdes` feature); chacha20-poly1305 key files are refused (Electron's BoringSSL has no
//!   chacha20, so ssh2 does not list the cipher), and so is every key type outside ssh2's private key switch (security
//!   keys `sk-*@openssh.com`, ...). ssh-key reads only files with one key: a key count of 0 (ssh2 returns no key) or
//!   more than 1 (ssh2 returns the first) goes through ssh2's own walk of the container, with ssh-key's KDF and
//!   ciphers, and only the first private entry is handed to ssh-key;
//! - traditional PEM: [`legacy_pem`](super::legacy_pem) for the DEK-Info part, then russh on the plain DER; EC keys with
//!   explicit curve parameters are refused like ssh2 does; a DSA key is checked with ssh2's own ASN.1 reads (version,
//!   p, q, g, y) and becomes an `ssh-dss` private key, which keys.ts refuses as unsupportedType;
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
use ssh_key::encoding::Decode;
use ssh_key::private::KeypairData;
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
    /// A private key ssh2 reads and 1.1.4 refuses in metaOf: a traditional PEM DSA key (`ssh-dss`).
    OtherPrivate {
        key_type: &'static str,
    },
    /// ssh2 returned `undefined` (an OpenSSH key file with a key count of 0): keys.ts answers notAKey.
    Nothing,
}

impl Loaded {
    /// ssh2's `getPublicSSH()`. Empty for [`Loaded::OtherPrivate`] (its `ssh-dss` blob never equals the blob of a key
    /// 1.1.4 accepts, the only use) and [`Loaded::Nothing`] (no key: keys.ts never gets that far).
    pub fn blob(&self) -> Vec<u8> {
        match self {
            Loaded::Private(k) => k.public_key().to_bytes().unwrap_or_default(),
            Loaded::Public { blob, .. } => blob.clone(),
            Loaded::OtherPrivate { .. } | Loaded::Nothing => Vec::new(),
        }
    }

    /// ssh2's `type`.
    pub fn key_type(&self) -> String {
        match self {
            Loaded::Private(k) => k.algorithm().as_str().to_string(),
            Loaded::Public { key_type, .. } => key_type.clone(),
            Loaded::OtherPrivate { key_type } => (*key_type).to_string(),
            Loaded::Nothing => String::new(),
        }
    }

    /// ssh2's `comment` (raw, before the metaOf rule). Invalid UTF-8 becomes U+FFFD like Node's `utf8Slice`.
    pub fn comment(&self) -> String {
        match self {
            Loaded::Private(k) => String::from_utf8_lossy(k.comment().as_bytes()).into_owned(),
            Loaded::Public { comment, .. } => comment.clone(),
            Loaded::OtherPrivate { .. } | Loaded::Nothing => String::new(),
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

/// The key types of ssh2's `parseOpenSSHPrivKeys` switch; any other one is "Unsupported OpenSSH private key type".
const SSH2_PRIVATE_TYPES: [&str; 6] =
    ["ssh-rsa", "ssh-dss", "ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"];

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
    // The key count after the cipher name, the KDF name and the KDF options. ssh-key reads only one-key files.
    let count =
        skip_fields(&data, magic, 3).and_then(|at| data.get(at..at + 4)).map(|n| u32::from_be_bytes([n[0], n[1], n[2], n[3]]));
    if count.is_some_and(|n| n != 1) {
        return std::panic::catch_unwind(|| openssh_container(&data, pass))
            .unwrap_or(Err(Fail::Other("Malformed OpenSSH private key")));
    }
    let key = match std::panic::catch_unwind(|| russh::keys::decode_openssh(&data, pass)) {
        Ok(Ok(k)) => k,
        Ok(Err(russh::keys::Error::KeyIsEncrypted)) => return Err(Fail::NoPassphrase),
        _ => return Err(Fail::Other("Malformed OpenSSH private key")),
    };
    // ssh2 decrypts first and refuses the type while reading the private entry.
    if !SSH2_PRIVATE_TYPES.contains(&key.algorithm().as_str()) {
        return Err(Fail::Other("Unsupported OpenSSH private key type"));
    }
    Ok(Loaded::Private(Box::new(key)))
}

/// ssh2's `OpenSSH_Private.parse` and `parseOpenSSHPrivKeys` for a file whose key count is not 1, in ssh2's order: the
/// cipher / KDF header rules, the bcrypt KDF and the cipher (ssh-key's), every public entry, every private entry walked
/// by ssh2's per-type layout, the padding; then ssh2's `ret[0]`: no key for a count of 0, else the first private entry
/// (read by ssh-key, its public key derived from it like ssh2 does).
fn openssh_container(data: &[u8], pass: Option<&str>) -> Result<Loaded, Fail> {
    const MALFORMED: Fail = Fail::Other("Malformed OpenSSH private key");
    let (cipher_name, pos) = read_string(data, 15).ok_or(MALFORMED)?;
    let cipher = match cipher_name {
        b"none" => None,
        name => Some(
            std::str::from_utf8(name)
                .ok()
                .and_then(|n| ssh_key::Cipher::new(n).ok())
                .ok_or(Fail::Other("Unsupported cipher for OpenSSH key"))?,
        ),
    };
    let (kdf_name, pos) = read_string(data, pos).ok_or(MALFORMED)?;
    if kdf_name != b"none" {
        if cipher.is_none() {
            return Err(MALFORMED);
        }
        if kdf_name != b"bcrypt" {
            return Err(Fail::Other("Unsupported kdf name for OpenSSH key"));
        }
        if pass.is_none() {
            return Err(Fail::NoPassphrase);
        }
    } else if cipher.is_some() {
        return Err(MALFORMED);
    }
    let (kdf_options, mut pos) = read_string(data, pos).ok_or(MALFORMED)?;
    let mut decrypt = None;
    if !kdf_options.is_empty() {
        if kdf_name == b"none" {
            return Err(MALFORMED);
        }
        let (salt, at) = read_string(kdf_options, 0).ok_or(MALFORMED)?;
        let rounds = kdf_options.get(at..at + 4).ok_or(MALFORMED)?;
        let kdf = ssh_key::Kdf::Bcrypt {
            salt: salt.to_vec(),
            rounds: u32::from_be_bytes([rounds[0], rounds[1], rounds[2], rounds[3]]),
        };
        let cipher = cipher.ok_or(MALFORMED)?;
        // bcrypt_pbkdf fails on an empty passphrase, salt or 0 rounds in both implementations.
        let (key, iv) = kdf
            .derive_key_and_iv(cipher, pass.unwrap_or_default())
            .map_err(|_| Fail::Other("Failed to generate information to decrypt key"))?;
        decrypt = Some((cipher, key, iv));
    } else if kdf_name != b"none" {
        return Err(MALFORMED);
    }
    if pos + 3 >= data.len() {
        return Err(MALFORMED);
    }
    let count = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
    pos += 4;
    if count == 0 {
        return Ok(Loaded::Nothing);
    }
    for _ in 0..count {
        let (public, at) = read_string(data, pos).ok_or(MALFORMED)?;
        read_string(public, 0).ok_or(MALFORMED)?;
        pos = at;
    }
    let (blob, at) = read_string(data, pos).ok_or(MALFORMED)?;
    pos = at;
    let mut private = Zeroizing::new(blob.to_vec());
    if let Some((cipher, key, iv)) = decrypt {
        let block = cipher.block_size();
        if private.len() < block || !private.len().is_multiple_of(block) {
            return Err(MALFORMED);
        }
        let tag = if cipher.has_tag() {
            let tag = data.get(pos..pos + 16).ok_or(MALFORMED)?;
            pos += 16;
            Some(ssh_key::cipher::Tag::try_from(tag).map_err(|_| MALFORMED)?)
        } else {
            None
        };
        cipher.decrypt(&key, &iv, &mut private, tag).map_err(|_| Fail::Other("bad decrypt"))?;
    }
    if pos != data.len() {
        return Err(MALFORMED);
    }
    // parseOpenSSHPrivKeys.
    let p = &private[..];
    if p.len() < 8 {
        return Err(MALFORMED);
    }
    if p[..4] != p[4..8] {
        return Err(Fail::Other("OpenSSH key integrity check failed"));
    }
    let mut pos = 8;
    let mut first = None;
    for i in 0..count {
        let start = pos;
        let (key_type, at) = read_string(p, pos).ok_or(MALFORMED)?;
        let fields_end = match key_type {
            b"ssh-rsa" => skip_fields(p, at, 6),
            b"ssh-dss" => skip_fields(p, at, 5),
            b"ssh-ed25519" => read_string(p, at)
                .filter(|(public, _)| public.len() == 32)
                .and_then(|(_, at)| read_string(p, at))
                .filter(|(private, _)| private.len() == 64)
                .map(|(_, end)| end),
            b"ecdsa-sha2-nistp256" | b"ecdsa-sha2-nistp384" | b"ecdsa-sha2-nistp521" => skip_fields(p, at, 3),
            _ => return Err(Fail::Other("Unsupported OpenSSH private key type")),
        }
        .ok_or(MALFORMED)?;
        let (comment, end) = read_string(p, fields_end).ok_or(MALFORMED)?;
        if i == 0 {
            first = Some((start..fields_end, comment));
        }
        pos = end;
    }
    // The padding 1, 2, 3, ... (counted modulo 255), any length.
    if p[pos..].iter().zip(1u32..).any(|(&b, n)| u32::from(b) != n % 255) {
        return Err(MALFORMED);
    }
    let (range, comment) = first.ok_or(MALFORMED)?;
    let key_data = KeypairData::decode(&mut &p[range]).map_err(|_| MALFORMED)?;
    let key = PrivateKey::new(key_data, comment.to_vec()).map_err(|_| MALFORMED)?;
    Ok(Loaded::Private(Box::new(key)))
}

fn old_private(label: &str, headers: &str, body: &str, pass: Option<&str>) -> Result<Loaded, Fail> {
    let pem = legacy_pem::read(label, headers, body, pass).map_err(|e| match e {
        legacy_pem::Error::NoPassphrase => Fail::NoPassphrase,
        _ => Fail::Other("Malformed OpenSSH private key"),
    })?;
    if pem.label == "EC" && legacy_pem::ec_explicit_curve(&pem.der) {
        return Err(Fail::Other("Unsupported private key EC OID"));
    }
    // ssh2 reads a DSA key itself (no OpenSSL): it is an ssh-dss private key whenever its ASN.1 reads succeed.
    if pem.label == "DSA" {
        return if ssh2_dsa_reads(&pem.der) {
            Ok(Loaded::OtherPrivate { key_type: "ssh-dss" })
        } else {
            Err(Fail::Other("Malformed OpenSSH private key. Bad passphrase?"))
        };
    }
    // The plain DER never needs a passphrase: russh must not try to decrypt it.
    russh_secret(&legacy_pem::armor(&pem), None)
        .map(|k| Loaded::Private(Box::new(k)))
        .map_err(|_| Fail::Other("Malformed OpenSSH private key"))
}

/// The reads of asn1 0.2.6's `Ber.Reader` that ssh2's OpenSSH_Old_Private makes on a DSA key: `readSequence()` (no tag
/// check, its length not enforced), `readInt()` (the version; its value is unused, so a null only reads nothing), then
/// `readString(Ber.Integer, true)` for p, q, g and y. True when none of them throws or returns null. Lengths are the
/// reader's 32-bit JS integers; an index outside the data reads as 0 (`undefined & 0xff`).
fn ssh2_dsa_reads(der: &[u8]) -> bool {
    struct Ber<'a> {
        buf: &'a [u8],
        off: i64,
        len: i64,
    }
    impl Ber<'_> {
        fn size(&self) -> i64 {
            self.buf.len() as i64
        }
        fn at(&self, i: i64) -> u8 {
            usize::try_from(i).ok().and_then(|i| self.buf.get(i)).copied().unwrap_or(0)
        }
        fn peek(&self) -> Option<u8> {
            (self.size() - self.off >= 1).then(|| self.at(self.off))
        }
        /// `readLength(offset)`: Ok(None) for null, Err for a throw.
        fn read_length(&mut self, mut o: i64) -> Result<Option<i64>, ()> {
            if o >= self.size() {
                return Ok(None);
            }
            let first = self.at(o);
            o += 1;
            if first & 0x80 != 0 {
                let n = first & 0x7f;
                if n == 0 || n > 4 {
                    return Err(());
                }
                if self.size() - o < i64::from(n) {
                    return Ok(None);
                }
                let mut len: i32 = 0;
                for _ in 0..n {
                    len = len.wrapping_shl(8) | i32::from(self.at(o));
                    o += 1;
                }
                self.len = i64::from(len);
            } else {
                self.len = i64::from(first);
            }
            Ok(Some(o))
        }
        fn read_sequence(&mut self) -> Result<(), ()> {
            if self.peek().is_some()
                && let Some(o) = self.read_length(self.off + 1)?
            {
                self.off = o;
            }
            Ok(())
        }
        fn read_int(&mut self) -> Result<(), ()> {
            let Some(tag) = self.peek() else { return Ok(()) };
            if tag != 0x02 {
                return Err(());
            }
            let Some(o) = self.read_length(self.off + 1)? else { return Ok(()) };
            if self.len > 4 {
                return Err(());
            }
            if self.len > self.size() - o {
                return Ok(());
            }
            self.off = o + self.len.max(0);
            Ok(())
        }
        /// `readString(Ber.Integer, true)`: Ok(false) for null.
        fn read_integer(&mut self) -> Result<bool, ()> {
            let Some(tag) = self.peek() else { return Ok(false) };
            if tag != 0x02 {
                return Err(());
            }
            let Some(o) = self.read_length(self.off + 1)? else { return Ok(false) };
            if self.len > self.size() - o {
                return Ok(false);
            }
            self.off = o + self.len;
            Ok(true)
        }
    }
    let mut r = Ber { buf: der, off: 0, len: 0 };
    let mut reads = || -> Result<bool, ()> {
        r.read_sequence()?;
        r.read_int()?;
        for _ in 0..4 {
            if !r.read_integer()? {
                return Ok(false);
            }
        }
        Ok(true)
    };
    reads().unwrap_or(false)
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
            Ok(_) => panic!("not a public key"),
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
    fn dsa_keys_are_checked_with_the_asn1_reads_of_ssh2() {
        let ints = |n: u8| (0..n).flat_map(|i| [2, 1, i + 1]).collect::<Vec<u8>>();
        let seq = |body: Vec<u8>, len: u8| [vec![0x30, len], body].concat();
        // version, p, q, g, y.
        assert!(ssh2_dsa_reads(&seq(ints(5), 15)));
        // The SEQUENCE length is not enforced, and its tag is not checked.
        assert!(ssh2_dsa_reads(&seq(ints(5), 3)));
        assert!(ssh2_dsa_reads(&[vec![0x31, 15], ints(5)].concat()));
        // y missing (null), a non-INTEGER tag (throws), an indefinite length (throws), a version longer than 4 bytes.
        assert!(!ssh2_dsa_reads(&seq(ints(4), 12)));
        assert!(!ssh2_dsa_reads(&[vec![0x30, 15], ints(4), vec![4, 1, 1]].concat()));
        assert!(!ssh2_dsa_reads(&[vec![0x30, 0x80], ints(5)].concat()));
        assert!(!ssh2_dsa_reads(&[vec![0x30, 20, 2, 5, 0, 0, 0, 0, 0], ints(4)].concat()));
        // An empty version is read as nothing (readInt's value is unused).
        assert!(ssh2_dsa_reads(&[vec![0x30, 14, 2, 0], ints(4)].concat()));
        assert!(!ssh2_dsa_reads(&[]));
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
