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
    let path: Vec<Value> = path.iter().map(|p| json!(p)).collect();
    type_issue_at(expected, &path, got)
}

fn type_issue_at(expected: &str, path: &[Value], got: Option<&Value>) -> Value {
    json!({ "expected": expected, "code": "invalid_type", "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", received(got)) })
}

/// The zod issues of InitializeRequestSchema's params (SDK 1.32.2): protocolVersion, ClientCapabilitiesSchema and
/// ImplementationSchema, in the schemas' key order. Unknown keys are allowed everywhere (z.object strips, loose keeps).
mod init_schema {
    use serde_json::{Value, json};

    use super::type_issue_at;

    type Path = Vec<Value>;

    fn at(path: &Path, key: impl Into<Value>) -> Path {
        let mut p = path.clone();
        p.push(key.into());
        p
    }

    /// z.object / z.looseObject: a plain object (not null, not an array).
    fn object<'a>(v: &'a Value, path: &Path, out: &mut Vec<Value>) -> Option<&'a serde_json::Map<String, Value>> {
        let o = v.as_object();
        if o.is_none() {
            out.push(type_issue_at("object", path, Some(v)));
        }
        o
    }

    /// The SDK's AssertObjectSchema: `v !== null && typeof v === 'object'` (arrays pass).
    fn assert_object(o: &serde_json::Map<String, Value>, key: &str, path: &Path, out: &mut Vec<Value>) {
        if let Some(v) = o.get(key)
            && !(v.is_object() || v.is_array())
        {
            out.push(json!({ "code": "custom", "path": at(path, key), "message": "Invalid input" }));
        }
    }

    fn optional_string(o: &serde_json::Map<String, Value>, key: &str, path: &Path, out: &mut Vec<Value>) {
        if let Some(v) = o.get(key)
            && !v.is_string()
        {
            out.push(type_issue_at("string", &at(path, key), Some(v)));
        }
    }

    fn required_string(o: &serde_json::Map<String, Value>, key: &str, path: &Path, out: &mut Vec<Value>) {
        if !o.get(key).is_some_and(Value::is_string) {
            out.push(type_issue_at("string", &at(path, key), o.get(key)));
        }
    }

    /// z.record(z.string(), AssertObjectSchema).
    fn record_of_objects(o: &serde_json::Map<String, Value>, key: &str, path: &Path, out: &mut Vec<Value>) {
        let Some(v) = o.get(key) else { return };
        let path = at(path, key);
        match v.as_object() {
            None => out.push(type_issue_at("record", &path, Some(v))),
            Some(r) => {
                for k in r.keys() {
                    assert_object(r, k, &path, out);
                }
            }
        }
    }

    /// z.intersection(z.object({...}), z.record(...)) on a value that is not a plain object: both sides fail.
    fn intersection_type(v: &Value, path: &Path, out: &mut Vec<Value>) -> bool {
        if v.is_object() {
            return true;
        }
        out.push(type_issue_at("object", path, Some(v)));
        out.push(type_issue_at("record", path, Some(v)));
        false
    }

    fn capabilities(v: &Value, path: &Path, out: &mut Vec<Value>) {
        let Some(c) = object(v, path, out) else { return };
        record_of_objects(c, "experimental", path, out);
        if let Some(s) = c.get("sampling")
            && let Some(s) = object(s, &at(path, "sampling"), out)
        {
            let p = at(path, "sampling");
            assert_object(s, "context", &p, out);
            assert_object(s, "tools", &p, out);
        }
        if let Some(e) = c.get("elicitation") {
            let p = at(path, "elicitation");
            // The preprocess turns `{}` into `{ form: {} }`, which passes.
            if intersection_type(e, &p, out) {
                let e = e.as_object().expect("checked");
                if let Some(form) = e.get("form") {
                    let fp = at(&p, "form");
                    if intersection_type(form, &fp, out)
                        && let Some(d) = form.get("applyDefaults")
                        && !d.is_boolean()
                    {
                        out.push(type_issue_at("boolean", &at(&fp, "applyDefaults"), Some(d)));
                    }
                }
                assert_object(e, "url", &p, out);
            }
        }
        if let Some(r) = c.get("roots")
            && let Some(r) = object(r, &at(path, "roots"), out)
            && let Some(l) = r.get("listChanged")
            && !l.is_boolean()
        {
            out.push(type_issue_at("boolean", &at(&at(path, "roots"), "listChanged"), Some(l)));
        }
        if let Some(t) = c.get("tasks") {
            let p = at(path, "tasks");
            if let Some(t) = object(t, &p, out) {
                assert_object(t, "list", &p, out);
                assert_object(t, "cancel", &p, out);
                if let Some(r) = t.get("requests") {
                    let rp = at(&p, "requests");
                    if let Some(r) = object(r, &rp, out) {
                        for (kind, method) in [("sampling", "createMessage"), ("elicitation", "create")] {
                            if let Some(k) = r.get(kind)
                                && let Some(k) = object(k, &at(&rp, kind), out)
                            {
                                assert_object(k, method, &at(&rp, kind), out);
                            }
                        }
                    }
                }
            }
        }
        record_of_objects(c, "extensions", path, out);
    }

    fn icon(v: &Value, path: &Path, out: &mut Vec<Value>) {
        let Some(i) = object(v, path, out) else { return };
        required_string(i, "src", path, out);
        optional_string(i, "mimeType", path, out);
        if let Some(sizes) = i.get("sizes") {
            let p = at(path, "sizes");
            match sizes.as_array() {
                None => out.push(type_issue_at("array", &p, Some(sizes))),
                Some(items) => {
                    for (n, s) in items.iter().enumerate() {
                        if !s.is_string() {
                            out.push(type_issue_at("string", &at(&p, n), Some(s)));
                        }
                    }
                }
            }
        }
        if let Some(theme) = i.get("theme")
            && theme != "light"
            && theme != "dark"
        {
            out.push(json!({ "code": "invalid_value", "values": ["light", "dark"], "path": at(path, "theme"),
                "message": "Invalid option: expected one of \"light\"|\"dark\"" }));
        }
    }

    fn implementation(v: &Value, path: &Path, out: &mut Vec<Value>) {
        let Some(o) = object(v, path, out) else { return };
        required_string(o, "name", path, out);
        optional_string(o, "title", path, out);
        if let Some(icons) = o.get("icons") {
            let p = at(path, "icons");
            match icons.as_array() {
                None => out.push(type_issue_at("array", &p, Some(icons))),
                Some(items) => {
                    for (n, item) in items.iter().enumerate() {
                        icon(item, &at(&p, n), out);
                    }
                }
            }
        }
        required_string(o, "version", path, out);
        optional_string(o, "websiteUrl", path, out);
        optional_string(o, "description", path, out);
    }

    /// The issues of `params` (None: the key is missing).
    pub fn issues(params: Option<&Value>) -> Vec<Value> {
        let mut out = Vec::new();
        let root: Path = vec![json!("params")];
        let Some(p) = params.and_then(Value::as_object) else {
            out.push(type_issue_at("object", &root, params));
            return out;
        };
        required_string(p, "protocolVersion", &root, &mut out);
        match p.get("capabilities") {
            Some(c) => capabilities(c, &at(&root, "capabilities"), &mut out),
            None => out.push(type_issue_at("object", &at(&root, "capabilities"), None)),
        }
        match p.get("clientInfo") {
            Some(c) => implementation(c, &at(&root, "clientInfo"), &mut out),
            None => out.push(type_issue_at("object", &at(&root, "clientInfo"), None)),
        }
        out
    }
}

