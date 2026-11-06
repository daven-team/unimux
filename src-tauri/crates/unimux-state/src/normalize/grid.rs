//! Grids: `isUsableLayout` / `layoutForCount` (shared/layout.ts), grid templates (shared/gridTemplates.ts `normalizePresets`,
//! `cleanTemplateDir`, `normalizeCellDir`), the prompt queue of a cell (shared/promptQueue.ts) and the notes (shared/notes.ts).

use super::js;
use serde_json::{Map, Value, json};

pub const MAX_CELLS: usize = 20;
const GROW_STEPS: [(usize, usize); 7] = [(1, 1), (2, 2), (2, 4), (3, 6), (3, 9), (4, 12), (5, 20)];

/// `layoutForCount(n)` for a count already known to be a number (clamped to 1..MAX_CELLS).
pub fn layout_for_count(n: f64) -> Value {
    let count = n.floor().clamp(1.0, MAX_CELLS as f64) as usize;
    let cols = GROW_STEPS.iter().find(|(_, cap)| *cap >= count).map_or(5, |s| s.0);
    let rows = count.div_ceil(cols);
    let mut areas = Vec::with_capacity(count);
    for i in 0..count {
        let (row, col) = (i / cols, i % cols);
        let span = if i + 1 == count { cols - col } else { 1 };
        areas.push(json!({"col": col, "row": row, "colSpan": span, "rowSpan": 1}));
    }
    json!({"cols": cols, "rows": rows, "areas": areas})
}

fn is_numbers(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(Value::is_number))
}

fn is_number_rows(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(|row| row.is_null() || is_numbers(row)))
}

/// `isUsableLayout(layout, count)`.
pub fn is_usable_layout(layout: Option<&Value>, count: usize) -> bool {
    let Some(l) = js::record(layout) else { return false };
    let (Some(cols), Some(rows)) = (js::integer(l.get("cols")), js::integer(l.get("rows"))) else { return false };
    if cols < 1.0 || rows < 1.0 || cols > 60.0 || rows > 60.0 {
        return false;
    }
    let Some(areas) = l.get("areas").and_then(Value::as_array) else { return false };
    if areas.len() != count {
        return false;
    }
    let inside = areas.iter().all(|a| {
        let Some(o) = a.as_object() else { return false };
        let f = |k: &str| js::integer(o.get(k));
        let (Some(col), Some(row), Some(cs), Some(rs)) = (f("col"), f("row"), f("colSpan"), f("rowSpan")) else { return false };
        col >= 0.0 && row >= 0.0 && cs >= 1.0 && rs >= 1.0 && col + cs <= cols && row + rs <= rows
    });
    if !inside {
        return false;
    }
    if let Some(mode) = l.get("mode")
        && mode.as_str() != Some("cols")
    {
        return false;
    }
    for field in ["rowCounts", "rowSizes", "colSizes"] {
        if let Some(v) = l.get(field)
            && !is_numbers(v)
        {
            return false;
        }
    }
    for field in ["rowColSizes", "colRowSizes"] {
        if let Some(v) = l.get(field)
            && !is_number_rows(v)
        {
            return false;
        }
    }
    true
}

/// `templateLayout`: only the fields a grid draws (a usable layout).
fn template_layout(l: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    out.insert("cols".into(), l["cols"].clone());
    out.insert("rows".into(), l["rows"].clone());
    let areas: Vec<Value> = l["areas"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|x| json!({"col": x["col"], "row": x["row"], "colSpan": x["colSpan"], "rowSpan": x["rowSpan"]}))
                .collect()
        })
        .unwrap_or_default();
    out.insert("areas".into(), Value::Array(areas));
    for field in ["rowCounts", "rowSizes", "rowColSizes", "colSizes", "mode", "colRowSizes"] {
        if js::truthy(l.get(field)) {
            out.insert(field.into(), l[field].clone());
        }
    }
    Value::Object(out)
}

