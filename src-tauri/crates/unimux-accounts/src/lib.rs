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
//! A5: the account limits ([`usage`]: fetchers, `UsageService` with `usage-cache.json` version 2, credential readers with the
//! macOS Keychain failure cache), the automatic switch ([`auto_switch`], `auto-switch.json`), the limit warnings
//! ([`limit_alerts`], `limit-alerts.json`, quiet hours) and their notice texts ([`notice_text`]). Ports of
//! src/main/usage/*.ts, src/main/{autoSwitch,limitAlerts}.ts and src/shared/{usage,autoSwitch,limitAlerts}.ts.
//!
//! A6: the GitHub sign-in of "Publish to GitHub" ([`github`]: token store, `gh` fallback, device flow, status cache, the git
//! environment and refusal regexes), registered in `unimux-app/src/commands/github.rs`.
//!
//! A4: the login managers ([`login`]: `claude auth login --claudeai` / `codex login` in an `auth:` terminal, profile
//! snapshots and restores, fingerprint polls every 1.5 s, the 10 minute limit, the identity confirmation). Ports of
//! src/main/auth/{login,codexLogin,profileSnapshot}.ts.
//!
//! The commands are registered in `unimux-app/src/commands/accounts.rs` by the later A packages.

pub mod activate;
pub mod auto_switch;
pub mod claude;
pub mod codex;
pub mod codex_activate;
pub mod codex_store;
pub mod cswap;
pub mod github;
pub mod identity;
mod js;
pub mod legacy_swap;
pub mod limit_alerts;
pub mod live;
pub mod localtime;
pub mod locks;
pub mod login;
pub mod migrate;
pub mod notice_text;
pub mod reconcile;
pub mod refresh;
pub mod refs;
pub mod results;
pub mod resync;
pub mod retry_after;
pub mod rules;
pub mod slot;
pub mod store;
pub mod swapfs;
#[cfg(test)]
mod test_support;
pub mod usage;
