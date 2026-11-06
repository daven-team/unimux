// SP8 spike: the MCP wire of the 1.1.4 server (TypeScript reference) next to the two Rust candidates (a custom axum
// dispatcher and rmcp 3.9 StreamableHttpService), driven by the real, installed `claude` and `codex` CLIs on a scratch home
// with a local mock model (no sign-in, no model usage; the same mocks as scripts/verify-mcp-cli.mjs).
//
// Every server sits behind a tap proxy that records the wire (requests, response headers, SSE frames with timestamps) into
// artifacts/sp8/wire-<server>.jsonl, so the CLIs' real traffic can be compared server by server.
//
// Usage: node scripts/spike-mcp-wire.mjs [ts|custom|rmcp ...]   (default: all three; build the Rust ones first with
//        `cd src-tauri && node ../scripts/msvc-run.mjs cargo build -p unimux-mcp --examples --release`)
// Env:   SP8_CARGO_PROFILE=debug|release (default release), MOCK_DEBUG=1 (mock model traces)
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { bench, cases as protocolCases } from './spike-mcp-protocol.mjs';

const which = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const servers = which.length ? which : ['ts', 'custom', 'rmcp'];
const root = mkdtempSync(join(tmpdir(), 'unimux-sp8-'));
const artifacts = resolve('artifacts/sp8');
mkdirSync(artifacts, { recursive: true });
const debug = (...args) => { if (process.env.MOCK_DEBUG) console.error(...args); };
const profile = process.env.SP8_CARGO_PROFILE ?? 'release';
const exe = resolve(`src-tauri/target/${profile}/examples/${process.platform === 'win32' ? 'sp8_server.exe' : 'sp8_server'}`);

