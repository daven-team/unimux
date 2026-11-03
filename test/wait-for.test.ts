// wait_for (1.1.2): event-driven with one deadline timer. Proves that it wakes on the event itself, times out on time, ends at
// once when cancelled or when the waiting agent's connection ends, reports agents of watched tasks that exited, cleans up its
// subscriptions, and sends MCP progress notifications to a client that asks for them (stateless and session clients).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, type Progress } from '@modelcontextprotocol/sdk/types.js';
import { removeCell } from '../src/shared/state';
import type { StateController } from '../src/main/stateController';
import { automationFixture } from './helpers/automationFixture';
import { startMcpHarness } from './helpers/mcpHarness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listeners = (controller: StateController) => (controller as unknown as { listeners: Set<unknown> }).listeners.size;

describe('wait_for in the service', () => {
  it('wakes on the change itself, well before any tick, and leaves no subscription behind', async () => {
    const f = automationFixture();
    const waiting = f.service.execute('wait_for', { timeoutSec: 30 }, f.worker.id);
    await sleep(10);
    expect(listeners(f.controller)).toBe(1);
    const sent = performance.now();
    await f.service.execute('send_message', { toCellId: f.worker.id, text: 'ping' }, f.coordinator.id);
    expect(await waiting).toEqual({ event: 'inbox', unreadMessages: 1, queuedTasks: 0 });
    expect(performance.now() - sent).toBeLessThan(50);
    expect(listeners(f.controller)).toBe(0);
  });

  it('times out after timeoutSec with one timer and no polling, however many unrelated changes happen', async () => {
    const f = automationFixture();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const started = performance.now();
    const waiting = f.service.execute('wait_for', { timeoutSec: 1 }, f.worker.id);
    for (let i = 0; i < 100; i++) f.controller.change((s) => ({ ...s, settings: { ...s.settings, fontSize: 12 + (i % 2) } }));
    const armed = spy.mock.calls.length;
    spy.mockRestore();
    expect(await waiting).toEqual({ event: 'timeout' });
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(950);
    expect(took).toBeLessThan(1500);
    expect(armed).toBe(1);
    expect(listeners(f.controller)).toBe(0);
  });

  it('ends at once when its signal aborts, also when it was aborted before it started', async () => {
    const f = automationFixture();
    const abort = new AbortController();
    const waiting = f.service.execute('wait_for', { timeoutSec: 30 }, f.worker.id, abort.signal);
    await sleep(10);
    const at = performance.now();
    abort.abort();
    expect(await waiting).toEqual({ event: 'cancelled' });
    expect(performance.now() - at).toBeLessThan(50);
    expect(listeners(f.controller)).toBe(0);
    expect(await f.service.execute('wait_for', { timeoutSec: 30 }, f.worker.id, abort.signal)).toEqual({ event: 'cancelled' });
  });

  it('fails when the waiting agent leaves (its cell is removed) instead of waiting out the timeout', async () => {
    const f = automationFixture();
    const waiting = f.service.execute('wait_for', { timeoutSec: 30 }, f.worker.id);
    await sleep(10);
    f.controller.change((s) => removeCell(s, f.project.id, f.project.tabs[0].id, f.worker.id));
    await expect(waiting).rejects.toThrow(/no longer available/);
    expect(listeners(f.controller)).toBe(0);
  });

  it('reports an exited agent of a watched open task once, and again after it ran and exited again', async () => {
    const f = automationFixture();
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'T', prompt: 'p' }, f.coordinator.id) as { id: string };
    const waiting = f.service.execute('wait_for', { taskIds: [task.id], timeoutSec: 30 }, f.coordinator.id);
    await sleep(10);
    f.service.statuses.set(f.worker.id, 'exited');
    expect(await waiting).toEqual({ event: 'exited', exitedCellIds: [f.worker.id], tasks: [{ id: task.id, status: 'queued', summary: undefined, blockedReason: undefined }] });
    // Told once: the next wait on the same task waits (no hot loop of instant answers).
    expect(await f.service.execute('wait_for', { taskIds: [task.id], timeoutSec: 1 }, f.coordinator.id)).toEqual({ event: 'timeout' });
    f.service.runtimeStarted(f.worker.id);
    f.service.statuses.set(f.worker.id, 'working');
    const again = f.service.execute('wait_for', { taskIds: [task.id], timeoutSec: 30 }, f.coordinator.id);
    await sleep(10);
    f.service.statuses.set(f.worker.id, 'exited');
    expect(await again).toMatchObject({ event: 'exited', exitedCellIds: [f.worker.id] });
  });

  it('a finished task wins over an exited agent, and all:true waits for every task', async () => {
    const f = automationFixture();
    const a = await f.service.execute('create_task', { cellId: f.worker.id, title: 'A', prompt: 'p' }, f.coordinator.id) as { id: string };
    const b = await f.service.execute('create_task', { cellId: f.worker.id, title: 'B', prompt: 'p' }, f.coordinator.id) as { id: string };
    const all = f.service.execute('wait_for', { taskIds: [a.id, b.id], all: true, timeoutSec: 30 }, f.coordinator.id);
    await f.service.execute('update_task', { taskId: a.id, status: 'completed', result: { summary: 'A done' } }, f.worker.id);
    await sleep(20);
    let settled = false;
    void all.then(() => { settled = true; });
    await sleep(20);
    expect(settled).toBe(false);
    await f.service.execute('update_task', { taskId: b.id, status: 'blocked', blockedReason: 'needs data' }, f.worker.id);
    expect(await all).toMatchObject({ event: 'tasks', tasks: [{ id: a.id, status: 'completed' }, { id: b.id, status: 'blocked' }] });
  });

  it('checks a burst of changes once', async () => {
    const f = automationFixture();
    const waiting = f.service.execute('wait_for', { timeoutSec: 30 }, f.worker.id);
    await sleep(5);
    const spy = vi.spyOn(f.controller, 'get');
    for (let i = 0; i < 50; i++) f.controller.change((s) => ({ ...s, settings: { ...s.settings, fontSize: 12 + (i % 2) } }));
    await sleep(0);
    const reads = spy.mock.calls.length;
    spy.mockRestore();
    expect(reads).toBeLessThan(10);
    await f.service.execute('send_message', { toCellId: f.worker.id, text: 'go' }, f.coordinator.id);
    expect(await waiting).toMatchObject({ event: 'inbox' });
  });
});

