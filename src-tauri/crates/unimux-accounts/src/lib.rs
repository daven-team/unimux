//! account stores, locks, activation/swap, reconcile/refresh, logins, usage, auto-switch, limit alerts, GitHub token (A1-A6)
//!
//! A1 (this layer): the saved Claude accounts (`accounts/accounts.json`, [`store::AccountsStore`]), the saved Codex accounts
//! (`codex-accounts/accounts.json`, [`codex_store::CodexAccountsStore`]), Claude Code's proper-lockfile directory locks
//! ([`locks`]) and the identity helpers ([`identity`], [`codex`]). Ports of src/main/accounts/{store,codexStore,claudeLocks,
//! identity}.ts, src/shared/{accounts,codexAccounts}.ts and the identity readers of src/main/usage/credentials.ts and
//! src/main/accounts/codexActivate.ts. The files they write are byte-identical to 1.1.4's (test/golden/accounts-*.jsonl).
//!
//! The commands are registered in `unimux-app/src/commands/accounts.rs` by the later A packages.

pub mod codex;
pub mod codex_store;
pub mod identity;
mod js;
pub mod locks;
pub mod store;