// ---------- the TS reference: harness + the real tool list and instructions (also the Rust servers' fixture) ----------
const bundle = join(root, 'harness.mjs');
await build({
  stdin: { contents: [
    "export { startMcpHarness } from './test/helpers/mcpHarness';",
    "export { writeClaudeMcpConfig, claudeMcpConfig } from './src/main/mcpCellConfig';",
    "export { toolsForRole, mcpInstructions } from './src/main/mcpTools';",
  ].join('\n'), resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: bundle, external: ['electron', 'node-pty'], logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
});
const ref = await import(pathToFileURL(bundle).href);
const fixture = join(root, 'tools.json');
writeFileSync(fixture, JSON.stringify({
  tools: ref.toolsForRole('coordinator'), workerTools: ref.toolsForRole('worker'),
  instructions: ref.mcpInstructions('coordinator', { cellId: 'cell-lead', name: 'Lead', project: 'Project' }),
}));

/** A started server: url, issue(cell) -> token, revoke(cell), lead/worker cell ids, the id of a grid with an open task. */
async function startTs() {
  const h = await ref.startMcpHarness(undefined, { rateLimit: false, progressEveryMs: 2000, version: '1.2.0' });
  const side = await h.service.execute('create_grid', { name: 'Side', cells: [{ profileId: 'codex', role: 'worker', name: 'Side worker', prompt: 'Work' }] }, h.coordinator.id);
  const side2 = await h.service.execute('create_grid', { name: 'Side 2', cells: [{ profileId: 'codex', role: 'worker', name: 'Side worker 2', prompt: 'Work' }] }, h.coordinator.id);
  const side3 = await h.service.execute('create_grid', { name: 'Side 3', cells: [{ profileId: 'codex', role: 'worker', name: 'Side worker 3', prompt: 'Work' }] }, h.coordinator.id);
  // The same call-start / call-end events the Rust fake logs, from the automation service the tools call.
  const events = [];
  const execute = h.service.execute.bind(h.service);
  h.service.execute = async (op, args, actor, signal) => {
    if (op !== 'wait_for') return execute(op, args, actor, signal);
    events.push({ kind: 'call-start', tool: op, at: Date.now() });
    try { const r = await execute(op, args, actor, signal); events.push({ kind: 'call-end', tool: op, outcome: signal?.aborted ? 'aborted' : 'ok', at: Date.now() }); return r; }
    catch (e) { events.push({ kind: 'call-end', tool: op, outcome: signal?.aborted ? 'aborted' : 'error', at: Date.now() }); throw e; }
  };
  return {
    url: h.url, lead: h.coordinator.id, worker: h.worker.id, openGrid: side.gridId, openGrid2: side2.gridId, openGrid3: side3.gridId,
    issue: async (cell) => h.server.issueToken(cell), revoke: async (cell) => h.server.revokeCell(cell),
    events: async () => events, sessions: async () => h.server.sessionCount,
    closed: () => h.controller.get().projects[0].tabs.every((t) => t.id !== side.gridId),
    stop: () => h.server.stop(),
  };
}
/** A Rust example server, driven over stdin/stdout JSON lines (issue, revoke, events). */
async function startRust(kind) {
  assert.ok(existsSync(exe), `build the spike first: ${exe}`);
  const child = spawn(exe, ['--impl', kind, '--tools', fixture, '--progress-ms', '2000'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const waiting = [];
  lines.on('line', (line) => { const w = waiting.shift(); if (w) w(JSON.parse(line)); });
  const next = () => new Promise((r) => waiting.push(r));
  const ask = (msg) => { const p = next(); child.stdin.write(`${JSON.stringify(msg)}\n`); return p; };
  const hello = await next();
  let closedGrid = false;
  return {
    url: hello.url, lead: 'cell-lead', worker: 'cell-worker', openGrid: 'grid-side', openGrid2: 'grid-side2', openGrid3: 'grid-side3',
    issue: async (cell) => (await ask({ cmd: 'issue', cell })).token, revoke: async (cell) => { await ask({ cmd: 'revoke', cell }); },
    events: async () => (await ask({ cmd: 'events' })).events,
    sessions: async () => (await ask({ cmd: 'events' })).sessions,
    closed: () => closedGrid, markClosed: () => { closedGrid = true; },
    stop: async () => { child.stdin.end(); await new Promise((r) => { child.once('exit', r); setTimeout(() => { child.kill(); r(); }, 3000); }); },
  };
}

// ---------- tap proxy: forwards to the server and records the wire ----------
function tap(target, file, label) {
  const up = new URL(target);
  let seq = 0;
  const t0 = Date.now();
  const log = (entry) => appendFileSync(file, `${JSON.stringify({ label: label(), ms: Date.now() - t0, at: Date.now(), ...entry })}\n`);
  const server = createServer((req, res) => {
    const id = ++seq;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers = { ...req.headers, host: up.host };
      log({ id, dir: 'req', method: req.method, url: req.url, headers: redact(req.headers), body: tryJson(body) });
      const fwd = httpRequest({ host: up.hostname, port: up.port, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        log({ id, dir: 'res', status: r.statusCode, headers: r.headers });
        r.on('data', (c) => { log({ id, dir: 'chunk', text: c.toString('utf8') }); res.write(c); });
        r.on('end', () => { log({ id, dir: 'end' }); res.end(); });
      });
      fwd.on('error', (e) => { log({ id, dir: 'error', error: String(e) }); if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => { if (!res.writableFinished) { log({ id, dir: 'client-closed' }); fwd.destroy(); } });
      fwd.end(body);
    });
  });
  return server;
}
const redact = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, k === 'authorization' ? String(v).replace(/[0-9a-f]{64}/, '<token>') : v]));
const tryJson = (s) => { try { return JSON.parse(s); } catch { return s; } };
const listen = async (server) => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; };

const run = (file, args, options) => new Promise((resolveRun) => {
  const started = Date.now();
  const child = execFile(file, args, { timeout: 180000, windowsHide: true, maxBuffer: 16 << 20, ...options }, (error, stdout, stderr) => resolveRun({ code: error?.code ?? 0, signal: error?.signal, stdout, stderr, ms: Date.now() - started }));
  child.stdin?.end();
  options?.onChild?.(child);
});

