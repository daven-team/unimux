//! Commands of the `git` domain: G1-G4: git reads, mutations, worktrees (git:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! G2: the trust channels of src/main/gitIpc.ts (`git:trust`, open to any sender; `git:trustGrant` / `git:trustRevoke`, the
//! router's guard admits the app window only), through the request pipeline of gitHandler.ts (`unimux_git::handler`). The
//! renderer names a project (never a path) and optionally one of its worktrees. One engine serves the domain, with the trust
//! file `<data dir>/git-trust.json` of 1.1.4; G3 / G4 register their channels on the same engine (`engine`).
//!
//! G3: `git:probe` and the reads (`git:status`, `log`, `show`, `diff`, `branches`, open to any sender) and mutations (`fetch`,
//! `pull`, `push`, `stage`, `unstage`, `commit`, `checkout`, app window only through the router's guard) of gitIpc.ts. fetch,
//! pull and push carry the GitHub sign-in of `commands::github` ([`AppRemoteAuth`]).
//!
//! G4 ([`register_worktrees`]): `git:worktrees` and `git:isRepo` (open), `git:createWorktree` / `git:inspectWorktree` /
//! `git:removeWorktree` (the cells' worktrees; the renderer names the project folder, as in 1.1.4), `git:init`, `git:clone`
//! (with the GitHub sign-in of A6 for github.com addresses) and `git:installGit` (winget / xcode-select / the download
//! page). Everything but the two open channels is admitted for the app windows only by the router's guard.
//! [`create_worktree`] and [`remove_worktree`] are the automation's (M3) entry points.

use std::sync::{Arc, OnceLock};

use serde_json::{Value, json};
use unimux_accounts::github::git_env::{github_auth_refused, github_token_refused};
use unimux_git::handler::GONE;
use unimux_git::setup::{ALREADY_REPO, DOWNLOAD_OPENED, GIT_DOWNLOAD, InstallPlan, install_plan, run_plain};
use unimux_git::shared::{GitCloneRequest, validate_clone_request};
use unimux_git::{
    Git, GitErrorCode, GitFailure, GitOptions, GitProbe, GitResult, RemoteAuth, Worktree, WorktreeInspection,
    WorktreeRemoveResult, result_json,
};
use unimux_ipc::RouterBuilder;
use unimux_state::Platform;

use crate::context::AppContext;

static ENGINE: OnceLock<Arc<Git>> = OnceLock::new();

/// The GitHub sign-in of the app as git's network runs see it (index.ts passes `github.remoteAuth` / `remoteAuthRefused` to
/// the engine). The GitHub service is looked up at each run (it is created when the `github` domain registers), so the engine
/// does not depend on the order the domains register in.
#[derive(Debug)]
struct AppRemoteAuth;

impl RemoteAuth for AppRemoteAuth {
    fn env(&self) -> Option<Vec<(String, String)>> {
        crate::commands::github::service_if_started()?.remote_auth()
    }
    fn auth_refused(&self, message: &str) -> bool {
        github_auth_refused(message)
    }
    fn token_refused(&self, message: &str) -> bool {
        github_token_refused(message)
    }
    fn refused(&self) {
        if let Some(service) = crate::commands::github::service_if_started() {
            service.remote_auth_refused();
        }
    }
}

/// The one Git engine of the app (src/main/index.ts `gitEngine`), created on first use: every caller gets the same instance,
/// so all packages share one trust store (git-trust.json), generation, scan cache and request-id set.
pub fn engine(ctx: &AppContext) -> Arc<Git> {
    ENGINE
        .get_or_init(|| {
            Arc::new(Git::new(GitOptions {
                trust_file: Some(ctx.data_dir.join("git-trust.json")),
                remote_auth: Some(Arc::new(AppRemoteAuth)),
                ..Default::default()
            }))
        })
        .clone()
}

/// `state.projects.find((p) => p.id === projectId)?.path` (a project id is a string).
pub(crate) fn project_path(ctx: &AppContext, id: &Value) -> Option<String> {
    let id = id.as_str()?;
    let state = ctx.state.get();
    let project = state.get("projects")?.as_array()?.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id))?;
    project.get("path")?.as_str().map(str::to_string)
}

