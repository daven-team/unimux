import { describe, expect, it } from 'vitest';
import {
  editQueued, enqueuePrompt, moveQueued, normalizePromptQueue, pauseQueue, promptPreview, QUEUE_MAX_ITEMS, QUEUE_MAX_TEXT, queueVerdict,
  removeQueued, resumeQueue, type PromptQueue, type QueueSignal,
} from '../src/shared/promptQueue';
import { defaultState, normalizeState } from '../src/shared/state';
import { layoutForCount } from '../src/shared/layout';

const queue = (...texts: string[]): PromptQueue => ({ items: texts.map((text, i) => ({ id: `p${i}`, text })) });
/** A Claude cell that just finished its turn (Stop hook) and sits at its prompt. */
const idle: QueueSignal = { agent: true, started: true, status: 'waiting', hooked: true, typed: false, sent: false };

describe('prompt queue: when to send', () => {
  it('sends only when the agent finished its turn and is idle at its prompt', () => {
    expect(queueVerdict(queue('a'), idle)).toEqual({ kind: 'ready' });
    expect(queueVerdict(undefined, idle)).toEqual({ kind: 'empty' });
    expect(queueVerdict({ items: [] }, idle)).toEqual({ kind: 'empty' });
  });

  it('waits while the agent works, before it started, before the first turn and after a send', () => {
    expect(queueVerdict(queue('a'), { ...idle, status: 'working' })).toEqual({ kind: 'wait', why: 'working' });
    expect(queueVerdict(queue('a'), { ...idle, started: false })).toEqual({ kind: 'wait', why: 'start' });
    expect(queueVerdict(queue('a'), { ...idle, agent: false })).toEqual({ kind: 'wait', why: 'start' });
    expect(queueVerdict(queue('a'), { ...idle, status: 'idle' })).toEqual({ kind: 'wait', why: 'first' });
    // The prompt was pasted, the turn's prompt hook has not arrived yet: never a second prompt on top.
    expect(queueVerdict(queue('a', 'b'), { ...idle, sent: true })).toEqual({ kind: 'wait', why: 'sent' });
  });

  it('does not trust a turn end guessed from the output alone', () => {
    expect(queueVerdict(queue('a'), { ...idle, hooked: false })).toEqual({ kind: 'wait', why: 'unsure' });
  });

  it('pauses with the reason when the agent needs the user or cannot take a prompt', () => {
    const pause = (signal: Partial<QueueSignal>) => queueVerdict(queue('a'), { ...idle, ...signal });
    expect(pause({ reason: 'attention', detail: { kind: 'permission', tool: 'Bash' } })).toEqual({ kind: 'pause', reason: 'permission' });
    expect(pause({ reason: 'attention', detail: { kind: 'question' } })).toEqual({ kind: 'pause', reason: 'question' });
    expect(pause({ reason: 'attention', detail: { kind: 'elicitation' } })).toEqual({ kind: 'pause', reason: 'question' });
    expect(pause({ reason: 'attention' })).toEqual({ kind: 'pause', reason: 'question' });
    expect(pause({ reason: 'error', failure: 'rate_limit' })).toEqual({ kind: 'pause', reason: 'error' });
    expect(pause({ failure: 'usage-limit' })).toEqual({ kind: 'pause', reason: 'limit' });
    expect(pause({ detail: { kind: 'interrupted' } })).toEqual({ kind: 'pause', reason: 'interrupted' });
    expect(pause({ status: 'exited' })).toEqual({ kind: 'pause', reason: 'exited' });
    expect(pause({ status: 'idle', detail: { kind: 'cli-exited', code: 0 } })).toEqual({ kind: 'pause', reason: 'exited' });
    expect(pause({ status: 'exited', sent: true })).toEqual({ kind: 'pause', reason: 'exited' });
    // The user typed into the prompt line after the turn ended (or opened a menu there): the prompt would land in their text.
    expect(pause({ typed: true })).toEqual({ kind: 'pause', reason: 'typing' });
  });

  it('a question outranks typing and an unsure end; working never pauses', () => {
    expect(queueVerdict(queue('a'), { ...idle, typed: true, hooked: false, detail: { kind: 'permission' } })).toEqual({ kind: 'pause', reason: 'permission' });
    expect(queueVerdict(queue('a'), { ...idle, status: 'working', typed: true, detail: { kind: 'tool', tool: 'Edit' } })).toEqual({ kind: 'wait', why: 'working' });
  });

  it('a paused queue stays paused whatever the cell does', () => {
    expect(queueVerdict({ ...queue('a'), paused: 'user' }, idle)).toEqual({ kind: 'paused', reason: 'user' });
    expect(queueVerdict({ ...queue('a'), paused: 'restart' }, idle)).toEqual({ kind: 'paused', reason: 'restart' });
  });
});

