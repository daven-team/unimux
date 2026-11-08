//! Writes on the main connection (`RedisSession.write`, `atomically`, `guarded`, `setString`, `create`, `unlinkKeys` of
//! src/dbhost/redisSession.ts). A write that must not create or change a key that changed meanwhile runs as WATCH key, a
//! check, MULTI ... EXEC; a null EXEC (the key changed between the check and EXEC) is a `conflict` (`keyExists` for a
//! create). Every check is an `async` block, so its commands are only sent after the WATCH.

use std::future::Future;

use serde_json::{Value, json};

use super::{OpError, OpResult, RedisSession, bool_of, contains_ci, f64_of, reply_message, str_of};
use crate::redis::connect::{CmdError, RedisClient};
use crate::redis::data::{as_buffer, from_data, int, js_num, num, text};
use crate::wire::redis::Raw;

type Argv = Vec<Vec<u8>>;

fn data_list(v: Option<&Value>) -> Vec<Vec<u8>> {
    v.and_then(Value::as_array).map(|a| a.iter().map(from_data).collect()).unwrap_or_default()
}

/// `[a, b]` pairs (hash / stream fields, zset entries).
fn pair_list(v: Option<&Value>) -> Vec<(&Value, &Value)> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_array())
                .map(|p| (p.first().unwrap_or(&Value::Null), p.get(1).unwrap_or(&Value::Null)))
                .collect()
        })
        .unwrap_or_default()
}

fn str_bytes(v: &Value) -> Vec<u8> {
    v.as_str().unwrap_or("").as_bytes().to_vec()
}

/// A JS-truthy number (`if (w.ttlMs)`).
fn truthy(n: Option<f64>) -> Option<f64> {
    n.filter(|t| *t != 0.0 && !t.is_nan())
}

fn changed(v: &Raw) -> Value {
    json!({ "changed": num(int(v)) })
}

fn changed_one() -> Value {
    json!({ "changed": 1 })
}

impl RedisSession {
    /// WATCH key, check, MULTI ... EXEC; a null EXEC (the key changed meanwhile) is `on_abort`. The commands may be built
    /// from what the check found.
    async fn atomically<T>(
        &self,
        key: &[u8],
        check: impl Future<Output = OpResult<T>>,
        commands: impl FnOnce(T) -> Vec<Argv>,
        on_abort: &'static str,
    ) -> OpResult<Vec<Raw>> {
        self.cmd(&[b"watch", key]).await?;
        let list = match check.await {
            Ok(t) => commands(t),
            Err(e) => {
                let _ = self.cmd(&[b"unwatch"]).await;
                return Err(e);
            }
        };
        self.cmd(&[b"multi"]).await?;
        for x in &list {
            if let Err(e) = self.cmd_vec(x).await {
                let _ = self.cmd(&[b"discard"]).await;
                return Err(e);
            }
        }
        match self.cmd(&[b"exec"]).await? {
            Raw::Null => Err(OpError::Code(on_abort, None)),
            Raw::Array(r) => {
                if let Some(Raw::Error(m)) = r.iter().find(|x| matches!(x, Raw::Error(_))) {
                    return Err(OpError::Reply(m.clone()));
                }
                Ok(r)
            }
            _ => Err(OpError::Conn),
        }
    }

    /// The key holds `ty` (else wrongType); missing: notFound, or fine when `allow_missing`.
    async fn expect_type(&self, key: &[u8], ty: &str, allow_missing: bool) -> OpResult<()> {
        let t = text(&self.cmd(&[b"type", key]).await?);
        if t == "none" {
            return if allow_missing { Ok(()) } else { Err(OpError::Code("notFound", None)) };
        }
        if t != ty {
            return Err(OpError::Code("wrongType", None));
        }
        Ok(())
    }

    /// A write that would create the key: with `existing` it runs only while the key still exists with that type.
    async fn guarded(&self, key: &[u8], ty: &str, existing: bool, command: Argv) -> OpResult<Raw> {
        if !existing {
            return self.cmd_vec(&command).await;
        }
        let r = self.atomically(key, async { self.expect_type(key, ty, false).await }, |()| vec![command], "conflict").await?;
        Ok(r.into_iter().next().unwrap_or(Raw::Null))
    }

