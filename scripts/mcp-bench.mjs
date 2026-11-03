// Measures what an MCP client pays for the unimux server: the tools/list payload per role (bytes and an estimated
// token count) and per-call latency of the in-process server. No model or network calls; run `node scripts/mcp-bench.mjs`.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const dir = mkdtempSync(join(tmpdir(), 'ajz-mcp-bench-'));
const out = join(dir, 'harness.mjs');
await build({ entryPoints: [resolve('test/helpers/mcpHarness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['electron', 'node-pty'], logLevel: 'silent', banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" } });
const { startMcpHarness } = await import(pathToFileURL(out).href);
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

const tokens = (chars) => Math.round(chars / 3.6);
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const h = await startMcpHarness(undefined, { rateLimit: false });
const connect = async (cellId) => {
  const client = new Client({ name: 'bench', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { Authorization: `Bearer ${h.server.issueToken(cellId)}` } } }));
  return client;
};
const rows = [];
let coordinator;
for (const [role, cell] of [['coordinator', h.coordinator], ['worker', h.worker]]) {
  const client = await connect(cell.id);
  if (role === 'coordinator') coordinator = client;
  const { tools } = await client.listTools();
  // What the model sees: name + description + input schema (annotations are not part of the model-facing definition).
  const modelFacing = JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })));
  const instructions = client.getInstructions() ?? '';
  const full = JSON.stringify(tools);
  rows.push({ role, tools: tools.length, descChars: tools.reduce((n, t) => n + (t.description ?? '').length, 0), schemaChars: JSON.stringify(tools.map((t) => t.inputSchema)).length,
    modelChars: modelFacing.length, modelTokens: tokens(modelFacing.length), instructionsChars: instructions.length, totalTokens: tokens(modelFacing.length + instructions.length), wireBytes: Buffer.byteLength(full) });
  if (role === 'worker') await client.close();
}
console.table(rows);

const call = async (client, name, args) => { const r = await client.callTool({ name, arguments: args }); return r; };
const sizes = [];
for (const [name, args] of [['get_context', {}], ['list_agents', {}], ['read_inbox', {}], ['create_task', { cellId: h.worker.id, title: 'Bench task', prompt: 'Do a thing' }], ['get_tasks', {}], ['send_message', { toCellId: h.worker.id, text: 'hello' }], ['get_messages', {}], ['wait_for', { timeoutSec: 1 }]]) {
  const r = await call(coordinator, name, args);
  const text = r.content?.map((c) => c.text ?? '').join('') ?? '';
  sizes.push({ tool: name, error: !!r.isError, textChars: text.length, structuredChars: r.structuredContent ? JSON.stringify(r.structuredContent).length : 0, estTokens: tokens(text.length + (r.structuredContent ? JSON.stringify(r.structuredContent).length : 0)) });
}
console.table(sizes);
// A worker calls read_inbox at the start and the end of every task: with 3 open tasks of ~2000 chars each, what the second call costs.
{
  const worker = await connect(h.reviewer.id);
  for (let i = 0; i < 3; i++) await call(coordinator, 'create_task', { cellId: h.reviewer.id, title: `Repeat ${i}`, prompt: 'Change the module and its tests carefully. '.repeat(45) });
  const chars = async (args) => (await call(worker, 'read_inbox', args)).content.map((c) => c.text ?? '').join('').length;
  const first = await chars({}), second = await chars({}), full = await chars({ full: true });
  console.table([{ read_inbox: '3 open tasks', firstChars: first, secondChars: second, secondTokens: tokens(second), fullChars: full }]);
  await worker.close();
}

const time = async (n, concurrency) => {
  const lat = [];
  const started = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < n) { next++; const t = performance.now(); await coordinator.callTool({ name: 'get_context', arguments: {} }); lat.push(performance.now() - t); }
  }));
  lat.sort((a, b) => a - b);
  return { calls: n, concurrency, totalMs: Math.round(performance.now() - started), p50: +pct(lat, 0.5).toFixed(2), p95: +pct(lat, 0.95).toFixed(2), p99: +pct(lat, 0.99).toFixed(2) };
};
const latency = [await time(1000, 1), await time(50, 50)];
{
  const t = performance.now(); await coordinator.listTools(); latency.push({ calls: 'tools/list', concurrency: 1, totalMs: +(performance.now() - t).toFixed(2) });
}
console.table(latency);
// Raw HTTP path (no SDK client): isolates the server's own cost per request.
{
  const headers = { Authorization: `Bearer ${h.server.issueToken(h.coordinator.id)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {} } });
  const lat = [];
  const started = performance.now();
  for (let i = 0; i < 1000; i++) { const t = performance.now(); const r = await fetch(h.url, { method: 'POST', headers, body }); await r.text(); lat.push(performance.now() - t); }
  lat.sort((a, b) => a - b);
  console.table([{ path: 'raw HTTP tools/call', calls: 1000, totalMs: Math.round(performance.now() - started), p50: +pct(lat, 0.5).toFixed(2), p95: +pct(lat, 0.95).toFixed(2), p99: +pct(lat, 0.99).toFixed(2) }]);
}
await coordinator.close().catch(() => {});
await h.server.stop();
rmSync(dir, { recursive: true, force: true });
