// Pty Host entry (Electron utilityProcess). Control messages come from main via parentPort;
// terminal data flows directly to/from the renderer over a transferred MessagePort.
import type { MessagePortMain } from 'electron';
import type { HostToMain, HostToRenderer, MainToHost, RendererToHost } from '../shared/ipc';
import { OutputBatcher } from './batch';
import { PtyManager, type PtySink } from './manager';
import { HostRouter } from './router';
import { SshManager } from './ssh';

const parentPort = process.parentPort;
let rendererPort: MessagePortMain | null = null;

const toMain = (m: HostToMain) => parentPort.postMessage(m);
/** Terminal output of one event-loop turn goes out as one message (16 busy terminals would otherwise be one message each). */
const batcher = new OutputBatcher((m) => rendererPort?.postMessage(m));

/** Message and stack of an error, cut to a size the crash log can take (never the payload of a message: SSH secrets). */
const describeError = (error: unknown): string =>
  (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4000);
const logToMain = (level: 'error' | 'warn', message: string) => { try { toMain({ t: 'log', level, message }); } catch { /* main is gone */ } };
// One failing terminal (a stream error nobody listened to, a bug in a backend) must not end the host and every other terminal
// with it: the error is reported to main's crash log and the host keeps running.
process.on('uncaughtException', (error) => logToMain('error', `pty host uncaught exception: ${describeError(error)}`));
process.on('unhandledRejection', (reason) => logToMain('error', `pty host unhandled rejection: ${describeError(reason)}`));
/** `echo`: typed output, posted at once (see OutputBatcher.data). */
const toRenderer = (m: HostToRenderer, echo = false): boolean => {
  if (!rendererPort) return false;
  if (m.t === 'data') { batcher.data(m.id, m.data, echo); return true; }
  batcher.flush(); // output of a terminal always arrives before its exit
  rendererPort.postMessage(m);
  return true;
};

/** Terminals whose output main also wants to read (the install window). */
const tapped = new Set<string>();

/** Shared by both backends: renderer data, the install window tap and exits. */
const sink: PtySink = {
  data: (id, data, echo) => {
    if (tapped.has(id)) toMain({ t: 'tap', id, data });
    return toRenderer({ t: 'data', id, data }, echo === true);
  },
  exit: (id, code) => {
    tapped.delete(id);
    toRenderer({ t: 'exit', id, code });
    toMain({ t: 'exit', id, code });
  },
};
const manager = new PtyManager(sink);
// Never log messages of the ssh* types: they can carry secrets.
const ssh = new SshManager(sink, {
  spawned: (id) => toMain({ t: 'spawned', id, pid: 0 }),
  status: (id, phase, extra) => toMain({ t: 'sshStatus', id, phase, ...extra }),
  hostKey: (id, promptId, key) => toMain({ t: 'sshHostKey', id, promptId, key }),
  authPrompt: (id, promptId, prompt) => toMain({ t: 'sshAuthPrompt', id, promptId, ...prompt }),
  debug: (id, line) => console.log(`[ssh ${id.slice(0, 8)}] ${line}`),
});
/** Sends renderer messages and kills to the backend that owns the terminal. */
const router = new HostRouter([manager, ssh]);

function attachRenderer(port: MessagePortMain): void {
  rendererPort?.close();
  // Queued output is part of the replay tails the new renderer gets below.
  batcher.drop();
  router.rendererAttached();
  rendererPort = port;
  port.on('message', (e) => {
    const m = e.data as RendererToHost;
    if (m.t === 'sshList') { listFor(port, m); return; }
    router.message(m);
    if (m.t === 'write' && tapped.has(m.id) && m.data.includes('\x03')) toMain({ t: 'interrupt', id: m.id });
  });
  port.on('close', () => {
    // Only the current port counts: replacing it closes the old one after the new one is in place.
    if (rendererPort !== port) return;
    rendererPort = null;
    router.setFlowControl(false);
  });
  port.start();
  router.setFlowControl(true);
  for (const h of router.histories()) toRenderer({ t: 'replay', id: h.id, data: h.data });
}

/** SSH path completion: the answer goes back on the port that asked (a reloaded renderer never gets an old one). */
function listFor(port: MessagePortMain, m: Extract<RendererToHost, { t: 'sshList' }>): void {
  const valid = typeof m.id === 'string' && typeof m.reqId === 'number' && typeof m.dir === 'string' && m.dir.length <= 1024
    && (m.cwd === null || (typeof m.cwd === 'string' && m.cwd.length <= 4096));
  if (!valid) return;
  void ssh.list(m.id, { dir: m.dir, cwd: m.cwd, cwdOnly: m.cwdOnly === true }).then((result) => {
    if (rendererPort === port) port.postMessage({ t: 'sshListResult', id: m.id, reqId: m.reqId, result } satisfies HostToRenderer);
  });
}

parentPort.on('message', (e) => {
  void handleMain(e).catch((error) => logToMain('error', `pty host message failed: ${describeError(error)}`));
});

async function handleMain(e: { data: unknown; ports: MessagePortMain[] }): Promise<void> {
  const m = e.data as MainToHost | { t: 'port' };
  switch (m.t) {
    case 'port':
      attachRenderer(e.ports[0]);
      break;
    case 'spawn':
      try {
        if (m.req.tap) tapped.add(m.req.id);
        const early = router.takeEarlySize(m.req.id);
        toMain({ t: 'spawned', id: m.req.id, pid: manager.spawn(early ? { ...m.req, ...early } : m.req) });
      } catch (err) {
        tapped.delete(m.req.id);
        toMain({ t: 'spawnError', id: m.req.id, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    case 'sshConnect': {
      const early = router.takeEarlySize(m.req.id);
      ssh.connect(early ? { ...m.req, ...early } : m.req);
      break;
    }
    case 'sshHostKeyAnswer':
      ssh.answerHostKey(m.id, m.promptId, m.accept, m.error);
      break;
    case 'sshAuthAnswer':
      ssh.answerAuth(m.id, m.promptId, m.values);
      break;
    case 'kill':
      tapped.delete(m.id);
      await router.kill(m.id);
      if (m.ack) toMain({ t: 'killed', id: m.id });
      break;
    case 'killAll':
      tapped.clear();
      await router.killAll();
      toMain({ t: 'killedAll' });
      break;
  }
}
