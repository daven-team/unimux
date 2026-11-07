//! The argument schemas: `automationSchemas` of src/shared/automation.ts (what AutomationService.execute parses first; M3
//! calls [`operation`]) and the `schema` of every MCP tool of src/main/mcpTools.ts ([`tool`]), built with [`crate::zod`].

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::json;

use crate::zod::{Pattern, Schema, array, boolean, enumeration, int, literal_true, number, object, string, unknown};

/// Longest bounded wait the schema allows (WAIT_SCHEMA_MAX).
pub const WAIT_SCHEMA_MAX: f64 = 600.0;
const PROJECT_ITEM_LIMIT_SCHEMA: f64 = 500.0;

/// `^#[0-9a-fA-F]{6}$`
fn is_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)
}
/// `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$`
fn is_model(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b[0].is_ascii_alphanumeric()
        && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'/' | b'-'))
}
const COLOR: Pattern = Pattern { source: "^#[0-9a-fA-F]{6}$", test: is_color };
const MODEL: Pattern = Pattern { source: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$", test: is_model };

fn id() -> Schema {
    string().min(1.0).max(128.0)
}
fn name() -> Schema {
    string().trim().min(1.0).max(140.0)
}
fn text() -> Schema {
    string().trim().min(1.0).max(32000.0)
}
fn color() -> Schema {
    string().regex(COLOR)
}
fn model() -> Schema {
    string().trim().min(1.0).max(128.0).regex(MODEL)
}
fn role() -> Schema {
    enumeration(&["coordinator", "worker"])
}
fn rows() -> Schema {
    array(int().min(1.0).max(5.0)).min(1.0).max(4.0)
}

/// `taskResultSchema`
pub fn task_result() -> Schema {
    object(vec![
        ("summary", text()),
        ("files", array(string().max(1000.0)).max(200.0).default(json!([]))),
        ("tests", array(string().max(2000.0)).max(100.0).default(json!([]))),
        ("branch", string().max(200.0).optional()),
        ("commit", string().max(128.0).optional()),
    ])
}

fn grid_cell() -> Schema {
    object(vec![
        ("profileId", id()),
        ("name", name().optional()),
        ("role", role().optional()),
        ("color", color().optional()),
        ("model", model().optional()),
        ("prompt", text().optional()),
        ("worktree", boolean().default(json!(false))),
        ("dir", string().min(1.0).max(1000.0).optional()),
        ("muted", literal_true().optional()),
    ])
}

fn launch_cell() -> Schema {
    grid_cell().extend(vec![("after", array(int().min(0.0).max(19.0)).max(19.0).optional())])
}

fn sizes() -> Schema {
    array(number().positive().max(1e6)).max(60.0)
}

fn grid_layout() -> Schema {
    object(vec![
        ("cols", int().min(1.0).max(60.0)),
        ("rows", int().min(1.0).max(4.0)),
        (
            "areas",
            array(object(vec![
                ("col", int().min(0.0).max(59.0)),
                ("row", int().min(0.0).max(3.0)),
                ("colSpan", int().min(1.0).max(60.0)),
                ("rowSpan", int().min(1.0).max(4.0)),
            ]))
            .min(1.0)
            .max(20.0),
        ),
        ("rowCounts", array(int().min(1.0).max(5.0)).min(1.0).max(4.0).optional()),
        ("rowSizes", sizes().optional()),
        ("colSizes", sizes().optional()),
        ("rowColSizes", array(sizes().nullable()).max(60.0).optional()),
        ("colRowSizes", array(sizes().nullable()).max(60.0).optional()),
        ("mode", enumeration(&["cols"]).optional()),
    ])
}

/// `z.literal('cols')` reads like a one-value enum (`Invalid input: expected "cols"`).
fn operations() -> Vec<(&'static str, Schema)> {
    let statuses = || enumeration(&["queued", "in_progress", "blocked", "completed", "cancelled"]);
    vec![
        ("get_context", object(vec![])),
        (
            "read_inbox",
            object(vec![
                ("acknowledge", boolean().default(json!(false))),
                ("openOnly", boolean().default(json!(false))),
                ("ackMaxChars", int().min(1.0).max(32000.0).optional()),
                ("limit", int().min(1.0).max(100.0).default(json!(50))),
                ("offset", int().min(0.0).default(json!(0))),
            ]),
        ),
        ("list_agents", object(vec![("projectId", id().optional())])),
        ("list_library", object(vec![("projectId", id().optional())])),
        ("get_snippet", object(vec![("snippetId", id())])),
        ("apply_snippet", object(vec![("snippetId", id()), ("cellId", id())])),
        (
            "create_grid",
            object(vec![
                ("projectId", id().optional()),
                ("name", name()),
                ("color", color().optional()),
                ("cells", array(launch_cell()).min(1.0).max(20.0).optional()),
                ("presetId", id().optional()),
                ("rows", rows().optional()),
                ("layout", grid_layout().optional()),
            ]),
        ),
        ("close_grid", object(vec![("gridId", id()), ("cancelTasks", boolean().default(json!(false)))])),
        (
            "add_agents",
            object(vec![
                ("gridId", id()),
                ("cells", array(launch_cell()).min(1.0).max(20.0)),
                ("rows", rows().optional()),
                ("layout", grid_layout().optional()),
            ]),
        ),
        ("update_grid", object(vec![("gridId", id()), ("name", name().optional()), ("color", color().nullable().optional())])),
        (
            "update_agent",
            object(vec![
                ("cellId", id()),
                ("name", name().optional()),
                ("color", color().nullable().optional()),
                ("profileId", id().optional()),
                ("model", model().nullable().optional()),
                ("restart", boolean().default(json!(false))),
            ]),
        ),
        (
            "save_snippet",
            object(vec![
                ("projectId", id().optional()),
                ("id", id().optional()),
                ("name", name()),
                ("text", text()),
                ("autoSend", boolean().default(json!(false))),
                ("icon", string().max(32.0).optional()),
                ("color", string().regex(COLOR).optional()),
            ]),
        ),
        (
            "save_preset",
            object(vec![
                ("projectId", id().optional()),
                ("id", id().optional()),
                ("name", name()),
                ("cells", array(grid_cell()).min(1.0).max(20.0)),
                ("rows", rows().optional()),
            ]),
        ),
        (
            "create_task",
            object(vec![
                ("cellId", id()),
                ("title", name()),
                ("prompt", text()),
                ("dependsOn", array(id()).max(50.0).optional()),
            ]),
        ),
        (
            "get_tasks",
            object(vec![
                ("readyOnly", boolean().default(json!(false))),
                ("projectId", id().optional()),
                ("cellId", id().optional()),
                ("ids", array(id()).min(1.0).max(50.0).optional()),
                ("status", statuses().optional()),
                ("limit", int().min(1.0).max(100.0).default(json!(50))),
                ("offset", int().min(0.0).default(json!(0))),
            ]),
        ),
        (
            "update_task",
            object(vec![
                ("taskId", id()),
                ("status", enumeration(&["in_progress", "blocked", "completed", "cancelled"]).optional()),
                ("cellId", id().optional()),
                ("blockedReason", text().optional()),
                ("result", task_result().optional()),
            ]),
        ),
        ("send_message", object(vec![("toCellId", id()), ("text", text())])),
        (
            "get_messages",
            object(vec![
                ("projectId", id().optional()),
                ("unreadOnly", boolean().default(json!(true))),
                ("limit", int().min(1.0).max(100.0).default(json!(50))),
                ("offset", int().min(0.0).default(json!(0))),
            ]),
        ),
        ("acknowledge_message", object(vec![("messageId", id())])),
        ("set_paused", object(vec![("paused", boolean())])),
        ("set_role", object(vec![("cellId", id()), ("role", role().nullable())])),
        ("deliver_task", object(vec![("taskId", id())])),
        ("deliver_message", object(vec![("messageId", id())])),
        (
            "wait_for",
            object(vec![
                ("taskIds", array(id()).min(1.0).max(50.0).optional()),
                ("all", boolean().default(json!(false))),
                ("timeoutSec", int().min(1.0).max(WAIT_SCHEMA_MAX).optional()),
            ]),
        ),
        ("mark_pasted", object(vec![("kind", enumeration(&["task", "message"])), ("id", id())])),
        (
            "remove_items",
            object(vec![
                ("projectId", id()),
                ("kind", enumeration(&["task", "message"])),
                ("ids", array(id()).min(1.0).max(PROJECT_ITEM_LIMIT_SCHEMA).optional()),
            ]),
        ),
    ]
}

static OPERATIONS: LazyLock<Vec<(&'static str, Schema)>> = LazyLock::new(operations);
static OPERATION_INDEX: LazyLock<HashMap<&'static str, usize>> =
    LazyLock::new(|| OPERATIONS.iter().enumerate().map(|(i, (k, _))| (*k, i)).collect());

/// The names of `automationSchemas` in declaration order (the automation operations).
pub fn operation_names() -> Vec<&'static str> {
    OPERATIONS.iter().map(|(k, _)| *k).collect()
}

/// `automationSchemas[op]` (`Object.hasOwn(automationSchemas, op)` is `is_some`).
pub fn operation(op: &str) -> Option<&'static Schema> {
    OPERATION_INDEX.get(op).map(|&i| &OPERATIONS[i].1)
}

