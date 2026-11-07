//! JSON-RPC pieces of the MCP wire as the 1.1.4 server (mcp.ts on @modelcontextprotocol/sdk 1.32.2) sees them: the SDK's
//! strict JSONRPCMessageSchema, the request params schemas (zod 4 issue lists), id keys, the answer shapes in the SDK's key
//! order, and the body sniffing mcp.ts does before the transport (session wanted, progress wanted).

use serde_json::{Map, Value, json};

/// The JavaScript `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub fn messages_of(body: &Value) -> Vec<&Value> {
    match body {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

/// A JSON-RPC request (not a response or a notification).
pub fn is_request(m: &Value) -> bool {
    m["method"].is_string() && (m["id"].is_string() || m["id"].is_number())
}

/// The key of a JSON-RPC id as a JS Map sees it: strings and numbers differ, `7.0` and `7` are the same number.
pub fn id_key(id: &Value) -> String {
    normalize_number(id).to_string()
}

/// A whole number written with a fraction or an exponent (`2.0`, `1e3`) as JSON.parse + JSON.stringify give it back.
pub fn normalize_number(v: &Value) -> Value {
    match v.as_f64() {
        Some(f) if v.is_f64() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER => json!(f as i64),
        _ => v.clone(),
    }
}

/// An `initialize` from a client that can answer form elicitations (`elicitation: {}` is the older spelling).
pub fn wants_session(body: &Value) -> bool {
    messages_of(body).iter().any(|m| m["method"] == "initialize" && form_elicitation(&m["params"]["capabilities"]))
}

/// The client capabilities declare form elicitation (`form`, or the empty object of older clients).
pub fn form_elicitation(capabilities: &Value) -> bool {
    match &capabilities["elicitation"] {
        Value::Object(e) => e.contains_key("form") || e.is_empty(),
        _ => false,
    }
}

/// A stateless tools/call with a progressToken from a client that accepts SSE: answered as an SSE stream.
pub fn wants_progress(body: &Value, accept: Option<&str>) -> bool {
    if !accept.is_some_and(|a| a.contains("text/event-stream")) {
        return false;
    }
    messages_of(body).iter().any(|m| {
        let token = &m["params"]["_meta"]["progressToken"];
        m["method"] == "tools/call" && (token.is_string() || token.is_number())
    })
}

/// zod 4 `z.number().int()`: a safe integer.
pub fn is_int(v: &Value) -> bool {
    v.as_f64().is_some_and(|f| f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER)
}

/// RequestIdSchema / ProgressTokenSchema: a string or an integer.
pub fn is_id(v: &Value) -> bool {
    v.is_string() || is_int(v)
}

/// RequestMetaSchema (loose): `progressToken` a string or an integer, `io.modelcontextprotocol/related-task` an object
/// with a string `taskId`.
pub fn meta_ok(meta: &Value) -> bool {
    let Some(meta) = meta.as_object() else { return false };
    meta.get("progressToken").is_none_or(is_id)
        && meta.get("io.modelcontextprotocol/related-task").is_none_or(|t| t.is_object() && t["taskId"].is_string())
}

/// BaseRequestParamsSchema.loose() / NotificationsParamsSchema.loose(): an object whose `_meta` is RequestMetaSchema.
fn params_ok(params: &Value) -> bool {
    params.as_object().is_some_and(|p| p.get("_meta").is_none_or(meta_ok))
}

/// The SDK's JSONRPCMessageSchema: the union of the four `.strict()` schemas (request, notification, result response, error
/// response), so extra top-level keys, a non-integer id or a params value that is not an object are refused.
pub fn valid_message(m: &Value) -> bool {
    let Some(obj) = m.as_object() else { return false };
    if obj.get("jsonrpc") != Some(&json!("2.0")) {
        return false;
    }
    let only = |keys: &[&str]| obj.keys().all(|k| keys.contains(&k.as_str()));
    let request = only(&["jsonrpc", "id", "method", "params"])
        && obj.get("id").is_some_and(is_id)
        && obj.get("method").is_some_and(Value::is_string)
        && obj.get("params").is_none_or(params_ok);
    let notification = only(&["jsonrpc", "method", "params"])
        && obj.get("method").is_some_and(Value::is_string)
        && obj.get("params").is_none_or(params_ok);
    let response = only(&["jsonrpc", "id", "result"])
        && obj.get("id").is_some_and(is_id)
        && obj.get("result").is_some_and(|r| r.is_object() && r.get("_meta").is_none_or(meta_ok));
    let error = only(&["jsonrpc", "id", "error"])
        && obj.get("id").is_none_or(is_id)
        && obj.get("error").is_some_and(|e| e.is_object() && is_int(&e["code"]) && e["message"].is_string());
    request || notification || response || error
}

/// A result answer in the SDK's key order: result, jsonrpc, id.
pub fn result(id: &Value, result: Value) -> Value {
    let mut m = Map::new();
    m.insert("result".into(), result);
    m.insert("jsonrpc".into(), json!("2.0"));
    m.insert("id".into(), id.clone());
    Value::Object(m)
}

/// An error answer in the SDK's key order: jsonrpc, id, error.
pub fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// An McpError as the SDK serializes it: the message carries the `MCP error <code>: ` prefix.
pub fn mcp_error(id: &Value, code: i64, message: &str) -> Value {
    error(id, code, &format!("MCP error {code}: {message}"))
}

/// zod 4's `received` name of a value (`undefined` for a missing key).
fn received(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// A zod 4 `invalid_type` issue, in zod's key order.
fn type_issue(expected: &str, path: &[&str], got: Option<&Value>) -> Value {
    json!({ "expected": expected, "code": "invalid_type", "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", received(got)) })
}

/// The request schema checks the SDK's setRequestHandler runs (parseWithCompat) for the methods whose params it reads:
/// a failure throws a ZodError, which the SDK answers as -32603 with `error.message` (the issues, JSON with 2 spaces).
pub fn schema_issues(method: &str, params: Option<&Value>) -> Vec<Value> {
    let object = |p: Option<&Value>| p.is_some_and(Value::is_object);
    let field = |name: &str| params.and_then(|p| p.get(name));
    let mut issues = Vec::new();
    match method {
        "tools/call" | "tasks/get" | "tasks/result" | "tasks/cancel" if !object(params) => {
            issues.push(type_issue("object", &["params"], params));
        }
        "tools/call" => {
            let task = field("task");
            if task.is_some() && !object(task) {
                issues.push(type_issue("object", &["params", "task"], task));
            } else if let Some(ttl) = task.and_then(|t| t.get("ttl"))
                && !ttl.is_number()
            {
                issues.push(type_issue("number", &["params", "task", "ttl"], Some(ttl)));
            }
            if !field("name").is_some_and(Value::is_string) {
                issues.push(type_issue("string", &["params", "name"], field("name")));
            }
            if let Some(arguments) = field("arguments")
                && !arguments.is_object()
            {
                issues.push(type_issue("record", &["params", "arguments"], Some(arguments)));
            }
        }
        "tasks/get" | "tasks/result" | "tasks/cancel" if !field("taskId").is_some_and(Value::is_string) => {
            issues.push(type_issue("string", &["params", "taskId"], field("taskId")));
        }
        "tasks/list" => {
            if let Some(cursor) = field("cursor")
                && !cursor.is_string()
            {
                issues.push(type_issue("string", &["params", "cursor"], Some(cursor)));
            }
        }
        _ => {}
    }
    issues
}

/// `JSON.stringify(issues, null, 2)`: the message of a ZodError.
pub fn issues_message(issues: &[Value]) -> String {
    unimux_core::js_json::stringify_pretty(&Value::Array(issues.to_vec()), 2)
}

/// JS numbers: a whole f64 is a number without `.0` (also when the value is printed by serde_json).
pub fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER { json!(n as i64) } else { json!(n) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_jsonrpc_messages() {
        let ok = |v: Value| valid_message(&v);
        assert!(ok(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })));
        assert!(ok(json!({ "jsonrpc": "2.0", "id": "a", "method": "ping", "params": { "_meta": { "progressToken": 3 } } })));
        assert!(ok(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })));
        assert!(ok(json!({ "jsonrpc": "2.0", "id": 1, "result": {} })));
        assert!(ok(json!({ "jsonrpc": "2.0", "error": { "code": -1, "message": "x", "data": [1] } })));
        assert!(!ok(json!({ "jsonrpc": "2.0", "id": 1.5, "method": "ping" })));
        assert!(!ok(json!({ "jsonrpc": "2.0", "id": 9_007_199_254_740_992u64, "method": "ping" })));
        assert!(!ok(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": [] })));
        assert!(!ok(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "foo": 1 })));
        assert!(!ok(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -1, "message": "x" } })));
        assert!(!ok(json!({ "jsonrpc": "2.0", "id": 1, "result": [] })));
        assert!(!ok(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping",
            "params": { "_meta": { "io.modelcontextprotocol/related-task": {} } } })));
        assert_eq!(id_key(&json!(7.0)), id_key(&json!(7)));
        assert_ne!(id_key(&json!("7")), id_key(&json!(7)));
    }

    #[test]
    fn zod_issue_lists_have_the_sdk_text() {
        let issues = schema_issues("tools/call", Some(&json!({ "name": 5 })));
        assert_eq!(
            issues_message(&issues),
            "[\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"params\",\n      \"name\"\n    ],\n    \"message\": \"Invalid input: expected string, received number\"\n  }\n]"
        );
        assert!(schema_issues("ping", None).is_empty());
        assert_eq!(schema_issues("tasks/get", Some(&json!({}))).len(), 1);
    }
}
