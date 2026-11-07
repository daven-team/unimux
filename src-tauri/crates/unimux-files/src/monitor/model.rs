//! The pure half of the Monitor panel (src/shared/monitor.ts): the CPU arithmetic between two snapshots and the trees of the
//! app and its cells. Numbers are f64 like JS numbers; sums run in the same order as 1.1.4's `reduce` calls, so the golden
//! rows (test/golden/monitor.jsonl) match to the last bit.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

/// One process of a system snapshot. `cpu_ms`: CPU time used since it started; `start`: start time (ms, only compared).
#[derive(Debug, Clone, PartialEq)]
pub struct RawProc {
    pub pid: u32,
    pub ppid: u32,
    pub cpu_ms: f64,
    pub mem: f64,
    pub start: f64,
    pub name: String,
}

/// One of the app's own processes: `main`, the WebView2 / WebKit processes (`webview`, `renderer`, `gpu`, `utility`) and,
/// in 1.1.4's model, the Electron hosts (`ptyhost`, `sftphost`, `dbhost`). Anything else the app started is `other`.
#[derive(Debug, Clone, PartialEq)]
pub struct AppProcInfo {
    pub pid: u32,
    pub kind: String,
    pub name: Option<String>,
}

impl AppProcInfo {
    pub fn new(pid: u32, kind: &str, name: Option<&str>) -> Self {
        Self { pid, kind: kind.to_string(), name: name.map(str::to_string) }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MonitorRow {
    pub pid: u32,
    pub name: String,
    pub cpu: f64,
    pub mem: f64,
    pub depth: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MonitorAppRow {
    pub pid: u32,
    pub kind: String,
    pub name: String,
    pub cpu: f64,
    pub mem: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MonitorCell {
    pub cell_id: String,
    pub pid: u32,
    pub cpu: f64,
    pub mem: f64,
    pub rows: Vec<MonitorRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MonitorSample {
    pub ok: bool,
    /// Logical processors; a CPU value of 100 is the whole machine (as in Task Manager).
    pub cores: u32,
    pub app: Vec<MonitorAppRow>,
    pub cells: Vec<MonitorCell>,
    /// Sums: the app with every cell, in % and bytes.
    pub cpu: f64,
    pub mem: f64,
    /// How long the snapshot took (ms).
    pub query_ms: f64,
}

/// A JS number as JSON: whole values as integers (what `JSON.stringify` prints), others as they are.
pub fn num(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        json!(v as i64)
    } else if v.is_finite() {
        json!(v)
    } else {
        Value::Null
    }
}

impl MonitorSample {
    pub fn failed(cores: u32, query_ms: f64) -> Self {
        Self { ok: false, cores, app: Vec::new(), cells: Vec::new(), cpu: 0.0, mem: 0.0, query_ms }
    }

    /// The `MonitorSample` object the renderer reads.
    pub fn to_json(&self) -> Value {
        json!({
            "ok": self.ok,
            "cores": self.cores,
            "app": self.app.iter().map(|a| json!({
                "pid": a.pid, "kind": a.kind, "name": a.name, "cpu": num(a.cpu), "mem": num(a.mem),
            })).collect::<Vec<_>>(),
            "cells": self.cells.iter().map(|c| json!({
                "cellId": c.cell_id, "pid": c.pid, "cpu": num(c.cpu), "mem": num(c.mem),
                "rows": c.rows.iter().map(|r| json!({
                    "pid": r.pid, "name": r.name, "cpu": num(r.cpu), "mem": num(r.mem), "depth": r.depth,
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "cpu": num(self.cpu),
            "mem": num(self.mem),
            "queryMs": num(self.query_ms),
        })
    }
}

/// The Monitor panel asks every 2 s while it is on screen (shared/monitor.ts MONITOR_INTERVAL_MS).
pub const MONITOR_INTERVAL_MS: u64 = 2000;

/// The previous snapshot's CPU time and start per pid.
pub type CpuMemo = HashMap<u32, (f64, f64)>;

/// `cpuPercents`: CPU % of each process since the previous snapshot (`wall_ms` ago), 100 being every core busy. A process
/// seen for the first time, or a pid that now belongs to a different process (another start time), shows 0.
pub fn cpu_percents(procs: &[RawProc], prev: Option<&CpuMemo>, wall_ms: f64, cores: u32) -> HashMap<u32, f64> {
    let denom = wall_ms.max(1.0) * f64::from(cores.max(1));
    let mut out = HashMap::with_capacity(procs.len());
    for p in procs {
        let used = match prev.and_then(|m| m.get(&p.pid)) {
            Some((cpu, start)) if *start == p.start => p.cpu_ms - cpu,
            _ => 0.0,
        };
        // Math.max(0, Math.min(100, x)); a NaN stays NaN in JS, never here (the inputs are finite).
        out.insert(p.pid, ((used / denom) * 100.0).clamp(0.0, 100.0));
    }
    out
}

pub fn cpu_memo(procs: &[RawProc]) -> CpuMemo {
    procs.iter().map(|p| (p.pid, (p.cpu_ms, p.start))).collect()
}

/// `childrenOf`: children (indexes into `procs`) by parent pid. A "child" that started before its parent is a reused parent
/// pid, not a child. A repeated pid keeps the last entry as the parent (`new Map` keeps the last value).
pub fn children_of(procs: &[RawProc]) -> HashMap<u32, Vec<usize>> {
    let by_pid: HashMap<u32, usize> = procs.iter().enumerate().map(|(i, p)| (p.pid, i)).collect();
    let mut out: HashMap<u32, Vec<usize>> = HashMap::new();
    for (i, p) in procs.iter().enumerate() {
        let Some(&parent) = by_pid.get(&p.ppid) else { continue };
        let parent = &procs[parent];
        if parent.pid == p.pid || (parent.start != 0.0 && p.start != 0.0 && p.start < parent.start) {
            continue;
        }
        out.entry(p.ppid).or_default().push(i);
    }
    out
}

/// `descendants`: every descendant of `pid` (not `pid` itself), in 1.1.4's stack order.
pub fn descendants(procs: &[RawProc], children: &HashMap<u32, Vec<usize>>, pid: u32) -> Vec<usize> {
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::from([pid]);
    let mut stack: Vec<usize> = children.get(&pid).cloned().unwrap_or_default();
    while let Some(i) = stack.pop() {
        let p = &procs[i];
        if !seen.insert(p.pid) {
            continue;
        }
        out.push(i);
        if let Some(kids) = children.get(&p.pid) {
            stack.extend_from_slice(kids);
        }
    }
    out
}

/// `/^(openconsole|conhost)(\.exe)?$/i`
pub fn is_console_host(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let base = lower.strip_suffix(".exe").unwrap_or(&lower);
    base == "openconsole" || base == "conhost"
}

/// `matchConsoleHosts` (Windows): the console host of each cell. ConPTY starts it right before the cell's shell, so a cell
/// gets the latest unclaimed console host started no later than its shell (1 s tolerance for clock granularity). `hosts` and
/// the answer are indexes into `procs`.
pub fn match_console_hosts(procs: &[RawProc], hosts: &[usize], roots: &[(String, usize)]) -> HashMap<String, usize> {
    let mut out = HashMap::new();
    let mut free: Vec<usize> = hosts.iter().copied().filter(|&h| is_console_host(&procs[h].name)).collect();
    free.sort_by(|a, b| js_order(procs[*a].start - procs[*b].start));
    let mut ordered: Vec<&(String, usize)> = roots.iter().collect();
    ordered.sort_by(|a, b| js_order(procs[b.1].start - procs[a.1].start));
    for (cell_id, root) in ordered {
        let limit = procs[*root].start + 1000.0;
        let Some(best) = free.iter().rposition(|&h| procs[h].start <= limit) else { continue };
        out.insert(cell_id.clone(), free.remove(best));
    }
    out
}

/// A JS comparator's number as an Ordering (NaN counts as equal, like V8's sort).
fn js_order(d: f64) -> std::cmp::Ordering {
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

/// `byCpu`: busiest first, then the larger memory.
fn by_cpu(a_cpu: f64, a_mem: f64, b_cpu: f64, b_mem: f64) -> std::cmp::Ordering {
    let d = b_cpu - a_cpu;
    js_order(if d != 0.0 && !d.is_nan() { d } else { b_mem - a_mem })
}

/// What `buildMonitor` gets.
pub struct MonitorInput<'a> {
    pub procs: &'a [RawProc],
    pub cpu: &'a HashMap<u32, f64>,
    pub cores: u32,
    /// The app's own processes; the first `main` is the root of the app tree.
    pub app: &'a [AppProcInfo],
    /// The pty shell of each running cell.
    pub cells: &'a [(String, u32)],
    /// The process whose children are the console hosts (OpenConsole.exe / conhost.exe): 1.1.4's Pty Host, the app itself in
    /// 1.2.0 (the pty service runs in unimux.exe).
    pub console_parent: Option<u32>,
    pub query_ms: f64,
}

/// `buildMonitor`: the app's processes (the known ones plus anything else the app started) and, per cell, its pty process
/// tree with the console host. Cells sorted by CPU, rows depth-first with the busiest child first; app rows by CPU.
pub fn build_monitor(input: &MonitorInput) -> MonitorSample {
    let procs = input.procs;
    let by_pid: HashMap<u32, usize> = procs.iter().enumerate().map(|(i, p)| (p.pid, i)).collect();
    let children = children_of(procs);
    let cpu_of = |pid: u32| input.cpu.get(&pid).copied().unwrap_or(0.0);
    let mut claimed: HashSet<u32> = HashSet::new();
    let roots: Vec<(String, usize)> =
        input.cells.iter().filter_map(|(id, pid)| by_pid.get(pid).map(|&i| (id.clone(), i))).collect();
    let hosts: Vec<usize> = input.console_parent.and_then(|p| children.get(&p)).cloned().unwrap_or_default();
    let consoles = match_console_hosts(procs, &hosts, &roots);

    fn walk(
        i: usize,
        depth: u32,
        procs: &[RawProc],
        children: &HashMap<u32, Vec<usize>>,
        cpu_of: &dyn Fn(u32) -> f64,
        claimed: &mut HashSet<u32>,
        rows: &mut Vec<MonitorRow>,
    ) {
        let p = &procs[i];
        if !claimed.insert(p.pid) {
            return;
        }
        rows.push(MonitorRow { pid: p.pid, name: p.name.clone(), cpu: cpu_of(p.pid), mem: p.mem, depth });
        let mut kids: Vec<usize> = children.get(&p.pid).cloned().unwrap_or_default();
        kids.sort_by(|a, b| {
            let (a, b) = (&procs[*a], &procs[*b]);
            let d = cpu_of(b.pid) - cpu_of(a.pid);
            js_order(if d != 0.0 && !d.is_nan() { d } else { b.mem - a.mem })
        });
        for kid in kids {
            walk(kid, depth + 1, procs, children, cpu_of, claimed, rows);
        }
    }

    let mut cells: Vec<MonitorCell> = roots
        .iter()
        .map(|(cell_id, root)| {
            let mut rows = Vec::new();
            walk(*root, 0, procs, &children, &cpu_of, &mut claimed, &mut rows);
            if let Some(&host) = consoles.get(cell_id) {
                walk(host, 0, procs, &children, &cpu_of, &mut claimed, &mut rows);
            }
            MonitorCell {
                cell_id: cell_id.clone(),
                pid: procs[*root].pid,
                cpu: rows.iter().fold(0.0, |s, r| s + r.cpu),
                mem: rows.iter().fold(0.0, |s, r| s + r.mem),
                rows,
            }
        })
        .collect();
    cells.sort_by(|a, b| by_cpu(a.cpu, a.mem, b.cpu, b.mem));

    let known: HashSet<u32> = input.app.iter().map(|a| a.pid).collect();
    let mut app: Vec<MonitorAppRow> = Vec::new();
    for info in input.app {
        let Some(&i) = by_pid.get(&info.pid) else { continue };
        let p = &procs[i];
        if !claimed.insert(p.pid) {
            continue;
        }
        let name = info.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| p.name.clone());
        app.push(MonitorAppRow { pid: p.pid, kind: info.kind.clone(), name, cpu: cpu_of(p.pid), mem: p.mem });
    }
    if let Some(main) = input.app.iter().find(|a| a.kind == "main") {
        for i in descendants(procs, &children, main.pid) {
            let p = &procs[i];
            if claimed.contains(&p.pid) || known.contains(&p.pid) {
                continue;
            }
            claimed.insert(p.pid);
            app.push(MonitorAppRow { pid: p.pid, kind: "other".into(), name: p.name.clone(), cpu: cpu_of(p.pid), mem: p.mem });
        }
    }
    app.sort_by(|a, b| by_cpu(a.cpu, a.mem, b.cpu, b.mem));
    let app_cpu = app.iter().fold(0.0, |s, r| s + r.cpu);
    let cell_cpu = cells.iter().fold(0.0, |s, r| s + r.cpu);
    let app_mem = app.iter().fold(0.0, |s, r| s + r.mem);
    let cell_mem = cells.iter().fold(0.0, |s, r| s + r.mem);
    MonitorSample {
        ok: true,
        cores: input.cores,
        app,
        cells,
        cpu: app_cpu + cell_cpu,
        mem: app_mem + cell_mem,
        query_ms: input.query_ms,
    }
}

/// `killablePid`: whether `pid` may be killed from the panel: a process of a cell's tree (its shell, the agent, their
/// children), never a console host.
pub fn killable_pid(sample: &MonitorSample, pid: u32) -> bool {
    sample.cells.iter().any(|c| c.rows.iter().any(|r| r.pid == pid && !is_console_host(&r.name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn proc(pid: u32, ppid: u32, name: &str, start: f64, cpu_ms: f64, mem: f64) -> RawProc {
        RawProc { pid, ppid, name: name.into(), start, cpu_ms, mem }
    }
    fn p(pid: u32, ppid: u32, name: &str, start: f64) -> RawProc {
        proc(pid, ppid, name, start, 0.0, 1000.0)
    }

    #[test]
    fn cpu_is_the_time_used_in_the_interval_over_every_core_0_for_new_or_reused_pids() {
        let before =
            [proc(1, 0, "a", 10.0, 1000.0, 1000.0), proc(2, 0, "b", 20.0, 500.0, 1000.0), proc(3, 0, "c", 30.0, 100.0, 1000.0)];
        let after = [
            proc(1, 0, "a", 10.0, 3000.0, 1000.0),
            proc(2, 0, "b", 99.0, 4000.0, 1000.0),
            proc(3, 0, "c", 30.0, 100.0, 1000.0),
            proc(4, 0, "d", 40.0, 900.0, 1000.0),
        ];
        let memo = cpu_memo(&before);
        let cpu = cpu_percents(&after, Some(&memo), 2000.0, 4);
        assert_eq!(cpu[&1], 25.0);
        assert_eq!(cpu[&2], 0.0);
        assert_eq!(cpu[&3], 0.0);
        assert_eq!(cpu[&4], 0.0);
        assert_eq!(cpu_percents(&after, None, 2000.0, 4)[&1], 0.0);
        assert_eq!(cpu_percents(&[proc(1, 0, "a", 10.0, 1e9, 1.0)], Some(&memo), 2000.0, 1)[&1], 100.0);
        assert_eq!(cpu_percents(&[proc(1, 0, "a", 10.0, 0.0, 1.0)], Some(&memo), 2000.0, 1)[&1], 0.0);
    }

    #[test]
    fn ignores_a_parent_pid_that_was_reused_by_a_younger_process() {
        let procs = [p(10, 1, "parent", 500.0), p(11, 10, "child", 600.0), p(12, 10, "orphan", 100.0)];
        let children = children_of(&procs);
        assert_eq!(children[&10].iter().map(|&i| procs[i].pid).collect::<Vec<_>>(), [11]);
        assert_eq!(descendants(&procs, &children, 10).iter().map(|&i| procs[i].pid).collect::<Vec<_>>(), [11]);
    }

    #[test]
    fn survives_cycles() {
        let procs = [p(1, 2, "a", 0.0), p(2, 1, "b", 0.0)];
        let children = children_of(&procs);
        assert_eq!(descendants(&procs, &children, 1).iter().map(|&i| procs[i].pid).collect::<Vec<_>>(), [2]);
    }

    #[test]
    fn gives_each_cell_the_console_host_conpty_started_right_before_its_shell() {
        let procs = [
            p(50, 9, "OpenConsole.exe", 1000.0),
            p(51, 9, "OpenConsole.exe", 2000.0),
            p(52, 9, "OpenConsole.exe", 3000.0),
            p(53, 9, "node.exe", 2999.0),
            p(61, 9, "pwsh.exe", 2010.0),
            p(60, 9, "pwsh.exe", 1010.0),
            p(62, 9, "pwsh.exe", 3005.0),
        ];
        let roots = [("b".to_string(), 4), ("a".to_string(), 5), ("c".to_string(), 6)];
        let got = match_console_hosts(&procs, &[0, 1, 2, 3], &roots);
        let pids: HashMap<&str, u32> = got.iter().map(|(k, v)| (k.as_str(), procs[*v].pid)).collect();
        assert_eq!(pids, HashMap::from([("a", 50), ("b", 51), ("c", 52)]));
        let procs = [p(50, 9, "conhost.exe", 5000.0), p(60, 9, "sh", 1000.0)];
        assert!(match_console_hosts(&procs, &[0], &[("a".to_string(), 1)]).is_empty());
    }

    // main 100 -> renderer 101, gpu 102, pty host 103 (-> console 200, shell 201 -> claude 202 -> bash 203; console 210,
    // shell 211), monitor helper 104 (not an app process); 999 is somebody else's.
    fn fixture() -> MonitorSample {
        let procs = [
            p(100, 1, "unimux.exe", 1.0),
            p(101, 100, "unimux.exe", 2.0),
            p(102, 100, "unimux.exe", 3.0),
            p(103, 100, "unimux.exe", 4.0),
            p(104, 100, "powershell.exe", 5.0),
            p(200, 103, "OpenConsole.exe", 10.0),
            p(201, 103, "pwsh.exe", 11.0),
            proc(202, 201, "claude.exe", 12.0, 0.0, 5000.0),
            p(203, 202, "bash.exe", 13.0),
            p(210, 103, "OpenConsole.exe", 20.0),
            p(211, 103, "pwsh.exe", 21.0),
            p(999, 1, "other.exe", 30.0),
        ];
        let cpu = HashMap::from([(100, 1.0), (101, 2.0), (104, 0.5), (202, 30.0), (203, 5.0), (211, 3.0), (210, 0.2)]);
        let app = [
            AppProcInfo::new(100, "main", None),
            AppProcInfo::new(101, "renderer", None),
            AppProcInfo::new(102, "gpu", None),
            AppProcInfo::new(103, "ptyhost", Some("unimux Pty Host")),
        ];
        let cells = [("quiet".to_string(), 211), ("busy".to_string(), 201), ("gone".to_string(), 777)];
        build_monitor(&MonitorInput {
            procs: &procs,
            cpu: &cpu,
            cores: 8,
            app: &app,
            cells: &cells,
            console_parent: Some(103),
            query_ms: 0.0,
        })
    }

    #[test]
    fn puts_the_busiest_cell_first_with_its_tree_depth_first_and_its_console_host() {
        let sample = fixture();
        assert_eq!(sample.cells.iter().map(|c| c.cell_id.as_str()).collect::<Vec<_>>(), ["busy", "quiet"]);
        assert_eq!(
            sample.cells[0].rows.iter().map(|r| (r.pid, r.depth)).collect::<Vec<_>>(),
            [(201, 0), (202, 1), (203, 2), (200, 0)]
        );
        assert_eq!(sample.cells[0].cpu, 35.0);
        assert_eq!(sample.cells[0].mem, 8000.0);
        assert_eq!(sample.cells[1].rows.iter().map(|r| r.pid).collect::<Vec<_>>(), [211, 210]);
    }

    #[test]
    fn lists_the_app_processes_and_anything_else_the_app_started_never_a_cell_process_twice_never_a_foreign_one() {
        let sample = fixture();
        assert_eq!(
            sample.app.iter().map(|a| (a.pid, a.kind.as_str())).collect::<Vec<_>>(),
            [(101, "renderer"), (100, "main"), (104, "other"), (102, "gpu"), (103, "ptyhost")]
        );
        assert_eq!(sample.app.iter().find(|a| a.pid == 103).unwrap().name, "unimux Pty Host");
        let all: Vec<u32> =
            sample.app.iter().map(|a| a.pid).chain(sample.cells.iter().flat_map(|c| c.rows.iter().map(|r| r.pid))).collect();
        assert_eq!(all.iter().collect::<HashSet<_>>().len(), all.len());
        assert!(!all.contains(&999));
        assert!((sample.cpu - 41.7).abs() < 1e-9);
    }

    #[test]
    fn allows_killing_only_processes_of_a_cell_tree_never_a_console_host_a_host_or_the_app() {
        let sample = fixture();
        assert!(killable_pid(&sample, 203));
        assert!(killable_pid(&sample, 201));
        assert!(!killable_pid(&sample, 200));
        assert!(!killable_pid(&sample, 103));
        assert!(!killable_pid(&sample, 100));
        assert!(!killable_pid(&sample, 999));
    }

    #[test]
    fn without_a_pty_host_the_console_hosts_are_the_apps_own_children() {
        // 1.2.0: unimux.exe runs the pseudo consoles; OpenConsole.exe and the shell are its children, WebView2 is too.
        let procs = [
            p(100, 1, "unimux.exe", 1.0),
            p(300, 100, "msedgewebview2.exe", 2.0),
            p(301, 300, "msedgewebview2.exe", 3.0),
            p(200, 100, "OpenConsole.exe", 10.0),
            p(201, 100, "cmd.exe", 11.0),
            p(202, 201, "node.exe", 12.0),
        ];
        let app = [
            AppProcInfo::new(100, "main", None),
            AppProcInfo::new(300, "webview", None),
            AppProcInfo::new(301, "renderer", None),
        ];
        let cells = [("c".to_string(), 201)];
        let cpu = HashMap::new();
        let sample = build_monitor(&MonitorInput {
            procs: &procs,
            cpu: &cpu,
            cores: 4,
            app: &app,
            cells: &cells,
            console_parent: Some(100),
            query_ms: 3.0,
        });
        assert_eq!(sample.cells[0].rows.iter().map(|r| r.pid).collect::<Vec<_>>(), [201, 202, 200]);
        assert_eq!(
            sample.app.iter().map(|a| (a.pid, a.kind.as_str())).collect::<Vec<_>>(),
            [(100, "main"), (300, "webview"), (301, "renderer")]
        );
        assert_eq!(sample.app[1].name, "msedgewebview2.exe");
        let json = sample.to_json();
        assert_eq!(json["cells"][0]["cellId"], "c");
        assert_eq!(json["mem"], 6000);
        assert_eq!(json["queryMs"], 3);
    }

    #[test]
    fn console_host_names_follow_the_1_1_4_pattern() {
        for yes in ["OpenConsole.exe", "conhost", "CONHOST.EXE", "openconsole"] {
            assert!(is_console_host(yes), "{yes}");
        }
        for no in ["conhost.exe.exe", "Open Console.exe", "conhosts.exe", ""] {
            assert!(!is_console_host(no), "{no}");
        }
    }
}
