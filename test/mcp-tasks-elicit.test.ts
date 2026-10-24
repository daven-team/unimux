import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, CreateTaskResultSchema, ElicitRequestSchema, GetTaskResultSchema, type ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import { startMcpHarness } from './helpers/mcpHarness';

// MCP elicitations (a tool call asks the user through the agent's client) and MCP tasks (a long wait_for the client polls),
// with the official SDK client the way Claude Code 2.1.x talks to the server: initialize declares elicitation, so the server
// keeps a session for it; clients without elicitation stay on the stateless path.
type Harness = Awaited<ReturnType<typeof startMcpHarness>>;
const harnesses: Harness[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(harnesses.splice(0).map((h) => h.server.stop()));
});
async function setup() {
  const h = await startMcpHarness(undefined, { rateLimit: false });
  harnesses.push(h);
  return h;
}
type Answer = (request: ElicitRequest) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
async function connect(h: Harness, cellId: string, answer?: Answer, token = h.server.issueToken(cellId)) {
  const client = new Client({ name: 'elicit-test', version: '1' }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  const asked: ElicitRequest[] = [];
  if (answer) client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request); return answer(request); });
  const transport = new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  clients.push(client);
  return { client, asked, transport, token };
}
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]).text;
/** A second grid with one worker that has an open task (close_grid cannot close the caller's own grid). */
async function gridWithOpenTask(h: Harness) {
  const team = await h.service.execute('create_grid', { name: 'Side', cells: [{ profileId: 'codex', role: 'worker', name: 'Side worker', prompt: 'Work' }] }, h.coordinator.id) as { gridId: string; cellIds: string[] };
  return team;
}

describe('MCP sessions for clients with elicitation', () => {
  it('gives an elicitation client a session and leaves other clients stateless', async () => {
    const h = await setup();
    const asking = await connect(h, h.coordinator.id, () => ({ action: 'cancel' }));
    expect(asking.transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const plain = await connect(h, h.worker.id);
    expect(plain.transport.sessionId).toBeUndefined();
    expect(h.server.sessionCount).toBe(1);
    expect((await asking.client.listTools()).tools.some((t) => t.name === 'create_grid')).toBe(true);
  });

  it('refuses a session id under another token and closes the sessions of a revoked token', async () => {
    const h = await setup();
    const asking = await connect(h, h.coordinator.id, () => ({ action: 'cancel' }));
    const other = h.server.issueToken(h.worker.id);
    const hijack = await fetch(h.url, { method: 'POST', headers: { Authorization: `Bearer ${other}`, 'Mcp-Session-Id': asking.transport.sessionId!, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) });
    expect(hijack.status).toBe(404);
    h.server.revokeCell(h.coordinator.id);
    expect(h.server.sessionCount).toBe(0);
    const again = await fetch(h.url, { method: 'POST', headers: { Authorization: `Bearer ${asking.token}`, 'Mcp-Session-Id': asking.transport.sessionId!, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }) });
    expect(again.status).toBe(401);
  });

  it('keeps at most four sessions per token and ends one on DELETE', async () => {
    const h = await setup();
    const token = h.server.issueToken(h.coordinator.id);
    const sessions = [];
    for (let i = 0; i < 6; i++) sessions.push(await connect(h, h.coordinator.id, () => ({ action: 'cancel' }), token));
    expect(h.server.sessionCount).toBe(4);
    await sessions[5].transport.terminateSession();
    expect(h.server.sessionCount).toBe(3);
  });
});

