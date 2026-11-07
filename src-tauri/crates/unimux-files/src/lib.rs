//! project files, preview, save, file ops, search/replace, notes, fs probes, monitor, changelog (G5-G8)
//!
//! G7: project search and replace (`search`, the JS pattern engine in `jsregex`).
//!
//! G5: project files of the Files panel and the editor (containment, listings in the Polish natural order,
//! previews, the conflict-safe save) and the editor's local files of the SFTP view. Every function is blocking file system
//! work; the commands in `unimux-app/src/commands/files.rs` run them on the blocking pool.

pub mod collate;
pub mod fserr;
pub mod fsx;
pub mod jspath;
pub mod jsregex;
pub mod local;
pub mod parquet;
pub mod preview;
pub mod project;
pub mod save;
pub mod search;
pub mod thrift;
