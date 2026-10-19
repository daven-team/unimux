// Pty Host entry (Electron utilityProcess). Control messages come from main via parentPort;
// terminal data flows directly to/from the renderer over a transferred MessagePort.
import type { MessagePortMain } from 'electron';
import type { HostToMain, HostToRenderer, MainToHost, RendererToHost } from '../shared/ipc';
import { OutputBatcher } from './batch';
import { PtyManager, type PtySink } from './manager';
import { setFocusedTerminal } from './output';
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
const toRenderer = (m: HostToRenderer): boolean => {
  if (!rendererPort) return false;
  if (m.t === 'data') { batcher.data(m.id, m.data); return true; }
  batcher.flush(); // output of a terminal always arrives before its exit
  rendererPort.postMessage(m);
  return true;
};

/** Terminals whose output main also wants to read (the install window). */
const tapped = new Set<string>();

/** Shared by both backends: renderer data, the install window tap and exits. */
const sink: PtySink = {
  data: (id, data) => {
    if (tapped.has(id)) toMain({ t: 'tap', id, data });
    return toRenderer({ t: 'data', id, data });
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
  // The new renderer reports its focused terminal itself.
  setFocusedTerminal(null);
  rendererPort = port;
  port.on('message', (e) => {
    const m = e.data as RendererToHost;
    if (m.t === 'write') {
      router.write(m.id, m.data);
      if (tapped.has(m.id) && m.data.includes('\x03')) toMain({ t: 'interrupt', id: m.id });
    } else if (m.t === 'resize') router.resize(m.id, m.cols, m.rows);
    else if (m.t === 'ack') router.ack(m.id, m.chars);
    else if (m.t === 'focus') setFocusedTerminal(typeof m.id === 'string' ? m.id : null);
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
