//! The messages between the SshCoordinator (main side) and the owners of SSH connections (SSH cells P5, SFTP sessions T1,
//! DB tunnels D2): 1.1.4's `MainToHost` (`sshConnect`, `sshHostKeyAnswer`, `sshAuthAnswer`) and `HostToMain` (`sshStatus`,
//! `sshHostKey`, `sshAuthPrompt`, `exit`) of src/shared/ipc.ts, now in one process. Secrets travel only in
//! [`ConnectRequest`] (zeroized when dropped) and in auth answers; nothing here is logged.

use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

use crate::session::{SshErrorCode, SshPhase};

/// `sftpSudo` of a connect (0.9.9): the SFTP server runs through sudo, optionally with the host's own command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SftpSudo {
    pub command: Option<String>,
}

/// `SshConnectRequest`: everything one login needs. `startup` already went through `startupInput`.
#[derive(Clone)]
pub struct ConnectRequest {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub cols: u32,
    pub rows: u32,
    /// Private key text exactly as stored (OpenSSH, PEM or PPK v2).
    pub private_key: Option<Zeroizing<String>>,
    pub passphrase: Option<Zeroizing<String>>,
    /// The saved password, tried once before prompting.
    pub password: Option<Zeroizing<String>>,
    pub startup: Option<String>,
    pub allow_password_prompt: bool,
    /// MC_SSH_DEBUG=1 in a dev build only (main decides).
    pub debug: bool,
    pub sftp_sudo: Option<SftpSudo>,
}

impl std::fmt::Debug for ConnectRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectRequest")
            .field("id", &self.id)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("cols", &self.cols)
            .field("rows", &self.rows)
            .field("privateKey", &self.private_key.is_some())
            .field("passphrase", &self.passphrase.is_some())
            .field("password", &self.password.is_some())
            .field("startup", &self.startup.is_some())
            .field("allowPasswordPrompt", &self.allow_password_prompt)
            .field("debug", &self.debug)
            .field("sftpSudo", &self.sftp_sudo)
            .finish_non_exhaustive()
    }
}

/// Main to an owner (`MainToHost` ssh messages).
#[derive(Debug, Clone)]
pub enum HostCommand {
    Connect(Box<ConnectRequest>),
    HostKeyAnswer { id: String, prompt_id: String, accept: bool, error: Option<SshErrorCode> },
    AuthAnswer { id: String, prompt_id: String, values: Option<Vec<Zeroizing<String>>> },
}

impl HostCommand {
    pub fn id(&self) -> &str {
        match self {
            HostCommand::Connect(r) => &r.id,
            HostCommand::HostKeyAnswer { id, .. } | HostCommand::AuthAnswer { id, .. } => id,
        }
    }
}

/// The kinds of an auth prompt an owner asks for (`sudo` only from SFTP sessions through sudo).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthPromptKind {
    Password,
    Keyboard,
    Sudo,
}

impl AuthPromptKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthPromptKind::Password => "password",
            AuthPromptKind::Keyboard => "keyboard",
            AuthPromptKind::Sudo => "sudo",
        }
    }
}

/// One keyboard-interactive field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptField {
    pub text: String,
    pub echo: bool,
}

/// `SshAuthPromptInfo` (plus `sudo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthPromptInfo {
    pub kind: AuthPromptKind,
    pub name: Option<String>,
    pub instructions: Option<String>,
    pub fields: Vec<PromptField>,
    pub retry: bool,
}

/// An owner to main (`HostToMain` ssh messages and `exit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostMessage {
    Status { id: String, phase: SshPhase, error: Option<SshErrorCode>, exit_code: Option<i64>, banner: Option<String> },
    HostKey { id: String, prompt_id: String, key: String },
    AuthPrompt { id: String, prompt_id: String, prompt: AuthPromptInfo },
    Exit { id: String, code: i64 },
}

fn s<'a>(m: &'a Value, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

impl HostMessage {
    pub fn id(&self) -> &str {
        match self {
            HostMessage::Status { id, .. }
            | HostMessage::HostKey { id, .. }
            | HostMessage::AuthPrompt { id, .. }
            | HostMessage::Exit { id, .. } => id,
        }
    }

