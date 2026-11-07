//! The pure matching of src/shared/convSearch.ts: query terms, per-conversation matches with snippets, and searchDocs. Every
//! offset (message starts, marks) is in UTF-16 code units, as the renderer reads them.

use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use unimux_state::normalize::timsort;

use super::text::{self, Needle, U16s, fold, fold_str, index_of_unit, js_less, last_index_of_unit, lossy, utf16};
use super::{ConvCli, ConvRole, num};

/// Separator between the messages of a document (never typed by anyone, so no term matches across two messages).
pub const MESSAGE_SEP: u16 = 0;

/// One indexed transcript. `text` holds every message joined with MESSAGE_SEP; `folded` is the same text folded.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConvDoc {
    pub cli: ConvCli,
    pub id: String,
    pub cwd: String,
    /// The /rename title, a generated one, or the first prompt (clipped).
    pub title: String,
    pub started_at: f64,
    pub updated_at: f64,
    pub model: Option<String>,
    pub file: String,
    pub text: U16s,
    pub folded: U16s,
    /// Start of each message in `text`.
    pub starts: Vec<u32>,
    /// b'u' or b'a' per message.
    pub roles: Vec<u8>,
    /// Time of each message (0 when the line had none).
    pub times: Vec<f64>,
    /// The text reached the per-conversation cap: later messages are not indexed.
    pub capped: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConvQuery {
    pub text: String,
    /// "claude", "codex" or "all".
    pub cli: Option<String>,
    /// A normalized cwd (see normalize_folder): only conversations held in this folder.
    pub project: Option<String>,
    /// "user", "assistant" or "all".
    pub role: Option<String>,
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub limit: Option<f64>,
}

impl ConvQuery {
    /// A query given as JSON with the TS field names (only fields of the right type are read; no clamping).
    pub fn from_json(v: &Value) -> Self {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let n = |k: &str| v.get(k).and_then(Value::as_f64);
        Self {
            text: s("text").unwrap_or_default(),
            cli: s("cli"),
            project: s("project"),
            role: s("role"),
            from: n("from"),
            to: n("to"),
            limit: n("limit"),
        }
    }
}

/// A folder as the filter compares it: forward slashes, no trailing slash, lower case (`normalizeFolder`).
pub fn normalize_folder(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    text::to_lower_str(slashed.trim_end_matches('/'))
}

pub const MAX_TERMS: usize = 8;

/// Words and "quoted phrases" of a query, folded; duplicates and terms inside a longer one dropped (`parseTerms`).
pub fn parse_terms(query: &str) -> Vec<U16s> {
    let q = utf16(query);
    let mut out: Vec<U16s> = Vec::new();
    let mut i = 0;
    // /"([^"]*)"?|(\S+)/g
    while i < q.len() {
        let raw: &[u16];
        if q[i] == u16::from(b'"') {
            let start = i + 1;
            let end = q[start..].iter().position(|&u| u == u16::from(b'"')).map_or(q.len(), |p| start + p);
            raw = &q[start..end];
            i = if end < q.len() { end + 1 } else { end };
        } else if text::is_space16(q[i]) {
            i += 1;
            continue;
        } else {
            let start = i;
            while i < q.len() && !text::is_space16(q[i]) {
                i += 1;
            }
            raw = &q[start..i];
        }
        let collapsed = text::collapse_space(&lossy_keep(raw));
        let term = fold_str(text::trim(&collapsed));
        if !term.is_empty() {
            out.push(term);
        }
    }
    let mut unique: Vec<U16s> = Vec::new();
    for t in out {
        if !unique.contains(&t) {
            unique.push(t);
        }
    }
    let kept: Vec<U16s> = unique.iter().filter(|t| !unique.iter().any(|o| o != *t && text::contains(o, t))).cloned().collect();
    kept.into_iter().take(MAX_TERMS).collect()
}

/// Query text back to a Rust string (it came from one, so it holds no lone surrogate).
fn lossy_keep(units: &[u16]) -> String {
    lossy(units)
}

