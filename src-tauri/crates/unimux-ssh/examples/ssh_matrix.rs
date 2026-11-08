//! S4: the real login core (`unimux_ssh::login::login`, the 1.1.4 offer, SshLogin's auth order, the step timers) against
//! the SP7 Docker servers, driven by scripts/ssh-matrix.mjs (CI job `ssh-matrix`).
//!
//! `ssh_matrix @cases.json` prints one JSON line per case. Case: `{id, host, port, user, keyFile?, passphrase?, password?,
//! allowPasswordPrompt?, promptPassword?, answers?: [..], exec?}`. The host key is accepted once; a password question is
//! answered with `promptPassword` (cancelled when absent), a keyboard-interactive question with `answers` (one empty answer
//! per field when absent). Result: `{id, ok, code?, methods: ["-> none", ..., "-> false"], hostKey?, prompts, exec?}`.
//! Credentials are never printed.

use std::sync::Arc;

use parking_lot::Mutex;
use russh::ChannelMsg;
use serde_json::{Value, json};
use unimux_ssh::login::{LOGIN_TIMERS, LoginControl, LoginEvents, LoginRequest, login};
use unimux_ssh::protocol::{AuthPromptInfo, AuthPromptKind};
use unimux_ssh::session::SshPhase;
use zeroize::Zeroizing;

struct Events {
    control: Arc<LoginControl>,
    prompt_password: Option<String>,
    answers: Option<Vec<String>>,
    methods: Mutex<Vec<String>>,
    host_key: Mutex<Option<String>>,
    prompts: Mutex<Vec<&'static str>>,
}

impl LoginEvents for Events {
    fn phase(&self, _: SshPhase) {}
    fn banner(&self, _: &str) {}
    fn host_key(&self, prompt_id: &str, key_base64: &str) {
        *self.host_key.lock() = Some(key_base64.to_string());
        self.control.answer_host_key(prompt_id, true, None);
    }
    fn auth_prompt(&self, prompt_id: &str, prompt: &AuthPromptInfo) {
        let values = match prompt.kind {
            AuthPromptKind::Password => {
                self.prompts.lock().push("password");
                self.prompt_password.clone().map(|p| vec![Zeroizing::new(p)])
            }
            _ => {
                self.prompts.lock().push("keyboard");
                Some(match &self.answers {
                    Some(a) => a.iter().map(|s| Zeroizing::new(s.clone())).collect(),
                    None => prompt.fields.iter().map(|_| Zeroizing::new(String::new())).collect(),
                })
            }
        };
        self.control.answer_auth(prompt_id, values);
    }
    fn auth_method(&self, method: &str) {
        self.methods.lock().push(format!("-> {method}"));
    }
}

fn text(case: &Value, key: &str) -> Option<String> {
    case.get(key).and_then(Value::as_str).map(str::to_string)
}

async fn run(case: Value) -> Value {
    let id = case.get("id").cloned().unwrap_or(Value::Null);
    let private_key = match text(&case, "keyFile") {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(t) => Some(Zeroizing::new(t)),
            Err(e) => return json!({ "id": id, "ok": false, "error": format!("key file: {e}") }),
        },
        None => None,
    };
    let req = LoginRequest {
        host: text(&case, "host").unwrap_or_else(|| "127.0.0.1".into()),
        port: case.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).unwrap_or(22),
        username: text(&case, "user").unwrap_or_default(),
        private_key,
        passphrase: text(&case, "passphrase").map(Zeroizing::new),
        password: text(&case, "password").map(Zeroizing::new),
        allow_password_prompt: case.get("allowPasswordPrompt").and_then(Value::as_bool).unwrap_or(false),
        debug: false,
    };
    let control = LoginControl::new();
    let events = Arc::new(Events {
        control: control.clone(),
        prompt_password: text(&case, "promptPassword"),
        answers: case
            .get("answers")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()),
        methods: Mutex::new(Vec::new()),
        host_key: Mutex::new(None),
        prompts: Mutex::new(Vec::new()),
    });
    let r = login(req, LOGIN_TIMERS, events.clone(), control).await;
    let mut out = json!({
        "id": id,
        "ok": r.is_ok(),
        "methods": *events.methods.lock(),
        "hostKey": *events.host_key.lock(),
        "prompts": *events.prompts.lock(),
    });
    match r {
        Err(code) => out["code"] = json!(code.as_str()),
        Ok(handle) => {
            if let Some(command) = text(&case, "exec") {
                out["exec"] = exec(&handle, &command).await;
            }
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        }
    }
    out
}

async fn exec(handle: &unimux_ssh::login::LoginHandle, command: &str) -> Value {
    let Ok(mut ch) = handle.channel_open_session().await else { return json!({ "error": "channel" }) };
    if ch.exec(true, command).await.is_err() {
        return json!({ "error": "exec" });
    }
    let (mut stdout, mut status) = (Vec::new(), None);
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            _ => {}
        }
    }
    json!({ "stdout": String::from_utf8_lossy(&stdout), "exitStatus": status })
}

#[tokio::main]
async fn main() {
    let mut arg = std::env::args().nth(1).unwrap_or_default();
    if let Some(path) = arg.strip_prefix('@') {
        arg = std::fs::read_to_string(path).unwrap_or_default();
    }
    let cases: Value = serde_json::from_str(&arg).unwrap_or_else(|e| {
        eprintln!("bad cases: {e}");
        std::process::exit(2)
    });
    let list = if let Value::Array(a) = cases { a } else { vec![cases] };
    for case in list {
        println!("{}", run(case).await);
    }
}