type Harness = Awaited<ReturnType<typeof startMcpHarness>>;
const harnesses: Harness[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(harnesses.splice(0).map((h) => h.server.stop()));
});
async function setup(progressEveryMs?: number) {
  const h = await startMcpHarness(undefined, { rateLimit: false, progressEveryMs });
  harnesses.push(h);
  return h;
}
/** `session`: a client that declares elicitation (like Claude Code) and gets a session; otherwise a stateless client. */
async function connect(h: Harness, cellId: string, session = false) {
  const client = new Client({ name: 'wait-test', version: '1' }, { capabilities: session ? { elicitation: { form: {} } } : {} });
  if (session) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
  const transport = new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { Authorization: `Bearer ${h.server.issueToken(cellId)}` } } });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}
const data = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

describe('wait_for over MCP', () => {
  for (const session of [false, true]) {
    it(`sends progress notifications while it waits, then the result (${session ? 'session' : 'stateless'} client)`, async () => {
      const h = await setup(60);
      const { client, transport } = await connect(h, h.worker.id, session);
      expect(!!transport.sessionId).toBe(session);
      const progress: Progress[] = [];
      const result = await client.callTool({ name: 'wait_for', arguments: { timeoutSec: 1 } }, undefined, { onprogress: (p) => progress.push(p), resetTimeoutOnProgress: true, timeout: 600 });
      expect(data(result)).toEqual({ event: 'timeout' });
      expect(progress.length).toBeGreaterThanOrEqual(5);
      expect(progress[0]).toMatchObject({ total: 1, message: 'waiting' });
      // The request timeout (600 ms) is shorter than the wait: the progress kept it alive.
    });
  }

  it('a client that does not ask for progress gets a plain JSON answer and no notifications', async () => {
    const h = await setup(30);
    const token = h.server.issueToken(h.worker.id);
    const r = await fetch(h.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 1 } } }) });
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(JSON.parse((await r.json()).result.content[0].text)).toEqual({ event: 'timeout' });
  });

  it('wakes on the event while progress flows, and the cancelled call frees its waiter', async () => {
    const h = await setup(50);
    const worker = (await connect(h, h.worker.id)).client;
    const lead = (await connect(h, h.coordinator.id, true)).client;
    const progress: Progress[] = [];
    const waiting = worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 30 } }, undefined, { onprogress: (p) => progress.push(p) });
    await sleep(180);
    const at = performance.now();
    await lead.callTool({ name: 'send_message', arguments: { toCellId: h.worker.id, text: 'hi' } });
    expect(data(await waiting)).toEqual({ event: 'inbox', unreadMessages: 1, queuedTasks: 0 });
    expect(performance.now() - at).toBeLessThan(500);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    // Cancelled by the client (notifications/cancelled and the closed request): the server-side wait ends, nothing keeps listening.
    const abort = new AbortController();
    const cancelled = lead.callTool({ name: 'wait_for', arguments: { timeoutSec: 30 } }, undefined, { signal: abort.signal });
    await sleep(100);
    expect(listeners(h.controller)).toBe(1);
    abort.abort();
    await expect(cancelled).rejects.toThrow();
    await vi.waitFor(() => expect(listeners(h.controller)).toBe(0), { timeout: 2000 });
    // And the next wait works normally.
    await lead.callTool({ name: 'send_message', arguments: { toCellId: h.worker.id, text: 'again' } });
    expect(data(await worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 5 } }))).toMatchObject({ event: 'inbox' });
  });

  it('tells the coordinator when the agent of a watched task exits', async () => {
    const h = await setup();
    const lead = (await connect(h, h.coordinator.id, true)).client;
    const task = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'Go', prompt: 'p' } }));
    const waiting = lead.callTool({ name: 'wait_for', arguments: { taskIds: [task.id], timeoutSec: 30 } });
    await sleep(100);
    h.service.statuses.set(h.worker.id, 'exited');
    expect(data(await waiting)).toEqual({ event: 'exited', exitedCellIds: [h.worker.id], tasks: [{ id: task.id, status: 'queued' }] });
  });

  it('a revoked token (the waiting agent exited) ends its wait at once', async () => {
    const h = await setup();
    // Stateless: the call itself answers with the expiry.
    const worker = (await connect(h, h.worker.id)).client;
    const waiting = worker.callTool({ name: 'wait_for', arguments: { timeoutSec: 30 } });
    await sleep(100);
    const at = performance.now();
    h.server.revokeCell(h.worker.id);
    const answer = await waiting.then((r) => r as { isError?: boolean; content: Array<{ text: string }> }, (e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    expect(answer.isError).toBe(true);
    expect(performance.now() - at).toBeLessThan(1000);
    expect(listeners(h.controller)).toBe(0);
    // A session (its process is gone with the token): the session closes and the server-side wait ends at once.
    const reviewer = (await connect(h, h.reviewer.id, true)).client;
    void reviewer.callTool({ name: 'wait_for', arguments: { timeoutSec: 30 } }).catch(() => undefined);
    await sleep(100);
    expect(listeners(h.controller)).toBe(1);
    h.server.revokeCell(h.reviewer.id);
    await vi.waitFor(() => expect(listeners(h.controller)).toBe(0), { timeout: 1000 });
    expect(h.server.sessionCount).toBe(0);
  });
});

