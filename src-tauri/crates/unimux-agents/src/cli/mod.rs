//! H3: the CLI detector (Claude Code, Codex). Port of src/main/cliDetect.ts, cliSystem.ts, cliIpc.ts (the `cli:*` part) and
//! the host-side helpers of src/shared/cliStatus.ts.
//!
//! - [`status`]: types, PATH arithmetic, known folders, probe scripts and parsers, install data (pure);
//! - [`detector`]: [`CliDetector`] with its caches (found 10 min, missing / unknown 30 s, registry 60 s), generations,
//!   `wait_ms`, the PATH for spawned processes ([`CliDetector::apply_env`]) and [`CliDetector::version_for`];
//! - [`system`]: the real I/O ([`SystemCliDeps`]);
//! - [`ipc`]: `cli:status`, `cli:recheck`, `cli:openDocs`.

pub mod detector;
pub mod ipc;
pub mod status;
pub mod system;

pub use detector::{CliDeps, CliDetector, ExecRequest, ExecResult, GetOptions};
pub use ipc::CliHandlers;
pub use status::{CliId, CliReason, CliSource, CliState, CliStatus, CliStatusMap, Os};
pub use system::{SystemCliDeps, SystemOptions};

/// How long a spawn may wait for a detection before it proceeds anyway (`CLI_WAIT_MS`; unknown never blocks).
pub const CLI_WAIT_MS: u64 = 7000;
