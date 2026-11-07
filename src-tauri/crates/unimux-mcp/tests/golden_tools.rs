//! The tool layer against the 1.1.4 reference (written by scripts/goldens-mcp.mjs through `npm run gen:goldens`):
//! test/golden/mcp-tools.json (tools/list per role, instructions), mcp-zod.jsonl (the argument schemas) and mcp-calls.jsonl
//! (callTool over a scripted service). Every comparison is on JSON.stringify text, so key order counts too.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use unimux_core::js_json::{self, stringify};
use unimux_mcp::catalog::{self, Delegation, Role, Who};
use unimux_mcp::elicit::ElicitAnswer;
use unimux_mcp::host::{McpTools, plain_ctx};
use unimux_mcp::tools::{ABORTED, BoxFuture, Elicit};
use unimux_mcp::{Automation, CallError, OpError, ToolHost, schemas};

fn golden(name: &str) -> String {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (run `npm run gen:goldens`)"))
}

fn rows(name: &str) -> Vec<Value> {
    golden(name).lines().filter(|l| !l.is_empty()).map(|l| js_json::parse(l).expect("golden row")).collect()
}

/// scripts/goldens-mcp.mjs expand: {"$repeat"} and {"$cat"} markers to strings.
fn expand(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
        Value::Object(m) => {
            if m.len() == 2
                && let (Some(Value::String(ch)), Some(n)) = (m.get("$repeat"), m.get("n").and_then(Value::as_u64))
            {
                return Value::String(ch.repeat(n as usize));
            }
            if m.len() == 1
                && let Some(Value::Array(parts)) = m.get("$cat")
            {
                return Value::String(parts.iter().map(|p| expand(p).as_str().unwrap_or_default().to_string()).collect());
            }
            Value::Object(m.iter().map(|(k, v)| (k.clone(), expand(v))).collect())
        }
        other => other.clone(),
    }
}

/// scripts/goldens-mcp.mjs compactLong: a string of one repeated character longer than 40 becomes {"$repeat"}.
fn compact_long(v: &Value) -> Value {
    match v {
        Value::String(s) => {
            let mut chars = s.chars();
            let first = chars.clone().next();
            let n = s.chars().count();
            match first {
                Some(c) if n > 40 && chars.all(|x| x == c) => json!({ "$repeat": c.to_string(), "n": n }),
                _ => v.clone(),
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(compact_long).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), compact_long(v))).collect()),
        other => other.clone(),
    }
}

fn role(s: &str) -> Role {
    Role::parse(s).unwrap()
}

#[test]
fn tools_list_per_role_is_byte_identical_to_1_1_4() {
    let g = js_json::parse(&golden("mcp-tools.json")).unwrap();
    assert_eq!(stringify(&Value::Array(catalog::tools_for_role(Some(Role::Coordinator)).to_vec())), stringify(&g["coordinator"]));
    assert_eq!(stringify(&Value::Array(catalog::tools_for_role(Some(Role::Worker)).to_vec())), stringify(&g["worker"]));
    assert_eq!(stringify(&Value::Array(catalog::tools_for_role(None).to_vec())), stringify(&g["none"]));
    let names: Vec<&str> = catalog::definitions_all().iter().map(|t| t.name).collect();
    assert_eq!(json!(names), g["names"]);
    let unlisted: Vec<&str> = catalog::definitions_all().iter().filter(|t| t.unlisted).map(|t| t.name).collect();
    assert_eq!(json!(unlisted), g["unlisted"]);
    for t in catalog::definitions_all() {
        let roles: Vec<&str> = t.roles.iter().map(|r| r.as_str()).collect();
        assert_eq!(json!(roles), g["roles"][t.name], "{}", t.name);
    }
    let candidates = names.iter().copied().chain(["nope", "read_inbox"]);
    let task: Vec<&str> = candidates.filter(|n| catalog::supports_task(n)).collect();
    assert_eq!(json!(task), g["taskCapable"]);
    assert_eq!(json!(catalog::LEGACY_OPERATIONS), g["legacy"]);
    assert_eq!(catalog::LEGACY_OPERATIONS.len(), 22);
}

