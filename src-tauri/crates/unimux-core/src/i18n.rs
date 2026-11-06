//! `translate()` of src/shared/i18n.ts over the generated table `src-tauri/gen/messages.json` (scripts/gen-messages.mjs; CI
//! fails when it drifts from src/shared). Polish is the key itself; a missing row or column falls back to the key; `{name}`
//! placeholders are replaced from `params`, unknown ones stay as written.

use std::collections::HashMap;
use std::sync::LazyLock;

/// The six UI languages in the order of `LANGUAGES` (src/shared/languages.ts).
pub const LANGUAGES: [&str; 6] = ["en", "pl", "de", "es", "fr", "pt"];

static TABLE: LazyLock<HashMap<String, Vec<String>>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../../gen/messages.json")).unwrap_or_default());

/// Column of a language in a message row (`MESSAGE_COLUMN`); None for Polish (the key).
fn column(language: &str) -> Option<usize> {
    match language {
        "en" => Some(0),
        "de" => Some(1),
        "es" => Some(2),
        "fr" => Some(3),
        "pt" => Some(4),
        _ => None,
    }
}

pub fn is_language(code: &str) -> bool {
    LANGUAGES.contains(&code)
}

/// `detectLanguage`: the first supported language of the locales, else English.
pub fn detect_language<S: AsRef<str>>(locales: &[S]) -> &'static str {
    for locale in locales {
        let lower = locale.as_ref().to_lowercase();
        let code = lower.split(['-', '_']).next().unwrap_or("");
        if let Some(found) = LANGUAGES.iter().find(|l| **l == code) {
            return found;
        }
    }
    "en"
}

/// Number of rows in the generated table (tests, the report).
pub fn message_count() -> usize {
    TABLE.len()
}

/// `translate(language, key, params)`.
pub fn translate(language: &str, key: &str, params: &[(&str, &str)]) -> String {
    let message: &str = if language == "pl" {
        key
    } else {
        column(language).and_then(|c| TABLE.get(key).and_then(|row| row.get(c))).map(String::as_str).unwrap_or(key)
    };
    replace_params(message, params)
}

/// `message.replace(/\{(\w+)\}/g, (token, name) => String(params[name] ?? token))`.
fn replace_params(message: &str, params: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let name_len = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after.len());
        if name_len > 0 && after[name_len..].starts_with('}') {
            let name = &after[..name_len];
            match params.iter().find(|(k, _)| *k == name) {
                Some((_, v)) => out.push_str(v),
                None => {
                    out.push('{');
                    out.push_str(name);
                    out.push('}');
                }
            }
            rest = &after[name_len + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders() {
        assert_eq!(replace_params("a {x} b {y} {}", &[("x", "1")]), "a 1 b {y} {}");
        assert_eq!(replace_params("{x}{x}", &[("x", "é")]), "éé");
    }

    #[test]
    fn polish_is_the_key_and_unknown_keys_fall_back() {
        assert_eq!(translate("pl", "Nie udało się uruchomić unimux.", &[]), "Nie udało się uruchomić unimux.");
        assert_eq!(translate("en", "no such key {a}", &[("a", "1")]), "no such key 1");
    }

    #[test]
    fn table_is_embedded() {
        assert!(message_count() > 1000, "gen/messages.json has {} rows", message_count());
        assert_eq!(translate("en", "Nie udało się uruchomić unimux.", &[]), "unimux could not start.");
    }

    #[test]
    fn detects_language() {
        assert_eq!(detect_language(&["pl-PL"]), "pl");
        assert_eq!(detect_language(&["xx", "de_DE"]), "de");
        assert_eq!(detect_language::<&str>(&[]), "en");
    }
}
