//! `normalizeShortcutOverrides` (shared/shortcuts.ts `resolveShortcuts(...).overrides`): the saved key overrides that survive.
//! Unknown ids and malformed combos are dropped, reserved ones and the later of two colliding ones fall back to the default.
//! The registry below mirrors SHORTCUTS of 1.1.4 (id, scope, default template, rebindable); the order matters.

use super::Platform;
use super::js;
use serde_json::{Map, Value};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Global,
    Cell,
    FilesTree,
    Editor,
    Modal,
    GitPanel,
    TerminalPassthrough,
}

struct Def {
    id: &'static str,
    scope: Scope,
    default: Option<&'static str>,
    rebindable: bool,
}

const fn def(id: &'static str, scope: Scope, default: Option<&'static str>, rebindable: bool) -> Def {
    Def { id, scope, default, rebindable }
}

use Scope::*;
const DEFS: [Def; 57] = [
    def("palette.open", Global, Some("Mod+K"), true),
    def("palette.openAlt", Global, Some("Mod+Shift+P"), true),
    def("modal.save", Modal, Some("Mod+Enter"), true),
    def("terminal.new", Global, Some("Mod+Shift+T"), true),
    def("agent.add", Global, Some("Mod+Shift+N"), true),
    def("grid.new", Global, Some("Mod+Shift+G"), true),
    def("conversations.search", Global, Some("Mod+Alt+F"), true),
    def("history.open", Global, Some("Mod+Shift+H"), true),
    def("tab.close", Global, Some("Mod+Shift+W"), true),
    def("tab.next", Global, Some("Ctrl+Tab"), true),
    def("tab.prev", Global, Some("Ctrl+Shift+Tab"), true),
    def("tab.right", Global, None, true),
    def("tab.left", Global, None, true),
    def("cell.maximize", Cell, Some("Mod+Shift+M"), true),
    def("cell.focus.left", Cell, Some("Mod+Alt+Left"), true),
    def("cell.focus.right", Cell, Some("Mod+Alt+Right"), true),
    def("cell.focus.up", Cell, Some("Mod+Alt+Up"), true),
    def("cell.focus.down", Cell, Some("Mod+Alt+Down"), true),
    def("cell.move.left", Cell, Some("Mod+Alt+Shift+Left"), true),
    def("cell.move.right", Cell, Some("Mod+Alt+Shift+Right"), true),
    def("cell.move.up", Cell, Some("Mod+Alt+Shift+Up"), true),
    def("cell.move.down", Cell, Some("Mod+Alt+Shift+Down"), true),
    def("cell.goto.1", Global, Some("Mod+1"), true),
    def("cell.goto.2", Global, Some("Mod+2"), true),
    def("cell.goto.3", Global, Some("Mod+3"), true),
    def("cell.goto.4", Global, Some("Mod+4"), true),
    def("cell.goto.5", Global, Some("Mod+5"), true),
    def("cell.goto.6", Global, Some("Mod+6"), true),
    def("cell.goto.7", Global, Some("Mod+7"), true),
    def("cell.goto.8", Global, Some("Mod+8"), true),
    def("cell.goto.9", Global, Some("Mod+9"), true),
    def("cell.queue", Cell, Some("Mod+Shift+D"), true),
    def("agents.prompt", Global, Some("Mod+Shift+U"), true),
    def("waiting.next", Global, Some("Mod+Alt+PageDown"), true),
    def("waiting.prev", Global, Some("Mod+Alt+PageUp"), true),
    def("terminal.find", Cell, Some("Mod+Shift+F"), true),
    def("snippets.toggle", Global, Some("Mod+Shift+B"), true),
    def("notes.toggle", Global, Some("Mod+Shift+O"), true),
    def("notes.capture", Global, Some("Mod+Shift+L"), true),
    def("folder.new", Global, Some("Mod+Shift+K"), true),
    def("sidebar.toggle", Global, Some("Mod+Shift+E"), true),
    def("git.commit", GitPanel, Some("Mod+Enter"), true),
    def("file.new", Global, Some("Mod+N"), true),
    def("editor.save", Editor, Some("Mod+S"), true),
    def("editor.saveAs", Editor, Some("Mod+Shift+S"), true),
    def("tree.rename", FilesTree, Some("F2"), true),
    def("tree.delete", FilesTree, Some("Delete"), true),
    def("tree.copy", FilesTree, Some("Mod+C"), true),
    def("tree.cut", FilesTree, Some("Mod+X"), true),
    def("tree.paste", FilesTree, Some("Mod+V"), true),
    def("tree.undo", FilesTree, Some("Mod+Z"), true),
    def("tree.selectAll", FilesTree, Some("Mod+A"), true),
    def("terminal.copy", TerminalPassthrough, Some("Mod+C"), false),
    def("terminal.copyAlways", TerminalPassthrough, Some("Mod+Shift+C"), false),
    def("terminal.paste", TerminalPassthrough, Some("Mod+V"), false),
    def("terminal.pasteShift", TerminalPassthrough, Some("Mod+Shift+V"), false),
    def("terminal.zoom", TerminalPassthrough, None, false),
];

