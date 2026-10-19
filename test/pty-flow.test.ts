import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

interface FakeProc {
  pid: number;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emit(data: string): void;
  exit(code?: number): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

const procs: FakeProc[] = [];

vi.mock('node-pty', () => ({
  spawn: () => {
    let dataCb: (d: string) => void = () => undefined;
    let exitCb: (e: { exitCode: number }) => void = () => undefined;
    const p: FakeProc = {
      pid: procs.length + 1,
      pause: vi.fn(), resume: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(() => exitCb({ exitCode: 0 })),
      emit: (d) => dataCb(d),
      exit: (code = 0) => exitCb({ exitCode: code }),
      onData: (cb) => { dataCb = cb; },
      onExit: (cb) => { exitCb = cb; },
    };
    procs.push(p);
    return p;
  },
}));

import { PtyManager } from '../src/ptyhost/manager';
import { BACKGROUND_COALESCE_MS, HIGH_WATER, LOW_WATER } from '../src/ptyhost/flow';

const req = { id: 'a', cwd: '.', cols: 80, rows: 24, env: {}, shell: 'cmd' as const };

function setup(delivered = true) {
  const data: Array<{ id: string; data: string }> = [];
  const exits: string[] = [];
  const m = new PtyManager({
    data: (id, d) => { data.push({ id, data: d }); return delivered; },
    exit: (id) => { exits.push(id); },
  });
  m.setFlowControl(true);
  m.spawn(req);
  return { m, data, exits, p: procs[procs.length - 1] };
}

/** Sends `n` characters and lets the coalescing timer fire (an unfocused cell nobody types in: the background window). */
const FLUSHED = BACKGROUND_COALESCE_MS * 1.5;
function output(p: FakeProc, n: number) {
  p.emit('x'.repeat(n));
  vi.advanceTimersByTime(FLUSHED);
}

beforeEach(() => {
  procs.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('PtyManager flow control', () => {
  it('pauses at the high watermark and resumes after acks', () => {
    const { m, p } = setup();
    output(p, HIGH_WATER);
    expect(p.pause).toHaveBeenCalledTimes(1);
    m.ack('a', HIGH_WATER - LOW_WATER);
    expect(p.resume).toHaveBeenCalledTimes(1);
    output(p, HIGH_WATER);
    expect(p.pause).toHaveBeenCalledTimes(2);
  });

  it('sends a buffer of 128 KB at once without waiting for the timer', () => {
    const { p, data } = setup();
    p.emit('x'.repeat(128 * 1024));
    expect(data).toHaveLength(1);
  });

  it('coalesces small chunks into one message', () => {
    const { p, data } = setup();
    p.emit('a');
    p.emit('b');
    expect(data).toHaveLength(0);
    vi.advanceTimersByTime(FLUSHED);
    expect(data).toEqual([{ id: 'a', data: 'ab' }]);
  });

  it('the watchdog resumes a stuck pause but keeps the in-flight count', () => {
    const { m, p } = setup();
    output(p, HIGH_WATER);
    vi.advanceTimersByTime(3100);
    expect(p.resume).toHaveBeenCalledTimes(1);
    // Still behind: the next chunk pauses again instead of piling up unbounded.
    output(p, 10);
    expect(p.pause).toHaveBeenCalledTimes(2);
    m.ack('a', HIGH_WATER + 10);
    expect(p.resume).toHaveBeenCalledTimes(2);
  });

  it('every ack renews the watchdog while paused', () => {
    const { m, p } = setup();
    output(p, HIGH_WATER);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2000);
      m.ack('a', 1000); // progress, but not enough to reach the low watermark
    }
    expect(p.resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3100);
    expect(p.resume).toHaveBeenCalledTimes(1);
  });

  it('ignores acks for unknown terminals and never goes negative', () => {
    const { m, p } = setup();
    m.ack('nope', 5);
    m.ack('a', 1_000_000);
    output(p, HIGH_WATER - 1);
    expect(p.pause).not.toHaveBeenCalled(); // a negative count would have hidden this
  });

  it('does not count or pause when nobody received the data', () => {
    const { p } = setup(false);
    output(p, HIGH_WATER * 2);
    expect(p.pause).not.toHaveBeenCalled();
  });

  it('turning flow control off or reconnecting lifts a pause', () => {
    const { m, p } = setup();
    output(p, HIGH_WATER);
    m.setFlowControl(false);
    expect(p.resume).toHaveBeenCalledTimes(1);
    output(p, HIGH_WATER * 2);
    expect(p.pause).toHaveBeenCalledTimes(1);
    m.setFlowControl(true);
    output(p, HIGH_WATER);
    expect(p.pause).toHaveBeenCalledTimes(2);
    m.setFlowControl(true); // reconnect resets the gate
    expect(p.resume).toHaveBeenCalledTimes(2);
  });

  it('a pty that exits while paused is resumed and its last output is still delivered', () => {
    const { p, data, exits } = setup();
    output(p, HIGH_WATER);
    p.exit(3);
    expect(p.resume).toHaveBeenCalledTimes(1);
    expect(exits).toHaveLength(0); // draining
    p.emit('tail-output');
    vi.advanceTimersByTime(200);
    expect(data.map((d) => d.data).join('')).toContain('tail-output');
    expect(exits).toEqual(['a']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an exit without a pause is reported at once', () => {
    const { p, exits } = setup();
    p.exit();
    expect(exits).toEqual(['a']);
  });

  it('killing a paused terminal clears the watchdog', async () => {
    const { m, p } = setup();
    output(p, HIGH_WATER);
    const done = m.kill('a');
    await vi.advanceTimersByTimeAsync(10);
    await done;
    vi.advanceTimersByTime(5000);
    expect(p.resume).not.toHaveBeenCalled();
  });
});

describe('xterm internals used by TerminalManager.deferParkedSelection', () => {
  it('still has the private names we patch', () => {
    const dir = createRequire(import.meta.url).resolve('@xterm/xterm/package.json').replace(/package\.json$/, '');
    const src = readFileSync(dir + 'lib/xterm.mjs', 'utf8');
    // RenderService owns handleSelectionChanged and is reachable as terminal._core._renderService.
    expect(src).toContain('_renderService');
    expect(src).toMatch(/handleSelectionChanged\([a-z],[a-z],[a-z]\)\{this\._selectionState/);
    expect(src).toMatch(/this\._core\b/);
  });
});
