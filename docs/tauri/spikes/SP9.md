# SP9: DB wire fidelity (spike result)

Date: 2026-11-06. Branch `tauri-pkg-SP9`. Windows 11 26200, Rust 1.99.1, Docker Desktop 29.9.2 (WSL2).

Question (PLAN.md): do postgres-protocol 0.6.12, mysql_common 0.38.2 and redis 1.8.1 over our own streams give the values,
logins and connection behaviour of 1.1.4 (node-postgres 8.23 + pg-cursor 2.22, mysql2 3.24 with `typeCast: false`,
ioredis 6.0 with `callBuffer`)? Acceptance: value goldens byte-identical to 1.1.4, or a documented custom path per gap.

**Answer: yes, byte-identical on every golden, with four custom paths (all implemented and tested here).**

| driver | verdict | custom path |
|---|---|---|
| postgres-protocol 0.6.12 | used for all frontend messages, MD5 / SCRAM-SHA-256, DataRow and the other backend messages | own parse of `K` BackendKeyData (3.2 keys), `v` NegotiateProtocolVersion, and lossy UTF-8 decoding of `T` / `E` / `N` / `S` / `C` like Node |
| mysql_common 0.38.2 (default features off + flate2 `rust_backend`) | used for the handshake, HandshakeResponse41, the auth plugins (`AuthProc`), AuthSwitch, OK / EOF / ERR | own packet framing, COM_QUERY (query-attribute prefix), own column definition parser (MariaDB extended metadata) |
| redis 1.8.1 | **not used** (dev-dependency only, to show the gaps) | own RESP2 reader / writer + own reconnect loop over our stream |

## How it is checked

- `test/db-wire-sp9.int.test.ts` (vitest) runs a corpus through the **real 1.1.4 DB host** (`src/dbhost`, via
  `test/helpers/dbHarness.ts`) and through the bare drivers, and writes `test/golden/db-wire/*.jsonl` (`MC_SP9_WRITE=1`)
  or checks them. Corpora: `pg-corpus.json` (37 statements incl. a SQL_ASCII database), `mysql-corpus.json` (25),
  `redis-corpus.json` (37 console commands). Lines longer than 8 KiB are stored as SHA-256 + UTF-16 length.
- `src-tauri/crates/unimux-db/tests/wire_servers.rs` runs the same corpora with the Rust spike clients
  (`src-tauri/crates/unimux-db/src/wire/`) and builds the same JSON text (JSON.stringify form) line by line; equality is
  checked on the whole line (or its hash).
- `node scripts/spike-db-wire.mjs [--write] [--keep] [--only=pg18,...]` starts own containers (postgres:13, postgres:18,
  mysql:8.4, mariadb:11, redis:8 on 127.0.0.1 random ports), runs both and removes exactly those containers by id.
- Offline (always in `cargo test`): `utf8-decode.jsonl` (Node `Buffer.toString('utf8')` / `isUtf8` on 20 invalid and
  valid byte sequences, `toValue` on long texts incl. a cut inside a surrogate pair) and 16 unit tests in `wire/`.

Result of the last full run from fresh containers (check mode, goldens unchanged): vitest 13/13, cargo wire_servers 9/9.

