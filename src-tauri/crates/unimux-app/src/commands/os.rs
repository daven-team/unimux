//! Commands of the `os` domain (W4): notifications (`notify`, `notify:show`), the taskbar flash (`attention:flash`), dialogs
//! (`dialog:pickFolder`, `sound:pick`), alert sounds (`sound:load`, `sound:beep`), the clipboard (`clipboard:read`, `:write`,
//! `:writeSecret`) and the shell (`shell:openExternal`, `:openPath`, `:revealPath`, `:openInEditor`). Ports of the handlers
//! in src/main/index.ts; the OS calls live in unimux-platform. `alerts:testLimit` belongs to A5 (it needs the usage service
//! and the limit notice text); A5 shows its notices through [`OsService::notice`].
//!
//! Registered by `register` only. The service is created here and kept in `AppContext::os`, so the quit path
//! ([`on_exit`]) and the test bridge reach it.

mod desktop;

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{Manager, WebviewWindow, WindowEvent};

use unimux_core::i18n::{detect_language, is_language, translate};
use unimux_exec::{ExecOptions, Program};
use unimux_ipc::{RouterBuilder, Scope, binary};
use unimux_platform::clipboard::SecretClipboard;
use unimux_platform::notify::{
    Native, Registry, ToastEvent, ToastSpec, is_permission_answer, is_permission_token, notification_actions,
};
use unimux_platform::shell::is_path_arg;
use unimux_platform::sound::{SOUND_EXTENSIONS, SoundLoad, is_sound_file, load_event_sound};
use unimux_platform::taskbar::{Taskbar, TaskbarCell, TaskbarDeps};
use unimux_platform::timers::ThreadScheduler;

use crate::context::AppContext;
pub use desktop::{Desktop, PickRequest, RealDesktop, Recorder};

/// The editor lookup (`where cursor`, `where code`) is repeated at most every 5 minutes.
const EDITOR_LOOKUP: Duration = Duration::from_secs(5 * 60);

/// The OS services of one run (notifications, the copied secret, the editor lookup, the Dock badge).
pub struct OsService {
    ctx: Weak<AppContext>,
    pub desktop: Arc<dyn Desktop>,
    /// Set when the desktop is the offscreen recorder (check builds with MC_OFFSCREEN); read by the test bridge.
    #[cfg_attr(not(feature = "test-bridge"), allow(dead_code))]
    pub recorder: Option<Arc<Recorder>>,
    notices: Registry<Native>,
    pub secret: Arc<SecretClipboard>,
    editor: tokio::sync::Mutex<Option<(Instant, Option<String>)>>,
    /// Windows whose focus already stops a flash.
    flash_watch: Mutex<HashSet<String>>,
    /// The Dock badge (macOS); W7 feeds it the `cell:runtime` statuses.
    pub taskbar: Arc<Taskbar>,
}

/// What a notification's button does besides showing the window.
pub type NoticeAction = Arc<dyn Fn(Option<usize>) + Send + Sync>;

impl OsService {
    pub fn new(ctx: &Arc<AppContext>) -> Arc<Self> {
        let (desktop, recorder): (Arc<dyn Desktop>, Option<Arc<Recorder>>) = if ctx.overrides.offscreen {
            let r = Arc::new(Recorder::new(&ctx.data_dir));
            (r.clone(), Some(r))
        } else {
            (Arc::new(RealDesktop::new(crate::AUMID, !unimux_core::PACKAGED)), None)
        };
        let scheduler = Arc::new(ThreadScheduler::default());
        let secret = SecretClipboard::new(desktop.clipboard(), scheduler.clone());
        let weak = Arc::downgrade(ctx);
        let (cells_ctx, badge_ctx, settings_ctx) = (weak.clone(), weak.clone(), weak.clone());
        let badge_desktop = desktop.clone();
        let taskbar = Taskbar::new(TaskbarDeps {
            platform: ctx.platform.as_str().to_string(),
            cells: Box::new(move || cells_ctx.upgrade().map(|c| taskbar_cells(&c.state.get())).unwrap_or_default()),
            // The live terminals come with P3 (`cell:alive`); until then no cell counts.
            alive: Box::new(HashSet::new),
            taskbar_badge: Box::new(move || {
                settings_ctx
                    .upgrade()
                    .is_some_and(|c| alerts(&c.state.get()).get("taskbarBadge").and_then(Value::as_bool) == Some(true))
            }),
            set_dock_badge: Box::new(move |text| {
                let main = badge_ctx.upgrade().and_then(|c| c.app().and_then(|a| a.get_webview_window(crate::windows::MAIN)));
                badge_desktop.dock_badge(main, text);
            }),
            scheduler,
        });
        Arc::new(Self {
            ctx: weak,
            desktop,
            recorder,
            notices: Registry::default(),
            secret,
            editor: tokio::sync::Mutex::new(None),
            flash_watch: Mutex::new(HashSet::new()),
            taskbar,
        })
    }