    async fn set_string(&self, key: &[u8], w: &Value) -> OpResult<()> {
        let value = from_data(w.get("value").unwrap_or(&Value::Null));
        // existing: the edit comes from an open value view; a key that expired or was deleted meanwhile is not created again.
        let allow_missing = !bool_of(w, "existing");
        let set = |extra: &[&[u8]]| -> Argv {
            let mut a = vec![b"set".to_vec(), key.to_vec(), value.clone()];
            a.extend(extra.iter().map(|x| x.to_vec()));
            a
        };
        if let Some(ttl) = truthy(f64_of(w, "ttlMs")) {
            let cmd = set(&[b"PX", js_num(ttl).as_bytes()]);
            self.atomically(key, async { self.expect_type(key, "string", allow_missing).await }, |()| vec![cmd], "conflict")
                .await?;
            return Ok(());
        }
        if w.get("keepTtl") == Some(&Value::Bool(false)) {
            let cmd = set(&[]);
            self.atomically(key, async { self.expect_type(key, "string", allow_missing).await }, |()| vec![cmd], "conflict")
                .await?;
            return Ok(());
        }
        if self.state.lock().keep_ttl {
            let cmd = set(&[b"KEEPTTL"]);
            match self
                .atomically(key, async { self.expect_type(key, "string", allow_missing).await }, |()| vec![cmd], "conflict")
                .await
            {
                Ok(_) => return Ok(()),
                Err(e) if contains_ci(reply_message(&e), "syntax") => self.state.lock().keep_ttl = false,
                Err(e) => return Err(e),
            }
        }
        // Before Redis 6 there is no KEEPTTL: the TTL is read under WATCH and set again in the same transaction.
        let plain = set(&[]);
        self.atomically(
            key,
            async {
                self.expect_type(key, "string", allow_missing).await?;
                Ok(int(&self.cmd(&[b"pttl", key]).await?))
            },
            |pttl| {
                let mut list = vec![plain];
                if pttl > 0.0 {
                    list.push(vec![b"pexpire".to_vec(), key.to_vec(), js_num(pttl).into_bytes()]);
                }
                list
            },
            "conflict",
        )
        .await?;
        Ok(())
    }

    /// The list element at `index` is still `expected` (else conflict).
    async fn list_item_is(&self, key: &[u8], index: &[u8], expected: &[u8]) -> OpResult<()> {
        let cur = self.cmd(&[b"lindex", key, index]).await?;
        if cur == Raw::Null || as_buffer(&cur) != expected {
            return Err(OpError::Code("conflict", None));
        }
        Ok(())
    }