/// A drive path (C:\ or C:/), a UNC path or a POSIX absolute path.
pub fn is_absolute_dir(dir: &str) -> bool {
    let b = dir.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
        || dir.starts_with('/')
        || dir.starts_with("\\\\")
}

/// `dir.replace(/(?<=.)[\\/]+$/, '')`: the trailing separators, unless nothing (or a line break) stands before them.
fn strip_trailing_separators(dir: &str) -> &str {
    let trimmed = dir.trim_end_matches(['\\', '/']);
    let run_start = trimmed.len();
    if run_start == dir.len() {
        return dir;
    }
    if run_start > 0 && !trimmed.chars().next_back().is_some_and(js::is_line_terminator) {
        return trimmed;
    }
    // The match may start one separator later (preceded by the first one), when there are two or more.
    if dir.len() - run_start >= 2 { &dir[..run_start + 1] } else { dir }
}

/// `cleanTemplateDir(raw)`.
pub fn clean_template_dir(raw: Option<&Value>) -> Option<String> {
    let dir = js::trim(js::string(raw)?);
    if dir.is_empty() || js::len16(dir) > 1000 || dir.contains('\0') {
        return None;
    }
    if is_absolute_dir(dir) {
        let stripped = strip_trailing_separators(dir);
        let b = stripped.as_bytes();
        if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            return Some(format!("{stripped}\\"));
        }
        return Some(stripped.to_string());
    }
    let b = dir.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return None;
    }
    let replaced = dir.replace('\\', "/");
    let parts: Vec<&str> = replaced.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.is_empty() || parts.contains(&"..") {
        return None;
    }
    Some(parts.join("/"))
}

/// `normalizeCellDir`: an absolute folder of a sane length.
pub fn normalize_cell_dir(raw: Option<&Value>) -> Option<String> {
    clean_template_dir(raw).filter(|d| is_absolute_dir(d))
}

/// `clip(v, max)` of gridTemplates.ts: a trimmed, non-empty string of at most `max` units.
fn clip(v: Option<&Value>, max: usize) -> Option<String> {
    let t = js::trim(js::string(v)?);
    (!t.is_empty() && js::len16(t) <= max).then(|| t.to_string())
}

/// What `remap(id)` (RETIRED_PROFILES[id] ?? id) leaves of a profile id: a value, or nothing (JSON.stringify drops the
/// inherited function a name like "constructor" finds).
pub enum Remapped {
    Value(Value),
    Dropped,
}

pub fn remap(id: &Value) -> Remapped {
    let key = js::to_string(Some(id));
    match key.as_str() {
        "claude-opus" => Remapped::Value(Value::from("claude")),
        "codex-high" => Remapped::Value(Value::from("codex")),
        // Object.prototype itself: JSON.stringify writes {}.
        "__proto__" => Remapped::Value(Value::Object(Map::new())),
        k if js::is_proto_key(k) => Remapped::Dropped,
        _ => Remapped::Value(id.clone()),
    }
}

pub fn put_remapped(out: &mut Map<String, Value>, key: &str, id: &Value) {
    match remap(id) {
        Remapped::Value(v) => {
            out.insert(key.into(), v);
        }
        Remapped::Dropped => {
            out.shift_remove(key);
        }
    }
}