    fn ctx(&self) -> Option<Arc<AppContext>> {
        self.ctx.upgrade()
    }

    /// Shows a notification. A click shows the main window (and `cell`); a button runs `on_button(index)` when given, else
    /// it acts like a click. Closed and failed ones are forgotten; a timed-out one stays (it is parked in the Action Center
    /// and still clickable); only the newest 50 keep their handlers.
    pub fn notice(
        self: &Arc<Self>,
        title: &str,
        body: &str,
        buttons: Vec<String>,
        cell: Option<String>,
        on_button: Option<NoticeAction>,
    ) {
        if !self.desktop.notifications_supported() {
            return;
        }
        let spec = ToastSpec::new(title, body, buttons);
        let id = self.notices.reserve();
        let me = Arc::downgrade(self);
        let on_event = Arc::new(move |event: ToastEvent| {
            let Some(me) = me.upgrade() else { return };
            match event {
                ToastEvent::Closed | ToastEvent::Failed => {
                    me.notices.forget(id);
                }
                // Parked in the Action Center: still clickable, so it stays (bounded by the limit of 50).
                ToastEvent::TimedOut => {}
                ToastEvent::Click => {
                    if me.notices.forget(id) {
                        me.show_cell(cell.as_deref());
                    }
                }
                ToastEvent::Button(index) => {
                    if !me.notices.forget(id) {
                        return;
                    }
                    match &on_button {
                        Some(action) => action(Some(index)),
                        None => me.show_cell(cell.as_deref()),
                    }
                }
            }
        });
        match self.desktop.toast(&spec, on_event) {
            Ok(Some(native)) => self.notices.attach(id, native),
            Ok(None) => {}
            Err(e) => {
                self.notices.forget(id);
                if let Some(ctx) = self.ctx() {
                    ctx.crash.warn(&format!("notification failed: {e}"));
                }
            }
        }
    }

    /// `notify`: an agent's notification; 1.0.9 buttons for one cell's permission request when the setting is on.
    fn notify(self: &Arc<Self>, n: &Value) {
        let Some(ctx) = self.ctx() else { return };
        let Some(obj) = n.as_object() else { return };
        let (Some(title), Some(body)) = (obj.get("title").and_then(Value::as_str), obj.get("body").and_then(Value::as_str))
        else {
            return;
        };
        let cell = match obj.get("cellId") {
            None => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return,
        };
        let token = obj.get("token").cloned().unwrap_or(Value::Null);
        let state = ctx.state.get();
        let actions_on = alerts(&state).get("notificationActions").and_then(Value::as_bool) == Some(true);
        let kind =
            match (cell.as_deref().is_some_and(|c| !c.is_empty()) && actions_on, obj.get("actions").and_then(Value::as_str)) {
                (true, Some("answer")) if is_permission_token(&token) => Some("answer"),
                (true, Some("show")) => Some("show"),
                _ => None,
            };
        let language = language(&state);
        let t = |key: &str| translate(&language, key, &[]);
        let buttons = kind.map(|k| notification_actions(k, ctx.platform.as_str(), &t)).unwrap_or_default();
        let answers: Vec<Option<&'static str>> = buttons.iter().map(|b| b.answer).collect();
        let me = Arc::downgrade(self);
        let answer_cell = cell.clone();
        let on_button: NoticeAction = Arc::new(move |index| {
            let Some(me) = me.upgrade() else { return };
            let answer = index.and_then(|i| answers.get(i).copied().flatten());
            // The window that holds the cell's terminal checks that the dialog is still the same before it types anything.
            match (&answer_cell, token.as_str()) {
                (Some(c), Some(t)) if is_permission_answer(answer) && !c.is_empty() && is_permission_token(&token) => {
                    if let Some(ctx) = me.ctx() {
                        ctx.events.emit(Scope::Cell(c.clone()), "notify:answer", vec![json!(c), json!(t), json!(answer)]);
                    }
                }
                _ => me.show_cell(answer_cell.as_deref()),
            }
        });
        self.notice(title, body, buttons.into_iter().map(|b| b.text).collect(), cell, Some(on_button));
    }