#[derive(Clone, PartialEq, Eq, Debug)]
struct Combo {
    key: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

const PUNCTUATION: [&str; 11] = [",", ".", "/", "\\", ";", "'", "[", "]", "-", "=", "`"];
const ALIASES: [(&str, &str); 22] = [
    ("esc", "Escape"),
    ("del", "Delete"),
    ("ins", "Insert"),
    ("return", "Enter"),
    ("pgup", "PageUp"),
    ("pgdn", "PageDown"),
    ("arrowleft", "Left"),
    ("arrowright", "Right"),
    ("arrowup", "Up"),
    ("arrowdown", "Down"),
    ("spacebar", "Space"),
    ("comma", ","),
    ("period", "."),
    ("slash", "/"),
    ("backslash", "\\"),
    ("semicolon", ";"),
    ("quote", "'"),
    ("bracketleft", "["),
    ("bracketright", "]"),
    ("minus", "-"),
    ("equal", "="),
    ("backquote", "`"),
];
const NAMED_TOKENS: [&str; 15] = [
    "Tab",
    "Enter",
    "Space",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Escape",
    "Left",
    "Right",
    "Up",
    "Down",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
    /// `MODIFIER_NAMES['constructor']` / `['__proto__']`: inherited values that count as a modifier and set a junk flag.
    Junk(u8),
}

fn modifier(name: &str) -> Option<Modifier> {
    Some(match name {
        "ctrl" | "control" => Modifier::Ctrl,
        "alt" | "option" | "opt" => Modifier::Alt,
        "shift" => Modifier::Shift,
        "meta" | "cmd" | "command" | "win" | "super" => Modifier::Meta,
        "constructor" => Modifier::Junk(0),
        "__proto__" => Modifier::Junk(1),
        _ => return None,
    })
}

/// `/^f([1-9]|1\d|2[0-4])$/i` (also for `F` keys of a default).
fn is_f_key(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() < 2 || !matches!(b[0], b'f' | b'F') || !b[1..].iter().all(u8::is_ascii_digit) || b[1] == b'0' {
        return false;
    }
    matches!(text[1..].parse::<u32>(), Ok(1..=24)) && b.len() <= 3
}

fn normalize_key(text: &str) -> Option<String> {
    let b = text.as_bytes();
    if b.len() == 1 && b[0].is_ascii_alphabetic() {
        return Some(text.to_ascii_uppercase());
    }
    if b.len() == 1 && b[0].is_ascii_digit() {
        return Some(text.into());
    }
    if is_f_key(text) {
        return Some(text.to_ascii_uppercase());
    }
    if PUNCTUATION.contains(&text) {
        return Some(text.into());
    }
    let lower = text.to_lowercase();
    if let Some((_, alias)) = ALIASES.iter().find(|(name, _)| *name == lower) {
        return Some((*alias).into());
    }
    NAMED_TOKENS.iter().find(|t| t.to_lowercase() == lower).map(|t| (*t).into())
}

fn parse_combo(text: &str) -> Option<Combo> {
    let t = js::trim(text);
    if t.is_empty() {
        return None;
    }
    let parts: Vec<&str> = t.split('+').map(js::trim).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let mut c = Combo { key: String::new(), ctrl: false, alt: false, shift: false, meta: false };
    let mut junk = [false; 2];
    let last = parts.len() - 1;
    for (i, part) in parts.iter().enumerate() {
        let m = modifier(&part.to_lowercase());
        match m {
            Some(m) if i < last => {
                let flag = match m {
                    Modifier::Ctrl => &mut c.ctrl,
                    Modifier::Alt => &mut c.alt,
                    Modifier::Shift => &mut c.shift,
                    Modifier::Meta => &mut c.meta,
                    Modifier::Junk(n) => &mut junk[n as usize],
                };
                if *flag {
                    return None;
                }
                *flag = true;
            }
            None if i == last => c.key = normalize_key(part)?,
            _ => return None,
        }
    }
    (!c.key.is_empty()).then_some(c)
}

fn format_combo(c: &Combo) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if c.ctrl {
        parts.push("Ctrl");
    }
    if c.alt {
        parts.push("Alt");
    }
    if c.shift {
        parts.push("Shift");
    }
    if c.meta {
        parts.push("Meta");
    }
    parts.push(&c.key);
    parts.join("+")
}

