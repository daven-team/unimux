# SP9: DB wire fidelity (spike result)

Date: 2026-11-06. Branch `tauri-pkg-SP9`. Windows 11 26200, Rust 1.99.1, Docker Desktop 29.9.2 (WSL2).

Question (PLAN.md): do postgres-protocol 0.6.12, mysql_common 0.38.2 and redis 1.8.1 over our own streams give the values,
logins and connection behaviour of 1.1.4 (node-postgres 8.23 + pg-cursor 2.22, mysql2 3.24 with `typeCast: false`,
ioredis 6.0 with `callBuffer`)? Acceptance: value goldens byte-identical to 1.1.4, or a documented custom path per gap.

**Answer: yes, byte-identical on every golden, with four custom paths (all implemented and tested here).**

| driver | verdict | custom path |
|---|---|---|
| postgres-protocol 0.6.12 | used for all frontend messages, MD5 / SCRAM-SHA-256, DataRow and the other backend messages | own parse of `K` BackendKeyData (3.2 keys), `v` NegotiateProtocolVersion, and lossy UTF-8 decoding of `T` / `E` / `N` / `S` / `C` like Node |
| mysql_common 0.38.2 (default features off + flate2 `rust_backend`) | used for the handshake, HandshakeResponse41, the auth plugins (`AuthProc`), AuthSwitch, OK / EOF / ERR | own packet framing, COM_QUERY (query-attribute prefix, text in the session's client charset), own column definition parser (MariaDB extended metadata, names in the column charset), LOAD DATA LOCAL answered like mysql2 |
| redis 1.8.1 | **not used** (dev-dependency only, to show the gaps) | own client in `wire::redis`: resumable RESP2 reader, writer, `RedisConn` (FIFO of pending replies, the 1.1.4 connect sequence, fail-all-pending on a drop, no resend) and the `reconnect` loop (300 / 1000 / 2000 ms) |

## How it is checked

- `test/db-wire-sp9.int.test.ts` (vitest) runs a corpus through the **real 1.1.4 DB host** (`src/dbhost`, via
  `test/helpers/dbHarness.ts`) and through the bare drivers, and writes `test/golden/db-wire/*.jsonl` (`MC_SP9_WRITE=1`)
  or checks them. Corpora: `pg-corpus.json` (39 statements incl. a SQL_ASCII database, COPY FROM STDIN and an error
  whose 4,000-unit cut splits a surrogate pair), `mysql-corpus.json` (29, incl. LOAD DATA LOCAL INFILE and a
  `SET NAMES latin1` session), `redis-corpus.json` (39 console commands, incl. error replies over 4,000 units). Lines
  longer than 8 KiB are stored as SHA-256 + UTF-16 length.
- `src-tauri/crates/unimux-db/tests/wire_servers.rs` runs the same corpora with the Rust spike clients
  (`src-tauri/crates/unimux-db/src/wire/`) and builds the same JSON text (JSON.stringify form) line by line; equality is
  checked on the whole line (or its hash). The host lines follow pgSession's path choice (`returnsRows`: a cursor for
  row statements, a simple query for the rest) and its error codes (57014 -> `cancelled`).
- `node scripts/spike-db-wire.mjs [--write] [--keep] [--only=pg18,...]` starts own containers (postgres:13, postgres:18,
  mysql:8.4, mariadb:11, redis:8 on 127.0.0.1 random ports, `--rm`, label `unimux-sp9=<pid>`), runs both and removes
  exactly those containers by id, also on Ctrl+C (SIGINT / SIGTERM / SIGHUP handler).
- The 8 server tests are `#[ignore]`d, so a plain `cargo test -p unimux-db` reports them as ignored, not passed; the
  script runs them with `--include-ignored` and name filters for the kinds it started, and a server test without a
  server of its kind fails.
- Offline (always in `cargo test`): `utf8-decode.jsonl` (Node `Buffer.toString('utf8')` / `isUtf8` on 20 invalid and
  valid byte sequences, `toValue` on long texts incl. a cut inside a surrogate pair) and 27 unit tests in `wire/`
  (incl. a 500,000-element array fed in 16 KiB chunks, the own Redis connection over an in-memory stream and the
  reconnect delays on a paused clock).

Result of the last full run from fresh containers (check mode, goldens unchanged): vitest 13/13, cargo wire_servers 9/9
(all of them run, none ignored).

