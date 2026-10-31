import { describe, expect, it } from 'vitest';
import {
  agentTargets, cleanAgentPromptAnswer, cleanAgentPromptRequest, initialSelection, planCounts, quickSelect, summarizeOutcomes,
  targetAction, targetState, AGENT_PROMPT_MAX_CELLS, QUEUEABLE, TARGET_STATES, type TargetSignal, type TargetState,
} from '../src/shared/agentPrompt';
import { QUEUE_MAX_TEXT } from '../src/shared/promptQueue';
import { SHORTCUT_DEFS, defaultCombo, sameCombo } from '../src/shared/shortcuts';
import type { AppState, Cell } from '../src/shared/types';

const idle: TargetSignal = { started: true, status: 'idle', typed: false, queued: false, sent: false, noPaste: false };
const done: TargetSignal = { ...idle, status: 'waiting', reason: 'done' };

describe('agent prompt: the state of a cell', () => {
  it('an agent idle at its prompt (no turn yet, or the turn ended) is ready', () => {
    expect(targetState(idle)).toBe('ready');
    expect(targetState(done)).toBe('ready');
    expect(targetState({ ...done, detail: { kind: 'interrupted' } })).toBe('ready');
  });

  it('a working, asking or permission-waiting agent is busy', () => {
    expect(targetState({ ...idle, status: 'working' })).toBe('working');
    expect(targetState({ ...done, sent: true })).toBe('working');
    expect(targetState({ ...done, detail: { kind: 'permission', tool: 'Bash' } })).toBe('permission');
    expect(targetState({ ...done, detail: { kind: 'question' } })).toBe('question');
    expect(targetState({ ...done, detail: { kind: 'elicitation' } })).toBe('question');
    expect(targetState({ ...done, reason: 'attention' })).toBe('question');
  });

  it('a limit, an ended agent or a terminal that has not started never gets the prompt', () => {
    expect(targetState({ ...done, reason: 'error', failure: 'usage-limit' })).toBe('limit');
    expect(targetState({ ...idle, status: 'exited' })).toBe('exited');
    expect(targetState({ ...idle, detail: { kind: 'cli-exited', code: 1 } })).toBe('exited');
    expect(targetState({ ...done, detail: { kind: 'exit-code', code: 2 } })).toBe('exited');
    expect(targetState({ ...done, started: false })).toBe('notStarted');
  });

  it('typed text, a pending queue and a multi-line prompt without bracketed paste hold the prompt back', () => {
    expect(targetState({ ...done, typed: true })).toBe('typing');
    expect(targetState({ ...done, queued: true })).toBe('queued');
    expect(targetState({ ...done, noPaste: true })).toBe('paste');
    // The more urgent reason wins.
    expect(targetState({ ...done, detail: { kind: 'permission' }, queued: true })).toBe('permission');
  });
});

describe('agent prompt: what a send does', () => {
  it('sends to ready cells only; busy ones are skipped unless the rest goes to the queue', () => {
    expect(targetAction('ready', false)).toBe('send');
    expect(targetAction('ready', true)).toBe('send');
    for (const state of TARGET_STATES.filter((s) => s !== 'ready')) {
      expect(targetAction(state, false)).toBe('skip');
      expect(targetAction(state, true)).toBe(QUEUEABLE.has(state) ? 'queue' : 'skip');
    }
    for (const state of ['notStarted', 'exited', 'limit', 'paste', 'unreachable'] as TargetState[]) expect(targetAction(state, true)).toBe('skip');
    for (const state of ['working', 'permission', 'question', 'queued', 'typing'] as TargetState[]) expect(targetAction(state, true)).toBe('queue');
  });

  it('plans and sums up', () => {
    const states: Record<string, TargetState> = { a: 'ready', b: 'working', c: 'exited', d: 'permission' };
    expect(planCounts(['a', 'b', 'c', 'd'], states, false)).toEqual({ send: 1, queue: 0, skip: 3 });
    expect(planCounts(['a', 'b', 'c', 'd'], states, true)).toEqual({ send: 1, queue: 2, skip: 1 });
    expect(planCounts(['zz'], states, true)).toEqual({ send: 0, queue: 0, skip: 1 });
    expect(summarizeOutcomes({
      a: { state: 'ready', result: 'sent' }, b: { state: 'ready', result: 'sent' }, c: { state: 'working', result: 'queued' }, d: { state: 'exited', result: 'skipped' },
    })).toEqual({ sent: 2, queued: 1, skipped: 1 });
  });
});