fn normalize_template_cell(raw: &Value) -> Option<Value> {
    let r = raw.as_object()?;
    let profile = r.get("profileId")?;
    let p = profile.as_str()?;
    if p.is_empty() || js::len16(p) > 128 {
        return None;
    }
    let name = clip(r.get("name"), 140);
    let model = clip(r.get("model"), 128);
    let color = clip(r.get("color"), 32);
    let prompt = js::string(r.get("prompt")).filter(|s| !js::trim(s).is_empty() && js::len16(s) <= 32_000);
    let ssh = js::string(r.get("sshHostId")).filter(|s| !s.is_empty() && js::len16(s) <= 64);
    let dir = clean_template_dir(r.get("dir"));
    let mut out = Map::new();
    put_remapped(&mut out, "profileId", profile);
    out.insert("worktree".into(), Value::Bool(js::is_true(r.get("worktree"))));
    if let Some(role) = js::string(r.get("role")).filter(|s| *s == "coordinator" || *s == "worker") {
        out.insert("role".into(), Value::from(role));
    }
    for (k, v) in [("model", model), ("name", name), ("color", color)] {
        if let Some(v) = v {
            out.insert(k.into(), Value::from(v));
        }
    }
    if let Some(p) = prompt {
        out.insert("prompt".into(), Value::from(p));
    }
    if let Some(s) = ssh {
        out.insert("sshHostId".into(), Value::from(s));
    }
    if let Some(d) = dir {
        out.insert("dir".into(), Value::from(d));
    }
    if js::is_true(r.get("muted")) {
        out.insert("muted".into(), Value::Bool(true));
    }
    Some(Value::Object(out))
}

/// `normalizePresets(raw, remap)`: at most 100 templates with a unique id and a name, 1..MAX_CELLS cells each.
pub fn normalize_presets(raw: Option<&Value>) -> Value {
    let Some(list) = raw.and_then(Value::as_array) else { return json!([]) };
    let mut out: Vec<Value> = Vec::new();
    let mut ids: Vec<&str> = Vec::new();
    for p in list {
        if out.len() >= 100 {
            break;
        }
        let Some(o) = p.as_object() else { continue };
        let Some(id) = js::string(o.get("id")) else { continue };
        if id.is_empty() || js::len16(id) > 128 || ids.contains(&id) {
            continue;
        }
        let Some(name) = clip(o.get("name"), 140) else { continue };
        let cells: Vec<Value> = o
            .get("cells")
            .and_then(Value::as_array)
            .map(|c| c.iter().filter_map(normalize_template_cell).take(MAX_CELLS).collect())
            .unwrap_or_default();
        if cells.is_empty() {
            continue;
        }
        let layout = match o.get("layout") {
            Some(Value::Object(l)) if is_usable_layout(o.get("layout"), cells.len()) => template_layout(l),
            _ => layout_for_count(cells.len() as f64),
        };
        ids.push(id);
        let mut t = Map::new();
        t.insert("id".into(), Value::from(id));
        t.insert("name".into(), Value::from(name));
        t.insert("layout".into(), layout);
        t.insert("cells".into(), Value::Array(cells));
        if let Some(pid) = js::string(o.get("projectId")).filter(|s| !s.is_empty() && js::len16(s) <= 128) {
            t.insert("projectId".into(), Value::from(pid));
        }
        out.push(Value::Object(t));
    }
    Value::Array(out)
}

const QUEUE_PAUSES: [&str; 11] =
    ["user", "restart", "permission", "question", "error", "limit", "interrupted", "exited", "typing", "noTurn", "paste"];

/// `normalizePromptQueue(raw, launch)`; None when nothing is left.
pub fn normalize_prompt_queue(raw: Option<&Value>, launch: bool) -> Option<Value> {
    let r = js::record(raw)?;
    let list = r.get("items")?.as_array()?;
    let mut seen: Vec<&str> = Vec::new();
    let mut items = Vec::new();
    for item in list {
        if items.len() >= 50 {
            break;
        }
        let Some(o) = item.as_object() else { continue };
        let Some(id) = js::string(o.get("id")) else { continue };
        if id.is_empty() || js::len16(id) > 64 || seen.contains(&id) {
            continue;
        }
        let Some(text) = js::string(o.get("text")).filter(|t| !js::trim(t).is_empty()) else { continue };
        let auto = js::is_true(o.get("auto"));
        if auto && launch {
            continue;
        }
        seen.push(id);
        let mut q = Map::new();
        q.insert("id".into(), Value::from(id));
        q.insert("text".into(), Value::from(js::slice16(text, 20_000)));
        if auto {
            q.insert("auto".into(), Value::Bool(true));
        }
        items.push(Value::Object(q));
    }
    if items.is_empty() {
        return None;
    }
    let saved = js::string(r.get("paused")).filter(|p| QUEUE_PAUSES.contains(p));
    let paused = saved.or(if launch { Some("restart") } else { None });
    let mut out = Map::new();
    out.insert("items".into(), Value::Array(items));
    if let Some(p) = paused {
        out.insert("paused".into(), Value::from(p));
    }
    Some(Value::Object(out))
}