    /// Shows the main window and the cell (a notification click, "Pokaż", or an answer that came too late). An offscreen run
    /// never takes the focus.
    pub fn show_cell(&self, cell: Option<&str>) {
        let Some(ctx) = self.ctx() else { return };
        if !ctx.overrides.offscreen
            && let Some(window) = ctx.app().and_then(|a| a.get_webview_window(crate::windows::MAIN))
        {
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
        if let Some(c) = cell.filter(|c| !c.is_empty()) {
            ctx.events.emit(Scope::Cell(c.to_string()), "focus-cell", vec![json!(c)]);
        }
    }

    /// `attention:flash`: the sender's taskbar button flashes (Dock bounce on macOS) when the setting is on and the window
    /// is not focused; it stops when the window gets the focus.
    fn flash(&self, label: &str) {
        let Some(ctx) = self.ctx() else { return };
        if alerts(&ctx.state.get()).get("flashWindow").and_then(Value::as_bool) != Some(true) {
            return;
        }
        let Some(window) = ctx.app().and_then(|a| a.get_webview_window(label)) else { return };
        if window.is_focused().unwrap_or(true) {
            return;
        }
        self.desktop.flash(&window, true);
        if self.flash_watch.lock().insert(label.to_string()) {
            let desktop = self.desktop.clone();
            let w = window.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Focused(true)) {
                    desktop.flash(&w, false);
                }
            });
        }
    }

    /// The window a dialog belongs to: the caller's, else main.
    fn dialog_parent(&self, label: &str) -> Option<WebviewWindow> {
        let app = self.ctx()?.app()?.clone();
        app.get_webview_window(label).or_else(|| app.get_webview_window(crate::windows::MAIN))
    }

    /// `cursor`, else `code` on PATH (looked up at most every 5 minutes), else None.
    async fn find_editor(&self) -> Option<String> {
        let mut cache = self.editor.lock().await;
        if let Some((at, found)) = cache.as_ref()
            && at.elapsed() < EDITOR_LOOKUP
        {
            return found.clone();
        }
        let found = tokio::task::spawn_blocking(|| {
            let finder = if cfg!(windows) { PathBuf::from("where") } else { PathBuf::from("/usr/bin/which") };
            ["cursor", "code"].into_iter().map(str::to_string).find(|cmd| {
                let options = ExecOptions {
                    timeout: Duration::from_secs(5),
                    env: Some(std::env::vars_os().collect()),
                    ..Default::default()
                };
                unimux_exec::run(&Program::Args { program: finder.clone(), args: vec![OsString::from(cmd)] }, &options)
                    .is_ok_and(|out| out.code == Some(0) && !out.timed_out)
            })
        })
        .await
        .unwrap_or(None);
        *cache = Some((Instant::now(), found.clone()));
        found
    }

    /// `shell:openPath`: the default program, except that a program, script, installer or shortcut is revealed in Explorer
    /// / Finder instead of being run (PLAN.md, W4 open path; 1.1.4 opened it). The openInEditor fallback goes through here.
    /// Every check (type list, PATHEXT, AssocIsDangerous, link targets, macOS execute bit / header / bundle) lives in
    /// `launches_program`, which `unimux_platform::shell::open_path` runs again right before ShellExecute / `open`.
    fn open_path(&self, path: &str) {
        if unimux_platform::shell::launches_program(path) {
            self.desktop.reveal(path);
        } else {
            self.desktop.open_path(path);
        }
    }

    /// `shell:openInEditor`: Cursor or VS Code through their launchers (a shell on Windows, with the cleaned environment),
    /// `open -a` on macOS when only the app is installed, else the default program (openPath).
    async fn open_in_editor(&self, path: String) {
        let editor = self.find_editor().await;
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut env = unimux_exec::clean_process_env();
        let result = match editor {
            #[cfg(windows)]
            Some(editor) => match editor_command_line(&editor, &path) {
                Some((raw, via_env)) => {
                    if via_env {
                        env.insert(OsString::from(EDITOR_PATH_VAR), OsString::from(&path));
                    }
                    let comspec = std::env::var_os("ComSpec").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cmd.exe"));
                    self.desktop.spawn_detached(Program::Raw { program: comspec, raw }, Some(env))
                }
                None => Err("the path cannot be passed to the editor safely".to_string()),
            },
            #[cfg(not(windows))]
            Some(editor) => {
                self.desktop.spawn_detached(Program::Args { program: editor.into(), args: vec![path.clone().into()] }, Some(env))
            }
            None => {
                #[cfg(target_os = "macos")]
                {
                    let home = unimux_core::home::home_dir();
                    let app = ["Cursor", "Visual Studio Code"].into_iter().find(|name| {
                        std::path::Path::new("/Applications").join(format!("{name}.app")).exists()
                            || home.join("Applications").join(format!("{name}.app")).exists()
                    });
                    if let Some(app) = app {
                        let program =
                            Program::Args { program: "/usr/bin/open".into(), args: vec!["-a".into(), app.into(), path.into()] };
                        let _ = self.desktop.spawn_detached(program, None);
                        return;
                    }
                }
                self.open_path(&path);
                Ok(())
            }
        };
        if let Err(e) = result
            && let Some(ctx) = self.ctx()
        {
            ctx.crash.warn(&format!("open in editor failed: {e}"));
        }
    }
}

