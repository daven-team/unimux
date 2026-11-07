//! The three SSH stores of one data dir (`<data>/ssh/`), as 1.1.4's startSsh creates them: the vault, the known hosts and
//! the command history. The vault and the known hosts are opened once on the blocking pool (the vault's DPAPI check
//! decrypts every secret, and on macOS asking for the storage may wait for the Keychain prompt); every caller awaits that
//! same init, so nothing ever sees a half-loaded vault.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::OnceCell;
use unimux_oscrypt::SafeCipher;

use crate::command_history::{CommandHistoryOptions, CommandHistoryStore, HostExists};
use crate::known_hosts::KnownHostsStore;
use crate::vault::SshVault;

/// `<data>/ssh/vault.json`, `known_hosts.json`, `command_history.json`.
pub const VAULT_FILE: &str = "vault.json";
pub const KNOWN_HOSTS_FILE: &str = "known_hosts.json";
pub const HISTORY_FILE: &str = "command_history.json";

struct Opened {
    vault: Arc<Mutex<SshVault>>,
    known_hosts: Arc<Mutex<KnownHostsStore>>,
}

pub struct SshStores {
    dir: PathBuf,
    cipher: Arc<dyn SafeCipher>,
    opened: OnceCell<Opened>,
    history: Arc<CommandHistoryStore>,
}

impl std::fmt::Debug for SshStores {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshStores").field("dir", &self.dir).field("opened", &self.opened.initialized()).finish()
    }
}

impl SshStores {
    /// Nothing is read here: the history loads on first use, the vault and the known hosts in [`SshStores::init`].
    pub fn new(data_dir: &Path, cipher: Arc<dyn SafeCipher>, host_exists: HostExists) -> Arc<Self> {
        let dir = data_dir.join("ssh");
        let history = CommandHistoryStore::new(dir.join(HISTORY_FILE), CommandHistoryOptions::new(host_exists));
        Arc::new(Self { dir, cipher, opened: OnceCell::new(), history })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Opens the vault (with its DPAPI check) and the known hosts on the blocking pool; later calls wait for the first.
    pub async fn init(&self) {
        self.opened().await;
    }

    async fn opened(&self) -> &Opened {
        self.opened
            .get_or_init(|| async {
                let (dir, cipher) = (self.dir.clone(), self.cipher.clone());
                let open = move || Opened {
                    vault: Arc::new(Mutex::new(SshVault::open(dir.join(VAULT_FILE), cipher))),
                    known_hosts: Arc::new(Mutex::new(KnownHostsStore::open(dir.join(KNOWN_HOSTS_FILE)))),
                };
                match tokio::runtime::Handle::try_current() {
                    Ok(handle) => {
                        let task = handle.spawn_blocking(open);
                        task.await.unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()))
                    }
                    Err(_) => open(),
                }
            })
            .await
    }

    /// The vault, once [`SshStores::init`] has run. Lock it only for a call, on the blocking pool for writes.
    pub async fn vault(&self) -> Arc<Mutex<SshVault>> {
        self.opened().await.vault.clone()
    }

    pub async fn known_hosts(&self) -> Arc<Mutex<KnownHostsStore>> {
        self.opened().await.known_hosts.clone()
    }

    pub fn history(&self) -> &Arc<CommandHistoryStore> {
        &self.history
    }
}
