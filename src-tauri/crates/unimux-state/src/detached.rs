//! Tabs pulled out of the main window into their own window: port of the pure part of src/shared/detached.ts (W5).
//!
//! The registry lives in `AppState.detachedWindows` and is written by main only. This module answers what the TS functions
//! answer: the registry edits (`addDetached`, `removeDetached`, `setDetachedPlace`), which window owns which cell
//! (`cellOwners`, `routeChanges`), where a window opens (`restoreBounds`, `boundsAtPoint`, `boundsBeside` over display work
//! areas in Electron DIPs), the window title, what a moving tab takes along (`splitHandoffs`, `handoffSessions`), the unsaved
//! work a detached window reports (`cleanWork`, `sumWork`), the tabs it opens in the main window (`cleanOpenInMain`), the
//! wait marks it relays (`normalizeWaitMark`, shared/waiting.ts) and the documents of a hand-over (`cleanDocs` of
//! src/main/detachedWindows.ts). The registry normalizer itself is [`crate::normalize::windows::normalize_detached_windows`].
//!
//! test/golden/detached.jsonl (scripts/goldens-detached.mjs, written by the TS functions) checks every answer
//! (tests/golden.rs `detached_matches_the_ts_reference`).

use serde_json::{Map, Value, json};

use crate::normalize::js;
pub use crate::normalize::windows::clean_target;

/// Detached windows at most (each is a renderer process).
pub const DETACHED_LIMIT: usize = 8;
/// The default size of a new detached window.
pub const DEFAULT_SIZE: Size = Size { width: 1000.0, height: 700.0 };
/// The smallest detached window.
pub const MIN_SIZE: Size = Size { width: 480.0, height: 320.0 };
/// Height of the detached window's title bar (the caption buttons take the same height on Windows).
pub const TITLE_HEIGHT: f64 = 36.0;
/// Documents handed over with a detach or an attach: plain data, bounded (JSON.stringify length, UTF-16 units).
pub const HANDOFF_MAX_CHARS: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// A rectangle in Electron DIPs (screen coordinates of `screen.getAllDisplays()` / `getNormalBounds()`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }
    pub fn right(&self) -> f64 {
        self.x + self.width
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }
    /// `{x, y, width, height}` with whole numbers written as integers (JSON.stringify).
    pub fn to_json(&self) -> Value {
        json!({ "x": js::num(self.x), "y": js::num(self.y), "width": js::num(self.width), "height": js::num(self.height) })
    }
    /// A rect of four numbers (anything else: None).
    pub fn from_json(v: &Value) -> Option<Self> {
        let n = |k: &str| v.get(k).and_then(Value::as_f64);
        Some(Self::new(n("x")?, n("y")?, n("width")?, n("height")?))
    }
    /// Every coordinate through `Math.round`.
    pub fn rounded(&self) -> Self {
        Self::new(js::round(self.x), js::round(self.y), js::round(self.width), js::round(self.height))
    }
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
    fn area(&self) -> f64 {
        self.width * self.height
    }
    /// The overlap of two rectangles (None when they do not overlap).
    pub fn intersect(&self, b: &Rect) -> Option<Rect> {
        let x = self.x.max(b.x);
        let y = self.y.max(b.y);
        let right = self.right().min(b.right());
        let bottom = self.bottom().min(b.bottom());
        (right > x && bottom > y).then(|| Rect::new(x, y, right - x, bottom - y))
    }
}

/// A display as the placement sees it: its id and work area (DIPs).
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayArea {
    pub id: f64,
    pub work_area: Rect,
}

/// Where a window opens: its bounds and the display they are on (None: no display known).
#[derive(Debug, Clone, PartialEq)]
pub struct Placement {
    pub bounds: Rect,
    pub display_id: Option<f64>,
}

impl Placement {
    pub fn to_json(&self) -> Value {
        let mut v = json!({ "bounds": self.bounds.to_json() });
        if let Some(id) = self.display_id {
            v["displayId"] = js::num(id);
        }
        v
    }
}

// ── the registry ─────────────────────────────────────────────────────────────

/// `detachedList(s)`: `s.detachedWindows ?? []`.
pub fn detached_list(s: &Value) -> &[Value] {
    s.get("detachedWindows").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
}

/// `targetKey(t)`: one key per tab, the strip key of the grid or file.
pub fn target_key(t: &Value) -> String {
    if t.get("kind").and_then(Value::as_str) == Some("grid") {
        format!("grid:{}", js::to_string(t.get("tabId")))
    } else {
        format!("file:{}", js::to_string(t.get("fileId")))
    }
}

/// `findDetached(s, id)`.
pub fn find_detached<'a>(s: &'a Value, id: &str) -> Option<&'a Value> {
    detached_list(s).iter().find(|w| w.get("id").and_then(Value::as_str) == Some(id))
}

/// `detachedByKey(s, key)`: the window that shows a strip key, if it is detached.
pub fn detached_by_key<'a>(s: &'a Value, key: &str) -> Option<&'a Value> {
    detached_list(s).iter().find(|w| w.get("target").is_some_and(|t| target_key(t) == key))
}

