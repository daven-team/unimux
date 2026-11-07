//! The tool definitions themselves: 1.1.4's mcp-protocol.test.ts 'token footprint' and 'tool definitions are portable across
//! Claude Code and Codex', and the MCP part of zod-schemas.test.ts (the hand-written JSON Schemas, the tool schemas).

use serde_json::{Value, json};
use unimux_core::js_json::stringify;
use unimux_core::utf16;
use unimux_mcp::catalog::{self, Delegation, Role, Who};
use unimux_mcp::schemas;

/// `Math.round(JSON.stringify(value).length / 3.6)`
fn tokens(v: &Value) -> f64 {
    (utf16::len(&stringify(v)) as f64 / 3.6).round()
}

fn listed(role: Role) -> &'static [Value] {
    catalog::tools_for_role(Some(role))
}

#[test]
fn lists_role_specific_tools_that_are_at_least_40_percent_cheaper_than_the_old_21_tool_list() {
    // Before the redesign every role received all 21 tools: 14754 chars (~4098 tokens) plus 1175 chars of instructions.
    let cell = "3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091";
    let size = |role: Role, name: &str| {
        let model_facing: Vec<Value> = listed(role)
            .iter()
            .map(|t| json!({ "name": t["name"], "description": t["description"], "input_schema": t["inputSchema"] }))
            .collect();
        let who = Who { cell, name: Some(&json!(name)), project: Some(&json!("Project")) };
        let instructions = catalog::instructions(Some(role), &who, &Delegation::default());
        tokens(&Value::Array(model_facing)) + tokens(&json!(instructions))
    };
    let coordinator = size(Role::Coordinator, "Lead");
    let worker = size(Role::Worker, "Backend");
    assert!(coordinator < 4425.0 * 0.6, "{coordinator}");
    assert!(worker < 4425.0 * 0.6, "{worker}");
    assert!(worker < coordinator);
}

#[test]
fn shows_workers_none_of_the_coordinator_only_tools() {
    let names: Vec<&str> = listed(Role::Worker).iter().map(|t| t["name"].as_str().unwrap()).collect();
    for name in ["create_grid", "close_grid", "update_grid", "save_preset", "create_task", "get_tasks", "deliver", "snippets"] {
        assert!(!names.contains(&name), "{name}");
    }
    for name in ["get_context", "read_inbox", "wait_for", "update_task", "send_message", "update_agent", "list_agents", "help"] {
        assert!(names.contains(&name), "{name}");
    }
}

fn walk(schema: &Value, path: &str, problems: &mut Vec<String>) {
    let Some(s) = schema.as_object() else { return };
    for keyword in ["$ref", "$schema", "$defs", "definitions", "anyOf", "oneOf", "allOf", "not", "if", "const"] {
        if s.contains_key(keyword) {
            problems.push(format!("{path}: {keyword}"));
        }
    }
    match s.get("type") {
        None => problems.push(format!("{path}: missing type")),
        Some(Value::Array(_)) | Some(Value::String(_)) if s["type"].is_array() || s["type"] == "null" => {
            problems.push(format!("{path}: type {}", s["type"]))
        }
        _ => {}
    }
    if s.get("type") == Some(&json!("array")) {
        match s.get("items") {
            None => problems.push(format!("{path}: array without items")),
            Some(items) => walk(items, &format!("{path}[]"), problems),
        }
    }
    if s.get("type") == Some(&json!("object")) {
        match s.get("properties").and_then(Value::as_object) {
            None => problems.push(format!("{path}: object without properties")),
            Some(props) => {
                for (k, v) in props {
                    walk(v, &format!("{path}.{k}"), problems);
                }
            }
        }
    }
}

#[test]
fn uses_flat_self_contained_schemas_and_valid_tool_names_for_every_role() {
    for role in [Role::Coordinator, Role::Worker] {
        for tool in listed(role) {
            let name = tool["name"].as_str().unwrap();
            let mut problems = Vec::new();
            walk(&tool["inputSchema"], name, &mut problems);
            assert!(problems.is_empty(), "{name}: {problems:?}");
            assert!(
                !name.is_empty() && name.len() <= 40 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            );
            // Claude Code and Codex prefix the server name: mcp__unimux__<tool> must stay within 64 characters.
            assert!(format!("mcp__unimux__{name}").len() <= 64);
            assert!(utf16::len(tool["description"].as_str().unwrap()) <= 420, "{name}");
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
    }
}

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    k.sort();
    k
}

