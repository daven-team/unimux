//! SFTP service, sides, queue, manage ops, sudo over exec (T1-T5).
//!
//! T1 (port of src/main/sftp/service.ts, src/main/sftp/ipc.ts, src/main/sftpHostClient.ts, the session half of
//! src/sftphost/host.ts and src/sftphost/throttle.ts): [`service::SftpService`] (deferred login, sudo decided once, the
//! start folder, the idle disconnect with the view / queue / pins per window), [`ipc`] (the `sftp:*` channels with 1.1.4's
//! zod validation), [`host::SftpHost`] (sessions on russh through S3's login, the `sftp` subsystem, the transfer port with
//! [`throttle::ItemThrottle`], crash supervision) and the [`host::SftpBackend`] slot T2-T5 fill (the SFTP client and the
//! local side, the queues, the manage ops and editor files, SFTP through sudo).
//!
//! T2 (port of src/sftphost/sides.ts, src/sftphost/targets.ts and the remote operations of src/sftphost/host.ts): the SFTP
//! v3 client ([`proto`], [`client::SftpClient`], pipelined, byte-exact handles), the [`sides::FileSide`] interface with
//! [`remote::RemoteSide`] (16 x 32 KB reads and writes in flight, posix-rename / lsetstat detection, the aside rename,
//! status mapping) and [`local::LocalSide`] (Windows names, `sameLocalFile` via the file index), the
//! [`targets::TargetRegistry`], and [`backend::SidesBackend`] (attach, list capped at 20,000, stat, realpath, mkdir,
//! rename).
//!
//! T3 (port of src/sftphost/queue.ts and the queue half of src/sftphost/host.ts): [`queue::TransferQueue`] (expansion
//! with its caps, 3 files at once, `.unimux-part` files, conflicts and keep-both names, the target registry, moves with
//! the aside rename and the cross-volume copy, cancel / retry / clear) and the queues of [`backend::SidesBackend`].
//!
//! T4 (port of the manage ops of src/sftphost/host.ts and src/sftphost/editFile.ts): [`manage`] (delete with the confirmed
//! count, chmodCount / chmod through lsetstat with progress and `cancelOp`) and [`edit_file`] (readFile / statFile /
//! writeFile with stamps, the exclusive 0600 part file, the owner check and stranded results).
//!
//! T5 (port of src/sftphost/sudo.ts, src/sftphost/execSftp.ts and `startSudo` / `execSftp` of src/sftphost/host.ts):
//! [`sudo`] (the server commands and their password form, classifySudo incl. Polish, the exec channel pump that keeps
//! stdout and stderr apart, the marker-gated password write, 3 password tries).

pub mod backend;
pub mod client;
pub mod edit_file;
pub mod error;
pub mod host;
pub mod ipc;
pub mod limits;
pub mod local;
pub mod manage;
pub mod op;
pub mod proto;
pub mod queue;
pub mod remote;
pub mod service;
pub mod sides;
pub mod sudo;
pub mod targets;
pub mod throttle;
pub mod timers;

#[cfg(test)]
mod fake_server;
#[cfg(test)]
mod queue_tests;
#[cfg(test)]
mod manage_tests;
#[cfg(test)]
mod sides_tests;
