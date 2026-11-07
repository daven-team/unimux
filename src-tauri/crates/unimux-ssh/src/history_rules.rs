//! The command history rules of shared/commandHistory.ts that the main process uses (S1): which lines are kept, how a run
//! is recorded, the frecency rank and how a history file is cleaned on load. The renderer keeps its own TS copy for the
//! capture (`captureCommand`) and the autocomplete.

use indexmap::IndexMap;
use serde_json::{Value, json};
use unimux_core::utf16;

use crate::js_value::{finite, integer, is_object, is_object_like, is_uuid, string};

pub const VERSION: u32 = 1;
/// Entries kept per host; the lowest ranked one goes first.
pub const PER_HOST: usize = 2000;
/// Characters (UTF-16 code units) of one command.
pub const COMMAND_MAX: usize = 1000;
/// Hosts with a history (the least recently used host's history goes first).
pub const HOSTS_MAX: usize = 500;

/// One command of a host's history.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryEntry {
    pub command: String,
    /// Runs counted (a repeat of the line run just before it is not counted).
    pub count: f64,
    /// Last run, ms since epoch.
    pub last_used: f64,
}

impl HistoryEntry {
    pub fn to_json(&self) -> Value {
        json!({ "command": self.command, "count": js_number(self.count), "lastUsed": js_number(self.last_used) })
    }
}

/// A finite double as JSON.stringify writes it (whole numbers without a fraction).
pub fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 { json!(n as i64) } else { json!(n) }
}

/// Hosts in their order: the most recently used last.
pub type Hosts = IndexMap<String, Vec<HistoryEntry>>;

const HOUR: f64 = 3_600_000.0;
const DAY: f64 = 24.0 * HOUR;

/// `frecency(entry, now)`: more runs count, recent runs count more.
pub fn frecency(entry: &HistoryEntry, now: f64) -> f64 {
    let age = (now - entry.last_used).max(0.0);
    let recency = if age < HOUR {
        8.0
    } else if age < DAY {
        4.0
    } else if age < 7.0 * DAY {
        2.0
    } else if age < 30.0 * DAY {
        1.0
    } else {
        0.5
    };
    (1.0 + entry.count.max(1.0).log2()) * recency
}

/// `/[\u0000-\u001f\u007f-\u009f]/`.
fn has_control(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
}

/// `/^[*•●·∙]+$/u`: a secret echoed as stars or dots.
fn masked(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| matches!(c, '*' | '•' | '●' | '·' | '∙'))
}

/// A continuation (`\`, a pipe or `&&` at the end) or an unclosed quote.
fn incomplete(command: &str) -> bool {
    if command.ends_with('\\') || command.ends_with('|') || command.ends_with("&&") {
        return true;
    }
    let mut quote: Option<char> = None;
    let mut chars = command.chars();
    while let Some(ch) = chars.next() {
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                } else if ch == '\\' && q == '"' {
                    chars.next();
                }
            }
            None => {
                if ch == '\\' {
                    chars.next();
                } else if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                }
            }
        }
    }
    quote.is_some()
}

/// `historyCommand(line)`: the text kept for a submitted line, or None when it is not kept.
pub fn history_command(line: &str) -> Option<&str> {
    if line.is_empty() || line.starts_with(utf16::is_js_space_char) {
        return None;
    }
    let text = utf16::js_trim_end(line);
    if text.chars().count() < 2 || utf16::len(text) > COMMAND_MAX || has_control(text) || masked(text) || incomplete(text) {
        return None;
    }
    Some(text)
}

/// `recordCommand(entries, command, now, limit)`: None when nothing changes (the command is already the newest entry).
pub fn record_command(entries: &[HistoryEntry], command: &str, now: f64, limit: usize) -> Option<Vec<HistoryEntry>> {
    if entries.first().is_some_and(|e| e.command == command) {
        return None;
    }
    let old = entries.iter().find(|e| e.command == command);
    let mut next = vec![HistoryEntry { command: command.to_string(), count: old.map_or(0.0, |e| e.count) + 1.0, last_used: now }];
    next.extend(entries.iter().filter(|e| e.command != command).cloned());
    while next.len() > limit.max(1) {
        let mut worst = 1;
        for i in 2..next.len() {
            let a = frecency(&next[i], now);
            let b = frecency(&next[worst], now);
            if a < b || (a == b && next[i].last_used <= next[worst].last_used) {
                worst = i;
            }
        }
        next.remove(worst);
    }
    Some(next)
}

