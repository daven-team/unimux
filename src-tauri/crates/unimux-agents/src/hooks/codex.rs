//! The Codex notify hook of one Codex process (port of src/shared/codexHooks.ts `codexNotifyArgv` / `codexHookOverrides`,
//! 1.1.4). The URL comes from [`super::HookServer::prepare_codex`]; the launch line (P4) quotes the overrides for its shell.

/// Notification types Codex raises as OSC 9 for our terminal: approvals and questions, never "turn complete" (notify does that).
pub const CODEX_ATTENTION_TYPES: [&str; 3] = ["approval-requested", "plan-mode-prompt", "async-question"];

/// The message `codexNotifyArgv` throws for a URL that is not one of ours.
pub const INVALID_HOOK_URL: &str = "Invalid hook URL.";

/// A run of `min..=max` bytes of a class, then the rest. The class never holds the `/` that follows, so a longer run is no
/// match (the regex cannot backtrack into a shorter one).
fn run(s: &str, min: usize, max: usize, ok: impl Fn(u8) -> bool) -> Option<&str> {
    let n = s.bytes().take_while(|b| ok(*b)).count();
    (min..=max).contains(&n).then(|| &s[n..])
}

/// `/^http:\/\/127\.0\.0\.1:\d{1,5}\/h\/[0-9a-f]{8,64}\/[\w%-]{1,200}\/codex\/[0-9a-f]{8,64}$/` (ASCII classes, `$` only at
/// the very end).
fn is_hook_url(url: &str) -> bool {
    let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    let cell = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'%' || b == b'-';
    (|| {
        let s = url.strip_prefix("http://127.0.0.1:")?;
        let s = run(s, 1, 5, |b| b.is_ascii_digit())?.strip_prefix("/h/")?;
        let s = run(s, 8, 64, hex)?.strip_prefix('/')?;
        let s = run(s, 1, 200, cell)?.strip_prefix("/codex/")?;
        run(s, 8, 64, hex).map(str::is_empty)
    })()
    .unwrap_or(false)
}

/// The `notify` argv: curl posts the JSON payload Codex appends as the final argument (`--data-raw` takes it verbatim).
/// Err([`INVALID_HOOK_URL`]) for anything that is not a hook URL of ours (it could break out of the TOML value).
pub fn codex_notify_argv(url: &str) -> Result<Vec<String>, &'static str> {
    if !is_hook_url(url) {
        return Err(INVALID_HOOK_URL);
    }
    Ok(["curl", "-s", "--noproxy", "*", "-m", "2", url, "--data-raw"].iter().map(|s| s.to_string()).collect())
}

/// The `key=value` overrides (values are TOML) for one Codex process. TOML literal strings (single quotes) only, so no double
/// quote ever reaches a shell (Windows PowerShell 5.1 would strip it from the argument).
pub fn codex_hook_overrides(url: &str) -> Result<Vec<String>, &'static str> {
    let list = |items: &[&str]| format!("[{}]", items.iter().map(|i| format!("'{i}'")).collect::<Vec<_>>().join(","));
    let argv = codex_notify_argv(url)?;
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    Ok(vec![
        format!("notify={}", list(&argv)),
        format!("tui.notifications={}", list(&CODEX_ATTENTION_TYPES)),
        // Codex raises OSC 9 only while its terminal is unfocused by default; the app decides itself whether the user is looking.
        "tui.notification_condition='always'".to_string(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:51234/h/0123456789abcdef0123456789abcdef/cell-1/codex/89abcdef01234567";

    // codex-hooks "Codex launch overrides"
    #[test]
    fn builds_a_curl_notify_argv_whose_last_flag_takes_the_appended_payload() {
        let argv = codex_notify_argv(URL).unwrap();
        assert_eq!(argv[0], "curl");
        assert!(argv.iter().any(|a| a == URL));
        assert_eq!(argv.last().unwrap(), "--data-raw");
        for flag in ["--noproxy", "*", "-m", "2"] {
            assert!(argv.iter().any(|a| a == flag), "{flag}");
        }
    }

    #[test]
    fn uses_toml_literal_strings_only_no_double_quote_reaches_any_shell() {
        let overrides = codex_hook_overrides(URL).unwrap();
        assert_eq!(overrides[0], format!("notify=['curl','-s','--noproxy','*','-m','2','{URL}','--data-raw']"));
        assert_eq!(overrides[1], "tui.notifications=['approval-requested','plan-mode-prompt','async-question']");
        assert_eq!(overrides[2], "tui.notification_condition='always'");
        assert!(overrides.iter().all(|o| !o.contains('"')));
    }

    #[test]
    fn refuses_a_url_that_could_break_out_of_the_toml_value() {
        for bad in [
            "http://127.0.0.1:1/h/abc/x'],evil=['/codex/ab".to_string(),
            "http://evil.example/h/0123456789abcdef/cell/codex/0123456789abcdef".to_string(),
            format!("{URL}'"),
            format!("{URL} --x"),
            format!("{URL}\n"),
            String::new(),
        ] {
            assert_eq!(codex_notify_argv(&bad), Err(INVALID_HOOK_URL), "{bad}");
            assert_eq!(codex_hook_overrides(&bad), Err(INVALID_HOOK_URL), "{bad}");
        }
    }
}
