//! Port of src/main/gitHandler.ts (G2): one Git request end to end: the channel allow-list, validation, the folder
//! resolution (project folder or one of its worktrees) and the call. G2 added the trust channels, G3 the reads and mutations.

use std::sync::Arc;

use serde_json::Value;

use crate::shared::{GitChannel, GitRequest, validate_git_request};
use crate::{Git, GitErrorCode, GitFailure, GitResult};

/// `GONE` of gitHandler.ts.
pub const GONE: &str = "Projekt już nie istnieje.";
/// `INVALID` of gitHandler.ts.
pub const INVALID: &str = crate::shared::INVALID_REQUEST;

/// `GIT_READ_CHANNELS`: open to any sender.
pub const GIT_READ_CHANNELS: [GitChannel; 6] =
    [GitChannel::Status, GitChannel::Log, GitChannel::Show, GitChannel::Diff, GitChannel::Branches, GitChannel::Trust];

/// The channels this build runs (every one since G3).
pub fn implemented(channel: GitChannel) -> bool {
    GitChannel::ALL.contains(&channel)
}

/// `handleGit(git, projectPath, channel, input, windows, extraWorktrees)`: validates, resolves the folder, runs. `scope` (the
/// folder the repository must not reach above) is the project folder, or the chosen worktree.
pub async fn handle_git(
    git: &Arc<Git>,
    project_path: Option<&str>,
    channel: &str,
    input: &Value,
    windows: bool,
    extra_worktrees: &[String],
) -> GitResult<Value> {
    let Some(name) = GitChannel::parse(channel) else { return Err(GitFailure::new(GitErrorCode::Invalid, INVALID)) };
    let Some(project_path) = project_path else { return Err(GitFailure::new(GitErrorCode::Gone, GONE)) };
    let request = validate_git_request(name, input, windows).map_err(|e| GitFailure::new(GitErrorCode::Invalid, e))?;
    let dir = git.resolve_dir(project_path, request.worktree(), extra_worktrees).await?;
    let scope = if request.worktree().is_some() { dir.clone() } else { project_path.to_string() };
    run(git, name, &dir, &request, &scope).await
}

async fn run(git: &Arc<Git>, channel: GitChannel, dir: &str, request: &GitRequest, scope: &str) -> GitResult<Value> {
    fn json<T: serde::Serialize>(value: T) -> GitResult<Value> {
        serde_json::to_value(value).map_err(|e| GitFailure::new(GitErrorCode::Failed, e.to_string()))
    }
    let scope = Some(scope);
    match (channel, request) {
        (GitChannel::Status, GitRequest::Base(_)) => json(git.status(dir, scope).await?),
        (GitChannel::Log, GitRequest::Log(req)) => json(git.log(dir, req).await?),
        (GitChannel::Show, GitRequest::Show(req)) => json(git.show(dir, &req.hash).await?),
        (GitChannel::Diff, GitRequest::Diff(req)) => json(git.diff(dir, req).await?),
        (GitChannel::Branches, GitRequest::Base(_)) => json(git.branches(dir).await?),
        (GitChannel::Fetch, GitRequest::Mutation(req)) => json(git.fetch(dir, &req.request_id, scope).await?),
        (GitChannel::Pull, GitRequest::Mutation(req)) => json(git.pull(dir, &req.request_id, scope).await?),
        (GitChannel::Push, GitRequest::Push(req)) => json(git.push(dir, req, scope).await?),
        (GitChannel::Stage, GitRequest::Paths(req)) => json(git.stage(dir, req, scope).await?),
        (GitChannel::Unstage, GitRequest::Paths(req)) => json(git.unstage(dir, req, scope).await?),
        (GitChannel::Commit, GitRequest::Commit(req)) => json(git.commit(dir, req, scope).await?),
        (GitChannel::Checkout, GitRequest::Checkout(req)) => json(git.checkout(dir, req, scope).await?),
        (GitChannel::Trust, GitRequest::Trust(req)) => json(git.trust_info(dir, scope, req.cached).await?),
        (GitChannel::TrustGrant, GitRequest::Mutation(req)) => json(git.grant_trust(dir, &req.request_id, scope).await?),
        (GitChannel::TrustRevoke, GitRequest::Mutation(req)) => json(git.revoke_trust(dir, &req.request_id, scope).await?),
        // validate_git_request answers the request shape of its channel; anything else is a bug, answered as invalid.
        _ => Err(GitFailure::new(GitErrorCode::Invalid, INVALID)),
    }
}
