//! The conversation search against the golden corpus of the 1.1.4 TS code (scripts/goldens-convsearch.mjs).

use base64::Engine as _;
use serde_json::{Value, json};
use unimux_agents::conv::export::{EXPORT_LIMITS, ExportLimits, read_export, tool_detail};
use unimux_agents::conv::indexer::{DocState, read_into};
use unimux_agents::conv::search::{ConvDoc, ConvQuery, MESSAGE_SEP, normalize_folder, parse_terms, search_docs};
use unimux_agents::conv::service::{ExportSource, sanitize_export_source, sanitize_query};
use unimux_agents::conv::text::{fold, lossy, to_lower, utf16};
use unimux_agents::conv::{ConvCli, Limits, clip_title, date, num};
use unimux_core::js_json;

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    // js_json: JSON.stringify wrote a lone surrogate (a text cut in an emoji) as \udXXX; it reads as U+FFFD, as Rust writes it.
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| js_json::parse(l).unwrap()).collect()
}

fn units(v: &Value) -> Vec<u16> {
    v.as_array().unwrap().iter().map(|u| u.as_u64().unwrap() as u16).collect()
}

fn same(rust: &Value, ts: &Value, what: &str) {
    let (a, b) = (js_json::stringify(rust), js_json::stringify(ts));
    assert!(a == b, "{what}\n rust: {}\n   ts: {}", &a[..a.len().min(3000)], &b[..b.len().min(3000)]);
}

#[test]
fn fold_of_every_code_unit_matches() {
    let rows = rows("conv-fold.jsonl");
    assert_eq!(rows.len(), 256);
    let mut diffs = vec![];
    for row in rows {
        let from = row["from"].as_u64().unwrap() as u16;
        for (i, out) in units(&row["out"]).into_iter().enumerate() {
            let u = from.wrapping_add(i as u16);
            let got = fold(&[u]);
            if got != [out] {
                diffs.push(format!("U+{u:04X}: rust {:04X?} ts {out:04X}", got));
            }
        }
    }
    assert!(diffs.is_empty(), "{} code units fold differently:\n{}", diffs.len(), diffs.join("\n"));
}

#[test]
fn lower_case_fold_and_folder_keys_of_mixed_strings_match() {
    for (i, row) in rows("conv-text.jsonl").iter().enumerate() {
        let s = units(&row["units"]);
        assert_eq!(to_lower(&s), units(&row["lower"]), "row {i} lower {:?}", lossy(&s));
        assert_eq!(fold(&s), units(&row["fold"]), "row {i} fold {:?}", lossy(&s));
        // normalizeFolder of a Rust string: lone surrogates are U+FFFD there (a path from JSON never holds one).
        let folder = lossy(&units(&row["folder"]));
        assert_eq!(normalize_folder(&lossy(&s)), folder, "row {i} folder");
    }
}

