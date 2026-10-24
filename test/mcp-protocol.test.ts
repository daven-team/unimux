import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MCP_TOOLS, toolsForRole } from '../src/main/mcpTools';
import { startMcpHarness } from './helpers/mcpHarness';

type Harness = Awaited<ReturnType<typeof startMcpHarness>>;
const harnesses: Harness[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(harnesses.splice(0).map((h) => h.server.stop()));
});
async function setup(options: Parameters<typeof startMcpHarness>[1] = { rateLimit: false }, deliver?: Parameters<typeof startMcpHarness>[0]) {
  const h = await startMcpHarness(deliver, options);
  harnesses.push(h);
  return h;
}
async function connect(h: Harness, cellId: string) {
  const client = new Client({ name: 'protocol-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { Authorization: `Bearer ${h.server.issueToken(cellId)}` } } }));
  clients.push(client);
  return client;
}
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]).text;
const data = (result: unknown) => JSON.parse(text(result));
const tokens = (value: unknown) => Math.round(JSON.stringify(value).length / 3.6);
const post = (h: Harness, token: string, body: unknown) => fetch(h.url, { method: 'POST', headers: {
  Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });

describe('token footprint', () => {
  // Before the redesign every role received all 21 tools: 14754 chars (~4098 tokens) plus 1175 chars of instructions.
  it('lists role-specific tools that are at least 40 percent cheaper than the old 21-tool list', async () => {
    const h = await setup();
    const sizes: Record<string, number> = {};
    for (const [role, cell] of [['coordinator', h.coordinator], ['worker', h.worker]] as const) {
      const client = await connect(h, cell.id);
      const { tools } = await client.listTools();
      const modelFacing = tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }));
      sizes[role] = tokens(modelFacing) + tokens(client.getInstructions());
    }
    expect(sizes.coordinator).toBeLessThan(4425 * 0.6);
    expect(sizes.worker).toBeLessThan(4425 * 0.6);
    expect(sizes.worker).toBeLessThan(sizes.coordinator);
  });
  it('shows workers none of the coordinator-only tools', async () => {
    const h = await setup();
    const names = (await (await connect(h, h.worker.id)).listTools()).tools.map((t) => t.name);
    for (const name of ['create_grid', 'close_grid', 'update_grid', 'save_preset', 'create_task', 'get_tasks', 'deliver']) expect(names).not.toContain(name);
    for (const name of ['get_context', 'read_inbox', 'wait_for', 'update_task', 'send_message', 'snippets', 'update_agent', 'list_agents', 'help']) expect(names).toContain(name);
  });
});

describe('tool definitions are portable across Claude Code and Codex', () => {
  const walk = (schema: unknown, path: string, problems: string[]) => {
    if (!schema || typeof schema !== 'object') return;
    const s = schema as Record<string, unknown>;
    for (const keyword of ['$ref', '$schema', '$defs', 'definitions', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'const']) if (keyword in s) problems.push(`${path}: ${keyword}`);
    if (Array.isArray(s.type) || s.type === 'null') problems.push(`${path}: type ${JSON.stringify(s.type)}`);
    if (!s.type) problems.push(`${path}: missing type`);
    if (s.type === 'array') { if (!s.items) problems.push(`${path}: array without items`); else walk(s.items, `${path}[]`, problems); }
    if (s.type === 'object') {
      if (!s.properties) problems.push(`${path}: object without properties`);
      for (const [key, value] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) walk(value, `${path}.${key}`, problems);
    }
  };
  it('uses flat, self-contained schemas and valid tool names for every role', () => {
    for (const role of ['coordinator', 'worker'] as const) {
      for (const tool of toolsForRole(role)) {
        const problems: string[] = [];
        walk(tool.inputSchema, tool.name, problems);
        expect(problems, tool.name).toEqual([]);
        expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,40}$/);
        // Claude Code and Codex prefix the server name: mcp__unimux__<tool> must stay within 64 characters.
        expect(`mcp__unimux__${tool.name}`.length).toBeLessThanOrEqual(64);
        expect(tool.description.length).toBeLessThanOrEqual(420);
        expect(tool.inputSchema.type).toBe('object');
      }
    }
  });
  it('keeps the advertised properties in step with what the tools accept', () => {
    // Accepted but intentionally not advertised (kept for older prompts or because help documents them).
    const hidden: Record<string, string[]> = { list_agents: ['projectId'], read_inbox: ['offset', 'openOnly'], get_tasks: ['projectId'], create_grid: ['layout', 'projectId'], save_preset: ['id'] };
    for (const tool of MCP_TOOLS) {
      const advertised = Object.keys(tool.inputSchema.properties).sort();
      const accepted = Object.keys(tool.schema.shape).filter((key) => !(hidden[tool.name] ?? []).includes(key)).sort();
      expect(advertised, tool.name).toEqual(accepted);
      const required = [...(tool.inputSchema.required ?? [])].sort();
      expect(required.every((key) => advertised.includes(key)), tool.name).toBe(true);
    }
    // Role-specific variants may only advertise things the tool accepts.
    for (const role of ['coordinator', 'worker'] as const) {
      for (const listed of toolsForRole(role)) {
        const accepted = Object.keys(MCP_TOOLS.find((t) => t.name === listed.name)!.schema.shape);
        expect(Object.keys(listed.inputSchema.properties).every((key) => accepted.includes(key)), `${role} ${listed.name}`).toBe(true);
      }
    }
  });
  it('declares hints so Codex asks before cross-agent, launch-setting and agent-spawning calls but not before own-task work', () => {
    const hints = (role: 'coordinator' | 'worker') => Object.fromEntries(toolsForRole(role).map((t) => [t.name, t.annotations]));
    const ask = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
    const quiet = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    expect(hints('worker')).toMatchObject({ get_context: read, list_agents: read, wait_for: read, help: read, read_inbox: quiet, update_task: quiet,
      send_message: ask, snippets: ask, update_agent: ask });
    expect(hints('coordinator')).toMatchObject({ get_tasks: read, create_task: ask, create_grid: ask, deliver: ask, update_agent: ask, snippets: ask,
      update_task: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, close_grid: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      update_grid: quiet, save_preset: quiet, read_inbox: quiet });
  });
  it('shows workers only name and color in update_agent', () => {
    const worker = toolsForRole('worker').find((t) => t.name === 'update_agent')!;
    expect(Object.keys(worker.inputSchema.properties).sort()).toEqual(['color', 'name']);
    expect(Object.keys(toolsForRole('coordinator').find((t) => t.name === 'update_agent')!.inputSchema.properties)).toContain('model');
  });
});

