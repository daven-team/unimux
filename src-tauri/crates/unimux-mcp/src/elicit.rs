//! Elicitation answers as the SDK's `Server.elicitInput` checks them: ElicitResultSchema first, then (for an accept with
//! content) ajv against the requested schema. Anything that fails is `cancel` (mcp.ts elicitFor).

use serde_json::Value;

use crate::jsonrpc::meta_ok;

/// The answer of an elicitation; a failure or a timeout counts as `cancel` (as in 1.1.4).
#[derive(Debug, Clone, PartialEq)]
pub struct ElicitAnswer {
    pub action: String,
    pub content: Option<Value>,
}

impl ElicitAnswer {
    pub fn cancel() -> Self {
        Self { action: "cancel".into(), content: None }
    }
}

/// The SDK's elicitInput on an answer: ElicitResultSchema (action accept / decline / cancel, content null or a record of
/// string, number, boolean or string array values), then for an accept with content the ajv check against the requested
/// schema. Any failure (also an error response) is None, which mcp.ts elicitFor turns into `cancel`.
pub fn elicit_answer(m: &Value, schema: &Value) -> Option<ElicitAnswer> {
    let result = m.get("result")?.as_object()?;
    if !result.get("_meta").is_none_or(meta_ok) {
        return None;
    }
    let action = result.get("action")?.as_str()?;
    if !["accept", "decline", "cancel"].contains(&action) {
        return None;
    }
    let content = match result.get("content") {
        None | Some(Value::Null) => None,
        Some(Value::Object(c)) => {
            let primitive = |v: &Value| {
                v.is_string()
                    || v.is_number()
                    || v.is_boolean()
                    || v.as_array().is_some_and(|items| items.iter().all(Value::is_string))
            };
            if !c.values().all(primitive) {
                return None;
            }
            Some(Value::Object(c.clone()))
        }
        Some(_) => return None,
    };
    if action == "accept"
        && let Some(content) = &content
        && !schema_ok(schema, content)
    {
        return None;
    }
    Some(ElicitAnswer { action: action.to_string(), content })
}

/// JSON values as ajv compares them for `const` / `enum` (numbers by value).
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

fn type_ok(name: &str, v: &Value) -> bool {
    match name {
        "string" => v.is_string(),
        "number" => v.is_number(),
        "integer" => v.as_f64().is_some_and(|f| f.fract() == 0.0),
        "boolean" => v.is_boolean(),
        "object" => v.is_object(),
        "array" => v.is_array(),
        "null" => v.is_null(),
        _ => false,
    }
}