| check | servers | result |
|---|---|---|
| PG values, both paths (the 1.1.4 host path: pg-cursor for row statements, simple query for the rest; plain simple query) | 13.23, 18.6 | 39/39 lines identical each |
| PG startup message bytes | 13, 18 | identical to node-postgres (`user`, `database`, `application_name=unimux`, `client_encoding=UTF8`, 3.0) |
| PG logins: md5, SCRAM with a SASLprep-sensitive password (raw and NFKC form), wrong password | 13, 18 | identical outcome and message (PG 18's default pg_hba refuses the md5-stored role for both clients) |
| PG CancelRequest 3.0 and 3.2, pg_cancel_backend side connection | 13, 18 | 57014 every time, 5-41 ms after the cancel |
| MySQL / MariaDB values, column names, typeName / kind (test port of `mysqlFieldKind`), command / rowCount, errors | 8.4.13, 11.8.9 | 28/28 and 29/29 lines identical |
| caching_sha2_password full auth over plain TCP (RSA public key request), then the fast path | 8.4 | works (full 9-19 ms, fast 3-30 ms); mysql2 does the same |
| Redis console replies (own `RedisConn`, opened with the connect sequence) | 8 | 39/39 identical |
| Redis console replies through the redis crate | 8 | 37/39: the 2 non-UTF-8 status / error lines kill the connection |
| Redis connect sequence bytes written by `RedisConn::open` (default user; ACL user on DB 2) | 8 | identical to ioredis + openRedis |
| Redis drop / reconnect x3 (300 / 1000 / 2000 ms) without resend, over `RedisConn` + `wire::redis::reconnect` | 8 | as 1.1.4 (see below) |

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
   this** (serde_json cannot hold a lone surrogate); the `DbValue::write_json` writer is the template. The same JS cut is
   applied to **every `DB_LIMITS.serverText` (4,000) text**, not only cells: pgSession `cap()` (error message, detail,
   hint, severity) and notices, mysqlSession `mysqlServerError` and warnings, redisSession error replies. They go through
   `wire::value::server_text` (a `Head`) and `write_head` (goldens `error_long_split_pair` for PG and Redis).
7. **COPY FROM STDIN** (1.1.4 runs it as a simple query): node-postgres answers CopyInResponse with CopyFail
   `No source stream defined`, the server reports `57014 COPY from stdin failed: No source stream defined`, and
   pgSession maps 57014 to `cancelled`. The Rust client sends the same CopyFail text (golden `copy_in`); D4 keeps the
   text and the code mapping.
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
   sends `unimux` / crate version, visible only in performance_schema), whether to keep advertising `LOCAL_FILES` (see
   8), and TLS / SSL request (`SslRequest` from mysql_common is ready to use).
