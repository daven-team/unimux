// P2: the binary frames of the Tauri pty data plane (unimux-pty frame.rs) as TerminalManager receives them, and the bridge's
// port object (release acks, queueing until TerminalManager listens, the shared-buffer and pull transports).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeFrames, encodeFrames, FRAME_DATA, FRAME_EXIT, FRAME_JSON, FRAME_REPLAY, FRAME_RESET, PtyFrameDecoder } from '../src/shared/ptyFrames';
import { replaySegments } from '../src/shared/replay';
import { createPtyPort, listenSharedBuffers, RELEASE_TICK_MS, runPull, type SharedBufferEvent } from '../src/renderer/src/bridge/ptyPort';

const enc = new TextEncoder();
const exitPayload = (code: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, code, true); return b; };
function replayPayload(data: Uint8Array, sizes: Array<{ at: number; cols: number; rows: number }>): Uint8Array {
  const header = enc.encode(JSON.stringify({ sizes }));
  const out = new Uint8Array(4 + header.length + data.length);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(data, 4 + header.length);
  return out;
}

describe('pty frames', () => {
  it('decode what frame.rs encodes (the Rust test vector) and refuse truncated messages', () => {
    // frame.rs round_trip_of_a_batch: data "cell-1" "hello \xc4", data "zażółć" "\x85 world", exit "cell-1" 3, data "" "".
    const msg = encodeFrames([
      { kind: FRAME_DATA, id: 'cell-1', payload: new Uint8Array([...enc.encode('hello '), 0xc4]) },
      { kind: FRAME_DATA, id: 'zażółć', payload: new Uint8Array([0x85, ...enc.encode(' world')]) },
      { kind: FRAME_EXIT, id: 'cell-1', payload: exitPayload(3) },
      { kind: FRAME_DATA, id: '', payload: new Uint8Array() },
    ]);
    const frames = decodeFrames(msg)!;
    expect(frames.map((f) => [f.kind, f.id, f.payload.length])).toEqual([[1, 'cell-1', 7], [1, 'zażółć', 7], [2, 'cell-1', 4], [1, '', 0]]);
    const one = encodeFrames([{ kind: FRAME_DATA, id: 'a', payload: enc.encode('xyz') }]);
    for (let cut = 1; cut < one.length; cut++) expect(decodeFrames(one.subarray(0, cut))).toBeNull();
    // The exact bytes of frame.rs encode(KIND_DATA, "a", b"xyz").
    expect([...encodeFrames([{ kind: 1, id: 'a', payload: enc.encode('xyz') }])]).toEqual([1, 1, 0, 97, 3, 0, 0, 0, 120, 121, 122]);
  });

  it('decode a character split across reads and across messages, and ack the bytes', () => {
    const d = new PtyFrameDecoder();
    const zo = enc.encode('żó'); // c5 bc c3 b3
    const a = d.messages(encodeFrames([{ kind: FRAME_DATA, id: 't', payload: zo.subarray(0, 1) }]));
    const b = d.messages(encodeFrames([{ kind: FRAME_DATA, id: 't', payload: zo.subarray(1, 3) }, { kind: FRAME_DATA, id: 'u', payload: enc.encode('x') }]));
    const c = d.messages(encodeFrames([{ kind: FRAME_DATA, id: 't', payload: zo.subarray(3) }]));
    expect([...a, ...b, ...c]).toEqual([
      { t: 'data', id: 't', data: '', bytes: 1 },
      { t: 'data', id: 't', data: 'ż', bytes: 2 },
      { t: 'data', id: 'u', data: 'x', bytes: 1 },
      { t: 'data', id: 't', data: 'ó', bytes: 1 },
    ]);
  });

  it('give the exit after the output and flush an incomplete last character', () => {
    const d = new PtyFrameDecoder();
    const out = d.messages(encodeFrames([
      { kind: FRAME_DATA, id: 't', payload: new Uint8Array([0x61, 0xc5]) },
      { kind: FRAME_EXIT, id: 't', payload: exitPayload(-1) },
    ]));
    expect(out).toEqual([{ t: 'data', id: 't', data: 'a', bytes: 2 }, { t: 'data', id: 't', data: '�', bytes: 0 }, { t: 'exit', id: 't', code: -1 }]);
  });

  it('start a new terminal of the same id clean after a reset frame (a killed one cut inside a character)', () => {
    const d = new PtyFrameDecoder();
    const box = enc.encode('\u2500'); // e2 94 80
    const a = d.messages(encodeFrames([{ kind: FRAME_DATA, id: 'c1', payload: new Uint8Array([0x61, 0x62, box[0]]) }]));
    const b = d.messages(encodeFrames([
      { kind: FRAME_RESET, id: 'c1', payload: new Uint8Array() },
      { kind: FRAME_DATA, id: 'c1', payload: enc.encode('PS C:\\>') },
    ]));
    expect([...a, ...b]).toEqual([
      { t: 'data', id: 'c1', data: 'ab', bytes: 3 },
      { t: 'data', id: 'c1', data: 'PS C:\\>', bytes: 7 },
    ]);
    // forget(id) (TerminalManager.dispose) does the same.
    d.messages(encodeFrames([{ kind: FRAME_DATA, id: 'c2', payload: box.subarray(0, 2) }]));
    d.forget('c2');
    expect(d.messages(encodeFrames([{ kind: FRAME_DATA, id: 'c2', payload: enc.encode('x') }]))).toEqual([{ t: 'data', id: 'c2', data: 'x', bytes: 1 }]);
  });

  it('keep a leading BOM of the output and of a replay as U+FEFF (node-pty did)', () => {
    const d = new PtyFrameDecoder();
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    expect(d.messages(encodeFrames([{ kind: FRAME_DATA, id: 't', payload: bom }]))).toEqual([{ t: 'data', id: 't', data: '\ufeffA', bytes: 4 }]);
    const r = d.messages(encodeFrames([{ kind: FRAME_REPLAY, id: 'r', payload: replayPayload(bom, [{ at: 0, cols: 80, rows: 24 }]) }]));
    expect(r).toEqual([{ t: 'replay', id: 'r', data: '\ufeffA', sizes: [{ at: 0, cols: 80, rows: 24 }] }]);
  });

  it('turn replay byte offsets into the character offsets of shared/replay', () => {
    const d = new PtyFrameDecoder();
    const text = enc.encode('zażółć\r\nwide');
    // Sizes at byte 0 and at byte 12 ("\r\n" ends at byte 12: z a ż(2) ó(2) ł(2) ć(2) \r \n).
    const [m] = d.messages(encodeFrames([{ kind: FRAME_REPLAY, id: 't', payload: replayPayload(text, [{ at: 0, cols: 33, rows: 20 }, { at: 12, cols: 100, rows: 30 }]) }]));
    expect(m).toEqual({ t: 'replay', id: 't', data: 'zażółć\r\nwide', sizes: [{ at: 0, cols: 33, rows: 20 }, { at: 8, cols: 100, rows: 30 }] });
    if (m.t !== 'replay') throw new Error('replay');
    expect(replaySegments(m.data, m.sizes)).toEqual([{ data: 'zażółć\r\n', cols: 33, rows: 20 }, { data: 'wide', cols: 100, rows: 30 }]);
    // A tail that ends inside a character: the rest comes with the live output.
    const [r] = d.messages(encodeFrames([{ kind: FRAME_REPLAY, id: 'v', payload: replayPayload(new Uint8Array([0x61, 0xc5]), []) }]));
    expect(r).toEqual({ t: 'replay', id: 'v', data: 'a', sizes: [] });
    expect(d.messages(encodeFrames([{ kind: FRAME_DATA, id: 'v', payload: new Uint8Array([0xbc]) }]))).toEqual([{ t: 'data', id: 'v', data: 'ż', bytes: 1 }]);
  });

  it('a size inside a character counts from where the character is complete', () => {
    const d = new PtyFrameDecoder();
    const [m] = d.messages(encodeFrames([{ kind: FRAME_REPLAY, id: 't', payload: replayPayload(enc.encode('aż'), [{ at: 2, cols: 50, rows: 10 }]) }]));
    expect(m).toEqual({ t: 'replay', id: 't', data: 'aż', sizes: [{ at: 1, cols: 50, rows: 10 }] });
  });

  it('pass JSON messages through in order with the frames', () => {
    const d = new PtyFrameDecoder();
    const json = enc.encode(JSON.stringify({ t: 'sshListResult', id: 's', reqId: 4, result: { ok: true } }));
    expect(d.messages(encodeFrames([{ kind: FRAME_DATA, id: 's', payload: enc.encode('$ ') }, { kind: FRAME_JSON, id: '', payload: json }]))).toEqual([
      { t: 'data', id: 's', data: '$ ', bytes: 2 },
      { t: 'sshListResult', id: 's', reqId: 4, result: { ok: true } },
    ]);
  });

  it('read the replay frame layout of frame.rs replay_payload', () => {
    // frame.rs replay_payload_layout: header {"sizes":[{"at":1,"cols":80,"rows":24}]}, data "ab".
    const header = '{"sizes":[{"at":1,"cols":80,"rows":24}]}';
    const rust = new Uint8Array([header.length, 0, 0, 0, ...enc.encode(header), ...enc.encode('ab')]);
    const [m] = new PtyFrameDecoder().messages(encodeFrames([{ kind: FRAME_REPLAY, id: 'x', payload: rust }]));
    expect(m).toEqual({ t: 'replay', id: 'x', data: 'ab', sizes: [{ at: 1, cols: 80, rows: 24 }] });
  });
});