describe('read_inbox keeps the agent context small', () => {
  it('sends a task prompt once per run of the agent; full:true and a restart send it again', async () => {
    const h = await setup();
    const lead = (await connect(h, h.coordinator.id)).client;
    const worker = (await connect(h, h.worker.id)).client;
    const prompt = 'Implement the export. '.repeat(200);
    const task = data(await lead.callTool({ name: 'create_task', arguments: { cellId: h.worker.id, title: 'Export', prompt } }));
    const first = await worker.callTool({ name: 'read_inbox', arguments: {} });
    expect(data(first).tasks[0]).toMatchObject({ id: task.id, prompt: prompt.trim() });
    const second = await worker.callTool({ name: 'read_inbox', arguments: {} });
    expect(data(second).tasks[0]).toEqual({ id: task.id, title: 'Export', status: 'queued', from: h.coordinator.id, seen: true });
    const size = (r: unknown) => JSON.stringify(r).length;
    expect(size(second)).toBeLessThan(size(first) / 10);
    expect(data(await worker.callTool({ name: 'read_inbox', arguments: { full: true } })).tasks[0].prompt).toBe(prompt.trim());
    h.service.runtimeStarted(h.worker.id);
    expect(data(await worker.callTool({ name: 'read_inbox', arguments: {} })).tasks[0].prompt).toBe(prompt.trim());
  });
});