describe('elicitations', () => {
  it('close_grid with unfinished tasks asks the user and closes only after a confirmation', async () => {
    const h = await setup();
    const team = await gridWithOpenTask(h);
    let reply: ReturnType<Answer> = { action: 'decline' };
    const lead = await connect(h, h.coordinator.id, () => reply);
    const declined = await lead.client.callTool({ name: 'close_grid', arguments: { gridId: team.gridId } });
    expect(declined.isError).toBe(true);
    expect(text(declined)).toMatch(/did not confirm/);
    expect(lead.asked).toHaveLength(1);
    expect(lead.asked[0].params.message).toContain('Side');
    expect(lead.asked[0].params.message).toContain('(1)');
    expect(h.controller.get().projects[0].tabs.some((t) => t.id === team.gridId)).toBe(true);

    reply = { action: 'accept', content: { confirm: true } };
    const closed = await lead.client.callTool({ name: 'close_grid', arguments: { gridId: team.gridId } });
    expect(closed.isError).toBeFalsy();
    expect(JSON.parse(text(closed))).toMatchObject({ archived: team.gridId, stopped: 1 });
    expect(h.controller.get().automation.tasks.find((t) => t.cellId === team.cellIds[0])?.status).toBe('cancelled');
  });

  it('a client without elicitation gets the plain error, and cancelTasks:true never asks', async () => {
    const h = await setup();
    const team = await gridWithOpenTask(h);
    const plain = await connect(h, h.coordinator.id);
    const refused = await plain.client.callTool({ name: 'close_grid', arguments: { gridId: team.gridId } });
    expect(text(refused)).toMatch(/cancelTasks:true/);
    const lead = await connect(h, h.coordinator.id, () => { throw new Error('must not ask'); });
    expect((await lead.client.callTool({ name: 'close_grid', arguments: { gridId: team.gridId, cancelTasks: true } })).isError).toBeFalsy();
  });

  it('resolves an exact agent name to its cell and asks which one when several agents share it', async () => {
    const h = await setup();
    const lead = await connect(h, h.coordinator.id, (request) => {
      const options = (request.params as unknown as { requestedSchema: { properties: { cellId: { oneOf: Array<{ const: string }> } } } }).requestedSchema.properties.cellId.oneOf;
      return { action: 'accept', content: { cellId: options[1].const } };
    });
    // A unique name needs no question.
    const sent = await lead.client.callTool({ name: 'send_message', arguments: { toCellId: 'backend', text: 'hi' } });
    expect(sent.isError).toBeFalsy();
    expect(h.controller.get().automation.messages.at(-1)?.toCellId).toBe(h.worker.id);
    expect(lead.asked).toHaveLength(0);
    // Two agents named "Twin": the user picks the second.
    const team = await h.service.execute('create_grid', { name: 'Twins', cells: [{ profileId: 'codex', role: 'worker', name: 'Twin' }, { profileId: 'codex', role: 'worker', name: 'Twin' }] }, h.coordinator.id) as { cellIds: string[] };
    const task = await lead.client.callTool({ name: 'create_task', arguments: { cellId: 'Twin', title: 'T', prompt: 'P' } });
    expect(task.isError).toBeFalsy();
    expect(lead.asked).toHaveLength(1);
    expect(h.controller.get().automation.tasks.at(-1)?.cellId).toBe(team.cellIds[1]);
    // Without elicitation the ambiguity is an error naming the candidates.
    const plain = await connect(h, h.reviewer.id);
    const ambiguous = await plain.client.callTool({ name: 'send_message', arguments: { toCellId: 'twin', text: 'x' } });
    expect(ambiguous.isError).toBe(true);
    expect(text(ambiguous)).toContain(team.cellIds[0]);
    expect(text(ambiguous)).toContain(team.cellIds[1]);
  });
});

describe('MCP tasks', () => {
  const callAsTask = (client: Client, args: Record<string, unknown>) =>
    client.request({ method: 'tools/call', params: { name: 'wait_for', arguments: args, task: { ttl: 120000 } } }, CreateTaskResultSchema);

  it('lists wait_for as task-capable and runs it as a task past the plain 45 s limit', async () => {
    const h = await setup();
    const { client } = await connect(h, h.worker.id);
    const wait = (await client.listTools()).tools.find((t) => t.name === 'wait_for');
    expect(wait?.execution).toEqual({ taskSupport: 'optional' });
    expect((await client.callTool({ name: 'wait_for', arguments: { timeoutSec: 600 } })).isError).toBe(true);
    const { task } = await callAsTask(client, { timeoutSec: 600 });
    expect(task.status).toBe('working');
    expect((await client.request({ method: 'tasks/get', params: { taskId: task.taskId } }, GetTaskResultSchema)).status).toBe('working');
    await h.service.execute('send_message', { toCellId: h.worker.id, text: 'wake up' }, h.coordinator.id);
    const result = await client.request({ method: 'tasks/result', params: { taskId: task.taskId } }, CallToolResultSchema);
    expect(JSON.parse(text(result))).toMatchObject({ event: 'inbox', unreadMessages: 1 });
  });

  it('keeps a task private to its token, ends it when the client cancels and when the token is revoked', async () => {
    const h = await setup();
    const { client } = await connect(h, h.worker.id);
    const { task } = await callAsTask(client, { timeoutSec: 600 });
    const other = await connect(h, h.reviewer.id);
    await expect(other.client.request({ method: 'tasks/get', params: { taskId: task.taskId } }, GetTaskResultSchema)).rejects.toThrow();
    await client.request({ method: 'tasks/cancel', params: { taskId: task.taskId } }, GetTaskResultSchema.passthrough());
    expect((await client.request({ method: 'tasks/get', params: { taskId: task.taskId } }, GetTaskResultSchema)).status).toBe('cancelled');

    const second = await callAsTask(client, { timeoutSec: 600 });
    h.server.revokeCell(h.worker.id);
    const fresh = await connect(h, h.worker.id);
    // The new token's store starts empty: the old task is gone with its token.
    await expect(fresh.client.request({ method: 'tasks/get', params: { taskId: second.task.taskId } }, GetTaskResultSchema)).rejects.toThrow();
  });

  it('refuses task mode for tools that do not support it', async () => {
    const h = await setup();
    const { client } = await connect(h, h.worker.id);
    await expect(client.request({ method: 'tools/call', params: { name: 'read_inbox', arguments: {}, task: {} } }, CreateTaskResultSchema)).rejects.toThrow(/does not run as a task/);
  });
});
