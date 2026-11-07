//! Searches while a pass runs (review finding of H5: a search of a big index waited on the pass workers while it held the
//! entries lock, and the pass jobs waited on that lock, so on a machine with 4 to 6 logical CPUs neither ever ended).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use unimux_agents::conv::Roots;
use unimux_agents::conv::indexer::{Indexer, IndexerOptions};
use unimux_agents::conv::search::ConvQuery;

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn q(text: &str) -> ConvQuery {
    ConvQuery { text: text.into(), ..Default::default() }
}

/// An index above the parallel search threshold (1M folded code units): 40 conversations of 10 x 4000-char messages.
fn big_index(dir: &Path) {
    let proj = dir.join("claude").join("projects").join("D--big");
    std::fs::create_dir_all(&proj).unwrap();
    for n in 0..40 {
        let lines: Vec<String> = (0..10)
            .map(|i| {
                json!({"type": "user", "message": {"role": "user", "content": format!("{i} redis {}", "abcd ".repeat(800))}, "sessionId": format!("big-{n}"), "cwd": "D:\\big"})
                    .to_string()
            })
            .collect();
        std::fs::write(proj.join(format!("big-{n}.jsonl")), lines.join("\n") + "\n").unwrap();
    }
}

fn tiny_dir(dir: &Path) -> PathBuf {
    let proj = dir.join("claude").join("projects").join("D--tiny");
    std::fs::create_dir_all(&proj).unwrap();
    proj
}

fn tiny(proj: &Path, n: usize) -> PathBuf {
    let file = proj.join(format!("tiny-{n}.jsonl"));
    let line = json!({"type": "user", "message": {"role": "user", "content": format!("tiny {n}")}, "sessionId": format!("tiny-{n}"), "cwd": "D:\\tiny"});
    std::fs::write(&file, line.to_string() + "\n").unwrap();
    file
}

/// Runs `f` on its own thread and fails when it does not end within 60 s (a deadlock must not hang the test run).
fn within_60s(what: &str, f: impl FnOnce() + Send + 'static) {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        f();
        let _ = tx.send(());
    });
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(()) => {}
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => panic!("DEADLOCK: {what} did not end in 60 s"),
        // The thread panicked: its message is above.
        Err(e) => panic!("{what} failed: {e}"),
    }
}

/// 4 pass workers: a machine with 4 to 6 logical CPUs, where every worker holds a pass job.
fn small_machine(dir: &Path) -> Arc<Indexer> {
    let roots = Roots { claude: vec![s(&dir.join("claude"))], codex: vec![s(&dir.join("codex"))] };
    Arc::new(Indexer::new(IndexerOptions { fresh_ms: 0.0, pass_threads: Some(4), ..IndexerOptions::new(roots, None) }))
}

/// Searches the big index in a loop while the pass runs; returns how many searches overlapped the pass.
fn search_through_the_pass(ix: &Arc<Indexer>) -> usize {
    let mut searches = 0;
    while ix.indexing().is_some() {
        let r = ix.search(&q("redis"));
        assert_eq!(r["total"], 40, "{}", r["total"]);
        searches += 1;
    }
    ix.refresh(false);
    assert_eq!(ix.indexing(), None);
    assert_eq!(ix.search(&q("redis"))["total"], 40);
    searches
}

#[test]
fn a_search_of_a_big_index_while_a_pass_reads_many_files_does_not_deadlock() {
    let dir = tempfile::tempdir().unwrap();
    big_index(dir.path());
    let path = dir.path().to_path_buf();
    within_60s("searches during the read phase", move || {
        let ix = small_machine(&path);
        ix.refresh(true);
        assert_eq!(ix.search(&q("redis"))["total"], 40);
        let proj = tiny_dir(&path);
        let mut overlapped = 0;
        for round in 0..3 {
            // Round 0: 2000 new files (the first launch without a cache); then every file grew.
            for n in 0..2000 {
                if round == 0 {
                    tiny(&proj, n);
                } else {
                    let line = json!({"type": "assistant", "message": {"role": "assistant", "content": format!("more {round}")}, "sessionId": format!("tiny-{n}"), "cwd": "D:\\tiny"});
                    let mut f = std::fs::OpenOptions::new().append(true).open(proj.join(format!("tiny-{n}.jsonl"))).unwrap();
                    writeln!(f, "{line}").unwrap();
                }
            }
            ix.start_refresh(true);
            overlapped += search_through_the_pass(&ix);
        }
        assert!(overlapped > 0, "no search ran during a pass");
        assert_eq!(ix.search(&q("tiny"))["total"], 2000);
    });
}

#[test]
fn a_search_of_a_big_index_while_a_pass_stats_vanishing_files_does_not_deadlock() {
    let dir = tempfile::tempdir().unwrap();
    big_index(dir.path());
    let path = dir.path().to_path_buf();
    within_60s("searches during the stat phase", move || {
        let ix = small_machine(&path);
        let proj = tiny_dir(&path);
        let files: Vec<PathBuf> = (0..6000).map(|n| tiny(&proj, n)).collect();
        ix.refresh(true);
        assert_eq!(ix.search(&q("redis"))["total"], 40);
        let mut overlapped = 0;
        for round in 0..3 {
            // Files deleted while the pass stats them are dropped by a pass job (the write lock).
            let gone: Vec<PathBuf> = files.iter().skip(round).step_by(3).cloned().collect();
            ix.start_refresh(true);
            let deleter = std::thread::spawn(move || {
                for f in gone {
                    let _ = std::fs::remove_file(f);
                }
            });
            overlapped += search_through_the_pass(&ix);
            deleter.join().unwrap();
        }
        assert!(overlapped > 0, "no search ran during a pass");
        ix.refresh(true);
        assert_eq!(ix.search(&q("tiny"))["total"], 0);
    });
}