#[test]
fn instructions_per_role_caller_and_delegation_are_byte_identical_to_1_1_4() {
    let g = js_json::parse(&golden("mcp-tools.json")).unwrap();
    let rows = g["instructions"].as_array().unwrap();
    assert!(rows.len() > 300);
    for row in rows {
        let r = row["role"].as_str().map(role);
        let who = &row["who"];
        let state = if row["delegation"] == json!("$absent") {
            json!({ "settings": {} })
        } else {
            json!({ "settings": { "delegation": row["delegation"] } })
        };
        let w = Who { cell: who["cellId"].as_str().unwrap(), name: who.get("name"), project: who.get("project") };
        assert_eq!(catalog::instructions(r, &w, &Delegation::of_state(&state)), row["out"].as_str().unwrap(), "{row}");
    }
}

#[test]
fn argument_schemas_parse_and_fail_like_zod_4() {
    let rows = rows("mcp-zod.jsonl");
    assert!(rows.len() > 20_000, "{}", rows.len());
    let mut failures = Vec::new();
    for row in &rows {
        let name = row["schema"].as_str().unwrap();
        let schema = match name.split_once(':') {
            Some(("op", op)) => schemas::operation(op),
            Some(("tool", tool)) => schemas::tool(tool),
            _ => None,
        }
        .unwrap_or_else(|| panic!("no schema {name}"));
        let input = expand(&row["input"]);
        let got = match schema.parse(&input) {
            Ok(out) => json!({ "out": compact_long(&out) }),
            Err(issues) => json!({
                "issues": issues.iter().map(|i| i.to_json()).collect::<Vec<_>>(),
                "text": unimux_mcp::zod::describe(&issues),
            }),
        };
        let want = match row.get("out") {
            Some(out) => json!({ "out": out }),
            None => json!({ "issues": row["issues"], "text": row["text"] }),
        };
        if stringify(&got) != stringify(&want) && failures.len() < 20 {
            failures.push(format!(
                "{name} {}\n  got  {}\n  want {}",
                stringify(&row["input"]),
                stringify(&got),
                stringify(&want)
            ));
        }
    }
    assert!(failures.is_empty(), "{} mismatches, first:\n{}", failures.len(), failures.join("\n"));
    // The four tools that validate with their operation's own schema have no rows of their own.
    for t in ["update_task", "send_message", "create_task", "close_grid"] {
        assert!(schemas::tool_uses_operation_schema(t));
        let tool = schemas::tool(t).unwrap();
        let op = schemas::operation(t).unwrap();
        for input in [
            json!({}),
            json!({ "taskId": "t", "status": "x", "extra": 1 }),
            json!({ "gridId": "g", "toCellId": " c ", "text": " t " }),
        ] {
            assert_eq!(tool.parse(&input), op.parse(&input), "{t}");
        }
    }
}

/// The scripted service of scripts/goldens-mcp.mjs: validates like AutomationService.execute first, answers from a queue.
struct Scripted {
    state: Arc<Value>,
    roles: Value,
    responses: Mutex<serde_json::Map<String, Value>>,
    shown: Mutex<HashMap<String, Arc<Mutex<HashSet<String>>>>>,
    calls: Mutex<Vec<Value>>,
}

impl Automation for Scripted {
    fn state(&self) -> Arc<Value> {
        self.state.clone()
    }
    fn role_of(&self, cell: &str) -> Option<Role> {
        if let Some(r) = self.roles.get(cell).and_then(Value::as_str) {
            return Role::parse(r);
        }
        unimux_mcp::automation::find_cell(&self.state, cell).and_then(|(_, _, c)| c["role"].as_str()).and_then(Role::parse)
    }
    fn prompts_shown(&self, cell: &str) -> Arc<Mutex<HashSet<String>>> {
        self.shown.lock().entry(cell.to_string()).or_default().clone()
    }
    fn execute(
        &self,
        op: &str,
        args: Value,
        actor: &str,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'static, Result<Value, OpError>> {
        // `signal`: whether the call gets the request's cancellation (1.1.4 passes ctx.signal only to wait_for, the long
        // wait's slices and the legacy names).
        self.calls
            .lock()
            .push(json!({ "op": op, "args": stringify(&compact_long(&args)), "actor": actor, "signal": cancel.is_some() }));
        let result = (|| {
            schemas::operation(op).unwrap().parse(&args).map_err(OpError::Invalid)?;
            let mut responses = self.responses.lock();
            let answer = match responses.get_mut(op) {
                Some(Value::Array(queue)) if !queue.is_empty() => queue.remove(0),
                Some(Value::Array(_)) | None => Value::Null,
                Some(single) => single.clone(),
            };
            if answer.is_null() {
                return Err(OpError::Message(format!("no fake answer for {op}")));
            }
            if let Some(e) = answer.get("error") {
                return Err(OpError::Message(e.as_str().unwrap().to_string()));
            }
            Ok(answer["value"].clone())
        })();
        Box::pin(async move { result })
    }
}

