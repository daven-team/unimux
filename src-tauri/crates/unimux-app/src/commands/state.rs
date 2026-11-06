//! Commands of the `state` domain (F9): `state:load`, `state:snapshot`, `state:edit`. The broadcast (`state:changed`) is wired
//! in context.rs; the controller owns the state.

use std::sync::Arc;

use serde_json::Value;
use unimux_ipc::RouterBuilder;

use crate::context::AppContext;

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let c = ctx.clone();
    r.invoke("state:load", move |_call| {
        let c = c.clone();
        async move { Ok((*c.state.get()).clone()) }
    });

    let c = ctx.clone();
    r.invoke("state:snapshot", move |_call| {
        let c = c.clone();
        async move {
            // The windows hear a waiting batched change first, so the snapshot never runs ahead of a patch they get later.
            c.broadcaster.flush();
            Ok(c.state.snapshot().to_json())
        }
    });

    // `applyStateEdit(edit)`: {id, base, next} (pruned by the renderer) merged into the latest state; answers the ack.
    let c = ctx.clone();
    r.invoke("state:edit", move |call| {
        let c = c.clone();
        async move {
            let edit = call.arg(0);
            let id = edit.get("id").and_then(Value::as_str).ok_or_else(|| call.fail("state:edit without an id"))?;
            let base = edit.get("base").ok_or_else(|| call.fail("state:edit without a base"))?;
            let next = edit.get("next").ok_or_else(|| call.fail("state:edit without a next"))?;
            c.state.apply_edit(id, base, next).map_err(|e| call.fail(e))
        }
    });
}
