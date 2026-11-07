//! Windows backend: `unimux_pty::conpty` (SP5), with node-pty's options from PtyManager (`useConpty`, `useConptyDll`).

use std::io;
use std::sync::Arc;

use unimux_pty::conpty::{ConptyApi, ConptySource, Pty, SpawnOptions};

use super::{DataFn, ExitFn, Launch, Term};

struct WinTerm(Pty);

impl Term for WinTerm {
    fn pid(&self) -> u32 {
        self.0.pid()
    }

    fn write(&self, data: &[u8]) {
        self.0.write(data);
    }

    fn resize(&self, cols: u16, rows: u16) {
        // Resizing a pty that is exiting fails; harmless (PtyManager.resize ignores it too).
        let _ = self.0.resize(cols, rows);
    }

    fn kill(&self) {
        self.0.kill();
    }

    fn kill_tree(&self) {
        // Pty::kill ends the shell and then the Job Object, i.e. the whole tree; a second call finishes what is left.
        self.0.kill();
    }

    fn source(&self) -> String {
        match self.0.source() {
            ConptySource::Bundled(dir) => format!("bundled:{}", dir.display()),
            ConptySource::Inbox => "inbox".into(),
        }
    }
}

pub fn spawn(launch: &Launch, on_data: DataFn, on_exit: ExitFn) -> io::Result<Arc<dyn Term>> {
    // UNIMUX_CONPTY_DIR (test/helpers/nodeHost.ts points it at node-pty's conpty.dll 1.23, the one 1.1.4 ships), then the
    // folders next to the exe, else the in-box API.
    let api = ConptyApi::shared()?;
    let opts = SpawnOptions {
        file: launch.file.clone(),
        args: launch.args.clone(),
        cwd: launch.cwd.clone(),
        env: Some(launch.env.clone()),
        cols: launch.cols,
        rows: launch.rows,
        flags: 0,
        job: true,
    };
    Ok(Arc::new(WinTerm(Pty::spawn(api, &opts, on_data, on_exit)?)))
}