#[tokio::test]
async fn call_tool_over_a_scripted_service_matches_1_1_4() {
    let rows = rows("mcp-calls.jsonl");
    assert!(rows.len() >= 35, "{}", rows.len());
    let mut failures = Vec::new();
    let mut steps = 0;
    for row in &rows {
        let scenario = row["scenario"].as_str().unwrap();
        let service = Arc::new(Scripted {
            state: Arc::new(expand(&row["state"])),
            roles: row["roles"].clone(),
            responses: Mutex::new(expand(&row["responses"]).as_object().cloned().unwrap_or_default()),
            shown: Mutex::default(),
            calls: Mutex::default(),
        });
        let language = row["language"].as_str().map(str::to_string);
        let tools = match language {
            Some(lang) => McpTools::with_tr(
                service.clone(),
                Arc::new(move |key: &str, params: &[(&str, String)]| {
                    let p: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
                    unimux_core::i18n::translate(&lang, key, &p)
                }),
            ),
            None => McpTools::new(service.clone()),
        };
        let answers: Option<Arc<Mutex<Vec<Value>>>> =
            row["elicit"].as_array().map(|a| Arc::new(Mutex::new(expand(&json!(a)).as_array().unwrap().clone())));
        for step in row["steps"].as_array().unwrap() {
            steps += 1;
            let elicits: Arc<Mutex<Vec<Value>>> = Arc::default();
            let mut ctx = plain_ctx(row["actor"].as_str().unwrap(), row["task"] == json!(true));
            if let Some(answers) = &answers {
                let (answers, elicits) = (answers.clone(), elicits.clone());
                let elicit: Elicit = Arc::new(move |message: String, schema: Value| {
                    elicits.lock().push(json!({ "message": message, "schema": schema }));
                    let next = {
                        let mut a = answers.lock();
                        if a.is_empty() { None } else { Some(a.remove(0)) }
                    };
                    let answer = match next {
                        Some(v) => {
                            ElicitAnswer { action: v["action"].as_str().unwrap().to_string(), content: v.get("content").cloned() }
                        }
                        None => ElicitAnswer::cancel(),
                    };
                    Box::pin(async move { answer })
                });
                ctx.elicit = Some(elicit);
            }
            service.calls.lock().clear();
            let tool = step["tool"].as_str().unwrap().to_string();
            let args = if step["args"].is_null() { None } else { Some(expand(&step["args"])) };
            let outcome = tools.clone().call(tool.clone(), args, ctx).await;
            let mut got = serde_json::Map::new();
            got.insert("tool".into(), json!(tool));
            got.insert("args".into(), step["args"].clone());
            match outcome {
                Ok(v) => {
                    got.insert("result".into(), json!(stringify(&compact_long(&v))));
                }
                Err(CallError::Unknown) => {
                    got.insert("unknown".into(), json!(true));
                }
                Err(CallError::Tool(text)) => {
                    got.insert("error".into(), json!(text));
                }
                Err(CallError::Aborted) => {
                    got.insert("error".into(), json!(ABORTED));
                }
            }
            got.insert("calls".into(), Value::Array(service.calls.lock().clone()));
            got.insert("elicits".into(), Value::Array(elicits.lock().clone()));
            let (got, want) = (stringify(&Value::Object(got)), stringify(step));
            if got != want && failures.len() < 20 {
                failures.push(format!("{scenario} / {tool}\n  got  {got}\n  want {want}"));
            }
        }
    }
    assert!(steps > 150, "{steps}");
    assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.join("\n"));
}