fn optional_bool() -> Schema {
    boolean().optional()
}
fn optional_str() -> Schema {
    string().optional()
}

/// The `schema` of every MCP tool (mcpTools.ts): the tool layer checks types and the key set, the service the values. Four
/// tools validate with their operation's own schema.
fn tools() -> Vec<(&'static str, Schema)> {
    let op = |name: &str| operation(name).expect("operation schema").clone();
    vec![
        ("get_context", object(vec![("profiles", optional_bool())])),
        ("list_agents", object(vec![("verbose", optional_bool()), ("projectId", optional_str())])),
        (
            "read_inbox",
            object(vec![
                ("acknowledge", optional_bool()),
                ("closed", optional_bool()),
                ("openOnly", optional_bool()),
                ("full", optional_bool()),
                ("limit", int().optional()),
                ("offset", int().optional()),
            ]),
        ),
        (
            "wait_for",
            object(vec![("taskIds", array(string()).optional()), ("all", optional_bool()), ("timeoutSec", int().optional())]),
        ),
        ("update_task", op("update_task")),
        ("send_message", op("send_message")),
        ("create_task", op("create_task")),
        (
            "get_tasks",
            object(vec![
                ("cellId", optional_str()),
                ("status", optional_str()),
                ("readyOnly", optional_bool()),
                ("ids", array(string()).optional()),
                ("verbose", optional_bool()),
                ("limit", int().optional()),
                ("offset", int().optional()),
                ("projectId", optional_str()),
            ]),
        ),
        (
            "snippets",
            object(vec![
                ("action", enumeration(&["list", "get", "save", "apply"]).optional()),
                ("snippetId", optional_str()),
                ("cellId", optional_str()),
                ("name", optional_str()),
                ("text", optional_str()),
                ("autoSend", optional_bool()),
            ]),
        ),
        (
            "update_agent",
            object(vec![
                ("cellId", optional_str()),
                ("name", optional_str()),
                ("color", string().nullable().optional()),
                ("profileId", optional_str()),
                ("model", string().nullable().optional()),
                ("restart", optional_bool()),
            ]),
        ),
        (
            "create_grid",
            object(vec![
                ("name", optional_str()),
                ("gridId", optional_str()),
                ("color", optional_str()),
                ("presetId", optional_str()),
                ("rows", array(int()).optional()),
                ("cells", array(unknown()).optional()),
                ("layout", unknown().optional()),
                ("projectId", optional_str()),
            ]),
        ),
        ("close_grid", op("close_grid")),
        ("update_grid", object(vec![("gridId", string()), ("name", optional_str()), ("color", string().nullable().optional())])),
        (
            "save_preset",
            object(vec![
                ("name", string()),
                ("cells", array(unknown())),
                ("rows", array(int()).optional()),
                ("id", optional_str()),
            ]),
        ),
        ("deliver", object(vec![("taskId", optional_str()), ("messageId", optional_str())])),
        ("help", object(vec![("topic", enumeration(crate::catalog::HELP_TOPICS).optional())])),
    ]
}

static TOOLS: LazyLock<Vec<(&'static str, Schema)>> = LazyLock::new(tools);

/// The argument schema of an MCP tool.
pub fn tool(name: &str) -> Option<&'static Schema> {
    TOOLS.iter().find(|(k, _)| *k == name).map(|(_, s)| s)
}

/// Whether the tool validates with the operation's own schema (`tool.schema === automationSchemas[op]`).
pub fn tool_uses_operation_schema(name: &str) -> bool {
    matches!(name, "update_task" | "send_message" | "create_task" | "close_grid")
}
