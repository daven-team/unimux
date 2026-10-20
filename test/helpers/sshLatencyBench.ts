// SSH typing latency bench (scripts/ssh-latency-bench.mjs bundles and runs this): keystroke -> echo delivered to the
// "renderer", per scenario (network round trip, echo shape, Pty Host load). Plain Node, not vitest: inside a vitest worker a
// MessagePort round trip to a worker thread took about 11 ms (0.1 ms in plain Node, Windows), which would drown the result.
// The Pty Host is modelled as in src/ptyhost/index.ts: SshManager, OutputBatcher and HostRouter on this thread. The renderer
// is a worker thread on a MessageChannel: it types (random gaps), acks output like TerminalManager and timestamps what it
// receives. The server is a child process (test/helpers/sshLatencyServer.mjs) behind a proxy that delays both directions.
// Load = local terminals streaming like busy agents through their own OutputChannels into the same batcher, plus short
// bursts of CPU work on the host's event loop (garbage collection, large flushes).
import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { performance as nodePerformance } from 'node:perf_hooks';
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';
import { OutputBatcher } from '../../src/ptyhost/batch';
import type { PtySink } from '../../src/ptyhost/manager';
import { OutputChannel } from '../../src/ptyhost/output';
import { HostRouter, type TerminalBackend } from '../../src/ptyhost/router';
import { SshManager } from '../../src/ptyhost/ssh';
import { SshLogin } from '../../src/sshcore/login';
import type { HostToRendererPort, RendererToHost } from '../../src/shared/ipc';

/** One clock for this thread, the worker and the logs (epoch milliseconds with sub-millisecond precision). */
const now = () => performance.timeOrigin + performance.now();
const eventLoopUtilization = nodePerformance.eventLoopUtilization.bind(nodePerformance);

export interface Load { agents: number; chunk: number; everyMs: number; burnMs: number; burnEveryMs: number }

export interface Scenario {
  name: string;
  rttMs: number;
  mode: 'simple' | 'split';
  load?: Load;
  /** Client cipher list (default: what SshLogin offers, i.e. ssh2's defaults). */
  ciphers?: string[];
  /**
   * 'steady' (default): 100 to 400 ms between keys. 'bursts': a fast typist, words of 3 to 8 keys 120 to 180 ms apart (faster
   * than a far server answers, so echoes overlap the typing) and 1 to 2 s between words.
   */
  typing?: 'steady' | 'bursts';
}

/** 16 agents streaming about 50 KB/s each. */
export const AGENTS: Load = { agents: 16, chunk: 1500, everyMs: 30, burnMs: 0, burnEveryMs: 0 };
/** The same, and 4 ms of other work every 40 ms (10 % of a core: garbage collection, large flushes, replays). */
export const LOAD: Load = { ...AGENTS, burnMs: 4, burnEveryMs: 40 };

export const SCENARIOS: Scenario[] = [
  { name: 'rtt0 simple', rttMs: 0, mode: 'simple' },
  { name: 'rtt40 simple', rttMs: 40, mode: 'simple' },
  { name: 'rtt120 simple', rttMs: 120, mode: 'simple' },
  { name: 'rtt200 simple', rttMs: 200, mode: 'simple' },
  { name: 'rtt40 split', rttMs: 40, mode: 'split' },
  { name: 'rtt200 split', rttMs: 200, mode: 'split' },
  { name: 'rtt40 simple agents', rttMs: 40, mode: 'simple', load: AGENTS },
  { name: 'rtt0 simple load', rttMs: 0, mode: 'simple', load: LOAD },
  { name: 'rtt40 simple load', rttMs: 40, mode: 'simple', load: LOAD },
  { name: 'rtt200 simple load', rttMs: 200, mode: 'simple', load: LOAD },
  { name: 'rtt40 split load', rttMs: 40, mode: 'split', load: LOAD },
  { name: 'rtt0 chacha20', rttMs: 0, mode: 'simple', ciphers: ['chacha20-poly1305@openssh.com'] },
  { name: 'rtt0 aes128-ctr+etm', rttMs: 0, mode: 'simple', ciphers: ['aes128-ctr'] },
  { name: 'rtt200 bursts', rttMs: 200, mode: 'simple', typing: 'bursts' },
  { name: 'rtt300 bursts', rttMs: 300, mode: 'simple', typing: 'bursts' },
];

