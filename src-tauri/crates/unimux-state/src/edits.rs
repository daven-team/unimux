//! Port of src/shared/stateEdits.ts `mergeStateEdit`: applies only the fields the renderer changed (base -> next) to the
//! latest state. Collections of objects with a string `id` merge by id: a concurrently deleted entity is not resurrected,
//! a new entry is inserted after its nearest surviving predecessor, a reorder follows the edit. Equality is JSON.stringify
//! equality (insertion order matters), exactly like the TS code.

use serde_json::{Map, Value};

use unimux_core::js_json::js_equal;

fn equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => js_equal(a, b),
        _ => false,
    }
}

fn is_object(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}

fn id_of(v: &Value) -> Option<&str> {
    v.as_object().and_then(|o| o.get("id")).and_then(Value::as_str)
}

/// `x.every((v) => object(v) && typeof v.id === 'string')` (no uniqueness check here, as in stateEdits.ts).
fn keyed(items: &[Value]) -> bool {
    items.iter().all(|v| id_of(v).is_some())
}

const SKIPPED_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// `merge(current, base, next)`; None stands for `undefined` (a key that is not there).
pub fn merge(current: Option<&Value>, base: Option<&Value>, next: Option<&Value>) -> Option<Value> {
    if equal(base, next) {
        return current.cloned();
    }
    if let (Some(Value::Array(cur)), Some(Value::Array(b)), Some(Value::Array(n))) = (current, base, next)
        && keyed(cur)
        && keyed(b)
        && keyed(n)
    {
        return Some(Value::Array(merge_keyed(cur, b, n)));
    }
    if is_object(base) && is_object(next) {
        let (Some(Value::Object(b)), Some(Value::Object(n))) = (base, next) else { unreachable!() };
        let Some(Value::Object(cur)) = current else {
            return current.cloned(); // deleted parent
        };
        let mut result: Map<String, Value> = cur.clone();
        let mut keys: Vec<&String> = b.keys().collect();
        for k in n.keys() {
            if !b.contains_key(k) {
                keys.push(k);
            }
        }
        for key in keys {
            if SKIPPED_KEYS.contains(&key.as_str()) || equal(b.get(key), n.get(key)) {
                continue;
            }
            match n.get(key) {
                None => {
                    result.shift_remove(key);
                }
                Some(nv) => {
                    let merged = if b.contains_key(key) { merge(cur.get(key), b.get(key), Some(nv)) } else { Some(nv.clone()) };
                    match merged {
                        Some(v) => {
                            result.insert(key.clone(), v);
                        }
                        // `result[key] = undefined`: JSON.stringify and the patch drop it, so the key goes.
                        None => {
                            result.shift_remove(key);
                        }
                    }
                }
            }
        }
        return Some(Value::Object(result));
    }
    next.cloned()
}

fn merge_keyed(current: &[Value], base: &[Value], next: &[Value]) -> Vec<Value> {
    // Like `new Map(list.map((v) => [v.id, v]))`: with a repeated id the last entry wins.
    let before = |id: &str| base.iter().rev().find(|v| id_of(v) == Some(id));
    let after = |id: &str| next.iter().rev().find(|v| id_of(v) == Some(id));
    let mut result: Vec<Value> = current
        .iter()
        .filter(|v| {
            let id = id_of(v).unwrap_or_default();
            before(id).is_none() || after(id).is_some()
        })
        .map(|v| {
            let id = id_of(v).unwrap_or_default();
            match (after(id), before(id)) {
                (Some(a), Some(b)) => merge(Some(v), Some(b), Some(a)).unwrap_or(Value::Null),
                _ => v.clone(),
            }
        })
        .collect();
    for (i, item) in next.iter().enumerate() {
        let id = id_of(item).unwrap_or_default();
        // A concurrently deleted entity must not be resurrected by a stale UI edit.
        if before(id).is_some() || result.iter().any(|v| id_of(v) == Some(id)) {
            continue;
        }
        let preceding = next[..i].iter().rev().find(|v| {
            let pid = id_of(v);
            result.iter().any(|r| id_of(r) == pid)
        });
        let at = match preceding {
            Some(p) => {
                let pid = id_of(p);
                result.iter().position(|v| id_of(v) == pid).map(|x| x + 1).unwrap_or(0)
            }
            None => 0,
        };
        result.insert(at, item.clone());
    }
    let old_order: Vec<&str> = base.iter().filter_map(id_of).filter(|id| after(id).is_some()).collect();
    let new_order: Vec<&str> = next.iter().filter_map(id_of).filter(|id| before(id).is_some()).collect();
    if old_order != new_order {
        let mut reordered: Vec<Value> =
            next.iter().filter_map(|v| result.iter().rev().find(|r| id_of(r) == id_of(v)).cloned()).collect();
        reordered.extend(result.iter().filter(|v| after(id_of(v).unwrap_or_default()).is_none()).cloned());
        result = reordered;
    }
    result
}