/// The variable that carries a path with `%` to the editor's command line (cmd expands it once, never its value).
#[cfg_attr(not(windows), allow(dead_code))]
const EDITOR_PATH_VAR: &str = "UNIMUX_OPEN_IN_EDITOR_PATH";

/// The cmd.exe arguments that start the editor's launcher (`code.cmd`, `cursor.cmd`) on one path, like Node's
/// spawn(editor, [`"${p}"`], { shell: true }) of 1.1.4: `/d /s /c "<editor> "<p>""`, plus `/v:off` so `!` is never expanded.
/// Inside the quotes `& | < > ^ !` are plain characters; only `"` could end them (no Windows file name has one, so such a
/// path is refused, as are control characters), and `%` would be expanded before the quotes are read (`%CMDCMDLINE%`
/// holds quotes): a path with `%` is passed as `%UNIMUX_OPEN_IN_EDITOR_PATH%`, whose value cmd does not expand again.
/// Returns the arguments and whether the path must be put in that variable; None when the path is refused.
#[cfg_attr(not(windows), allow(dead_code))]
fn editor_command_line(editor: &str, path: &str) -> Option<(String, bool)> {
    if path.is_empty() || path.chars().any(|c| c == '"' || c.is_control()) {
        return None;
    }
    let via_env = path.contains('%');
    let arg = if via_env { format!("%{EDITOR_PATH_VAR}%") } else { path.to_string() };
    Some((format!("/d /v:off /s /c \"{editor} \"{arg}\"\""), via_env))
}

