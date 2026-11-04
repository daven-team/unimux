// Guards the zod 3 -> 4 migration: the automation and MCP argument schemas keep the results zod 3 gave (defaults, trimming,
// stripped or refused keys, key order), IDs checked with z.guid() keep the loose zod 3 uuid rule, a ZodError still becomes an
// "Invalid arguments" text, and a state.json of the current version round-trips through normalizeState unchanged.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { automationSchemas, taskResultSchema } from '../src/shared/automation';
import { MCP_TOOLS, callTool, describeError, isZodError, type McpToolContext } from '../src/main/mcpTools';
import { normalizeState } from '../src/shared/state';

const fail = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? [] : r.error.issues.map((i) => ({ code: i.code, path: i.path }));
};

describe('automation schemas after zod 4', () => {
  it('fills defaults in declaration order and keeps explicit values', () => {
    const inbox = automationSchemas.read_inbox.parse({});
    expect(inbox).toEqual({ acknowledge: false, openOnly: false, limit: 50, offset: 0 });
    expect(Object.keys(inbox)).toEqual(['acknowledge', 'openOnly', 'limit', 'offset']);
    expect(automationSchemas.read_inbox.parse({ limit: 7, acknowledge: undefined })).toEqual({ acknowledge: false, openOnly: false, limit: 7, offset: 0 });
    // 1.1.4: no fixed default; the service picks it (and the cap) by the caller's CLI.
    expect(automationSchemas.wait_for.parse({})).toEqual({ all: false });
    expect(automationSchemas.get_messages.parse({ unreadOnly: false })).toEqual({ unreadOnly: false, limit: 50, offset: 0 });
    // A null is not "missing": it fails instead of taking the default.
    fail(automationSchemas.read_inbox, { acknowledge: null });
  });

  it('applies the defaults inside a given result object but leaves an absent result absent', () => {
    expect(automationSchemas.update_task.parse({ taskId: 't', status: 'completed' })).toEqual({ taskId: 't', status: 'completed' });
    expect('result' in automationSchemas.update_task.parse({ taskId: 't', status: 'completed' })).toBe(false);
    // As in zod 3, an explicit undefined stays an own key (with no default filled in).
    const explicit = automationSchemas.update_task.parse({ taskId: 't', status: 'completed', result: undefined });
    expect(Object.keys(explicit)).toEqual(['taskId', 'status', 'result']);
    expect(explicit.result).toBeUndefined();
    expect(automationSchemas.update_task.parse({ taskId: 't', status: 'completed', result: { summary: '  done ' } }))
      .toEqual({ taskId: 't', status: 'completed', result: { summary: 'done', files: [], tests: [] } });
    expect(taskResultSchema.parse({ summary: 's', files: undefined })).toEqual({ summary: 's', files: [], tests: [] });
  });

  it('refuses unknown keys of strict objects, nested ones too', () => {
    expect(fail(automationSchemas.get_context, { extra: 1 })).toEqual([{ code: 'unrecognized_keys', path: [] }]);
    expect(fail(automationSchemas.update_task, { taskId: 't', status: 'completed', result: { summary: 's', extra: 1 } })).toEqual([{ code: 'unrecognized_keys', path: ['result'] }]);
    expect(fail(automationSchemas.create_grid, { name: 'G', layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }], extra: 1 } }))
      .toEqual([{ code: 'unrecognized_keys', path: ['layout'] }]);
    fail(automationSchemas.get_context, null);
    fail(automationSchemas.get_context, []);
  });

  it('trims texts before the length checks and keeps nullable, optional and literal fields as before', () => {
    expect(automationSchemas.send_message.parse({ toCellId: 'c', text: '  hi  ' })).toEqual({ toCellId: 'c', text: 'hi' });
    fail(automationSchemas.send_message, { toCellId: 'c', text: '   ' });
    expect(automationSchemas.update_agent.parse({ cellId: 'c', color: null, model: null })).toEqual({ cellId: 'c', color: null, model: null, restart: false });
    expect(automationSchemas.update_agent.parse({ cellId: 'c', name: ' A ', model: 'gpt-5.1' })).toEqual({ cellId: 'c', name: 'A', model: 'gpt-5.1', restart: false });
    fail(automationSchemas.update_agent, { cellId: 'c', model: '-bad' });
    const grid = automationSchemas.create_grid.parse({ name: 'G', cells: [{ profileId: 'p', muted: true, dir: 'C:/x', after: [0] }] });
    expect(grid.cells).toEqual([{ profileId: 'p', muted: true, dir: 'C:/x', after: [0], worktree: false }]);
    fail(automationSchemas.create_grid, { name: 'G', cells: [{ profileId: 'p', muted: false }] });
    expect(automationSchemas.set_role.parse({ cellId: 'c', role: null })).toEqual({ cellId: 'c', role: null });
    fail(automationSchemas.wait_for, { timeoutSec: 601 });
    fail(automationSchemas.create_grid, { name: 'G', layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }], rowSizes: [Infinity] } });
  });

  it('the MCP tool schemas accept omitted unknown-typed fields and the tool JSON Schemas stay hand-written', () => {
    const grid = MCP_TOOLS.find((t) => t.name === 'create_grid')!;
    expect(grid.schema.parse({ name: 'G' })).toEqual({ name: 'G' });
    expect(grid.schema.parse({ name: 'G', cells: [{ any: 1 }], layout: 'x' })).toEqual({ name: 'G', cells: [{ any: 1 }], layout: 'x' });
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/\$schema|\$ref|anyOf/);
    }
  });

  it('a ZodError becomes an "Invalid arguments" text with the paths of the first issues', async () => {
    const r = automationSchemas.update_task.safeParse({ taskId: 't', status: 'bogus' });
    expect(r.success).toBe(false);
    expect(isZodError(r.error)).toBe(true);
    expect(describeError(r.error)).toMatch(/^Invalid arguments - status: /);
    expect(describeError(new Error('plain'))).toBe('plain');
    expect(describeError(automationSchemas.get_context.safeParse({ a: 1, b: 2 }).error)).toMatch(/^Invalid arguments - arguments: .*"a".*"b"/);
    // callTool parses with the tool schema before the service runs.
    const ctx = { service: { roleOf: () => 'worker', execute: () => { throw new Error('not reached'); } }, actorId: 'w' } as unknown as McpToolContext;
    await expect(callTool('update_task', { taskId: 't', status: 'completed', extra: 1 }, ctx)).rejects.toSatisfy(isZodError);
  });
});

