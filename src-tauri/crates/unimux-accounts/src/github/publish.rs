//! "Publish to GitHub", end to end (G3: port of src/main/github/publish.ts and the `publish` handler of ipc.ts): the repository
//! is checked first (a branch with commits, no remote, trusted, not above the project), then created on GitHub
//! (POST /user/repos), added as "origin" (its https address) and the branch pushed with upstream. The token reaches git in
//! the environment only ([`super::git_env::github_git_env`]), never on a command line.

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value};
use unimux_git::{Git, GitFailure, paths};

use super::GhFail;
use super::api::create_repo;
use super::auth::GithubAuth;
use super::git_env::{GITHUB_ORIGIN, github_git_env, workflow_scope_refused};
use crate::js;

/// `PUBLISH_ERR` of publish.ts (Polish source texts; the renderer translates them).
pub mod publish_err {
    pub const SIGN_IN: &str = "Zaloguj się do GitHuba, aby opublikować repozytorium.";
    pub const REMOTE_EXISTS: &str = "To repozytorium ma już zdalne repozytorium.";
    pub const NO_COMMITS: &str = "Najpierw zatwierdź pierwszy commit, potem opublikuj repozytorium.";
    pub const DETACHED: &str = "Publikowanie wymaga gałęzi (HEAD jest odłączony).";
    pub const BUSY: &str = "Publikowanie już trwa.";
    pub const REMOTE_FAILED: &str = "Repozytorium zostało utworzone na GitHubie, ale nie udało się dodać go jako origin.";
    pub const PUSH_FAILED: &str = "Repozytorium zostało utworzone na GitHubie, ale wysłanie gałęzi nie powiodło się. Użyj Push w panelu Git, aby spróbować ponownie.";
    pub const WORKFLOW_SCOPE: &str = "Repozytorium zostało utworzone na GitHubie, ale GitHub nie przyjął gałęzi: zawiera pliki .github/workflows, a to logowanie nie ma uprawnienia „workflow”. Użyj Push w panelu Git (z Twoimi poświadczeniami git) albo git push w terminalu.";

    pub const ALL: [&str; 8] = [SIGN_IN, REMOTE_EXISTS, NO_COMMITS, DETACHED, BUSY, REMOTE_FAILED, PUSH_FAILED, WORKFLOW_SCOPE];
}

/// `GITHUB_REPO_NAME_MAX`.
pub const GITHUB_REPO_NAME_MAX: usize = 100;
/// `INVALID_NAME` of src/shared/github.ts.
pub const INVALID_NAME: &str = "Nazwa repozytorium może mieć do 100 znaków: litery, cyfry, kropki, myślniki i podkreślenia.";
/// `GONE` of gitHandler.ts.
pub const GONE: &str = unimux_git::handler::GONE;
/// `INVALID` of gitHandler.ts.
pub const INVALID: &str = unimux_git::handler::INVALID;

/// `isValidRepoName`: GitHub's rules (letters, digits, `.`, `-`, `_`; not `.` / `..`; no `.git` suffix; at most 100).
pub fn is_valid_repo_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= GITHUB_REPO_NAME_MAX
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && value != "."
        && value != ".."
        && !(value.len() >= 4 && value[value.len() - 4..].eq_ignore_ascii_case(".git"))
}

/// `GithubPublishRequest`, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishRequest {
    pub request_id: String,
    pub name: String,
    pub private: bool,
    pub worktree: Option<String>,
}

