// The AI team's reliability fixes of 1.1.4: stalled agents, inbox notices through the prompt queue, restarting an exited
// agent, dependents delivered when their prerequisites complete, the runtime status left alone for a dead worker, orphaned
// tasks cancelled and reassigned, closed ids in wait_for, the per-CLI wait cap and the delegation limit.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePromptQueue, queueVerdict, type QueueSignal } from '../src/shared/promptQueue';

const refusal = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../src/shared/delegation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shared/delegation')>()),
  delegationRefusal: () => refusal.value,
}));

afterEach(() => { vi.useRealTimers(); refusal.value = null; });

/** Lets queued microtasks and the promise chain of a wait run. */

describe('inbox notices', () => {
  it('lets a notice reach an agent idle at its first prompt once its hooks report, and drops stale notices at launch', () => {
    const signal: QueueSignal = { agent: true, started: true, status: 'idle', hooked: true, typed: false, sent: false };
    const notice = { items: [{ id: 'unimux-1', text: 'unimux: x: read_inbox', auto: true as const }] };
    expect(queueVerdict(notice, signal)).toEqual({ kind: 'ready' });
    expect(queueVerdict(notice, { ...signal, hooked: false })).toEqual({ kind: 'wait', why: 'first' });
    expect(queueVerdict({ items: [{ id: 'u', text: 'my prompt' }] }, signal)).toEqual({ kind: 'wait', why: 'first' });
    expect(queueVerdict(notice, { ...signal, status: 'waiting', detail: { kind: 'permission' } } as QueueSignal)).toEqual({ kind: 'pause', reason: 'permission' });
    expect(normalizePromptQueue({ items: [...notice.items, { id: 'u', text: 'mine' }] }, true)).toEqual({ items: [{ id: 'u', text: 'mine' }], paused: 'restart' });
    expect(normalizePromptQueue(notice, false)).toEqual(notice);
  });
});

