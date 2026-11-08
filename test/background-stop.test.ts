import { describe, expect, it } from 'vitest';
import { hookDetail } from '../src/shared/statusLog';
import { BG_STALL_MS, INTERRUPT_QUIET_MS, shouldNotify, StatusTracker, STALL_MS } from '../src/shared/status';

/** Ticks every 5 s (like the app) so the sleep detection does not restart the silence window. */
const run = (t: StatusTracker, from: number, to: number) => { for (let n = from + 5000; n <= to; n += 5000) t.tick(n); return t.tick(to); };

describe('StatusTracker background work', () => {
  it('stays working past STALL_MS and flips only after BG_STALL_MS', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('stopbg', 1000);
    expect(t.status).toBe('working');
    expect(run(t, 1000, 1000 + STALL_MS + 5000)).toBe('working');
    expect(run(t, 1000, 1000 + BG_STALL_MS - 5)).toBe('working');
    expect(t.tick(1000 + BG_STALL_MS)).toBe('waiting');
  });

  it('leaves background mode once the long net expired, so a later lost Stop uses the short net', () => {
    const t = new StatusTracker();
    t.hook('stopbg', 0);
    expect(t.tick(BG_STALL_MS)).toBe('waiting');
    t.hook('busy', BG_STALL_MS + 10);
    t.hook('prompt', BG_STALL_MS + 20);
    expect(run(t, BG_STALL_MS + 20, BG_STALL_MS + 20 + STALL_MS + 1000)).toBe('waiting');
  });

  it('ignores Esc while background work runs', () => {
    const t = new StatusTracker();
    t.hook('stopbg', 0);
    t.interrupt(1000);
    expect(t.tick(1000 + INTERRUPT_QUIET_MS + 10)).toBe('working');
    t.input(2000, false);
    expect(t.status).toBe('working');
  });

  it('busy keeps the flag; prompt, stop and notify clear it', () => {
    for (const ev of ['prompt', 'stop', 'notify'] as const) {
      const t = new StatusTracker();
      t.hook('stopbg', 0);
      t.hook('busy', 100);
      expect(t.tick(100 + STALL_MS + 1)).toBe('working');
      t.hook(ev, 200);
      t.hook('prompt', 300);
      expect(t.tick(300 + STALL_MS)).toBe('waiting');
    }
    const t = new StatusTracker();
    t.hook('stopbg', 0);
    t.hook('stop', 10);
    expect(t.status).toBe('waiting');
    t.hook('prompt', 20);
    expect(t.tick(20 + STALL_MS)).toBe('waiting');
  });

  it('reset and exit clear the flag', () => {
    const t = new StatusTracker();
    t.hook('stopbg', 0);
    t.reset();
    t.hook('prompt', 10);
    expect(t.tick(10 + STALL_MS)).toBe('waiting');
  });

  it('does not notify for stopbg, then notifies on the real stop', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    let prev = t.status;
    t.hook('stopbg', 100);
    expect(shouldNotify(prev, t.status, t.lastCause)).toBe(false);
    prev = t.status;
    t.hook('prompt', 200);
    expect(shouldNotify(prev, t.status, t.lastCause)).toBe(false);
    prev = t.status;
    t.hook('stop', 300);
    expect(shouldNotify(prev, t.status, t.lastCause)).toBe(true);
  });
});

describe('workflow entries in the Stop payload', () => {
  it('hookDetail shows the workflow count and an unknown task list', () => {
    expect(hookDetail({ tasks: 1, active: 1, workflows: 1 })).toBe('tasks=1 active=1 workflows=1');
    expect(hookDetail({ tasks: 0, active: 0, workflows: 0, tasksUnknown: true })).toBe('tasks=?');
  });
});