const CODE_LANGUAGES: [&str; 19] = [
    "text",
    "markdown",
    "shell",
    "powershell",
    "typescript",
    "javascript",
    "sql",
    "python",
    "json",
    "yaml",
    "html",
    "css",
    "go",
    "rust",
    "c",
    "cpp",
    "java",
    "csharp",
    "toml",
];

/// `normalizeNotes`: at most 500 notes with a unique id (1..64 units), name and text cut.
pub fn normalize_notes(raw: Option<&Value>) -> Value {
    let Some(list) = raw.and_then(Value::as_array) else { return json!([]) };
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for item in list {
        if out.len() >= 500 {
            break;
        }
        let Some(r) = item.as_object() else { continue };
        let Some(id) = js::string(r.get("id")) else { continue };
        if id.is_empty() || js::len16(id) > 64 || seen.contains(&id) {
            continue;
        }
        let (name, text) = (js::string(r.get("name")), js::string(r.get("text")));
        if name.is_none() && text.is_none() {
            continue;
        }
        seen.push(id);
        let mut n = Map::new();
        n.insert("id".into(), Value::from(id));
        n.insert("name".into(), Value::from(name.map(|s| js::slice16(s, 120)).unwrap_or_default()));
        n.insert("text".into(), Value::from(text.map(|s| js::slice16(s, 200_000)).unwrap_or_default()));
        if let Some(p) = js::string(r.get("projectId")).filter(|s| !s.is_empty()) {
            n.insert("projectId".into(), Value::from(p));
        }
        if let Some(c) = js::string(r.get("color")).filter(|s| js::is_hex_color(s)) {
            n.insert("color".into(), Value::from(c));
        }
        if let Some(l) = js::string(r.get("language")).filter(|s| CODE_LANGUAGES.contains(s)) {
            n.insert("language".into(), Value::from(l));
        }
        if js::is_true(r.get("pinned")) {
            n.insert("pinned".into(), Value::Bool(true));
        }
        let updated = js::number(r.get("updatedAt")).filter(|u| *u > 0.0).map_or(Value::from(0), |u| js::num(js::round(u)));
        n.insert("updatedAt".into(), updated);
        out.push(Value::Object(n));
    }
    Value::Array(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_for_counts() {
        assert_eq!(
            layout_for_count(3.0),
            json!({"cols": 2, "rows": 2, "areas": [
            {"col": 0, "row": 0, "colSpan": 1, "rowSpan": 1}, {"col": 1, "row": 0, "colSpan": 1, "rowSpan": 1},
            {"col": 0, "row": 1, "colSpan": 2, "rowSpan": 1}]})
        );
        assert_eq!(layout_for_count(25.0)["areas"].as_array().unwrap().len(), 20);
    }

    #[test]
    fn template_dirs() {
        let d = |s: &str| clean_template_dir(Some(&Value::from(s)));
        assert_eq!(d("C:\\x\\\\").as_deref(), Some("C:\\x"));
        assert_eq!(d("C:\\").as_deref(), Some("C:\\"));
        assert_eq!(d("/").as_deref(), Some("/"));
        assert_eq!(d("//").as_deref(), Some("/"));
        assert_eq!(d("a\\.\\b/").as_deref(), Some("a/b"));
        assert_eq!(d("a/../b"), None);
        assert_eq!(d("C:web"), None);
        assert_eq!(d("/a\u{2028}/").as_deref(), Some("/a\u{2028}/"));
        assert_eq!(d("/a\u{2028}//").as_deref(), Some("/a\u{2028}/"));
    }
}
