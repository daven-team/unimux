//! How git gets a GitHub token without it ever being on a command line (port of src/main/github/gitEnv.ts): configuration
//! entries in the environment (GIT_CONFIG_COUNT, git 2.31+), an HTTP header git sends to https://github.com/ only, and the
//! regexes that tell a refused credential from other git errors.
//!
//! The JS regexes have the `i` flag without `u`: only ASCII letters fold, `\w` is `[A-Za-z0-9_]`, `.` stops at the four JS
//! line terminators and `\s` is the JS white space set. The patterns below spell that out (`(?i-u:...)` for the literals);
//! the address check has a negative lookahead, which is written out by hand.

use std::sync::OnceLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;

use crate::js;

pub const GITHUB_ORIGIN: &str = "https://github.com";
/// `http.<url>.extraHeader` applies to that URL prefix only, never to another host.
pub const GITHUB_HEADER_KEY: &str = "http.https://github.com/.extraheader";
/// The user's credential helpers for github.com (an empty value empties the list git collected from its config files).
pub const GITHUB_HELPER_KEY: &str = "credential.https://github.com.helper";

/// `githubGitEnv(token, origin)`: the environment additions (in 1.1.4's order) that make git authenticate to `origin` with
/// `token`; tracing off, redaction on, no prompt, and the user's credential helpers off for that origin in the same run (a
/// refused header must never make git erase a credential it never tried). `origin` other than GitHub is for the tests.
pub fn github_git_env(token: &str, origin: &str) -> Vec<(String, String)> {
    let basic = STANDARD.encode(format!("x-access-token:{token}").as_bytes());
    [
        ("GIT_CONFIG_COUNT", "2".to_string()),
        ("GIT_CONFIG_KEY_0", format!("http.{origin}/.extraheader")),
        ("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {basic}")),
        ("GIT_CONFIG_KEY_1", format!("credential.{origin}.helper")),
        ("GIT_CONFIG_VALUE_1", String::new()),
        ("GIT_TERMINAL_PROMPT", "0".to_string()),
        ("GCM_INTERACTIVE", "never".to_string()),
        ("GIT_TRACE_REDACT", "1".to_string()),
        ("GIT_TRACE", "0".to_string()),
        ("GIT_TRACE_CURL", "0".to_string()),
        ("GIT_TRACE_PACKET", "0".to_string()),
        ("GIT_CURL_VERBOSE", "0".to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

/// `/[\w.-]/` of a JS regex without `u`.
fn word_dot_dash(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'
}

fn starts_with_ci(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len() && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// `GITHUB_ADDRESS`: `/https:\/\/(?:[^/\s@'"]+@)?github\.com(?![\w.-])/i.test(message)`. The user part is a run of characters
/// that cannot contain `@`, so it either ends right before an `@` or does not exist: both alternatives are tried at every
/// position, like the backtracking engine does.
pub fn names_github_address(message: &str) -> bool {
    let host_ok =
        |rest: &str| starts_with_ci(rest, "github.com") && !rest["github.com".len()..].chars().next().is_some_and(word_dot_dash);
    for (i, _) in message.char_indices() {
        let at = &message[i..];
        if !starts_with_ci(at, "https://") {
            continue;
        }
        let after = &at["https://".len()..];
        if host_ok(after) {
            return true;
        }
        let user_len: usize = after
            .chars()
            .take_while(|&c| !(c == '/' || c == '@' || c == '\'' || c == '"' || js::is_space(c)))
            .map(char::len_utf8)
            .sum();
        if user_len > 0 && after[user_len..].starts_with('@') && host_ok(&after[user_len + 1..]) {
            return true;
        }
    }
    false
}

/// `.` of a JS regex: anything but a line terminator.
const DOT: &str = r"[^\n\r\u{2028}\u{2029}]";

fn workflow_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i-u:refusing to allow an? [A-Za-z0-9_ ]*App to create or update workflow|without [`'"]?workflow[`'"]? scope)"#,
        )
        .expect("valid regex")
    })
}

fn auth_refused_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"(?i-u:Authentication failed|Invalid username or (?:password|token)|returned error: 40[13])|(?i-u:Permission to ){DOT}*(?i-u: denied)|(?i-u:could not read (?:Username|Password)|terminal prompts disabled|Repository not found)"
        ))
        .expect("valid regex")
    })
}

fn token_refused_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i-u:Authentication failed|Invalid username or (?:password|token)|could not read (?:Username|Password)|terminal prompts disabled)",
        )
        .expect("valid regex")
    })
}

/// `workflowScopeRefused`: GitHub refused a push that adds or changes .github/workflows files (the token has no "workflow"
/// permission).
pub fn workflow_scope_refused(message: &str) -> bool {
    workflow_regex().is_match(message)
}

/// `githubAuthRefused`: GitHub refused the credentials of a network operation (so the user's own credential manager may get a
/// try without ours). Only git's messages about an https://github.com address count; a push refused for a workflow file too.
pub fn github_auth_refused(message: &str) -> bool {
    names_github_address(message) && (workflow_scope_refused(message) || auth_refused_regex().is_match(message))
}