    pub(super) async fn write(&self, w: &Value) -> OpResult<Value> {
        let key = w.get("key").map(from_data).unwrap_or_default();
        let existing = bool_of(w, "existing");
        let with_key = |cmd: &[u8], rest: Vec<Vec<u8>>| -> Argv {
            let mut a = vec![cmd.to_vec(), key.clone()];
            a.extend(rest);
            a
        };
        match str_of(w, "op").unwrap_or("") {
            "set" => {
                self.set_string(&key, w).await?;
                Ok(changed_one())
            }
            "hset" => {
                let cmd: &[u8] = if bool_of(w, "onlyNew") { b"hsetnx" } else { b"hset" };
                let field = from_data(w.get("field").unwrap_or(&Value::Null));
                let value = from_data(w.get("value").unwrap_or(&Value::Null));
                Ok(changed(&self.guarded(&key, "hash", existing, with_key(cmd, vec![field, value])).await?))
            }
            "hdel" => Ok(changed(&self.cmd_vec(&with_key(b"hdel", data_list(w.get("fields")))).await?)),
            op @ ("lpush" | "rpush") => {
                let cmd = with_key(op.as_bytes(), data_list(w.get("items")));
                Ok(changed(&self.guarded(&key, "list", existing, cmd).await?))
            }
            "lset" => {
                let index = js_num(f64_of(w, "index").unwrap_or(f64::NAN)).into_bytes();
                let value = from_data(w.get("value").unwrap_or(&Value::Null));
                let cmd = with_key(b"lset", vec![index.clone(), value]);
                match w.get("expected") {
                    None => {
                        self.cmd_vec(&cmd).await?;
                    }
                    Some(expected) => {
                        let expected = from_data(expected);
                        self.atomically(&key, self.list_item_is(&key, &index, &expected), |()| vec![cmd], "conflict").await?;
                    }
                }
                Ok(changed_one())
            }
            "lrem" => {
                let count = js_num(f64_of(w, "count").unwrap_or(f64::NAN)).into_bytes();
                let value = from_data(w.get("value").unwrap_or(&Value::Null));
                Ok(changed(&self.cmd_vec(&with_key(b"lrem", vec![count, value])).await?))
            }
            "ldel" => {
                let index = js_num(f64_of(w, "index").unwrap_or(f64::NAN)).into_bytes();
                let expected = from_data(w.get("expected").unwrap_or(&Value::Null));
                let marker = format!("__unimux_removed_{}__", uuid::Uuid::new_v4()).into_bytes();
                let cmds =
                    vec![with_key(b"lset", vec![index.clone(), marker.clone()]), with_key(b"lrem", vec![b"1".to_vec(), marker])];
                self.atomically(&key, self.list_item_is(&key, &index, &expected), |()| cmds, "conflict").await?;
                Ok(changed_one())
            }
            "sadd" => {
                let cmd = with_key(b"sadd", data_list(w.get("members")));
                Ok(changed(&self.guarded(&key, "set", existing, cmd).await?))
            }
            "srem" => Ok(changed(&self.cmd_vec(&with_key(b"srem", data_list(w.get("members")))).await?)),
            "zadd" => {
                let mode = str_of(w, "mode");
                let mut rest: Vec<Vec<u8>> = Vec::new();
                if let Some(m) = mode {
                    rest.push(m.to_uppercase().into_bytes());
                }
                if mode == Some("xx") {
                    rest.push(b"CH".to_vec());
                }
                for (m, s) in pair_list(w.get("entries")) {
                    rest.push(str_bytes(s));
                    rest.push(from_data(m));
                }
                Ok(changed(&self.guarded(&key, "zset", existing, with_key(b"zadd", rest)).await?))
            }
            "zrem" => Ok(changed(&self.cmd_vec(&with_key(b"zrem", data_list(w.get("members")))).await?)),
            "zincrby" => {
                let by = str_bytes(w.get("by").unwrap_or(&Value::Null));
                let member = from_data(w.get("member").unwrap_or(&Value::Null));
                self.guarded(&key, "zset", existing, with_key(b"zincrby", vec![by, member])).await?;
                Ok(changed_one())
            }
            "xadd" => {
                let mut rest: Vec<Vec<u8>> = Vec::new();
                if let Some(max) = w.get("maxLen").and_then(Value::as_f64) {
                    rest.push(b"MAXLEN".to_vec());
                    if bool_of(w, "approx") {
                        rest.push(b"~".to_vec());
                    }
                    rest.push(js_num(max).into_bytes());
                }
                rest.push(str_of(w, "id").unwrap_or("*").as_bytes().to_vec());
                for (f, v) in pair_list(w.get("fields")) {
                    rest.push(from_data(f));
                    rest.push(from_data(v));
                }
                let id = text(&self.guarded(&key, "stream", existing, with_key(b"xadd", rest)).await?);
                Ok(json!({ "changed": 1, "id": id }))
            }
            "xdel" => {
                let ids = w.get("ids").and_then(Value::as_array).map(|a| a.iter().map(str_bytes).collect()).unwrap_or_default();
                Ok(changed(&self.cmd_vec(&with_key(b"xdel", ids)).await?))
            }
            "xtrim" => {
                let mut rest = vec![str_of(w, "strategy").unwrap_or("").to_uppercase().into_bytes()];
                if bool_of(w, "approx") {
                    rest.push(b"~".to_vec());
                }
                rest.push(str_bytes(w.get("threshold").unwrap_or(&Value::Null)));
                Ok(changed(&self.cmd_vec(&with_key(b"xtrim", rest)).await?))
            }
            "rename" => {
                let new_key = from_data(w.get("newKey").unwrap_or(&Value::Null));
                let r = async {
                    if bool_of(w, "overwrite") {
                        self.cmd(&[b"rename", &key, &new_key]).await?;
                        return Ok(changed_one());
                    }
                    if int(&self.cmd(&[b"renamenx", &key, &new_key]).await?) == 0.0 {
                        return Err(OpError::Code("keyExists", None));
                    }
                    Ok(changed_one())
                }
                .await;
                match r {
                    Err(e) if contains_ci(reply_message(&e), "no such key") => Err(OpError::Code("notFound", None)),
                    r => r,
                }
            }
            "expire" => {
                let ttl = js_num(f64_of(w, "ttlMs").unwrap_or(f64::NAN));
                let r = int(&self.cmd(&[b"pexpire", &key, ttl.as_bytes()]).await?);
                if r == 0.0 {
                    return Err(OpError::Code("notFound", None));
                }
                Ok(json!({ "changed": num(r) }))
            }
            "persist" => Ok(changed(&self.cmd(&[b"persist", &key]).await?)),
            "delete" => {
                let keys = data_list(w.get("keys"));
                let n = self.unlink_keys(&self.client, &keys).await?;
                Ok(json!({ "changed": num(n) }))
            }
            "create" => self.create(&key, w.get("value").unwrap_or(&Value::Null), truthy(f64_of(w, "ttlMs"))).await,
            _ => Err(OpError::Code("invalid", None)),
        }
    }

