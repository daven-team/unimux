//! "Clone a repository" (G4, the clone half of src/main/git.ts) and the network run it shares with fetch / pull / push (G3).
//!
//! `git clone -- <url> .` runs inside the target folder, which must be empty or not exist yet (its parent must). The address
//! was checked by [`crate::shared::is_clone_url_str`]; `protocol.ext.allow=never` is one of the runner's global arguments. The
//! GitHub sign-in of unimux ([`RemoteAuth`], A6) goes along for `https://github.com/` addresses only, with a second run
//! without it when GitHub refuses it (the user's own credential helper then answers). A folder made here goes away again when
//! the clone fails.

use std::collections::HashSet;
use std::io::ErrorKind;
use std::time::Duration;

use parking_lot::Mutex;

pub use crate::runner::RemoteAuth;
use crate::runner::{GitErrorCode, GitFailure, GitResult, RunOptions, RunOutput};
use crate::shared::{INVALID_CLONE_URL, is_clone_url_str};
pub use crate::ops::op_message;
pub use crate::shared::GitOpResult;
use crate::{Git, paths};

/// `'Inna operacja git w tym repozytorium jeszcze trwa.'`
pub const BUSY: &str = "Inna operacja git w tym repozytorium jeszcze trwa.";
pub const NOT_EMPTY: &str = "Folder docelowy nie jest pusty. Klonować można tylko do pustego folderu.";
pub const UNREADABLE_TARGET: &str = "Nie można odczytać folderu docelowego.";
pub const CANNOT_CREATE_TARGET: &str = "Nie można utworzyć folderu docelowego.";

/// The keys of the operations that hold a repository (or a clone target) right now: one at a time each.
#[derive(Debug, Default)]
pub struct BusySet(Mutex<HashSet<String>>);

/// Releases its key when dropped.
pub struct BusyGuard<'a> {
    set: &'a BusySet,
    key: String,
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.set.0.lock().remove(&self.key);
    }
}

impl BusySet {
    /// Takes `key`; None when another operation holds it.
    pub fn take(&self, key: &str) -> Option<BusyGuard<'_>> {
        self.0.lock().insert(key.to_string()).then(|| BusyGuard { set: self, key: key.to_string() })
    }
    /// Takes `key` without a guard (the caller releases it with [`BusySet::release`]); false when another operation holds it.
    pub(crate) fn insert(&self, key: &str) -> bool {
        self.0.lock().insert(key.to_string())
    }
    pub(crate) fn release(&self, key: &str) {
        self.0.lock().remove(key);
    }
    pub fn holds(&self, key: &str) -> bool {
        self.0.lock().contains(key)
    }
}

/// `caseFold(resolve(target))`: the key of a clone target.
fn clone_key(target: &str) -> String {
    let resolved = paths::resolve(target, ".");
    format!("clone\0{}", if cfg!(windows) { resolved.to_lowercase() } else { resolved })
}

/// `/^https:\/\/github\.com\//i`.
pub fn is_github_https(url: &str) -> bool {
    url.len() >= 19 && url.as_bytes()[..19].eq_ignore_ascii_case(b"https://github.com/")
}

impl Git {
    /// A run that talks to a remote with the sign-in `auth` (clone passes it for github.com only; fetch / pull / push go
    /// through [`Git::network`] with the engine's own). When GitHub refuses it, the same command runs once more without it;
    /// a refusal of the token as a whole is reported.
    pub async fn network_with<S: AsRef<str>>(
        &self,
        cwd: &str,
        args: &[S],
        timeout: Duration,
        auth: Option<&dyn RemoteAuth>,
    ) -> GitResult<RunOutput> {
        let plain = RunOptions::write(timeout);
        let Some((auth, env)) = auth.and_then(|a| a.env().map(|env| (a, env))) else {
            return self.run(cwd, args, &plain).await;
        };
        match self.run(cwd, args, &RunOptions { env, ..RunOptions::write(timeout) }).await {
            Ok(out) => Ok(out),
            Err(e) if e.code == GitErrorCode::Failed && auth.auth_refused(&e.message) => {
                if auth.token_refused(&e.message) {
                    auth.refused();
                }
                self.run(cwd, args, &plain).await
            }
            Err(e) => Err(e),
        }
    }

    /// `clone(target, url)`: see the module documentation. `auth` is the app's GitHub sign-in (sent for github.com only).
    pub async fn clone_repo(&self, target: &str, url: &str, auth: Option<&dyn RemoteAuth>) -> GitResult<GitOpResult> {
        if !is_clone_url_str(url) {
            return Err(GitFailure::new(GitErrorCode::Invalid, INVALID_CLONE_URL));
        }
        let mut created = false;
        match std::fs::read_dir(target) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return Err(GitFailure::new(GitErrorCode::Invalid, NOT_EMPTY));
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {
                if std::fs::create_dir(target).is_err() {
                    return Err(GitFailure::new(GitErrorCode::Invalid, CANNOT_CREATE_TARGET));
                }
                created = true;
            }
            Err(_) => return Err(GitFailure::new(GitErrorCode::Failed, UNREADABLE_TARGET)),
        }
        let key = clone_key(target);
        let Some(_busy) = self.busy().take(&key) else {
            return Err(GitFailure::new(GitErrorCode::Busy, BUSY));
        };
        let github = auth.filter(|_| is_github_https(url));
        let result = self.network_with(target, &["clone", "--", url, "."], self.options().clone_timeout, github).await;
        self.forget_root(target);
        match result {
            Ok(out) => Ok(op_message(&out, "OK")),
            Err(e) => {
                if created {
                    let t = target.to_string();
                    let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(t)).await;
                }
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(stdout: &str, stderr: &str) -> RunOutput {
        RunOutput { code: 0, stdout: stdout.into(), stderr: stderr.into(), truncated: false }
    }

    #[test]
    fn op_message_keeps_the_last_two_meaningful_lines() {
        assert_eq!(op_message(&out("", "Cloning into '.'...\n"), "OK").message, "Cloning into '.'...");
        assert_eq!(op_message(&out("", ""), "OK").message, "OK");
        assert_eq!(op_message(&out("a\n", "b\nhint: x\nWarning: y\nc\n"), "OK").message, "b c");
    }

    #[test]
    fn github_https_only() {
        assert!(is_github_https("https://github.com/a/b.git"));
        assert!(is_github_https("HTTPS://GitHub.com/a"));
        assert!(!is_github_https("https://github.company.io/a"));
        assert!(!is_github_https("git@github.com:a/b.git"));
        assert!(!is_github_https("https://gitlab.com/a"));
    }

    #[test]
    fn busy_keys_are_held_until_dropped() {
        let set = BusySet::default();
        let g = set.take("a").unwrap();
        assert!(set.take("a").is_none());
        assert!(set.holds("a"));
        drop(g);
        assert!(set.take("a").is_some());
    }
}
