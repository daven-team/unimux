// The pty port of the Tauri build (P2): what TerminalManager gets instead of 1.1.4's MessagePort. Host -> page messages are
// binary frames (src/shared/ptyFrames.ts) arriving on one of three transports, chosen by Rust at attach (pty_transport.rs):
//   sharedBuffer  WebView2 `sharedbufferreceived` events (Windows), additional data {mcPort: 'pty', a, n}: `a` is this
//                 page's attach id (buffers an earlier attach posted during a reload are dropped), `n` the host's number,
//   pull          a long poll of `mc_port_pull`, one request in flight (macOS),
//   channel       the attach Channel (fallback).
// Each message is handed to TerminalManager synchronously (onmessage), then released: the shared buffer is given back and
// a release ack `{t: 'released', upto: n}` goes to the host (`n`: the host's number of the message when the transport
// carries it, else the page's own count, which matches the host's for a transport of one attach), which keeps at most a
// few messages per window in flight
// (renderer back-pressure; the FlowGate byte acks hold the terminals themselves back). Page -> host messages (write,
// resize, ack, focus, released) go through `post`, in order.

export interface PtyPortStats {
  transport: string;
  /** Messages handed to TerminalManager. */
  received: number;
  /** Highest (posted - released) seen when a shared buffer arrived: the host's number of the message minus releases. */
  maxInFlight: number;
  /** Shared buffers of another attach (posted to the page before it reloaded), dropped. */
  stale: number;
  bytes: number;
}

export interface PtyPortHost {
  /** Page -> host messages of the port (ordered, batched by the caller). */
  post(message: unknown): void;
}

export interface BridgePtyPort {
  postMessage(message: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  start(): void;
  close(): void;
  /** A message from the host (Uint8Array frames or a JSON message). `n`: the host's number of it, when known. */
  deliver(data: unknown, n?: number): void;
  readonly stats: PtyPortStats;
}

export function createPtyPort(host: PtyPortHost, transport: string): BridgePtyPort {
  const queue: Array<{ data: unknown; n?: number }> = [];
  let closed = false;
  let handled = 0;
  let released = 0;
  const stats: PtyPortStats = { transport, received: 0, maxInFlight: 0, bytes: 0, stale: 0 };
  const handle = (data: unknown, n?: number) => {
    if (n !== undefined) stats.maxInFlight = Math.max(stats.maxInFlight, n - released);
    try {
      port.onmessage?.({ data });
    } finally {
      stats.received++;
      if (data instanceof Uint8Array) {
        stats.bytes += data.length;
        handled++;
        // By the host's number: a lost or foreign message can never put the page's count ahead of the host's.
        released = n ?? handled;
        host.post({ t: 'released', upto: released });
      }
    }
  };
  const port: BridgePtyPort = {
    onmessage: null,
    postMessage: (message) => { if (!closed) host.post(message); },
    start: () => { while (queue.length && port.onmessage) { const m = queue.shift()!; handle(m.data, m.n); } },
    close: () => { closed = true; queue.length = 0; },
    deliver: (data, n) => {
      if (closed) return;
      if (!port.onmessage || queue.length) { queue.push({ data, n }); return; }
      handle(data, n);
    },
    stats,
  };
  return port;
}

/** WebView2's `sharedbufferreceived` event (ICoreWebView2_17). */
export interface SharedBufferEvent { additionalData?: { mcPort?: string; a?: string; n?: number }; getBuffer(): ArrayBuffer }
export interface SharedBufferHost {
  addEventListener(type: 'sharedbufferreceived', cb: (e: SharedBufferEvent) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}

/**
 * Routes the pty port's shared buffers into `port` (a copy: the buffer is given back right after). `attach`: this page's
 * attach id; buffers of another attach (the old page's batcher still posting while this page loaded) are released and
 * dropped, their output is in the replay tails this attach gets.
 */
export function listenSharedBuffers(webview: SharedBufferHost, port: BridgePtyPort, attach?: string): void {
  webview.addEventListener('sharedbufferreceived', (e) => {
    if (e.additionalData?.mcPort !== 'pty') return;
    const buffer = e.getBuffer();
    if (attach !== undefined && e.additionalData.a !== attach) {
      webview.releaseBuffer(buffer);
      port.stats.stale++;
      return;
    }
    let copy: Uint8Array;
    try { copy = new Uint8Array(buffer).slice(); } finally { webview.releaseBuffer(buffer); }
    port.deliver(copy, typeof e.additionalData.n === 'number' ? e.additionalData.n : undefined);
  });
}

/** The pull transport: one `pull()` in flight; an empty answer asks again, a rejection (port replaced) stops. */
export async function runPull(pull: () => Promise<ArrayBuffer | Uint8Array>, port: BridgePtyPort, stopped: () => boolean): Promise<void> {
  while (!stopped()) {
    let body: ArrayBuffer | Uint8Array;
    try { body = await pull(); } catch { return; }
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    if (bytes.length) port.deliver(bytes);
  }
}
