//! The golden corpus of the state code (scripts/dump-goldens.mjs, written by the TS reference): every Rust answer must be
//! byte-identical to the TS one (compared as JSON.stringify text).

use serde_json::Value;
use unimux_core::js_json::stringify;
use unimux_state::edits::merge_state_edit;
use unimux_state::patch::{apply_patch, diff_state};

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

/// Rows read like JSON.parse reads them (array-index keys first), as the TS side saw its inputs.
fn js_rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| unimux_core::js_json::parse(l).unwrap()).collect()
}

/// Where two JSON texts first differ (for a readable failure).
fn first_difference(a: &str, b: &str) -> String {
    let at = a.bytes().zip(b.bytes()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
    let from = at.saturating_sub(120);
    let cut = |s: &str| s.get(from..(at + 120).min(s.len())).unwrap_or("").to_string();
    format!("at byte {at}:\n  rust: ...{}\n  ts:   ...{}", cut(a), cut(b))
}

#[test]
fn normalize_state_matches_the_ts_reference() {
    use unimux_state::normalize::state::{Env, normalize_state};
    let rows = js_rows("normalize-state.jsonl");
    assert!(rows.len() >= 1000, "{} rows", rows.len());
    let mut failures = Vec::new();
    let mut nulls = 0;
    for (i, row) in rows.iter().enumerate() {
        let platform = if row["platform"] == "darwin" { unimux_state::Platform::Darwin } else { unimux_state::Platform::Win32 };
        let mut n = 0u64;
        let mut uid = || {
            n += 1;
            format!("00000000-0000-4000-8000-{n:012}")
        };
        let mut env = Env { now_ms: row["now"].as_f64().unwrap(), uid: &mut uid };
        let ours = normalize_state(&row["input"], platform, &mut env).map(|v| stringify(&v));
        let want = row["out"].as_str().map(str::to_string);
        if want.is_none() {
            nulls += 1;
        }
        if ours != want {
            let detail = match (&ours, &want) {
                (Some(a), Some(b)) => first_difference(a, b),
                _ => format!(
                    "rust {:?}, ts {:?}",
                    ours.as_ref().map(|s| &s[..s.len().min(200)]),
                    want.as_ref().map(|s| &s[..s.len().min(200)])
                ),
            };
            failures.push(format!("row {i} ({}): {detail}", row["platform"]));
        }
    }
    assert!(nulls > 10, "the corpus must hold rejected states too");
    assert!(
        failures.is_empty(),
        "{} of {} rows differ:\n{}",
        failures.len(),
        rows.len(),
        failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
    );
}

/// A state that went through normalizeState once is written back unchanged by the next start (load + save of a 1.1.4
/// state.json without an edit keeps its bytes), on both platforms.
#[test]
fn a_normalized_state_loads_and_saves_unchanged() {
    let rows = js_rows("normalize-state.jsonl");
    let mut checked = 0;
    for (i, row) in rows.iter().enumerate() {
        let Some(text) = row["out"].as_str() else { continue };
        // Some damaged states take two starts to settle in 1.1.4 too (a cell whose profile id was "constructor").
        if row["stable"] != true {
            continue;
        }
        let platform = if row["platform"] == "darwin" { unimux_state::Platform::Darwin } else { unimux_state::Platform::Win32 };
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("state.json"), text).unwrap();
        let options = unimux_state::store::LoadOptions::default();
        let state = unimux_state::store::load_state(dir.path(), platform, &unimux_state::StateNormalizer, &options).unwrap();
        // The inbox retention looks at the real clock: states with tasks or messages (which may age) are not compared exactly.
        let written = &row["out"];
        let written: Value = unimux_core::js_json::parse(written.as_str().unwrap()).unwrap();
        let ages = written["automation"]["tasks"].as_array().is_some_and(|t| !t.is_empty())
            || written["automation"]["messages"].as_array().is_some_and(|m| !m.is_empty());
        if !ages {
            assert_eq!(stringify(&state), text, "row {i}");
            checked += 1;
        }
    }
    assert!(checked > 500, "{checked} states checked");
}

