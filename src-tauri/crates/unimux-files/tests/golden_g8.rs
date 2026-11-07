//! The G8 golden rows (scripts/goldens-g8.mjs): the answers of 1.1.4's parseReleases / compareVersions and of the Monitor
//! panel's cpuPercents / buildMonitor / killablePid.

use std::collections::HashMap;
use std::fs;

use serde_json::{Value, json};
use unimux_files::changelog::{compare_versions, parse_releases};
use unimux_files::monitor::model::{AppProcInfo, CpuMemo, MonitorInput, RawProc, build_monitor, cpu_percents, killable_pid, num};

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[test]
fn releases_match_the_ts_reference() {
    let mut releases = 0;
    let mut compares = 0;
    for (i, row) in rows("changelog.jsonl").iter().enumerate() {
        if let Some(input) = row.get("releases") {
            let got: Vec<Value> = parse_releases(input).iter().map(|e| e.to_json()).collect();
            assert_eq!(Value::Array(got), row["out"], "row {i}: {input}");
            releases += 1;
        } else {
            let (a, b) = (row["a"].as_str().unwrap(), row["b"].as_str().unwrap());
            let want = row["cmp"].as_f64();
            let got = compare_versions(a, b);
            match want {
                Some(w) => assert_eq!(got, w, "row {i}: {a} vs {b}"),
                // JSON.stringify(NaN) is null.
                None => assert!(got.is_nan(), "row {i}: {a} vs {b}: {got}"),
            }
            compares += 1;
        }
    }
    assert!(releases >= 300 && compares >= 200, "{releases} / {compares}");
}

fn procs_of(v: &Value) -> Vec<RawProc> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| RawProc {
            pid: p["pid"].as_u64().unwrap() as u32,
            ppid: p["ppid"].as_u64().unwrap() as u32,
            cpu_ms: p["cpuMs"].as_f64().unwrap(),
            mem: p["mem"].as_f64().unwrap(),
            start: p["start"].as_f64().unwrap(),
            name: p["name"].as_str().unwrap().to_string(),
        })
        .collect()
}

#[test]
fn monitor_trees_match_the_ts_reference() {
    let all = rows("monitor.jsonl");
    assert_eq!(all.len(), 400);
    for (i, row) in all.iter().enumerate() {
        let procs = procs_of(&row["procs"]);
        let prev: Option<CpuMemo> = row["prev"].as_array().map(|list| {
            list.iter().map(|e| (e[0].as_u64().unwrap() as u32, (e[1].as_f64().unwrap(), e[2].as_f64().unwrap()))).collect()
        });
        let cores = row["cores"].as_u64().unwrap() as u32;
        let cpu = cpu_percents(&procs, prev.as_ref(), row["wallMs"].as_f64().unwrap(), cores);
        let want_cpu: HashMap<u32, f64> =
            row["cpu"].as_array().unwrap().iter().map(|e| (e[0].as_u64().unwrap() as u32, e[1].as_f64().unwrap())).collect();
        assert_eq!(cpu, want_cpu, "row {i}: cpu");
        let app: Vec<AppProcInfo> = row["app"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| AppProcInfo::new(a["pid"].as_u64().unwrap() as u32, a["kind"].as_str().unwrap(), a["name"].as_str()))
            .collect();
        let cells: Vec<(String, u32)> = row["cells"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["cellId"].as_str().unwrap().to_string(), c["pid"].as_u64().unwrap() as u32))
            .collect();
        // 1.1.4 matched console hosts among the Pty Host's children only.
        let console_parent = app.iter().find(|a| a.kind == "ptyhost").map(|a| a.pid);
        let sample = build_monitor(&MonitorInput {
            procs: &procs,
            cpu: &cpu,
            cores,
            app: &app,
            cells: &cells,
            console_parent,
            query_ms: 3.0,
        });
        assert_eq!(sample.to_json(), row["sample"], "row {i}: sample");
        let killable: Vec<Value> = procs.iter().filter(|p| killable_pid(&sample, p.pid)).map(|p| json!(p.pid)).collect();
        assert_eq!(Value::Array(killable), row["killable"], "row {i}: killable");
    }
    // Whole numbers are written as integers, like JSON.stringify.
    assert_eq!(num(3.0), json!(3));
    assert_eq!(num(0.5), json!(0.5));
}
