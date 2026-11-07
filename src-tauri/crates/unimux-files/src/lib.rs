//! project files, preview, save, file ops, search/replace, notes, fs probes, monitor, changelog (G5-G8)
//!
//! G5 (this part): project files of the Files panel and the editor (containment, listings in the Polish natural order,
//! previews, the conflict-safe save) and the editor's local files of the SFTP view. Every function is blocking file system
//! work; the commands in `unimux-app/src/commands/files.rs` run them on the blocking pool.

pub mod collate;
pub mod fserr;
pub mod fsx;
pub mod jspath;
pub mod local;
pub mod parquet;
pub mod preview;
pub mod project;
pub mod save;
pub mod thrift;