#[test]
fn keeps_the_advertised_properties_in_step_with_what_the_tools_accept() {
    // Accepted but intentionally not advertised (kept for older prompts or because help documents them).
    let hidden = |name: &str| -> &'static [&'static str] {
        match name {
            "list_agents" => &["projectId"],
            "read_inbox" => &["offset", "openOnly"],
            "get_tasks" => &["projectId"],
            "create_grid" => &["layout", "projectId", "color"],
            "save_preset" => &["id"],
            "update_grid" => &["color"],
            "update_task" => &["cellId"],
            _ => &[],
        }
    };
    // The base definitions are what a role without an override lists; check them through the role that lists the tool.
    for def in catalog::definitions_all() {
        let role = def.roles[0];
        let shown = catalog::tools_for_role(Some(role)).iter().find(|t| t["name"] == def.name);
        let base = match shown {
            // update_task's coordinator variant differs; the worker one is the base definition.
            Some(_) if def.name == "update_task" => {
                listed(Role::Worker).iter().find(|t| t["name"] == "update_task").unwrap().clone()
            }
            Some(_) if def.name == "update_agent" => {
                listed(Role::Coordinator).iter().find(|t| t["name"] == "update_agent").unwrap().clone()
            }
            Some(t) => t.clone(),
            None => continue, // deliver: unlisted
        };
        let advertised = keys(&base["inputSchema"]["properties"]);
        let mut accepted: Vec<String> = schemas::tool(def.name)
            .unwrap()
            .shape_keys()
            .into_iter()
            .filter(|k| !hidden(def.name).contains(k))
            .map(str::to_string)
            .collect();
        accepted.sort();
        assert_eq!(advertised, accepted, "{}", def.name);
        let required: Vec<&str> = base["inputSchema"]["required"]
            .as_array()
            .map(|r| r.iter().map(|v| v.as_str().unwrap()).collect())
            .unwrap_or_default();
        assert!(required.iter().all(|k| advertised.iter().any(|a| a == k)), "{}", def.name);
    }
    // Role-specific variants may only advertise things the tool accepts.
    for role in [Role::Coordinator, Role::Worker] {
        for t in listed(role) {
            let accepted = schemas::tool(t["name"].as_str().unwrap()).unwrap().shape_keys();
            assert!(
                keys(&t["inputSchema"]["properties"]).iter().all(|k| accepted.contains(&k.as_str())),
                "{role:?} {}",
                t["name"]
            );
        }
    }
}

