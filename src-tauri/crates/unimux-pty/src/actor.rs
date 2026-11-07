//! The pty manager as a supervised actor: the Rust stand-in for the Pty Host utility process of 1.1.4. Commands run in
//! order on the actor thread; a panic there, or in the sink on a terminal's reader thread, is a crash: every terminal is
//! killed and forgotten (no exit reports, the renderer respawns its cells), and the manager is built again after the
//! restart delay of [`crate::supervisor`] or, after more than 5 crashes in 60 s, only on `restart_after_fatal`.

use std::io;
use std::sync::Arc;
use std::sync::mpsc::Sender;
use std::time::Duration;

use crate::manager::{PtyManager, PtySink, SpawnRequest};
use crate::supervisor::{CrashPolicy, Supervisor, SupervisorEvent};

/// The host messages of 1.1.4 (`MainToHost` without the SSH ones, which P5 adds).
pub enum PtyCommand {
    /// `spawned` / `spawnError`: the shell's pid or the error.
    Spawn(Box<SpawnRequest>, Option<Sender<io::Result<u32>>>),
    Write(String, Vec<u8>),
    Resize(String, u16, u16),
    SetPaused(String, bool),
    /// `kill` (with `ack`: the answer comes once the terminal ended or `timeout` passed; the actor does not wait).
    Kill(String, Option<(Duration, Sender<bool>)>),
    /// `killAll`, then `killedAll` (true when every terminal ended in time). Blocks the actor up to `timeout`.
    KillAll(Duration, Option<Sender<bool>>),
    /// Tests: a crash on the actor thread.
    Panic(String),
}

/// Starts the supervised pty manager. `sink` gets the output and exits of every manager built (also after crashes).
pub fn start(
    sink: Arc<dyn PtySink>,
    policy: CrashPolicy,
    events: impl Fn(SupervisorEvent) + Send + 'static,
) -> Supervisor<PtyCommand> {
    Supervisor::start(
        "pty-actor",
        policy,
        move |injector| {
            let manager = PtyManager::new(sink.clone());
            manager.set_panic_hook(Some(Arc::new(move |message| injector.crash(message))));
            manager
        },
        handle,
        events,
    )
}

fn handle(m: &mut PtyManager, cmd: PtyCommand) {
    match cmd {
        PtyCommand::Spawn(req, reply) => {
            let r = m.spawn(*req);
            if let Some(reply) = reply {
                let _ = reply.send(r);
            }
        }
        PtyCommand::Write(id, data) => m.write(&id, &data),
        PtyCommand::Resize(id, cols, rows) => m.resize(&id, cols, rows),
        PtyCommand::SetPaused(id, paused) => m.set_paused(&id, paused),
        PtyCommand::Kill(id, ack) => {
            let wait = m.kill(&id);
            if let Some((timeout, done)) = ack {
                let waiter = move || {
                    let _ = done.send(wait.wait(timeout));
                };
                let _ = std::thread::Builder::new().name("pty-kill-ack".into()).spawn(waiter);
            }
        }
        PtyCommand::KillAll(timeout, done) => {
            let all = m.kill_all(timeout);
            if let Some(done) = done {
                let _ = done.send(all);
            }
        }
        PtyCommand::Panic(message) => panic!("{message}"),
    }
}
