import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { open } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyClaudeEntry, applyCodexEntry, claudeContextWindow, contextLevel, contextUsage, emptyScan, groupDigits, scanLines,
} from '../src/shared/contextUsage';
import { ContextTracker, findCodexRollout, scanBackwards, type ContextTarget } from '../src/main/contextUsage';
import { claudeProjectDirName } from '../src/main/sessions';
import { transcriptOf } from '../src/main/hooks';

const SESSION = '3f2b9c1e-7a4d-4e21-9b0a-5c6d7e8f9a01';
const CODEX_ID = '01a13797-c84e-7c32-bc48-1da925af91e6';
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// Shapes as Claude Code 2.1.x writes them (texts replaced, ids invented).
const claudeUser = (text: string) => ({
  parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: 'u1',
  timestamp: '2026-10-20T10:00:00.000Z', cwd: 'D:\\Projekty\\demo', sessionId: SESSION, version: '2.1.300', gitBranch: 'main',
});
const claudeAssistant = (usage: Record<string, number>, opts: { model?: string; sidechain?: boolean } = {}) => ({
  parentUuid: 'u1', isSidechain: opts.sidechain ?? false, type: 'assistant', requestId: 'req_1', requestedModel: opts.model ?? 'claude-opus-5-5',
  message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: opts.model ?? 'claude-opus-5-5',
    content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn',
    usage: { cache_creation: { ephemeral_5m_input_tokens: 0 }, service_tier: 'standard', output_tokens_details: {}, ...usage },
  },
  uuid: 'a1', timestamp: '2026-10-20T10:00:05.000Z', cwd: 'D:\\Projekty\\demo', sessionId: SESSION, version: '2.1.300',
});
const compactBoundary = (postTokens?: number) => ({
  parentUuid: null, logicalParentUuid: 'a1', isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
  level: 'info', compactMetadata: { trigger: 'manual', preTokens: 180_000, ...(postTokens ? { postTokens } : {}) }, uuid: 'c1', sessionId: SESSION,
});
const usage = (input: number, creation: number, read: number, output: number) =>
  ({ input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: output });