#[test]
fn declares_hints_so_codex_asks_before_cross_agent_launch_setting_and_agent_spawning_calls() {
    let hints = |role: Role| -> serde_json::Map<String, Value> {
        listed(role).iter().map(|t| (t["name"].as_str().unwrap().to_string(), t["annotations"].clone())).collect()
    };
    let ask = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true });
    let quiet = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false });
    let read = json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false });
    let destructive = json!({ "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false });
    let w = hints(Role::Worker);
    for (name, want) in [
        ("get_context", &read),
        ("list_agents", &read),
        ("wait_for", &read),
        ("help", &read),
        ("read_inbox", &quiet),
        ("update_task", &quiet),
        ("send_message", &ask),
        ("update_agent", &ask),
    ] {
        assert_eq!(&w[name], want, "worker {name}");
    }
    let c = hints(Role::Coordinator);
    for (name, want) in [
        ("get_tasks", &read),
        ("create_task", &ask),
        ("create_grid", &ask),
        ("update_agent", &ask),
        ("snippets", &ask),
        ("update_task", &destructive),
        ("close_grid", &destructive),
        ("update_grid", &quiet),
        ("save_preset", &quiet),
        ("read_inbox", &quiet),
    ] {
        assert_eq!(&c[name], want, "coordinator {name}");
    }
}

#[test]
fn shows_workers_only_name_and_color_in_update_agent() {
    let worker = listed(Role::Worker).iter().find(|t| t["name"] == "update_agent").unwrap();
    assert_eq!(keys(&worker["inputSchema"]["properties"]), ["color", "name"]);
    let lead = listed(Role::Coordinator).iter().find(|t| t["name"] == "update_agent").unwrap();
    assert!(lead["inputSchema"]["properties"].get("model").is_some());
}

#[test]
fn the_tool_schemas_accept_omitted_unknown_typed_fields_and_the_json_schemas_stay_hand_written() {
    let grid = schemas::tool("create_grid").unwrap();
    assert_eq!(grid.parse(&json!({ "name": "G" })).unwrap(), json!({ "name": "G" }));
    let any = json!({ "name": "G", "cells": [{ "any": 1 }], "layout": "x" });
    assert_eq!(stringify(&grid.parse(&any).unwrap()), r#"{"name":"G","cells":[{"any":1}],"layout":"x"}"#);
    for role in [Role::Coordinator, Role::Worker] {
        for t in listed(role) {
            assert_eq!(t["inputSchema"]["type"], "object");
            let text = stringify(&t["inputSchema"]);
            assert!(!text.contains("$schema") && !text.contains("$ref") && !text.contains("anyOf"), "{text}");
        }
    }
    // A ZodError becomes an "Invalid arguments" text with the paths of the first issues.
    let op = schemas::operation("update_task").unwrap();
    let issues = op.parse(&json!({ "taskId": "t", "status": "bogus" })).unwrap_err();
    assert!(unimux_mcp::zod::describe(&issues).starts_with("Invalid arguments - status: "));
    let issues = schemas::operation("get_context").unwrap().parse(&json!({ "a": 1, "b": 2 })).unwrap_err();
    assert_eq!(unimux_mcp::zod::describe(&issues), "Invalid arguments - arguments: Unrecognized keys: \"a\", \"b\"");
}

#[test]
fn defaults_trims_and_strict_keys_of_the_automation_schemas() {
    // zod-schemas.test.ts 'automation schemas after zod 4'.
    let inbox = schemas::operation("read_inbox").unwrap();
    assert_eq!(stringify(&inbox.parse(&json!({})).unwrap()), r#"{"acknowledge":false,"openOnly":false,"limit":50,"offset":0}"#);
    assert_eq!(schemas::operation("wait_for").unwrap().parse(&json!({})).unwrap(), json!({ "all": false }));
    assert!(inbox.parse(&json!({ "acknowledge": null })).is_err());
    let update = schemas::operation("update_task").unwrap();
    assert_eq!(
        update.parse(&json!({ "taskId": "t", "status": "completed" })).unwrap(),
        json!({ "taskId": "t", "status": "completed" })
    );
    assert_eq!(
        stringify(&update.parse(&json!({ "taskId": "t", "status": "completed", "result": { "summary": "  done " } })).unwrap()),
        r#"{"taskId":"t","status":"completed","result":{"summary":"done","files":[],"tests":[]}}"#
    );
    let issues =
        update.parse(&json!({ "taskId": "t", "status": "completed", "result": { "summary": "s", "extra": 1 } })).unwrap_err();
    assert_eq!((issues[0].code, issues[0].path.len()), ("unrecognized_keys", 1));
    let agent = schemas::operation("update_agent").unwrap();
    assert_eq!(
        stringify(&agent.parse(&json!({ "cellId": "c", "color": null, "model": null })).unwrap()),
        r#"{"cellId":"c","color":null,"model":null,"restart":false}"#
    );
    assert!(agent.parse(&json!({ "cellId": "c", "model": "-bad" })).is_err());
    let grid = schemas::operation("create_grid").unwrap();
    let parsed =
        grid.parse(&json!({ "name": "G", "cells": [{ "profileId": "p", "muted": true, "dir": "C:/x", "after": [0] }] })).unwrap();
    assert_eq!(stringify(&parsed["cells"]), r#"[{"profileId":"p","worktree":false,"dir":"C:/x","muted":true,"after":[0]}]"#);
    assert!(grid.parse(&json!({ "name": "G", "cells": [{ "profileId": "p", "muted": false }] })).is_err());
    assert_eq!(
        schemas::operation("set_role").unwrap().parse(&json!({ "cellId": "c", "role": null })).unwrap(),
        json!({ "cellId": "c", "role": null })
    );
    assert!(schemas::operation("wait_for").unwrap().parse(&json!({ "timeoutSec": 601 })).is_err());
}