// ---------- mock models (as in verify-mcp-cli.mjs) ----------
function claudeMock(turns) {
  const seen = { results: [], offered: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":1}'); return; }
      const request = JSON.parse(body || '{}');
      const all = JSON.stringify(request.messages ?? []);
      const names = [...new Set(all.match(/mcp__unimux__\w+/g) ?? [])];
      if (names.length > seen.offered.length) seen.offered = names;
      const done = new Set([...all.matchAll(/"tool_use_id":"(toolu_[\w]+)"/g)].map((m) => m[1]));
      for (const message of request.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result' && !seen.results.some((r) => r.tool_use_id === block.tool_use_id)) seen.results.push(block);
      }
      const turn = turns.find((t) => !t.every((call) => done.has(call.id)));
      const blocks = turn && names.length ? turn.map((call) => ({ type: 'tool_use', ...call })) : [{ type: 'text', text: names.length ? 'DONE' : 'NO_UNIMUX_TOOLS' }];
      debug('claude turn', JSON.stringify(blocks).slice(0, 300));
      const stop = blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model: request.model ?? 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      blocks.forEach((b, index) => {
        if (b.type === 'text') {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
        } else {
          send('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
        }
        send('content_block_stop', { index });
      });
      send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      send('message_stop', {});
      res.end();
    });
  });
  return { server, seen };
}
/** Codex: one function call per turn from `calls` (namespace mcp__unimux), then DONE. */
function codexMock(calls) {
  const outputs = {};
  let tools = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      const ns = (request.tools ?? []).find((t) => t.name === 'mcp__unimux');
      if (ns) tools = ns.tools.map((t) => t.name);
      for (const i of request.input ?? []) if (i.type === 'function_call_output') outputs[i.call_id] = typeof i.output === 'string' ? i.output : JSON.stringify(i.output);
      const call = ns && calls.find((c) => !(c.call_id in outputs));
      debug('codex', ns ? 'namespace ok' : 'no unimux namespace', call?.name);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.created', { response: { id: 'resp_mock' } });
      const item = call
        ? { type: 'function_call', id: `fc_${call.call_id}`, call_id: call.call_id, name: call.name, namespace: 'mcp__unimux', arguments: JSON.stringify(call.args ?? {}) }
        : { type: 'message', id: 'msg_mock', role: 'assistant', content: [{ type: 'output_text', text: ns ? 'DONE' : 'NO_UNIMUX_TOOLS' }] };
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', { response: { id: 'resp_mock', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
  });
  return { server, outputs, tools: () => tools };
}
const resultText = (r) => (Array.isArray(r?.content) ? r.content.map((c) => c.text ?? '').join('') : String(r?.content ?? ''));