8. **LOAD DATA LOCAL INFILE**: mysql2 3.24 without `infileStreamFactory` answers the server's request (0xfb) with an
   empty packet, reads the server's OK and still fails the statement with `As a result of LOCAL INFILE command server
   wants to read <file> file, but as of v2.0 you must provide streamFactory option returning ReadStream.` (an Error
   without errno, which mysqlSession reports as `dbClosed` with no server text; the session stays usable). The Rust
   client does the same (`MyResult::ClientError`, golden `load_local_infile` on MariaDB, where `local_infile` is on;
   MySQL 8.4 refuses earlier with 3948 for both clients).
9. **Session charset**: mysql2 follows `character_set_client` from the OK packet's session-state tracking (after
   `SET NAMES` / `SET CHARACTER SET`), encodes later COM_QUERY text in that charset's encoding and decodes column names
   in the column definition's charset (the client encoding for `binary`); cell values stay UTF-8 in mysqlSession. The
   Rust client does the same (`wire::mycharset`, mysql2's charset tables; golden `latin1_session`: `HEX('é')` is `E9`,
   the name is `éx`). Converted like Node: utf8, latin1 / binary, ascii, ucs2 / utf16-le, cesu8 (utf8mb3). The other
   encodings mysql2 hands to iconv-lite (cp1250, koi8r, sjis, big5 ...) are refused for queries by the spike and their
   names are read as UTF-8: **D7 adds iconv-lite's tables** (encoding_rs differs from iconv-lite at unmapped bytes).

7. Plugins mysql2 3.24 has: caching_sha2_password, mysql_native_password, mysql_clear_password, sha256_password. It has
   no client_ed25519, so 1.1.4 cannot log in to a MariaDB ed25519 account; PLAN D7 lists ed25519, which would be new
   behaviour and needs mysql_common's `client_ed25519` feature (off here; without it `AuthProc` answers
   `FeatureRequired`).

## Findings, Redis

1. **The redis crate is not a fit; D9 / D10 use an own RESP2 client** (`wire::redis`: `RespReader`, `encode_command`,
   `RedisConn`, `reconnect`, the `reply` port), measured on the crate:
   - status and error lines are decoded with `str::from_utf8`; a line that is not UTF-8 is a parse error that ends the
     connection ("Incompatible type - Parse error ... invalid utf-8 sequence"): `EVAL "return redis.status_reply(ARGV[1])" 0 \xff`
     and the same with `error_reply`. ioredis keeps the bytes (`{t:'bulk', v:{b64:'/w=='}}`, `ERR �`).
   - the default response timeout is 500 ms (`BLPOP k 1` fails after 507 ms); the console allows 30 s to 5 min.
   - it sends `CLIENT SETINFO LIB-NAME/LIB-VER` unless told not to, retries AUTH without the user name on some errors,
     and its disconnect notice (push sender) exists only for RESP3; 1.1.4 speaks RESP2.
   - multiplexing RESP2 is a FIFO of pending replies, so an own client is small (`RedisConn` is one driver task that
     owns the stream, writes in call order and hands replies out in the same order).
2. **Replies**: the port of `RedisSession.reply` (simple vs bulk by the status flag, 1 MiB bulk cut moved back to a UTF-8
   character start, base64 for non-UTF-8, node budget, error text cut at 4,000 UTF-16 units keeping a split high
   surrogate like JS) matches all 39 commands, read by `RedisConn`. The console sends the command name in lower case
   (`argv[0].toLowerCase()`), which shows in error texts (`ERR unknown command 'nopecmd'`); D10 must keep that.
3. **Connect sequence**: ioredis + openRedis write, in lower case, `auth [user] pw`, `client setname unimux`, `ping`,
   `select n` (n > 0), `info server`; nothing else (no SETINFO, no ready check). `RedisConn::open` writes the same bytes
   (golden `redis8-connect.jsonl`, through `wire::tap`); a wrong password stops at AUTH with the server's `WRONGPASS`.
   On a reconnect ioredis sends only its handshake again (`auth`, `client setname unimux`) and, from readyHandler,
   `select` of the DB the dropped connection had selected; `reconnect_sequence` follows event_handler.js, the golden
   for it is D9's (1.1.4's retry control lives inside RedisSession, so the SP9 harness cannot drive it alone).
4. **Drop and reconnect** (`RedisConn` + `wire::redis::reconnect`, measured through a switchable TCP proxy): a pending
   command fails at once (`CallError::Dropped`, 0 ms after the drop) and is never written again (one `blpop` in the
   written bytes); the drop is seen by the driver's read without any command in flight (0 ms); a command on the dropped
   connection is refused at once (`NotWritable`, ioredis `enableOfflineQueue: false`). The texts are ioredis': a
   pending command gets `Reached the max retries per request limit (which is 0) ...` when a retry follows
   (`maxRetriesPerRequest: 0`) and `Connection is closed.` when not, a later one `Stream isn't writeable and
   enableOfflineQueue options is false` (`CallError::message`). Attempt n is announced at once (ioredis calls
   retryStrategy in its close handler) and tried after 300 / 1000 / 2000 ms: reconnected on attempt 2 at 1.32 s when
   the server came back after 0.8 s; closed after 3 refused attempts at 3.32-3.33 s. The own client has no response
   timeout (a 1 s BLPOP returns null after 1 s); the console's timeouts are D10's.
5. **Reader cost**: `RespReader` is resumable like the ioredis 6 decoder (consumed bytes leave the buffer, a partly read
   array waits on a stack, the CRLF search resumes where it stopped). A 500,000-element array (9.5 MB) in 16 KiB chunks
   takes well under a second (unit test with a 5 s bound; the first spike reader re-parsed from byte 0 on every read and
   needed 9 s for it).

## Decisions

| decision | effect |
|---|---|
| Postgres: postgres-protocol + own frame layer for `K`, `v`, `T`, `E`, `N`, `S`, `C`; protocol 3.0 pinned | D4 builds on `wire::pg` |
| MySQL: mysql_common (handshake, auth, OK/ERR) + own framing, COM_QUERY and column parser; mysql2's flag set, its session charset tracking and its LOAD DATA LOCAL answer | D7 builds on `wire::mysql`; `mysql_common` with `default-features = false` and `flate2` `rust_backend` (no C zlib build) |
| Redis: own RESP2 client, no redis crate in the shipped app | D9 / D10 build on `wire::redis`; ARCHITECTURE section 2 and PLAN D9 updated |
| DB port JSON goes through a writer that can emit a lone surrogate escape | D4 / D7 / D12 |

## Not covered here (owned by later packages)

- TLS for all three (rustls over the same streams): D4 / D7 / D9. MySQL 9 and Valkey are not in the matrix yet (D7 / D9
  add them to their Docker matrices).
- Throughput (100k-row results, Channel pressure) and the session logic around the wire (statement splitting, cursors,
  read-only, timeouts, KILL QUERY): D4-D10, R2.
- SSH tunnels as the stream: D2 (the clients are generic over `AsyncRead + AsyncWrite`, nothing TCP-specific).