describe('IDs checked with z.guid() (zod 3 uuid rule)', () => {
  const id = z.guid();
  it('accepts any 8-4-4-4-12 hex ID, also ones without RFC version and variant bits', () => {
    for (const v of [crypto.randomUUID(), crypto.randomUUID().toUpperCase(), '00000000-0000-0000-0000-000000000000', '12345678-1234-1234-1234-123456789012', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
      expect(id.safeParse(v).success, v).toBe(true);
    }
    // z.uuid() of zod 4 would refuse this one: an ID saved by an older version must keep working.
    expect(z.uuid().safeParse('12345678-1234-1234-1234-123456789012').success).toBe(false);
  });
  it('refuses everything else', () => {
    for (const v of ['', 'x', '123', '12345678-1234-1234-1234-12345678901', '12345678-1234-1234-1234-1234567890123', '{12345678-1234-1234-1234-123456789012}', 1, null, undefined]) {
      expect(id.safeParse(v).success, String(v)).toBe(false);
    }
  });
});

describe('state.json of the current version', () => {
  const state = {
    version: 1, activeProjectId: 'p',
    projects: [{ id: 'p', name: 'Atlas', path: 'C:/work/atlas', color: '#3b82f6', archive: [], activeTabId: 'g', tabs: [{
      id: 'g', name: 'Team', layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] },
      cells: [{ id: 'lead', name: 'Lead', profileId: 'claude', role: 'coordinator', color: '#f59e0b' }, { id: 'worker', name: 'Worker', profileId: 'codex', role: 'worker' }],
    }] }],
    profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' }, { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
    snippets: [{ id: 's1', name: 'Review', icon: 'R', color: '#60a5fa', text: 'Review {{branch}}', autoSend: false }],
    presets: [{ id: 'team', name: 'Team', layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] },
      cells: [{ name: 'Lead', profileId: 'claude', role: 'coordinator', worktree: false, prompt: 'Plan.' }, { name: 'Dev', profileId: 'codex', role: 'worker', worktree: false }] }],
    settings: { language: 'en', fontSize: 13, notifications: false, shell: 'cmd', lastProfileId: 'claude' },
    sidebarCollapsed: false, snippetsOpen: false, sidebarWidth: 228, snippetsWidth: 210,
  };
  it('normalizes once and then round-trips identically', () => {
    const first = normalizeState(JSON.parse(JSON.stringify(state)), 'win32');
    expect(first).not.toBeNull();
    const saved = JSON.stringify(first);
    expect(JSON.stringify(normalizeState(JSON.parse(saved), 'win32'))).toBe(saved);
    expect(first!.projects[0].tabs[0].cells.map((c) => [c.id, c.role])).toEqual([['lead', 'coordinator'], ['worker', 'worker']]);
  });
});
