//! P5: the SSH cells in the app. [`unimux_ssh::shell::SshShells`] (the 1.1.4 Pty Host's `SshManager`) runs over the app's
//! pty engine, so an SSH cell is a terminal of the `pty` port like any other (output, flow control, replay, routes, kill,
//! kill all, the crash of the pty service); this file plugs it in where 1.1.4 main and the Pty Host did:
//! - the coordinator's cell slot (`ptyHost.sendSsh`): `sshConnect`, `sshHostKeyAnswer`, `sshAuthAnswer`; not delivered
//!   while the pty service is down (the connect then fails with `ptyHostCrashed`);
//! - the sessions' `sshStatus` / `sshHostKey` / `sshAuthPrompt` go to the coordinator; `spawned` (pid 0) and the engine's
//!   `exit` go through main's cell bookkeeping, the exit also to the coordinator first (`ssh.onHostMessage` returns false
//!   for it);
//! - `cell:kill` / `cell:killAndWait` tell the coordinator (`ssh.killed`), a crash of the pty service `ssh.hostCrashed()`;
//! - the pty port's `sshList` / `sshStats` run on the cell's own connection and are answered on the page that asked.

use std::sync::{Arc, OnceLock, Weak};

use unimux_pty::service::HostEvent;
use unimux_ssh::coordinator::{SshCoordinator, SshHostLink};
use unimux_ssh::protocol::{HostCommand, HostMessage};
use unimux_ssh::shell::{ShellEvents, SshShells};

use super::link::SshLink;
use crate::commands::pty;

/// Where the sessions report: the coordinator (SSH messages) and main's cell bookkeeping (`spawned`).
struct AppShellEvents {
    coordinator: Weak<SshCoordinator>,
}

impl ShellEvents for AppShellEvents {
    fn spawned(&self, id: &str) {
        pty::host().handle(HostEvent::Spawned { id: id.to_string(), pid: 0 });
    }

    fn message(&self, m: HostMessage) {
        if let Some(c) = self.coordinator.upgrade() {
            c.on_host_message(m);
        }
    }
}

/// The coordinator's cell slot.
struct CellOwner(Weak<SshShells>);

impl SshHostLink for CellOwner {
    fn send(&self, cmd: HostCommand) -> bool {
        // `ptyHost.sendSsh`: nothing is delivered while no pty service runs (crashed too often).
        if !pty::service().is_running() {
            return false;
        }
        let Some(shells) = self.0.upgrade() else { return false };
        match cmd {
            HostCommand::Connect(req) => shells.connect(*req),
            // An answer for a login that ended meanwhile is dropped (the Pty Host ignored it the same way).
            answer => {
                shells.answer(answer);
            }
        }
        true
    }
}

static SHELLS: OnceLock<Arc<SshShells>> = OnceLock::new();

/// The SSH cells of this run (None before `ssh::register`).
#[allow(dead_code, reason = "the check build's test bridge and later packages read it")]
pub fn shells() -> Option<&'static Arc<SshShells>> {
    SHELLS.get()
}

/// Creates the SSH cells over the app's pty engine and plugs them into the coordinator and the pty host (once per run,
/// from `ssh::register`, after `pty::register`).
pub fn register(link: &Arc<SshLink>) {
    if SHELLS.get().is_some() {
        return;
    }
    let rt = tauri::async_runtime::handle().inner().clone();
    let events = Arc::new(AppShellEvents { coordinator: Arc::downgrade(&link.coordinator) });
    let shells = SshShells::new(pty::engine().clone(), rt, events);
    link.owners.set(None, Arc::new(CellOwner(Arc::downgrade(&shells))));

    // The port's sshList / sshStats (the engine already checked that the window owns the terminal).
    let s = Arc::downgrade(&shells);
    pty::engine().on_message(move |label, page, m| {
        if let Some(shells) = s.upgrade() {
            shells.port_message(label, page, m);
        }
    });

    let host = pty::host();
    // `ssh.onHostMessage(exit)`: a live session reads closed / error; the cell bookkeeping still runs (false).
    let c = Arc::downgrade(&link.coordinator);
    host.intercept("ssh cells", move |event| {
        if let HostEvent::Exit { id, code } = event
            && let Some(c) = c.upgrade()
        {
            c.on_host_message(HostMessage::Exit { id: id.clone(), code: *code });
        }
        false
    });
    let c = Arc::downgrade(&link.coordinator);
    host.on_killed("ssh cells", move |cell| {
        if let Some(c) = c.upgrade() {
            c.killed(cell);
        }
    });
    let c = Arc::downgrade(&link.coordinator);
    host.on_crashed("ssh cells", move || {
        if let Some(c) = c.upgrade() {
            c.host_crashed();
        }
    });
    let _ = SHELLS.set(shells);
}