/// The ids of the grids that are in their own window (`detachedGridIds`).
pub fn detached_grid_ids(s: &Value) -> Vec<String> {
    detached_list(s)
        .iter()
        .filter_map(|w| {
            let t = w.get("target")?;
            (t.get("kind")?.as_str()? == "grid").then(|| js::to_string(t.get("tabId")))
        })
        .collect()
}

/// What `addDetached` answers.
#[derive(Debug, Clone, PartialEq)]
pub enum Added {
    /// The tab already has a window: that one (the state is unchanged).
    Existing(Value),
    /// The new state with the window appended.
    Added(Value),
    /// DETACHED_LIMIT windows are open already.
    Limit,
}

fn with_list(s: &Value, list: Vec<Value>) -> Value {
    let mut next = s.as_object().cloned().unwrap_or_default();
    next.insert("detachedWindows".into(), Value::Array(list));
    Value::Object(next)
}

/// `addDetached(s, w)`: the same tab twice keeps the existing window; the limit refuses.
pub fn add_detached(s: &Value, w: Value) -> Added {
    let key = w.get("target").map(target_key).unwrap_or_default();
    if let Some(existing) = detached_by_key(s, &key) {
        return Added::Existing(existing.clone());
    }
    let list = detached_list(s);
    if list.len() >= DETACHED_LIMIT {
        return Added::Limit;
    }
    let mut next = list.to_vec();
    next.push(w);
    Added::Added(with_list(s, next))
}

/// `removeDetached(s, id)`: None when there is no such window (the state stays the same object in TS).
pub fn remove_detached(s: &Value, id: &str) -> Option<Value> {
    let list = detached_list(s);
    if !list.iter().any(|w| w.get("id").and_then(Value::as_str) == Some(id)) {
        return None;
    }
    let rest: Vec<Value> = list.iter().filter(|w| w.get("id").and_then(Value::as_str) != Some(id)).cloned().collect();
    let mut next = with_list(s, rest);
    if detached_list(&next).is_empty()
        && let Some(o) = next.as_object_mut()
    {
        o.shift_remove("detachedWindows");
    }
    Some(next)
}

/// `setDetachedPlace(s, id, place)`: the window moved or was resized. None when nothing changes (unknown id, same values).
pub fn set_detached_place(s: &Value, id: &str, bounds: Option<Rect>, display_id: Option<f64>, maximized: bool) -> Option<Value> {
    let list = detached_list(s);
    let w = list.iter().find(|x| x.get("id").and_then(Value::as_str) == Some(id))?;
    let mut next: Map<String, Value> = w.as_object().cloned().unwrap_or_default();
    if let Some(b) = bounds {
        next.insert("bounds".into(), b.to_json());
    }
    if let Some(d) = display_id {
        next.insert("displayId".into(), js::num(d));
    }
    if maximized {
        next.insert("maximized".into(), Value::Bool(true));
    } else {
        next.shift_remove("maximized");
    }
    let next = Value::Object(next);
    if unimux_core::js_json::stringify(&next) == unimux_core::js_json::stringify(w) {
        return None;
    }
    let list: Vec<Value> =
        list.iter().map(|x| if x.get("id").and_then(Value::as_str) == Some(id) { next.clone() } else { x.clone() }).collect();
    Some(with_list(s, list))
}

/// `cellOwners(s)`: which detached window owns each cell of a detached grid (Map order: first insertion of each cell).
pub fn cell_owners(s: &Value) -> Vec<(String, String)> {
    let mut by_tab: Vec<(String, String)> = Vec::new();
    for w in detached_list(s) {
        let Some(t) = w.get("target") else { continue };
        if t.get("kind").and_then(Value::as_str) != Some("grid") {
            continue;
        }
        let (Some(tab), Some(id)) = (t.get("tabId").and_then(Value::as_str), w.get("id").and_then(Value::as_str)) else {
            continue;
        };
        match by_tab.iter_mut().find(|(k, _)| k == tab) {
            Some(slot) => slot.1 = id.to_string(),
            None => by_tab.push((tab.to_string(), id.to_string())),
        }
    }
    let mut owners: Vec<(String, String)> = Vec::new();
    if by_tab.is_empty() {
        return owners;
    }
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for p in s.get("projects").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        for t in p.get("tabs").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
            let Some(tab) = t.get("id").and_then(Value::as_str) else { continue };
            let Some((_, owner)) = by_tab.iter().find(|(k, _)| k == tab) else { continue };
            for c in t.get("cells").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
                let Some(cell) = c.get("id").and_then(Value::as_str) else { continue };
                match index.get(cell) {
                    Some(&i) => owners[i].1 = owner.clone(),
                    None => {
                        index.insert(cell.to_string(), owners.len());
                        owners.push((cell.to_string(), owner.clone()));
                    }
                }
            }
        }
    }
    owners
}