| check | servers | result |
|---|---|---|
| PG values, both paths (pg-cursor through the host = extended protocol, plain simple query) | 13.23, 18.6 | 37/37 lines identical each |
| PG startup message bytes | 13, 18 | identical to node-postgres (`user`, `database`, `application_name=unimux`, `client_encoding=UTF8`, 3.0) |
| PG logins: md5, SCRAM with a SASLprep-sensitive password (raw and NFKC form), wrong password | 13, 18 | identical outcome and message (PG 18's default pg_hba refuses the md5-stored role for both clients) |
| PG CancelRequest 3.0 and 3.2, pg_cancel_backend side connection | 13, 18 | 57014 every time, 5-41 ms after the cancel |
| MySQL / MariaDB values, column names, typeName / kind (test port of `mysqlFieldKind`), command / rowCount, errors | 8.4.13, 11.8.9 | 24/24 and 25/25 lines identical |
| caching_sha2_password full auth over plain TCP (RSA public key request), then the fast path | 8.4 | works (full 9-19 ms, fast 3-30 ms); mysql2 does the same |
| Redis console replies (own reader) | 8 | 37/37 identical |
| Redis console replies through the redis crate | 8 | 35/37: the 2 non-UTF-8 status / error lines kill the connection |
| Redis connect sequence bytes (default user; ACL user on DB 2) | 8 | identical to ioredis + openRedis |
| Redis drop / reconnect x3 (300 / 1000 / 2000 ms) without resend | 8 | as 1.1.4 (see below) |

## Findings, Postgres

1. **Values**: every type in the corpus comes back as the same text (numeric incl. NaN / +-Infinity on 18 and the
   error on 13, float4 / float8 shortest form, money, intervals incl. ISO input, arrays incl. NULL / quoting / bounds /
   nested, bytea hex, timestamptz in several zones, BC, infinity, timetz, jsonb normalisation, uuid, inet, ranges, xml,
   geometric types, records). The text form does not depend on the protocol path (simple vs extended) or on 3.0 vs 3.2.
   The session settings that shape it are the server defaults for both clients (`TimeZone Etc/UTC`, `DateStyle ISO, MDY`,
   `IntervalStyle postgres`, `extra_float_digits 1`, `bytea_output hex`): neither client sets them.
2. **Cell cut**: `DB_LIMITS.cellChars` counts UTF-16 code units and the JS `slice` can split a surrogate pair, leaving a
   lone high surrogate that JSON.stringify writes as `\ud83d`. `wire::value` keeps it as `Head::dangling` and writes the
   same escape (golden `long_split_pair`). **D4 / D7 / D12 must send DB port messages through a JSON writer that can do
   this** (serde_json cannot hold a lone surrogate); the `DbValue::write_json` writer is the template.
3. **Protocol 3.2 (PostgreSQL 18)**: 1.1.4 sends 3.0 and so does the Rust client (decision: keep 3.0 pinned). Under 3.0
   PG 18 sends a 4-byte key and the 3.0 CancelRequest works. Under 3.2 the key is 32 bytes; postgres-protocol's
   `Message::parse` refuses that BackendKeyData ("expected buffer to be empty") and does not know
   NegotiateProtocolVersion (PG 13 answers 3.2 with it; the "newest minor version" field is the full number 0x00030000).
   Both are parsed by our own frame layer, and `cancel_bytes` writes a CancelRequest for any key length, so a later move
   to 3.2 needs no new code.
4. **Strings in backend messages**: postgres-protocol refuses invalid UTF-8 in RowDescription names, error / notice
   fields, ParameterStatus and command tags; node-postgres decodes them lossily. A real PostgreSQL never sends invalid
   UTF-8 to a `client_encoding=UTF8` client: a SQL_ASCII database with byte 0xff in values, a column name and an error
   message answers 22021 "invalid byte sequence for encoding UTF8: 0xff" to both clients (goldens `ascii_*`). The lossy
   parse stays as a defensive path for PGlite and PG-compatible servers.
5. **SCRAM**: node-postgres runs a partial SASLprep (space mapping, mapped-to-nothing, NFKC, no prohibition check);
   postgres-protocol runs full SASLprep and falls back to the raw password when it fails, like libpq and the server.
   Both log in with `Ⅸ ﬁ x` and with its NFKC form `IX fi x`. They can only differ for a password that contains a
   SASLprep-prohibited character AND characters NFKC changes; Rust then behaves like the server (better than 1.1.4).
   Neither client uses channel binding by default (gs2 header `n`), so no SCRAM-SHA-256-PLUS until a decision says so.
6. **Environment** (parity note for D4): node-postgres fills unset fields from `PGUSER` / `USERNAME`, `PGDATABASE`,
   `PGOPTIONS`, `PGSSLMODE` and friends of the DB host's environment. 1.1.4 always passes user and database, so only
   `PGOPTIONS` (sent as `options`) could reach a server in practice. Recommendation: do not copy that (a user-level
   environment variable silently changing a session is a bug, not a feature); record it in the D4 release note list.

## Findings, MySQL / MariaDB

1. **Values**: identical for integers incl. unsigned bigint, DECIMAL(65,9), float / double text, all temporal types
   (TIME negative and fractional, YEAR, DATETIME(6), TIMESTAMP(3)), utf8mb4, latin1 columns (converted by the server),
   BIT / VARBINARY / BLOB / GEOMETRY / `_binary` as hex, JSON (MySQL normalises), ENUM / SET, CALL with two result sets,
   long values, 2,500 rows (1,000 sent, result kept open), duplicate-key / missing-table / syntax errors.
2. **Session parity comes from the client flags**, so D7 must send exactly mysql2's set: `0x08baf3cf` (LONG_PASSWORD,
   FOUND_ROWS, LONG_FLAG, CONNECT_WITH_DB, ODBC, LOCAL_FILES, IGNORE_SPACE, PROTOCOL_41, IGNORE_SIGPIPE, TRANSACTIONS,
   RESERVED, SECURE_CONNECTION, MULTI_RESULTS, SESSION_TRACK, CONNECT_ATTRS, QUERY_ATTRIBUTES, PLUGIN_AUTH,
   PLUGIN_AUTH_LENENC_CLIENT_DATA) plus MULTI_FACTOR_AUTHENTICATION when the server offers it, without DEPRECATE_EOF.
   Visible effects checked by goldens: `IGNORE_SPACE` (`COUNT (*)` works, MariaDB shows it in `@@sql_mode`),
   `FOUND_ROWS` (an UPDATE to the same value reports matched rows: 3), collation 45 (`utf8mb4_general_ci` on MySQL,
   MariaDB 11.8 maps it to `utf8mb4_uca1400_ai_ci` for both clients).
3. **MariaDB extended metadata**: mysql2 asks for MARIADB_CLIENT_EXTENDED_METADATA (and drops CLIENT_MYSQL to do so);
   1.1.4 uses it for `uuid` / `inet4` / `inet6` / `json` column kinds. mysql_common's `Column` does not read that block,
   so `wire::mysql::parse_column` is our own (golden `mariadb_types`).
