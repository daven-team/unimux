//! SP7 probe: one russh 0.65.1 login against a test server, driven by scripts/sp7/matrix.mjs.
//!
//! `sp7_probe '<json spec>'` or `sp7_probe @spec.json` prints one JSON line per spec (a spec or a list of specs). Spec:
//! `{host, port, user, profile: "ssh2" | "russh" | "legacy", hostKeyAlgs?: [name], login?: {keyFile?, passphrase?, password?,
//!   allowPasswordPrompt?, promptPassword?, answers?: [..]}, exec?: "command", timeoutMs?}`. Without `login` the probe only
//!   connects (host key checks). With it, the methods follow 1.1.4's SshLogin order against the server's method lists
//!   (`AuthOrder`), so the sequence can be compared with ssh2's.
//! Result: `{ok, code?, error?, hostKey: {algorithm, type, base64}, names: {kex, hostKey, cipher, mac, compression}, banner?,
//!   methods: ["-> none", "-> password", ..., "-> false"], steps: [{method, success, remaining?, partial?, rsaHash?, prompts?}],
//!   exec?: {stdout, exitStatus}, ms: {connect, kex, auth, authenticated, total}}`. `code` is the SshErrorCode 1.1.4 maps the
//!   matching ssh2 error to (`error_code`).
//! Profiles: "russh" is `Preferred::DEFAULT`; "ssh2" mirrors what ssh2 1.17 offers under Electron 45 (the 1.1.4 offer, see
//! scripts/sp7/ssh2-defaults.cjs); "legacy" is "ssh2" plus the SHA-1 kex and the AES-CBC ciphers ssh2 supports but does not
//! offer by default.

use std::borrow::Cow;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{Algorithm, EcdsaCurve, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, decode_secret_key};
use russh::{ChannelMsg, Preferred, cipher, compression, kex, mac};
use serde_json::{Value, json};

/// 1.1.4's offer: ssh2 1.17 DEFAULT_* under Electron 45 (BoringSSL: no chacha20-poly1305), in ssh2's order, plus the
/// ext-info-c / kex-strict-c markers ssh2 also sends.
fn ssh2_preferred() -> Preferred {
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

fn legacy_preferred() -> Preferred {
    let mut p = ssh2_preferred();
    let mut k = p.kex.to_vec();
    let markers = k.split_off(k.len() - 2);
    k.extend([kex::DH_GEX_SHA1, kex::DH_G14_SHA1, kex::DH_G1_SHA1]);
    k.extend(markers);
    p.kex = Cow::Owned(k);
    let mut c = p.cipher.to_vec();
    c.extend([cipher::AES_256_CBC, cipher::AES_192_CBC, cipher::AES_128_CBC]);
    p.cipher = Cow::Owned(c);
    p
}

#[derive(Default)]
struct Seen {
    host_key: Option<Value>,
    names: Option<Value>,
    banner: Option<String>,
    kex_at: Option<Duration>,
}

struct Probe {
    seen: Arc<Mutex<Seen>>,
    start: Instant,
}

impl client::Handler for Probe {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        if let PublicKeyOrCertificate::PublicKey { key, .. } = key {
            let blob = key.to_bytes().unwrap_or_default();
            let ty = if blob.len() > 4 {
                let n = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
                String::from_utf8_lossy(&blob[4..(4 + n).min(blob.len())]).into_owned()
            } else {
                String::new()
            };
            self.seen.lock().unwrap().host_key =
                Some(json!({ "algorithm": key.algorithm().as_str(), "type": ty, "base64": STANDARD.encode(&blob) }));
        }
        Ok(true)
    }

    async fn kex_done(
        &mut self,
        _secret: Option<&[u8]>,
        names: &russh::Names,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let mut seen = self.seen.lock().unwrap();
        if seen.names.is_none() {
            seen.kex_at = Some(self.start.elapsed());
            seen.names = Some(json!({
                "kex": names.kex.as_ref(),
                "hostKey": names.key.to_string(),
                "cipher": names.cipher.as_ref(),
                "mac": names.client_mac.as_ref(),
                "compression": format!("{:?}", names.client_compression),
            }));
        }
        Ok(())
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<(), Self::Error> {
        self.seen.lock().unwrap().banner = Some(banner.to_string());
        Ok(())
    }
}

fn methods(m: &russh::MethodSet) -> Vec<String> {
    m.iter().map(String::from).collect()
}

/// The SshErrorCode 1.1.4's mapSshError (src/ptyhost/sshErrors.ts) gives the matching ssh2 / socket error; the S3 table.
fn error_code(e: &russh::Error) -> &'static str {
    use russh::Error as E;
    match e {
        E::IO(io) => io_code(io),
        E::ConnectionTimeout | E::KeepaliveTimeout | E::InactivityTimeout | E::Elapsed(_) => "timeout",
        // ssh2: level 'handshake' / 'protocol' or "no matching ..." -> protocol.
        E::NoCommonAlgo { .. }
        | E::KexInit
        | E::Kex
        | E::Version
        | E::UnknownAlgo
        | E::WrongServerSig
        | E::StrictKeyExchangeViolation { .. }
        | E::DecryptionError
        | E::PacketAuth
        | E::PacketSize(_)
        | E::Inconsistent => "protocol",
        // ssh2: level 'client-authentication' -> auth.
        E::NotAuthenticated | E::NoAuthMethod | E::UnsupportedAuthMethod => "auth",
        // ssh2 ends with 'close' and no error (mapSshError(undefined) -> unknown).
        _ => "unknown",
    }
}

