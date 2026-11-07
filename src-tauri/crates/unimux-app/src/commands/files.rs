//! Commands of the `files` domain: G5-G8: project files, file ops, search, notes, fs probes, monitor, changelog, local pane (fs:*, local:*, notes:*, monitor:*, changelog:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! G5: the project files of the Files panel and the editor (`fs:listProjectDirectory`, `fs:listProjectDirectoryBatch`,
//! `fs:listProjectDirectories`, `fs:statProjectFile`, `fs:readProjectFile`, `fs:writeProjectFile`) and the editor's local
//! files of the SFTP view (`local:readFile`, `local:statFile`, `local:writeFile`). The file system work runs on the blocking
//! pool (a slow network share never stalls the IPC threads).
//!
//! G6: the file operations of the tree (`fs:renameEntry`, `fs:createEntry`, `fs:deleteEntries`, `fs:transfer` with its
//! `fs:progress` events at most every 120 ms, `fs:cancelOp`) and the SFTP view's local pane (`local:list`, `:roots`,
//! `:mkdir`, `:rename`, `:trash`, `:reveal`). Deleted and replaced items go to the OS trash (MC_TRASH_DIR in dev builds).
//!
//! G7: project search and replace (`fs:searchProject`, `fs:replaceInProject`). A new search of a window cancels its running
//! one (1.1.4 kept one AbortController per sender); the cancelled search answers the empty, truncated result nobody shows.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_files::fileops::{self, OpOptions, TrashFn};
use unimux_files::fserr::FsError;
use unimux_files::fsx;
use unimux_files::jspath::{self, Flavor};
use unimux_files::local::{LocalFiles, LocalPlatform};
use unimux_files::pane::{LocalPane, PaneDeps};
use unimux_files::preview::Preview;
use unimux_files::project::{self, DIRECTORIES_LIMIT};
use unimux_files::save::{self, SaveResult};
use unimux_files::search;
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

/// The running search of every window (by label): its id and cancel flag. A new search of a window (typing goes on) stops
/// the previous one, whose answer nobody shows.
#[derive(Default)]
struct SearchRuns {
    next: AtomicU64,
    running: parking_lot::Mutex<HashMap<String, (u64, Arc<AtomicBool>)>>,
    /// Held by tests so that searches wait before they walk the project until the test has started them all.
    #[cfg(test)]
    gate: parking_lot::RwLock<()>,
}

impl SearchRuns {
    /// A new search of window `label`: its id and cancel flag; the search it replaces is told to stop.
    fn start(&self, label: &str) -> (u64, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let flag = Arc::new(AtomicBool::new(false));
        if let Some((_, previous)) = self.running.lock().insert(label.to_string(), (id, flag.clone())) {
            previous.store(true, Ordering::SeqCst);
        }
        (id, flag)
    }

    /// The search `id` of window `label` ended: forgotten unless a newer one of the window replaced it.
    fn finish(&self, label: &str, id: u64) {
        let mut running = self.running.lock();
        if running.get(label).is_some_and(|(current, _)| *current == id) {
            running.remove(label);
        }
    }

    #[cfg(test)]
    fn current(&self, label: &str) -> Option<u64> {
        self.running.lock().get(label).map(|(id, _)| *id)
    }
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

    register_search(r, ctx, Arc::default());

