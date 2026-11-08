//! The console connection's operations (`command`, `countPattern`, `deletePattern` of src/dbhost/redisSession.ts): console
//! commands with the strict read-only check (refused lists, then the server's command table), the confirmation of dangerous
//! commands and of collection reads with a very big reply, the reply as `RedisReply`; pattern counts that hand out a
//! one-time token and pattern deletes bounded by the counted number plus a small slack.

use std::collections::HashSet;
use std::future::Future;
use std::time::Duration;

use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};

use super::{CommandInfo, OpError, OpResult, PatternToken, RedisSession, ServerError, bool_of, f64_of, num, str_of};
use crate::redis::connect::{CmdError, RedisClient, js_head};
use crate::redis::data::{blob, from_data, int, text};
use crate::redis_shared::{READ_COMMANDS, RedisData, Refusal, classify_command, read_only_refused};
use crate::sql::values::js_to_number;
use crate::wire::redis::Raw;

/// `Math.min` (NaN wins, unlike `f64::min`).
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// `Number(buf?.toString())`: a missing argument is NaN.
fn arg_number(a: Option<&Vec<u8>>) -> f64 {
    a.map_or(f64::NAN, |b| js_to_number(&String::from_utf8_lossy(b)))
}

fn upper(a: &[u8]) -> String {
    String::from_utf8_lossy(a).to_uppercase()
}

/// The 64-bit key id a pattern count deduplicates on (the first 16 hex digits of SHA-1, as 1.1.4).
fn key_id(k: &[u8]) -> u64 {
    let d = Sha1::digest(k);
    u64::from_be_bytes(d[..8].try_into().expect("sha1 has 20 bytes"))
}

/// `REDIS_READ_COMMANDS` has the name, or (without a subcommand) its first word.
fn known_read(name: &str, sub: Option<&str>) -> bool {
    let first = name.split(' ').next().unwrap_or("");
    READ_COMMANDS.contains(&name) || (sub.is_none() && READ_COMMANDS.contains(&first))
}

/// The strict read-only check: the refused lists; then the server's command table (write, may_replicate and admin refused
/// unless a known read; unknown commands refused); a subcommand without its own entry, or no COMMAND INFO at all: only
/// known reads. `info`: None = not allowed to ask (undefined), Some(None) = the server does not know it (null).
fn only_reads(info: Option<&Option<CommandInfo>>, name: &str, sub: Option<&str>) -> bool {
    let first = name.split(' ').next().unwrap_or("");
    if read_only_refused(name) || read_only_refused(first) {
        return false;
    }
    let known = known_read(name, sub);
    let Some(info) = info else { return known };
    let Some(info) = info else { return false };
    if sub.is_some() && !info.sub_found {
        return known;
    }
    let has = |f: &str| info.flags.iter().any(|x| x == f);
    if has("write") || has("may_replicate") {
        return false;
    }
    if has("admin") && !known {
        return false;
    }
    true
}

fn error_reply(message: &str, time_ms: f64, db: u32) -> Value {
    json!({ "reply": { "t": "error", "v": message }, "timeMs": num(time_ms), "db": db })
}

impl RedisSession {
    pub(super) async fn run_console(&self, kind: &str, op: &Value, generation: u64, deadline: Option<f64>) -> OpResult<Value> {
        match kind {
            "command" => self.command(op.get("req").unwrap_or(&Value::Null), deadline).await,
            "countPattern" => self.count_pattern(str_of(op, "match").unwrap_or(""), str_of(op, "type"), generation).await,
            "deletePattern" => {
                self.writable()?;
                self.delete_pattern(str_of(op, "token").unwrap_or(""), generation).await
            }
            _ => Err(OpError::Code("invalid", None)),
        }
    }

    fn cancelled(&self, generation: u64) -> bool {
        let st = self.state.lock();
        st.cancel_gen != generation || st.ended
    }