// Codex rollout lines (codex-rs 0.1xx).
const codexMeta = { timestamp: '2026-10-14T01:27:36.000Z', type: 'session_meta', payload: { id: CODEX_ID, cwd: 'D:\\Projekty\\demo', originator: 'codex_cli_rs' } };
const turnContext = (model: string) => ({ timestamp: '2026-10-14T01:27:40.000Z', type: 'turn_context', payload: { turn_id: 't1', cwd: 'D:\\Projekty\\demo', model, effort: 'medium' } });
const tokenCount = (lastTotal: number, window?: number) => ({
  timestamp: '2026-10-14T01:28:00.000Z', type: 'event_msg', payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: lastTotal * 10, cached_input_tokens: lastTotal * 9, output_tokens: 900, reasoning_output_tokens: 400, total_tokens: lastTotal * 10 + 900 },
      last_token_usage: { input_tokens: lastTotal - 300, cached_input_tokens: lastTotal - 1000, output_tokens: 300, reasoning_output_tokens: 120, total_tokens: lastTotal },
      ...(window ? { model_context_window: window } : {}),
    },
    rate_limits: { primary: { used_percent: 12, window_minutes: 300 } },
  },
});
const rateOnly = { timestamp: '2026-10-14T01:28:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {} } };
const codexMessage = { timestamp: '2026-10-14T01:28:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'token_count is a word here' }] } };

describe('context windows of Claude models', () => {
  it('knows the 1M and the 200k models', () => {
    expect(claudeContextWindow('claude-opus-5-5')).toBe(1_000_000);
    expect(claudeContextWindow('claude-sonnet-5-5')).toBe(1_000_000);
    expect(claudeContextWindow('claude-opus-4-6')).toBe(1_000_000);
    expect(claudeContextWindow('claude-sonnet-4-6')).toBe(1_000_000);
    expect(claudeContextWindow('claude-fable-5-1')).toBe(1_000_000);
    expect(claudeContextWindow('claude-haiku-5-5')).toBe(1_000_000);
    expect(claudeContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(claudeContextWindow('claude-sonnet-4-5-20250929')).toBe(200_000);
    expect(claudeContextWindow('claude-opus-4-1-20250805')).toBe(200_000);
    expect(claudeContextWindow('claude-sonnet-4-20250514')).toBe(200_000);
    expect(claudeContextWindow('claude-3-5-sonnet-20241022')).toBe(200_000);
  });

  it('takes the long window from a [1m] model setting, and 200k for unknown ids', () => {
    expect(claudeContextWindow('claude-sonnet-4-5-20250929', 'sonnet[1m]')).toBe(1_000_000);
    expect(claudeContextWindow('my-proxy-model')).toBe(200_000);
    expect(claudeContextWindow(undefined)).toBe(200_000);
  });
});

describe('Claude transcripts', () => {
  it('counts the last main-chain call: input, cache writes and reads, output', () => {
    const text = jsonl([claudeUser('hi'), claudeAssistant(usage(10, 2000, 30_000, 500)), claudeUser('more'), claudeAssistant(usage(4, 1200, 62_808, 300))]);
    const scan = scanLines('claude', emptyScan(), text);
    expect(scan.tokens).toBe(64_312);
    expect(contextUsage('claude', scan)).toEqual({ cli: 'claude', tokens: 64_312, window: 1_000_000, percent: 6, model: 'claude-opus-5-5' });
    const old = scanLines('claude', emptyScan(), jsonl([claudeAssistant(usage(4, 1200, 62_808, 300), { model: 'claude-sonnet-4-5-20250929' })]));
    expect(contextUsage('claude', old)?.percent).toBe(32);
  });

  it('ignores subagent (sidechain) calls and synthetic error messages', () => {
    let scan = scanLines('claude', emptyScan(), jsonl([claudeAssistant(usage(1, 0, 50_000, 10))]));
    scan = applyClaudeEntry(scan, claudeAssistant(usage(1, 0, 150_000, 10), { sidechain: true }));
    scan = applyClaudeEntry(scan, claudeAssistant(usage(0, 0, 0, 0), { model: '<synthetic>' }));
    expect(scan.tokens).toBe(50_011);
    expect(scan.model).toBe('claude-opus-5-5');
  });

  it('starts again after /compact: the summary size when recorded, else unknown until the next call', () => {
    const before = scanLines('claude', emptyScan(), jsonl([claudeAssistant(usage(1, 0, 180_000, 10))]));
    expect(applyClaudeEntry(before, compactBoundary(35_797)).tokens).toBe(35_797);
    const unknown = applyClaudeEntry(before, compactBoundary());
    expect(unknown.tokens).toBeNull();
    expect(contextUsage('claude', unknown)).toBeNull();
    expect(applyClaudeEntry(unknown, claudeAssistant(usage(3, 500, 40_000, 200))).tokens).toBe(40_703);
  });

  it('raises the window when the conversation is visibly larger than the table says', () => {
    const scan = scanLines('claude', emptyScan(), jsonl([claudeAssistant(usage(1, 0, 450_000, 10), { model: 'proxy-large' })]));
    expect(contextUsage('claude', scan)).toMatchObject({ window: 1_000_000, percent: 45 });
  });

  it('skips half-written and foreign lines', () => {
    const text = `${JSON.stringify(claudeAssistant(usage(1, 0, 1000, 1)))}\n{"type":"assistant","message":{"usage":{"input_tok\nnot json "usage"\n`;
    expect(scanLines('claude', emptyScan(), text).tokens).toBe(1002);
  });
});

describe('Codex rollouts', () => {
  it('reads the last call and the window from token_count, the model from the turn context', () => {
    const scan = scanLines('codex', emptyScan(), jsonl([codexMeta, turnContext('gpt-6.1-sol'), codexMessage, tokenCount(215_365, 475_000), rateOnly]));
    expect(contextUsage('codex', scan)).toEqual({ cli: 'codex', tokens: 215_365, window: 475_000, percent: 45, model: 'gpt-6.1-sol' });
  });

  it('is unknown without a window, and after a compaction until the next count', () => {
    expect(contextUsage('codex', scanLines('codex', emptyScan(), jsonl([tokenCount(10_000)])))).toBeNull();
    const scan = scanLines('codex', emptyScan(), jsonl([tokenCount(400_000, 475_000)]));
    const compacted = applyCodexEntry(scan, { timestamp: 'x', type: 'compacted', payload: { message: '' } });
    expect(contextUsage('codex', compacted)).toBeNull();
    expect(contextUsage('codex', applyCodexEntry(compacted, tokenCount(30_000, 475_000)))?.percent).toBe(6);
  });
});

describe('levels and numbers', () => {
  it('turns amber above 70% and red above 90%', () => {
    expect([contextLevel(70), contextLevel(71), contextLevel(90), contextLevel(91)]).toEqual(['ok', 'warn', 'warn', 'high']);
  });
  it('groups digits with spaces', () => {
    expect(groupDigits(64_312)).toBe('64 312');
    expect(groupDigits(1_000_000)).toBe('1 000 000');
    expect(groupDigits(950)).toBe('950');
  });
});

describe('hook payloads', () => {
  it('takes the transcript path of the main conversation only', () => {
    const path = `C:\\Users\\me\\.claude\\projects\\D--demo\\${SESSION}.jsonl`;
    expect(transcriptOf({ session_id: SESSION, transcript_path: path })).toEqual({ sessionId: SESSION, path });
    expect(transcriptOf({ session_id: SESSION, transcript_path: path, agent_id: 'sub' })).toBeNull();
    expect(transcriptOf({ session_id: SESSION, transcript_path: 'C:\\elsewhere\\secrets.txt' })).toBeNull();
    expect(transcriptOf({ session_id: 'nope', transcript_path: path })).toBeNull();
  });
});

describe('ContextTracker', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

  const setup = (targets: Record<string, ContextTarget>) => {
    dir = mkdtempSync(join(tmpdir(), 'mc-context-'));
    const emitted: Array<[string, number | null]> = [];
    const tracker = new ContextTracker({
      target: (cellId) => targets[cellId] ?? null,
      emit: (cellId, u) => emitted.push([cellId, u?.tokens ?? null]),
      claudeDir: () => join(dir, '.claude'),
      codexHome: () => join(dir, '.codex'),
    });
    return { tracker, emitted };
  };

  it('reads a Claude transcript from the project folder and then only what was appended', async () => {
    const cwd = 'D:\\Projekty\\demo';
    const { tracker, emitted } = setup({ c1: { cli: 'claude', sessionId: SESSION, cwd } });
    const folder = join(dir, '.claude', 'projects', claudeProjectDirName(cwd));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${SESSION}.jsonl`);
    writeFileSync(file, jsonl([claudeUser('hi'), claudeAssistant(usage(10, 2000, 30_000, 500))]));
    expect((await tracker.get('c1'))?.tokens).toBe(32_510);
    // A line still being written is not read yet.
    appendFileSync(file, JSON.stringify(claudeAssistant(usage(4, 1200, 62_808, 300))));
    expect((await tracker.get('c1'))?.tokens).toBe(32_510);
    appendFileSync(file, '\n');
    expect((await tracker.get('c1'))?.tokens).toBe(64_312);
    expect(tracker.reads).toBe(3);
    await tracker.get('c1'); // unchanged size: no read
    expect(tracker.reads).toBe(3);
    expect(emitted).toEqual([['c1', 32_510], ['c1', 64_312]]);
  });

  it('prefers the transcript path a hook reported', async () => {
    const { tracker } = setup({ c1: { cli: 'claude', sessionId: SESSION, cwd: 'D:\\nowhere' } });
    const elsewhere = join(dir, 'account-2', 'projects', 'x');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, `${SESSION}.jsonl`), jsonl([claudeAssistant(usage(1, 0, 99, 0))]));
    expect(await tracker.get('c1')).toBeNull();
    tracker.noteTranscript(SESSION, join(elsewhere, `${SESSION}.jsonl`));
    tracker.noteTranscript(SESSION, join(elsewhere, 'other.jsonl')); // refused
    expect((await tracker.get('c1'))?.tokens).toBe(100);
  });

  it('finds a Codex rollout by its thread id', async () => {
    const { tracker } = setup({ x1: { cli: 'codex', sessionId: CODEX_ID.toUpperCase(), cwd: 'D:\\Projekty\\demo' } });
    const day = join(dir, '.codex', 'sessions', '2026', '10', '14');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-10-14T01-00-00-01a10000-0000-7000-8000-000000000000.jsonl'), jsonl([codexMeta]));
    const file = join(day, `rollout-2026-10-14T01-27-36-${CODEX_ID}.jsonl`);
    writeFileSync(file, jsonl([codexMeta, turnContext('gpt-6.1-sol'), tokenCount(47_500, 475_000)]));
    expect(await findCodexRollout(join(dir, '.codex', 'sessions'), CODEX_ID)).toBe(file);
    expect(await tracker.get('x1')).toMatchObject({ percent: 10, model: 'gpt-6.1-sol' });
  });

  it('reads a long file backwards only until it finds a usage line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mc-context-'));
    const file = join(dir, 'long.jsonl');
    const filler = JSON.stringify(claudeUser('x'.repeat(2000)));
    writeFileSync(file, jsonl([claudeAssistant(usage(1, 0, 10, 0))]) + `${filler}\n`.repeat(400)
      + jsonl([claudeAssistant(usage(1, 0, 20_000, 0)), compactBoundary(5000)]) + `${filler}\n`.repeat(400) + '{"partial":');
    const fh = await open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      const { scan, offset } = await scanBackwards(fh, size, 'claude');
      expect(scan.tokens).toBe(5000);
      expect(offset).toBe(size - '{"partial":'.length);
    } finally { await fh.close(); }
  });

  it('throttles hook bursts into one read', async () => {
    vi.useFakeTimers();
    const cwd = 'D:\\Projekty\\demo';
    const { tracker, emitted } = setup({ c1: { cli: 'claude', sessionId: SESSION, cwd } });
    const folder = join(dir, '.claude', 'projects', claudeProjectDirName(cwd));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${SESSION}.jsonl`), jsonl([claudeAssistant(usage(1, 0, 10, 0))]));
    for (let i = 0; i < 20; i++) tracker.poke('c1');
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 50));
    expect(tracker.reads).toBe(1);
    expect(emitted).toEqual([['c1', 11]]);
  });
});