fn io_code(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::ConnectionRefused => "refused",
        K::TimedOut => "timeout",
        K::HostUnreachable | K::NetworkUnreachable | K::NetworkDown => "unreachable",
        K::ConnectionReset | K::BrokenPipe | K::ConnectionAborted => "reset",
        // ENOTFOUND / EAI_AGAIN: getaddrinfo failures (WSAHOST_NOT_FOUND, WSATRY_AGAIN, WSANO_DATA on Windows).
        _ if matches!(e.raw_os_error(), Some(11001 | 11002 | 11004)) || e.to_string().contains("lookup") => "dns",
        _ => "unknown",
    }
}

/// The credentials of one login, the fields of 1.1.4's SshConnectRequest that SshLogin reads plus the prompt answers.
struct LoginSpec {
    key_file: Option<String>,
    passphrase: Option<String>,
    password: Option<String>,
    allow_password_prompt: bool,
    prompt_password: String,
    answers: Vec<String>,
}

impl LoginSpec {
    fn from(v: &Value) -> LoginSpec {
        let s = |k: &str| v[k].as_str().filter(|x| !x.is_empty()).map(String::from);
        LoginSpec {
            key_file: s("keyFile"),
            passphrase: s("passphrase"),
            password: s("password"),
            allow_password_prompt: v["allowPasswordPrompt"] == true,
            prompt_password: s("promptPassword").unwrap_or_default(),
            answers: v["answers"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default(),
        }
    }
}

enum Choice {
    None,
    PublicKey,
    SavedPassword,
    PromptPassword,
    Keyboard,
}

/// The method sequence of 1.1.4's SshLogin.nextAuth (src/sshcore/login.ts): the queued steps (publickey, then the saved
/// password) while the server allows them, then `none` before the server has named its methods, then the password prompt and
/// keyboard-interactive, 3 tries each, then give up. `methods` is None until the server answered a request.
struct AuthOrder {
    queue: Vec<Choice>,
    password_tries: u32,
    keyboard_tries: u32,
}

impl AuthOrder {
    fn new(spec: &LoginSpec) -> AuthOrder {
        let mut queue = Vec::new();
        if spec.key_file.is_some() {
            queue.push(Choice::PublicKey);
        }
        if spec.password.is_some() {
            queue.push(Choice::SavedPassword);
        }
        AuthOrder { queue, password_tries: 0, keyboard_tries: 0 }
    }