/// `githubTokenRefused`: GitHub answered 401, i.e. it no longer accepts the token at all (rather than refusing it this one
/// repository).
pub fn github_token_refused(message: &str) -> bool {
    names_github_address(message) && token_refused_regex().is_match(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "gho_16C7e42F292c6912E7710c838347Ae178B4a";

    fn env_map(env: &[(String, String)]) -> std::collections::HashMap<&str, &str> {
        env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
    }

    /// test/github-publish.test.ts "is one header for https://github.com/ in GIT_CONFIG_*, never an argument, ...".
    #[test]
    fn token_in_one_header() {
        let env = github_git_env(TOKEN, GITHUB_ORIGIN);
        let m = env_map(&env);
        assert_eq!(m["GIT_CONFIG_COUNT"], "2");
        assert_eq!(m["GIT_CONFIG_KEY_0"], GITHUB_HEADER_KEY);
        assert_eq!(m["GIT_CONFIG_KEY_1"], GITHUB_HELPER_KEY);
        assert_eq!(m["GIT_CONFIG_VALUE_1"], "");
        let value = m["GIT_CONFIG_VALUE_0"].strip_prefix("AUTHORIZATION: basic ").unwrap();
        assert_eq!(STANDARD.decode(value).unwrap(), format!("x-access-token:{TOKEN}").as_bytes());
        assert_eq!(m["GIT_TERMINAL_PROMPT"], "0");
        assert_eq!(m["GIT_TRACE_CURL"], "0");
        assert_eq!(m["GIT_TRACE_REDACT"], "1");
        assert_eq!(m["GCM_INTERACTIVE"], "never");
        let others: Vec<&str> = env.iter().filter(|(k, _)| k != "GIT_CONFIG_VALUE_0").map(|(_, v)| v.as_str()).collect();
        let others = others.join("\n");
        assert!(!others.contains(TOKEN));
        assert!(!others.contains(value));
        // 1.1.4's key order (Object.entries of the literal).
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            [
                "GIT_CONFIG_COUNT",
                "GIT_CONFIG_KEY_0",
                "GIT_CONFIG_VALUE_0",
                "GIT_CONFIG_KEY_1",
                "GIT_CONFIG_VALUE_1",
                "GIT_TERMINAL_PROMPT",
                "GCM_INTERACTIVE",
                "GIT_TRACE_REDACT",
                "GIT_TRACE",
                "GIT_TRACE_CURL",
                "GIT_TRACE_PACKET",
                "GIT_CURL_VERBOSE"
            ]
        );
        let local = env_map(&github_git_env(TOKEN, "http://127.0.0.1:5000")).get("GIT_CONFIG_KEY_0").map(|s| s.to_string());
        assert_eq!(local.as_deref(), Some("http.http://127.0.0.1:5000/.extraheader"));
    }

    /// "recognizes GitHub refusing the credentials (and only for github.com)".
    #[test]
    fn auth_refused() {
        assert!(github_auth_refused(
            "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b.git/'"
        ));
        assert!(github_auth_refused(
            "remote: Permission to a/b.git denied to c.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403"
        ));
        assert!(github_auth_refused("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found"));
        assert!(!github_auth_refused("fatal: Authentication failed for 'https://gitlab.com/a/b.git/'"));
        assert!(!github_auth_refused(
            "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com"
        ));
        assert!(!github_auth_refused(" ! [rejected]        main -> main (fetch first)"));
        assert!(github_auth_refused("fatal: could not read Username for 'https://github.com': terminal prompts disabled"));
        assert!(!github_auth_refused(
            "fatal: could not read Username for 'https://github.com.evil.io': terminal prompts disabled"
        ));
        assert!(!github_auth_refused("fatal: Authentication failed for 'https://github.company.io/a/b.git/'"));
        let workflow = "To https://github.com/a/b.git\n ! [remote rejected] main -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\nerror: failed to push some refs to 'https://github.com/a/b.git'";
        assert!(github_auth_refused(workflow));
        assert!(workflow_scope_refused(workflow));
        assert!(!workflow_scope_refused("remote: Permission denied"));
        assert!(workflow_scope_refused("refusing to allow a GitHub App to create or update workflow"));
    }

    /// "tells a dead token (401) from one refused for a single repository".
    #[test]
    fn token_refused() {
        assert!(github_token_refused("fatal: could not read Username for 'https://github.com': terminal prompts disabled"));
        assert!(github_token_refused(
            "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b.git/'"
        ));
        assert!(!github_token_refused(
            "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found"
        ));
        assert!(!github_token_refused(
            "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403"
        ));
        assert!(!github_token_refused("fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled"));
    }

    /// The JS semantics the patterns spell out.
    #[test]
    fn js_regex_semantics() {
        // A user part before the host, any case, and the lookahead after it.
        assert!(names_github_address("fetch HTTPS://x-access-token@GitHub.COM/a"));
        assert!(names_github_address("'https://github.com'"));
        assert!(names_github_address("https://github.com"));
        assert!(!names_github_address("https://github.com_x"));
        assert!(!names_github_address("https://github.com-x"));
        assert!(!names_github_address("https://u ser@github.com/a"));
        assert!(!names_github_address("https://a/b@github.com/a"));
        assert!(names_github_address("https://github.com:443/a"));
        assert!(names_github_address("https://github.com@github.com/a"));
        assert!(names_github_address("https://évil@github.com/"));
        // JS `.` stops at line terminators; `i` without `u` folds ASCII only (U+017F long s and U+212A Kelvin do not fold).
        assert!(!github_auth_refused("Permission to a\ndenied https://github.com/a"));
        assert!(!github_auth_refused("Permission to a\u{2028}denied https://github.com/a"));
        assert!(github_auth_refused("PERMISSION TO a DENIED https://github.com/a"));
        assert!(!github_token_refused("Invalid u\u{17f}ername or token for https://github.com/a"));
        assert!(github_token_refused("invalid USERNAME or TOKEN for https://github.com/a"));
        assert!(!workflow_scope_refused("without workflow \u{17f}cope"));
    }
}
