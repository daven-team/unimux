//! Commands of the `files` domain: G5-G8: project files, file ops, search, notes, fs probes, monitor, changelog, local pane (fs:*, local:*, notes:*, monitor:*, changelog:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! G5: the project files of the Files panel and the editor (`fs:listProjectDirectory`, `fs:listProjectDirectoryBatch`,
//! `fs:listProjectDirectories`, `fs:statProjectFile`, `fs:readProjectFile`, `fs:writeProjectFile`) and the editor's local
//! files of the SFTP view (`local:readFile`, `local:statFile`, `local:writeFile`). The file system work runs on the blocking
//! pool (a slow network share never stalls the IPC threads).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use unimux_files::local::{LocalFiles, LocalPlatform};
use unimux_files::preview::Preview;
use unimux_files::project::{self, DIRECTORIES_LIMIT};
use unimux_files::save::{self, SaveResult};
use unimux_ipc::{IpcError, Reply, RouterBuilder};

use crate::context::AppContext;

const GONE: &str = "Projekt już nie istnieje.";

/// The folder of the project `id` (`state.projects.find((p) => p.id === projectId)?.path`).
fn project_path(ctx: &AppContext, id: &Value) -> Option<String> {
    let state = ctx.state.get();
    let projects = state.get("projects")?.as_array()?;
    let project = projects.iter().find(|p| p.get("id") == Some(id) && !id.is_null())?;
    project.get("path")?.as_str().map(str::to_string)
}

/// Runs blocking file work off the async threads.
async fn blocking<T: Send + 'static>(command: &str, f: impl FnOnce() -> T + Send + 'static) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IpcError::failed(command, e.to_string()))
}

fn preview_reply(preview: Preview) -> Reply {
    match preview.into_reply() {
        (value, parts) if parts.is_empty() => Reply::Json(value),
        (value, parts) => Reply::Binary { value, parts },
    }
}