    fn next(&mut self, methods: Option<&[String]>, allow_password_prompt: bool) -> Option<Choice> {
        let has = |m: &str| methods.is_some_and(|ms| ms.iter().any(|x| x == m));
        let allows = |m: &str| methods.is_none() || has(m);
        while !self.queue.is_empty() {
            let step = self.queue.remove(0);
            match step {
                Choice::PublicKey if allows("publickey") => return Some(step),
                Choice::SavedPassword if allows("password") => return Some(step),
                _ => {}
            }
        }
        if methods.is_none() {
            return Some(Choice::None);
        }
        if has("password") && allow_password_prompt && self.password_tries < 3 {
            self.password_tries += 1;
            return Some(Choice::PromptPassword);
        }
        if has("keyboard-interactive") && self.keyboard_tries < 3 {
            self.keyboard_tries += 1;
            return Some(Choice::Keyboard);
        }
        None
    }
}

/// One keyboard-interactive exchange: every info request answered (an empty one with an empty list, like SshLogin).
async fn keyboard(
    handle: &mut client::Handle<Probe>,
    user: &str,
    answers: &[String],
    timeout: Duration,
    rec: &mut Value,
) -> Result<client::AuthResult, russh::Error> {
    let mut prompts = Vec::new();
    let mut r = tokio::time::timeout(timeout, handle.authenticate_keyboard_interactive_start(user, None)).await?;
    let mut rounds = 0;
    let result = loop {
        match r? {
            KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts: p } if rounds < 5 => {
                rounds += 1;
                prompts.push(json!({ "name": name, "instructions": instructions, "prompts": p.iter().map(|x| json!({ "prompt": x.prompt, "echo": x.echo })).collect::<Vec<_>>() }));
                let reply: Vec<String> = (0..p.len()).map(|i| answers.get(i).cloned().unwrap_or_default()).collect();
                r = tokio::time::timeout(timeout, handle.authenticate_keyboard_interactive_respond(reply)).await?;
            }
            KeyboardInteractiveAuthResponse::InfoRequest { .. } => break Err(russh::Error::Inconsistent),
            KeyboardInteractiveAuthResponse::Success => break Ok(client::AuthResult::Success),
            KeyboardInteractiveAuthResponse::Failure { remaining_methods, partial_success } => {
                break Ok(client::AuthResult::Failure { remaining_methods, partial_success });
            }
        }
    };
    rec["prompts"] = json!(prompts);
    result
}