/// `ownsCell(owners, windowId, cellId)`: does the window (None: main) show the cell? Unknown cells belong to main.
pub fn owns_cell(owners: &[(String, String)], window: Option<&str>, cell: &str) -> bool {
    owners.iter().find(|(c, _)| c == cell).map(|(_, w)| w.as_str()) == window
}

/// `routeChanges(prev, next)`: `[cell id, new owner (None = main)]`.
pub fn route_changes(prev: &[(String, String)], next: &[(String, String)]) -> Vec<(String, Option<String>)> {
    let get = |list: &[(String, String)], id: &str| list.iter().find(|(c, _)| c == id).map(|(_, w)| w.clone());
    let mut out = Vec::new();
    for (id, owner) in next {
        if get(prev, id).as_ref() != Some(owner) {
            out.push((id.clone(), Some(owner.clone())));
        }
    }
    for (id, _) in prev {
        if get(next, id).is_none() {
            out.push((id.clone(), None));
        }
    }
    out
}

/// `detachedTitle(s, target)`: the tab's name and the app's.
pub fn detached_title(s: &Value, target: &Value) -> String {
    if target.get("kind").and_then(Value::as_str) == Some("file") {
        return format!("{} - unimux", js::to_string(target.get("name")));
    }
    let projects = s.get("projects").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let project = projects.iter().find(|p| js::strict_eq(p.get("id"), target.get("projectId")));
    let tab = project
        .and_then(|p| p.get("tabs").and_then(Value::as_array)?.iter().find(|t| js::strict_eq(t.get("id"), target.get("tabId"))));
    match (project, tab) {
        (Some(p), Some(t)) => format!("{} - {} - unimux", js::to_string(t.get("name")), js::to_string(p.get("name"))),
        _ => "unimux".into(),
    }
}

// ── where a window opens ─────────────────────────────────────────────────────

/// `clampRect(r, bounds)`: moved and shrunk until it lies inside `bounds`.
pub fn clamp_rect(r: &Rect, bounds: &Rect) -> Rect {
    let width = 1f64.max(r.width.min(bounds.width));
    let height = 1f64.max(r.height.min(bounds.height));
    let x = r.x.max(bounds.x).min(bounds.x + bounds.width - width);
    let y = r.y.max(bounds.y).min(bounds.y + bounds.height - height);
    Rect::new(x, y, width, height).rounded()
}

fn primary_of(displays: &[DisplayArea], primary_id: f64) -> Option<&DisplayArea> {
    displays.iter().find(|d| d.id == primary_id).or(displays.first())
}

/// `displayAt(displays, p, primaryId)`: the display a point lies on, else the nearest one, else the primary one.
pub fn display_at(displays: &[DisplayArea], x: f64, y: f64, primary_id: f64) -> Option<&DisplayArea> {
    if let Some(hit) = displays.iter().find(|d| d.work_area.contains(x, y)) {
        return Some(hit);
    }
    let mut best: Option<&DisplayArea> = None;
    let mut best_dist = f64::INFINITY;
    for d in displays {
        let w = &d.work_area;
        let cx = x.max(w.x).min(w.x + w.width);
        let cy = y.max(w.y).min(w.y + w.height);
        let dist = (cx - x).powi(2) + (cy - y).powi(2);
        if dist < best_dist {
            best_dist = dist;
            best = Some(d);
        }
    }
    best.or_else(|| primary_of(displays, primary_id))
}

fn centered(size: Size, on: &Rect) -> Rect {
    clamp_rect(
        &Rect::new(on.x + (on.width - size.width) / 2.0, on.y + (on.height - size.height) / 2.0, size.width, size.height),
        on,
    )
}

/// `restoreBounds(saved, displays, primaryId)`: where it was while its title bar is still visible on a display (at least
/// 100 px of it), else centered on the primary display.
pub fn restore_bounds(saved: Option<&Rect>, displays: &[DisplayArea], primary_id: f64) -> Placement {
    let primary = primary_of(displays, primary_id);
    let size = Size {
        width: MIN_SIZE.width.max(saved.map_or(DEFAULT_SIZE.width, |s| s.width)),
        height: MIN_SIZE.height.max(saved.map_or(DEFAULT_SIZE.height, |s| s.height)),
    };
    if let Some(saved) = saved {
        let title = Rect::new(saved.x, saved.y, saved.width, TITLE_HEIGHT);
        let mut best: Option<(&DisplayArea, f64)> = None;
        for d in displays {
            if let Some(hit) = title.intersect(&d.work_area)
                && hit.width >= 100f64.min(saved.width)
                && best.is_none_or(|(_, seen)| hit.area() > seen)
            {
                best = Some((d, hit.area()));
            }
        }
        if let Some((d, _)) = best {
            return Placement {
                bounds: clamp_rect(&Rect::new(saved.x, saved.y, size.width, size.height), &d.work_area),
                display_id: Some(d.id),
            };
        }
    }
    match primary {
        None => Placement { bounds: Rect::new(80.0, 80.0, size.width, size.height), display_id: None },
        Some(p) => Placement { bounds: centered(size, &p.work_area), display_id: Some(p.id) },
    }
}