// ---------- scenarios ----------
async function scenarios(name, srv, results) {
  const wire = join(artifacts, `wire-${name}.jsonl`);
  rmSync(wire, { force: true });
  let scenario = 'setup';
  const proxy = tap(srv.url, wire, () => scenario);
  const url = `${await listen(proxy)}/mcp`;
  const mocks = [];
  const check = async (id, fn) => {
    scenario = id;
    const started = Date.now();
    try {
      const note = await fn();
      results.push({ server: name, id, ok: true, ms: Date.now() - started, note: note ?? '' });
    } catch (error) {
      results.push({ server: name, id, ok: false, ms: Date.now() - started, note: String(error?.message ?? error).split('\n').slice(0, 4).join(' | ').slice(0, 400) });
    }
  };
  try {
    // ----- Claude Code -----
    const configDir = join(root, `claude-config-${name}`), project = join(root, `claude-project-${name}`);
    mkdirSync(configDir, { recursive: true }); mkdirSync(project, { recursive: true });
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CONFIG_DIR)/.test(k))),
      CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'sk-ant-mock-0000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    };
    const claudeWith = async (turns, extra = {}) => {
      const mock = claudeMock(turns);
      mocks.push(mock.server);
      const base = await listen(mock.server);
      const token = await srv.issue(srv.lead);
      const config = join(root, `mcp-${name}-${Date.now()}.json`);
      writeFileSync(config, ref.claudeMcpConfig(url, token));
      const allowed = 'mcp__unimux__get_context,mcp__unimux__list_agents,mcp__unimux__update_task,mcp__unimux__close_grid,mcp__unimux__wait_for';
      const result = await run('claude', ['-p', 'Use the unimux tools.', '--mcp-config', config, '--strict-mcp-config', '--output-format', 'json', '--allowedTools', allowed,
        '--model', 'claude-sonnet-4-5', ...(extra.args ?? [])], { cwd: project, env: { ...env, ANTHROPIC_BASE_URL: base }, ...extra.options });
      const byId = Object.fromEntries(mock.seen.results.map((r) => [r.tool_use_id, r]));
      return { result, byId, offered: mock.seen.offered };
    };
    const version = (await run('claude', ['--version'], { env })).stdout.trim();

    await check('claude mcp list (initialize + tools/list)', async () => {
      const token = await srv.issue(srv.lead);
      const add = await run('claude', ['mcp', 'add-json', '-s', 'user', 'unimux', JSON.stringify({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } })], { cwd: project, env });
      assert.equal(add.code, 0, add.stderr);
      const list = await run('claude', ['mcp', 'list'], { cwd: project, env });
      await run('claude', ['mcp', 'remove', '-s', 'user', 'unimux'], { cwd: project, env });
      const line = list.stdout.split(/\r?\n/).find((l) => l.includes('unimux'))?.trim() ?? '';
      assert.match(line, /Connected/i, list.stdout + list.stderr);
      return `${version}: ${line.replace(/http:\/\/[^ ]+/, '<url>')}`;
    });
    await check('claude mcp list, revoked token -> 401', async () => {
      const token = await srv.issue(srv.worker);
      await srv.revoke(srv.worker);
      await run('claude', ['mcp', 'add-json', '-s', 'user', 'stale', JSON.stringify({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } })], { cwd: project, env });
      const line = (await run('claude', ['mcp', 'list'], { cwd: project, env })).stdout.split(/\r?\n/).find((l) => l.includes('stale'))?.trim() ?? '';
      await run('claude', ['mcp', 'remove', '-s', 'user', 'stale'], { cwd: project, env });
      assert.match(line, /401|Failed|auth/i);
      return line.replace(/http:\/\/[^ ]+/, '<url>');
    });
    await check('claude -p tools/call + elicitation (cancel in -p) + progress', async () => {
      const { result, byId, offered } = await claudeWith([
        [{ id: 'toolu_search', name: 'ToolSearch', input: { query: 'select:mcp__unimux__get_context,mcp__unimux__list_agents,mcp__unimux__update_task,mcp__unimux__close_grid,mcp__unimux__wait_for', max_results: 5 } }],
        [{ id: 'toolu_ctx', name: 'mcp__unimux__get_context', input: { profiles: true } }, { id: 'toolu_agents', name: 'mcp__unimux__list_agents', input: {} },
          { id: 'toolu_bad', name: 'mcp__unimux__update_task', input: { taskId: 'nope', status: 'completed' } }],
        [{ id: 'toolu_close', name: 'mcp__unimux__close_grid', input: { gridId: srv.openGrid } }],
        [{ id: 'toolu_wait', name: 'mcp__unimux__wait_for', input: { timeoutSec: 5 } }],
      ]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.ok(offered.includes('mcp__unimux__create_grid'), `tools offered: ${offered.length}`);
      assert.equal(JSON.parse(resultText(byId.toolu_ctx)).cellId, srv.lead, resultText(byId.toolu_ctx));
      assert.ok(Array.isArray(JSON.parse(resultText(byId.toolu_agents)).agents));
      assert.equal(byId.toolu_bad?.is_error, true, 'invalid update_task is an error result');
      assert.equal(byId.toolu_close?.is_error, true, resultText(byId.toolu_close));
      assert.match(resultText(byId.toolu_close), /did not confirm/);
      assert.match(resultText(byId.toolu_wait), /"event":"timeout"/, resultText(byId.toolu_wait));
      return `tools offered ${offered.length}; close_grid: ${resultText(byId.toolu_close).slice(0, 60)}; wait_for: ${resultText(byId.toolu_wait).slice(0, 40)}`;
    });
    await check('claude -p elicitation accepted by an Elicitation hook', async () => {
      const hook = join(root, 'elicit-accept.mjs');
      writeFileSync(hook, "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'Elicitation',action:'accept',content:{confirm:true}}}))});");
      const settings = join(root, 'elicit-settings.json');
      writeFileSync(settings, JSON.stringify({ hooks: { Elicitation: [{ matcher: '', hooks: [{ type: 'command', command: `node "${hook.replace(/\\/g, '/')}"` }] }] } }));
      const { result, byId } = await claudeWith([
        [{ id: 'toolu_search', name: 'ToolSearch', input: { query: 'select:mcp__unimux__close_grid', max_results: 1 } }],
        [{ id: 'toolu_close', name: 'mcp__unimux__close_grid', input: { gridId: srv.openGrid } }],
      ], { args: ['--settings', settings] });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const text = resultText(byId.toolu_close);
      assert.ok(!byId.toolu_close?.is_error, text);
      assert.match(text, /"archived"/);
      srv.markClosed?.();
      assert.ok(srv.closed(), 'the grid was closed after the accepted elicitation');
      return text.slice(0, 80);
    });
    await check('claude -p cancellation: wait_for ends when the CLI is killed', async () => {
      let child;
      const before = (await srv.events()).length;
      const mockPromise = claudeWith([
        [{ id: 'toolu_search', name: 'ToolSearch', input: { query: 'select:mcp__unimux__wait_for', max_results: 1 } }],
        [{ id: 'toolu_wait', name: 'mcp__unimux__wait_for', input: { timeoutSec: 120 } }],
      ], { options: { onChild: (c) => { child = c; } } });
      // Kill as soon as the wait_for is on the wire.
      const deadline = Date.now() + 60000;
      let killedAt;
      while (Date.now() < deadline) {
        const ev = (await srv.events()).slice(before);
        if (ev.some((e) => e.kind === 'call-start' && e.tool === 'wait_for')) {
          await new Promise((r) => setTimeout(r, 1000));
          killedAt = Date.now();
          if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGKILL');
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(killedAt, 'wait_for reached the server');
      await mockPromise;
      let ended;
      for (let i = 0; i < 50 && !ended; i++) {
        ended = (await srv.events()).slice(before).find((e) => e.kind === 'call-end' && e.tool === 'wait_for');
        if (!ended) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ended, 'the server noticed the dropped call');
      assert.equal(ended.outcome, 'aborted');
      // The tap closes the server side when the CLI's connection drops; the OS needs a varying time to kill the tree.
      const closed = readFileSync(wire, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.label === scenario && e.dir === 'client-closed').pop();
      return `server aborted wait_for ${closed ? ended.at - closed.at : '?'} ms after the connection closed (${ended.at - killedAt} ms after taskkill)`;
    });

    // ----- Codex -----
    const home = join(root, `codex-home-${name}`), cproject = join(root, `codex-project-${name}`);
    mkdirSync(home, { recursive: true }); mkdirSync(cproject, { recursive: true });
    const codexVersion = (await run('codex', ['--version'], { env: process.env })).stdout.trim();
    const codexWith = async (calls, prompt, cell = srv.worker, extraArgs = []) => {
      const mock = codexMock(calls);
      mocks.push(mock.server);
      const base = await listen(mock.server);
      const token = await srv.issue(cell);
      const args = ['exec', '--skip-git-repo-check', '-c', 'model_provider="mock"', '-c', `model_providers.mock={name="mock",base_url="${base}/v1",wire_api="responses",env_key="MOCK_KEY"}`,
        '-c', `mcp_servers.unimux.url="${url}"`, '-c', 'mcp_servers.unimux.bearer_token_env_var="UNIMUX_MCP_TOKEN"', '-c', 'mcp_servers.unimux.tool_timeout_sec=180',
        ...extraArgs, '-m', 'gpt-5', prompt];
      const result = await run('codex', args, { cwd: cproject, env: { ...process.env, CODEX_HOME: home, MOCK_KEY: 'mock', UNIMUX_MCP_TOKEN: token, NO_PROXY: '127.0.0.1' } });
      return { result, outputs: mock.outputs, tools: mock.tools() };
    };
    await check('codex exec tools/list + tools/call + progress', async () => {
      const { result, outputs, tools } = await codexWith([
        { call_id: 'call_ctx', name: 'get_context', args: {} },
        { call_id: 'call_wait', name: 'wait_for', args: { timeoutSec: 5 } },
      ], 'Use unimux.');
      assert.match(result.stdout, /DONE/, result.stdout + result.stderr);
      assert.ok(String(outputs.call_ctx).includes(srv.worker), `get_context: ${outputs.call_ctx}`);
      assert.match(String(outputs.call_wait), /timeout/);
      return `${codexVersion}; tools ${tools.length}; wait_for: ${String(outputs.call_wait).slice(0, 60)}`;
    });
    await check('codex exec elicitation (close_grid)', async () => {
      const { result, outputs } = await codexWith([{ call_id: 'call_close', name: 'close_grid', args: { gridId: srv.openGrid2 } }], 'Close the grid.', srv.lead,
        ['-c', 'mcp_servers.unimux.tools.close_grid.approval_mode="approve"']);
      assert.match(result.stdout, /DONE/, result.stdout + result.stderr);
      return String(outputs.call_close).slice(0, 160);
    });
    results.push({ server: name, id: 'sessions open at the end', ok: true, ms: 0, note: String(await srv.sessions()) });
    scenario = 'done';
    await new Promise((r) => setTimeout(r, 300));
    for (const [label, s] of Object.entries(summarize(wire))) results.push({ server: name, id: `wire: ${label}`, ok: true, ms: 0, note: s });
  } finally {
    for (const m of mocks) m.close();
    proxy.close();
  }
}

/** Per scenario: the exchanges (method -> status, content type) and how many progress / elicitation / keepalive frames. */
function summarize(file) {
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const byId = new Map();
  for (const e of lines) { if (!byId.has(e.id)) byId.set(e.id, []); byId.get(e.id).push(e); }
  const out = {};
  for (const events of byId.values()) {
    const req = events.find((e) => e.dir === 'req');
    const res = events.find((e) => e.dir === 'res');
    if (!req) continue;
    const text = events.filter((e) => e.dir === 'chunk').map((e) => e.text).join('');
    const method = req.method === 'POST' ? (req.body?.method ?? (req.body?.result ? 'response' : '?')) : req.method;
    const ct = String(res?.headers?.['content-type'] ?? '').replace('text/event-stream', 'sse').replace('application/json', 'json');
    const extras = [['progress', /notifications\/progress/g], ['elicit', /elicitation\/create/g], ['keepalive', /: keepalive/g]]
      .map(([k, re]) => [k, (text.match(re) ?? []).length]).filter(([, n]) => n).map(([k, n]) => `${k}x${n}`);
    const item = `${method}=${res?.status ?? (events.some((e) => e.dir === 'client-closed') ? 'closed' : '-')}${ct ? `/${ct}` : ''}${extras.length ? `(${extras.join(',')})` : ''}`;
    (out[req.label] ??= []).push(item);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join(' ')]));
}

