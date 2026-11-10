// The alert sounds' AudioContext (renderer/src/alertSound.ts) is closed some seconds after the last sound and made again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/src/store', () => ({ getS: () => ({ settings: { alerts: { volume: 0.5 } } }) }));

class FakeParam { value = 0; setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  type = '';
  buffer: unknown = null;
  connect(next: unknown) { return next; }
  start() {}
  stop() {}
}
const made: FakeContext[] = [];
class FakeContext {
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 0;
  destination = {};
  constructor() { made.push(this); }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createGain() { return new FakeNode(); }
  createOscillator() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
}

// The renderer is not part of the node tsconfig: loaded through a variable, so tsc does not follow the imports.
const alertSoundPath = '../src/renderer/src/alertSound';
type AlertSound = { playAlertSound: (event: never, choice: never) => Promise<boolean> };
const load = async () => (await import(/* @vite-ignore */ alertSoundPath)) as AlertSound;

describe('alert sound context', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    made.length = 0;
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('window', { mc: { systemBeep: vi.fn() } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('closes the context 10 s after the last sound ended and makes a new one for the next', async () => {
    const { playAlertSound } = await load();
    expect(await playAlertSound('done' as never, { kind: 'preset', id: 'chime' } as never)).toBe(true);
    expect(made).toHaveLength(1);
    // A second sound a moment later shares the context and moves the close.
    await vi.advanceTimersByTimeAsync(5_000);
    await playAlertSound('done' as never, { kind: 'preset', id: 'chime' } as never);
    expect(made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(made[0].state).toBe('running');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(made[0].state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
    await playAlertSound('done' as never, { kind: 'preset', id: 'chime' } as never);
    expect(made).toHaveLength(2);
    expect(made[1].state).toBe('running');
  });

  it('keeps a context open while it waits to be resumed', async () => {
    let release: () => void = () => {};
    class Held extends FakeContext {
      state: 'suspended' | 'running' | 'closed' = 'suspended';
      resume() { return new Promise<void>((done) => { release = () => { this.state = 'running'; done(); }; }); }
    }
    vi.stubGlobal('AudioContext', Held);
    const { playAlertSound } = await load();
    const played = playAlertSound('done' as never, { kind: 'preset', id: 'chime' } as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(made[0].state).toBe('suspended');
    release();
    expect(await played).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(made[0].state).toBe('closed');
  });
});
