//! AppState of unimux (state.json), owned by Rust from wave 0 (PLAN F7-F9).
//!
//! The state is kept as `serde_json::Value` with insertion order (feature `preserve_order`), so unknown keys survive and a
//! load + save without an edit writes the same bytes (`unimux_core::js_json`). Typed views are added by the domains that
//! need them; the renderer keeps the TS types.
//!
//! - [`edits`]: `mergeStateEdit` (a renderer edit rebased on the latest state).
//! - [`patch`]: `diffState` / `stateChange` (what the windows are told) and `applyPatch` (tests).
//! - [`store`]: loadState rules, the debounced saver, `flush_until_saved`.
//! - [`controller`]: the single writer with revisions, change hooks and a revision watch.
//! - [`broadcast`]: `state:changed` with 16 ms batching of agent changes.
//! - [`normalize`]: normalizeState / defaultState / the edit normalization of 1.1.4 ([`StateNormalizer`]).

pub mod broadcast;
pub mod controller;
pub mod edits;
pub mod normalize;
pub mod patch;
pub mod store;
pub mod webview_import;

pub use controller::{Snapshot, StateController};
pub use normalize::{Normalizer, PassThrough, Platform, StateNormalizer};