const results = [];
const protocol = {};
const benches = {};
const onlyProtocol = process.argv.includes('--protocol'), onlyCli = process.argv.includes('--cli');
for (const name of servers) {
  const srv = name === 'ts' ? await startTs() : await startRust(name);
  try {
    if (!onlyCli) {
      protocol[name] = {};
      for (const [id, fn] of Object.entries(protocolCases(srv))) {
        try { protocol[name][id] = await fn(); } catch (error) { protocol[name][id] = { error: String(error?.message ?? error) }; }
      }
      writeFileSync(join(artifacts, `protocol-${name}.json`), JSON.stringify(protocol[name], null, 2));
      if (process.argv.includes('--bench')) benches[name] = await bench(srv);
    }
    if (!onlyProtocol) await scenarios(name, srv, results);
  } finally { await srv.stop(); }
}
if (protocol.ts) {
  const ids = Object.keys(protocol.ts);
  const others = Object.keys(protocol).filter((n) => n !== 'ts');
  const table = [];
  for (const id of ids) {
    const row = others.map((n) => (JSON.stringify(protocol[n][id]) === JSON.stringify(protocol.ts[id]) ? 'same' : 'DIFF'));
    table.push(`${row.map((r, i) => `${others[i]}:${r}`).join(' ')}  ${id}`);
  }
  for (const n of others) {
    const same = ids.filter((id) => JSON.stringify(protocol[n][id]) === JSON.stringify(protocol.ts[id])).length;
    table.push(`${n}: ${same} / ${ids.length} cases identical to 1.1.4`);
  }
  console.log(table.join('\n'));
  writeFileSync(join(artifacts, 'protocol-summary.txt'), `${table.join('\n')}\n`);
  if (protocol.custom && ids.some((id) => JSON.stringify(protocol.custom[id]) !== JSON.stringify(protocol.ts[id]))) process.exitCode = 1;
}
for (const [name, b] of Object.entries(benches)) console.log(`bench ${name}: stateless tools/list ms ${JSON.stringify(b.statelessToolsList)}, session ping ms ${JSON.stringify(b.sessionPing)}`);
const lines = results.map((r) => `${r.ok ? 'PASS' : r.server === 'rmcp' ? 'GAP ' : 'FAIL'} ${r.server.padEnd(6)} ${r.id} (${r.ms} ms)${r.note ? `: ${r.note}` : ''}`);
console.log(lines.join('\n'));
writeFileSync(join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
// rmcp failures are findings of the comparison (docs/tauri/spikes/SP8.md), not failures of the spike.
if (results.some((r) => !r.ok && r.server !== 'rmcp')) process.exitCode = 1;