    let c = ctx.clone();
    r.invoke("fs:replaceInProject", move |call| {
        let c = c.clone();
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(json!({ "ok": false, "error": GONE })) };
            let request = call.arg(1).clone();
            blocking(&call.command, move || search::replace_in_project(&root, &request)).await?.map_err(|e| call.fail(e.0))
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

    register_file_ops(r, ctx);
    register_local_pane(r, ctx);
}

/// The OS trash (Electron's shell.trashItem: the Recycle Bin through IFileOperation, NSFileManager on macOS). With
/// dev-overrides MC_TRASH_DIR redirects it into a folder (`<8 hex>-<name>`), so UI checks never touch the real bin.
pub fn trash_fn(ctx: &AppContext) -> Arc<TrashFn> {
    match ctx.overrides.trash_dir.clone() {
        Some(dir) => Arc::new(move |path: &str| {
            let folder = dir.to_string_lossy().into_owned();
            std::fs::create_dir_all(&dir).map_err(|e| FsError::io(&e, "mkdir", &folder))?;
            let id = uuid::Uuid::new_v4().to_string();
            let name = format!("{}-{}", &id[..8], jspath::basename(Flavor::native(), path));
            fsx::rename(path, &jspath::join_name(Flavor::native(), &folder, &name))
        }),
        None => Arc::new(|path: &str| unimux_platform::shell::trash_item(Path::new(path)).map_err(FsError::plain)),
    }
}

/// G6: rename, create, delete to the trash, copy / move with progress (`fs:progress`) and cancel (`fs:cancelOp`).
fn register_file_ops(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let trash = trash_fn(ctx);
    let platform = LocalPlatform::native();
    // opId -> its cancel flag while the transfer runs (1.1.4's `running` map of AbortControllers).
    let running: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> = Arc::default();

    let c = ctx.clone();
    r.invoke("fs:renameEntry", move |call| {
        let c = c.clone();
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(json!({ "ok": false, "error": GONE })) };
            let (path, name) = (call.arg(1).clone(), call.arg(2).clone());
            blocking(&call.command, move || fileops::rename_project_entry(&root, &path, &name, platform)).await
        }
    });

    let c = ctx.clone();
    r.invoke("fs:createEntry", move |call| {
        let c = c.clone();
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(json!({ "ok": false, "error": GONE })) };
            let (dir, name) = (call.arg(1).clone(), call.arg(2).clone());
            let folder = call.arg(3) == &json!("directory");
            blocking(&call.command, move || fileops::create_project_entry(&root, &dir, &name, folder, platform)).await
        }
    });

    let (c, t) = (ctx.clone(), trash.clone());
    r.invoke("fs:deleteEntries", move |call| {
        let (c, t) = (c.clone(), t.clone());
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(json!({ "ok": false, "error": GONE })) };
            let paths = call.arg(1).clone();
            blocking(&call.command, move || fileops::delete_project_entries(&root, &paths, &*t)).await
        }
    });

    let (c, t, run) = (ctx.clone(), trash, running.clone());
    r.invoke("fs:transfer", move |call| {
        let (c, t, run) = (c.clone(), t.clone(), run.clone());
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(json!({ "ok": false, "error": GONE })) };
            let request = call.arg(1).clone();
            let op_id =
                request.get("opId").and_then(Value::as_str).filter(|id| id.encode_utf16().count() <= 100).map(str::to_string);
            let cancel = Arc::new(AtomicBool::new(false));
            let mut options = OpOptions::new(t);
            options.platform = platform;
            options.cancel = Some(cancel.clone());
            if let Some(id) = &op_id {
                run.lock().insert(id.clone(), cancel);
                let (events, id) = (c.events.clone(), id.clone());
                options.on_progress = Some(Box::new(move |entries, bytes| {
                    events.send("fs:progress", vec![json!({ "opId": id, "entries": entries, "bytes": bytes })]);
                }));
            }
            let result = blocking(&call.command, move || fileops::transfer_project_entries(&root, &request, &options)).await;
            if let Some(id) = &op_id {
                run.lock().remove(id);
            }
            result
        }
    });

    r.send("fs:cancelOp", move |call| {
        let flag = call.arg(0).as_str().and_then(|id| running.lock().get(id).cloned());
        async move {
            if let Some(flag) = flag {
                flag.store(true, Ordering::SeqCst);
            }
        }
    });
}