const cell = (id: string, profileId: string, extra: Partial<Cell> = {}): Cell => ({ id, profileId, ...extra });
const state = {
  profiles: [
    { id: 'claude', name: 'Claude', cli: 'claude' }, { id: 'codex', name: 'Codex', cli: 'codex' }, { id: 'shell', name: 'Shell', cli: 'shell' },
  ],
  projects: [
    { id: 'p1', tabs: [
      { id: 't1', cells: [cell('c1', 'claude'), cell('c2', 'codex'), cell('s1', 'shell'), cell('ssh1', 'shell', { ssh: { hostId: 'h' } as Cell['ssh'] })] },
      { id: 't2', cells: [cell('c3', 'claude')] },
    ] },
    { id: 'p2', tabs: [{ id: 't3', cells: [cell('c4', 'codex'), cell('x', 'gone')] }] },
  ],
} as unknown as AppState;

describe('agent prompt: targets and selections', () => {
  it('lists Claude and Codex cells of every grid; shell and SSH cells are no targets', () => {
    expect(agentTargets(state)).toEqual([
      { cellId: 'c1', projectId: 'p1', tabId: 't1', cli: 'claude' },
      { cellId: 'c2', projectId: 'p1', tabId: 't1', cli: 'codex' },
      { cellId: 'c3', projectId: 'p1', tabId: 't2', cli: 'claude' },
      { cellId: 'c4', projectId: 'p2', tabId: 't3', cli: 'codex' },
    ]);
  });

  it('checks the given grid first, else every agent', () => {
    const targets = agentTargets(state);
    expect([...initialSelection(targets, 't1')]).toEqual(['c1', 'c2']);
    expect([...initialSelection(targets)]).toEqual(['c1', 'c2', 'c3', 'c4']);
    // A grid without agents (or unknown) falls back to all of them.
    expect([...initialSelection(targets, 'nope')]).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('quick selections: this grid, all grids, only idle ones (of the checked), none', () => {
    const targets = agentTargets(state);
    const states: Record<string, TargetState> = { c1: 'ready', c2: 'working', c3: 'ready', c4: 'permission' };
    expect([...quickSelect('grid', targets, new Set(), states, 't2')]).toEqual(['c3']);
    expect([...quickSelect('all', targets, new Set(), states)]).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect([...quickSelect('idle', targets, new Set(['c1', 'c2', 'c4']), states)]).toEqual(['c1']);
    expect([...quickSelect('none', targets, new Set(['c1']), states)]).toEqual([]);
  });
});

describe('agent prompt: requests over IPC', () => {
  it('repairs a request: known mode, ids once, texts cut, blank sends dropped', () => {
    expect(cleanAgentPromptRequest(null)).toBeNull();
    expect(cleanAgentPromptRequest({ mode: 'bogus', items: [] })).toBeNull();
    const req = cleanAgentPromptRequest({
      mode: 'send', queueBusy: true,
      items: [{ cellId: 'a', text: 'hi' }, { cellId: 'a', text: 'again' }, { cellId: 'b', text: '  ' }, { cellId: 7, text: 'x' }, { cellId: 'c', text: 'y'.repeat(QUEUE_MAX_TEXT + 10) }],
    })!;
    expect(req.mode).toBe('send');
    expect(req.queueBusy).toBe(true);
    expect(req.items.map((i) => i.cellId)).toEqual(['a', 'c']);
    expect(req.items[1].text.length).toBe(QUEUE_MAX_TEXT);
    // A probe may carry an empty text (the box is still empty).
    expect(cleanAgentPromptRequest({ mode: 'probe', items: [{ cellId: 'a', text: '' }] })!.items).toHaveLength(1);
    const many = cleanAgentPromptRequest({ mode: 'probe', items: Array.from({ length: AGENT_PROMPT_MAX_CELLS + 5 }, (_, i) => ({ cellId: `c${i}`, text: '' })) })!;
    expect(many.items).toHaveLength(AGENT_PROMPT_MAX_CELLS);
    expect(many.queueBusy).toBe(false);
  });

  it('keeps only answers for the asked cells with known states', () => {
    expect(cleanAgentPromptAnswer({
      a: { state: 'ready', result: 'sent' }, b: { state: 'weird' }, c: { state: 'working', result: 'nope' }, z: { state: 'ready', result: 'sent' },
    }, ['a', 'b', 'c'])).toEqual({ a: { state: 'ready', result: 'sent' }, c: { state: 'working' } });
    expect(cleanAgentPromptAnswer('x', ['a'])).toEqual({});
  });
});

describe('agent prompt: shortcut', () => {
  it('has a default that no other app shortcut uses', () => {
    const def = SHORTCUT_DEFS.find((d) => d.id === 'agents.prompt')!;
    expect(def.rebindable).toBe(true);
    for (const platform of ['win32', 'darwin'] as const) {
      const mine = defaultCombo(def, platform)!;
      for (const other of SHORTCUT_DEFS) {
        if (other.id === def.id) continue;
        const combo = defaultCombo(other, platform);
        if (combo) expect(sameCombo(combo, mine), `${other.id} on ${platform}`).toBe(false);
      }
    }
  });
});
