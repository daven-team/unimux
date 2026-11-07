//! account stores, locks, activation/swap, reconcile/refresh, logins, usage, auto-switch, limit alerts, GitHub token (A1-A6)
//!
//! A1 (this layer): the saved Claude accounts (`accounts/accounts.json`, [`store::AccountsStore`]), the saved Codex accounts
//! (`codex-accounts/accounts.json`, [`codex_store::CodexAccountsStore`]), Claude Code's proper-lockfile directory locks
//! ([`locks`]) and the identity helpers ([`identity`], [`codex`]). Ports of src/main/accounts/{store,codexStore,claudeLocks,
//! identity}.ts, src/shared/{accounts,codexAccounts}.ts and the identity readers of src/main/usage/credentials.ts and
//! src/main/accounts/codexActivate.ts. The files they write are byte-identical to 1.1.4's (test/golden/accounts-*.jsonl).
//!
//! A2: "make main" ([`activate`]: the version-2 journal with backups in `accounts/swap-backup`, its recovery and the 30 s
//! retry), the 0.9.0 exchange and its version-1 recovery ([`legacy_swap`]), the Codex "make main" ([`codex_activate`]), the
//! one swap slot ([`slot`]), the per-profile lock ([`refresh`]), cswap's read-only roster ([`cswap`]) and the family rule and
//! account guards ([`rules`]). Ports of src/main/accounts/{activate,swap,codexActivate,makeMain,guards,dead,cswap}.ts and the
//! parts of refs.ts, refresh.ts and resync.ts they use.
//!
//! A6: the GitHub sign-in of "Publish to GitHub" ([`github`]: token store, `gh` fallback, device flow, status cache, the git
//! environment and refusal regexes), registered in `unimux-app/src/commands/github.rs`.
//!
//! The commands are registered in `unimux-app/src/commands/accounts.rs` by the later A packages.

pub mod activate;
pub mod codex;
pub mod codex_activate;
pub mod codex_store;
pub mod cswap;
pub mod github;
pub mod identity;
mod js;
pub mod legacy_swap;
pub mod locks;
pub mod refresh;
pub mod results;
pub mod rules;
pub mod slot;
pub mod store;
pub mod swapfs;
#[cfg(test)]
mod test_support;
