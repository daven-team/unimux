import { describe, expect, it } from 'vitest';
import { alignedDelay, BULK_COALESCE_MS, coalesceDelay, ECHO_COALESCE_MS, FlowGate, HIGH_WATER, LOW_WATER, MAX_TAIL_CHUNKS, TailBuffer } from '../src/ptyhost/flow';
import { OutputBatcher } from '../src/ptyhost/batch';
import { unpackHostMessage, type HostToRendererPort } from '../src/shared/ipc';

describe('TailBuffer', () => {
  it('matches the naive (tail + data).slice(-limit) for random chunks', () => {
    for (const limit of [1, 7, 100, 1000]) {
      const buf = new TailBuffer(limit);
      let naive = '';
      let seed = limit;
      for (let i = 0; i < 300; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const chunk = String.fromCharCode(97 + (i % 26)).repeat(seed % 40);
        buf.push(chunk);
        naive = (naive + chunk).slice(-limit);
        if (i % 17 === 0) expect(buf.toString()).toBe(naive);
      }
      expect(buf.toString()).toBe(naive);
    }
  });

  it('keeps a chunk larger than the limit cut to the newest characters', () => {
    const buf = new TailBuffer(4);
    buf.push('abcdefgh');
    expect(buf.toString()).toBe('efgh');
    buf.push('ij');
    expect(buf.toString()).toBe('ghij');
  });

  it('does not grow without bound', () => {
    const buf = new TailBuffer(1000);
    for (let i = 0; i < 10_000; i++) buf.push('x'.repeat(100));
    expect((buf as unknown as { chunks: string[] }).chunks.length).toBeLessThan(25);
  });

  it('ignores empty pushes', () => {
    const buf = new TailBuffer(5);
    buf.push('');
    expect(buf.toString()).toBe('');
  });
});

describe('FlowGate', () => {
  it('pauses at the high watermark and resumes at the low one', () => {
    const g = new FlowGate();
    expect(g.sent(HIGH_WATER - 1)).toBe(false);
    expect(g.sent(1)).toBe(true);
    expect(g.paused).toBe(true);
    expect(g.sent(500)).toBe(false); // already paused
    expect(g.acked(HIGH_WATER - LOW_WATER - 1)).toBe(false);
    expect(g.acked(600)).toBe(true);
    expect(g.paused).toBe(false);
  });

  it('never lets pending go negative and ignores acks while running', () => {
    const g = new FlowGate();
    expect(g.acked(10_000)).toBe(false);
    expect(g.inFlight).toBe(0);
    expect(g.sent(10)).toBe(false);
    expect(g.inFlight).toBe(10);
  });

  it('release lifts a pause but keeps the in-flight count', () => {
    const g = new FlowGate();
    g.sent(HIGH_WATER);
    g.release();
    expect(g.paused).toBe(false);
    expect(g.inFlight).toBe(HIGH_WATER);
    expect(g.sent(1)).toBe(true);
  });

  it('reset reports a pause that has to be lifted', () => {
    const g = new FlowGate();
    g.sent(HIGH_WATER);
    expect(g.reset()).toBe(true);
    expect(g.paused).toBe(false);
    expect(g.reset()).toBe(false);
    expect(g.sent(HIGH_WATER - 1)).toBe(false);
  });
});

describe('coalesceDelay', () => {
  it('is short right after the user typed and longer for bulk output', () => {
    expect(coalesceDelay(1000, 900, true)).toBe(ECHO_COALESCE_MS);
    expect(coalesceDelay(1000, 900, false)).toBe(ECHO_COALESCE_MS);
    expect(coalesceDelay(1000, 100, true)).toBe(BULK_COALESCE_MS);
    expect(coalesceDelay(1000, -Infinity, true)).toBe(BULK_COALESCE_MS);
  });
});

describe('alignedDelay', () => {
  it('puts bulk flushes on a shared grid and leaves the echo delay alone', () => {
    expect(alignedDelay(1000, ECHO_COALESCE_MS)).toBe(ECHO_COALESCE_MS);
    for (let now = 0; now < 50; now++) {
      const delay = alignedDelay(now, BULK_COALESCE_MS);
      expect((now + delay) % BULK_COALESCE_MS).toBe(0);
      expect(delay).toBeGreaterThanOrEqual(BULK_COALESCE_MS / 2);
      expect(delay).toBeLessThanOrEqual(BULK_COALESCE_MS * 1.5);
    }
  });
});

describe('TailBuffer with many tiny chunks', () => {
  it('joins them into one piece and keeps the same text', () => {
    const buf = new TailBuffer(100_000);
    let naive = '';
    for (let i = 0; i < 5000; i++) { buf.push('x' + (i % 10)); naive += 'x' + (i % 10); }
    expect(buf.pieces).toBeLessThanOrEqual(MAX_TAIL_CHUNKS);
    expect(buf.toString()).toBe(naive.slice(-100_000));
    const small = new TailBuffer(50);
    let tail = '';
    for (let i = 0; i < 2000; i++) { small.push(String(i)); tail = (tail + String(i)).slice(-50); }
    expect(small.toString()).toBe(tail);
  });
});

describe('OutputBatcher', () => {
  it('posts one message per turn, single output unchanged, several as a batch in order', () => {
    const posted: HostToRendererPort[] = [];
    const queue: Array<() => void> = [];
    const batcher = new OutputBatcher((m) => posted.push(m), (fn) => queue.push(fn));
    batcher.data('a', 'one');
    queue.shift()!();
    expect(posted).toEqual([{ t: 'data', id: 'a', data: 'one' }]);
    batcher.data('a', 'two');
    batcher.data('b', 'three');
    batcher.data('a', 'four');
    expect(queue).toHaveLength(1);
    queue.shift()!();
    expect(posted[1]).toEqual({ t: 'dataBatch', items: [['a', 'two'], ['b', 'three'], ['a', 'four']] });
    expect(unpackHostMessage(posted[1])).toEqual([
      { t: 'data', id: 'a', data: 'two' }, { t: 'data', id: 'b', data: 'three' }, { t: 'data', id: 'a', data: 'four' },
    ]);
    // An explicit flush (before an exit) empties the queue; the scheduled one then has nothing left.
    batcher.data('c', 'last');
    batcher.flush();
    queue.shift()!();
    expect(posted).toHaveLength(3);
    batcher.data('d', 'gone');
    batcher.drop();
    queue.shift()!();
    expect(posted).toHaveLength(3);
  });
});