/// `boundsAtPoint(point, size, displays, primaryId)`: a tab dropped outside the window; the title bar under the pointer.
pub fn bounds_at_point(x: f64, y: f64, size: Size, displays: &[DisplayArea], primary_id: f64) -> Placement {
    let want = Rect::new(x - 160f64.min(size.width / 2.0), y - TITLE_HEIGHT / 2.0, size.width, size.height);
    match display_at(displays, x, y, primary_id) {
        Some(d) => Placement { bounds: clamp_rect(&want, &d.work_area), display_id: Some(d.id) },
        None => Placement { bounds: want, display_id: None },
    }
}

/// `boundsBeside(main, size, displays, primaryId)`: "Move to a new window" from a menu: on another display when there is
/// one, centered there; otherwise beside the main window, a little down and to the right.
pub fn bounds_beside(main: Option<&Rect>, size: Size, displays: &[DisplayArea], primary_id: f64) -> Placement {
    let home = match main {
        Some(m) => display_at(displays, m.x + m.width / 2.0, m.y + m.height / 2.0, primary_id),
        None => primary_of(displays, primary_id),
    };
    let other = displays.iter().find(|d| home.is_none_or(|h| d.id != h.id));
    if let Some(o) = other {
        return Placement { bounds: centered(size, &o.work_area), display_id: Some(o.id) };
    }
    let Some(home) = home else {
        return Placement { bounds: Rect::new(80.0, 80.0, size.width, size.height), display_id: None };
    };
    let want = match main {
        Some(m) => Rect::new(m.x + 48.0, m.y + 48.0, size.width, size.height),
        None => centered(size, &home.work_area),
    };
    Placement { bounds: clamp_rect(&want, &home.work_area), display_id: Some(home.id) }
}

// ── what a moving tab takes along ────────────────────────────────────────────

fn is_text(v: Option<&Value>) -> bool {
    crate::normalize::windows::is_text(v)
}

/// `isTabHandoff(x)`.
pub fn is_tab_handoff(x: &Value) -> bool {
    x.as_object().is_some_and(|o| {
        o.get("handoff").and_then(Value::as_str) == Some("tab")
            && is_text(o.get("fileId"))
            && o.get("dbSessions").is_some_and(Value::is_array)
    })
}

/// `splitHandoffs(items)`: documents and handoffs apart (only handoffs of documents that travel too).
pub fn split_handoffs(items: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let docs: Vec<Value> = items.iter().filter(|x| !is_tab_handoff(x)).cloned().collect();
    let ids: Vec<&str> = docs.iter().filter_map(|d| d.as_object()?.get("id")?.as_str()).collect();
    let handoffs = items
        .iter()
        .filter(|x| is_tab_handoff(x))
        .filter(|h| h.get("fileId").and_then(Value::as_str).is_some_and(|f| ids.contains(&f)))
        .cloned()
        .collect();
    (docs, handoffs)
}

/// `isDbSessionId(id)`: `/^db:<uuid>$/i`.
pub fn is_db_session_id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 39 && s.is_char_boundary(3) && s[..3].eq_ignore_ascii_case("db:") && js::is_uuid(Some(&Value::from(&s[3..])))
    })
}

/// `handoffSessions(handoffs)`: valid DB session ids only, each once, at most 32.
pub fn handoff_sessions(handoffs: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for h in handoffs {
        for id in h.get("dbSessions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
            if is_db_session_id(id) {
                let s = id.as_str().unwrap_or_default().to_string();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
    out.truncate(32);
    out
}

/// `cleanDocs(raw)` (detachedWindows.ts): the documents of a detach or attach; None refuses (not a list, more than 4, over
/// 64M characters as JSON). Non-object items are dropped.
pub fn clean_docs(raw: Option<&Value>) -> Option<Vec<Value>> {
    let raw = match raw {
        None | Some(Value::Null) => return Some(Vec::new()),
        Some(v) => v,
    };
    let list = raw.as_array()?;
    if list.len() > 4 {
        return None;
    }
    if js::len16(&unimux_core::js_json::stringify(raw)) > HANDOFF_MAX_CHARS {
        return None;
    }
    Some(list.iter().filter(|x| x.is_object()).cloned().collect())
}

// ── unsaved work of a detached window ────────────────────────────────────────

fn work_count(x: Option<&Value>) -> f64 {
    match x.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= 0.0 => n.min(100_000.0),
        _ => 0.0,
    }
}

/// `hasWork(w)`.
pub fn has_work(w: &Value) -> bool {
    let n = |k: &str| w.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    n("tx") + n("staged") + n("redis") + n("files") + n("saving") > 0.0
}

/// `cleanWork(raw)`: a window's report, repaired; None when nothing is pending.
pub fn clean_work(raw: Option<&Value>) -> Option<Value> {
    let o = raw?.as_object()?;
    let mut work = json!({
        "tx": js::num(work_count(o.get("tx"))),
        "staged": js::num(work_count(o.get("staged"))),
        "redis": js::num(work_count(o.get("redis"))),
    });
    let files = work_count(o.get("files"));
    let saving = work_count(o.get("saving"));
    if files != 0.0 {
        work["files"] = js::num(files);
    }
    if saving != 0.0 {
        work["saving"] = js::num(saving);
    }
    has_work(&work).then_some(work)
}

/// `sumWork(list)`.
pub fn sum_work<'a>(list: impl IntoIterator<Item = &'a Value>) -> Value {
    // Keys in the order the TS code first sets them (`files` / `saving` only once a report has them).
    let mut out: Vec<(&str, f64)> = vec![("tx", 0.0), ("staged", 0.0), ("redis", 0.0)];
    let n = |w: &Value, k: &str| w.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    for w in list {
        for key in ["tx", "staged", "redis", "files", "saving"] {
            let v = n(w, key);
            let optional = matches!(key, "files" | "saving");
            if optional && v == 0.0 {
                continue;
            }
            match out.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 += v,
                None => out.push((key, v)),
            }
        }
    }
    Value::Object(out.into_iter().map(|(k, v)| (k.to_string(), js::num(v))).collect())
}

