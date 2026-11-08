//! S4: the key, password and known-host channels of src/main/ssh/ipc.ts (`unimux_ssh::ipc::SshIpc`) in the app: the state,
//! the state edit, `ssh:vault:changed`, the two dialogs over the main window (1.1.4 `showOpen` / `showSaveDialog(win)`; an
//! offscreen check run answers them from the test bridge's recorder) and the host name. The guard of the router already
//! refused every window but the app window (R9); payloads are never logged.

use std::sync::Arc;
use std::sync::Weak;

use serde_json::{Value, json};
use unimux_core::i18n::translate;
use unimux_ipc::RouterBuilder;
use unimux_ssh::coordinator::CoordinatorEvents;
use unimux_ssh::ipc::{HostFuture, KEY_CHANNELS, SshIpc, SshIpcHost};

use crate::commands::os::{PickRequest, SaveRequest, language};
use crate::context::AppContext;

struct AppIpcHost(Weak<AppContext>);

impl AppIpcHost {
    fn tr(ctx: &AppContext, key: &str) -> String {
        translate(&language(&ctx.state.get()), key, &[])
    }
}

impl SshIpcHost for AppIpcHost {
    fn state(&self) -> Arc<Value> {
        self.0.upgrade().map(|c| c.state.get()).unwrap_or_else(|| Arc::new(json!({})))
    }

    fn change(&self, edit: &(dyn Fn(&Value) -> Option<Value> + Send + Sync)) {
        let Some(ctx) = self.0.upgrade() else { return };
        // Unchanged: the controller keeps the state and broadcasts nothing (StateController.change with the same object).
        let _ = ctx.state.change(|s| edit(s).ok_or_else(|| "unchanged".to_string()), None, false);
    }

    fn vault_changed(&self) {
        if let Some(ctx) = self.0.upgrade() {
            super::link::link(&ctx).events.vault_changed();
        }
    }

    fn pick_key_file(&self) -> HostFuture<Option<String>> {
        let ctx = self.0.upgrade();
        Box::pin(async move {
            let ctx = ctx?;
            let os = ctx.os.get().cloned()?;
            // The default folder is only passed to the dialog; the app never reads ~/.ssh by itself.
            let ssh_dir = unimux_core::home::home_dir().join(".ssh");
            let directory = tokio::task::spawn_blocking(move || ssh_dir.is_dir().then_some(ssh_dir)).await.ok().flatten();
            let request = PickRequest {
                folder: false,
                title: Self::tr(&ctx, "Importuj z pliku"),
                filter: None,
                more_filters: Vec::new(),
                directory,
            };
            os.pick_file(crate::windows::MAIN, request).await
        })
    }

    fn save_key_file(&self, default_name: String) -> HostFuture<Result<Option<String>, ()>> {
        let ctx = self.0.upgrade();
        Box::pin(async move {
            let ctx = ctx.ok_or(())?;
            let os = ctx.os.get().cloned().ok_or(())?;
            let request = SaveRequest {
                title: Self::tr(&ctx, "Zapisz klucz prywatny do pliku..."),
                default_path: default_name,
                filters: Vec::new(),
            };
            Ok(os.save_file(crate::windows::MAIN, request).await)
        })
    }

    fn hostname(&self) -> String {
        unimux_platform::hostname()
    }
}

/// The handlers of `ctx` (one draft store per process, like 1.1.4's `new KeyDrafts()`).
pub fn ipc(ctx: &Arc<AppContext>) -> Arc<SshIpc> {
    SshIpc::new(ctx.ssh.clone(), Arc::new(AppIpcHost(Arc::downgrade(ctx))))
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let handlers = ipc(ctx);
    for channel in KEY_CHANNELS {
        let h = handlers.clone();
        r.invoke(channel, move |call| {
            let h = h.clone();
            async move {
                let arg = call.arg(0).clone();
                Ok(h.invoke(&call.command, &arg).await.unwrap_or(Value::Null))
            }
        });
    }
    let h = handlers;
    r.send("ssh:key:discardDraft", move |call| {
        let h = h.clone();
        async move { h.discard_draft(call.arg(0)) }
    });
}