/// G6: the SFTP view's local pane (`local:list`, `:roots`, `:mkdir`, `:rename`, `:trash`, `:reveal`). Explorer and Finder
/// go through the os service's desktop, so an offscreen check run records them instead of opening a window.
fn register_local_pane(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let (open_ctx, show_ctx) = (Arc::downgrade(ctx), Arc::downgrade(ctx));
    let pane = Arc::new(LocalPane::new(PaneDeps {
        platform: LocalPlatform::native(),
        trash: trash_fn(ctx),
        open_folder: Box::new(move |path: &str| {
            if let Some(os) = open_ctx.upgrade().and_then(|c| c.os.get().cloned()) {
                os.desktop.open_path(path);
            }
            Ok(())
        }),
        show_file: Box::new(move |path: &str| {
            if let Some(os) = show_ctx.upgrade().and_then(|c| c.os.get().cloned()) {
                os.desktop.reveal(path);
            }
        }),
        home: Box::new(|| unimux_core::home::home_dir().to_string_lossy().into_owned()),
    }));

    let p = pane.clone();
    r.invoke("local:list", move |call| {
        let p = p.clone();
        async move {
            let path = call.arg(0).clone();
            blocking(&call.command, move || p.list(&path)).await
        }
    });
    let p = pane.clone();
    r.invoke("local:roots", move |call| {
        let p = p.clone();
        async move { blocking(&call.command, move || p.roots()).await }
    });
    let p = pane.clone();
    r.invoke("local:mkdir", move |call| {
        let p = p.clone();
        async move {
            let path = call.arg(0).clone();
            blocking(&call.command, move || p.mkdir(&path)).await
        }
    });
    let p = pane.clone();
    r.invoke("local:rename", move |call| {
        let p = p.clone();
        async move {
            let (from, to) = (call.arg(0).clone(), call.arg(1).clone());
            blocking(&call.command, move || p.rename(&from, &to)).await
        }
    });
    let p = pane.clone();
    r.invoke("local:trash", move |call| {
        let p = p.clone();
        async move {
            let paths = call.arg(0).clone();
            blocking(&call.command, move || p.trash(&paths)).await
        }
    });
    let p = pane;
    r.invoke("local:reveal", move |call| {
        let p = p.clone();
        async move {
            let path = call.arg(0).clone();
            blocking(&call.command, move || p.reveal(&path)).await
        }
    });
}