#[test]
fn query_terms_match() {
    for row in rows("conv-terms.jsonl") {
        let got: Vec<String> = parse_terms(row["query"].as_str().unwrap()).iter().map(|t| lossy(t)).collect();
        let want: Vec<String> = row["terms"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
        assert_eq!(got, want, "query {:?}", row["query"]);
    }
}

fn doc_of(d: &Value) -> ConvDoc {
    let mut text = vec![];
    let mut starts = vec![];
    let mut roles = vec![];
    let mut times = vec![];
    for (i, m) in d["messages"].as_array().unwrap().iter().enumerate() {
        if i > 0 {
            text.push(MESSAGE_SEP);
        }
        starts.push(text.len() as u32);
        text.extend(utf16(m[1].as_str().unwrap()));
        roles.push(m[0].as_str().unwrap().as_bytes()[0]);
        times.push(m[2].as_f64().unwrap());
    }
    ConvDoc {
        cli: ConvCli::parse(d["cli"].as_str().unwrap()).unwrap(),
        id: d["id"].as_str().unwrap().into(),
        cwd: d["cwd"].as_str().unwrap().into(),
        title: d["title"].as_str().unwrap().into(),
        started_at: d["startedAt"].as_f64().unwrap(),
        updated_at: d["updatedAt"].as_f64().unwrap(),
        model: d.get("model").and_then(Value::as_str).map(str::to_string),
        file: d["file"].as_str().unwrap().into(),
        folded: fold(&text),
        text,
        starts,
        roles,
        times,
        capped: false,
    }
}

#[test]
fn search_results_match_with_utf16_offsets() {
    let rows = rows("conv-search.jsonl");
    assert!(rows.len() >= 100);
    let mut with_hits = 0;
    for (i, row) in rows.iter().enumerate() {
        let docs: Vec<ConvDoc> = row["docs"].as_array().unwrap().iter().map(doc_of).collect();
        let out = search_docs(&docs, &ConvQuery::from_json(&row["query"]));
        let got = Value::Object(out.into_map());
        same(&got, &row["out"], &format!("row {i} query {}", row["query"]));
        if row["out"]["hits"].as_array().is_some_and(|h| h.iter().any(|h| !h["snippets"].as_array().unwrap().is_empty())) {
            with_hits += 1;
        }
    }
    assert!(with_hits > 40, "only {with_hits} rows with snippets");
}

/// The legacy (non-ISO) forms V8 still accepts that the port does not parse (see conv/date.rs).
const LEGACY_DATE_GAPS: [&str; 4] = ["0", "12", "2026/10/20", "2026-1-2"];

#[test]
fn date_parse_matches_v8() {
    for row in rows("conv-date.jsonl") {
        let text = row["text"].as_str().unwrap();
        let got = date::parse(text);
        if LEGACY_DATE_GAPS.contains(&text) {
            assert!(got.is_nan(), "{text}");
            continue;
        }
        match row["utc"].as_f64() {
            None => assert!(got.is_nan(), "{text}: {got}"),
            Some(utc) if row["local"] == json!(true) => assert_eq!(got, date::local_to_utc(utc), "{text}"),
            Some(utc) => assert_eq!(got, utc, "{text}"),
        }
    }
}

fn limits(v: &Value) -> Limits {
    Limits { message_chars: v["messageChars"].as_u64().unwrap() as usize, doc_chars: v["docChars"].as_u64().unwrap() as usize }
}

#[test]
fn transcripts_read_into_the_same_documents_and_exports() {
    let dir = tempfile::tempdir().unwrap();
    for (i, row) in rows("conv-read.jsonl").iter().enumerate() {
        let cli = ConvCli::parse(row["cli"].as_str().unwrap()).unwrap();
        let content = base64::engine::general_purpose::STANDARD.decode(row["content"].as_str().unwrap()).unwrap();
        let split = row["split"].as_u64().unwrap() as usize;
        let file = dir.path().join(format!("t{i}.jsonl"));
        let file_s = file.to_string_lossy().to_string();
        let lim = limits(&row["limits"]);
        std::fs::write(&file, &content[..split]).unwrap();
        let mut doc = DocState::empty(cli, &file_s);
        let first = read_into(&file_s, 0, &mut doc, lim, Some(split as u64)).unwrap();
        assert_eq!(json!(first), row["first"], "row {i} first offset");
        std::fs::write(&file, &content).unwrap();
        let offset = read_into(&file_s, first, &mut doc, lim, Some(content.len() as u64)).unwrap();
        assert_eq!(json!(offset), row["offset"], "row {i} offset");
        let d = &doc.doc;
        let m = &doc.meta;
        let got = json!({
            "text": lossy(&d.text), "folded": lossy(&d.folded), "starts": d.starts,
            "roles": String::from_utf8(d.roles.clone()).unwrap(), "times": d.times.iter().map(|t| num(*t)).collect::<Vec<_>>(),
            "capped": d.capped, "len": doc.len,
        });
        same(&got, &row["doc"], &format!("row {i} doc"));
        let meta = json!({
            "id": m.id, "cwd": m.cwd, "firstTs": num(m.first_ts), "lastTs": num(m.last_ts), "model": m.model,
            "custom": m.custom, "ai": m.ai, "prompt": m.prompt,
        });
        same(&meta, &row["meta"], &format!("row {i} meta"));
        assert_eq!(json!(clip_title(m)), row["title"], "row {i} title");
        let el = match &row["exportLimits"] {
            Value::Null => EXPORT_LIMITS,
            v => ExportLimits {
                doc_chars: v["docChars"].as_u64().unwrap() as usize,
                message_chars: v["messageChars"].as_u64().unwrap() as usize,
                items: v["items"].as_u64().unwrap() as usize,
            },
        };
        let exported = read_export(&file_s, cli, el).unwrap();
        same(&exported, &row["export"], &format!("row {i} export"));
    }
}

#[test]
fn tool_details_match() {
    for row in rows("conv-tool.jsonl") {
        let got = tool_detail(row["name"].as_str().unwrap(), row.get("input"));
        assert_eq!(json!(got), row["out"], "{} {:?}", row["name"], row.get("input"));
    }
}

#[test]
fn ipc_sanitizers_match() {
    for row in rows("conv-sanitize.jsonl") {
        let q = sanitize_query(&row["raw"]);
        let mut m = serde_json::Map::new();
        m.insert("text".into(), json!(q.text));
        if let Some(v) = &q.cli {
            m.insert("cli".into(), json!(v));
        }
        if let Some(v) = &q.role {
            m.insert("role".into(), json!(v));
        }
        if let Some(v) = &q.project {
            m.insert("project".into(), json!(v));
        }
        for (k, v) in [("from", q.from), ("to", q.to), ("limit", q.limit)] {
            if let Some(v) = v {
                m.insert(k.into(), num(v));
            }
        }
        same(&Value::Object(m), &row["query"], &format!("query of {}", row["raw"]));
        let source = match sanitize_export_source(&row["raw"]) {
            None => Value::Null,
            Some(ExportSource::File(f)) => json!({"file": f}),
            Some(ExportSource::Session { cli, id }) => json!({"cli": cli.as_str(), "id": id}),
        };
        same(&source, &row["source"], &format!("source of {}", row["raw"]));
    }
}
