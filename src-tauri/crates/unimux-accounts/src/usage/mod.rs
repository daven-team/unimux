//! A5: the limits of the AI accounts. Ports of src/main/usage/{fetchers,credentials,codexLog,parse,sanitize,service}.ts and
//! the main-process half of src/shared/usage.ts.
//!
//! - [`fetchers`]: one read of a Claude or Codex account (requests from `unimux_net::calls`).
//! - [`service`]: `UsageService` (spacing 20 s / 180 s, backoff 60 s doubling to 30 min, `usage-cache.json` version 2,
//!   0.9.0 cache adoption, credentials watcher, hidden-window polling).
//! - [`credentials`]: the read-only credential helpers, with the macOS Keychain read behind a 30 minute failure cache.
//! - [`subscription`]: the OAuth profile's plan fields (1.2.6): a lapsed subscription and the plan label.

pub mod codex_log;
pub mod credentials;
pub mod fetchers;
pub mod parse;
pub mod sanitize;
pub mod service;
pub mod subscription;
pub mod types;

pub use fetchers::{FetchResult, FetcherDeps, fetch_claude, fetch_codex};
pub use service::{AccountsInfo, UsageOptions, UsageService, UsageState};
pub use types::{CardState, HeldBy, Provider, ProviderUsage, Source, Status, UsageWindow, WindowId, card_state};