/// `fs:searchProject` with the running searches of the windows (`runs`).
fn register_search(r: &mut RouterBuilder, ctx: &Arc<AppContext>, runs: Arc<SearchRuns>) {
    let c = ctx.clone();
    r.invoke("fs:searchProject", move |call| {
        let (c, runs) = (c.clone(), runs.clone());
        async move {
            let Some(root) = project_path(&c, call.arg(0)) else { return Ok(json!({ "ok": false, "error": GONE })) };
            let label = call.caller.label.clone();
            let (id, flag) = runs.start(&label);
            let options = call.arg(1).clone();
            #[cfg(test)]
            let walk = runs.clone();
            let result = blocking(&call.command, move || {
                #[cfg(test)]
                let _gate = walk.gate.read();
                search::search_project(&root, &options, &search::clock(), Some(&flag))
            })
            .await;
            runs.finish(&label, id);
            result?.map_err(|e| call.fail(e.0))
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

    fn context_with_trash(data: &Path, project: &Path, trash: &Path) -> Arc<AppContext> {
        let overrides = DevOverrides { trash_dir: Some(trash.to_path_buf()), ..DevOverrides::default() };
        AppContext::new(
            data.to_path_buf(),
            overrides,
            Arc::new(RollingLog::crash_log(data)),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(data.join("startup.log"), "")),
            json!({ "version": 1, "projects": [{ "id": "p1", "path": project.to_string_lossy() }] }),
        )
    }

    #[test]
    fn the_file_op_channels_answer_like_1_1_4() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let trash = tempfile::tempdir().unwrap();
        let bin = trash.path().join("bin");
        std::fs::create_dir(project.path().join("docs")).unwrap();
        std::fs::write(project.path().join("a.txt"), "A").unwrap();
        std::fs::write(project.path().join("docs").join("a.txt"), "old").unwrap();
        let ctx = context_with_trash(data.path(), project.path(), &bin);
        let r = router(&ctx);
        let gone = json!({ "ok": false, "error": GONE });
        assert_eq!(json_of(call(&r, "fs:renameEntry", json!(["nope", "a.txt", "b.txt"]))), gone);
        assert_eq!(json_of(call(&r, "fs:createEntry", json!(["nope", "", "x", "file"]))), gone);
        assert_eq!(json_of(call(&r, "fs:deleteEntries", json!(["nope", ["a.txt"]]))), gone);
        assert_eq!(json_of(call(&r, "fs:transfer", json!(["nope", { "kind": "copy" }]))), gone);
        assert_eq!(
            json_of(call(&r, "fs:createEntry", json!(["p1", "", "new", "directory"]))),
            json!({ "ok": true, "path": "new" })
        );
        assert!(project.path().join("new").is_dir());
        // Any other kind makes a file (1.1.4: kind === 'directory' ? 'directory' : 'file').
        assert_eq!(
            json_of(call(&r, "fs:createEntry", json!(["p1", "new", "f", "folder"]))),
            json!({ "ok": true, "path": "new/f" })
        );
        assert!(project.path().join("new").join("f").is_file());
        assert_eq!(
            json_of(call(&r, "fs:renameEntry", json!(["p1", "new/f", "g.txt"]))),
            json!({ "ok": true, "from": "new/f", "to": "new/g.txt" })
        );
        // Replace: the old docs/a.txt goes to MC_TRASH_DIR as `<8 hex>-a.txt`, never deleted.
        let moved = json_of(call(
            &r,
            "fs:transfer",
            json!(["p1", { "kind": "move", "paths": ["a.txt"], "destination": "docs", "conflict": "replace", "opId": "op-1" }]),
        ));
        assert_eq!(moved["done"], json!([{ "from": "a.txt", "to": "docs/a.txt" }]));
        assert_eq!(moved["replaced"], json!(["docs/a.txt"]));
        let binned: Vec<String> =
            std::fs::read_dir(&bin).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(binned.len(), 1);
        assert!(binned[0].len() == 8 + "-a.txt".len() && binned[0].ends_with("-a.txt"), "{binned:?}");
        assert_eq!(std::fs::read_to_string(bin.join(&binned[0])).unwrap(), "old");
        let deleted = json_of(call(&r, "fs:deleteEntries", json!(["p1", ["new"]])));
        assert_eq!(deleted, json!({ "ok": true, "trashed": ["new"], "failed": [] }));
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 2);
        // A cancel of an unknown or finished operation is ignored.
        let caller =
            Caller::new("main", "http://tauri.localhost/index.html").with_request_origin(Some("http://tauri.localhost".into()));
        r.admit_send("fs:cancelOp", &caller).unwrap();
        tauri::async_runtime::block_on(r.run_send(Call::new("fs:cancelOp", caller, vec![json!("op-1")])));
        ctx.saver.stop();
    }

    #[test]
    fn the_local_pane_channels_answer_like_1_1_4() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let trash = tempfile::tempdir().unwrap();
        let ctx = context_with_trash(data.path(), outside.path(), &trash.path().join("bin"));
        let r = router(&ctx);
        let dir = outside.path().to_string_lossy().into_owned();
        let at = |n: &str| outside.path().join(n).to_string_lossy().into_owned();
        assert_eq!(json_of(call(&r, "local:mkdir", json!([at("sub")]))), json!({ "ok": true, "value": null }));
        std::fs::write(outside.path().join("a.txt"), "abc").unwrap();
        let listing = json_of(call(&r, "local:list", json!([dir])));
        assert_eq!(listing["ok"], true);
        assert_eq!(listing["value"]["entries"].as_array().unwrap().len(), 2);
        assert_eq!(json_of(call(&r, "local:rename", json!([at("a.txt"), at("b.txt")]))), json!({ "ok": true, "value": null }));
        assert_eq!(json_of(call(&r, "local:trash", json!([[at("b.txt")]]))), json!({ "ok": true, "value": null }));
        assert!(!outside.path().join("b.txt").exists());
        assert_eq!(std::fs::read_dir(trash.path().join("bin")).unwrap().count(), 1);
        // No os service in this test: reveal answers ok and shows nothing.
        assert_eq!(json_of(call(&r, "local:reveal", json!([at("sub")]))), json!({ "ok": true, "value": null }));
        assert_eq!(json_of(call(&r, "local:reveal", json!(["relative"]))), json!({ "ok": false, "error": "invalid" }));
        let roots = json_of(call(&r, "local:roots", json!([])));
        assert_eq!(roots["home"], json!(unimux_core::home::home_dir().to_string_lossy()));
        assert_eq!(roots["drives"].as_array().unwrap().is_empty(), !cfg!(windows));
        ctx.saver.stop();
    }

    #[test]
    fn search_and_replace_answer_like_1_1_4() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("a.txt"), "żółw token\r\nŻÓŁW 😀 token\n").unwrap();
        let ctx = context(data.path(), project.path());
        let r = router(&ctx);
        let found = json_of(call(&r, "fs:searchProject", json!(["p1", { "query": "żółw" }])));
        assert_eq!(found["matches"], 2);
        assert_eq!(found["files"][0]["matches"][1]["preview"], "ŻÓŁW 😀 token");
        assert_eq!(
            json_of(call(&r, "fs:searchProject", json!(["nope", { "query": "a" }]))),
            json!({ "ok": false, "error": GONE })
        );
        // A malformed request rejects (1.1.4 threw a TypeError).
        let caller =
            Caller::new("main", "http://tauri.localhost/index.html").with_request_origin(Some("http://tauri.localhost".into()));
        let thrown =
            tauri::async_runtime::block_on(r.invoke(Call::new("fs:searchProject", caller, vec![json!("p1"), Value::Null])));
        assert!(thrown.is_err());
        let replaced = json_of(call(
            &r,
            "fs:replaceInProject",
            json!(["p1", { "options": { "query": "token" }, "replacement": "😀", "scope": { "kind": "all" } }]),
        ));
        assert_eq!(replaced, json!({ "ok": true, "replaced": 2, "files": [{ "path": "a.txt", "replaced": 2 }] }));
        assert_eq!(std::fs::read_to_string(project.path().join("a.txt")).unwrap(), "żółw 😀\r\nŻÓŁW 😀 😀\n");
        assert_eq!(
            json_of(call(&r, "fs:replaceInProject", json!(["nope", { "options": {}, "replacement": "", "scope": {} }]))),
            json!({ "ok": false, "error": GONE })
        );
        ctx.saver.stop();
    }

    #[test]
    fn search_runs_are_kept_per_window() {
        let runs = SearchRuns::default();
        let (a, first) = runs.start("main");
        let (b, second) = runs.start("main");
        assert!(first.load(Ordering::SeqCst), "a new search of the window stops the previous one");
        assert!(!second.load(Ordering::SeqCst));
        let (c, other) = runs.start("detached-abc");
        assert!(!second.load(Ordering::SeqCst) && !other.load(Ordering::SeqCst), "another window's search runs on");
        runs.finish("main", a);
        assert_eq!(runs.current("main"), Some(b), "the stopped search does not forget the newer one");
        runs.finish("main", b);
        assert_eq!(runs.current("main"), None);
        assert_eq!(runs.current("detached-abc"), Some(c));
        runs.finish("detached-abc", c);
        assert_eq!(runs.current("detached-abc"), None);
    }

    #[test]
    fn a_new_search_of_a_window_cancels_only_its_previous_one() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("a.txt"), "token\n").unwrap();
        let ctx = context(data.path(), project.path());
        assert!(ctx.guard.register_detached("detached-abc"));
        let runs = Arc::new(SearchRuns::default());
        let mut builder = RouterBuilder::new(Contract::embedded());
        register_search(&mut builder, &ctx, runs.clone());
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        let r = Arc::new(builder.build(ctx.guard.clone()));
        let search = |label: &str, project: &str| {
            let caller = Caller::new(label, "http://tauri.localhost/index.html?detached=abc")
                .with_request_origin(Some("http://tauri.localhost".into()));
            let call = Call::new("fs:searchProject", caller, vec![json!(project), json!({ "query": "token" })]);
            let r = r.clone();
            tauri::async_runtime::spawn(async move { json_of(r.invoke(call).await.unwrap()) })
        };
        let wait_for = |label: &str, id: Option<u64>| {
            let until = Instant::now() + std::time::Duration::from_secs(10);
            while runs.current(label) != id {
                assert!(Instant::now() < until, "{label} never had search {id:?}");
                std::thread::yield_now();
            }
        };
        let found = json!({
            "ok": true, "files": [{ "path": "a.txt", "matches": [{
                "line": 1, "column": 0, "text": "token", "preview": "token", "matchStart": 0, "matchLength": 5
            }] }],
            "matches": 1, "scanned": 1, "skipped": 0, "truncated": false
        });
        let cancelled = json!({ "ok": true, "files": [], "matches": 0, "scanned": 0, "skipped": 0, "truncated": true });

        // Every search waits at the gate until all of them have started.
        let gate = runs.gate.write();
        let first = search("main", "p1");
        wait_for("main", Some(0));
        let other = search("detached-abc", "p1");
        wait_for("detached-abc", Some(1));
        // A project that is gone answers at once and leaves the running search alone.
        let gone = tauri::async_runtime::block_on(search("main", "nope")).unwrap();
        assert_eq!(gone, json!({ "ok": false, "error": GONE }));
        assert_eq!(runs.current("main"), Some(0));
        let second = search("main", "p1");
        wait_for("main", Some(2));
        drop(gate);

        assert_eq!(tauri::async_runtime::block_on(first).unwrap(), cancelled);
        assert_eq!(tauri::async_runtime::block_on(second).unwrap(), found);
        assert_eq!(tauri::async_runtime::block_on(other).unwrap(), found);
        wait_for("main", None);
        wait_for("detached-abc", None);
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