#[test]
fn edit_normalization_matches_the_ts_reference() {
    use unimux_state::normalize::state::normalize_edited_state;
    let rows = js_rows("state-after-edit.jsonl");
    assert!(rows.len() >= 200, "{} rows", rows.len());
    let mut failures = Vec::new();
    let (mut errors, mut limits) = (0, 0);
    for (i, row) in rows.iter().enumerate() {
        let ours = normalize_edited_state(row["next"].clone(), &row["prev"]);
        match (&ours, row.get("error")) {
            (Ok(v), None) => {
                let (a, b) = (stringify(v), row["out"].as_str().unwrap_or_default().to_string());
                if a != b {
                    failures.push(format!("row {i}: {}", first_difference(&a, &b)));
                }
            }
            (Err(e), Some(ts)) => {
                errors += 1;
                // The cell limit is a message the renderer shows; a TypeError is only "the edit was refused".
                let limit = ts == "Concurrent grid change exceeds the cell limit.";
                limits += usize::from(limit);
                if limit != (e == "Concurrent grid change exceeds the cell limit.") {
                    failures.push(format!("row {i}: rust {e:?}, ts {ts}"));
                }
            }
            (a, b) => failures.push(format!("row {i}: rust {:?}, ts {b:?}", a.as_ref().map(|_| "ok"))),
        }
    }
    assert!(errors > 10 && limits > 3, "{errors} errors, {limits} cell limit errors");
    assert!(
        failures.is_empty(),
        "{} of {} rows differ:\n{}",
        failures.len(),
        rows.len(),
        failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn merge_state_edit_matches_the_ts_reference() {
    let rows = rows("state-merge.jsonl");
    assert!(rows.len() >= 400);
    for (i, row) in rows.iter().enumerate() {
        let out = merge_state_edit(&row["current"], &row["base"], &row["next"]);
        assert_eq!(stringify(&out), stringify(&row["out"]), "row {i}");
    }
}

#[test]
fn diff_state_matches_the_ts_reference_and_applies() {
    let rows = rows("state-diff.jsonl");
    assert!(rows.len() >= 400);
    for (i, row) in rows.iter().enumerate() {
        let patch = diff_state(&row["prev"], &row["next"]).unwrap_or(Value::Null);
        assert_eq!(stringify(&patch), stringify(&row["patch"]), "row {i}");
        let applied = if patch.is_null() { row["prev"].clone() } else { apply_patch(&row["prev"], &patch).unwrap() };
        assert_eq!(stringify(&applied), stringify(&row["next"]), "row {i}: apply(diff(a, b), a) == b");
    }
}

#[test]
fn a_state_json_with_lone_surrogates_loads_like_json_parse_reads_it() {
    let rows = rows("state-load.jsonl");
    assert!(rows.len() >= 8);
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(row["jsonParseAccepts"], true, "row {i}");
        let text = row["text"].as_str().unwrap();
        let parsed = unimux_core::js_json::parse(text).unwrap_or_else(|e| panic!("row {i}: {e}"));
        assert_eq!(stringify(&parsed), row["out"].as_str().unwrap(), "row {i}");
        // The whole load: state.json stays where it is (not renamed to a .bak-<ISO> as corrupt).
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("state.json"), text).unwrap();
        let options = unimux_state::store::LoadOptions::default();
        let state =
            unimux_state::store::load_state(dir.path(), unimux_state::Platform::Win32, &unimux_state::PassThrough, &options)
                .unwrap();
        assert_eq!(stringify(&state), row["out"].as_str().unwrap(), "row {i}");
        assert_eq!(std::fs::read_to_string(dir.path().join("state.json")).unwrap(), text, "row {i}");
    }
}

#[test]
fn the_retention_sort_orders_like_v8_even_for_nan_keys() {
    let rows = rows("js-sort.jsonl");
    assert_eq!(rows.len(), 400);
    let mut bad = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let keys: Vec<f64> = row["keys"].as_array().unwrap().iter().map(|k| k.as_f64().unwrap_or(f64::NAN)).collect();
        let want: Vec<usize> = row["order"].as_array().unwrap().iter().map(|k| k.as_u64().unwrap() as usize).collect();
        let mut got: Vec<usize> = (0..keys.len()).collect();
        unimux_state::normalize::timsort::sort_by(&mut got, |a, b| keys[*a] - keys[*b]);
        if got != want {
            bad.push(i);
        }
    }
    assert!(bad.is_empty(), "{} of {} rows differ: {:?}", bad.len(), rows.len(), &bad[..bad.len().min(20)]);
}