/** Gaps after each key of Scenario.typing 'bursts'; `rand` gives non-negative integers. */
function burstGaps(count: number, rand: () => number): number[] {
  const gaps: number[] = [];
  let left = 0;
  for (let i = 0; i < count; i++) {
    if (left === 0) left = 3 + (rand() % 6);
    left--;
    gaps.push(left === 0 ? 1000 + (rand() % 1000) : 120 + (rand() % 61));
  }
  return gaps;
}

/** The renderer: types into `id`, acks every terminal's output (8 ms, like TerminalManager) and logs what `id` receives. */
const RENDERER = `
const { parentPort } = require('node:worker_threads');
const now = () => performance.timeOrigin + performance.now();
let port, id;
const sends = [], recvs = [], acks = new Map();
let ackTimer = null;
parentPort.on('message', (m) => {
  if (m.cmd === 'port') {
    port = m.port; id = m.id;
    port.on('message', (msg) => {
      const at = now();
      const items = msg.t === 'dataBatch' ? msg.items : msg.t === 'data' ? [[msg.id, msg.data]] : [];
      for (const [tid, data] of items) {
        if (tid === id) recvs.push([at, data]);
        acks.set(tid, (acks.get(tid) || 0) + data.length);
      }
      if (items.length && !ackTimer) ackTimer = setTimeout(() => {
        ackTimer = null;
        for (const [tid, chars] of acks) port.postMessage({ t: 'ack', id: tid, chars });
        acks.clear();
      }, 8);
    });
    port.postMessage({ t: 'focus', id });
  } else if (m.cmd === 'type') {
    let i = 0;
    const next = () => {
      if (i >= m.keys.length) { parentPort.postMessage({ cmd: 'typed' }); return; }
      const key = m.keys[i++];
      sends.push([now(), key]);
      port.postMessage({ t: 'write', id, data: key });
      setTimeout(next, m.gaps[i - 1]);
    };
    next();
  } else if (m.cmd === 'report') {
    parentPort.postMessage({ cmd: 'report', sends, recvs });
    sends.length = 0; recvs.length = 0;
  }
});
`;

function startServer(s: Scenario): Promise<{ child: ChildProcess; port: number }> {
  const child = fork(resolve('test/helpers/sshLatencyServer.mjs'), [JSON.stringify({ rttMs: s.rttMs, mode: s.mode })], { stdio: 'ignore' });
  return new Promise((done, fail) => {
    child.once('message', (m) => done({ child, port: (m as { port: number }).port }));
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`server exited ${code}`)));
  });
}

/**
 * Makes this thread's setTimeout fire like Windows' default timer resolution (15.625 ms ticks): at the first tick after it is
 * due. Windows runs at that resolution unless some program asks for a finer one (browsers and Electron apps often do while
 * they animate; on battery they often do not), so the host's coalescing timers cost a tick or two there.
 */
export function coarseTimers(tickMs = 15.625): void {
  const original = globalThis.setTimeout;
  const coarse = (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const now = performance.now();
    const due = Math.ceil((now + Math.max(1, ms ?? 0)) / tickMs) * tickMs;
    return original(fn, due - now, ...rest);
  };
  globalThis.setTimeout = coarse as typeof setTimeout;
}

export function pct(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const fmt = (values: number[]) => `${pct(values, 50).toFixed(1)} / ${pct(values, 95).toFixed(1)} / ${pct(values, 100).toFixed(1)}`;

/** First time a log entry contains `needle`. */
const firstAt = (log: Array<[number, string]>, needle: string): number => log.find(([, d]) => d.includes(needle))?.[0] ?? NaN;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await sleep(10);
  }
}