    /// The 1.1.4 wire shape (`{t: 'sshStatus', ...}`), for owners that report as JSON (the DB service forwards these).
    pub fn from_json(m: &Value) -> Option<HostMessage> {
        let id = s(m, "id")?.to_string();
        Some(match s(m, "t")? {
            "sshStatus" => HostMessage::Status {
                id,
                phase: SshPhase::parse(s(m, "phase")?)?,
                error: s(m, "error").and_then(SshErrorCode::parse),
                exit_code: m.get("exitCode").and_then(Value::as_f64).map(|c| c as i64),
                banner: m.get("banner").map(|b| b.as_str().unwrap_or("").to_string()),
            },
            "sshHostKey" => {
                HostMessage::HostKey { id, prompt_id: s(m, "promptId")?.to_string(), key: s(m, "key").unwrap_or("").to_string() }
            }
            "sshAuthPrompt" => {
                let kind = match s(m, "kind")? {
                    "password" => AuthPromptKind::Password,
                    "keyboard" => AuthPromptKind::Keyboard,
                    "sudo" => AuthPromptKind::Sudo,
                    _ => return None,
                };
                let fields = m
                    .get("fields")
                    .and_then(Value::as_array)
                    .map(|l| {
                        l.iter()
                            .map(|f| PromptField {
                                text: s(f, "text").unwrap_or("").to_string(),
                                echo: f.get("echo") == Some(&Value::Bool(true)),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                HostMessage::AuthPrompt {
                    id,
                    prompt_id: s(m, "promptId")?.to_string(),
                    prompt: AuthPromptInfo {
                        kind,
                        name: s(m, "name").map(str::to_string),
                        instructions: s(m, "instructions").map(str::to_string),
                        fields,
                        retry: m.get("retry") == Some(&Value::Bool(true)),
                    },
                }
            }
            "exit" => HostMessage::Exit { id, code: m.get("code").and_then(Value::as_f64).map(|c| c as i64).unwrap_or(-1) },
            _ => return None,
        })
    }

    pub fn to_json(&self) -> Value {
        match self {
            HostMessage::Status { id, phase, error, exit_code, banner } => {
                let mut o = Map::new();
                o.insert("t".into(), json!("sshStatus"));
                o.insert("id".into(), json!(id));
                o.insert("phase".into(), json!(phase.as_str()));
                if let Some(e) = error {
                    o.insert("error".into(), json!(e.as_str()));
                }
                if let Some(c) = exit_code {
                    o.insert("exitCode".into(), json!(c));
                }
                if let Some(b) = banner {
                    o.insert("banner".into(), json!(b));
                }
                Value::Object(o)
            }
            HostMessage::HostKey { id, prompt_id, key } => {
                json!({ "t": "sshHostKey", "id": id, "promptId": prompt_id, "key": key })
            }
            HostMessage::AuthPrompt { id, prompt_id, prompt } => {
                let mut o = Map::new();
                o.insert("t".into(), json!("sshAuthPrompt"));
                o.insert("id".into(), json!(id));
                o.insert("promptId".into(), json!(prompt_id));
                o.insert("kind".into(), json!(prompt.kind.as_str()));
                if let Some(n) = &prompt.name {
                    o.insert("name".into(), json!(n));
                }
                if let Some(i) = &prompt.instructions {
                    o.insert("instructions".into(), json!(i));
                }
                let fields: Vec<Value> = prompt.fields.iter().map(|f| json!({ "text": f.text, "echo": f.echo })).collect();
                o.insert("fields".into(), Value::Array(fields));
                o.insert("retry".into(), json!(prompt.retry));
                Value::Object(o)
            }
            HostMessage::Exit { id, code } => json!({ "t": "exit", "id": id, "code": code }),
        }
    }
}

/// How a host key question was answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyChoice {
    Once,
    Save,
    Replace,
}

impl HostKeyChoice {
    pub fn parse(s: &str) -> Option<HostKeyChoice> {
        match s {
            "once" => Some(HostKeyChoice::Once),
            "save" => Some(HostKeyChoice::Save),
            "replace" => Some(HostKeyChoice::Replace),
            _ => None,
        }
    }
}

/// `SshPromptAnswer` from the renderer (already validated by the IPC layer).
#[derive(Clone)]
pub enum PromptAnswer {
    Cancel { cell_id: String, prompt_id: String },
    Values { cell_id: String, prompt_id: String, values: Vec<Zeroizing<String>>, remember: bool, use_saved: bool },
    HostKey { cell_id: String, prompt_id: String, choice: HostKeyChoice },
}

impl std::fmt::Debug for PromptAnswer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PromptAnswer::Cancel { cell_id, .. } => write!(f, "Cancel({cell_id})"),
            PromptAnswer::Values { cell_id, values, .. } => write!(f, "Values({cell_id}, {} values)", values.len()),
            PromptAnswer::HostKey { cell_id, choice, .. } => write!(f, "HostKey({cell_id}, {choice:?})"),
        }
    }
}