/// `mergeStateEdit(current, {base, next})`.
pub fn merge_state_edit(current: &Value, base: &Value, next: &Value) -> Value {
    merge(Some(current), Some(base), Some(next)).unwrap_or_else(|| current.clone())
}

#[cfg(test)]
mod tests {
    //! Cases of test/state-edits.test.ts; the golden corpus (tests/golden.rs) covers the generated ones.
    use super::*;
    use serde_json::json;
    use unimux_core::js_json::stringify;

    #[test]
    fn applies_only_changed_fields() {
        let current = json!({"settings": {"fontSize": 13, "language": "pl"}, "sidebarWidth": 300});
        let base = json!({"settings": {"fontSize": 13, "language": "en"}, "sidebarWidth": 250});
        let next = json!({"settings": {"fontSize": 14, "language": "en"}, "sidebarWidth": 250});
        assert_eq!(
            stringify(&merge_state_edit(&current, &base, &next)),
            r#"{"settings":{"fontSize":14,"language":"pl"},"sidebarWidth":300}"#
        );
    }

    #[test]
    fn does_not_resurrect_a_deleted_entity() {
        let current = json!({"projects": [{"id": "b", "n": 1}]});
        let base = json!({"projects": [{"id": "a", "n": 1}, {"id": "b", "n": 1}]});
        let next = json!({"projects": [{"id": "a", "n": 2}, {"id": "b", "n": 1}]});
        assert_eq!(merge_state_edit(&current, &base, &next), json!({"projects": [{"id": "b", "n": 1}]}));
    }

    #[test]
    fn inserts_new_entries_after_their_neighbour_and_follows_a_reorder() {
        let current = json!({"l": [{"id": "a"}, {"id": "x"}, {"id": "b"}]});
        let base = json!({"l": [{"id": "a"}, {"id": "b"}]});
        let next = json!({"l": [{"id": "a"}, {"id": "n"}, {"id": "b"}]});
        assert_eq!(merge_state_edit(&current, &base, &next), json!({"l": [{"id": "a"}, {"id": "n"}, {"id": "x"}, {"id": "b"}]}));
        let reorder = json!({"l": [{"id": "b"}, {"id": "a"}]});
        assert_eq!(merge_state_edit(&current, &base, &reorder), json!({"l": [{"id": "b"}, {"id": "a"}, {"id": "x"}]}));
    }

    #[test]
    fn deletes_keys_and_skips_prototype_keys() {
        let current = json!({"a": 1, "b": 2});
        let base = json!({"a": 1, "b": 2, "__proto__": 1});
        let next = json!({"a": 1, "__proto__": {"polluted": true}});
        assert_eq!(stringify(&merge_state_edit(&current, &base, &next)), r#"{"a":1}"#);
    }

    #[test]
    fn a_changed_child_of_a_deleted_parent_stays_deleted() {
        let current = json!({"x": 1});
        let base = json!({"p": {"a": 1}});
        let next = json!({"p": {"a": 2}});
        assert_eq!(stringify(&merge_state_edit(&current, &base, &next)), r#"{"x":1}"#);
    }

    #[test]
    fn new_keys_are_appended_in_order() {
        let current = json!({"a": 1});
        let base = json!({});
        let next = json!({"z": 1, "b": 2});
        assert_eq!(stringify(&merge_state_edit(&current, &base, &next)), r#"{"a":1,"z":1,"b":2}"#);
    }
}