export interface Result {
  scenario: string;
  cipher: string;
  writesPerKey: number;
  /** Share of the time the host's event loop was busy while the keys were typed. */
  hostBusy: number;
  /** Per key, ms: renderer send -> renderer receive of the echo. */
  total: number[];
  /** Host received the keystroke -> its echo arrived from the socket (network and server). */
  network: number[];
  /** Echo arrived from the socket -> posted to the renderer (what the Pty Host adds). */
  pipeline: number[];
  /** Renderer send -> host received the keystroke (the host's event loop and the port). */
  input: number[];
  /** Posted -> renderer received. */
  deliver: number[];
  /** "split" only: the redraw that follows the echo, total and host pipeline. */
  redrawTotal: number[];
  redrawPipeline: number[];
}

export async function runScenario(s: Scenario, keyCount: number): Promise<Result> {
  const server = await startServer(s);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(RENDERER, { eval: true });
  const hostRecv: Array<[number, string]> = [];
  const posts: Array<[number, string]> = [];
  const arrivals: Array<[number, string]> = [];
  const debug: string[] = [];
  // index.ts: terminal output of one turn goes out as one message; posts are logged for the SSH cell only.
  const batcher = new OutputBatcher((m: HostToRendererPort) => {
    const at = now();
    const items = m.t === 'dataBatch' ? m.items : m.t === 'data' ? [[m.id, m.data] as [string, string]] : [];
    for (const [id, data] of items) if (id === 'ssh') posts.push([at, data]);
    port1.postMessage(m);
  });
  // Wired like index.ts (extra arguments are passed on, so the bench runs against older and newer sinks alike).
  const sink = {
    data: (id: string, data: string, ...rest: unknown[]) => { (batcher.data as (...a: unknown[]) => void).call(batcher, id, data, ...rest); return true; },
    exit: () => batcher.flush(),
  } as PtySink;
  const ssh = new SshManager(sink, {
    spawned: () => undefined,
    status: () => undefined,
    hostKey: (id, promptId) => ssh.answerHostKey(id, promptId, true),
    authPrompt: () => undefined,
    debug: (_id, line) => debug.push(line),
  });
  const loads = new Map<string, OutputChannel>();
  const loadBackend: TerminalBackend = {
    has: (id) => loads.has(id), write: () => undefined, resize: () => undefined, ack: (id, chars) => loads.get(id)?.ack(chars),
    setFlowControl: () => undefined, histories: () => [], kill: async () => undefined, killAll: async () => undefined,
  };
  const router = new HostRouter([loadBackend, ssh]);
  port1.on('message', (m: RendererToHost) => {
    if (m.t === 'write') hostRecv.push([now(), m.data]);
    router.message(m);
  });
  router.setFlowControl(true);
  worker.postMessage({ cmd: 'port', port: port2, id: 'ssh' }, [port2 as unknown as MessagePort]);

  const original = SshLogin.prototype.connectConfig;
  if (s.ciphers) {
    SshLogin.prototype.connectConfig = function (this: SshLogin) { return { ...original.call(this), algorithms: { cipher: s.ciphers as never } }; };
  }
  const timers: NodeJS.Timeout[] = [];
  try {
    ssh.connect({ id: 'ssh', host: '127.0.0.1', port: server.port, username: 'alice', cols: 120, rows: 30, allowPasswordPrompt: false, debug: true });
    type Sock = { _writeGeneric: (...a: unknown[]) => unknown };
    const session = () => (ssh as unknown as { sessions: Map<string, { stream: NodeJS.ReadableStream | null; client: { _sock: Sock } }> }).sessions.get('ssh');
    await waitFor(() => !!session()?.stream);
    const sess = session()!;
    sess.stream!.prependListener('data', (chunk: Buffer) => arrivals.push([now(), chunk.toString('utf8')]));
    // Writes that reach the OS (a corked burst is one), counted while typing.
    let socketWrites = 0;
    const writeGeneric = sess.client._sock._writeGeneric;
    sess.client._sock._writeGeneric = function (this: unknown, ...a: unknown[]) { socketWrites++; return writeGeneric.apply(this, a); };
    await sleep(300);

    if (s.load) {
      const { agents, chunk, everyMs, burnMs, burnEveryMs } = s.load;
      const text = (n: number) => `\x1b[2K\x1b[38;5;${n % 200}m${'agent output '.repeat(Math.ceil(chunk / 13)).slice(0, chunk)}\x1b[0m\r\n`;
      for (let i = 0; i < agents; i++) {
        const id = `load${i}`;
        const out = new OutputChannel(id, () => sink, { pause: () => undefined, resume: () => undefined }, () => true);
        loads.set(id, out);
        timers.push(setInterval(() => out.push(text(i)), everyMs + (i % 5) - 2));
      }
      if (burnMs > 0) timers.push(setInterval(() => { const end = performance.now() + burnMs; while (performance.now() < end) { /* busy */ } }, burnEveryMs));
      await sleep(500);
    }

    // Unique characters per key (CJK), so every echo is found in the logs; gaps of a person typing or moving around.
    const keys = Array.from({ length: keyCount }, (_, i) => String.fromCodePoint(0x4e00 + i));
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    const gaps = s.typing === 'bursts' ? burstGaps(keys.length, rand) : keys.map(() => 100 + (rand() % 300));
    const typed = new Promise<void>((done) => worker.once('message', () => done()));
    const writesBefore = socketWrites;
    const eluBefore = eventLoopUtilization();
    worker.postMessage({ cmd: 'type', keys, gaps });
    await typed;
    const hostBusy = eventLoopUtilization(eluBefore).utilization;
    const writesPerKey = (socketWrites - writesBefore) / keys.length;
    await sleep(s.rttMs + 300);
    const report = new Promise<{ sends: Array<[number, string]>; recvs: Array<[number, string]> }>((done) => worker.once('message', (m) => done(m)));
    worker.postMessage({ cmd: 'report' });
    const { sends, recvs } = await report;

    const r: Result = {
      scenario: s.name, cipher: debug.map((l) => /^Handshake: C->S Cipher: (\S+)/.exec(l)?.[1]).find(Boolean) ?? '?', writesPerKey, hostBusy,
      total: [], network: [], pipeline: [], input: [], deliver: [], redrawTotal: [], redrawPipeline: [],
    };
    for (const [sent, key] of sends) {
      const hr = firstAt(hostRecv, key), ar = firstAt(arrivals, key), po = firstAt(posts, key), rc = firstAt(recvs, key);
      r.total.push(rc - sent); r.input.push(hr - sent); r.network.push(ar - hr); r.pipeline.push(po - ar); r.deliver.push(rc - po);
      if (s.mode === 'split') {
        const redraw = String.fromCodePoint(key.codePointAt(0)! + 0x1000);
        r.redrawTotal.push(firstAt(recvs, redraw) - sent);
        r.redrawPipeline.push(firstAt(posts, redraw) - firstAt(arrivals, redraw));
      }
    }
    if (!r.total.every(Number.isFinite)) throw new Error(`${s.name}: an echo never arrived`);
    return r;
  } finally {
    SshLogin.prototype.connectConfig = original;
    for (const t of timers) clearInterval(t);
    for (const out of loads.values()) out.dispose();
    await ssh.killAll();
    await worker.terminate();
    port1.close();
    server.child.kill();
  }
}

/** One printable row per result: p50 / p95 / max in ms. */
export function summarize(r: Result): Record<string, string> {
  return {
    scenario: r.scenario, cipher: r.cipher, 'writes/key': r.writesPerKey.toFixed(2), 'host busy': `${Math.round(r.hostBusy * 100)} %`,
    total: fmt(r.total), network: fmt(r.network), 'host pipeline': fmt(r.pipeline),
    // An echo held by a coalescing timer shows here (or a host busy with other work: see the load scenarios).
    'pipeline > 2 ms': `${r.pipeline.filter((ms) => ms > 2).length} / ${r.pipeline.length}`,
    'input queue': fmt(r.input), 'to renderer': fmt(r.deliver),
    ...(r.redrawTotal.length ? { 'redraw total': fmt(r.redrawTotal), 'redraw pipeline': fmt(r.redrawPipeline) } : {}),
  };
}
