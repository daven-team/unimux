//! Wave 0 placeholders: fixed answers for the few invoke channels the renderer's boot awaits without a catch, so the real UI
//! starts before their packages land. A fallback never counts as implemented (`npm run ipc:report` lists it as "fallback")
//! and is dropped automatically when the owning domain registers a real handler.

use std::sync::Arc;

use serde_json::json;
use unimux_ipc::RouterBuilder;

use crate::context::AppContext;

pub fn register(r: &mut RouterBuilder, _ctx: &Arc<AppContext>) {
    // App.tsx / DetachedApp.tsx bootSteps: Promise.all([loadSnapshot, aliveCells, getMcpInfo, cliStatus.catch]); mcp:info is
    // real since M1.
    r.fallback("cell:alive", json!([])); // P3: no terminal runs before the pty service exists
}