    /// UNLINK (DEL on servers without it) in batches of `deleteBatch`; the number of keys deleted.
    pub(super) async fn unlink_keys(&self, client: &RedisClient, keys: &[Vec<u8>]) -> OpResult<f64> {
        let mut deleted = 0.0;
        for batch in keys.chunks(self.opts.limits.delete_batch.max(1)) {
            if self.state.lock().unlink {
                let mut a = vec![b"unlink".to_vec()];
                a.extend(batch.iter().cloned());
                match client.call_vec(&a).await {
                    Ok(v) => {
                        deleted += int(&v);
                        continue;
                    }
                    Err(CmdError::Reply(m)) if contains_ci(&m, "unknown command") => self.state.lock().unlink = false,
                    Err(e) => return Err(e.into()),
                }
            }
            let mut a = vec![b"del".to_vec()];
            a.extend(batch.iter().cloned());
            deleted += int(&client.call_vec(&a).await.map_err(OpError::from)?);
        }
        Ok(deleted)
    }

    async fn create(&self, key: &[u8], v: &Value, ttl_ms: Option<f64>) -> OpResult<Value> {
        let ty = str_of(v, "type").unwrap_or("");
        let mut cmd: Argv = Vec::new();
        let mut head = |name: &[u8]| {
            cmd.push(name.to_vec());
            cmd.push(key.to_vec());
        };
        match ty {
            "string" => {
                head(b"set");
                cmd.push(from_data(v.get("value").unwrap_or(&Value::Null)));
            }
            "hash" => {
                head(b"hset");
                for (f, x) in pair_list(v.get("entries")) {
                    cmd.push(from_data(f));
                    cmd.push(from_data(x));
                }
            }
            "list" => {
                head(b"rpush");
                cmd.extend(data_list(v.get("items")));
            }
            "set" => {
                head(b"sadd");
                cmd.extend(data_list(v.get("members")));
            }
            "zset" => {
                head(b"zadd");
                for (m, s) in pair_list(v.get("entries")) {
                    cmd.push(str_bytes(s));
                    cmd.push(from_data(m));
                }
            }
            "stream" => {
                head(b"xadd");
                cmd.push(str_of(v, "id").unwrap_or("*").as_bytes().to_vec());
                for (f, x) in pair_list(v.get("fields")) {
                    cmd.push(from_data(f));
                    cmd.push(from_data(x));
                }
            }
            _ => return Err(OpError::Code("invalid", None)),
        }
        let mut cmds = vec![cmd];
        if let Some(ttl) = ttl_ms {
            cmds.push(vec![b"pexpire".to_vec(), key.to_vec(), js_num(ttl).into_bytes()]);
        }
        let r = self
            .atomically(
                key,
                async {
                    if int(&self.cmd(&[b"exists", key]).await?) > 0.0 {
                        return Err(OpError::Code("keyExists", None));
                    }
                    Ok(())
                },
                |()| cmds,
                "keyExists",
            )
            .await?;
        if ty == "stream" {
            return Ok(json!({ "changed": 1, "id": r.first().map(text).unwrap_or_default() }));
        }
        Ok(changed_one())
    }
}