describe('MCP protocol behaviour (official SDK client)', () => {
  it('initializes statelessly with a role-aware instruction and returns text-only JSON results', async () => {
    const h = await setup();
    const client = await connect(h, h.worker.id);
    expect(client.getServerVersion()).toMatchObject({ name: 'unimux' });
    expect(client.getServerCapabilities()).toEqual({ tools: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } });
    expect(client.getInstructions()).toContain(h.worker.id);
    expect(client.getInstructions()).toContain('worker');
    const result = await client.callTool({ name: 'get_context', arguments: {} });
    expect(result.structuredContent).toBeUndefined();
    expect((result.content as Array<{ type: string }>).map((c) => c.type)).toEqual(['text']);
    // No session header: every request stands alone, so there is nothing to leak or expire.
    const response = await post(h, h.server.issueToken(h.reviewer.id), { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await client.ping()).toEqual({});
  });
  it('calls every listed tool with valid arguments', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id);
    const worker = await connect(h, h.worker.id);
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${text(result)}`).not.toBe(true);
      return data(result);
    };
    expect((await call(lead, 'get_context', { profiles: true })).profiles.length).toBeGreaterThan(1);
    const agents = await call(lead, 'list_agents', { verbose: true });
    expect(agents.agents).toHaveLength(3);
    expect(agents.grids).toHaveLength(1);
    const task = await call(lead, 'create_task', { cellId: h.worker.id, title: 'Implement', prompt: 'Do the thing' });
    const dependent = await call(lead, 'create_task', { cellId: h.reviewer.id, title: 'Review', prompt: 'Review it', dependsOn: [task.id] });
    expect(dependent.blockedBy).toEqual([task.id]);
    expect((await call(lead, 'get_tasks', { status: 'queued' })).tasks).toHaveLength(2);
    expect((await call(lead, 'get_tasks', { readyOnly: true })).tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    const inbox = await call(worker, 'read_inbox');
    expect(inbox.tasks).toMatchObject([{ id: task.id, title: 'Implement', prompt: 'Do the thing', status: 'queued' }]);
    expect(await call(worker, 'update_task', { taskId: task.id, status: 'in_progress' })).toEqual({ id: task.id, status: 'in_progress' });
    await call(worker, 'update_task', { taskId: task.id, status: 'completed', result: { summary: 'Done', files: ['a.ts'], tests: ['ok'] } });
    expect((await call(lead, 'get_tasks', { ids: [task.id] })).tasks[0].result).toMatchObject({ summary: 'Done', files: ['a.ts'] });
    expect((await call(worker, 'read_inbox')).tasks).toEqual([]);
    expect((await call(worker, 'read_inbox', { closed: true })).tasks).toHaveLength(1);
    const sent = await call(lead, 'send_message', { toCellId: h.worker.id, text: 'thanks' });
    expect(sent.delivery).toBe('pending');
    expect(await call(worker, 'read_inbox', { acknowledge: true })).toMatchObject({ messages: [{ id: sent.id, text: 'thanks' }], acknowledgedMessageIds: [sent.id] });
    expect((await call(worker, 'read_inbox')).messages).toEqual([]);
    expect(await call(worker, 'wait_for', { timeoutSec: 1 })).toEqual({ event: 'timeout' });
    const snippet = await call(worker, 'snippets', { action: 'save', name: 'Checklist', text: 'Run tests' });
    expect((await call(worker, 'snippets')).snippets).toMatchObject([{ id: snippet.id, name: 'Checklist' }]);
    expect(await call(worker, 'snippets', { action: 'get', snippetId: snippet.id })).toMatchObject({ text: 'Run tests' });
    expect((await call(lead, 'snippets', { action: 'apply', snippetId: snippet.id, cellId: h.reviewer.id })).id).toBeTruthy();
    expect(await call(worker, 'update_agent', { name: 'Backend 2', color: '#112233' })).toEqual({ cellId: h.worker.id });
    expect(h.controller.get().projects[0].tabs[0].cells[1]).toMatchObject({ name: 'Backend 2', color: '#112233' });
    await call(worker, 'update_agent', { color: '' });
    expect(h.controller.get().projects[0].tabs[0].cells[1].color).toBeUndefined();
    const grid = await call(lead, 'create_grid', { name: 'Extra', rows: [1], cells: [{ profileId: 'codex', role: 'worker', name: 'Extra', prompt: 'Look around' }] });
    expect(grid.cellIds).toHaveLength(1);
    const appended = await call(lead, 'create_grid', { gridId: grid.gridId, rows: [2], cells: [{ profileId: 'claude', name: 'Second' }] });
    expect(appended.gridId).toBe(grid.gridId);
    await call(lead, 'update_grid', { gridId: grid.gridId, name: 'Renamed', color: '#445566' });
    await call(lead, 'save_preset', { name: 'Pair', cells: [{ profileId: 'codex', role: 'worker' }] });
    expect((await call(lead, 'snippets')).presets).toMatchObject([{ name: 'Pair', cells: 1 }]);
    expect(await call(lead, 'deliver', { taskId: dependent.id })).toMatchObject({ delivery: 'pending', deliveryError: 'Not running' });
    expect(await call(lead, 'close_grid', { gridId: grid.gridId, cancelTasks: true })).toMatchObject({ stopped: 2 });
    expect(await call(worker, 'help', { topic: 'grids' })).toMatchObject({ topic: 'grids' });
  });
  it('builds a chained team in one create_grid call and returns the task ids', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id);
    const call = async (name: string, args: Record<string, unknown>) => data(await lead.callTool({ name, arguments: args }));
    const team = await call('create_grid', { name: 'Pipeline', cells: [
      { profileId: 'codex', role: 'worker', name: 'Dev', count: 2, prompt: 'Implement' },
      { profileId: 'claude', role: 'worker', name: 'Review', prompt: 'Review', after: [0, 1] },
    ] });
    expect(team.cellIds).toHaveLength(3);
    expect(Object.keys(team.tasks)).toEqual(team.cellIds);
    const tasks = h.controller.get().automation.tasks;
    const review = tasks.find((t) => t.id === team.tasks[team.cellIds[2]])!;
    expect(review.dependsOn).toEqual([team.tasks[team.cellIds[0]], team.tasks[team.cellIds[1]]]);
    const names = h.controller.get().projects[0].tabs.find((t) => t.id === team.gridId)!.cells.map((c) => c.name);
    expect(names).toEqual(['Dev 1', 'Dev 2', 'Review']);
    // The returned ids go straight to wait_for: no get_tasks round trip.
    expect(await call('wait_for', { taskIds: [team.tasks[team.cellIds[0]]], timeoutSec: 1 })).toEqual({ event: 'timeout' });
    const forward = await lead.callTool({ name: 'create_grid', arguments: { name: 'Bad', cells: [{ profileId: 'codex', role: 'worker', prompt: 'x', after: [1] }, { profileId: 'codex', role: 'worker', prompt: 'y' }] } });
    expect(forward.isError).toBe(true);
    expect(text(forward)).toMatch(/earlier cells/);
    const plain = await lead.callTool({ name: 'create_grid', arguments: { name: 'Bad2', cells: [{ profileId: 'codex', name: 'a' }, { profileId: 'codex', role: 'worker', prompt: 'y', after: [0] }] } });
    expect(plain.isError).toBe(true);
  });
  it('reports tool errors as isError text and protocol errors for unknown tools', async () => {
    const h = await setup();
    const client = await connect(h, h.worker.id);
    const bad = await client.callTool({ name: 'update_task', arguments: { taskId: 'x', status: 'bogus' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^Invalid arguments - status: /);
    expect(text(bad).length).toBeLessThan(300);
    const missing = await client.callTool({ name: 'update_task', arguments: {} });
    expect(missing.isError).toBe(true);
    const extra = await client.callTool({ name: 'get_context', arguments: { nope: 1 } });
    expect(extra.isError).toBe(true);
    const wrongType = await client.callTool({ name: 'read_inbox', arguments: { limit: 'many' } });
    expect(wrongType.isError).toBe(true);
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/Unknown tool/);
    const denied = await client.callTool({ name: 'create_grid', arguments: { name: 'x', cells: [{ profileId: 'codex' }] } });
    expect(denied).toMatchObject({ isError: true });
    expect(text(denied)).toContain('coordinator');
    const notFound = await client.callTool({ name: 'update_task', arguments: { taskId: 'missing', status: 'in_progress' } });
    // The id the model sent and where valid ids come from (a worker has no get_tasks).
    expect(text(notFound)).toBe('Task not found: missing. Task IDs come from read_inbox.');
    expect(h.controller.get().automation.events).toEqual([]);
  });
  it('keeps the old one-tool-per-operation names callable (unlisted) with role checks', async () => {
    const h = await setup();
    const worker = await connect(h, h.worker.id);
    const lead = await connect(h, h.coordinator.id);
    const legacy = await worker.callTool({ name: 'get_messages', arguments: {} });
    expect(data(legacy)).toEqual([]);
    expect((await worker.callTool({ name: 'list_library', arguments: {} })).isError).not.toBe(true);
    expect((await worker.callTool({ name: 'add_agents', arguments: { gridId: 'x', cells: [{ profileId: 'codex' }] } })).isError).toBe(true);
    const task = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'T', prompt: 'P' } }));
    expect((await worker.callTool({ name: 'get_tasks', arguments: {} })).isError).not.toBe(true);
    expect(data(await lead.callTool({ name: 'deliver_task', arguments: { taskId: task.id } }))).toMatchObject({ delivery: 'pending' });
    // UI-only operations are never reachable through MCP.
    for (const name of ['set_paused', 'set_role', 'mark_pasted']) await expect(worker.callTool({ name, arguments: {} })).rejects.toThrow(/Unknown tool/);
  });
  it('shapes results compactly: no echoed inputs, truncation markers, pagination', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id);
    const worker = await connect(h, h.worker.id);
    const long = 'x'.repeat(20000);
    const created = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'Long', prompt: long } }));
    expect(Object.keys(created).sort()).toEqual(['delivery', 'deliveryError', 'id', 'status']);
    for (let i = 0; i < 30; i++) await lead.callTool({ name: 'create_task', arguments: { cellId: h.reviewer.id, title: `T${i}`, prompt: 'short' } });
    const page = data(await lead.callTool({ name: 'get_tasks', arguments: { limit: 10 } }));
    expect(page.tasks).toHaveLength(10);
    expect(page.next).toBe(10);
    expect(page.tasks[0].prompt).toBeUndefined();
    expect(data(await lead.callTool({ name: 'get_tasks', arguments: { limit: 10, offset: page.next } })).tasks[0].title).not.toBe(page.tasks[0].title);
    expect(data(await lead.callTool({ name: 'get_tasks', arguments: { limit: 50 } })).next).toBeUndefined();
    const inbox = data(await worker.callTool({ name: 'read_inbox' }));
    expect(inbox.tasks[0].prompt).toMatch(/\.\.\.\[truncated \d+ chars; full:true for all\]$/);
    expect(inbox.tasks[0].prompt.length).toBeLessThan(12100);
    expect(data(await worker.callTool({ name: 'read_inbox', arguments: { full: true } })).tasks[0].prompt).toBe(long);
    const done = data(await worker.callTool({ name: 'update_task', arguments: { taskId: created.id, status: 'completed', result: { summary: 'y'.repeat(2000) } } }));
    expect(done).toEqual({ id: created.id, status: 'completed' });
    const row = data(await lead.callTool({ name: 'get_tasks', arguments: { ids: [created.id] } })).tasks[0];
    expect(row.result.summary).toContain('truncated');
    expect(data(await lead.callTool({ name: 'get_tasks', arguments: { ids: [created.id], verbose: true } })).tasks[0].result.summary).toHaveLength(2000);
  });
  it('accepts large arguments up to the body limit and handles concurrent calls', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id);
    const big = await lead.callTool({ name: 'snippets', arguments: { action: 'save', name: 'Big', text: 'z'.repeat(32000) } });
    expect(big.isError).not.toBe(true);
    const tooBig = await lead.callTool({ name: 'snippets', arguments: { action: 'save', name: 'Huge', text: 'z'.repeat(32001) } });
    expect(tooBig.isError).toBe(true);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => lead.callTool({ name: i % 2 ? 'get_context' : 'list_agents', arguments: {} })));
    expect(results.every((r) => r.isError !== true)).toBe(true);
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: `C${i}`, prompt: 'p' } })));
    expect(created.every((r) => r.isError !== true)).toBe(true);
    expect(new Set(created.map((r) => data(r).id)).size).toBe(20);
    expect(h.controller.get().automation.tasks).toHaveLength(20);
  });
  it('rejects revoked tokens at the HTTP layer and mid-session', async () => {
    const h = await setup();
    const token = h.server.issueToken(h.worker.id);
    expect((await post(h, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    h.server.revokeCell(h.worker.id);
    expect((await post(h, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    const second = h.server.issueToken(h.worker.id);
    h.server.issueToken(h.worker.id);
    expect((await post(h, second, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });
  it('stops listing tools when MCP is disabled for the cell and refuses calls', async () => {
    const h = await setup();
    const client = await connect(h, h.worker.id);
    h.service.state.change((s) => ({ ...s, projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t, cells: t.cells.map((c) => c.id === h.worker.id ? { ...c, role: undefined } : c) })) })) }));
    expect((await client.listTools()).tools).toEqual([]);
    const result = await client.callTool({ name: 'get_context', arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe('wait_for', () => {
  it('returns at once for pending inbox items and times out otherwise', async () => {
    const h = await setup();
    const worker = await connect(h, h.worker.id);
    const started = Date.now();
    expect(data(await worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 1 } }))).toEqual({ event: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const lead = await connect(h, h.coordinator.id);
    await lead.callTool({ name: 'send_message', arguments: { toCellId: h.worker.id, text: 'hi' } });
    const quick = Date.now();
    expect(data(await worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 30 } }))).toEqual({ event: 'inbox', unreadMessages: 1, queuedTasks: 0 });
    expect(Date.now() - quick).toBeLessThan(1000);
  });
  it('wakes up when a task is assigned, and when watched tasks finish', async () => {
    const h = await setup();
    const worker = await connect(h, h.worker.id);
    const lead = await connect(h, h.coordinator.id);
    const waiting = worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 20 } });
    await new Promise((r) => setTimeout(r, 100));
    const task = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'Go', prompt: 'p' } }));
    expect(data(await waiting)).toMatchObject({ event: 'inbox', queuedTasks: 1 });
    const watching = lead.callTool({ name: 'wait_for', arguments: { taskIds: [task.id], timeoutSec: 20 } });
    await new Promise((r) => setTimeout(r, 100));
    await worker.callTool({ name: 'update_task', arguments: { taskId: task.id, status: 'in_progress' } });
    await new Promise((r) => setTimeout(r, 300));
    await worker.callTool({ name: 'update_task', arguments: { taskId: task.id, status: 'completed', result: { summary: 'Finished it' } } });
    expect(data(await watching)).toEqual({ event: 'tasks', tasks: [{ id: task.id, status: 'completed', summary: 'Finished it' }] });
  });
  it('waits for all watched tasks when asked and rejects unknown ids', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id);
    const worker = await connect(h, h.worker.id);
    const a = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'A', prompt: 'p' } }));
    const b = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'B', prompt: 'p' } }));
    await worker.callTool({ name: 'update_task', arguments: { taskId: a.id, status: 'blocked', blockedReason: 'Need input' } });
    expect(data(await lead.callTool({ name: 'wait_for', arguments: { taskIds: [a.id, b.id], timeoutSec: 1 } }))).toMatchObject({ event: 'tasks' });
    expect(data(await lead.callTool({ name: 'wait_for', arguments: { taskIds: [a.id, b.id], all: true, timeoutSec: 1 } }))).toEqual({ event: 'timeout' });
    const unknown = await lead.callTool({ name: 'wait_for', arguments: { taskIds: ['nope'], timeoutSec: 1 } });
    expect(unknown.isError).toBe(true);
    expect((await lead.callTool({ name: 'wait_for', arguments: { timeoutSec: 600 } })).isError).toBe(true);
  });
  it('stops waiting when the client disconnects and frees the request slot', async () => {
    const h = await setup({ rateLimit: false, maxInFlightPerToken: 1 });
    const token = h.server.issueToken(h.worker.id);
    const ping = (id: number) => post(h, token, { jsonrpc: '2.0', id, method: 'ping' });
    const controller = new AbortController();
    const pending = fetch(h.url, { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 30 } } }) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    // The waiting request occupies the only slot...
    expect((await ping(2)).status).toBe(429);
    controller.abort();
    await pending;
    // ...and releases it as soon as the client is gone, long before the 30 s wait would end.
    const started = Date.now();
    let status = 429;
    while (status === 429 && Date.now() - started < 3000) { status = (await ping(3)).status; if (status === 429) await new Promise((r) => setTimeout(r, 25)); }
    expect(status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it('ends an in-flight wait_for with an expiry error when its token is revoked', async () => {
    const h = await setup();
    const token = h.server.issueToken(h.worker.id);
    const started = Date.now();
    const waiting = post(h, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 30 } } });
    await new Promise((r) => setTimeout(r, 200));
    h.server.revokeCell(h.worker.id);
    const body = await (await waiting).json();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe('Agent connection has expired.');
    // Re-issuing a token (cell restart) ends the old agent's wait the same way.
    const first = h.server.issueToken(h.reviewer.id);
    const second = post(h, first, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 30 } } });
    await new Promise((r) => setTimeout(r, 200));
    h.server.issueToken(h.reviewer.id);
    expect((await (await second).json()).result.isError).toBe(true);
  });
  it('does not hot-loop: wait_for ignores items already shown by read_inbox and reports new ones', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id);
    const worker = await connect(h, h.worker.id);
    await lead.callTool({ name: 'send_message', arguments: { toCellId: h.worker.id, text: 'first' } });
    await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'T1', prompt: 'p' } });
    // read without acknowledging, then wait: the old behaviour returned at once forever.
    expect(data(await worker.callTool({ name: 'read_inbox' })).messages).toHaveLength(1);
    const started = Date.now();
    expect(data(await worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 1 } }))).toEqual({ event: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    await lead.callTool({ name: 'send_message', arguments: { toCellId: h.worker.id, text: 'second' } });
    expect(data(await worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 5 } }))).toEqual({ event: 'inbox', unreadMessages: 1, queuedTasks: 0 });
    // A wait_for result counts as shown too.
    expect(data(await worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 1 } }))).toEqual({ event: 'timeout' });
    // A task that was blocked when read becomes news once its prerequisite completes.
    const pre = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.reviewer.id, title: 'Pre', prompt: 'p' } }));
    const dep = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'Dep', prompt: 'p', dependsOn: [pre.id] } }));
    expect(dep.blockedBy).toEqual([pre.id]);
    await worker.callTool({ name: 'read_inbox' });
    const reviewer = await connect(h, h.reviewer.id);
    const waiting = worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 10 } });
    await new Promise((r) => setTimeout(r, 300));
    await reviewer.callTool({ name: 'update_task', arguments: { taskId: pre.id, status: 'completed', result: { summary: 'ok' } } });
    expect(data(await waiting)).toEqual({ event: 'inbox', unreadMessages: 0, queuedTasks: 1 });
  });
  it('lets workers wait only on their own tasks and denies cross-cell actions', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id);
    const worker = await connect(h, h.worker.id);
    const other = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.reviewer.id, title: 'Secret', prompt: 'p' } }));
    const mine = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'Mine', prompt: 'p' } }));
    const reviewer = await connect(h, h.reviewer.id);
    await reviewer.callTool({ name: 'update_task', arguments: { taskId: other.id, status: 'blocked', blockedReason: 'private reason' } });
    const peek = await worker.callTool({ name: 'wait_for', arguments: { taskIds: [other.id], timeoutSec: 1 } });
    expect(peek.isError).toBe(true);
    expect(text(peek)).toBe('Task not found.');
    expect((await worker.callTool({ name: 'wait_for', arguments: { taskIds: [mine.id, other.id], timeoutSec: 1 } })).isError).toBe(true);
    expect(data(await lead.callTool({ name: 'wait_for', arguments: { taskIds: [other.id], timeoutSec: 1 } }))).toMatchObject({ event: 'tasks', tasks: [{ id: other.id, blockedReason: 'private reason' }] });
    const denied = [
      await worker.callTool({ name: 'create_task', arguments: { cellId: h.reviewer.id, title: 'x', prompt: 'p' } }),
      await worker.callTool({ name: 'update_agent', arguments: { cellId: h.coordinator.id, name: 'x' } }),
      await worker.callTool({ name: 'update_agent', arguments: { name: 'x', profileId: 'codex' } }),
      await worker.callTool({ name: 'update_agent', arguments: { restart: true } }),
      await worker.callTool({ name: 'update_task', arguments: { taskId: other.id, status: 'cancelled' } }),
    ];
    expect(denied.map((r) => r.isError)).toEqual([true, true, true, true, true]);
    // get_tasks is a coordinator tool: a worker calling it by name only ever sees its own tasks.
    expect(JSON.stringify(data(await worker.callTool({ name: 'get_tasks', arguments: { cellId: h.reviewer.id } })))).not.toContain('Secret');
    expect(h.controller.get().projects[0].tabs[0].cells[1].profileId).toBe('codex');
    expect(h.controller.get().projects[0].tabs[0].cells[1].name).toBe('Backend');
    expect(h.controller.get().automation.tasks.find((t) => t.id === other.id)!.status).toBe('blocked');
  });
  it('keeps a clipped message unread when acknowledging and returns it whole on request', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id);
    const worker = await connect(h, h.worker.id);
    const long = 'm'.repeat(20000);
    const longId = data(await lead.callTool({ name: 'send_message', arguments: { toCellId: h.worker.id, text: long } })).id;
    const shortId = data(await lead.callTool({ name: 'send_message', arguments: { toCellId: h.worker.id, text: 'short' } })).id;
    const first = data(await worker.callTool({ name: 'read_inbox', arguments: { acknowledge: true } }));
    expect(first.messages.find((m: { id: string }) => m.id === longId).text).toContain('kept unread');
    expect(first.messages.find((m: { id: string }) => m.id === longId).text.length).toBeLessThan(8200);
    expect(first.acknowledgedMessageIds).toEqual([shortId]);
    const stored = () => h.controller.get().automation.messages;
    expect(stored().find((m) => m.id === longId)!.readAt).toBeUndefined();
    expect(stored().find((m) => m.id === shortId)!.readAt).toBeDefined();
    const second = data(await worker.callTool({ name: 'read_inbox', arguments: { acknowledge: true, full: true } }));
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].text).toBe(long);
    expect(second.acknowledgedMessageIds).toEqual([longId]);
    expect(stored().find((m) => m.id === longId)!.readAt).toBeDefined();
  });
  it('keeps old inputs working and old shapes for names that are not listed', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id);
    const worker = await connect(h, h.worker.id);
    const task = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'Legacy', prompt: 'Full prompt' } }));
    // get_tasks is not listed for workers: the original call returns the original array of full records.
    const records = data(await worker.callTool({ name: 'get_tasks', arguments: {} }));
    expect(records).toMatchObject([{ id: task.id, prompt: 'Full prompt', projectId: h.project.id, cellId: h.worker.id, ready: true, blockedBy: [], delivery: 'pending' }]);
    expect(data(await worker.callTool({ name: 'get_messages', arguments: {} }))).toEqual([]);
    expect(data(await worker.callTool({ name: 'list_library', arguments: {} }))).toEqual({ snippets: [], presets: [] });
    const added = data(await lead.callTool({ name: 'add_agents', arguments: { gridId: h.project.tabs[0].id, rows: [2, 2], cells: [{ profileId: 'codex', name: 'Late' }] } }));
    expect(added.gridId).toBe(h.project.tabs[0].id);
    expect(added.cellIds).toHaveLength(1);
    // Listed tools keep accepting the old inputs.
    expect((await lead.callTool({ name: 'get_tasks', arguments: { limit: 100 } })).isError).not.toBe(true);
    expect((await worker.callTool({ name: 'read_inbox', arguments: { openOnly: false, offset: 0 } })).isError).not.toBe(true);
    const sent = data(await lead.callTool({ name: 'send_message', arguments: { toCellId: h.worker.id, text: 'legacy ack' } }));
    expect(data(await worker.callTool({ name: 'read_inbox', arguments: { acknowledge: true } })).acknowledgedMessageIds).toEqual([sent.id]);
  });
});

describe('server hardening', () => {
  it('listens on loopback only and issues unique 256-bit tokens', async () => {
    const h = await setup();
    expect(new URL(h.url).hostname).toBe('127.0.0.1');
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(h.server.issueToken(`cell-${i}`));
    expect(seen.size).toBe(200);
    for (const token of seen) expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
  it('does not grow with issued and revoked tokens', async () => {
    const h = await setup();
    for (let i = 0; i < 5000; i++) h.server.issueToken(`cell-${i % 50}`);
    expect(h.server.getInfo().configuredCellIds).toHaveLength(50);
    for (let i = 0; i < 50; i++) h.server.revokeCell(`cell-${i}`);
    expect(h.server.getInfo().configuredCellIds).toEqual([]);
    const internals = h.server as unknown as { tokens: Map<string, string>; tokenOf: Map<string, string>; buckets: Map<string, unknown>; inFlightByToken: Map<string, number> };
    expect([internals.tokens.size, internals.tokenOf.size, internals.buckets.size, internals.inFlightByToken.size]).toEqual([0, 0, 0, 0]);
  });
  it('rate limits per token with a monotonic clock: exact 429s, refill, no refill from a backwards step', async () => {
    let clock = 1000;
    const h = await setup({ rateLimit: { burst: 5, perSecond: 1 }, now: () => clock });
    const a = h.server.issueToken(h.worker.id);
    const b = h.server.issueToken(h.reviewer.id);
    const ping = async (token: string) => (await post(h, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status;
    const run = async (n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push(await ping(a)); return out; };
    expect(await run(7)).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(await ping(b)).toBe(200);
    const limited = await post(h, a, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    clock += 2000;
    expect(await run(3)).toEqual([200, 200, 429]);
    // The clock jumps back an hour: nothing is refilled (and nothing breaks), the new time is the reference.
    clock -= 3_600_000;
    expect(await run(2)).toEqual([429, 429]);
    clock += 1000;
    expect(await run(2)).toEqual([200, 429]);
    // A long idle period refills up to the burst only.
    clock += 10_000_000;
    expect(await run(7)).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });
  it('does not spend rate budget on requests rejected by the in-flight cap', async () => {
    const h = await setup({ rateLimit: { burst: 3, perSecond: 0.0001 }, maxInFlightPerToken: 1, now: () => 0 });
    const token = h.server.issueToken(h.worker.id);
    const call = (id: number, method: string, params?: unknown) => post(h, token, { jsonrpc: '2.0', id, method, params });
    const waiting = call(1, 'tools/call', { name: 'wait_for', arguments: { timeoutSec: 1 } });
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 10; i++) expect((await call(10 + i, 'ping')).status).toBe(429);
    await waiting;
    // One token went to the wait_for, none to the ten rejected pings: two pings remain.
    expect([(await call(2, 'ping')).status, (await call(3, 'ping')).status, (await call(4, 'ping')).status]).toEqual([200, 200, 429]);
  });
  it('caps simultaneous requests per token so a waiting agent cannot exhaust the server', async () => {
    const h = await setup({ rateLimit: false, maxInFlightPerToken: 2 });
    const token = h.server.issueToken(h.worker.id);
    const wait = () => post(h, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 2 } } });
    const first = [wait(), wait()];
    await new Promise((r) => setTimeout(r, 200));
    expect((await post(h, token, { jsonrpc: '2.0', id: 9, method: 'ping' })).status).toBe(429);
    // Another cell is unaffected.
    expect((await post(h, h.server.issueToken(h.reviewer.id), { jsonrpc: '2.0', id: 9, method: 'ping' })).status).toBe(200);
    await Promise.all(first);
    expect((await post(h, token, { jsonrpc: '2.0', id: 10, method: 'ping' })).status).toBe(200);
  });
  it('rejects foreign Host and Origin headers, other paths and methods, and oversize bodies', async () => {
    const h = await setup();
    const token = h.server.issueToken(h.worker.id);
    const rawStatus = (headers: Record<string, string>, path = '/mcp', method = 'POST') => new Promise<number>((resolve, reject) => {
      const req = request(new URL(path, h.url), { method, headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    expect(await rawStatus({ Host: 'evil.example' })).toBe(403);
    expect(await rawStatus({ Host: `evil.example:${new URL(h.url).port}` })).toBe(403);
    expect(await rawStatus({ Origin: 'null' })).toBe(403);
    expect(await rawStatus({ Origin: 'https://evil.example' })).toBe(403);
    expect(await rawStatus({}, '/other')).toBe(404);
    expect(await rawStatus({}, '/mcp', 'DELETE')).toBe(405);
    expect(await rawStatus({}, '/mcp', 'GET')).toBe(405);
    const noAuth = await fetch(h.url, { method: 'POST', headers: { Authorization: 'Basic abc' } });
    expect(noAuth.status).toBe(401);
    const big = await post(h, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'snippets', arguments: { action: 'save', name: 'x', text: 'x'.repeat(300000) } } });
    expect(big.status).toBe(413);
  });
  it('never echoes the bearer token in responses', async () => {
    const h = await setup();
    const token = h.server.issueToken(h.worker.id);
    const bodies: string[] = [];
    for (const body of [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bogus', arguments: {} } }, { jsonrpc: '2.0', id: 2, method: 'nope' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_task', arguments: { taskId: 5 } } }]) {
      bodies.push(await (await post(h, token, body)).text());
    }
    const malformed = await fetch(h.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{not json' });
    bodies.push(await malformed.text());
    expect(malformed.status).toBe(400);
    for (const body of bodies) expect(body).not.toContain(token);
  });
  it('answers tools/list quickly and cheaply for repeated calls', async () => {
    const h = await setup();
    const client = await connect(h, h.coordinator.id);
    const started = performance.now();
    for (let i = 0; i < 100; i++) await client.listTools();
    expect((performance.now() - started) / 100).toBeLessThan(25);
    const tools: Tool[] = (await client.listTools()).tools;
    expect(tools.length).toBe(toolsForRole('coordinator').length);
  });
});
