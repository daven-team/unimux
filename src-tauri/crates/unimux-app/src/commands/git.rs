//! Commands of the `git` domain: G1-G4: git reads, mutations, worktrees (git:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! G2: the trust channels of src/main/gitIpc.ts (`git:trust`, open to any sender; `git:trustGrant` / `git:trustRevoke`, the
//! router's guard admits the app window only), through the request pipeline of gitHandler.ts (`unimux_git::handler`). The
//! renderer names a project (never a path) and optionally one of its worktrees. One engine serves the domain, with the trust
//! file `<data dir>/git-trust.json` of 1.1.4; G3 / G4 register their channels on the same engine (`engine`).

use std::sync::{Arc, OnceLock};

use serde_json::Value;
use unimux_git::{Git, GitOptions, result_json};
use unimux_ipc::RouterBuilder;
use unimux_state::Platform;

use crate::context::AppContext;

static ENGINE: OnceLock<Arc<Git>> = OnceLock::new();

/// The one Git engine of the app (src/main/index.ts `gitEngine`), created on first use: every caller gets the same instance,
/// so all packages share one trust store (git-trust.json), generation, scan cache and request-id set.
pub fn engine(ctx: &AppContext) -> Arc<Git> {
    ENGINE
        .get_or_init(|| {
            Arc::new(Git::new(GitOptions { trust_file: Some(ctx.data_dir.join("git-trust.json")), ..Default::default() }))
        })
        .clone()
}

/// `state.projects.find((p) => p.id === projectId)?.path` (a project id is a string).
fn project_path(ctx: &AppContext, id: &Value) -> Option<String> {
    let id = id.as_str()?;
    let state = ctx.state.get();
    let project = state.get("projects")?.as_array()?.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id))?;
    project.get("path")?.as_str().map(str::to_string)
}

/// `worktreePaths(projectId)`: the worktrees the project's cells use (they may sit anywhere).
fn worktree_paths(ctx: &AppContext, id: &Value) -> Vec<String> {
    let Some(id) = id.as_str() else { return Vec::new() };
    let state = ctx.state.get();
    let Some(project) = state
        .get("projects")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id)))
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for tab in project.get("tabs").and_then(Value::as_array).into_iter().flatten() {
        for cell in tab.get("cells").and_then(Value::as_array).into_iter().flatten() {
            if let Some(path) = cell.get("worktree").and_then(|w| w.get("path")).and_then(Value::as_str) {
                out.push(path.to_string());
            }
        }
    }
    out
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let git = engine(ctx);
    let windows = ctx.platform == Platform::Win32;
    for channel in ["trust", "trustGrant", "trustRevoke"] {
        let (c, git) = (ctx.clone(), git.clone());
        r.invoke(&format!("git:{channel}"), move |call| {
            let (c, git) = (c.clone(), git.clone());
            async move {
                let path = project_path(&c, call.arg(0));
                let extra = worktree_paths(&c, call.arg(0));
                let result = unimux_git::handler::handle_git(&git, path.as_deref(), channel, call.arg(1), windows, &extra).await;
                Ok(result_json(&result))
            }
        });
    }
}