/// `worktreePaths(projectId)`: the worktrees the project's cells use (they may sit anywhere).
pub(crate) fn worktree_paths(ctx: &AppContext, id: &Value) -> Vec<String> {
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

/// JS truthiness of an IPC argument.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `createWorktree(projectPath, name)` for the automation (M3): the error is the text the renderer would show.
pub async fn create_worktree(ctx: &AppContext, project_path: &str, name: &str) -> Result<Worktree, String> {
    engine(ctx).create_worktree(project_path, name).await
}

/// The automation's rollback (`removeWorktree(path, wt, true)` of index.ts): unforced, the branch goes when unimux made it.
pub async fn remove_worktree(ctx: &AppContext, project_path: &str, wt: &Worktree) -> Result<(), String> {
    match engine(ctx).remove_worktree(project_path, wt, true, None).await {
        WorktreeRemoveResult::Ok => Ok(()),
        WorktreeRemoveResult::Unsafe(_) => Err("unsafe".into()),
        WorktreeRemoveResult::Failed(e) | WorktreeRemoveResult::Branch(e) => Err(e),
    }
}

/// `git:installGit`: winget on Windows, the Xcode tools on macOS, the download page elsewhere (and when winget fails).
async fn install_git(ctx: &Arc<AppContext>) -> Value {
    let open_download = || {
        if let Some(os) = ctx.os.get() {
            os.desktop.open_external(GIT_DOWNLOAD);
        }
    };
    match install_plan(std::env::consts::OS) {
        // A test run (MC_OFFSCREEN) never starts a real installer.
        InstallPlan::Run { .. } if ctx.overrides.offscreen => {
            json!({ "ok": false, "code": "failed", "error": "Installing Git is off in offscreen test runs." })
        }
        InstallPlan::Run { program, args, timeout, message, open_on_failure } => {
            let args = args.into_iter().map(Into::into).collect();
            match run_plain(program.into(), args, None, timeout, None).await {
                Ok(_) => json!({ "ok": true, "data": { "message": message, "restart": true } }),
                Err(error) => {
                    if open_on_failure {
                        open_download();
                    }
                    json!({ "ok": false, "code": "failed", "error": error })
                }
            }
        }
        InstallPlan::OpenDownload => {
            open_download();
            json!({ "ok": true, "data": { "message": DOWNLOAD_OPENED, "restart": false } })
        }
    }
}

/// `git:clone(request)`: into the folder of a project that is no repository yet (it must be empty), or into a new folder
/// `name` of a folder the user picked (it must not exist yet or be empty).
async fn clone_into(ctx: &Arc<AppContext>, git: &Git, request: &Value) -> GitResult<Value> {
    let req = validate_clone_request(request).map_err(|e| GitFailure::new(GitErrorCode::Invalid, e))?;
    let (url, target) = match req {
        GitCloneRequest::Project { url, project_id } => {
            let Some(path) = project_path(ctx, &Value::String(project_id)) else {
                return Err(GitFailure::new(GitErrorCode::Gone, GONE));
            };
            if git.probe(&path).await != GitProbe::NoRepo {
                return Err(GitFailure::new(GitErrorCode::Failed, ALREADY_REPO));
            }
            (url, path)
        }
        GitCloneRequest::Folder { url, parent, name } => {
            let p = parent.clone();
            let is_dir = tokio::task::spawn_blocking(move || std::fs::metadata(&p).is_ok_and(|m| m.is_dir())).await;
            if !matches!(is_dir, Ok(true)) {
                return Err(GitFailure::new(GitErrorCode::Gone, unimux_git::runner::GONE));
            }
            (url, unimux_git::paths::resolve(&parent, &name))
        }
    };
    // The GitHub service starts here when it has not yet (AppRemoteAuth looks it up at each run).
    let _ = crate::commands::github::github_service(ctx);
    let done = git.clone_repo(&target, &url, Some(&AppRemoteAuth)).await?;
    Ok(json!({ "message": done.message, "path": target }))
}

/// `git:worktrees(projectId, {prefer})`: a preferred folder longer than 1000 UTF-16 units or with NUL is ignored.
fn prefer_of(request: &Value) -> Option<String> {
    request
        .get("prefer")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty() && p.encode_utf16().count() <= 1000 && !p.contains('\0'))
        .map(str::to_string)
}

fn gone() -> Value {
    result_json::<()>(&Err(GitFailure::new(GitErrorCode::Gone, GONE)))
}