async fn run(spec: Value) -> Value {
    let start = Instant::now();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mut preferred = match spec["profile"].as_str().unwrap_or("ssh2") {
        "russh" => Preferred::DEFAULT,
        "legacy" => legacy_preferred(),
        _ => ssh2_preferred(),
    };
    if let Some(algs) = spec["hostKeyAlgs"].as_array() {
        preferred.key = Cow::Owned(algs.iter().filter_map(|a| Algorithm::from_str(a.as_str()?).ok()).collect());
    }
    let config = Arc::new(client::Config {
        preferred,
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        inactivity_timeout: None,
        ..Default::default()
    });
    let host = spec["host"].as_str().unwrap_or("127.0.0.1").to_string();
    let port = spec["port"].as_u64().unwrap_or(22) as u16;
    let user = spec["user"].as_str().unwrap_or("sp7").to_string();
    let timeout = Duration::from_millis(spec["timeoutMs"].as_u64().unwrap_or(20_000));
    let probe = Probe { seen: seen.clone(), start };
    let mut out = json!({ "ok": false });
    let connected = tokio::time::timeout(timeout, client::connect(config, (host.as_str(), port), probe)).await;
    let connect_ms = start.elapsed().as_millis() as u64;
    let mut handle = match connected {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            out["code"] = json!(error_code(&e));
            return finish(out, &seen, json!({ "connect": connect_ms }), Some(format!("connect: {e}")));
        }
        Err(_) => {
            out["code"] = json!("timeout");
            return finish(out, &seen, json!({ "connect": connect_ms }), Some("connect: timeout".into()));
        }
    };
    let Some(login) = spec.get("login").map(LoginSpec::from) else {
        // Host key only: connected, no authentication.
        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        let kex_ms = seen.lock().unwrap().kex_at.map(|d| d.as_millis() as u64);
        out["ok"] = json!(true);
        return finish(out, &seen, json!({ "connect": connect_ms, "kex": kex_ms }), None);
    };
    let auth_start = Instant::now();
    let mut order = AuthOrder::new(&login);
    let mut server_methods: Option<Vec<String>> = None;
    let mut steps = Vec::new();
    let mut sent = Vec::new();
    let mut success = false;
    let mut error = None;
    let mut authenticated_ms = None;
    loop {
        let Some(choice) = order.next(server_methods.as_deref(), login.allow_password_prompt) else {
            // SshLogin's next(false): ssh2 then fails with "All configured authentication methods failed" (auth).
            sent.push("-> false".to_string());
            out["code"] = json!("auth");
            break;
        };
        let name = match choice {
            Choice::None => "none",
            Choice::PublicKey => "publickey",
            Choice::SavedPassword | Choice::PromptPassword => "password",
            Choice::Keyboard => "keyboard-interactive",
        };
        sent.push(format!("-> {name}"));
        let mut rec = json!({ "method": name });
        let res: Result<client::AuthResult, russh::Error> = match choice {
            Choice::None => {
                tokio::time::timeout(timeout, handle.authenticate_none(&user)).await.map_err(Into::into).and_then(|r| r)
            }
            Choice::SavedPassword | Choice::PromptPassword => {
                let pw = if matches!(choice, Choice::SavedPassword) {
                    login.password.clone().unwrap_or_default()
                } else {
                    login.prompt_password.clone()
                };
                tokio::time::timeout(timeout, handle.authenticate_password(&user, pw)).await.map_err(Into::into).and_then(|r| r)
            }
            Choice::PublicKey => {
                let text = std::fs::read_to_string(login.key_file.as_deref().unwrap_or("")).unwrap_or_default();
                match decode_secret_key(&text, login.passphrase.as_deref()) {
                    Ok(key) => {
                        let hash = if key.algorithm().is_rsa() {
                            let h = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
                            rec["rsaHash"] = json!(format!("{h:?}"));
                            h
                        } else {
                            None
                        };
                        tokio::time::timeout(
                            timeout,
                            handle.authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)),
                        )
                        .await
                        .map_err(Into::into)
                        .and_then(|r| r)
                    }
                    Err(e) => {
                        // 1.1.4 never gets here (the key was parsed when it was stored); the step is skipped.
                        rec["error"] = json!(format!("key: {e}"));
                        steps.push(rec);
                        continue;
                    }
                }
            }
            Choice::Keyboard => keyboard(&mut handle, &user, &login.answers, timeout, &mut rec).await,
        };
        match res {
            Ok(client::AuthResult::Success) => {
                rec["success"] = json!(true);
                steps.push(rec);
                success = true;
                authenticated_ms = Some(start.elapsed().as_millis() as u64);
                break;
            }
            Ok(client::AuthResult::Failure { remaining_methods, partial_success }) => {
                rec["success"] = json!(false);
                rec["remaining"] = json!(methods(&remaining_methods));
                rec["partial"] = json!(partial_success);
                server_methods = Some(methods(&remaining_methods));
                steps.push(rec);
            }
            Err(e) => {
                rec["success"] = json!(false);
                rec["error"] = json!(e.to_string());
                out["code"] = json!(error_code(&e));
                error = Some(format!("auth: {e}"));
                steps.push(rec);
                break;
            }
        }
    }
    let auth_ms = auth_start.elapsed().as_millis() as u64;
    out["steps"] = json!(steps);
    out["methods"] = json!(sent);
    out["authenticated"] = json!(success);
    if success && let Some(cmd) = spec["exec"].as_str() {
        let exec = async {
            let mut ch = handle.channel_open_session().await?;
            ch.exec(true, cmd).await?;
            let mut stdout = Vec::new();
            let mut status = None;
            while let Some(msg) = ch.wait().await {
                match msg {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                    _ => {}
                }
            }
            Ok::<_, russh::Error>(json!({ "stdout": String::from_utf8_lossy(&stdout), "exitStatus": status }))
        };
        out["exec"] = match tokio::time::timeout(timeout, exec).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => json!({ "error": e.to_string() }),
            Err(_) => json!({ "error": "timeout" }),
        };
    }
    let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    out["ok"] = json!(success && error.is_none());
    let kex_ms = seen.lock().unwrap().kex_at.map(|d| d.as_millis() as u64);
    // `authenticated`: from the start of the connect to the auth success, the point ssh2's 'ready' event marks (the timing
    // compares this one); `total` also holds the exec and the disconnect.
    finish(
        out,
        &seen,
        json!({ "connect": connect_ms, "kex": kex_ms, "auth": auth_ms, "authenticated": authenticated_ms, "total": start.elapsed().as_millis() as u64 }),
        error,
    )
}

fn finish(mut out: Value, seen: &Arc<Mutex<Seen>>, ms: Value, error: Option<String>) -> Value {
    let seen = seen.lock().unwrap();
    out["hostKey"] = seen.host_key.clone().unwrap_or(Value::Null);
    out["names"] = seen.names.clone().unwrap_or(Value::Null);
    if let Some(b) = &seen.banner {
        out["banner"] = json!(b);
    }
    out["ms"] = ms;
    if let Some(e) = error {
        out["error"] = json!(e);
    }
    out
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut arg = std::env::args().nth(1).unwrap_or_default();
    if let Some(path) = arg.strip_prefix('@') {
        arg = std::fs::read_to_string(path).unwrap_or_default();
    }
    let specs: Value = serde_json::from_str(&arg).unwrap_or_else(|e| {
        eprintln!("bad spec: {e}");
        std::process::exit(2)
    });
    // One spec or a list (one process for a whole server keeps the run short).
    let list = if let Value::Array(a) = specs { a } else { vec![specs] };
    for spec in list {
        println!("{}", run(spec).await);
    }
}
