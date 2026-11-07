//! The context meter (H4): [`usage`] is the pure port of src/shared/contextUsage.ts, [`tracker`] the ContextTracker of
//! src/main/contextUsage.ts.

pub mod tracker;
pub mod usage;

pub use tracker::{ContextTarget, ContextTracker, ContextTrackerDeps};
pub use usage::{ContextCli, ContextScan, ContextUsage};