/// Index of the message holding text offset `pos` (binary search over the starts).
pub fn message_at(starts: &[u32], pos: usize) -> usize {
    if starts.is_empty() {
        return 0;
    }
    let (mut lo, mut hi) = (0usize, starts.len() - 1);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if starts[mid] as usize <= pos {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

fn message_end(doc: &ConvDoc, i: usize) -> usize {
    if i + 1 < doc.starts.len() { doc.starts[i + 1] as usize - 1 } else { doc.text.len() }
}

/// Occurrences counted per term at most (a term found in every line of a huge log must not slow the search down).
const MAX_OCCURRENCES: usize = 400;
const SNIPPETS: usize = 3;
const SNIPPET_BEFORE: usize = 70;
const SNIPPET_AFTER: usize = 170;

fn ranges_in(folded: &[u16], terms: &[Needle], from: usize, to: usize) -> Vec<(usize, usize)> {
    let mut marks = Vec::new();
    for t in terms {
        let mut p = t.find(folded, from);
        while let Some(at) = p {
            if at + t.len() > to {
                break;
            }
            marks.push((at - from, at - from + t.len()));
            p = t.find(folded, at + t.len());
        }
    }
    marks.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    // Overlapping marks merged.
    let mut out: Vec<(usize, usize)> = Vec::new();
    for r in marks {
        match out.last_mut() {
            Some(last) if r.0 <= last.1 => last.1 = last.1.max(r.1),
            _ => out.push(r),
        }
    }
    out
}

/// Highlighted ranges of every term in `text` (the transcript preview), at most `max` (`markText`).
pub fn mark_text(text: &[u16], terms: &[Needle], max: usize) -> Vec<(usize, usize)> {
    if terms.is_empty() || text.is_empty() {
        return vec![];
    }
    let mut r = ranges_in(&fold(text), terms, 0, text.len());
    r.truncate(max);
    r
}

#[derive(Debug, Clone, PartialEq)]
pub struct Snippet {
    pub index: usize,
    pub role: ConvRole,
    pub ts: f64,
    pub text: String,
    pub marks: Vec<(usize, usize)>,
    pub before: bool,
    pub after: bool,
}

impl Snippet {
    pub fn to_json(&self) -> Value {
        json!({
            "index": self.index,
            "role": self.role.as_str(),
            "ts": num(self.ts),
            "text": self.text,
            "marks": marks_json(&self.marks),
            "before": self.before,
            "after": self.after,
        })
    }
}

fn marks_json(marks: &[(usize, usize)]) -> Value {
    Value::Array(marks.iter().map(|(a, b)| json!([a, b])).collect())
}

/// The part of a message around offset `at` (absolute in doc.text), cut at whitespace, with every term marked.
pub fn snippet_of(doc: &ConvDoc, index: usize, at: usize, terms: &[Needle]) -> Snippet {
    let start = doc.starts[index] as usize;
    let end = message_end(doc, index);
    let mut from = start.max(at.saturating_sub(SNIPPET_BEFORE));
    let mut to = end.min(at + SNIPPET_AFTER);
    if from > start
        && let Some(ws) = index_of_unit(&doc.text, 0x20, from)
        && ws < at
    {
        from = ws + 1;
    }
    if to < end
        && let Some(ws) = last_index_of_unit(&doc.text, 0x20, to)
        && ws > at
    {
        to = ws;
    }
    let raw = &doc.text[from.min(to)..to];
    let marks = ranges_in(&doc.folded, terms, from, to);
    // Whitespace runs collapse to one space: marks are mapped through the same walk.
    let mut out: U16s = Vec::with_capacity(raw.len());
    let mut map = vec![0usize; raw.len() + 1];
    let mut space = false;
    for (i, &c) in raw.iter().enumerate() {
        map[i] = out.len();
        if c == 0x20 || c == 0x0a || c == 0x09 || c == 0x0d {
            if !space {
                out.push(0x20);
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    map[raw.len()] = out.len();
    let at_map = |i: usize| map.get(i).copied().unwrap_or(out.len());
    Snippet {
        index,
        role: if doc.roles.get(index) == Some(&b'a') { ConvRole::Assistant } else { ConvRole::User },
        ts: doc.times.get(index).copied().unwrap_or(0.0),
        text: lossy(&out),
        marks: marks.iter().map(|&(a, b)| (at_map(a), at_map(b))).filter(|(a, b)| b > a).collect(),
        before: from > start,
        after: to < end,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocMatch {
    pub hits: usize,
    pub snippets: Vec<Snippet>,
    pub title_marks: Vec<(usize, usize)>,
}

/// Does the conversation hold every term (in its title or messages of the wanted role), and where (`matchDoc`).
pub fn match_doc(doc: &ConvDoc, terms: &[Needle], role: Option<ConvRole>) -> Option<DocMatch> {
    let title_folded = fold_str(&doc.title);
    let title_marks = ranges_in(&title_folded, terms, 0, title_folded.len());
    let wanted = role.map(|r| if r == ConvRole::User { b'u' } else { b'a' });
    // Per message: which terms it holds and the first offset of one.
    let mut found: IndexMap<usize, (u32, usize)> = IndexMap::new();
    for (ti, t) in terms.iter().enumerate() {
        let mut p = t.find(&doc.folded, 0);
        let mut seen = 0;
        let mut any = false;
        while let Some(at) = p {
            if seen >= MAX_OCCURRENCES {
                break;
            }
            let i = message_at(&doc.starts, at);
            if wanted.is_none() || doc.roles.get(i).copied() == wanted {
                any = true;
                found.entry(i).and_modify(|f| f.0 |= 1 << ti).or_insert((1 << ti, at));
            }
            seen += 1;
            // The rest of this message holds nothing new for this term.
            p = t.find(&doc.folded, (at + t.len()).max(message_end(doc, i)));
        }
        if !any && !t.found_in(&title_folded) {
            return None;
        }
    }
    let mut best: Vec<(usize, (u32, usize))> = found.iter().map(|(k, v)| (*k, *v)).collect();
    best.sort_by(|a, b| b.1.0.count_ones().cmp(&a.1.0.count_ones()).then(a.0.cmp(&b.0)));
    best.truncate(SNIPPETS);
    best.sort_by_key(|b| b.0);
    Some(DocMatch {
        hits: found.len(),
        title_marks,
        snippets: best.iter().map(|(i, f)| snippet_of(doc, *i, f.1, terms)).collect(),
    })
}

pub const DEFAULT_LIMIT: usize = 120;

/// What searchDocs answers (the indexer adds `indexing` and `tookMs`).
pub struct SearchOut {
    pub hits: Vec<Value>,
    pub total: usize,
    pub conversations: usize,
    pub projects: Vec<Value>,
}

impl SearchOut {
    pub fn into_map(self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("hits".into(), Value::Array(self.hits));
        m.insert("total".into(), json!(self.total));
        m.insert("conversations".into(), json!(self.conversations));
        m.insert("projects".into(), Value::Array(self.projects));
        m
    }
}

#[derive(Clone)]
struct Project {
    cwd: String,
    key: String,
    count: usize,
    updated_at: f64,
}

/// Runs a query over the documents: matching conversations newest first, the project list, and how many matched.
/// Folded text (code units) over which a search matches the documents in parallel.
const PARALLEL_UNITS: usize = 1 << 20;

pub fn search_docs<'a>(docs: impl IntoIterator<Item = &'a ConvDoc>, query: &ConvQuery) -> SearchOut {
    search_docs_with(docs, query, PARALLEL_UNITS)
}

/// `search_docs` that matches in parallel from `parallel_units` of folded text on (the tests compare both ways).
pub fn search_docs_with<'a>(docs: impl IntoIterator<Item = &'a ConvDoc>, query: &ConvQuery, parallel_units: usize) -> SearchOut {
    let terms: Vec<Needle> = parse_terms(&query.text).into_iter().map(Needle::new).collect();
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT as f64);
    let role = match query.role.as_deref() {
        Some("user") => Some(ConvRole::User),
        // matchDoc: 'all' (or none) is every role, 'user' the user's, anything else the agent's.
        None | Some("all") => None,
        Some(_) => Some(ConvRole::Assistant),
    };
    let mut projects: IndexMap<String, Project> = IndexMap::new();
    let mut matched: Vec<(&ConvDoc, Option<DocMatch>)> = Vec::new();
    let mut candidates: Vec<&ConvDoc> = Vec::new();
    let mut conversations = 0;
    for doc in docs {
        conversations += 1;
        let key = normalize_folder(&doc.cwd);
        match projects.get_mut(&key) {
            Some(p) => {
                p.count += 1;
                if doc.updated_at > p.updated_at {
                    p.updated_at = doc.updated_at;
                    p.cwd = doc.cwd.clone();
                }
            }
            None => {
                projects.insert(
                    key.clone(),
                    Project { cwd: doc.cwd.clone(), key: key.clone(), count: 1, updated_at: doc.updated_at },
                );
            }
        }
        if let Some(cli) = query.cli.as_deref().filter(|c| !c.is_empty() && *c != "all")
            && doc.cli.as_str() != cli
        {
            continue;
        }
        if let Some(project) = query.project.as_deref().filter(|p| !p.is_empty())
            && key != project
        {
            continue;
        }
        if query.from.is_some_and(|from| doc.updated_at < from) {
            continue;
        }
        if query.to.is_some_and(|to| doc.started_at > to) {
            continue;
        }
        if terms.is_empty() {
            matched.push((doc, None));
            continue;
        }
        candidates.push(doc);
    }
    // The documents are matched on the pass workers when there is much text (a big index), in place otherwise; the
    // matches keep the order of the documents either way.
    let units: usize = candidates.iter().map(|d| d.folded.len()).sum();
    let found: Vec<Option<DocMatch>> = if units >= parallel_units && candidates.len() > 1 {
        super::indexer::pool(super::indexer::workers(), &candidates, 8, |d| match_doc(d, &terms, role))
    } else {
        candidates.iter().map(|d| match_doc(d, &terms, role)).collect()
    };
    for (doc, m) in candidates.into_iter().zip(found) {
        if let Some(m) = m {
            matched.push((doc, Some(m)));
        }
    }
    let mut order: Vec<usize> = (0..matched.len()).collect();
    timsort::sort_by(&mut order, |&a, &b| {
        let (da, db) = (matched[a].0, matched[b].0);
        let d = db.updated_at - da.updated_at;
        if d != 0.0 && !d.is_nan() {
            d
        } else if js_less(&da.id, &db.id) {
            -1.0
        } else {
            1.0
        }
    });
    // matched.slice(0, limit): ToIntegerOrInfinity, a negative end counts from the back.
    let take = if limit.is_nan() {
        0
    } else if limit < 0.0 {
        (matched.len() as f64 + limit.trunc()).max(0.0) as usize
    } else {
        limit.trunc().min(matched.len() as f64) as usize
    };
    let hits = order
        .iter()
        .take(take)
        .map(|&i| {
            let (doc, m) = &matched[i];
            let mut h = Map::new();
            h.insert("cli".into(), json!(doc.cli.as_str()));
            h.insert("id".into(), json!(doc.id));
            h.insert("cwd".into(), json!(doc.cwd));
            h.insert("title".into(), json!(doc.title));
            h.insert("titleMarks".into(), m.as_ref().map_or(json!([]), |m| marks_json(&m.title_marks)));
            h.insert("startedAt".into(), num(doc.started_at));
            h.insert("updatedAt".into(), num(doc.updated_at));
            if let Some(model) = doc.model.as_deref().filter(|m| !m.is_empty()) {
                h.insert("model".into(), json!(model));
            }
            h.insert("file".into(), json!(doc.file));
            h.insert("messages".into(), json!(doc.starts.len()));
            h.insert("hits".into(), json!(m.as_ref().map_or(0, |m| m.hits)));
            h.insert(
                "snippets".into(),
                Value::Array(m.as_ref().map_or(vec![], |m| m.snippets.iter().map(Snippet::to_json).collect())),
            );
            Value::Object(h)
        })
        .collect();
    let mut list: Vec<Project> = projects.into_values().collect();
    timsort::sort_by(&mut list, |a, b| b.updated_at - a.updated_at);
    SearchOut {
        hits,
        total: matched.len(),
        conversations,
        projects: list
            .into_iter()
            .map(|p| json!({"cwd": p.cwd, "key": p.key, "count": p.count, "updatedAt": num(p.updated_at)}))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc_of(messages: &[(&str, &str)]) -> ConvDoc {
        let mut starts = vec![];
        let mut text: U16s = vec![];
        for (i, (_, t)) in messages.iter().enumerate() {
            if i > 0 {
                text.push(MESSAGE_SEP);
            }
            starts.push(text.len() as u32);
            text.extend(utf16(t));
        }
        ConvDoc {
            cli: ConvCli::Claude,
            id: "x".into(),
            cwd: "D:\\p".into(),
            title: "T".into(),
            started_at: 1.0,
            updated_at: 2.0,
            file: "f".into(),
            folded: fold(&text),
            text,
            starts,
            roles: messages.iter().map(|m| m.0.as_bytes()[0]).collect(),
            times: messages.iter().map(|_| 0.0).collect(),
            ..Default::default()
        }
    }

    fn terms(ts: &[&str]) -> Vec<Needle> {
        ts.iter().map(|t| Needle::new(utf16(t))).collect()
    }

    fn mark(s: &Snippet, i: usize) -> String {
        lossy(&utf16(&s.text)[s.marks[i].0..s.marks[i].1])
    }

    // conv-search.test.ts: "splits words and quoted phrases and drops terms another one contains"
    #[test]
    fn splits_words_and_quoted_phrases_and_drops_terms_another_one_contains() {
        let t = |q: &str| parse_terms(q).iter().map(|t| lossy(t)).collect::<Vec<_>>();
        assert_eq!(t("Atomic  \"write file\"  atom"), vec!["atomic", "write file"]);
        assert_eq!(t("\"unterminated phrase"), vec!["unterminated phrase"]);
        assert!(t("   ").is_empty());
        assert_eq!(t("a b c d e f g h i j").len(), 8);
    }

    // conv-search.test.ts: "finds the message of an offset"
    #[test]
    fn finds_the_message_of_an_offset() {
        assert_eq!(message_at(&[0, 5, 9], 0), 0);
        assert_eq!(message_at(&[0, 5, 9], 5), 1);
        assert_eq!(message_at(&[0, 5, 9], 8), 1);
        assert_eq!(message_at(&[0, 5, 9], 100), 2);
    }

    fn sample() -> ConvDoc {
        doc_of(&[
            ("u", "Napraw zapis stanu: plik state.json gubi zakładki"),
            ("a", "Sprawdzę funkcję atomicWrite."),
            ("u", "Teraz dodaj test regresji dla zapisu."),
        ])
    }

    // conv-search.test.ts: "needs every term somewhere in the conversation"
    #[test]
    fn needs_every_term_somewhere_in_the_conversation() {
        let doc = sample();
        assert!(match_doc(&doc, &terms(&["zakladki", "atomicwrite"]), None).is_some());
        assert!(match_doc(&doc, &terms(&["zakladki", "nieistniejace"]), None).is_none());
    }

    // conv-search.test.ts: "marks the terms in snippets with offsets of the snippet text"
    #[test]
    fn marks_the_terms_in_snippets_with_offsets_of_the_snippet_text() {
        let m = match_doc(&sample(), &terms(&["zapis"]), None).unwrap();
        assert_eq!(m.hits, 2);
        let first = &m.snippets[0];
        assert_eq!(first.index, 0);
        assert_eq!(first.role, ConvRole::User);
        assert_eq!(mark(first, 0), "zapis");
        let third = m.snippets.iter().find(|s| s.index == 2).unwrap();
        assert_eq!(mark(third, 0), "zapis");
    }

    // conv-search.test.ts: "marks folded matches on the original text"
    #[test]
    fn marks_folded_matches_on_the_original_text() {
        let m = match_doc(&sample(), &terms(&["zakladki"]), None).unwrap();
        assert_eq!(mark(&m.snippets[0], 0), "zakładki");
    }

    // conv-search.test.ts: "filters by role"
    #[test]
    fn filters_by_role() {
        let doc = sample();
        assert!(match_doc(&doc, &terms(&["atomicwrite"]), Some(ConvRole::User)).is_none());
        assert_eq!(match_doc(&doc, &terms(&["atomicwrite"]), Some(ConvRole::Assistant)).unwrap().snippets[0].index, 1);
    }

    // conv-search.test.ts: "cuts long messages around the hit and collapses whitespace"
    #[test]
    fn cuts_long_messages_around_the_hit_and_collapses_whitespace() {
        let text = format!("{}\n\n  NEEDLE   here {}", "lorem ipsum ".repeat(40), "dolor sit ".repeat(60));
        let long = doc_of(&[("a", &text)]);
        let s = &match_doc(&long, &terms(&["needle"]), None).unwrap().snippets[0];
        assert!(s.before);
        assert!(s.after);
        assert!(text::len16(&s.text) < 260);
        assert!(s.text.contains("NEEDLE here"));
        assert_eq!(mark(s, 0), "NEEDLE");
    }

    // conv-search.test.ts: "matches a title term and lists newest first with filters"
    #[test]
    fn matches_a_title_term_and_lists_newest_first_with_filters() {
        let mut a = doc_of(&[("u", "one")]);
        (a.id, a.title, a.updated_at, a.cwd) = ("a".into(), "Redis pool".into(), 10.0, "D:\\A".into());
        let mut b = doc_of(&[("u", "redis two")]);
        (b.id, b.updated_at, b.cli, b.cwd) = ("b".into(), 20.0, ConvCli::Codex, "d:/a/".into());
        let mut c = doc_of(&[("u", "nothing")]);
        (c.id, c.updated_at, c.cwd) = ("c".into(), 30.0, "D:\\C".into());
        let docs = [a, b, c];
        let ids = |r: &SearchOut| r.hits.iter().map(|h| h["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let q = |text: &str| ConvQuery { text: text.into(), ..Default::default() };
        let all = search_docs(&docs, &q("redis"));
        assert_eq!(ids(&all), vec!["b", "a"]);
        assert_eq!(all.hits[1]["titleMarks"], json!([[0, 5]]));
        assert_eq!(all.conversations, 3);
        let key = normalize_folder("D:\\A");
        assert_eq!(all.projects.iter().find(|p| p["key"] == json!(key)).unwrap()["count"], json!(2));
        assert_eq!(ids(&search_docs(&docs, &ConvQuery { cli: Some("claude".into()), ..q("redis") })), vec!["a"]);
        assert_eq!(ids(&search_docs(&docs, &ConvQuery { project: Some(normalize_folder("D:\\C")), ..q("") })), vec!["c"]);
        assert_eq!(ids(&search_docs(&docs, &ConvQuery { from: Some(15.0), ..q("") })), vec!["c", "b"]);
        let one = search_docs(&docs, &ConvQuery { limit: Some(1.0), ..q("") });
        assert_eq!((one.total, ids(&one)), (3, vec!["c".to_string()]));
    }

    #[test]
    fn parallel_matching_answers_like_matching_in_place() {
        let words = ["redis", "pool", "Zażółć", "ΣΟΦΟΣ", "state", "x"];
        let docs: Vec<ConvDoc> = (0..60)
            .map(|i| {
                let text = format!("{} message {i} {}", words[i % words.len()], words[(i * 7) % words.len()]);
                let mut d = doc_of(&[("u", &text), ("a", &text.repeat(3))]);
                (d.id, d.updated_at) = (format!("d{i}"), f64::from((i % 9) as u8));
                d
            })
            .collect();
        for text in ["redis", "pool state", "zazolc", "\"message 1\"", "nothing", ""] {
            let q = ConvQuery { text: text.into(), ..Default::default() };
            let a = search_docs_with(&docs, &q, usize::MAX).into_map();
            let b = search_docs_with(&docs, &q, 0).into_map();
            assert_eq!(a, b, "{text}");
        }
    }
}
