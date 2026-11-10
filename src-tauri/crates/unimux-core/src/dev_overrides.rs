//! The MC_* run and debug switches. Electron honoured them only when `!app.isPackaged`; here they are read only in builds with
//! the `dev-overrides` feature or in debug builds (dev and check flavours). Release builds compile the reads out and see `None` for each.
//! MC_CELL_ID is the per-terminal variable, not an override.

use std::path::PathBuf;

/// Every override the app reads, in one place (INVENTORY: the 16 MC_* switches of 1.1.x, plus MC_SAFE_STORAGE_NAME of 1.2.0).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DevOverrides {
    pub data_dir: Option<PathBuf>,
    pub debug_port: Option<u16>,
    pub offscreen: bool,
    pub hook_debug: bool,
    pub ssh_debug: bool,
    pub ssh_no_safestorage: bool,
    /// 1.2.0 only (not in 1.1.x): the app name of the macOS Keychain item (`<name> Safe Storage`) instead of `unimux`, so
    /// harness runs on a Mac never open the real 1.1.x key. Ignored on Windows (the key lives in the data dir).
    pub safe_storage_name: Option<String>,
    pub trash_dir: Option<PathBuf>,
    pub db_export_dir: Option<PathBuf>,
    pub notes_export_dir: Option<PathBuf>,
    pub cli_no_registry: bool,
    pub cli_probe_profile: Option<String>,
    pub install_command_override: Option<String>,
    pub usage_claude_url: Option<String>,
    pub usage_codex_url: Option<String>,
    pub usage_claude_token_url: Option<String>,
    pub update_feed: Option<String>,
    /// 1.2.0 only (U1): the updater public key (base64 of a minisign key file, as `tauri signer generate` writes it) that
    /// replaces the embedded release key, so a harness run can sign a local feed with a scratch key. Never in a release build.
    pub update_pubkey: Option<String>,
    /// 1.2.0 only: on Windows an agent cell types its launch line into the shell again (A/B and diagnosis); without it the
    /// agent CLI is the terminal's own process and the shell starts after it.
    pub agent_via_shell: bool,
}

/// The names, for docs and the release check (a release binary must not read them).
pub const OVERRIDE_NAMES: [&str; 19] = [
    "MC_DATA_DIR",
    "MC_DEBUG_PORT",
    "MC_OFFSCREEN",
    "MC_HOOK_DEBUG",
    "MC_SSH_DEBUG",
    "MC_SSH_NO_SAFESTORAGE",
    "MC_SAFE_STORAGE_NAME",
    "MC_TRASH_DIR",
    "MC_DB_EXPORT_DIR",
    "MC_NOTES_EXPORT_DIR",
    "MC_CLI_NO_REGISTRY",
    "MC_CLI_PROBE_PROFILE",
    "MC_INSTALL_COMMAND_OVERRIDE",
    "MC_USAGE_CLAUDE_URL",
    "MC_USAGE_CODEX_URL",
    "MC_USAGE_CLAUDE_TOKEN_URL",
    "MC_UPDATE_FEED",
    "MC_UPDATE_PUBKEY",
    "MC_AGENT_VIA_SHELL",
];

impl DevOverrides {
    /// Reads the process environment (always empty in a release build).
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Reads from any lookup; `enabled` decides like the build feature does.
    pub fn from_lookup_enabled(enabled: bool, get: impl Fn(&str) -> Option<String>) -> Self {
        if !enabled {
            return Self::default();
        }
        // `process.env[name] || undefined`: an empty value counts as unset.
        let s = |n: &str| get(n).filter(|v| !v.is_empty());
        let flag = |n: &str| s(n).is_some_and(|v| v != "0");
        // `process.env[name] === '1'`: these four are on for exactly "1" ("true", "yes" or "2" leave them off).
        let one = |n: &str| get(n).is_some_and(|v| v == "1");
        Self {
            data_dir: s("MC_DATA_DIR").map(PathBuf::from),
            debug_port: s("MC_DEBUG_PORT").and_then(|v| v.trim().parse().ok()).filter(|p| *p != 0),
            offscreen: flag("MC_OFFSCREEN"),
            hook_debug: one("MC_HOOK_DEBUG"),
            ssh_debug: one("MC_SSH_DEBUG"),
            ssh_no_safestorage: one("MC_SSH_NO_SAFESTORAGE"),
            safe_storage_name: s("MC_SAFE_STORAGE_NAME"),
            trash_dir: s("MC_TRASH_DIR").map(PathBuf::from),
            db_export_dir: s("MC_DB_EXPORT_DIR").map(PathBuf::from),
            notes_export_dir: s("MC_NOTES_EXPORT_DIR").map(PathBuf::from),
            cli_no_registry: one("MC_CLI_NO_REGISTRY"),
            cli_probe_profile: s("MC_CLI_PROBE_PROFILE"),
            install_command_override: s("MC_INSTALL_COMMAND_OVERRIDE"),
            usage_claude_url: s("MC_USAGE_CLAUDE_URL"),
            usage_codex_url: s("MC_USAGE_CODEX_URL"),
            usage_claude_token_url: s("MC_USAGE_CLAUDE_TOKEN_URL"),
            update_feed: s("MC_UPDATE_FEED"),
            update_pubkey: s("MC_UPDATE_PUBKEY"),
            agent_via_shell: one("MC_AGENT_VIA_SHELL"),
        }
    }