/// The SDK's `isInitializeRequest` (InitializeRequestSchema.safeParse, which does not look at `id`): an `initialize`
/// whose params pass the schema. Only such a message initializes a transport.
pub fn is_initialize(m: &Value) -> bool {
    m["method"] == "initialize" && init_schema::issues(m.get("params")).is_empty()
}

/// CancelledNotificationSchema's params: `requestId` a RequestId and `reason` a string, each optional. A notification
/// failing it is dropped by the SDK (an explicit `"reason": null` too).
pub fn cancelled_params_ok(params: &Value) -> bool {
    params.get("requestId").is_none_or(is_id) && params.get("reason").is_none_or(Value::is_string)
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
        "initialize" => issues = init_schema::issues(params),
        // ListToolsRequestSchema / ListTasksRequestSchema: PaginatedRequestParamsSchema, `cursor` an optional string.
        "tools/list" | "tasks/list" => {
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
        assert_eq!(schema_issues("tools/list", Some(&json!({ "cursor": 5 }))).len(), 1);
        assert!(schema_issues("tools/list", None).is_empty());
        let init = |params: Value| json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": params });
        let ok = json!({ "protocolVersion": "x", "capabilities": { "elicitation": {}, "foo": 1 },
            "clientInfo": { "name": "a", "version": "1", "extra": true } });
        assert!(is_initialize(&init(ok.clone())));
        assert!(is_initialize(&json!({ "jsonrpc": "2.0", "method": "initialize", "params": ok })));
        assert!(!is_initialize(&init(json!({ "protocolVersion": "x", "capabilities": { "elicitation": {} } }))));
        assert!(!is_initialize(&json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize" })));
        assert!(cancelled_params_ok(&json!({ "requestId": 7 })) && cancelled_params_ok(&json!({ "reason": "x" })));
        assert!(!cancelled_params_ok(&json!({ "requestId": 7, "reason": null })));
        assert!(!cancelled_params_ok(&json!({ "requestId": 1.5 })));
        assert_eq!(schema_issues("tasks/get", Some(&json!({}))).len(), 1);
    }
}