/// `parseDefault`: `Mod` is Cmd (Meta) on macOS, Ctrl elsewhere.
fn parse_default(template: &str, platform: Platform) -> Option<Combo> {
    let m = if platform == Platform::Darwin { "Meta" } else { "Ctrl" };
    let replaced: Vec<String> = template.split('+').map(|p| if p == "Mod" { m.to_string() } else { p.to_string() }).collect();
    parse_combo(&replaced.join("+"))
}

fn scopes_overlap(a: Scope, b: Scope) -> bool {
    if matches!(a, Global | Cell) || matches!(b, Global | Cell) {
        return true;
    }
    a == b
}

fn is_letter(k: &str) -> bool {
    k.len() == 1 && k.as_bytes()[0].is_ascii_uppercase()
}

fn is_printable(k: &str) -> bool {
    is_letter(k) || (k.len() == 1 && k.as_bytes()[0].is_ascii_digit()) || PUNCTUATION.contains(&k) || k == "Space"
}

/// `reservedReason(...) !== null`.
fn reserved(c: &Combo, platform: Platform, scope: Scope, own: Option<&Combo>) -> bool {
    if own == Some(c) {
        return false;
    }
    let (key, ctrl, alt, shift, meta) = (c.key.as_str(), c.ctrl, c.alt, c.shift, c.meta);
    let mac = platform == Platform::Darwin;
    if key == "Escape" && !ctrl && !alt && !meta {
        return true;
    }
    if !(ctrl || alt || meta) {
        let function_key = key.len() > 1 && key.starts_with('F') && key[1..].bytes().all(|b| b.is_ascii_digit());
        if function_key {
            return false;
        }
        return !(scope == FilesTree && !shift && ["Delete", "Insert", "Enter", "Backspace"].contains(&key));
    }
    if platform == Platform::Win32 {
        if meta
            || (alt && !ctrl && ["F4", "Tab", "Escape", "Space"].contains(&key))
            || (ctrl && !alt && key == "Escape")
            || (ctrl && alt && key == "Delete")
        {
            return true;
        }
    } else if (meta && !ctrl && !alt && ["Q", "H", "M", "W", "Tab", "Space", "`"].contains(&key))
        || (meta && alt && !ctrl && key == "H")
    {
        return true;
    }
    if is_printable(key) && ((!mac && ctrl && alt && !meta) || (mac && alt && !ctrl && !meta)) {
        return true;
    }
    let edit = ["Z", "Y", "A", "C", "V", "X"].contains(&key);
    let md = if mac { meta && !ctrl && !alt } else { ctrl && !alt && !meta };
    if mac && matches!(scope, Global | Cell) && meta && !ctrl && !alt && !shift && edit {
        return true;
    }
    match scope {
        Global | Cell => {
            (key == "V" && ((ctrl && !alt && !meta) || (mac && meta && !ctrl && !alt)))
                || (ctrl && !alt && !shift && !meta && (is_letter(key) || ["[", "\\", "]", "/", "-", "Space"].contains(&key)))
                || (ctrl
                    && !alt
                    && !meta
                    && ["Left", "Right", "Up", "Down", "Home", "End", "Backspace", "Delete", "Enter", "PageUp", "PageDown"]
                        .contains(&key))
                || (ctrl && !alt && !meta && key.len() == 1 && (b'2'..=b'8').contains(&key.as_bytes()[0]))
                || (alt && !ctrl && !meta)
        }
        Modal | Editor | GitPanel => {
            let editor_keys = [
                "F",
                "G",
                "D",
                "L",
                "I",
                "U",
                "H",
                "K",
                "J",
                "M",
                "/",
                "[",
                "]",
                "\\",
                "Enter",
                "Backspace",
                "Delete",
                "Left",
                "Right",
                "Up",
                "Down",
                "Home",
                "End",
                "Space",
            ];
            (md && !shift && edit)
                || (md && key == "Z" && shift)
                || (scope == Editor && md && editor_keys.contains(&key))
                || (scope == Editor && key == "Tab")
        }
        FilesTree => ["Left", "Right", "Up", "Down", "Home", "End"].contains(&key) && !ctrl && !alt && !meta,
        TerminalPassthrough => false,
    }
}