/// The G4 channels (see the module documentation).
pub fn register_worktrees(r: &mut RouterBuilder, ctx: &Arc<AppContext>, git: &Arc<Git>) {
    let g = git.clone();
    r.invoke("git:isRepo", move |call| {
        let g = g.clone();
        async move {
            Ok(Value::Bool(match call.arg(0).as_str() {
                Some(p) => g.is_git_repo(p).await,
                None => false,
            }))
        }
    });

    let (c, g) = (ctx.clone(), git.clone());
    r.invoke("git:worktrees", move |call| {
        let (c, g) = (c.clone(), g.clone());
        async move {
            let Some(path) = project_path(&c, call.arg(0)) else { return Ok(gone()) };
            let prefer = prefer_of(call.arg(1));
            let extra = worktree_paths(&c, call.arg(0));
            Ok(result_json(&g.worktrees(&path, Some(&path), &extra, prefer.as_deref()).await))
        }
    });

    let g = git.clone();
    r.invoke("git:createWorktree", move |call| {
        let g = g.clone();
        async move {
            let (Some(path), Some(name)) = (call.arg(0).as_str(), call.arg(1).as_str()) else {
                return Err(call.fail("The project path and the worktree name must be strings."));
            };
            let wt = g.create_worktree(path, name).await.map_err(|e| call.fail(e))?;
            serde_json::to_value(wt).map_err(|e| call.fail(e.to_string()))
        }
    });

    let g = git.clone();
    r.invoke("git:inspectWorktree", move |call| {
        let g = g.clone();
        async move {
            let wt = serde_json::from_value::<Worktree>(call.arg(1).clone()).ok();
            let (Some(path), Some(wt)) = (call.arg(0).as_str(), wt) else {
                return Ok(json!({ "ok": false, "error": "Invalid worktree." }));
            };
            Ok(match g.inspect_worktree(path, &wt).await {
                Ok(inspection) => json!({ "ok": true, "inspection": inspection }),
                Err(error) => json!({ "ok": false, "error": error }),
            })
        }
    });

    let g = git.clone();
    r.invoke("git:removeWorktree", move |call| {
        let g = g.clone();
        async move {
            let Some(path) = call.arg(0).as_str() else { return Err(call.fail("The project path must be a string.")) };
            let wt: Worktree = call.arg_as(1)?;
            let delete_branch = truthy(call.arg(2));
            // A confirmation of another shape counts as none: the removal then refuses whenever work would be lost.
            let confirmed = serde_json::from_value::<Option<WorktreeInspection>>(call.arg(3).clone()).ok().flatten();
            Ok(g.remove_worktree(path, &wt, delete_branch, confirmed.as_ref()).await.to_json())
        }
    });

    let (c, g) = (ctx.clone(), git.clone());
    r.invoke("git:init", move |call| {
        let (c, g) = (c.clone(), g.clone());
        async move {
            let Some(path) = project_path(&c, call.arg(0)) else { return Ok(gone()) };
            if g.probe(&path).await != GitProbe::NoRepo {
                return Ok(result_json::<()>(&Err(GitFailure::new(GitErrorCode::Failed, ALREADY_REPO))));
            }
            Ok(match g.init_repo(&path).await {
                Ok(message) => json!({ "ok": true, "data": { "message": message } }),
                Err(error) => json!({ "ok": false, "code": "failed", "error": error }),
            })
        }
    });

    let (c, g) = (ctx.clone(), git.clone());
    r.invoke("git:clone", move |call| {
        let (c, g) = (c.clone(), g.clone());
        async move { Ok(result_json(&clone_into(&c, &g, call.arg(0)).await)) }
    });

    let c = ctx.clone();
    r.invoke("git:installGit", move |_| {
        let c = c.clone();
        async move { Ok(install_git(&c).await) }
    });
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let git = engine(ctx);
    let windows = ctx.platform == Platform::Win32;
    register_worktrees(r, ctx, &git);
    let g = git.clone();
    let c = ctx.clone();
    r.invoke("git:probe", move |call| {
        let (c, git) = (c.clone(), g.clone());
        async move {
            let probe = match project_path(&c, call.arg(0)) {
                Some(path) => git.probe(&path).await,
                None => unimux_git::GitProbe::NoRepo,
            };
            Ok(serde_json::to_value(probe).unwrap_or(Value::Null))
        }
    });
    for channel in unimux_git::shared::GitChannel::ALL.map(|c| c.as_str()) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_read_like_1_1_4() {
        assert!(truthy(&json!(true)) && truthy(&json!(1)) && truthy(&json!("x")) && truthy(&json!({})));
        assert!(!truthy(&json!(false)) && !truthy(&json!(0)) && !truthy(&json!("")) && !truthy(&Value::Null));
        assert_eq!(prefer_of(&json!({ "prefer": "D:/p-wt-x" })).as_deref(), Some("D:/p-wt-x"));
        assert_eq!(prefer_of(&json!({ "prefer": "" })), None);
        assert_eq!(prefer_of(&json!({ "prefer": "a\u{0}b" })), None);
        assert_eq!(prefer_of(&json!({ "prefer": "x".repeat(1001) })), None);
        assert_eq!(prefer_of(&Value::Null), None);
        assert_eq!(gone(), json!({ "ok": false, "code": "gone", "error": GONE }));
    }
}