/// `state.settings.alerts` (normalized; Null when missing).
fn alerts(state: &Value) -> &Value {
    state.get("settings").and_then(|s| s.get("alerts")).unwrap_or(&Value::Null)
}

/// The language of main's texts: the saved one, else the OS language (`detectLanguage([app.getLocale()])`).
pub fn language(state: &Value) -> String {
    match state.get("settings").and_then(|s| s.get("language")).and_then(Value::as_str) {
        Some(l) if is_language(l) => l.to_string(),
        _ => detect_language(&[unimux_platform::os_locale().unwrap_or_default()]).to_string(),
    }
}

/// `findCell(state, id)` is not null.
fn has_cell(state: &Value, cell: &str) -> bool {
    each_cell(state).any(|c| c.get("id").and_then(Value::as_str) == Some(cell))
}

fn list(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn each_cell(state: &Value) -> impl Iterator<Item = &Value> {
    list(state.get("projects")).iter().flat_map(|p| list(p.get("tabs")).iter()).flat_map(|t| list(t.get("cells")).iter())
}

/// The cells of every grid for the Dock badge: `agent` = the profile's CLI is not the shell (`getProfile` fallbacks).
fn taskbar_cells(state: &Value) -> Vec<TaskbarCell> {
    let profiles = state.get("profiles").and_then(Value::as_array).cloned().unwrap_or_default();
    let cli_of = |id: Option<&str>| -> Option<String> {
        let found = profiles
            .iter()
            .find(|p| id.is_some() && p.get("id").and_then(Value::as_str) == id)
            .or_else(|| profiles.iter().find(|p| p.get("cli").and_then(Value::as_str) == Some("shell")))
            .or_else(|| profiles.first());
        found.and_then(|p| p.get("cli")).and_then(Value::as_str).map(str::to_string)
    };
    each_cell(state)
        .map(|c| TaskbarCell {
            id: c.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            muted: c.get("muted").and_then(Value::as_bool).unwrap_or(false),
            agent: cli_of(c.get("profileId").and_then(Value::as_str)).as_deref() != Some("shell"),
        })
        .collect()
}

/// `new URL(address)` with an http(s) protocol: the URL's href.
fn external_url(address: &Value) -> Option<String> {
    let url = url::Url::parse(address.as_str()?).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.as_str().to_string())
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let os = OsService::new(ctx);
    let _ = ctx.os.set(os.clone());

    let s = os.clone();
    r.send("notify", move |call| {
        let s = s.clone();
        async move { s.notify(call.arg(0)) }
    });

    let s = os.clone();
    r.send("notify:show", move |call| {
        let s = s.clone();
        async move {
            let Some(cell) = call.arg(0).as_str() else { return };
            let Some(ctx) = s.ctx() else { return };
            if has_cell(&ctx.state.get(), cell) {
                s.show_cell(Some(cell));
            }
        }
    });

    let s = os.clone();
    r.send("attention:flash", move |call| {
        let s = s.clone();
        async move { s.flash(&call.caller.label) }
    });

    let s = os.clone();
    r.invoke("dialog:pickFolder", move |call| {
        let s = s.clone();
        async move {
            let Some(ctx) = s.ctx() else { return Ok(Value::Null) };
            let title = translate(&language(&ctx.state.get()), "Wybierz folder projektu", &[]);
            let request = PickRequest { folder: true, title, filter: None };
            Ok(s.desktop.pick(s.dialog_parent(&call.caller.label), request).await.map(Value::String).unwrap_or(Value::Null))
        }
    });

    let s = os.clone();
    r.invoke("sound:pick", move |call| {
        let s = s.clone();
        async move {
            let Some(ctx) = s.ctx() else { return Ok(Value::Null) };
            let language = language(&ctx.state.get());
            let request = PickRequest {
                folder: false,
                title: translate(&language, "Wybierz plik dźwiękowy", &[]),
                filter: Some((
                    translate(&language, "Pliki dźwiękowe", &[]),
                    SOUND_EXTENSIONS.iter().map(|e| e.to_string()).collect(),
                )),
            };
            let picked = s.desktop.pick(s.dialog_parent(&call.caller.label), request).await;
            Ok(picked.filter(|p| is_sound_file(p)).map(Value::String).unwrap_or(Value::Null))
        }
    });

    // The path is never taken from the renderer: only the saved setting of that event (set from the dialog result) is read.
    let s = os.clone();
    r.invoke_reply("sound:load", move |call| {
        let s = s.clone();
        async move {
            let Some(ctx) = s.ctx() else { return Ok(json!({ "ok": false }).into()) };
            let alerts = alerts(&ctx.state.get()).clone();
            let (event, known) = (call.arg(0).clone(), call.arg(1).clone());
            let loaded = tokio::task::spawn_blocking(move || load_event_sound(&alerts, &event, &known))
                .await
                .unwrap_or(SoundLoad::Refused);
            Ok(match loaded {
                SoundLoad::Loaded { key, data: Some(bytes) } => unimux_ipc::Reply::Binary {
                    value: json!({ "ok": true, "key": key, "data": binary::part(0) }),
                    parts: vec![bytes],
                },
                SoundLoad::Loaded { key, data: None } => json!({ "ok": true, "key": key, "data": null }).into(),
                SoundLoad::Refused => json!({ "ok": false }).into(),
            })
        }
    });

    let s = os.clone();
    r.send("sound:beep", move |_| {
        let s = s.clone();
        async move { s.desktop.beep() }
    });

    let s = os.clone();
    r.invoke("clipboard:read", move |_| {
        let s = s.clone();
        async move {
            let io = s.desktop.clipboard();
            let text = tokio::task::spawn_blocking(move || io.read().unwrap_or_default()).await.unwrap_or_default();
            Ok(Value::String(text))
        }
    });

    let s = os.clone();
    r.send("clipboard:write", move |call| {
        let s = s.clone();
        async move {
            let Some(text) = call.arg(0).as_str().map(str::to_string) else { return };
            let io = s.desktop.clipboard();
            let _ = tokio::task::spawn_blocking(move || io.write(&text, false)).await;
        }
    });

    // A copied private key (0.9.3): the clearing waits here, not in the window, so a reload or quit within the minute still
    // clears it.
    let s = os.clone();
    r.invoke("clipboard:writeSecret", move |call| {
        let s = s.clone();
        async move {
            let Some(text) = call.arg(0).as_str().filter(|t| !t.is_empty()).map(str::to_string) else {
                return Ok(Value::Bool(false));
            };
            let secret = s.secret.clone();
            let copied = tokio::task::spawn_blocking(move || secret.copy(&text)).await.map_err(|e| call.fail(e.to_string()))?;
            copied.map(|()| Value::Bool(true)).map_err(|e| call.fail(e))
        }
    });

    let s = os.clone();
    r.send("shell:openExternal", move |call| {
        let s = s.clone();
        async move {
            if let Some(url) = external_url(call.arg(0)) {
                s.desktop.open_external(&url);
            }
        }
    });

    let s = os.clone();
    r.send("shell:openPath", move |call| {
        let s = s.clone();
        async move {
            if let Some(p) = call.arg(0).as_str().filter(|p| is_path_arg(p)) {
                s.open_path(p);
            }
        }
    });

    let s = os.clone();
    r.send("shell:revealPath", move |call| {
        let s = s.clone();
        async move {
            if let Some(p) = call.arg(0).as_str().filter(|p| is_path_arg(p)) {
                s.desktop.reveal(p);
            }
        }
    });

    let s = os;
    r.send("shell:openInEditor", move |call| {
        let s = s.clone();
        async move {
            if let Some(p) = call.arg(0).as_str().filter(|p| is_path_arg(p)).map(str::to_string) {
                s.open_in_editor(p).await;
            }
        }
    });
}

