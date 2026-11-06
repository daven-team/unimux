//! Port of src/shared/statePatch.ts: the `state:changed` message as a patch against the previous revision.
//! Patch shapes (key order as in TS, the renderer's applyPatch reads them): `{v}`, `{o, d?}`, `{a}`, `{s: {drop?, at?, add?}}`.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use unimux_core::js_json::js_equal;

fn id_of(v: &Value) -> Option<&str> {
    v.as_object().and_then(|o| o.get("id")).and_then(Value::as_str)
}

/// `isKeyed`: an array of objects with string ids, all different.
fn is_keyed(items: &[Value]) -> bool {
    let mut seen = HashSet::with_capacity(items.len());
    items.iter().all(|v| id_of(v).is_some_and(|id| seen.insert(id)))
}

/// `diffState(prev, next)`; None = nothing changed.
pub fn diff_state(prev: &Value, next: &Value) -> Option<Value> {
    match (prev, next) {
        (Value::Object(p), Value::Object(n)) => {
            let mut o = Map::new();
            for (key, nv) in n {
                match p.get(key) {
                    None => {
                        o.insert(key.clone(), json!({ "v": nv }));
                    }
                    Some(pv) => {
                        if let Some(patch) = diff_state(pv, nv) {
                            o.insert(key.clone(), patch);
                        }
                    }
                }
            }
            let d: Vec<Value> = p.keys().filter(|k| !n.contains_key(*k)).map(|k| Value::String(k.clone())).collect();
            if o.is_empty() && d.is_empty() {
                return None;
            }
            let mut out = Map::new();
            out.insert("o".into(), Value::Object(o));
            if !d.is_empty() {
                out.insert("d".into(), Value::Array(d));
            }
            Some(Value::Object(out))
        }
        (Value::Array(p), Value::Array(n)) if is_keyed(p) && is_keyed(n) => {
            let before: HashMap<&str, &Value> = p.iter().filter_map(|v| id_of(v).map(|id| (id, v))).collect();
            match kept_order(p, n, &before) {
                KeptOrder::Unchanged => return None,
                KeptOrder::Patch(patch) => return Some(patch),
                KeptOrder::NotApplicable => {}
            }
            let a: Vec<Value> = n
                .iter()
                .map(|item| {
                    let id = id_of(item).unwrap_or_default();
                    match before.get(id) {
                        None => json!({ "v": item }),
                        Some(old) => match diff_state(old, item) {
                            Some(patch) => json!({ "id": id, "p": patch }),
                            None => Value::String(id.to_string()),
                        },
                    }
                })
                .collect();
            let unchanged =
                a.len() == p.len() && a.iter().zip(p).all(|(op, old)| op.as_str().is_some() && op.as_str() == id_of(old));
            if unchanged { None } else { Some(json!({ "a": a })) }
        }
        _ => {
            if js_equal(prev, next) {
                None
            } else {
                Some(json!({ "v": next }))
            }
        }
    }
}

enum KeptOrder {
    NotApplicable,
    Unchanged,
    Patch(Value),
}

fn kept_order(prev: &[Value], next: &[Value], before: &HashMap<&str, &Value>) -> KeptOrder {
    let first_kept = match next.first().and_then(id_of) {
        Some(id) if before.contains_key(id) => prev.iter().position(|v| id_of(v) == Some(id)).unwrap_or(prev.len()),
        _ => prev.len(),
    };
    let kept = prev.len() - first_kept;
    if next.len() < kept {
        return KeptOrder::NotApplicable;
    }
    let mut at = Vec::new();
    for i in 0..kept {
        let old = &prev[first_kept + i];
        let item = &next[i];
        if id_of(item) != id_of(old) {
            return KeptOrder::NotApplicable;
        }
        if let Some(p) = diff_state(old, item) {
            at.push(json!([i, id_of(item).unwrap_or_default(), p]));
        }
    }
    let add = &next[kept..];
    if add.iter().any(|item| id_of(item).is_some_and(|id| before.contains_key(id))) {
        return KeptOrder::NotApplicable;
    }
    if first_kept == 0 && at.is_empty() && add.is_empty() {
        return KeptOrder::Unchanged;
    }
    let mut s = Map::new();
    if first_kept > 0 {
        s.insert("drop".into(), json!(first_kept));
    }
    if !at.is_empty() {
        s.insert("at".into(), Value::Array(at));
    }
    if !add.is_empty() {
        s.insert("add".into(), Value::Array(add.to_vec()));
    }
    KeptOrder::Patch(json!({ "s": Value::Object(s) }))
}

