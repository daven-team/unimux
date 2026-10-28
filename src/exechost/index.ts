// Exec Host entry (Electron utilityProcess "unimux Exec Host", 1.0.9): runs one program for main and reports whether it
// succeeded, so a slow process start (CreateProcess of a big binary) never blocks the main process. See main/offMainExec.ts.
import { execCall, type ExecHostReply, type ExecHostRequest } from '../main/offMainExec';

const parentPort = process.parentPort;
let started = false;

parentPort.on('message', (e) => {
  const m = e.data as ExecHostRequest;
  if (started || !m || m.t !== 'run' || !m.call) return;
  started = true;
  void execCall(m.call).then((ok) => {
    parentPort.postMessage({ t: 'done', ok } satisfies ExecHostReply);
    // Main kills the host once it has the answer; this only covers a main that went away meanwhile.
    setTimeout(() => process.exit(0), 2000).unref();
  });
});