    /// One console-connection step bounded by `opTimeoutMs` (a hang drops that connection, never the browser's).
    async fn console_step<T, F, Fut>(&self, f: F) -> OpResult<T>
    where
        F: FnOnce(RedisClient) -> Fut,
        Fut: Future<Output = OpResult<T>>,
    {
        let c = self.console_cmd().await?;
        match tokio::time::timeout(Duration::from_millis(self.opts.limits.op_timeout_ms.max(1)), f(c)).await {
            Ok(r) => r,
            Err(_) => {
                self.drop_console();
                Err(OpError::Code("dbTimeout", None))
            }
        }
    }

    // ── pattern counts and deletes ─────────────────────────────────────────────

    async fn count_pattern(&self, pattern: &str, ty: Option<&str>, generation: u64) -> OpResult<Value> {
        // Keys are deduplicated on a 64-bit hash (SCAN may return a key twice): memory stays small even near the cap.
        let mut ids: HashSet<u64> = HashSet::new();
        let mut cursor = "0".to_owned();
        let mut complete = true;
        loop {
            if self.cancelled(generation) {
                return Err(OpError::Code("cancelled", None));
            }
            let at = cursor.clone();
            let (next, keys) =
                self.console_step(|c| async move { self.scan_once(&c, &at, Some(pattern), 1000.0, ty).await }).await?;
            cursor = next;
            ids.extend(keys.iter().map(|k| key_id(k)));
            if ids.len() >= self.opts.limits.count_keys {
                complete = cursor == "0";
                break;
            }
            if cursor == "0" {
                break;
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        let count = ids.len();
        {
            let mut st = self.state.lock();
            let db = st.db;
            st.pattern_token = Some(PatternToken {
                token: token.clone(),
                pattern: pattern.to_owned(),
                ty: ty.filter(|t| !t.is_empty()).map(str::to_owned),
                db,
                count,
                at: self.now(),
            });
        }
        Ok(json!({ "token": token, "count": count, "complete": complete }))
    }

    /// Deletes what matches the counted pattern, at most the confirmed count plus a small slack: keys created after the
    /// count can only be deleted after another count. The token is used once and is valid for `tokenTtlMs`.
    async fn delete_pattern(&self, token: &str, generation: u64) -> OpResult<Value> {
        let l = &self.opts.limits;
        let t = {
            let mut st = self.state.lock();
            let valid = st
                .pattern_token
                .as_ref()
                .is_some_and(|t| t.token == token && t.db == st.db && self.now() - t.at <= l.token_ttl_ms);
            if !valid {
                return Err(OpError::Code("staleToken", None));
            }
            st.pattern_token.take().expect("checked above")
        };
        let count = t.count as f64;
        let cap = (count + l.delete_slack_min.max((count * l.delete_slack).ceil())) as usize;
        let result =
            |deleted: f64, cancelled: bool, more: bool| json!({ "deleted": num(deleted), "cancelled": cancelled, "more": more });
        let mut deleted = 0.0;
        let mut sent = 0usize;
        let mut cursor = "0".to_owned();
        loop {
            if self.cancelled(generation) {
                return Ok(result(deleted, true, true));
            }
            let at = cursor.clone();
            let (pattern, ty) = (t.pattern.as_str(), t.ty.as_deref());
            let (next, keys) =
                self.console_step(|c| async move { self.scan_once(&c, &at, Some(pattern), 1000.0, ty).await }).await?;
            cursor = next;
            let room = cap.saturating_sub(sent);
            let batch = &keys[..keys.len().min(room)];
            if !batch.is_empty() {
                sent += batch.len();
                for part in batch.chunks(l.delete_batch.max(1)) {
                    if self.cancelled(generation) {
                        return Ok(result(deleted, true, true));
                    }
                    deleted += self.console_step(|c| async move { self.unlink_keys(&c, part).await }).await?;
                }
            }
            if keys.len() > room {
                return Ok(result(deleted, false, true));
            }
            if sent >= cap && cursor != "0" {
                return Ok(result(deleted, false, true));
            }
            if cursor == "0" {
                break;
            }
        }
        Ok(result(deleted, false, false))
    }

    // ── console ────────────────────────────────────────────────────────────────

    /// COMMAND INFO of a command (and subcommand): None = not allowed (no more asking), Some(None) = the server does not
    /// know it.
    async fn info_of(&self, c: &RedisClient, name: &str, sub: Option<&str>) -> Option<Option<CommandInfo>> {
        let id = match sub {
            Some(s) => format!("{name}|{s}"),
            None => name.to_owned(),
        };
        {
            let st = self.state.lock();
            if !st.command_info {
                return None;
            }
            if let Some(i) = st.infos.get(&id) {
                return Some(i.clone());
            }
        }
        let r = match c.call(&[b"command", b"info", name.as_bytes()]).await {
            Ok(r) => r,
            Err(_) => {
                self.state.lock().command_info = false;
                return None;
            }
        };
        let entry = match &r {
            Raw::Array(a) => match a.first() {
                Some(Raw::Array(e)) => Some(e),
                _ => None,
            },
            _ => None,
        };
        let Some(entry) = entry else {
            self.state.lock().infos.insert(id, None);
            return Some(None);
        };
        let list = |x: Option<&Raw>| -> Vec<String> {
            match x {
                Some(Raw::Array(a)) => a.iter().map(|f| text(f).to_lowercase()).collect(),
                _ => Vec::new(),
            }
        };
        let mut info = CommandInfo { flags: list(entry.get(2)), categories: list(entry.get(6)), sub_found: false };
        if sub.is_some()
            && let Some(Raw::Array(subs)) = entry.get(9)
        {
            let found = subs.iter().find_map(|x| match x {
                Raw::Array(s) if s.first().is_some_and(|n| text(n).to_lowercase() == id) => Some(s),
                _ => None,
            });
            if let Some(s) = found {
                info = CommandInfo { flags: list(s.get(2)), categories: list(s.get(6)), sub_found: true };
            }
        }
        self.state.lock().infos.insert(id, Some(info.clone()));
        Some(Some(info))
    }

    /// Collection reads that would bring back a very big reply: their size is checked first (needsConfirm above the
    /// limits). Any failure while checking: not big.
    async fn big_read(&self, c: &RedisClient, argv: &[Vec<u8>], name: &str) -> bool {
        self.big_read_inner(c, argv, name).await.unwrap_or(false)
    }

    async fn big_read_inner(&self, c: &RedisClient, argv: &[Vec<u8>], name: &str) -> Result<bool, CmdError> {
        let Some(k) = argv.get(1) else { return Ok(false) };
        let items = self.opts.limits.console_items_confirm;
        let bytes = self.opts.limits.console_bytes_confirm;
        let n = |v: Raw| int(&v);
        let memory = || async { self.memory_of(c, k).await.unwrap_or(0.0) > bytes };
        let has_word = |w: &str| argv.iter().any(|a| upper(a) == w);
        Ok(match name {
            "GET" | "GETEX" | "GETDEL" | "DUMP" => {
                n(c.call(&[b"strlen", k]).await?) > bytes || (name == "DUMP" && memory().await)
            }
            "MGET" => {
                let mut sum = 0.0;
                for key in argv.iter().skip(1).take(10_000) {
                    sum += c.call(&[b"strlen", key]).await.map_or(0.0, n);
                    if sum > bytes {
                        return Ok(true);
                    }
                }
                false
            }
            "HGETALL" | "HKEYS" | "HVALS" => n(c.call(&[b"hlen", k]).await?) > items || memory().await,
            "SMEMBERS" => n(c.call(&[b"scard", k]).await?) > items || memory().await,
            "SINTER" | "SUNION" | "SDIFF" => {
                let mut sum = 0.0;
                for key in argv.iter().skip(1).take(1000) {
                    sum += c.call(&[b"scard", key]).await.map_or(0.0, n);
                }
                sum > items
            }
            "LRANGE" => {
                let len = n(c.call(&[b"llen", k]).await?);
                let (mut a, mut b) = (arg_number(argv.get(2)), arg_number(argv.get(3)));
                if !a.is_finite() || !b.is_finite() {
                    return Ok(false);
                }
                if a < 0.0 {
                    a = (len + a).max(0.0);
                }
                if b < 0.0 {
                    b += len;
                }
                let count = (js_min(b, len - 1.0) - a + 1.0).max(0.0);
                if count > items {
                    return Ok(true);
                }
                // Few but big elements: the average element size from MEMORY USAGE times the range.
                let mem = if len > 0.0 && count > 0.0 { self.memory_of(c, k).await.unwrap_or(0.0) } else { 0.0 };
                len > 0.0 && (mem / len) * count > bytes
            }
            "ZRANGE" | "ZREVRANGE" | "ZRANGEBYSCORE" | "ZREVRANGEBYSCORE" | "ZRANGEBYLEX" | "ZREVRANGEBYLEX" => {
                (n(c.call(&[b"zcard", k]).await?) > items && !has_word("LIMIT")) || memory().await
            }
            "XRANGE" | "XREVRANGE" => {
                let at = argv.iter().position(|a| upper(a) == "COUNT");
                let limit = match at {
                    Some(i) if i > 0 => arg_number(argv.get(i + 1)),
                    _ => f64::INFINITY,
                };
                js_min(limit, n(c.call(&[b"xlen", k]).await?)) > items || (limit > items && memory().await)
            }
            _ => false,
        })
    }

    /// `RedisSession.reply`: the reply as `RedisReply`, at most `replyNodes` nodes, bulk strings cut at `replyBulkBytes`.
    fn reply_json(&self, v: &Raw, status: bool, budget: &mut i64, top: bool) -> Value {
        *budget -= 1;
        match v {
            Raw::Null => json!({ "t": "null" }),
            Raw::Error(m) => json!({ "t": "error", "v": js_head(m, 4000) }),
            Raw::Integer(s) => json!({ "t": "integer", "v": s }),
            Raw::Bytes(b) => {
                if top
                    && status
                    && b.len() < 1024
                    && let Ok(s) = std::str::from_utf8(b)
                {
                    return json!({ "t": "simple", "v": s });
                }
                let blob = blob(b, self.opts.limits.reply_bulk_bytes);
                let mut m = Map::new();
                m.insert("t".into(), json!("bulk"));
                m.insert("v".into(), blob["data"].clone());
                m.insert("bytes".into(), blob["bytes"].clone());
                if blob.get("truncated").is_some() {
                    m.insert("truncated".into(), Value::Bool(true));
                }
                Value::Object(m)
            }
            Raw::Array(items) => {
                let mut out = Vec::new();
                for x in items {
                    if *budget <= 0 {
                        break;
                    }
                    out.push(self.reply_json(x, status, budget, false));
                }
                json!({ "t": "array", "items": out, "length": items.len() })
            }
        }
    }

    async fn command(&self, req: &Value, deadline: Option<f64>) -> OpResult<Value> {
        let raw_argv = req.get("argv").and_then(Value::as_array).cloned().unwrap_or_default();
        if !raw_argv.first().is_some_and(Value::is_string) {
            return Err(OpError::Code("invalid", None));
        }
        let data: Vec<RedisData> =
            raw_argv.iter().map(|a| RedisData::from_json(a).unwrap_or(RedisData::Text(String::new()))).collect();
        let cls = classify_command(&data);
        if let Some(r) = cls.refused {
            return Err(OpError::Code(
                match r {
                    Refusal::Blocking => "blockingCommand",
                    Refusal::Subscribe => "subscribeCommand",
                    _ => "consoleUnsupported",
                },
                None,
            ));
        }
        let confirmed = bool_of(req, "confirmed");
        let read_write = bool_of(req, "readWrite");
        if cls.dangerous && !confirmed {
            return Err(OpError::Code("needsConfirm", None));
        }
        let argv: Vec<Vec<u8>> = raw_argv.iter().map(from_data).collect();
        let name = String::from_utf8_lossy(&argv[0]).to_lowercase();
        let started = self.now();
        let elapsed = || (self.now() - started) as f64;
        if name == "select" {
            let n = arg_number(argv.get(1));
            if argv.len() != 2 || n.fract() != 0.0 || !n.is_finite() || n < 0.0 {
                return Ok(error_reply("ERR value is not an integer or out of range", 0.0, self.current_db()));
            }
            // The session's DB changes on the browsing connection (its queue), the console connection follows before its next
            // command.
            let r = self.on_lane(&self.main, self.select(n)).await;
            return match r {
                Ok(_) => Ok(json!({ "reply": { "t": "simple", "v": "OK" }, "timeMs": num(elapsed()), "db": self.current_db() })),
                Err(OpError::Code(_, Some(s))) => Ok(error_reply(&s.message, elapsed(), self.current_db())),
                Err(OpError::Reply(m)) => Ok(error_reply(&ServerError::of(&m).message, elapsed(), self.current_db())),
                Err(e) => Err(e),
            };
        }
        let c = self.console_cmd().await?;
        let sub = if cls.name.contains(' ') { argv.get(1).map(|a| String::from_utf8_lossy(a).to_lowercase()) } else { None };
        let sub = sub.as_deref();
        let read_only = self.opts.read_only && !read_write;
        let info = if read_only || !confirmed { self.info_of(&c, &name, sub).await } else { None };
        if read_only && !only_reads(info.as_ref(), &cls.name, sub) {
            return Err(OpError::Code("readOnly", None));
        }
        if !confirmed {
            // A renamed dangerous command still carries its category; a huge collection read asks first.
            let known = known_read(&cls.name, sub);
            if let Some(Some(i)) = &info
                && i.categories.iter().any(|x| x == "@dangerous")
                && !known
            {
                return Err(OpError::Code("needsConfirm", None));
            }
            if self.big_read(&c, &argv, &cls.name).await {
                return Err(OpError::Code("needsConfirm", None));
            }
        }
        let l = &self.opts.limits;
        let left = deadline.map_or(f64::INFINITY, |d| d - self.now() as f64);
        let limit =
            js_min(js_min(f64_of(req, "timeoutMs").unwrap_or(l.console_timeout_ms).max(1.0), l.console_timeout_max_ms), left);
        let mut call = vec![name.into_bytes()];
        call.extend(argv[1..].iter().cloned());
        let sent = c.call_vec(&call);
        // A command that times out takes the console connection with it (a new one opens for the next command).
        let raw = match tokio::time::timeout(Duration::from_millis(limit.max(1.0) as u64), sent).await {
            Err(_) => {
                self.drop_console();
                return Err(OpError::Code("statementTimeout", None));
            }
            Ok(Ok(v)) => v,
            Ok(Err(CmdError::Reply(m))) => Raw::Error(m),
            Ok(Err(e)) => return Err(e.into()),
        };
        let mut budget = l.reply_nodes;
        let reply = self.reply_json(&raw, cls.status, &mut budget, true);
        Ok(json!({ "reply": reply, "timeMs": num(elapsed()), "db": self.current_db() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(flags: &[&str]) -> Option<CommandInfo> {
        Some(CommandInfo { flags: flags.iter().map(|s| s.to_string()).collect(), categories: Vec::new(), sub_found: false })
    }

    #[test]
    fn the_read_only_check_follows_the_command_table() {
        // no COMMAND INFO: only known reads
        assert!(only_reads(None, "GET", None));
        assert!(!only_reads(None, "SET", None));
        // refused lists win over everything
        assert!(!only_reads(Some(&info(&["readonly"])), "FLUSHALL", None));
        // the server does not know it
        assert!(!only_reads(Some(&None), "GET", None));
        assert!(!only_reads(Some(&info(&["write"])), "SET", None));
        assert!(!only_reads(Some(&info(&["may_replicate"])), "PUBLISH", None));
        assert!(only_reads(Some(&info(&["readonly", "fast"])), "MYMODULE.GET", None));
        assert!(!only_reads(Some(&info(&["admin"])), "MYADMIN", None));
        // a subcommand without its own entry: only known reads
        assert!(!only_reads(Some(&info(&[])), "CONFIG SETX", Some("setx")));
    }

    #[test]
    fn js_min_keeps_nan_and_key_ids_are_stable() {
        assert!(js_min(f64::NAN, 3.0).is_nan());
        assert_eq!(js_min(f64::INFINITY, 3.0), 3.0);
        // sha1("a") = 86f7e437faa5a7fc...
        assert_eq!(key_id(b"a"), 0x86f7_e437_faa5_a7fc);
        assert!(arg_number(None).is_nan());
        assert_eq!(arg_number(Some(&b"-3".to_vec())), -3.0);
    }
}
