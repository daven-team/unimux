// Measures what one MCP event costs the app around the tool call itself: how many state changes it makes, how many bytes the
// state:changed patches sent to the renderer carry (with a busy project: 300 tasks, 200 activity events, 200 messages), how
// long a waiting wait_for takes to wake, and how much work the waiting agents do on state changes that are not for them.
// No model or network calls; run `node scripts/mcp-bench-events.mjs`.
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const dir = mkdtempSync(join(tmpdir(), 'ajz-mcp-events-'));
const entry = join(dir, 'entry.ts');
const src = (p) => JSON.stringify(pathToFileURL(resolve(p)).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const hasBroadcast = existsSync(resolve('src/main/stateBroadcast.ts'));
writeFileSync(entry, [
  `export { AutomationService } from ${src('src/main/automation.ts')};`,
  `export { StateController } from ${src('src/main/stateController.ts')};`,
  `export { addProject, addTab, defaultState } from ${src('src/shared/state.ts')};`,
  `export { layoutForCount } from ${src('src/shared/layout.ts')};`,
  `export { stateChange } from ${src('src/shared/statePatch.ts')};`,
  ...(hasBroadcast ? [`export { createStateBroadcaster } from ${src('src/main/stateBroadcast.ts')};`] : []),
].join('\n'));
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, external: ['electron', 'node-pty'], logLevel: 'silent' });
const m = await import(pathToFileURL(out).href);

let state = m.addProject(m.defaultState(), { name: 'P', path: 'D:/p' });
state = m.addTab(state, state.projects[0].id, { layout: m.layoutForCount(12), cells: Array.from({ length: 12 }, (_, i) => ({ profileId: i % 2 ? 'codex' : 'claude', role: i ? 'worker' : 'coordinator', name: `Agent ${i}` })) });
const project = state.projects[0], cells = project.tabs[0].cells, lead = cells[0], workers = cells.slice(1);
const now = Date.now();
const uuid = () => crypto.randomUUID();
state = { ...state, automation: { paused: false,
  tasks: Array.from({ length: 300 }, (_, i) => ({ id: uuid(), projectId: project.id, cellId: workers[i % workers.length].id, fromCellId: lead.id, title: `Task ${i}`, prompt: 'Do the thing. '.repeat(20), status: i % 3 ? 'completed' : 'in_progress', delivery: 'native', createdAt: now, updatedAt: now, ...(i % 3 ? { result: { summary: 'Done. '.repeat(10), files: ['a.ts'], tests: ['ok'] } } : {}) })),
  messages: Array.from({ length: 200 }, (_, i) => ({ id: uuid(), projectId: project.id, fromCellId: lead.id, toCellId: workers[i % workers.length].id, text: 'Hello there. '.repeat(5), delivery: 'native', createdAt: now, readAt: now })),
  events: Array.from({ length: 200 }, (_, i) => ({ id: uuid(), projectId: project.id, action: 'message', detail: `Event ${i}`, cellId: lead.id, createdAt: now })) } };

const sent = [];
let prev = state;
const pushRaw = (snapshot) => { sent.push(JSON.stringify(m.stateChange(prev, snapshot)).length); prev = snapshot.state; };
let broadcaster;
const controller = new m.StateController(state, (snapshot, batch) => {
  if (hasBroadcast) broadcaster.changed(snapshot, batch);
  else pushRaw(snapshot);
});
if (hasBroadcast) {
  broadcaster = m.createStateBroadcaster({ initial: controller.snapshot(), send: (change) => sent.push(JSON.stringify(change).length), delayMs: 16 });
}
const service = new m.AutomationService(controller, { createWorktree: async () => { throw new Error('no'); }, removeWorktree: async () => undefined, startCells: () => undefined, deliver: async () => undefined });
const settle = () => new Promise((r) => setTimeout(r, 40));
const measure = async (label, fn) => {
  sent.length = 0;
  const before = controller.snapshot().revision;
  await fn();
  await settle();
  return { event: label, stateChanges: controller.snapshot().revision - before, ipcMessages: sent.length, ipcBytes: sent.reduce((a, b) => a + b, 0) };
};
const rows = [];
let taskId;
rows.push(await measure('create_task', async () => { taskId = (await service.execute('create_task', { cellId: workers[0].id, title: 'New', prompt: 'Work' }, lead.id)).id; }));
rows.push(await measure('update_task in_progress', () => service.execute('update_task', { taskId, status: 'in_progress' }, workers[0].id)));
rows.push(await measure('update_task completed', () => service.execute('update_task', { taskId, status: 'completed', result: { summary: 'ok' } }, workers[0].id)));
rows.push(await measure('send_message', () => service.execute('send_message', { toCellId: workers[1].id, text: 'hi' }, lead.id)));
rows.push(await measure('read_inbox acknowledge', () => service.execute('read_inbox', { acknowledge: true }, workers[1].id)));
rows.push(await measure('10 x send_message burst', () => Promise.all(Array.from({ length: 10 }, (_, i) => service.execute('send_message', { toCellId: workers[2 + (i % 5)].id, text: `burst ${i}` }, lead.id)))));
console.log(hasBroadcast ? 'with the batched state broadcast (src/main/stateBroadcast.ts)' : 'one state:changed per state change (no stateBroadcast.ts)');
console.table(rows);

// wait_for: wake latency and the cost of unrelated changes while 10 agents wait.
const wake = [];
for (let i = 0; i < 20; i++) {
  const w = workers[3];
  const t = performance.now();
  let woke;
  const waiting = service.execute('wait_for', { timeoutSec: 10 }, w.id).then(() => { woke = performance.now(); });
  await new Promise((r) => setTimeout(r, 5));
  const sentAt = performance.now();
  await service.execute('send_message', { toCellId: w.id, text: `wake ${i}` }, lead.id);
  await waiting;
  wake.push(woke - sentAt);
  void t;
  await service.execute('read_inbox', { acknowledge: true }, w.id);
}
wake.sort((a, b) => a - b);
const timers = { set: 0 };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => { timers.set++; return realSetTimeout(fn, ms, ...rest); };
const waiters = workers.slice(0, 10).map((w) => service.execute('wait_for', { timeoutSec: 4 }, w.id));
const unrelated = 200;
const t0 = performance.now();
for (let i = 0; i < unrelated; i++) controller.change((s) => ({ ...s, settings: { ...s.settings, fontSize: 12 + (i % 2) } }));
const unrelatedMs = performance.now() - t0;
await Promise.all(waiters);
globalThis.setTimeout = realSetTimeout;
console.table([{ waitFor: 'wake after send_message', p50ms: +wake[10].toFixed(3), maxMs: +wake.at(-1).toFixed(3) },
  { waitFor: `${unrelated} unrelated state changes with 10 waiters`, totalMs: +unrelatedMs.toFixed(2), perChangeUs: +((unrelatedMs / unrelated) * 1000).toFixed(1) },
  { waitFor: '10 waiters x 4 s: timers armed', timers: timers.set }]);
rmSync(dir, { recursive: true, force: true });
