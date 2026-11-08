//! H6: the guided install of the agent CLIs (port of src/main/cliInstall.ts, the install half of src/main/cliIpc.ts and
//! src/shared/cliInstall.ts).
//!
//! - [`shared`]: the allow-listed commands per shell, the end marker, the failure classes, the POSIX tool probe (pure);
//! - [`manager`]: [`InstallManager`] (one install at a time in an `install:` terminal: 5 s polls, 20 s grace after an early
//!   find, 3 s after Ctrl+C, 10 min limit).

pub mod manager;
pub mod shared;

pub use manager::{ActiveInstall, InstallDeps, InstallManager, InstallPty, InstallTimings, PtyEvent, StartError, Started};
pub use shared::{INSTALL_PTY_PREFIX, InstallReason, InstallState};