// ── tabs a detached window opens in the main window ──────────────────────────

const REDIS_TAB_VIEWS: [&str; 4] = ["keys", "console", "pubsub", "info"];
/// DB_LIMITS.database and DB_LIMITS.sql (shared/db.ts).
const DB_DATABASE_MAX: usize = 64;
const DB_SQL_MAX: usize = 8 * 1024 * 1024;

/// `cleanOpenInMain(raw)`: "Open in the SQL editor" of a DDL tab, the view switch of a Redis tab.
pub fn clean_open_in_main(raw: Option<&Value>) -> Option<Value> {
    let o = raw?.as_object()?;
    if !js::is_uuid(o.get("connectionId")) {
        return None;
    }
    let kind = o.get("kind").and_then(Value::as_str);
    if kind == Some("sql")
        && let (Some(Value::String(database)), Some(Value::String(text))) = (o.get("database"), o.get("text"))
        && js::len16(database) <= DB_DATABASE_MAX
        && js::len16(text) <= DB_SQL_MAX
    {
        return Some(json!({ "kind": "sql", "connectionId": o["connectionId"], "database": database, "text": text }));
    }
    if kind == Some("redis")
        && o.get("view").and_then(Value::as_str).is_some_and(|v| REDIS_TAB_VIEWS.contains(&v))
        && let Some(db) = o.get("db").and_then(Value::as_f64)
        && db.fract() == 0.0
        && (0.0..=10_000.0).contains(&db)
    {
        return Some(json!({ "kind": "redis", "connectionId": o["connectionId"], "view": o["view"], "db": js::num(db) }));
    }
    None
}

// ── wait marks (shared/waiting.ts) ───────────────────────────────────────────

const WAIT_KINDS: [&str; 9] =
    ["permission", "question", "elicitation", "input", "limit", "error", "failed", "interrupted", "done"];

/// `/^[\w.:@/-]{1,80}$/`.
fn safe_text(s: &str) -> bool {
    (1..=80).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:@/-".contains(&b))
}

/// `normalizeWaitMark(raw)`: a mark another window reported, checked field by field; None for anything malformed.
pub fn normalize_wait_mark(raw: Option<&Value>) -> Option<Value> {
    let o = raw?.as_object()?;
    let kind = o.get("kind").and_then(Value::as_str).filter(|k| WAIT_KINDS.contains(k))?;
    let since = o.get("since").and_then(Value::as_f64).filter(|s| s.is_finite() && *s > 0.0)?;
    let mut mark = json!({ "kind": kind, "since": js::num(since) });
    if let Some(tool) = o.get("tool").and_then(Value::as_str).filter(|t| safe_text(t)) {
        mark["tool"] = json!(tool);
    }
    if let Some(error) = o.get("error").and_then(Value::as_str).filter(|t| safe_text(t)) {
        mark["error"] = json!(error);
    }
    if let Some(code) = o.get("code").and_then(Value::as_f64).filter(|c| c.fract() == 0.0 && c.abs() <= 9_007_199_254_740_991.0) {
        mark["code"] = js::num(code);
    }
    if let Some(seen) = o.get("seenAt").and_then(Value::as_f64).filter(|s| s.is_finite()) {
        mark["seenAt"] = js::num(seen);
    }
    Some(mark)
}

#[cfg(test)]
mod tests {
    //! The cases of test/detached-windows.test.ts and test/detached-tabs.test.ts that test this pure part.
    use super::*;
    use crate::normalize::windows::{normalize_detached_windows, open_grids};

