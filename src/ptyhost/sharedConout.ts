// One ConPTY output thread for every terminal of the Pty Host (Windows).
// node-pty 1.1.0 reads each terminal's conout pipe on a Worker of its own (a ClosePseudoConsole deadlock: the pipe must be
// drained off the thread that closes the console) and serves it to the main thread on a second named pipe. Every Worker is a
// V8 isolate with a Node environment: about 9 MB per terminal (28 cells: about 250 MB of the Pty Host), for a thread that only
// pipes bytes. Here a single Worker does that for all terminals; it never calls into ConPTY, so the drain still happens off the
// main thread. Every pipe has its own streams and back-pressure (a paused terminal does not slow the others) and its own error
// handlers (a broken pipe ends that terminal only). node-pty's ConoutConnection is replaced on its module object, before the
// first spawn; the class below keeps its interface (onReady, connectSocket, dispose and the 1 s drain before the close).
import type { Socket } from 'net';
import { Worker } from 'worker_threads';

/** node-pty's FLUSH_DATA_INTERVAL: output that arrives after the exit still reaches the terminal. */
export const CONOUT_DRAIN_MS = 1000;

/**
 * The thread: `open` connects to a conout pipe and serves it on `<pipe>-worker` (node-pty's getWorkerPipeName), then answers
 * `ready`; `close` ends that pipe's sockets and server. A pipe whose console closed is let go of on its own and reported as
 * `closed`: node-pty (with the ConPTY DLL) disposes its connection only when output still comes after a kill, and never for a
 * terminal that exited by itself, so its own Worker stayed for good (1.0.4: about 9.8 MB and a thread per closed or restarted
 * cell). Decoding as UTF-8 here is what node-pty's own worker does.
 */
const WORKER_SOURCE = `
const { parentPort } = require('worker_threads');
const net = require('net');
const pipes = new Map();
// After an end, 'closed' waits for the terminal's socket to close: what it still buffers (a paused terminal) reaches it.
const closed = (name, p) => { if (!p.reported && p.clients.size === 0) { p.reported = true; parentPort.postMessage({ t: 'closed', name }); } };
const close = (name, destroy) => {
  const p = pipes.get(name);
  if (!p) return;
  pipes.delete(name);
  p.ending = true;
  if (destroy) { p.conout.destroy(); for (const c of p.clients) c.destroy(); }
  if (p.server) p.server.close(() => undefined);
  closed(name, p);
};
parentPort.on('message', (m) => {
  if (m.t === 'close') { close(m.name, true); return; }
  if (m.t !== 'open' || pipes.has(m.name)) return;
  const conout = new net.Socket();
  const p = { conout, server: null, clients: new Set(), ending: false, reported: false, connected: false, ended: false, grace: undefined };
  pipes.set(m.name, p);
  conout.setEncoding('utf8');
  conout.on('error', () => close(m.name, true));
  // The console closed and its last output went to the terminal. Before the terminal connected (a shell that ended at once),
  // the server waits a little for it: node-pty treats a failed connect as an error.
  conout.on('end', () => {
    p.ended = true;
    if (p.connected) close(m.name, false);
    else p.grace = setTimeout(() => close(m.name, false), 5000);
  });
  conout.connect(m.name, () => {
    if (pipes.get(m.name) !== p) return;
    p.server = net.createServer((client) => {
      p.connected = true;
      clearTimeout(p.grace);
      p.clients.add(client);
      client.on('error', () => undefined);
      client.on('close', () => { p.clients.delete(client); if (p.ending) closed(m.name, p); });
      if (p.ended) { client.end(); close(m.name, false); return; }
      conout.pipe(client);
    });
    p.server.on('error', () => close(m.name, true));
    p.server.listen(m.name + '-worker');
    parentPort.postMessage({ t: 'ready', name: m.name });
  });
});
`;

/** Young 2 MB, old 128 MB (one thread for all terminals: 5 flooding terminals peaked at 4.6 MB of heap on their own worker). */
const LIMITS = { maxYoungGenerationSizeMb: 2, maxOldGenerationSizeMb: 128, codeRangeSizeMb: 4, stackSizeMb: 1 };

type Listener = () => void;

/** The shared thread and the pipes it serves (module state: one per Pty Host). */
let worker: Worker | null = null;
const waiting = new Map<string, Set<Listener>>();
const connections = new Map<string, SharedConoutConnection>();
let open = 0;
let started = 0;

function thread(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_SOURCE, { eval: true, resourceLimits: LIMITS });
  started++;
  w.on('message', (m: { t?: string; name?: string }) => {
    if (typeof m?.name !== 'string') return;
    if (m.t === 'closed') { connections.get(m.name)?.released(); return; }
    if (m.t !== 'ready') return;
    const listeners = waiting.get(m.name);
    waiting.delete(m.name);
    listeners?.forEach((l) => l());
  });
  // A dead thread closes every pipe it served: node-pty reports those terminals' exits. The next terminal starts a new one.
  w.on('error', (e) => console.error('unimux: shared conout worker failed', e));
  w.on('exit', () => {
    if (worker !== w) return;
    worker = null;
    for (const c of [...connections.values()]) c.released();
  });
  worker = w;
  return w;
}

/** node-pty's ConoutConnection, served by the shared thread. */
export class SharedConoutConnection {
  private disposed = false;
  private closed = false;
  private drain: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly pipe: string, private readonly useConptyDll = false) {
    open++;
    connections.set(pipe, this);
    waiting.set(pipe, this.listeners);
    thread().postMessage({ t: 'open', name: pipe });
  }

  /** node-pty's `onReady` event: the listener runs once the worker pipe accepts connections. */
  readonly onReady = (listener: Listener): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  connectSocket(socket: Socket): void {
    socket.connect(`${this.pipe}-worker`);
  }

  /** Like node-pty: every call (re)starts the drain window; the pipe closes once it passed (with the DLL it may come twice). */
  dispose(): void {
    if (this.closed || (!this.useConptyDll && this.disposed)) return;
    this.disposed = true;
    clearTimeout(this.drain);
    this.drain = setTimeout(() => this.close(), CONOUT_DRAIN_MS);
  }

  private close(): void {
    if (this.closed) return;
    worker?.postMessage({ t: 'close', name: this.pipe });
    this.released();
  }

  /** The pipe is gone in the thread (closed from here, its console closed, or the thread died). */
  released(): void {
    clearTimeout(this.drain);
    if (this.closed) return;
    this.closed = true;
    waiting.delete(this.pipe);
    if (connections.get(this.pipe) === this) connections.delete(this.pipe);
    open--;
    // No terminal left: the thread goes too (the next spawn starts a new one).
    const w = worker;
    if (open === 0 && w) {
      worker = null;
      setTimeout(() => void w.terminate(), 100);
    }
  }
}

/** Open pipes and threads started so far (tests, diagnostics). */
export const sharedConoutStats = () => ({ open, started, running: worker !== null });

/** Puts the shared connection in place of node-pty's own (its windowsPtyAgent reads the class from the module at every spawn). */
export function installSharedConout(conoutModule: { ConoutConnection: unknown }): void {
  conoutModule.ConoutConnection = SharedConoutConnection;
}