/// `normalizeShortcutOverrides(raw, platform)`.
pub fn normalize_overrides(raw: Option<&Value>, platform: Platform) -> Value {
    let stored = js::record(raw);
    let defs: Vec<&Def> = DEFS.iter().collect();
    let defaults: Vec<Option<Combo>> = defs.iter().map(|d| d.default.and_then(|t| parse_default(t, platform))).collect();
    // candidates: index -> Some(None) = disabled, Some(Some(c)) = custom.
    let mut candidates: Vec<Option<Option<Combo>>> = vec![None; defs.len()];
    if let Some(stored) = stored {
        for (i, d) in defs.iter().enumerate() {
            let Some(value) = stored.get(d.id) else { continue };
            if !d.rebindable {
                continue;
            }
            if value.is_null() {
                candidates[i] = Some(None);
                continue;
            }
            let Some(combo) = value.as_str().and_then(parse_combo) else { continue };
            if reserved(&combo, platform, d.scope, defaults[i].as_ref()) {
                continue;
            }
            if defaults[i].as_ref() == Some(&combo) {
                continue;
            }
            candidates[i] = Some(Some(combo));
        }
    }
    loop {
        let current: Vec<Option<&Combo>> = (0..defs.len())
            .map(|i| match &candidates[i] {
                Some(c) => c.as_ref(),
                None => defaults[i].as_ref(),
            })
            .collect();
        let mut victim = None;
        'search: for j in 1..defs.len() {
            for i in 0..j {
                let (Some(ca), Some(cb)) = (current[i], current[j]) else { continue };
                if ca != cb || !scopes_overlap(defs[i].scope, defs[j].scope) {
                    continue;
                }
                let v = if candidates[j].is_some() {
                    Some(j)
                } else if candidates[i].is_some() {
                    Some(i)
                } else {
                    None
                };
                if v.is_some() {
                    victim = v;
                    break 'search;
                }
            }
        }
        match victim {
            Some(v) => candidates[v] = None,
            None => break,
        }
    }
    let mut out = Map::new();
    for (i, d) in defs.iter().enumerate() {
        if let Some(c) = &candidates[i] {
            out.insert(d.id.into(), c.as_ref().map_or(Value::Null, |c| Value::from(format_combo(c))));
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn combos_parse_like_the_ts_code() {
        assert_eq!(parse_combo(" shift + ctrl + e ").map(|c| format_combo(&c)).as_deref(), Some("Ctrl+Shift+E"));
        assert_eq!(parse_combo("Ctrl+Ctrl+E"), None);
        assert_eq!(parse_combo("Ctrl++"), None);
        assert_eq!(parse_combo("Ctrl+constructor"), None);
        assert_eq!(parse_combo("constructor+Insert").map(|c| format_combo(&c)).as_deref(), Some("Insert"));
        assert_eq!(parse_combo("constructor+constructor+K"), None);
        assert_eq!(parse_combo("Alt+f24").map(|c| format_combo(&c)).as_deref(), Some("Alt+F24"));
        assert_eq!(parse_combo("f25"), None);
        assert_eq!(parse_combo("Ctrl+pgdn").map(|c| format_combo(&c)).as_deref(), Some("Ctrl+PageDown"));
    }

    #[test]
    fn overrides_keep_only_usable_ones() {
        let raw = json!({"palette.open": "Ctrl+Shift+J", "unknown": "Ctrl+J", "terminal.copy": "Ctrl+Q", "tab.right": null, "agent.add": "Ctrl+Shift+J", "sidebar.toggle": "Ctrl+E"});
        assert_eq!(normalize_overrides(Some(&raw), Platform::Win32), json!({"palette.open": "Ctrl+Shift+J", "tab.right": null}));
    }
}
