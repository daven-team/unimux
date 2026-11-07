//! The Rust half of the H5 bench (scripts/bench-convsearch.mjs runs 1.1.4's TS indexer on the same folders).
//!
//! `conv_bench <claude dir> <codex home> <scratch dir> <rounds> <query>...` prints one JSON line with the medians in ms:
//! `cold` (a full pass with no cache), `rescan` (a forced pass where nothing changed), `cached` (a new index that loads the
//! cache file one of the cold rounds saved and runs a pass, after all cold rounds; `load` is its load alone), `search` (each query, median over 20 runs on the full index) and `transcript` (the
//! preview of the largest file). Nothing outside the given folders is read or written.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use unimux_agents::conv::{ConvQuery, Indexer, IndexerOptions, Roots};

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 {
        eprintln!("usage: conv_bench <claude dir> <codex home> <scratch dir> <rounds> <query>...");
        std::process::exit(2);
    }
    let roots = Roots { claude: vec![args[0].clone()], codex: vec![args[1].clone()] };
    let scratch = PathBuf::from(&args[2]);
    let rounds: usize = args[3].parse().expect("rounds");
    let queries = &args[4..];
    let opts = |cache: Option<PathBuf>| {
        let mut o = IndexerOptions::new(roots.clone(), cache);
        o.fresh_ms = 0.0;
        o
    };

    let (mut cold, mut rescan, mut cached, mut loads) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut last: Option<Arc<Indexer>> = None;
    for round in 0..rounds {
        let cache = scratch.join(format!("conversation-index-v2-{round}.bin"));
        let ix = Arc::new(Indexer::new(opts(Some(cache))));
        let t = Instant::now();
        ix.load();
        ix.refresh(true);
        cold.push(ms(t));

        let t = Instant::now();
        ix.refresh(true);
        rescan.push(ms(t));

        ix.save();
        last = Some(ix);
    }
    // The saved files are read after all cold rounds, like the app reads its cache at a start (not right after writing it).
    for round in 0..rounds {
        let again = Arc::new(Indexer::new(opts(Some(scratch.join(format!("conversation-index-v2-{round}.bin"))))));
        let t = Instant::now();
        again.load();
        loads.push(ms(t));
        again.refresh(true);
        cached.push(ms(t));
    }
    let ix = last.expect("one round");

    let mut search = serde_json::Map::new();
    let mut hits = serde_json::Map::new();
    for q in queries {
        let query = ConvQuery { text: q.clone(), ..Default::default() };
        let mut times = Vec::new();
        let mut total = serde_json::Value::Null;
        for _ in 0..20 {
            let t = Instant::now();
            let r = ix.search(&query);
            times.push(ms(t));
            total = r.get("total").cloned().unwrap_or_default();
        }
        search.insert(q.clone(), serde_json::json!(median(times)));
        hits.insert(q.clone(), total);
    }

    let largest = ix.entries().into_iter().max_by_key(|e| e.size).map(|e| e.file).unwrap_or_default();
    let mut transcript = Vec::new();
    for _ in 0..rounds.max(3) {
        let t = Instant::now();
        let r = ix.transcript(&largest);
        transcript.push(ms(t));
        assert_eq!(r.get("ok"), Some(&serde_json::Value::Bool(true)), "transcript of {largest}");
    }

    let out = serde_json::json!({
        "files": ix.size(),
        "cold": median(cold),
        "rescan": median(rescan),
        "cached": median(cached),
        "load": median(loads),
        "search": search,
        "hits": hits,
        "transcript": median(transcript),
    });
    println!("{out}");
}