/// test/golden/detached.jsonl (scripts/goldens-detached.mjs): the registry edits, cell owners, placement over display work
/// areas, titles, hand-over parts, work reports, open-in-main requests and wait marks of src/shared/detached.ts.
#[test]
fn detached_matches_the_ts_reference() {
    use serde_json::json;
    use unimux_state::detached::*;
    let rows = rows("detached.jsonl");
    assert!(rows.len() >= 1500, "{} rows", rows.len());
    let rect = |v: &Value| Rect::from_json(v);
    let displays = |v: &Value| -> Vec<DisplayArea> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|d| DisplayArea { id: d["id"].as_f64().unwrap(), work_area: Rect::from_json(&d["workArea"]).unwrap() })
            .collect()
    };
    let size = |v: &Value| Size { width: v["width"].as_f64().unwrap(), height: v["height"].as_f64().unwrap() };
    let pairs = |v: &Value| -> Vec<(String, String)> {
        v.as_array().unwrap().iter().map(|p| (p[0].as_str().unwrap().into(), p[1].as_str().unwrap().into())).collect()
    };
    let pairs_json = |list: Vec<(String, String)>| Value::Array(list.into_iter().map(|(a, b)| json!([a, b])).collect());
    let list = |v: &Value| v.as_array().unwrap().clone();
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let a = row["args"].as_array().unwrap();
        let ours: Value = match row["fn"].as_str().unwrap() {
            "restoreBounds" => restore_bounds(rect(&a[0]).as_ref(), &displays(&a[1]), a[2].as_f64().unwrap()).to_json(),
            "boundsAtPoint" => bounds_at_point(
                a[0]["x"].as_f64().unwrap(),
                a[0]["y"].as_f64().unwrap(),
                size(&a[1]),
                &displays(&a[2]),
                a[3].as_f64().unwrap(),
            )
            .to_json(),
            "boundsBeside" => {
                bounds_beside(rect(&a[0]).as_ref(), size(&a[1]), &displays(&a[2]), a[3].as_f64().unwrap()).to_json()
            }
            "clampRect" => clamp_rect(&rect(&a[0]).unwrap(), &rect(&a[1]).unwrap()).to_json(),
            "displayAt" => {
                let ds = displays(&a[0]);
                display_at(&ds, a[1]["x"].as_f64().unwrap(), a[1]["y"].as_f64().unwrap(), a[2].as_f64().unwrap())
                    .map_or(Value::Null, |d| unimux_state::normalize::js::num(d.id))
            }
            "cellOwners" => pairs_json(cell_owners(&a[0])),
            "routeChanges" => {
                Value::Array(route_changes(&pairs(&a[0]), &pairs(&a[1])).into_iter().map(|(c, w)| json!([c, w])).collect())
            }
            "addDetached" => match add_detached(&a[0], a[1].clone()) {
                Added::Limit => json!("limit"),
                Added::Existing(w) => json!({ "existing": w }),
                Added::Added(s) => json!({ "state": s }),
            },
            "removeDetached" => remove_detached(&a[0], a[1].as_str().unwrap()).unwrap_or(json!("same")),
            "setDetachedPlace" => {
                let place = &a[2];
                set_detached_place(
                    &a[0],
                    a[1].as_str().unwrap(),
                    place.get("bounds").and_then(Rect::from_json),
                    place.get("displayId").and_then(Value::as_f64),
                    place["maximized"] == true,
                )
                .unwrap_or(json!("same"))
            }
            "detachedTitle" => json!(detached_title(&a[0], &a[1])),
            "splitHandoffs" => {
                let (docs, handoffs) = split_handoffs(&list(&a[0]));
                json!({ "docs": docs, "handoffs": handoffs })
            }
            "handoffSessions" => json!(handoff_sessions(&list(&a[0]))),
            "cleanWork" => clean_work(Some(&a[0])).unwrap_or(Value::Null),
            "sumWork" => sum_work(a[0].as_array().unwrap()),
            "cleanOpenInMain" => clean_open_in_main(Some(&a[0])).unwrap_or(Value::Null),
            "normalizeWaitMark" => normalize_wait_mark(Some(&a[0])).unwrap_or(Value::Null),
            other => panic!("unknown fn {other}"),
        };
        if stringify(&ours) != stringify(&row["out"]) {
            failures.push(format!("row {i} {}: {}", row["fn"], first_difference(&stringify(&ours), &stringify(&row["out"]))));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} rows differ:\n{}",
        failures.len(),
        rows.len(),
        failures[..failures.len().min(10)].join("\n")
    );
}