fn opt_string(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// The folders the editor never reads or writes through `local:*`: the data dir (state, vault, logs), the WebView2 folders
/// and the installed app (1.1.4: DATA_DIR, userData, the exe folder, the app path).
fn forbidden_roots(ctx: &AppContext) -> Vec<String> {
    let mut roots: Vec<PathBuf> = vec![ctx.data_dir.clone(), ctx.data_dir.join("webview2")];
    if let Some(exe_dir) = std::env::current_exe().ok().as_deref().and_then(Path::parent) {
        roots.push(exe_dir.to_path_buf());
        // macOS: the bundle's Resources next to Contents/MacOS (Electron's app path lives there).
        if cfg!(target_os = "macos")
            && let Some(contents) = exe_dir.parent()
        {
            roots.push(contents.join("Resources"));
        }
    }
    if cfg!(windows) {
        // The update window's own WebView2 folders and runtime copies (unimux-update).
        roots.push(unimux_core::home::local_app_data_dir().join("unimux-updater"));
    }
    if cfg!(target_os = "macos") {
        let home = unimux_core::home::home_dir();
        for id in ["com.ajzakomator.app", "com.unimux.app"] {
            roots.push(home.join("Library/WebKit").join(id));
            roots.push(home.join("Library/Caches").join(id));
        }
    }
    roots.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let c = ctx.clone();
    r.invoke("fs:listProjectDirectory", move |call| {
        let c = c.clone();
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(json!({ "ok": false, "error": GONE })) };
            // `path = ''`: an omitted path (undefined arrives as null) lists the project folder.
            let path = if call.arg(1).is_null() { Some(String::new()) } else { opt_string(call.arg(1)) };
            blocking(&call.command, move || project::list_project_directory(&root, path.as_deref(), None)).await
        }
    });

    let c = ctx.clone();
    r.invoke("fs:listProjectDirectoryBatch", move |call| {
        let c = c.clone();
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(json!({})) };
            let paths = call.arg(1).clone();
            blocking(&call.command, move || project::list_project_directory_batch(&root, &paths)).await
        }
    });

    let c = ctx.clone();
    r.invoke("fs:listProjectDirectories", move |call| {
        let c = c.clone();
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(json!({ "ok": false, "error": GONE })) };
            blocking(&call.command, move || project::list_project_directories(&root, DIRECTORIES_LIMIT)).await
        }
    });

    let c = ctx.clone();
    r.invoke("fs:statProjectFile", move |call| {
        let c = c.clone();
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(Value::Null) };
            let path = opt_string(call.arg(1));
            blocking(&call.command, move || project::stat_project_file(&root, path.as_deref())).await
        }
    });

    let c = ctx.clone();
    r.invoke_reply("fs:readProjectFile", move |call| {
        let c = c.clone();
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(preview_reply(Preview::error(GONE))) };
            let path = opt_string(call.arg(1));
            let limit = project::read_limit(call.arg(2) == &Value::Bool(true));
            let preview = blocking(&call.command, move || project::read_project_file(&root, path.as_deref(), limit)).await?;
            Ok(preview_reply(preview))
        }
    });

    let c = ctx.clone();
    r.invoke("fs:writeProjectFile", move |call| {
        let c = c.clone();
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(SaveResult::Failed(GONE.into()).to_json()) };
            let (path, text, expected) = (opt_string(call.arg(1)), opt_string(call.arg(2)), opt_string(call.arg(3)));
            // The bridge's marker: the new text held an unpaired surrogate (transport.ts markIllFormedText).
            let ill_formed = call.arg(4) == &Value::Bool(true);
            let result = blocking(&call.command, move || {
                save::write_text(
                    &|| project::project_file_path(&root, path.as_deref(), None),
                    text.as_deref(),
                    ill_formed,
                    expected.as_deref(),
                )
            })
            .await?;
            Ok(result.to_json())
        }
    });

    let local = Arc::new(LocalFiles::new(LocalPlatform::native(), forbidden_roots(ctx)));
    // A reload of the main page: what it opened may be written no more (restored drafts read again before they save).
    let gone = local.clone();
    ctx.on_main_page_started(move || gone.renderer_gone());

    let l = local.clone();
    r.invoke_reply("local:readFile", move |call| {
        let l = l.clone();
        async move {
            let path = opt_string(call.arg(0));
            let preview = blocking(&call.command, move || l.read_file(path.as_deref())).await?;
            Ok(preview_reply(preview))
        }
    });

    let l = local.clone();
    r.invoke("local:statFile", move |call| {
        let l = l.clone();
        async move {
            let path = opt_string(call.arg(0));
            blocking(&call.command, move || l.stat_file(path.as_deref())).await
        }
    });

    let l = local;
    r.invoke("local:writeFile", move |call| {
        let l = l.clone();
        async move {
            let (path, text, expected) = (opt_string(call.arg(0)), opt_string(call.arg(1)), opt_string(call.arg(2)));
            let ill_formed = call.arg(3) == &Value::Bool(true);
            let result =
                blocking(&call.command, move || l.write_text(path.as_deref(), text.as_deref(), ill_formed, expected.as_deref()))
                    .await?;
            Ok(result.to_json())
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};
    use unimux_ipc::{Call, Caller, Contract, Router};

    fn context(data: &Path, project: &Path) -> Arc<AppContext> {
        AppContext::new(
            data.to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(data)),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(data.join("startup.log"), "")),
            json!({ "version": 1, "projects": [{ "id": "p1", "path": project.to_string_lossy() }] }),
        )
    }

    fn router(ctx: &Arc<AppContext>) -> Router {
        let mut builder = RouterBuilder::new(Contract::embedded());
        register(&mut builder, ctx);
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        builder.build(ctx.guard.clone())
    }

    fn call(router: &Router, command: &str, args: Value) -> Reply {
        let caller =
            Caller::new("main", "http://tauri.localhost/index.html").with_request_origin(Some("http://tauri.localhost".into()));
        let call = Call::new(command, caller, args.as_array().unwrap().clone());
        tauri::async_runtime::block_on(router.invoke(call)).unwrap()
    }

    fn json_of(reply: Reply) -> Value {
        match reply {
            Reply::Json(v) => v,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn forbidden_roots_cover_the_app_folders() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path(), dir.path());
        let roots = forbidden_roots(&ctx);
        let data = dir.path().to_string_lossy().into_owned();
        assert!(roots.contains(&data));
        assert!(roots.iter().any(|r| r.ends_with("webview2")));
        let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_string_lossy().into_owned();
        assert!(roots.contains(&exe_dir));
        ctx.saver.stop();
    }

    #[test]
    fn the_project_channels_answer_like_1_1_4() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir(project.path().join("src")).unwrap();
        std::fs::write(project.path().join("a.txt"), "one\r\n").unwrap();
        std::fs::write(project.path().join("pic.png"), [0x89, b'P', b'N', b'G']).unwrap();
        let ctx = context(data.path(), project.path());
        let r = router(&ctx);
        let listing = json_of(call(&r, "fs:listProjectDirectory", json!(["p1", null])));
        assert_eq!(listing["entries"][0], json!({ "name": "src", "path": "src", "kind": "directory" }));
        assert_eq!(json_of(call(&r, "fs:listProjectDirectory", json!(["nope", ""]))), json!({ "ok": false, "error": GONE }));
        assert_eq!(json_of(call(&r, "fs:listProjectDirectoryBatch", json!(["nope", [""]]))), json!({}));
        assert_eq!(
            json_of(call(&r, "fs:listProjectDirectories", json!(["p1"]))),
            json!({ "ok": true, "paths": ["src"], "truncated": false })
        );
        assert_eq!(json_of(call(&r, "fs:statProjectFile", json!(["p1", "a.txt"])))["size"], 5);
        assert_eq!(json_of(call(&r, "fs:statProjectFile", json!(["nope", "a.txt"]))), Value::Null);
        assert_eq!(
            json_of(call(&r, "fs:readProjectFile", json!(["p1", "a.txt", null]))),
            json!({ "kind": "text", "text": "one\r\n", "size": 5, "truncated": false })
        );
        match call(&r, "fs:readProjectFile", json!(["p1", "pic.png", true])) {
            Reply::Binary { value, parts } => {
                assert_eq!(value["dataUrl"], json!({ "$mcBytes": 0 }));
                assert_eq!(parts, vec![vec![0x89, b'P', b'N', b'G']]);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(json_of(call(&r, "fs:writeProjectFile", json!(["p1", "a.txt", "two\n", "one\r\n"]))), json!({ "ok": true }));
        assert_eq!(std::fs::read_to_string(project.path().join("a.txt")).unwrap(), "two\r\n");
        assert_eq!(
            json_of(call(&r, "fs:writeProjectFile", json!(["nope", "a.txt", "x", "y"]))),
            json!({ "ok": false, "error": GONE })
        );
        // The bridge's ill-formed marker (a lone surrogate in the new text): checked where 1.1.4 checked it, after the
        // project lookup and the conflict.
        let invalid = json!({ "ok": false, "error": "Nieprawidłowa treść pliku." });
        assert_eq!(
            json_of(call(&r, "fs:writeProjectFile", json!(["nope", "a.txt", "x\u{fffd}", "y", true]))),
            json!({ "ok": false, "error": GONE })
        );
        assert_eq!(
            json_of(call(&r, "fs:writeProjectFile", json!(["p1", "a.txt", "x\u{fffd}", "stale", true])))["code"],
            "conflict"
        );
        assert_eq!(json_of(call(&r, "fs:writeProjectFile", json!(["p1", "a.txt", "x\u{fffd}", "two\r\n", true]))), invalid);
        assert_eq!(std::fs::read_to_string(project.path().join("a.txt")).unwrap(), "two\r\n");
        ctx.saver.stop();
    }

    #[test]
    fn local_files_are_forgotten_when_the_main_page_reloads() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("n.txt");
        std::fs::write(&file, "a").unwrap();
        let path = file.to_string_lossy().into_owned();
        let ctx = context(data.path(), outside.path());
        let r = router(&ctx);
        assert_eq!(json_of(call(&r, "local:readFile", json!([path])))["text"], "a");
        assert_eq!(json_of(call(&r, "local:statFile", json!([path])))["size"], 1);
        assert_eq!(json_of(call(&r, "local:writeFile", json!([path, "b", "a"]))), json!({ "ok": true }));
        ctx.main_page_started();
        assert_eq!(
            json_of(call(&r, "local:writeFile", json!([path, "c", "b"]))),
            json!({ "ok": false, "error": "Ten plik nie został otwarty w edytorze." })
        );
        // Not opened wins over the ill-formed marker (1.1.4 checked the opened set first), then the conflict does.
        assert_eq!(
            json_of(call(&r, "local:writeFile", json!([path, "c\u{fffd}", "b", true]))),
            json!({ "ok": false, "error": "Ten plik nie został otwarty w edytorze." })
        );
        assert_eq!(json_of(call(&r, "local:readFile", json!([path])))["text"], "b");
        assert_eq!(json_of(call(&r, "local:writeFile", json!([path, "c\u{fffd}", "x", true])))["code"], "conflict");
        assert_eq!(
            json_of(call(&r, "local:writeFile", json!([path, "c\u{fffd}", "b", true]))),
            json!({ "ok": false, "error": "Nieprawidłowa treść pliku." })
        );
        // The data dir is never read for the editor.
        let state = data.path().join("state.json");
        std::fs::write(&state, "{}").unwrap();
        assert_eq!(
            json_of(call(&r, "local:readFile", json!([state.to_string_lossy()]))),
            json!({ "kind": "error", "message": "Tego miejsca nie można edytować w aplikacji." })
        );
        ctx.saver.stop();
    }
}