describe('the bridge pty port', () => {
  it('queues until TerminalManager listens, then hands every message over and releases it', () => {
    const posted: unknown[] = [];
    const port = createPtyPort({ post: (m) => posted.push(m) }, 'sharedBuffer');
    const seen: unknown[] = [];
    port.deliver(new Uint8Array([1]), 1, true);
    port.deliver(new Uint8Array([2]), 2, true);
    expect(posted).toEqual([]);
    port.onmessage = (e) => seen.push(e.data);
    port.start();
    port.deliver(new Uint8Array([3]), 3, true);
    expect(seen).toEqual([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
    expect(posted).toEqual([{ t: 'released', upto: 1 }, { t: 'released', upto: 2 }, { t: 'released', upto: 3 }]);
    // Message 1 arrived with nothing released: 1 in flight; the queued ones were counted when they were handled.
    expect(port.stats.maxInFlight).toBe(1);
    port.postMessage({ t: 'focus', id: null });
    expect(posted.at(-1)).toEqual({ t: 'focus', id: null });
    port.close();
    port.postMessage({ t: 'focus', id: 'x' });
    port.deliver(new Uint8Array([4]), 4);
    expect(seen).toHaveLength(3);
  });

  it('counts the messages the host posted but the page has not released (page side)', () => {
    const port = createPtyPort({ post: () => undefined }, 'sharedBuffer');
    port.onmessage = () => undefined;
    port.deliver(new Uint8Array([1]), 1, true);
    port.deliver(new Uint8Array([1]), 3); // the host already posted 3 while the page handled 1
    expect(port.stats.maxInFlight).toBe(2);
  });

  it('releases by the host number, so a message it never saw cannot put it ahead of the host', () => {
    const posted: unknown[] = [];
    const port = createPtyPort({ post: (m) => posted.push(m) }, 'sharedBuffer');
    port.onmessage = () => undefined;
    port.deliver(new Uint8Array([1]), 1, true);
    port.deliver(new Uint8Array([1]), 3, true); // message 2 was lost on the way
    port.deliver(new Uint8Array([1]), 4, true);
    expect(posted).toEqual([{ t: 'released', upto: 1 }, { t: 'released', upto: 3 }, { t: 'released', upto: 4 }]);
  });

  it('delays a release the host does not wait for, until the next message to the host or the tick', () => {
    vi.useFakeTimers();
    try {
      const posted: unknown[] = [];
      const port = createPtyPort({ post: (m) => posted.push(m) }, 'sharedBuffer');
      port.onmessage = () => undefined;
      port.deliver(new Uint8Array([1]), 1);
      port.deliver(new Uint8Array([1]), 2);
      expect(posted).toEqual([]);
      vi.advanceTimersByTime(RELEASE_TICK_MS);
      expect(posted).toEqual([{ t: 'released', upto: 2 }]);
      port.deliver(new Uint8Array([1]), 3);
      port.postMessage({ t: 'ack', id: 'x', chars: 1 });
      expect(posted.slice(1)).toEqual([{ t: 'released', upto: 3 }, { t: 'ack', id: 'x', chars: 1 }]);
      vi.advanceTimersByTime(RELEASE_TICK_MS * 2);
      expect(posted).toHaveLength(3);
      // A release the host waits for is not delayed.
      port.deliver(new Uint8Array([1]), 4, true);
      expect(posted.at(-1)).toEqual({ t: 'released', upto: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing handler still releases', () => {
    const posted: unknown[] = [];
    const port = createPtyPort({ post: (m) => posted.push(m) }, 'channel');
    port.onmessage = () => { throw new Error('boom'); };
    expect(() => port.deliver(new Uint8Array([1]))).toThrow('boom');
    expect(posted).toEqual([{ t: 'released', upto: 1 }]);
  });

  it('copies a shared buffer, gives it back at once and ignores other ports', () => {
    const released: ArrayBuffer[] = [];
    let listener: ((e: SharedBufferEvent) => void) | null = null;
    const port = createPtyPort({ post: () => undefined }, 'sharedBuffer');
    const seen: Uint8Array[] = [];
    port.onmessage = (e) => seen.push(e.data as Uint8Array);
    listenSharedBuffers({ addEventListener: (_t, cb) => { listener = cb; }, releaseBuffer: (b) => released.push(b) }, port);
    const buf = new Uint8Array([7, 8, 9]).buffer;
    listener!({ additionalData: { mcPort: 'pty', n: 1 }, getBuffer: () => buf });
    listener!({ additionalData: { mcPort: 'other' }, getBuffer: () => { throw new Error('not ours'); } });
    expect(released).toEqual([buf]);
    expect(seen).toEqual([new Uint8Array([7, 8, 9])]);
    expect(seen[0].buffer).not.toBe(buf);
  });

  it('drops (and gives back) the shared buffers of another attach: the old page still posting during a reload', () => {
    const released: ArrayBuffer[] = [];
    let listener: ((e: SharedBufferEvent) => void) | null = null;
    const posted: unknown[] = [];
    const port = createPtyPort({ post: (m) => posted.push(m) }, 'sharedBuffer');
    const seen: Uint8Array[] = [];
    port.onmessage = (e) => seen.push(e.data as Uint8Array);
    listenSharedBuffers({ addEventListener: (_t, cb) => { listener = cb; }, releaseBuffer: (b) => released.push(b) }, port, 'new');
    const old = new Uint8Array([1]).buffer;
    const fresh = new Uint8Array([2]).buffer;
    listener!({ additionalData: { mcPort: 'pty', a: 'old', n: 229 }, getBuffer: () => old });
    listener!({ additionalData: { mcPort: 'pty', a: 'new', n: 1, r: 1 }, getBuffer: () => fresh });
    expect(released).toEqual([old, fresh]);
    expect(seen).toEqual([new Uint8Array([2])]);
    expect(posted).toEqual([{ t: 'released', upto: 1 }]);
    expect(port.stats.stale).toBe(1);
    expect(port.stats.received).toBe(1);
  });

  it('pulls one message at a time and stops when the port is replaced', async () => {
    const answers: Array<Uint8Array | Error> = [new Uint8Array([1]), new Uint8Array(), new Uint8Array([2]), new Error('replaced')];
    let inFlight = 0;
    let maxInFlight = 0;
    const port = createPtyPort({ post: () => undefined }, 'pull');
    const seen: unknown[] = [];
    port.onmessage = (e) => seen.push(e.data);
    await runPull(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    }, port, () => false);
    expect(seen).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
    expect(maxInFlight).toBe(1);
  });
});

describe('TerminalManager on the Tauri host', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'terminals', 'TerminalManager.ts'), 'utf8');
  it('decodes binary frames and acks bytes when the host counts bytes', () => {
    expect(src).toContain('e.data instanceof Uint8Array ? this.frames.messages(e.data)');
    expect(src).toContain('(m.bytes ?? m.data.length)');
    expect(src).toContain("window.addEventListener('mc:pty-port'");
    expect(src).toContain('this.frames.forget(cellId)');
  });
});
