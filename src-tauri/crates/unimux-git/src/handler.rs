//! Port of src/main/gitHandler.ts (G2): one Git request end to end: the channel allow-list, validation, the folder
//! resolution (project folder or one of its worktrees) and the call. G2 runs the trust channels; G3 adds the reads and
//! mutations to [`run`].

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

/// The channels this build runs (the rest come with G3).
pub fn implemented(channel: GitChannel) -> bool {
    matches!(channel, GitChannel::Trust | GitChannel::TrustGrant | GitChannel::TrustRevoke)
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
    let json = |info| serde_json::to_value(info).map_err(|e| GitFailure::new(GitErrorCode::Failed, e.to_string()));
    match (channel, request) {
        (GitChannel::Trust, GitRequest::Trust(req)) => json(git.trust_info(dir, Some(scope), req.cached).await?),
        (GitChannel::TrustGrant, GitRequest::Mutation(req)) => json(git.grant_trust(dir, &req.request_id, Some(scope)).await?),
        (GitChannel::TrustRevoke, GitRequest::Mutation(req)) => json(git.revoke_trust(dir, &req.request_id, Some(scope)).await?),
        _ => Err(GitFailure::new(GitErrorCode::Failed, format!("git:{} is not available yet in this build", channel.as_str()))),
    }
}
