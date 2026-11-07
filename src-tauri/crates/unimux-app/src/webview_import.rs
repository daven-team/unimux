//! The first-start import of 1.1.x's localStorage (PLAN W3; the reader is `unimux_state::webview_import`).
//!
//! At start, before the main window exists, the old entries are read (from a copy of Electron's folder). The main window then
//! gets one more initialization script, which runs before the bridge and the app in the first page: it stores every entry the
//! new origin does not have yet (never overwriting), remembers the import id in sessionStorage (a reload of the same window
//! skips it) and reports with `mc_webview_import_done`, which writes the marker `webview-import.json`. A start whose page never
//! reported (the app ended first) offers the entries again; keys stored by then are kept as they are.

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, State, Webview};

use unimux_state::webview_import::{self as import, Import, Marker, Prepared};

use crate::context::AppContext;

/// The pending import of this run (managed state).
#[derive(Default)]
pub struct WebviewImport {
    pending: Mutex<Option<Import>>,
}

/// Reads the old entries if the marker is missing; called once in setup, before the main window is built.
pub fn prepare(app: &AppHandle, ctx: &AppContext) {
    let state = WebviewImport::default();
    match import::prepare(&ctx.data_dir, &std::env::temp_dir()) {
        Prepared::Pending(found) => {
            ctx.mark("webview-import-read");
            *state.pending.lock() = Some(found);
        }
        Prepared::Failed(error) => ctx.crash.warn(&format!("localStorage of 1.1.x not imported: {error}")),
        Prepared::Done | Prepared::Nothing => {}
    }
    app.manage(state);
}

/// The extra initialization script of the main window, when there is something to import.
pub fn script_for_main(app: &AppHandle) -> Option<String> {
    let state = app.try_state::<WebviewImport>()?;
    let pending = state.pending.lock();
    pending.as_ref().map(script)
}

/// The import script: plain ES5, no dependency on the bridge (it runs before it).
pub fn script(import: &Import) -> String {
    let mut entries = String::with_capacity(import.entries.iter().map(|e| e.key.len() + e.value.len() + 8).sum());
    entries.push('[');
    for (i, entry) in import.entries.iter().enumerate() {
        if i > 0 {
            entries.push(',');
        }
        entries.push('[');
        import::js_literal(&entry.key, &mut entries);
        entries.push(',');
        import::js_literal(&entry.value, &mut entries);
        entries.push(']');
    }
    entries.push(']');
    let id = serde_json::to_string(&import.id).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function () {{
  var id = {id}, entries = {entries}, imported = 0, kept = 0, error = null, again = false;
  try {{
    again = window.sessionStorage.getItem('mc:webview-import') === id;
    if (!again) {{
      for (var i = 0; i < entries.length; i++) {{
        if (window.localStorage.getItem(entries[i][0]) === null) {{ window.localStorage.setItem(entries[i][0], entries[i][1]); imported++; }}
        else kept++;
      }}
      window.sessionStorage.setItem('mc:webview-import', id);
    }}
  }} catch (e) {{ error = String((e && e.message) || e); }}
  entries = null;
  if (again) return;
  var report = function () {{
    var p = window.__TAURI_INTERNALS__.invoke('mc_webview_import_done', {{ id: id, imported: imported, kept: kept, error: error }});
    if (p && p.catch) p.catch(function () {{}});
  }};
  try {{ report(); }} catch (e) {{ window.addEventListener('DOMContentLoaded', function () {{ try {{ report(); }} catch (e2) {{}} }}); }}
}})();"#
    )
}

/// The page stored the entries: write the marker so the next start does not offer them again.
#[tauri::command]
pub async fn mc_webview_import_done(
    webview: Webview,
    ctx: State<'_, Arc<AppContext>>,
    state: State<'_, WebviewImport>,
    id: String,
    imported: usize,
    kept: usize,
    error: Option<String>,
) -> Result<(), String> {
    if webview.label() != crate::windows::MAIN {
        return Err("refused".into());
    }
    let taken = {
        let mut pending = state.pending.lock();
        match pending.as_ref() {
            Some(p) if p.id == id => pending.take(),
            _ => None,
        }
    };
    let Some(done) = taken else { return Ok(()) };
    if let Some(e) = &error {
        ctx.crash.warn(&format!("localStorage of 1.1.x: {imported} of {} entries stored, then: {e}", done.entries.len()));
    }
    ctx.mark("webview-import-done");
    import::write_marker(&ctx.data_dir, &Marker::new(done.entries.len(), imported, kept, error, true)).map_err(|e| {
        ctx.crash.warn(&format!("webview-import.json: {e}"));
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use unimux_state::webview_import::Entry;

    #[test]
    fn the_script_carries_every_entry_as_a_literal() {
        let u = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        let import = Import {
            id: "abc".into(),
            entries: vec![Entry { key: u("k\"1"), value: u("v\n1") }, Entry { key: u("draft"), value: vec![0xd800] }],
        };
        let s = script(&import);
        assert!(s.contains(r#"var id = "abc", entries = [["k\"1","v\n1"],["draft","\ud800"]]"#), "{s}");
        assert!(s.contains("mc_webview_import_done"));
        assert!(!s.contains('\u{2014}'));
    }
}