4. **Logins**: `AuthProc` covers caching_sha2_password (fast path and full authentication with the RSA public key
   request and OAEP encryption over plain TCP), mysql_native_password (MariaDB default) and AuthSwitch. Over TLS the
   full path sends the password in clear (plugin code, like mysql2; not run here, D7 passes `is_tls_transport` and tests it).
5. **COM_QUERY** needs the empty query-attribute prefix (`0x00 0x01`) when CLIENT_QUERY_ATTRIBUTES is on for both sides
   (MySQL 8.4 yes, MariaDB no), as mysql2 writes it.
6. Open for D7 (decisions, not fidelity gaps): connection attributes (mysql2 sends `_client_name=Node-MySQL-2`; the spike
   sends `unimux` / crate version, visible only in performance_schema), `LOCAL_FILES` (mysql2 advertises it; the spike
   answers a LOAD DATA LOCAL request with an empty file; D7 decides whether to keep advertising it), and TLS / SSL
   request (`SslRequest` from mysql_common is ready to use).

7. Plugins mysql2 3.24 has: caching_sha2_password, mysql_native_password, mysql_clear_password, sha256_password. It has
   no client_ed25519, so 1.1.4 cannot log in to a MariaDB ed25519 account; PLAN D7 lists ed25519, which would be new
   behaviour and needs mysql_common's `client_ed25519` feature (off here; without it `AuthProc` answers
   `FeatureRequired`).

## Findings, Redis

1. **The redis crate is not a fit; D9 / D10 use an own RESP2 client** (`wire::redis::RespReader`, `encode_command`, the
   `reply` port), measured:
   - status and error lines are decoded with `str::from_utf8`; a line that is not UTF-8 is a parse error that ends the
     connection ("Incompatible type - Parse error ... invalid utf-8 sequence"): `EVAL "return redis.status_reply(ARGV[1])" 0 \xff`
     and the same with `error_reply`. ioredis keeps the bytes (`{t:'bulk', v:{b64:'/w=='}}`, `ERR �`).
   - the default response timeout is 500 ms (`BLPOP k 1` fails after 507 ms); the console allows 30 s to 5 min.
   - it sends `CLIENT SETINFO LIB-NAME/LIB-VER` unless told not to, retries AUTH without the user name on some errors,
     and its disconnect notice (push sender) exists only for RESP3; 1.1.4 speaks RESP2.
   - multiplexing RESP2 is a FIFO of pending replies, so an own client is small (the reader is about 100 lines).
2. **Replies**: the port of `RedisSession.reply` (simple vs bulk by the status flag, 1 MiB bulk cut moved back to a UTF-8
   character start, base64 for non-UTF-8, node budget, error text cut at 4,000 UTF-16 units) matches all 37 commands.
   The console sends the command name in lower case (`argv[0].toLowerCase()`), which shows in error texts
   (`ERR unknown command 'nopecmd'`); D10 must keep that.
3. **Connect sequence**: ioredis + openRedis write, in lower case, `auth [user] pw`, `client setname unimux`, `ping`,
   `select n` (n > 0), `info server`; nothing else (no SETINFO, no ready check). Byte-identical from Rust.
4. **Drop and reconnect** (own loop over the stream, measured through a switchable TCP proxy): a pending command fails at
   once ("broken pipe", 0-8 ms after the drop) and is never written again; the drop is seen by the stream wrapper
   (`wire::tap`, EOF) and by the driver ending, without any command in flight; attempts after 300 / 1000 / 2000 ms
   (measured 306-341, 1313-1349 ms), reconnected on attempt 2 when the server came back, closed after 3 refused
   attempts at 3.3-3.4 s. A command on the dropped connection fails at once, which is what ioredis does with `enableOfflineQueue: false` (the reconnecting state itself is D9's).

## Decisions

| decision | effect |
|---|---|
| Postgres: postgres-protocol + own frame layer for `K`, `v`, `T`, `E`, `N`, `S`, `C`; protocol 3.0 pinned | D4 builds on `wire::pg` |
| MySQL: mysql_common (handshake, auth, OK/ERR) + own framing, COM_QUERY and column parser; mysql2's flag set | D7 builds on `wire::mysql`; `mysql_common` with `default-features = false` and `flate2` `rust_backend` (no C zlib build) |
| Redis: own RESP2 client, no redis crate in the shipped app | D9 / D10 build on `wire::redis`; ARCHITECTURE section 2 and PLAN D9 updated |
| DB port JSON goes through a writer that can emit a lone surrogate escape | D4 / D7 / D12 |

## Not covered here (owned by later packages)

- TLS for all three (rustls over the same streams): D4 / D7 / D9. MySQL 9 and Valkey are not in the matrix yet (D7 / D9
  add them to their Docker matrices).
- Throughput (100k-row results, Channel pressure) and the session logic around the wire (statement splitting, cursors,
  read-only, timeouts, KILL QUERY): D4-D10, R2.
- SSH tunnels as the stream: D2 (the clients are generic over `AsyncRead + AsyncWrite`, nothing TCP-specific).
