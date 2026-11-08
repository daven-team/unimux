// D12: the DB port's shared buffers (unimux-app pty_transport.rs DbBufferSink): `[u32 LE len][UTF-8 JSON]...` per post,
// parsed in order into the page's MessagePort; buffers of another attach are released and dropped.
import { describe, expect, it } from 'vitest';
import { decodeDbFrames, listenDbBuffers } from '../src/renderer/src/bridge/dbPort';
import type { SharedBufferEvent } from '../src/renderer/src/bridge/ptyPort';

function frames(...texts: string[]): Uint8Array {
  const parts = texts.map((t) => new TextEncoder().encode(t));
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of parts) { view.setUint32(at, p.length, true); out.set(p, at + 4); at += 4 + p.length; }
  return out;
}

describe('DB port frames', () => {
  it('decodes every message in order, lone surrogates included', () => {
    const rows = '{"t":"rows","queryId":"q","index":0,"rows":[["\\ud800","żółw"]]}';
    const got = decodeDbFrames(frames('{"t":"statement","queryId":"q"}', rows, '{"t":"queryEnd"}'));
    expect(got).toEqual([{ t: 'statement', queryId: 'q' }, JSON.parse(rows), { t: 'queryEnd' }]);
    expect((got[1] as { rows: string[][] }).rows[0]![0]).toBe('\ud800');
  });

  it('skips a frame that is not JSON and stops at a cut frame', () => {
    const whole = frames('{"a":1}', 'nope', '{"b":2}');
    expect(decodeDbFrames(whole)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(decodeDbFrames(whole.subarray(0, whole.length - 2))).toEqual([{ a: 1 }]);
    expect(decodeDbFrames(new Uint8Array(0))).toEqual([]);
  });

  it('takes only buffers of its own attach and always releases them', () => {
    let listener: ((e: SharedBufferEvent) => void) | null = null;
    const released: ArrayBuffer[] = [];
    const host = { addEventListener: (_: 'sharedbufferreceived', cb: (e: SharedBufferEvent) => void) => { listener = cb; }, releaseBuffer: (b: ArrayBuffer) => { released.push(b); } };
    const got: unknown[] = [];
    listenDbBuffers(host, 'att-1', (m) => got.push(m));
    const post = (mcPort: string, a: string, bytes: Uint8Array) => {
      const buffer = bytes.slice().buffer;
      listener!({ additionalData: { mcPort, a }, getBuffer: () => buffer });
      return buffer;
    };
    post('pty', 'att-1', frames('{"x":0}'));
    const stale = post('db', 'att-0', frames('{"x":1}'));
    const mine = post('db', 'att-1', frames('{"x":2}', '{"x":3}'));
    expect(got).toEqual([{ x: 2 }, { x: 3 }]);
    expect(released).toEqual([stale, mine]);
  });
});
