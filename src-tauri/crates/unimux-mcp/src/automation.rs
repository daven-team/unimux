//! The seam between the tool layer (M2) and the automation service (M3: automation.ts AutomationService). The tool layer
//! reads the state, asks for a cell's role and runs operations; M3 implements [`Automation`] over the StateController.

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
pub use tokio_util::sync::CancellationToken;

use crate::catalog::Role;
use crate::tools::BoxFuture;
use crate::zod::{self, Issue};

/// A failed operation, as AutomationService.execute throws it.
#[derive(Debug, Clone, PartialEq)]
pub enum OpError {
    /// An Error with this message.
    Message(String),
    /// The argument schema refused the input (a ZodError).
    Invalid(Vec<Issue>),
    /// The call's signal fired (an AbortError).
    Aborted,
}

impl OpError {
    pub fn message(text: impl Into<String>) -> Self {
        OpError::Message(text.into())
    }
    /// mcpTools.ts describeError.
    pub fn describe(&self) -> String {
        match self {
            OpError::Message(m) => m.clone(),
            OpError::Invalid(issues) => zod::describe(issues),
            OpError::Aborted => crate::tools::ABORTED.to_string(),
        }
    }
}

/// What the tool layer needs from the automation service.
pub trait Automation: Send + Sync + 'static {
    /// The current state (AppState as JSON), read fresh for every use like `service.state.get()`.
    fn state(&self) -> Arc<Value>;
    /// AutomationService.roleOf: the cell's MCP role, None while MCP is disabled for it (see [`role_in_state`]).
    fn role_of(&self, cell: &str) -> Option<Role>;
    /// AutomationService.promptsShown: the task prompts read_inbox has shown the cell's agent in full during this run of
    /// its CLI (the service clears it when the agent starts again).
    fn prompts_shown(&self, cell: &str) -> Arc<Mutex<HashSet<String>>>;
    /// AutomationService.execute(operation, input, actorId, signal): parses the input with
    /// [`crate::schemas::operation`] first, then runs the operation with the actor's permissions. `cancel` is the
    /// signal the 1.1.4 tool passes (wait_for and the legacy names), None where it passes none.
    fn execute(
        &self,
        op: &str,
        args: Value,
        actor: &str,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'static, Result<Value, OpError>>;
}

/// shared/state.ts findCell: the project, tab and cell of a cell ID.
pub fn find_cell<'a>(state: &'a Value, cell: &str) -> Option<(&'a Value, &'a Value, &'a Value)> {
    for project in state.get("projects")?.as_array()? {
        let Some(tabs) = project.get("tabs").and_then(Value::as_array) else { continue };
        for tab in tabs {
            let Some(cells) = tab.get("cells").and_then(Value::as_array) else { continue };
            if let Some(c) = cells.iter().find(|c| crate::js::is_str(c.get("id"), cell)) {
                return Some((project, tab, c));
            }
        }
    }
    None
}

/// shared/state.ts getProfile: the profile of the ID, else the shell profile, else the first.
pub fn profile<'a>(state: &'a Value, id: Option<&Value>) -> Option<&'a Value> {
    let profiles = state.get("profiles")?.as_array()?;
    profiles
        .iter()
        .find(|p| crate::js::strict_eq(p.get("id"), id))
        .or_else(|| profiles.iter().find(|p| crate::js::is_str(p.get("cli"), "shell")))
        .or_else(|| profiles.first())
}

/// AutomationService.roleOf over a state: the cell exists, has a role, is no SSH cell and its profile is not a shell.
pub fn role_in_state(state: &Value, cell: &str) -> Option<Role> {
    let (_, _, c) = find_cell(state, cell)?;
    let role = c.get("role");
    if !crate::js::truthy(role) || crate::js::truthy(c.get("ssh")) {
        return None;
    }
    // No profile at all: `getProfile(...).cli` threw, and roleOf answered undefined.
    let profile = profile(state, c.get("profileId"))?;
    if crate::js::is_str(profile.get("cli"), "shell") {
        return None;
    }
    role.and_then(Value::as_str).and_then(Role::parse)
}
