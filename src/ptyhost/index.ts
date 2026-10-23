// Pty Host entry (Electron utilityProcess). Control messages come from main via parentPort;
// terminal data flows directly to/from the renderer over a transferred MessagePort.
import type { MessagePortMain } from 'electron';
import type { HostToMain, HostToRenderer, MainToHost, RendererToHost } from '../shared/ipc';
import { OutputBatcher } from './batch';
import { PtyManager, type PtySink } from './manager';
import { HostRouter } from './router';
import { MAIN_WINDOW, WindowRoutes } from './routes';
import { SshManager } from './ssh';

const parentPort = process.parentPort;

/** One renderer window's data port (the main window, and since 1.0.6 each detached window) with its own output batcher. */
interface RendererLink { port: MessagePortMain; batcher: OutputBatcher }
const links = new Map<string, RendererLink>();
/** Which window shows which terminal (main routes the cells of detached grids). */
const routes = new WindowRoutes();

const toMain = (m: HostToMain) => parentPort.postMessage(m);

/** Message and stack of an error, cut to a size the crash log can take (never the payload of a message: SSH secrets). */
const describeError = (error: unknown): string =>
  (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4000);
const logToMain = (level: 'error' | 'warn', message: string) => { try { toMain({ t: 'log', level, message }); } catch { /* main is gone */ } };
// One failing terminal (a stream error nobody listened to, a bug in a backend) must not end the host and every other terminal
// with it: the error is reported to main's crash log and the host keeps running.
process.on('uncaughtException', (error) => logToMain('error', `pty host uncaught exception: ${describeError(error)}`));
process.on('unhandledRejection', (reason) => logToMain('error', `pty host unhandled rejection: ${describeError(reason)}`));
/** `echo`: typed output, posted at once (see OutputBatcher.data). False when the terminal's window has no port (yet). */
const toRenderer = (m: HostToRenderer, echo = false): boolean => {
  const link = links.get(routes.ownerOf(m.id));
  if (!link) return false;
  if (m.t === 'data') { link.batcher.data(m.id, m.data, echo); return true; }
  link.batcher.flush(); // output of a terminal always arrives before its exit
  link.port.postMessage(m);
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

function attachRenderer(port: MessagePortMain, window: string): void {
  const old = links.get(window);
  // Queued output is part of the replay tails the new renderer gets below.
  old?.batcher.drop();
  old?.port.close();
  if (window === MAIN_WINDOW) router.rendererAttached();
  const link: RendererLink = { port, batcher: new OutputBatcher((m) => port.postMessage(m)) };
  links.set(window, link);
  port.on('message', (e) => {
    const m = e.data as RendererToHost;
    // A window speaks only for its own terminals (a detached grid's cells are not the main window's any more).
    if (!routes.accepts(window, m)) return;
    if (m.t === 'focus') {
      const id = routes.focus(window, typeof m.id === 'string' ? m.id : null);
      if (id !== undefined) router.message({ t: 'focus', id });
      return;
    }
    router.message(m);
    if (m.t === 'write' && tapped.has(m.id) && m.data.includes('')) toMain({ t: 'interrupt', id: m.id });
  });
  port.on('close', () => {
    // Only the current port counts: replacing it closes the old one after the new one is in place.
    if (links.get(window) !== link) return;
    links.delete(window);
    if (window === MAIN_WINDOW) router.setFlowControl(false);
  });
  port.start();
  if (window === MAIN_WINDOW) router.setFlowControl(true);
  for (const h of router.histories()) if (routes.ownerOf(h.id) === window) toRenderer({ t: 'replay', id: h.id, data: h.data });
}

/** A terminal moved to another window: the old window's queued output goes out first, the new one gets the replay tail. */
function route(id: string, window: string | null): void {
  const before = routes.set(id, window);
  if (before === null) return;
  links.get(before)?.batcher.flush();
  // Acks of output the old window parsed never come from the new one.
  router.resetFlow(id);
  const history = router.history(id);
  if (history !== undefined) toRenderer({ t: 'replay', id, data: history });
}

parentPort.on('message', (e) => {
  void handleMain(e).catch((error) => logToMain('error', `pty host message failed: ${describeError(error)}`));
});

async function handleMain(e: { data: unknown; ports: MessagePortMain[] }): Promise<void> {
  const m = e.data as MainToHost | { t: 'port'; window?: string };
  switch (m.t) {
    case 'port':
      attachRenderer(e.ports[0], typeof m.window === 'string' ? m.window : MAIN_WINDOW);
      break;
    case 'route':
      route(m.id, m.window);
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
