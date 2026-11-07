//! Runs the Rust CLI detector once on this machine with the real I/O and prints `{ ms, map }` as JSON (used by
//! scripts/verify-cli-detect.mjs to compare with the TS detector of 1.1.4). MC_CLI_NO_REGISTRY=1 and MC_CLI_PROBE_PROFILE are
//! honoured like in a dev-overrides build; the shell kind comes from the first argument (default: powershell / zsh).
//! H3_EACH=1 first times each CLI on its own (stderr).

use std::sync::Arc;
use std::time::Instant;

use unimux_agents::cli::{CliDetector, SystemCliDeps, SystemOptions};

#[tokio::main]
async fn main() {
    let shell = std::env::args().nth(1);
    let options = SystemOptions {
        disable_registry: std::env::var("MC_CLI_NO_REGISTRY").as_deref() == Ok("1"),
        shell: shell.map(|s| Arc::new(move || Some(s.clone())) as Arc<dyn Fn() -> Option<String> + Send + Sync>),
        probe_profile: std::env::var("MC_CLI_PROBE_PROFILE").ok().filter(|p| !p.is_empty()),
    };
    let detector = CliDetector::new(SystemCliDeps::new(options));
    if std::env::var("H3_EACH").as_deref() == Ok("1") {
        // One CLI after the other, each timed (where the time goes).
        for cli in unimux_agents::cli::CliId::ALL {
            let t = Instant::now();
            let s = detector.get(cli, unimux_agents::cli::GetOptions { wait_ms: 0, force: true }).await;
            eprintln!("{} {:?} {} ms", cli.as_str(), s.version, t.elapsed().as_millis());
        }
    }
    let started = Instant::now();
    let map = detector.refresh_all().await;
    let ms = started.elapsed().as_millis() as u64;
    println!("{}", serde_json::json!({ "ms": ms, "map": map }));
}