describe('prompt queue: edits', () => {
  it('adds, edits, removes and keeps the pause', () => {
    let q = enqueuePrompt(undefined, 'first', 'a');
    q = enqueuePrompt(q, 'second\nline two', 'b');
    expect(q?.items.map((i) => i.text)).toEqual(['first', 'second\nline two']);
    expect(enqueuePrompt(q, '   ', 'c')).toBe(q);
    q = pauseQueue(q, 'user');
    q = editQueued(q, 'a', 'changed');
    expect(q).toEqual({ items: [{ id: 'a', text: 'changed' }, { id: 'b', text: 'second\nline two' }], paused: 'user' });
    q = editQueued(q, 'a', '  ');
    expect(q?.items.map((i) => i.id)).toEqual(['b']);
    expect(removeQueued(q, 'b')).toBeUndefined();
    expect(resumeQueue(q)).toEqual({ items: [{ id: 'b', text: 'second\nline two' }] });
  });

  it('reorders like a drag in the list', () => {
    const q = queue('a', 'b', 'c');
    expect(moveQueued(q, 'p2', 0)?.items.map((i) => i.text)).toEqual(['c', 'a', 'b']);
    expect(moveQueued(q, 'p0', 2)?.items.map((i) => i.text)).toEqual(['b', 'c', 'a']);
    expect(moveQueued(q, 'p0', 99)?.items.map((i) => i.text)).toEqual(['b', 'c', 'a']);
    expect(moveQueued(q, 'p1', 1)).toBe(q);
    expect(moveQueued(q, 'missing', 0)).toBe(q);
  });

  it('caps the number and the length of prompts', () => {
    let q: PromptQueue | undefined;
    for (let i = 0; i < QUEUE_MAX_ITEMS + 5; i++) q = enqueuePrompt(q, `p${i}`, `id${i}`);
    expect(q?.items).toHaveLength(QUEUE_MAX_ITEMS);
    expect(enqueuePrompt(undefined, 'x'.repeat(QUEUE_MAX_TEXT + 10), 'a')?.items[0].text).toHaveLength(QUEUE_MAX_TEXT);
  });

  it('previews the first line', () => {
    expect(promptPreview('  fix the tests\nthen commit')).toBe('fix the tests');
    expect(promptPreview('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('prompt queue: persistence', () => {
  it('normalises a saved queue and pauses it at launch', () => {
    const raw = { items: [{ id: 'a', text: 'one' }, { id: 'a', text: 'dup' }, { id: 'b', text: '  ' }, { text: 'no id' }, 7, { id: 'c', text: 'two' }] };
    expect(normalizePromptQueue(raw)).toEqual({ items: [{ id: 'a', text: 'one' }, { id: 'c', text: 'two' }] });
    expect(normalizePromptQueue(raw, true)).toEqual({ items: [{ id: 'a', text: 'one' }, { id: 'c', text: 'two' }], paused: 'restart' });
    // A pause the user chose is kept; an unknown one is replaced.
    expect(normalizePromptQueue({ ...raw, paused: 'user' }, true)?.paused).toBe('user');
    expect(normalizePromptQueue({ ...raw, paused: 'bogus' }, true)?.paused).toBe('restart');
    expect(normalizePromptQueue({ items: [] }, true)).toBeUndefined();
    expect(normalizePromptQueue('junk', true)).toBeUndefined();
    expect(normalizePromptQueue({ items: 'junk' })).toBeUndefined();
  });

  it('survives a save and load of the app state, paused', () => {
    const s = defaultState();
    const claude = s.profiles.find((p) => p.cli === 'claude')!;
    const cell = { id: 'c1', profileId: claude.id, promptQueue: { items: [{ id: 'q1', text: 'next step' }] } };
    const bare = { id: 'c2', profileId: claude.id, promptQueue: { items: [] } };
    const saved = {
      ...s,
      activeProjectId: 'p',
      projects: [{ id: 'p', name: 'P', path: '/p', color: '#fff', tabs: [{ id: 't', name: 'T', layout: layoutForCount(2), cells: [cell, bare] }], archive: [], activeTabId: 't' }],
    };
    const loaded = normalizeState(JSON.parse(JSON.stringify(saved)))!;
    const cells = loaded.projects[0].tabs[0].cells;
    expect(cells[0].promptQueue).toEqual({ items: [{ id: 'q1', text: 'next step' }], paused: 'restart' });
    expect('promptQueue' in cells[1]).toBe(false);
  });
});
