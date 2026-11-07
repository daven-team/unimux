//! Commands of the `agents` domain: H1-H6: CLI detection and install, sessions, context, conversation search, agent prompts (cli:*, install:*, codex:*, context:*, sessions:*, conv:*, agents:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).

use std::sync::Arc;

use parking_lot::Mutex;

use serde_json::Value;
use unimux_agents::conv::service::{self, ConvSearchService};
use unimux_ipc::RouterBuilder;

use crate::context::AppContext;

/// The conversation search of the app (H5), kept so the exit can let it save its index (the last registered one).
static CONV: Mutex<Option<Arc<ConvSearchService>>> = Mutex::new(None);

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    register_conv(r, ctx);
}

/// What the app does for this domain when it exits: the conversation index saves itself (1.1.4's `will-quit` stop).
pub fn on_exit() {
    let conv = CONV.lock().clone();
    if let Some(conv) = conv {
        conv.stop();
    }
}

/// Runs a blocking conversation search call off the async runtime; a failed join answers `fallback`.
async fn blocking(work: impl FnOnce() -> Value + Send + 'static, fallback: impl FnOnce() -> Value) -> Value {
    tauri::async_runtime::spawn_blocking(work).await.unwrap_or_else(|_| fallback())
}

/// conv:search, conv:transcript, conv:export (H5): the index lives in a Rust thread instead of 1.1.4's eval'd worker.
fn register_conv(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let conv = ConvSearchService::for_data_dir(ctx.data_dir.clone());
    *CONV.lock() = Some(conv.clone());

    let c = conv.clone();
    r.invoke("conv:search", move |call| {
        let c = c.clone();
        async move {
            let query = service::sanitize_query(call.arg(0));
            Ok(blocking(move || c.search(query), || service::search_failed(None)).await)
        }
    });

    let c = conv.clone();
    r.invoke("conv:transcript", move |call| {
        let c = c.clone();
        async move {
            let Some(file) = call.arg(0).as_str().filter(|f| !f.is_empty()).map(str::to_string) else {
                return Ok(service::transcript_failed(None));
            };
            Ok(blocking(move || c.transcript(file), || service::transcript_failed(None)).await)
        }
    });

    let c = conv;
    r.invoke("conv:export", move |call| {
        let c = c.clone();
        async move {
            let Some(source) = service::sanitize_export_source(call.arg(0)) else { return Ok(service::no_export()) };
            Ok(blocking(move || c.export_data(source), service::no_export).await)
        }
    });
}

#[cfg(test)]
mod tests {
    //! The conv:* wiring. Only answers that never start the index (a search would read the CLI folders of the environment);
    //! the index itself is tested in unimux-agents (tests/conv_index.rs, tests/conv_golden.rs).
    use super::*;
    use std::time::Instant;
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};
    use unimux_ipc::router::Status;
    use unimux_ipc::{Call, Caller, Contract, Guard, Reply};

    struct Open;
    impl Guard for Open {
        fn allowed(&self, _: &Caller) -> bool {
            true
        }
    }

    #[test]
    fn conv_channels_answer_bad_requests_like_main_without_starting_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = AppContext::new(
            dir.path().to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir.path())),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.path().join("startup.log"), "")),
            serde_json::json!({"version": 1, "projects": []}),
        );
        let mut builder = RouterBuilder::new(Contract::embedded());
        register(&mut builder, &ctx);
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        let router = builder.build(Arc::new(Open));
        for channel in ["conv:search", "conv:transcript", "conv:export"] {
            assert_eq!(router.status(channel), Status::Implemented, "{channel}");
        }
        let ask = |channel: &str, args: Vec<Value>| match tauri::async_runtime::block_on(router.invoke(Call::new(
            channel,
            Caller::new("main", "http://tauri.localhost/"),
            args,
        ))) {
            Ok(Reply::Json(v)) => v,
            _ => panic!("{channel}: no JSON answer"),
        };
        let refused = serde_json::json!({"ok": false, "messages": [], "capped": false});
        assert_eq!(ask("conv:transcript", vec![]), refused);
        assert_eq!(ask("conv:transcript", vec![serde_json::json!("")]), refused);
        assert_eq!(ask("conv:transcript", vec![serde_json::json!(5)]), refused);
        assert_eq!(ask("conv:export", vec![]), service::no_export());
        assert_eq!(ask("conv:export", vec![serde_json::json!({"cli": "claude", "id": "../x"})]), service::no_export());
        assert_eq!(ask("conv:export", vec![serde_json::json!({"cli": "gemini", "id": "abc"})]), service::no_export());
        let conv = CONV.lock().clone().expect("registered");
        assert!(!conv.running(), "a refused request must not start the index");
        on_exit();
        assert!(!dir.path().join("conversation-index-v2.bin").exists());
        ctx.saver.stop();
    }
}