/// `validatePublishRequest(input)`: unknown fields are dropped, the name follows GitHub's rules, visibility is a boolean.
pub fn validate_publish_request(input: &Value) -> Result<PublishRequest, String> {
    let invalid = || Err(INVALID.to_string());
    let Value::Object(req) = input else { return invalid() };
    let request_id = req.get("requestId").filter(|v| unimux_git::shared::is_request_id(v)).and_then(Value::as_str);
    let private = req.get("private").and_then(Value::as_bool);
    let (Some(request_id), Some(private)) = (request_id, private) else { return invalid() };
    let Some(name) = req.get("name").and_then(Value::as_str).filter(|n| is_valid_repo_name(n)) else {
        return Err(INVALID_NAME.to_string());
    };
    let worktree = match req.get("worktree") {
        None => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) if js::len16(s) <= 1000 && !s.contains('\0') => Some(s.clone()),
        Some(_) => return invalid(),
    };
    Ok(PublishRequest { request_id: request_id.to_string(), name: name.to_string(), private, worktree })
}

fn git_fail_json(failure: &GitFailure) -> Value {
    unimux_git::result_json::<()>(&Err(failure.clone()))
}

fn fail_with(code: &'static str, error: &str, detail: String, url: String) -> Value {
    GhFail { code, error: error.to_string(), detail: Some(detail), url: Some(url) }.to_json()
}

/// Removes the repository from the running set however the publish ends.
struct Running<'a> {
    set: &'a Mutex<HashSet<String>>,
    key: String,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.set.lock().remove(&self.key);
    }
}

/// `createPublisher(deps)`: one publish per repository at a time.
pub struct Publisher {
    git: Arc<Git>,
    auth: Arc<GithubAuth>,
    running: Mutex<HashSet<String>>,
    /// The origin the token header is for (GitHub; a local server in the tests).
    origin: String,
}

impl Publisher {
    pub fn new(git: Arc<Git>, auth: Arc<GithubAuth>) -> Self {
        Self::with_origin(git, auth, GITHUB_ORIGIN)
    }

    pub fn with_origin(git: Arc<Git>, auth: Arc<GithubAuth>, origin: &str) -> Self {
        Self { git, auth, running: Mutex::new(HashSet::new()), origin: origin.to_string() }
    }

    /// `github:publish(projectId, request)` once main resolved the project: validates the request, resolves the folder like
    /// every Git panel request (the project folder, or one of its worktrees git itself lists) and publishes.
    pub async fn handle(&self, project_path: Option<&str>, request: &Value, extra_worktrees: &[String]) -> Value {
        let Some(path) = project_path else { return GhFail::new("gone", GONE).to_json() };
        let req = match validate_publish_request(request) {
            Ok(req) => req,
            Err(error) => return GhFail::new("invalid", &error).to_json(),
        };
        let dir = match self.git.resolve_dir(path, req.worktree.as_deref(), extra_worktrees).await {
            Ok(dir) => dir,
            Err(failure) => return git_fail_json(&failure),
        };
        let scope = if req.worktree.is_some() { dir.clone() } else { path.to_string() };
        self.publish(&dir, &scope, &req).await
    }