fn normalize_entries(raw: &Value) -> Vec<HistoryEntry> {
    let Some(list) = raw.as_array() else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for value in list {
        if !is_object_like(value) {
            continue;
        }
        let Some(original) = string(&value["command"]) else { continue };
        let Some(command) = history_command(original) else { continue };
        if command != original || seen.contains(command) {
            continue;
        }
        let count = integer(&value["count"]).filter(|c| *c >= 1.0).unwrap_or(1.0);
        let last_used = finite(&value["lastUsed"]).and_then(|n| n.as_f64()).filter(|l| *l >= 0.0).unwrap_or(0.0);
        seen.insert(command.to_string());
        out.push(HistoryEntry { command: command.to_string(), count, last_used });
    }
    out.sort_by(|a, b| b.last_used.partial_cmp(&a.last_used).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(PER_HOST);
    out
}

/// What [`normalize_command_history`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct Normalized {
    pub hosts: Hosts,
    /// From a newer app version: never written over.
    pub newer: bool,
    /// Not a history file at all: never written over.
    pub invalid: bool,
}

/// `normalizeCommandHistory(raw)`: bad entries dropped, duplicates merged, limits applied, the most recently used host last.
pub fn normalize_command_history(raw: &Value) -> Normalized {
    let mut hosts = Hosts::new();
    if !is_object(raw) {
        return Normalized { hosts, newer: false, invalid: true };
    }
    let newer = crate::js_value::JsNum::of(&raw["version"]).is_some_and(|n| n.as_f64() > f64::from(VERSION));
    let Some(h) = raw.get("hosts") else { return Normalized { hosts, newer, invalid: false } };
    let Some(map) = h.as_object() else { return Normalized { hosts, newer, invalid: true } };
    let mut list: Vec<(String, Vec<HistoryEntry>)> = map
        .iter()
        .filter(|(id, _)| is_uuid(id))
        .map(|(id, entries)| (id.clone(), normalize_entries(entries)))
        .filter(|(_, entries)| !entries.is_empty())
        .collect();
    list.sort_by(|a, b| a.1[0].last_used.partial_cmp(&b.1[0].last_used).unwrap_or(std::cmp::Ordering::Equal));
    let skip = list.len().saturating_sub(HOSTS_MAX);
    for (id, entries) in list.into_iter().skip(skip) {
        hosts.insert(id, entries);
    }
    Normalized { hosts, newer, invalid: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_lines() {
        for (line, kept) in [
            ("ls -la", Some("ls -la")),
            ("ls   ", Some("ls")),
            (" secret", None),
            ("\u{a0}ls", None),
            ("", None),
            ("a", None),
            ("ab", Some("ab")),
            ("a\u{1b}b", None),
            ("a\u{85}b", None),
            ("****", None),
            ("••", None),
            ("echo 'x", None),
            ("echo \"a\\\"b\"", Some("echo \"a\\\"b\"")),
            ("echo a \\", None),
            ("cat x |", None),
            ("make &&", None),
            ("make &", Some("make &")),
            ("\u{1F600}", None),
            ("\u{1F600}\u{1F600}", Some("\u{1F600}\u{1F600}")),
        ] {
            assert_eq!(history_command(line), kept, "{line:?}");
        }
        assert_eq!(history_command(&"x".repeat(1000)).map(str::len), Some(1000));
        assert_eq!(history_command(&"x".repeat(1001)), None);
        assert_eq!(history_command(&"\u{1F600}".repeat(501)), None, "1002 code units");
    }

    #[test]
    fn records_most_recent_first_and_drops_the_lowest_ranked() {
        let e = |c: &str, count: f64, at: f64| HistoryEntry { command: c.into(), count, last_used: at };
        let list = vec![e("a", 1.0, 10.0), e("b", 5.0, 5.0)];
        assert_eq!(record_command(&list, "a", 20.0, 10), None);
        let next = record_command(&list, "b", 20.0, 10).unwrap();
        assert_eq!(next, vec![e("b", 6.0, 20.0), e("a", 1.0, 10.0)]);
        let capped = record_command(&[e("x", 1.0, 0.0), e("y", 1.0, 0.0), e("z", 9.0, 0.0)], "n", 1.0, 3).unwrap();
        assert_eq!(capped.iter().map(|e| e.command.as_str()).collect::<Vec<_>>(), vec!["n", "x", "z"]);
    }
}