/// A patch that does not fit the value (the renderer then asks for a full snapshot).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PatchError(pub String);

/// `applyPatch` (the renderer's; here for tests and goldens).
pub fn apply_patch(value: &Value, patch: &Value) -> Result<Value, PatchError> {
    let p = patch.as_object().ok_or_else(|| PatchError("patch is not an object".into()))?;
    if let Some(v) = p.get("v") {
        return Ok(v.clone());
    }
    if let Some(Value::Object(o)) = p.get("o") {
        let Value::Object(cur) = value else { return Err(PatchError("patch of an object does not fit the value".into())) };
        let mut result = cur.clone();
        for (key, kp) in o {
            if key == "__proto__" {
                continue;
            }
            let is_v = kp.as_object().is_some_and(|x| x.contains_key("v"));
            if !is_v && !cur.contains_key(key) {
                return Err(PatchError(format!("missing key {key}")));
            }
            let applied = apply_patch(cur.get(key).unwrap_or(&Value::Null), kp)?;
            result.insert(key.clone(), applied);
        }
        if let Some(Value::Array(d)) = p.get("d") {
            for key in d.iter().filter_map(Value::as_str) {
                result.shift_remove(key);
            }
        }
        return Ok(Value::Object(result));
    }
    let Value::Array(items) = value else { return Err(PatchError("patch of a list does not fit the value".into())) };
    if !is_keyed(items) {
        return Err(PatchError("patch of a list does not fit the value".into()));
    }
    if let Some(Value::Object(s)) = p.get("s") {
        let drop = s.get("drop").and_then(Value::as_u64).unwrap_or(0) as usize;
        if drop > items.len() {
            return Err(PatchError("patch drops more entries than the list has".into()));
        }
        let mut result: Vec<Value> = items[drop..].to_vec();
        if let Some(Value::Array(at)) = s.get("at") {
            for entry in at {
                let index = entry[0].as_u64().unwrap_or(u64::MAX) as usize;
                let id = entry[1].as_str().unwrap_or_default();
                let found = result
                    .get(index)
                    .filter(|f| id_of(f) == Some(id))
                    .ok_or_else(|| PatchError(format!("missing entry {id}")))?;
                result[index] = apply_patch(found, &entry[2])?;
            }
        }
        if let Some(Value::Array(add)) = s.get("add") {
            result.extend(add.iter().cloned());
        }
        return Ok(Value::Array(result));
    }
    let Some(Value::Array(a)) = p.get("a") else { return Err(PatchError("unknown patch".into())) };
    let before: HashMap<&str, &Value> = items.iter().filter_map(|v| id_of(v).map(|id| (id, v))).collect();
    a.iter()
        .map(|op| match op {
            Value::String(id) => {
                before.get(id.as_str()).map(|v| (*v).clone()).ok_or_else(|| PatchError(format!("missing entry {id}")))
            }
            Value::Object(o) if o.contains_key("v") => Ok(o["v"].clone()),
            Value::Object(o) => {
                let id = o.get("id").and_then(Value::as_str).unwrap_or_default();
                let found = before.get(id).ok_or_else(|| PatchError(format!("missing entry {id}")))?;
                apply_patch(found, o.get("p").unwrap_or(&Value::Null))
            }
            _ => Err(PatchError("bad list op".into())),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

/// `stateChange(prev, snapshot)` with the base of the last state the windows have:
/// `{revision, base, editId?, patch}`.
pub fn state_change(prev: &Value, next: &Value, revision: u64, base: u64, edit_id: Option<&str>) -> Value {
    let mut m = Map::new();
    m.insert("revision".into(), json!(revision));
    m.insert("base".into(), json!(base));
    if let Some(id) = edit_id {
        m.insert("editId".into(), json!(id));
    }
    m.insert("patch".into(), diff_state(prev, next).unwrap_or(Value::Null));
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use unimux_core::js_json::stringify;

    fn round_trip(a: Value, b: Value) {
        let p = diff_state(&a, &b);
        let applied = match &p {
            Some(p) => apply_patch(&a, p).unwrap(),
            None => a.clone(),
        };
        assert_eq!(stringify(&applied), stringify(&b), "patch {p:?}");
    }

    #[test]
    fn shapes() {
        assert_eq!(diff_state(&json!({"a": 1}), &json!({"a": 1})), None);
        assert_eq!(
            stringify(&diff_state(&json!({"a": 1, "b": 2}), &json!({"a": 2, "c": 3})).unwrap()),
            r#"{"o":{"a":{"v":2},"c":{"v":3}},"d":["b"]}"#
        );
        // An appended task: `s` with add only.
        assert_eq!(
            stringify(&diff_state(&json!([{"id": "a"}]), &json!([{"id": "a"}, {"id": "b"}])).unwrap()),
            r#"{"s":{"add":[{"id":"b"}]}}"#
        );
        // The oldest event dropped and one patched in place.
        assert_eq!(
            stringify(&diff_state(&json!([{"id": "a"}, {"id": "b", "x": 1}]), &json!([{"id": "b", "x": 2}])).unwrap()),
            r#"{"s":{"drop":1,"at":[[0,"b",{"o":{"x":{"v":2}}}]]}}"#
        );
        // A move: `a` with ids.
        assert_eq!(
            stringify(&diff_state(&json!([{"id": "a"}, {"id": "b"}]), &json!([{"id": "b"}, {"id": "a"}])).unwrap()),
            r#"{"a":["b","a"]}"#
        );
        // Not keyed (duplicate ids): replaced.
        assert_eq!(
            stringify(&diff_state(&json!([{"id": "a"}]), &json!([{"id": "a"}, {"id": "a"}])).unwrap()),
            r#"{"v":[{"id":"a"},{"id":"a"}]}"#
        );
    }

    #[test]
    fn round_trips() {
        round_trip(json!({"a": [1, 2], "b": {"c": null}}), json!({"a": [1, 3], "b": {"c": {"d": 1}}, "e": "x"}));
        round_trip(
            json!([{"id": "a", "v": 1}, {"id": "b"}, {"id": "c"}]),
            json!([{"id": "c"}, {"id": "a", "v": 2}, {"id": "d"}]),
        );
        round_trip(json!([{"id": "a"}, {"id": "b"}, {"id": "c"}]), json!([{"id": "a"}, {"id": "c"}]));
        round_trip(json!([{"id": "a"}, {"id": "b"}]), json!([{"id": "b"}, {"id": "x"}]));
        round_trip(json!({"a": 1}), json!([1]));
    }

    #[test]
    fn change_message_shape() {
        let c = state_change(&json!({"a": 1}), &json!({"a": 2}), 5, 4, Some("e1"));
        assert_eq!(stringify(&c), r#"{"revision":5,"base":4,"editId":"e1","patch":{"o":{"a":{"v":2}}}}"#);
        let c = state_change(&json!({"a": 1}), &json!({"a": 1}), 5, 4, None);
        assert_eq!(stringify(&c), r#"{"revision":5,"base":4,"patch":null}"#);
    }
}