/// The part of JSON Schema (ajv, strict off) that elicitation schemas use: type, enum, const, required, properties,
/// additionalProperties, items, oneOf / anyOf / allOf / not, string length (code points, as ajv's ucs2length counts), number
/// and array bounds. Other keywords (title, description, default, format) do not constrain, as with ajv without ajv-formats.
pub fn schema_ok(schema: &Value, v: &Value) -> bool {
    let Some(s) = schema.as_object() else { return schema.as_bool() != Some(false) };
    let num = |k: &str| s.get(k).and_then(Value::as_f64);
    if let Some(t) = s.get("type") {
        let ok = match t {
            Value::String(name) => type_ok(name, v),
            Value::Array(names) => names.iter().filter_map(Value::as_str).any(|n| type_ok(n, v)),
            _ => true,
        };
        if !ok {
            return false;
        }
    }
    if let Some(Value::Array(options)) = s.get("enum")
        && !options.iter().any(|o| json_eq(o, v))
    {
        return false;
    }
    if let Some(c) = s.get("const")
        && !json_eq(c, v)
    {
        return false;
    }
    if let Some(obj) = v.as_object() {
        if let Some(Value::Array(required)) = s.get("required")
            && !required.iter().filter_map(Value::as_str).all(|k| obj.contains_key(k))
        {
            return false;
        }
        let props = s.get("properties").and_then(Value::as_object);
        for (k, value) in obj {
            match props.and_then(|p| p.get(k)) {
                Some(sub) if !schema_ok(sub, value) => return false,
                Some(_) => {}
                None => {
                    if let Some(extra) = s.get("additionalProperties")
                        && !schema_ok(extra, value)
                    {
                        return false;
                    }
                }
            }
        }
    }
    if let Some(items) = v.as_array() {
        if let Some(sub) = s.get("items").filter(|i| i.is_object() || i.is_boolean())
            && !items.iter().all(|i| schema_ok(sub, i))
        {
            return false;
        }
        let n = items.len() as f64;
        if num("minItems").is_some_and(|m| n < m) || num("maxItems").is_some_and(|m| n > m) {
            return false;
        }
    }
    if let Some(text) = v.as_str() {
        let n = text.chars().count() as f64;
        if num("minLength").is_some_and(|m| n < m) || num("maxLength").is_some_and(|m| n > m) {
            return false;
        }
    }
    if let Some(x) = v.as_f64() {
        let out = num("minimum").is_some_and(|m| x < m)
            || num("maximum").is_some_and(|m| x > m)
            || num("exclusiveMinimum").is_some_and(|m| x <= m)
            || num("exclusiveMaximum").is_some_and(|m| x >= m);
        if out {
            return false;
        }
    }
    let subs = |k: &str| s.get(k).and_then(Value::as_array).map(|a| a.iter().filter(|sub| schema_ok(sub, v)).count());
    let all = s.get("allOf").and_then(Value::as_array).map(Vec::len);
    if subs("oneOf").is_some_and(|n| n != 1) || subs("anyOf") == Some(0) || all.is_some_and(|n| subs("allOf") != Some(n)) {
        return false;
    }
    !s.get("not").is_some_and(|sub| schema_ok(sub, v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn elicitation_answers_are_checked_like_elicit_input() {
        let confirm = json!({ "type": "object", "required": ["confirm"],
            "properties": { "confirm": { "type": "boolean", "default": false } } });
        let answer = |result: Value| elicit_answer(&json!({ "jsonrpc": "2.0", "id": 0, "result": result }), &confirm);
        let accepted = answer(json!({ "action": "accept", "content": { "confirm": true } })).unwrap();
        assert_eq!((accepted.action.as_str(), accepted.content), ("accept", Some(json!({ "confirm": true }))));
        assert!(answer(json!({ "action": "accept", "content": { "confirm": "yes" } })).is_none());
        assert!(answer(json!({ "action": "accept", "content": {} })).is_none());
        assert!(answer(json!({ "action": "yes" })).is_none());
        assert!(answer(json!({ "action": "accept", "content": { "confirm": true, "x": { "a": 1 } } })).is_none());
        assert!(answer(json!({ "action": "accept", "content": [true] })).is_none());
        let declined = answer(json!({ "action": "decline", "content": null })).unwrap();
        assert_eq!((declined.action.as_str(), declined.content), ("decline", None));
        // A decline is not checked against the schema (only an accept with content is).
        assert!(answer(json!({ "action": "decline", "content": { "confirm": "no" } })).is_some());
        let refused = json!({ "jsonrpc": "2.0", "id": 0, "error": { "code": -1, "message": "x" } });
        assert!(elicit_answer(&refused, &confirm).is_none());
        // The agent picker (mcpTools resolveCell): a string out of oneOf consts.
        let pick = json!({ "type": "object", "required": ["cellId"], "properties": { "cellId": { "type": "string",
            "title": "Agent", "oneOf": [{ "const": "a", "title": "A" }, { "const": "b", "title": "B" }] } } });
        let picked = |id: Value| schema_ok(&pick, &json!({ "cellId": id }));
        assert!(picked(json!("a")) && picked(json!("b")));
        assert!(!picked(json!("c")) && !picked(json!(1)));
    }
}