    /// `twoGrids()` of the TS test: project P with "Grid 1" (2 cells) and "Grid 5" (1 cell).
    fn two_grids() -> (Value, &'static str, &'static str, &'static str) {
        let s = json!({
            "version": 1,
            "projects": [{
                "id": "p1", "name": "P", "path": "C:\\p", "activeTabId": "ta",
                "tabs": [
                    { "id": "ta", "name": "Grid 1", "cells": [{ "id": "c1" }, { "id": "c2" }] },
                    { "id": "tb", "name": "Grid 5", "cells": [{ "id": "c3" }] }
                ]
            }],
            "activeProjectId": "p1"
        });
        (s, "p1", "ta", "tb")
    }

    fn grid_window(id: &str, project: &str, tab: &str) -> Value {
        json!({ "id": id, "target": { "kind": "grid", "projectId": project, "tabId": tab } })
    }

    fn with_windows(s: &Value, list: Vec<Value>) -> Value {
        with_list(s, list)
    }

    #[test]
    fn keeps_valid_entries_one_per_tab_of_open_grids_only_and_repairs_a_grid_that_moved_project() {
        let (s, p, a, b) = two_grids();
        let grids = open_grids(s["projects"].as_array().unwrap());
        let mut w1 = grid_window("w1", p, a);
        w1["bounds"] = json!({ "x": 10.4, "y": 20, "width": 800, "height": 600 });
        w1["displayId"] = json!(2);
        w1["maximized"] = json!(true);
        let raw = json!([
            w1,
            grid_window("w1", p, b),
            grid_window("w2", p, a),
            grid_window("w3", "other-project", b),
            grid_window("w4", p, "closed-grid"),
            { "id": "w5", "target": { "kind": "file", "fileId": "f", "projectId": p, "name": "a.ts", "reopen": { "kind": "project", "projectId": p, "relativePath": "src/a.ts" } } },
            { "id": "w6", "target": { "kind": "file", "fileId": "g", "projectId": "", "name": "x", "reopen": { "kind": "nope" } } },
            { "id": "w7", "target": { "kind": "grid" } }, "junk", null
        ]);
        let out = normalize_detached_windows(Some(&raw), &grids).unwrap();
        let ids: Vec<&str> = out.as_array().unwrap().iter().map(|w| w["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["w1", "w3", "w5"]);
        assert_eq!(
            out[0],
            json!({ "id": "w1", "target": { "kind": "grid", "projectId": p, "tabId": a }, "bounds": { "x": 10, "y": 20, "width": 800, "height": 600 }, "displayId": 2, "maximized": true })
        );
        assert_eq!(out[1]["target"], json!({ "kind": "grid", "projectId": p, "tabId": b }));
        assert_eq!(normalize_detached_windows(Some(&json!([])), &grids), None);
        assert_eq!(normalize_detached_windows(Some(&json!("x")), &grids), None);
    }

    #[test]
    fn adds_one_window_per_tab_a_limit_moves_and_removes_entries() {
        let (s, p, a, b) = two_grids();
        let Added::Added(one) = add_detached(&s, grid_window("w1", p, a)) else { panic!("not added") };
        assert_eq!(detached_list(&one)[0]["id"], "w1");
        assert_eq!(add_detached(&one, grid_window("w2", p, a)), Added::Existing(grid_window("w1", p, a)));
        let mut full = detached_list(&one).to_vec();
        for i in 1..DETACHED_LIMIT {
            full.push(grid_window(&format!("x{i}"), p, &format!("t{i}")));
        }
        let full = with_windows(&one, full);
        assert_eq!(add_detached(&full, grid_window("w9", p, b)), Added::Limit);
        let placed = set_detached_place(&one, "w1", Some(Rect::new(5.0, 6.0, 700.0, 500.0)), Some(3.0), false).unwrap();
        assert_eq!(
            detached_list(&placed)[0],
            json!({ "id": "w1", "target": { "kind": "grid", "projectId": p, "tabId": a }, "bounds": { "x": 5, "y": 6, "width": 700, "height": 500 }, "displayId": 3 })
        );
        assert_eq!(set_detached_place(&placed, "w1", Some(Rect::new(5.0, 6.0, 700.0, 500.0)), Some(3.0), false), None);
        let removed = remove_detached(&placed, "w1").unwrap();
        assert!(removed.get("detachedWindows").is_none());
        assert_eq!(remove_detached(&placed, "nope"), None);
        // The registry key keeps its place in the state (a spread keeps the key order).
        let keys: Vec<&String> = placed.as_object().unwrap().keys().collect();
        assert_eq!(keys.last().unwrap().as_str(), "detachedWindows");
    }

    #[test]
    fn knows_which_window_owns_each_cell_and_what_moves_between_two_states() {
        let (s, p, a, b) = two_grids();
        let detached = with_windows(&s, vec![grid_window("w1", p, b)]);
        let owners = cell_owners(&detached);
        assert_eq!(owners, vec![("c3".to_string(), "w1".to_string())]);
        assert!(owns_cell(&owners, None, "c1"));
        assert!(!owns_cell(&owners, Some("w1"), "c1"));
        assert!(owns_cell(&owners, Some("w1"), "c3"));
        assert!(!owns_cell(&owners, None, "c3"));
        assert!(owns_cell(&owners, None, "install:x"));
        assert_eq!(detached_grid_ids(&detached), vec![b.to_string()]);
        let swapped = cell_owners(&with_windows(&s, vec![grid_window("w2", p, a)]));
        let mut changes = route_changes(&owners, &swapped);
        changes.sort();
        assert_eq!(changes, vec![("c1".into(), Some("w2".into())), ("c2".into(), Some("w2".into())), ("c3".into(), None)]);
        assert!(route_changes(&owners, &owners).is_empty());
    }

    #[test]
    fn titles() {
        let (s, p, a, _) = two_grids();
        assert_eq!(detached_title(&s, &json!({ "kind": "grid", "projectId": p, "tabId": a })), "Grid 1 - P - unimux");
        assert_eq!(detached_title(&s, &json!({ "kind": "grid", "projectId": p, "tabId": "gone" })), "unimux");
        assert_eq!(detached_title(&s, &json!({ "kind": "file", "fileId": "f", "name": "a.ts" })), "a.ts - unimux");
    }

    const PRIMARY: DisplayArea = DisplayArea { id: 1.0, work_area: Rect::new(0.0, 0.0, 1920.0, 1040.0) };
    const SECOND: DisplayArea = DisplayArea { id: 2.0, work_area: Rect::new(1920.0, 0.0, 2560.0, 1400.0) };

    #[test]
    fn clamps_into_an_area_and_finds_the_display_of_a_point() {
        let both = [PRIMARY, SECOND];
        assert_eq!(clamp_rect(&Rect::new(1800.0, -50.0, 400.0, 300.0), &PRIMARY.work_area), Rect::new(1520.0, 0.0, 400.0, 300.0));
        assert_eq!(clamp_rect(&Rect::new(0.0, 0.0, 4000.0, 3000.0), &PRIMARY.work_area), Rect::new(0.0, 0.0, 1920.0, 1040.0));
        assert_eq!(display_at(&both, 2000.0, 10.0, 1.0).unwrap().id, 2.0);
        assert_eq!(display_at(&both, 9000.0, 10.0, 1.0).unwrap().id, 2.0);
        assert_eq!(display_at(&both, -50.0, 10.0, 1.0).unwrap().id, 1.0);
    }

    #[test]
    fn reopens_where_it_was_while_its_title_bar_is_on_a_display_else_centered_on_the_primary_display() {
        let saved = Rect::new(2100.0, 100.0, 1200.0, 800.0);
        assert_eq!(restore_bounds(Some(&saved), &[PRIMARY, SECOND], 1.0), Placement { bounds: saved, display_id: Some(2.0) });
        let back = restore_bounds(Some(&saved), &[PRIMARY], 1.0);
        assert_eq!(back, Placement { bounds: Rect::new(360.0, 120.0, 1200.0, 800.0), display_id: Some(1.0) });
        assert_eq!(restore_bounds(Some(&Rect::new(1900.0, 100.0, 600.0, 400.0)), &[PRIMARY], 1.0).bounds.x, 660.0);
        assert_eq!(restore_bounds(None, &[PRIMARY], 1.0).bounds, Rect::new(460.0, 170.0, 1000.0, 700.0));
        let tiny = restore_bounds(Some(&Rect::new(10.0, 10.0, 100.0, 50.0)), &[PRIMARY], 1.0).bounds;
        assert_eq!((tiny.width, tiny.height), (480.0, 320.0));
    }

    #[test]
    fn a_drop_puts_the_title_bar_under_the_pointer_clamped_to_that_display() {
        let both = [PRIMARY, SECOND];
        assert_eq!(
            bounds_at_point(2500.0, 300.0, DEFAULT_SIZE, &both, 1.0),
            Placement { bounds: Rect::new(2340.0, 282.0, 1000.0, 700.0), display_id: Some(2.0) }
        );
        assert_eq!(bounds_at_point(1910.0, 1030.0, DEFAULT_SIZE, &both, 1.0).bounds, Rect::new(920.0, 340.0, 1000.0, 700.0));
    }

    #[test]
    fn the_menu_opens_it_on_the_other_display_or_beside_the_main_window_when_there_is_one_display() {
        let both = [PRIMARY, SECOND];
        let main = Rect::new(100.0, 50.0, 1600.0, 950.0);
        assert_eq!(
            bounds_beside(Some(&main), DEFAULT_SIZE, &both, 1.0),
            Placement { bounds: Rect::new(2700.0, 350.0, 1000.0, 700.0), display_id: Some(2.0) }
        );
        assert_eq!(bounds_beside(Some(&Rect { x: 2000.0, ..main }), DEFAULT_SIZE, &both, 1.0).display_id, Some(1.0));
        assert_eq!(
            bounds_beside(Some(&main), DEFAULT_SIZE, &[PRIMARY], 1.0),
            Placement { bounds: Rect::new(148.0, 98.0, 1000.0, 700.0), display_id: Some(1.0) }
        );
    }

    const CONN: &str = "00000000-0000-4000-8000-0000000000c1";
    const S1: &str = "db:00000000-0000-4000-8000-0000000000e1";
    const S2: &str = "db:00000000-0000-4000-8000-0000000000e2";

    #[test]
    fn tells_documents_and_handoffs_apart_and_takes_only_valid_sessions_of_documents_that_travel() {
        let doc = json!({ "id": "f1", "text": "" });
        let handoff = json!({ "handoff": "tab", "fileId": "f1", "dbSessions": [S1, "junk", S1, 42] });
        let stray = json!({ "handoff": "tab", "fileId": "other", "dbSessions": [S2] });
        let (docs, handoffs) = split_handoffs(&[doc.clone(), handoff.clone(), stray, json!("x")]);
        assert_eq!(docs, vec![doc, json!("x")]);
        assert_eq!(handoffs, vec![handoff]);
        assert_eq!(handoff_sessions(&handoffs), vec![S1.to_string()]);
        assert!(handoff_sessions(&[]).is_empty());
    }

    #[test]
    fn repairs_and_sums_the_work_reports_of_detached_windows() {
        assert_eq!(
            clean_work(Some(&json!({ "tx": 1, "staged": 2, "redis": 0 }))),
            Some(json!({ "tx": 1, "staged": 2, "redis": 0 }))
        );
        assert_eq!(clean_work(Some(&json!({ "tx": 0, "staged": 0, "redis": 0 }))), None);
        assert_eq!(clean_work(Some(&json!({ "tx": -1, "staged": 1.5, "redis": "3" }))), None);
        assert_eq!(clean_work(Some(&Value::Null)), None);
        assert_eq!(clean_work(Some(&json!({ "tx": 1e9 }))), Some(json!({ "tx": 100_000, "staged": 0, "redis": 0 })));
        let a = json!({ "tx": 1, "staged": 0, "redis": 2 });
        let b = json!({ "tx": 0, "staged": 3, "redis": 1 });
        let sum = sum_work([&a, &b]);
        assert_eq!(sum, json!({ "tx": 1, "staged": 3, "redis": 3 }));
        assert!(has_work(&sum));
        assert!(!has_work(&sum_work([])));
    }

    #[test]
    fn accepts_only_well_formed_tabs_to_open_in_the_main_window() {
        let sql = json!({ "kind": "sql", "connectionId": CONN, "database": "shop", "text": "select 1" });
        assert_eq!(clean_open_in_main(Some(&sql)), Some(sql.clone()));
        let redis = json!({ "kind": "redis", "connectionId": CONN, "view": "pubsub", "db": 0 });
        assert_eq!(clean_open_in_main(Some(&redis)), Some(redis));
        assert_eq!(clean_open_in_main(Some(&json!({ "kind": "redis", "connectionId": CONN, "view": "pubsub", "db": -1 }))), None);
        assert_eq!(clean_open_in_main(Some(&json!({ "kind": "redis", "connectionId": CONN, "view": "shell", "db": 0 }))), None);
        assert_eq!(
            clean_open_in_main(Some(&json!({ "kind": "sql", "connectionId": "x", "database": "shop", "text": "" }))),
            None
        );
        assert_eq!(clean_open_in_main(Some(&json!({ "kind": "file", "connectionId": CONN }))), None);
    }

    #[test]
    fn clean_docs_bounds_the_hand_over() {
        assert_eq!(clean_docs(None), Some(vec![]));
        assert_eq!(clean_docs(Some(&Value::Null)), Some(vec![]));
        assert_eq!(clean_docs(Some(&json!({}))), None);
        assert_eq!(clean_docs(Some(&json!([1, 2, 3, 4, 5]))), None);
        assert_eq!(clean_docs(Some(&json!([{ "id": "a" }, [1], "x", null]))), Some(vec![json!({ "id": "a" })]));
        let big = "x".repeat(HANDOFF_MAX_CHARS);
        assert_eq!(clean_docs(Some(&json!([{ "text": big }]))), None);
    }

    #[test]
    fn wait_marks_are_checked_field_by_field() {
        assert_eq!(
            normalize_wait_mark(Some(&json!({ "kind": "permission", "since": 5, "tool": "Bash", "seenAt": 7, "x": 1 }))),
            Some(json!({ "kind": "permission", "since": 5, "tool": "Bash", "seenAt": 7 }))
        );
        assert_eq!(normalize_wait_mark(Some(&json!({ "kind": "nope", "since": 5 }))), None);
        assert_eq!(normalize_wait_mark(Some(&json!({ "kind": "done", "since": 0 }))), None);
        assert_eq!(
            normalize_wait_mark(Some(&json!({ "kind": "failed", "since": 1, "code": 1.5, "tool": "a b" }))),
            Some(json!({ "kind": "failed", "since": 1 }))
        );
    }
}