    /// The publish itself (`Publish(dir, scope, req)`): the JSON the renderer gets.
    pub async fn publish(&self, dir: &str, scope: &str, req: &PublishRequest) -> Value {
        let key = paths::canonical_path(dir);
        if !self.running.lock().insert(key.clone()) {
            return GhFail::new("busy", publish_err::BUSY).to_json();
        }
        let _running = Running { set: &self.running, key };

        let info = match self.git.publish_info(dir, Some(scope)).await {
            Ok(info) => info,
            Err(failure) => return git_fail_json(&failure),
        };
        if !info.remotes.is_empty() {
            return GhFail::new("remote-exists", publish_err::REMOTE_EXISTS).to_json();
        }
        let Some(branch) = info.branch.filter(|b| !b.is_empty()) else {
            return GhFail::new("detached", publish_err::DETACHED).to_json();
        };
        if info.initial {
            return GhFail::new("no-commits", publish_err::NO_COMMITS).to_json();
        }

        let Some((token, source)) = self.auth.token().await else {
            return GhFail::new("auth", publish_err::SIGN_IN).to_json();
        };
        let created = match create_repo(self.auth.fetcher().as_ref(), self.auth.endpoints(), &token, &req.name, req.private).await
        {
            Ok(created) => created,
            Err(fail) => {
                if fail.code == "auth" {
                    self.auth.rejected(source);
                }
                return fail.to_json();
            }
        };
        let env = github_git_env(&token, &self.origin);
        let pushed = match self.git.publish_push(dir, &req.request_id, &created.clone_url, &branch, env, Some(scope)).await {
            Ok(pushed) => pushed,
            Err(failure) => {
                return fail_with("remote-failed", publish_err::REMOTE_FAILED, failure.message, created.html_url);
            }
        };
        if !pushed.pushed {
            // The device-flow sign-in asks for "repo" only: GitHub refuses it a push that brings workflow files.
            let error =
                if workflow_scope_refused(&pushed.message) { publish_err::WORKFLOW_SCOPE } else { publish_err::PUSH_FAILED };
            return fail_with("push-failed", error, pushed.message, created.html_url);
        }
        let mut data = Map::new();
        data.insert("fullName".into(), Value::String(created.full_name));
        data.insert("htmlUrl".into(), Value::String(created.html_url));
        data.insert("branch".into(), Value::String(branch));
        let mut out = Map::new();
        out.insert("ok".into(), Value::Bool(true));
        out.insert("data".into(), Value::Object(data));
        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// test/github-publish.test.ts "follows GitHub's rules" (the validator half).
    #[test]
    fn repository_names_follow_githubs_rules() {
        for good in ["unimux", "my-repo_1.0", "A", &"a".repeat(100), ".github", "x.gitx"] {
            assert!(is_valid_repo_name(good), "{good}");
        }
        for bad in ["", ".", "..", "a b", "zażółć", "repo.git", "repo.GIT", &"a".repeat(101), "a/b", "a\0"] {
            assert!(!is_valid_repo_name(bad), "{bad:?}");
        }
    }

    /// test/github-publish.test.ts "keeps the known fields and refuses anything odd".
    #[test]
    fn publish_requests_keep_the_known_fields_and_refuse_anything_odd() {
        let ok = validate_publish_request(&json!({"requestId": "req-000001-abcd", "name": "demo", "private": true, "extra": 1}));
        assert_eq!(
            ok,
            Ok(PublishRequest { request_id: "req-000001-abcd".into(), name: "demo".into(), private: true, worktree: None })
        );
        let wt = validate_publish_request(
            &json!({"requestId": "req-000001-abcd", "name": "demo", "private": false, "worktree": "C:/p-wt-x"}),
        )
        .unwrap();
        assert_eq!(wt.worktree.as_deref(), Some("C:/p-wt-x"));
        let empty_wt =
            validate_publish_request(&json!({"requestId": "req-000001-abcd", "name": "demo", "private": false, "worktree": ""}))
                .unwrap();
        assert_eq!(empty_wt.worktree, None);
        assert_eq!(
            validate_publish_request(&json!({"requestId": "req-000001-abcd", "name": "bad name", "private": false})),
            Err(INVALID_NAME.to_string())
        );
        for bad in [
            json!(null),
            json!([]),
            json!("x"),
            json!({"requestId": "short", "name": "demo", "private": false}),
            json!({"requestId": "req-000001-abcd", "name": "demo", "private": "yes"}),
            json!({"requestId": "req-000001-abcd", "name": "demo"}),
            json!({"requestId": "req-000001-abcd", "name": "demo", "private": true, "worktree": 5}),
            json!({"requestId": "req-000001-abcd", "name": "demo", "private": true, "worktree": "a\u{0}b"}),
            json!({"requestId": "req-000001-abcd", "name": "demo", "private": true, "worktree": "a".repeat(1001)}),
        ] {
            assert_eq!(validate_publish_request(&bad), Err(INVALID.to_string()), "{bad}");
        }
    }

    #[test]
    fn publish_messages_have_no_em_dash() {
        for m in publish_err::ALL {
            assert!(!m.contains('\u{2014}'), "{m}");
        }
    }
}