    /// The overrides of this build: read with `dev-overrides`, none without it.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        #[cfg(any(feature = "dev-overrides", debug_assertions))]
        {
            Self::from_lookup_enabled(true, get)
        }
        #[cfg(not(any(feature = "dev-overrides", debug_assertions)))]
        {
            let _ = get;
            Self::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn reads_when_enabled() {
        let o = DevOverrides::from_lookup_enabled(
            true,
            env(&[("MC_DATA_DIR", "C:/scratch"), ("MC_DEBUG_PORT", "9333"), ("MC_OFFSCREEN", "1"), ("MC_UPDATE_FEED", "")]),
        );
        assert_eq!(o.data_dir, Some(PathBuf::from("C:/scratch")));
        assert_eq!(o.debug_port, Some(9333));
        assert!(o.offscreen);
        assert_eq!(o.update_feed, None);
    }

    /// 1.1.x turned safeStorage off only for exactly `1`.
    #[test]
    fn no_safestorage_needs_exactly_one() {
        for (value, off) in [("1", true), ("true", false), ("yes", false), ("0", false), ("", false), (" 1", false)] {
            let o = DevOverrides::from_lookup_enabled(true, env(&[("MC_SSH_NO_SAFESTORAGE", value)]));
            assert_eq!(o.ssh_no_safestorage, off, "{value:?}");
        }
    }

    #[test]
    fn safe_storage_name_is_read_as_given() {
        let o = DevOverrides::from_lookup_enabled(true, env(&[("MC_SAFE_STORAGE_NAME", "unimux-check")]));
        assert_eq!(o.safe_storage_name.as_deref(), Some("unimux-check"));
        let o = DevOverrides::from_lookup_enabled(true, env(&[("MC_SAFE_STORAGE_NAME", "")]));
        assert_eq!(o.safe_storage_name, None);
    }

    #[test]
    fn the_exact_one_switches_ignore_other_values() {
        for v in ["true", "yes", "2", "0", " 1", ""] {
            let o = DevOverrides::from_lookup_enabled(
                true,
                env(&[("MC_HOOK_DEBUG", v), ("MC_SSH_DEBUG", v), ("MC_SSH_NO_SAFESTORAGE", v), ("MC_CLI_NO_REGISTRY", v)]),
            );
            assert!(!o.hook_debug && !o.ssh_debug && !o.ssh_no_safestorage && !o.cli_no_registry, "{v:?}");
        }
        let o = DevOverrides::from_lookup_enabled(
            true,
            env(&[("MC_HOOK_DEBUG", "1"), ("MC_SSH_DEBUG", "1"), ("MC_SSH_NO_SAFESTORAGE", "1"), ("MC_CLI_NO_REGISTRY", "1")]),
        );
        assert!(o.hook_debug && o.ssh_debug && o.ssh_no_safestorage && o.cli_no_registry);
    }

    #[test]
    fn the_agent_via_shell_switch_needs_exactly_one() {
        for (value, on) in [("1", true), ("true", false), ("0", false), ("", false)] {
            let o = DevOverrides::from_lookup_enabled(true, env(&[("MC_AGENT_VIA_SHELL", value)]));
            assert_eq!(o.agent_via_shell, on, "{value:?}");
        }
        assert!(!DevOverrides::from_lookup_enabled(false, env(&[("MC_AGENT_VIA_SHELL", "1")])).agent_via_shell);
    }

    #[test]
    fn ignored_when_disabled() {
        let o = DevOverrides::from_lookup_enabled(false, env(&[("MC_DATA_DIR", "C:/scratch")]));
        assert_eq!(o, DevOverrides::default());
    }

    /// The release flavour (no feature, no debug assertions: `cargo test --release`) ignores MC_DATA_DIR whatever the environment says.
    #[cfg(not(any(feature = "dev-overrides", debug_assertions)))]
    #[test]
    fn release_build_ignores_the_environment() {
        assert_eq!(DevOverrides::from_lookup(env(&[("MC_DATA_DIR", "C:/scratch")])).data_dir, None);
    }

    #[cfg(any(feature = "dev-overrides", debug_assertions))]
    #[test]
    fn dev_build_reads_the_environment() {
        assert_eq!(DevOverrides::from_lookup(env(&[("MC_DATA_DIR", "C:/scratch")])).data_dir, Some(PathBuf::from("C:/scratch")));
    }
}