/// The quit path (1.1.4 will-quit): a copied key that still waits is cleared now, within 400 ms whatever the clipboard does.
pub fn on_exit(ctx: &AppContext) {
    let Some(os) = ctx.os.get() else { return };
    os.taskbar.dispose();
    if !os.secret.pending() {
        return;
    }
    let secret = os.secret.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        secret.flush();
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(Duration::from_millis(400));
}

/// Test bridge (check builds): `{action: "log", take?}`, `{action: "answer", path|null}` (the next dialog's answer),
/// `{action: "toast", index, event: "click" | "button" | "closed" | "timedOut" | "failed", button?}`, `{action: "clipboardFire"}` (the 60 s
/// clear runs now), `{action: "live"}` (the live notification ids), `{action: "taskbar", ...}` (a status for the badge).
#[cfg(feature = "test-bridge")]
pub fn test_op(ctx: &AppContext, args: &Value) -> Result<Value, String> {
    let os = ctx.os.get().ok_or("no os service")?;
    let recorder = os.recorder.as_ref().ok_or("the os recorder needs MC_OFFSCREEN")?;
    match args.get("action").and_then(Value::as_str).unwrap_or_default() {
        "log" => Ok(json!(recorder.log(args.get("take").and_then(Value::as_bool).unwrap_or(false)))),
        "answer" => {
            recorder.queue_answer(args.get("path").and_then(Value::as_str).map(str::to_string));
            Ok(Value::Null)
        }
        "toast" => {
            let index = args.get("index").and_then(Value::as_u64).ok_or("toast needs index")? as usize;
            let event = match args.get("event").and_then(Value::as_str) {
                Some("click") => ToastEvent::Click,
                Some("closed") => ToastEvent::Closed,
                Some("timedOut") => ToastEvent::TimedOut,
                Some("failed") => ToastEvent::Failed,
                Some("button") => {
                    ToastEvent::Button(args.get("button").and_then(Value::as_u64).ok_or("button needs button")? as usize)
                }
                _ => return Err("unknown toast event".into()),
            };
            Ok(Value::Bool(recorder.activate(index, event)))
        }
        "live" => Ok(json!(os.notices.ids())),
        "secretPending" => Ok(Value::Bool(os.secret.pending())),
        "clipboardFire" => {
            // What the 60 s timer does, now: clear if the clipboard still holds the copied text.
            os.secret.flush();
            Ok(Value::Null)
        }
        "taskbar" => {
            let cell = args.get("cell").and_then(Value::as_str).ok_or("taskbar needs cell")?;
            let status = args.get("status").and_then(Value::as_str).unwrap_or("idle");
            let reason = args.get("reason").and_then(Value::as_str);
            os.taskbar.status(cell, unimux_platform::taskbar::CellRuntime::new(status, reason), None);
            os.taskbar.flush();
            Ok(json!(os.taskbar.view()))
        }
        other => Err(format!("unknown os action {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The W4 channels of the contract are implemented (alerts:testLimit is A5's).
    #[test]
    fn w4_channels_are_implemented() {
        let _one = crate::commands::REGISTER_LOCK.lock();
        use unimux_core::crash_log::RollingLog;
        use unimux_core::dev_overrides::DevOverrides;
        use unimux_core::startup_timing::{StartupLog, StartupTimer};
        use unimux_ipc::router::Status;
        let dir = tempfile::tempdir().unwrap();
        let ctx = AppContext::new(
            dir.path().to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir.path())),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.path().join("startup.log"), "")),
            json!({ "version": 1, "projects": [] }),
        );
        let mut builder = RouterBuilder::new(unimux_ipc::Contract::embedded());
        crate::commands::register_all(&mut builder, &ctx);
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        let report = builder.build(ctx.guard.clone()).report();
        for channel in [
            "notify",
            "notify:show",
            "attention:flash",
            "dialog:pickFolder",
            "sound:pick",
            "sound:load",
            "sound:beep",
            "clipboard:read",
            "clipboard:write",
            "clipboard:writeSecret",
            "shell:openExternal",
            "shell:openPath",
            "shell:revealPath",
            "shell:openInEditor",
        ] {
            assert_eq!(report[channel], Status::Implemented, "{channel}");
        }
        assert_ne!(report["alerts:testLimit"], Status::Implemented);
        assert!(ctx.os.get().is_some_and(|os| os.recorder.is_none()), "a normal run uses the real desktop");
        ctx.saver.stop();
    }

    #[test]
    fn external_urls_are_http_or_https_hrefs() {
        assert_eq!(external_url(&json!("https://example.com/a b")).as_deref(), Some("https://example.com/a%20b"));
        assert_eq!(external_url(&json!("  HTTP://Example.COM")).as_deref(), Some("http://example.com/"));
        assert_eq!(external_url(&json!("file:///C:/Windows/win.ini")), None);
        assert_eq!(external_url(&json!("javascript:alert(1)")), None);
        assert_eq!(external_url(&json!("not a url")), None);
        assert_eq!(external_url(&json!(5)), None);
    }

    #[test]
    fn editor_command_line_quotes_the_path_and_refuses_what_could_end_the_quotes() {
        assert_eq!(editor_command_line("code", "C:\\p\\a.ts"), Some(("/d /v:off /s /c \"code \"C:\\p\\a.ts\"\"".into(), false)));
        assert_eq!(
            editor_command_line("code", "C:\\100%\\x"),
            Some(("/d /v:off /s /c \"code \"%UNIMUX_OPEN_IN_EDITOR_PATH%\"\"".into(), true))
        );
        assert_eq!(editor_command_line("code", "x\" & calc & \""), None);
        assert_eq!(editor_command_line("code", "C:\\a\nb"), None);
        assert_eq!(editor_command_line("code", ""), None);
    }

    /// The real cmd.exe gets the editor's command line with `echo` as the editor: whatever the path holds (`&`, `|`, `>`,
    /// `^`, `!`, `%VAR%`, `%CMDCMDLINE%`), the one command prints exactly the quoted path, so nothing else ran and nothing
    /// was expanded.
    #[cfg(windows)]
    #[test]
    fn hostile_paths_reach_the_editor_as_one_argument_through_cmd() {
        use std::os::windows::process::CommandExt;
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("injected.txt");
        let hostile = [
            "C:\\R&D\\a^b!c!\\x.txt".to_string(),
            format!("C:\\a & echo x > {} & \\b", marker.display()),
            "C:\\a | b > c\\x".to_string(),
            "C:\\100%\\%CMDCMDLINE%\\%PATH%\\%COMSPEC:~0,1%\\x".to_string(),
        ];
        let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        for path in hostile {
            let (raw, via_env) = editor_command_line("echo", &path).unwrap();
            let mut cmd = std::process::Command::new(&comspec);
            cmd.raw_arg(&raw);
            if via_env {
                cmd.env(EDITOR_PATH_VAR, &path);
            }
            let out = cmd.output().unwrap();
            let printed = String::from_utf8_lossy(&out.stdout).trim_end_matches(['\r', '\n']).to_string();
            assert_eq!(printed, format!("\"{path}\""), "{raw}");
        }
        assert!(!marker.exists(), "a second command ran");
    }

    #[test]
    fn cells_and_profiles_like_get_profile() {
        let state = json!({
            "profiles": [{ "id": "c", "cli": "claude" }, { "id": "sh", "cli": "shell" }],
            "projects": [{ "tabs": [{ "cells": [
                { "id": "1", "profileId": "c" },
                { "id": "2", "profileId": "sh", "muted": true },
                { "id": "3", "profileId": "gone" },
            ] }] }],
        });
        let cells = taskbar_cells(&state);
        assert_eq!(
            cells.iter().map(|c| (c.id.as_str(), c.agent, c.muted)).collect::<Vec<_>>(),
            vec![("1", true, false), ("2", false, true), ("3", false, false)]
        );
        assert!(has_cell(&state, "3"));
        assert!(!has_cell(&state, "4"));
    }
}
