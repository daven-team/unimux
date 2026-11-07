//! Who is signed in to Claude Code, for the account roles (ports of `readSignedInClaudeIdentity`, `claudeLoginPresence` and
//! the expiry part of `readClaudeCredentials` of src/main/usage/credentials.ts, as A3's reconcile and migration use them).

use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;
use unimux_core::js_json;

use crate::identity::{AccountIdentity, LiveIdentityUnknown, read_live_claude_identity_with};
use crate::js;

/// `ClaudeLoginPresence`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginPresence {
    Present,
    Absent,
    Unknown,
}

/// `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json`.
fn credentials_path(config_dir: Option<&str>, home: &Path) -> PathBuf {
    match config_dir.map(js::trim).filter(|d| !d.is_empty()) {
        Some(d) => Path::new(d).join(".credentials.json"),
        None => home.join(".claude").join(".credentials.json"),
    }
}

/// `claudeLoginPresence`: whether a Claude login is stored next to the config (the environment token counts as one). A file
/// that cannot be read right now or does not parse is `Unknown`.
pub fn claude_login_presence(
    env_token: Option<&str>,
    config_dir: Option<&str>,
    home: &Path,
    read: &mut dyn FnMut(&Path) -> io::Result<String>,
) -> LoginPresence {
    if env_token.map(js::trim).is_some_and(|t| !t.is_empty()) {
        return LoginPresence::Present;
    }
    let raw = match read(&credentials_path(config_dir, home)) {
        Ok(raw) => raw,
        Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) => return LoginPresence::Absent,
        Err(_) => return LoginPresence::Unknown,
    };
    match js_json::parse(&raw) {
        Ok(Value::Object(m)) => {
            if js::record(m.get("claudeAiOauth")).is_some() {
                LoginPresence::Present
            } else {
                LoginPresence::Absent
            }
        }
        _ => LoginPresence::Unknown,
    }
}

/// `readSignedInClaudeIdentity`: `~/.claude.json` alone does not make a login (Claude Desktop and an earlier sign-in leave an
/// `oauthAccount` there while `~/.claude/.credentials.json` holds no Claude login): such an identity is nobody signed in.
/// `Err` when either file cannot be read right now. On macOS the login is in the Keychain, so the config file decides there.
pub fn read_signed_in_claude_identity(
    env_token: Option<&str>,
    config_dir: Option<&str>,
    home: &Path,
    darwin: bool,
    read: &mut dyn FnMut(&Path) -> io::Result<String>,
) -> Result<Option<AccountIdentity>, LiveIdentityUnknown> {
    let identity = read_live_claude_identity_with(config_dir, home, read)?;
    if identity.is_none() || darwin {
        return Ok(identity);
    }
    match claude_login_presence(env_token, config_dir, home, read) {
        LoginPresence::Unknown => Err(LiveIdentityUnknown),
        LoginPresence::Present => Ok(identity),
        LoginPresence::Absent => Ok(None),
    }
}

/// `readClaudeCredentials(profileSource(..., dir))?.expiresAt`: the access token expiry of a saved profile (no file, no
/// usable login or no number: `None`).
pub fn profile_expiry(dir: &Path) -> Option<f64> {
    let raw = js::read_text(&dir.join(".credentials.json")).ok()?;
    let parsed = js_json::parse(&raw).ok()?;
    let oauth = js::record(js::record(Some(&parsed))?.get("claudeAiOauth"))?;
    if !matches!(oauth.get("accessToken"), Some(Value::String(t)) if !t.is_empty()) {
        return None;
    }
    oauth.get("expiresAt").and_then(Value::as_f64)
}

/// The profile of a saved account holds no Claude login (`claudeLoginPresence(profileSource(dir)) === 'absent'`).
pub fn profile_login_absent(dir: &Path) -> bool {
    let dir = dir.to_string_lossy();
    claude_login_presence(None, Some(&dir), Path::new(""), &mut |p| js::read_text(p)) == LoginPresence::Absent
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs_read(files: Vec<(&'static str, io::Result<String>)>) -> impl FnMut(&Path) -> io::Result<String> {
        move |p: &Path| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            match files.iter().find(|(n, _)| *n == name) {
                Some((_, Ok(s))) => Ok(s.clone()),
                Some((_, Err(e))) => Err(io::Error::new(e.kind(), "x")),
                None => Err(io::ErrorKind::NotFound.into()),
            }
        }
    }

    #[test]
    fn an_identity_without_a_login_next_to_it_is_nobody_signed_in() {
        let home = Path::new("/h");
        let config = r#"{"oauthAccount":{"emailAddress":"a@x.com","accountUuid":"u"}}"#;
        let mut only_config = fs_read(vec![(".claude.json", Ok(config.into()))]);
        assert_eq!(read_signed_in_claude_identity(None, None, home, false, &mut only_config), Ok(None));
        // macOS: the config decides.
        assert!(read_signed_in_claude_identity(None, None, home, true, &mut only_config).unwrap().is_some());
        // The environment token is a login.
        assert!(read_signed_in_claude_identity(Some("tok"), None, home, false, &mut only_config).unwrap().is_some());
        let mut both =
            fs_read(vec![(".claude.json", Ok(config.into())), (".credentials.json", Ok(r#"{"claudeAiOauth":{}}"#.into()))]);
        assert!(read_signed_in_claude_identity(None, None, home, false, &mut both).unwrap().is_some());
        let mut busy = fs_read(vec![
            (".claude.json", Ok(config.into())),
            (".credentials.json", Err(io::Error::from(io::ErrorKind::PermissionDenied))),
        ]);
        assert_eq!(read_signed_in_claude_identity(None, None, home, false, &mut busy), Err(LiveIdentityUnknown));
        let mut half = fs_read(vec![(".claude.json", Ok(config.into())), (".credentials.json", Ok("{".into()))]);
        assert_eq!(read_signed_in_claude_identity(None, None, home, false, &mut half), Err(LiveIdentityUnknown));
    }

    #[test]
    fn the_expiry_of_a_profile() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(profile_expiry(dir.path()), None);
        assert!(profile_login_absent(dir.path()));
        std::fs::write(dir.path().join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"a","expiresAt":5}}"#).unwrap();
        assert_eq!(profile_expiry(dir.path()), Some(5.0));
        assert!(!profile_login_absent(dir.path()));
        std::fs::write(dir.path().join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"","expiresAt":5}}"#).unwrap();
        assert_eq!(profile_expiry(dir.path()), None);
    }
}
