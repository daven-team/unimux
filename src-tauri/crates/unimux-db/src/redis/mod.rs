//! D9: Redis sessions and browsing on the own RESP2 client (SP9 decided against the redis crate; see
//! docs/tauri/spikes/SP9.md). Ports src/dbhost/redisSession.ts (`openRedis`, `RedisSession`) and the Redis half of
//! src/dbhost/host.ts.
//!
//! - [`connect`]: streams (TCP / the SSH tunnel's channel, TLS), the 1.1.4 connect sequence, error codes, and
//!   [`connect::RedisClient`] (the ioredis client: reconnect x3 after 300 / 1000 / 2000 ms, nothing resent, the DB selected
//!   again after a reconnect).
//! - [`session`]: [`session::RedisSession`] (main lane with the 60 s watchdog, console lane, databases / select / scan /
//!   keyInfo / read / readItem / info / slowlog / clients / cancel; D10 adds writes, the console, pattern operations and
//!   Pub/Sub).
//! - [`host`]: [`host::RedisHost`], the [`crate::host::DbHostLink`] that opens Redis sessions (password prompts, TLS
//!   modes, tunnels through [`host::DbTunnels`]) and hands every other kind to the next link.
//! - [`tls`], [`data`]: TLS set-up and the byte / number helpers.

pub mod connect;
pub mod data;
pub mod host;
pub mod session;
pub mod tls;
