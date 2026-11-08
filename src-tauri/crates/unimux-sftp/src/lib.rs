//! SFTP service, sides, queue, manage ops, sudo over exec (T1-T5).
//!
//! T1 (port of src/main/sftp/service.ts, src/main/sftp/ipc.ts, src/main/sftpHostClient.ts, the session half of
//! src/sftphost/host.ts and src/sftphost/throttle.ts): [`service::SftpService`] (deferred login, sudo decided once, the
//! start folder, the idle disconnect with the view / queue / pins per window), [`ipc`] (the `sftp:*` channels with 1.1.4's
//! zod validation), [`host::SftpHost`] (sessions on russh through S3's login, the `sftp` subsystem, the transfer port with
//! [`throttle::ItemThrottle`], crash supervision) and the [`host::SftpBackend`] slot T2-T5 fill (the SFTP client and the
//! local side, the queues, the manage ops and editor files, SFTP through sudo).

pub mod error;
pub mod host;
pub mod ipc;
pub mod limits;
pub mod op;
pub mod service;
pub mod throttle;
pub mod timers;
