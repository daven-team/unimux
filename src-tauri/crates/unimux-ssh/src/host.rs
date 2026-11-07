//! The owner side of logins (1.1.4's Pty Host, SFTP Host and DB Host halves of the SSH protocol): an owner keeps one
//! [`LoginRegistry`], starts each login through it, and hands it main's `sshHostKeyAnswer` / `sshAuthAnswer` commands.
//! The login's questions and phases go to main as [`HostMessage`]s. What the owner does once logged in (a shell, an SFTP
//! subsystem, a tunnel) and its final `connected` / `error` / `closed` status stay with the owner (P5, T1, D2).

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::login::{LoginControl, LoginEvents, LoginHandle, LoginRequest, LoginTimers, login};
use crate::protocol::{AuthPromptInfo, HostCommand, HostMessage};
use crate::session::{SshErrorCode, SshPhase};

/// Where an owner's messages to main go (the coordinator's `on_host_message`, possibly through a service).
pub type MessageSink = Arc<dyn Fn(HostMessage) + Send + Sync>;

/// The running logins of one owner, by session id.
#[derive(Default)]
pub struct LoginRegistry {
    logins: Mutex<HashMap<String, Arc<LoginControl>>>,
}

impl std::fmt::Debug for LoginRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginRegistry").field("logins", &self.logins.lock().len()).finish()
    }
}

struct Events {
    id: String,
    sink: MessageSink,
    phase: Mutex<SshPhase>,
}

impl LoginEvents for Events {
    fn phase(&self, phase: SshPhase) {
        *self.phase.lock() = phase;
        (self.sink)(HostMessage::Status { id: self.id.clone(), phase, error: None, exit_code: None, banner: None });
    }
    fn banner(&self, text: &str) {
        let phase = *self.phase.lock();
        (self.sink)(HostMessage::Status {
            id: self.id.clone(),
            phase,
            error: None,
            exit_code: None,
            banner: Some(text.to_string()),
        });
    }
    fn host_key(&self, prompt_id: &str, key_base64: &str) {
        (self.sink)(HostMessage::HostKey { id: self.id.clone(), prompt_id: prompt_id.into(), key: key_base64.into() });
    }
    fn auth_prompt(&self, prompt_id: &str, prompt: &AuthPromptInfo) {
        (self.sink)(HostMessage::AuthPrompt { id: self.id.clone(), prompt_id: prompt_id.into(), prompt: prompt.clone() });
    }
}

impl LoginRegistry {
    pub fn new() -> Arc<LoginRegistry> {
        Arc::new(LoginRegistry::default())
    }

    /// Hands main's answer to the login it belongs to; false for a connect command or an id with no running login.
    pub fn answer(&self, cmd: HostCommand) -> bool {
        match cmd {
            HostCommand::Connect(_) => false,
            HostCommand::HostKeyAnswer { id, prompt_id, accept, error } => {
                let Some(c) = self.logins.lock().get(&id).cloned() else { return false };
                c.answer_host_key(&prompt_id, accept, error);
                true
            }
            HostCommand::AuthAnswer { id, prompt_id, values } => {
                let Some(c) = self.logins.lock().get(&id).cloned() else { return false };
                c.answer_auth(&prompt_id, values);
                true
            }
        }
    }

    /// Runs one login for `id` (a login still running for the same id is aborted first). The owner reports `connecting`
    /// itself before this and the final status after it.
    pub async fn login(
        &self,
        id: &str,
        req: LoginRequest,
        timers: LoginTimers,
        sink: MessageSink,
    ) -> Result<LoginHandle, SshErrorCode> {
        let control = LoginControl::new();
        if let Some(old) = self.logins.lock().insert(id.to_string(), control.clone()) {
            old.abort();
        }
        let events = Arc::new(Events { id: id.to_string(), sink, phase: Mutex::new(SshPhase::Connecting) });
        let r = login(req, timers, events, control.clone()).await;
        let mut logins = self.logins.lock();
        if logins.get(id).is_some_and(|c| Arc::ptr_eq(c, &control)) {
            logins.remove(id);
        }
        r
    }

    /// The session of `id` ended (killed, closed): its login stops and its questions are dropped.
    pub fn abort(&self, id: &str) {
        if let Some(c) = self.logins.lock().remove(id) {
            c.abort();
        }
    }

    /// The reason main or the user decided for a running login (refused host key, cancelled prompt).
    pub fn override_code(&self, id: &str) -> Option<SshErrorCode> {
        self.logins.lock().get(id).and_then(|c| c.override_code())
    }
}