impl PromptAnswer {
    pub fn cell_id(&self) -> &str {
        match self {
            PromptAnswer::Cancel { cell_id, .. }
            | PromptAnswer::Values { cell_id, .. }
            | PromptAnswer::HostKey { cell_id, .. } => cell_id,
        }
    }

    pub fn prompt_id(&self) -> &str {
        match self {
            PromptAnswer::Cancel { prompt_id, .. }
            | PromptAnswer::Values { prompt_id, .. }
            | PromptAnswer::HostKey { prompt_id, .. } => prompt_id,
        }
    }

    /// The shape the coordinator reads (`'cancel' in a`, `'hostKey' in a`, else values): no validation beyond the types,
    /// which the IPC schema (or the DB / SFTP service that forwards a tunnel answer) already checked.
    pub fn from_json(a: &Value) -> Option<PromptAnswer> {
        let cell_id = s(a, "cellId")?.to_string();
        let prompt_id = s(a, "promptId")?.to_string();
        if a.get("cancel").is_some() {
            return Some(PromptAnswer::Cancel { cell_id, prompt_id });
        }
        if let Some(h) = a.get("hostKey") {
            return Some(PromptAnswer::HostKey { cell_id, prompt_id, choice: HostKeyChoice::parse(h.as_str()?)? });
        }
        let values = a
            .get("values")?
            .as_array()?
            .iter()
            .map(|v| v.as_str().map(|v| Zeroizing::new(v.to_string())))
            .collect::<Option<Vec<_>>>()?;
        Some(PromptAnswer::Values {
            cell_id,
            prompt_id,
            values,
            remember: a.get("remember") == Some(&Value::Bool(true)),
            use_saved: a.get("useSaved") == Some(&Value::Bool(true)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_messages_round_trip_the_1_1_4_shape() {
        for m in [
            json!({"t": "sshStatus", "id": "c", "phase": "error", "error": "auth"}),
            json!({"t": "sshStatus", "id": "c", "phase": "connecting", "banner": "hi"}),
            json!({"t": "sshStatus", "id": "c", "phase": "closed", "exitCode": 3}),
            json!({"t": "sshHostKey", "id": "c", "promptId": "p", "key": "AAAA"}),
            json!({"t": "sshAuthPrompt", "id": "c", "promptId": "p", "kind": "keyboard", "name": "n", "instructions": "i",
                "fields": [{"text": "Code:", "echo": true}], "retry": false}),
            json!({"t": "sshAuthPrompt", "id": "c", "promptId": "p", "kind": "sudo", "fields": [], "retry": true}),
            json!({"t": "exit", "id": "c", "code": -1}),
        ] {
            assert_eq!(HostMessage::from_json(&m).unwrap().to_json(), m);
        }
        assert!(HostMessage::from_json(&json!({"t": "sshStatus", "id": "c", "phase": "nope"})).is_none());
    }

    #[test]
    fn prompt_answers_parse() {
        let a = PromptAnswer::from_json(&json!({"cellId": "c", "promptId": "p", "values": ["x"], "remember": true})).unwrap();
        assert!(matches!(a, PromptAnswer::Values { remember: true, use_saved: false, .. }));
        let a = PromptAnswer::from_json(&json!({"cellId": "c", "promptId": "p", "hostKey": "replace"})).unwrap();
        assert!(matches!(a, PromptAnswer::HostKey { choice: HostKeyChoice::Replace, .. }));
        assert!(PromptAnswer::from_json(&json!({"cellId": "c", "promptId": "p", "cancel": true})).is_some());
        assert!(PromptAnswer::from_json(&json!({"cellId": "c", "promptId": "p", "values": [1]})).is_none());
    }
}
