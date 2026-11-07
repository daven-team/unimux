// End-to-end check of the unimux MCP server with the real, installed agent CLIs and no sign-in or model usage. The model is a
// local mock. The server under test:
//   - Tauri (default): the check build's own MCP server (M1 server, M2 tools) on a seeded scratch state, with the stand-in
//     automation of the check build (unimux-mcp fake-automation); tokens come from the test bridge (`mcp-token`), the
//     state the automation answers from from `mcp-automation`. Offscreen, scratch MC_DATA_DIR and home.
//   - MC_APP_TARGET=electron / --target=electron: the 1.1.4 TS reference in-process (fake automation dependencies,
//     test/helpers/mcpHarness.ts).
// Claude Code (skipped when not installed):
//   1. `claude mcp list` (scratch CLAUDE_CONFIG_DIR) health-checks the server with a cell's bearer token; a revoked token fails;
//   2. `claude -p --mcp-config <the per-cell file unimux writes>` against a mock Anthropic Messages API: the "model" loads the
//      deferred unimux tools with ToolSearch, calls get_context, list_agents, an invalid update_task and a close_grid that needs
//      the user's confirmation (an MCP elicitation; `-p` cannot ask, so Claude Code answers "cancel" and nothing is closed).
// Codex (skipped when not installed):
//   3. `codex exec` with the same -c overrides a Codex cell gets (url, bearer_token_env_var) against a mock Responses API: the
//      "model" calls get_context through the mcp__unimux namespace.
// Usage: node scripts/verify-mcp-cli.mjs   (npm run build:check first; nothing reaches the real ~/.claude, ~/.codex or any API).
//        MCP_CLI_WAIT=600 node scripts/verify-mcp-cli.mjs   also runs a long wait_for in each CLI (the per-CLI wait caps).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { bridgeCall, freePort, isTauri, killAppTreeAndWait, quitApp, requireBuild, spawnApp, waitForMainPage } from './real-app.mjs';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';

const root = mkdtempSync(join(tmpdir(), 'unimux-mcp-cli-'));
const out = join(root, 'harness.mjs');
await build({ stdin: { contents: "export { startMcpHarness } from './test/helpers/mcpHarness';\nexport { writeClaudeMcpConfig } from './src/main/mcpCellConfig';", resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['electron', 'node-pty'], logLevel: 'silent', banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" } });
const { startMcpHarness, writeClaudeMcpConfig } = await import(pathToFileURL(out).href);
const debug = (...args) => { if (process.env.MOCK_DEBUG) console.error(...args); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The server under test behind one interface: url, the three team cells and the side grid with an open task (close_grid
 * needs the user's confirmation for it), tokens, the server info, the tabs the automation sees, and stop.
 */
async function electronHarness() {
  const h = await startMcpHarness(undefined, { rateLimit: false });
  const side = await h.service.execute('create_grid', { name: 'Side', cells: [{ profileId: 'codex', role: 'worker', name: 'Side worker', prompt: 'Work' }] }, h.coordinator.id);
  return {
    url: h.url, coordinator: h.coordinator.id, worker: h.worker.id, reviewer: h.reviewer.id, sideGridId: side.gridId,
    issueToken: async (cell) => h.server.issueToken(cell), revokeCell: async (cell) => h.server.revokeCell(cell),
    info: async () => h.server.getInfo(), sessions: async () => h.server.sessionCount, tabs: async () => h.controller.get().projects[0].tabs,
    stop: () => h.server.stop(),
  };
}

const LEAD = 'cli-lead', WORKER = 'cli-backend', REVIEWER = 'cli-review', SIDE = 'cli-side', SIDE_WORKER = 'cli-side-worker';
async function tauriHarness() {
  requireBuild();
  const data = join(root, 'app-data'), project = join(root, 'app-project'), agents = join(root, 'fake-agents');
  for (const dir of [data, project, agents]) mkdirSync(dir, { recursive: true });
  // The cells' agents must not start real CLIs: a stand-in claude / codex that only waits (the app may start the cells).
  const win = process.platform === 'win32';
  for (const cli of ['claude', 'codex']) {
    const file = join(agents, win ? `${cli}.cmd` : cli);
    writeFileSync(file, win ? '@echo off\r\nif "%~1"=="--version" (echo 0.0.0& exit /b 0)\r\nping -n 100000 127.0.0.1 >nul\r\n' : '#!/bin/sh\n[ "$1" = "--version" ] && echo 0.0.0 && exit 0\nsleep 100000\n');
    if (!win) chmodSync(file, 0o755);
  }
  const layout = (n) => ({ cols: n, rows: 1, areas: Array.from({ length: n }, (_, i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) });
  writeFileSync(join(data, 'state.json'), JSON.stringify({
    version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Project', path: project, color: '#3b82f6', archive: [], activeTabId: 'g', tabs: [
      { id: 'g', name: 'Team', layout: layout(3), cells: [
        { id: LEAD, name: 'Lead', profileId: 'claude', role: 'coordinator' }, { id: WORKER, name: 'Backend', profileId: 'codex', role: 'worker' },
        { id: REVIEWER, name: 'Review', profileId: 'claude', role: 'worker' }] },
      { id: SIDE, name: 'Side', layout: layout(1), cells: [{ id: SIDE_WORKER, name: 'Side worker', profileId: 'codex', role: 'worker' }] },
    ] }],
    profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' }, { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' },
      { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
    snippets: [], presets: [], settings: { language: 'en', fontSize: 13, notifications: false, lastProfileId: 'claude' },
    automation: { paused: false, events: [], messages: [], tasks: [{ id: 'cli-task', projectId: 'p', cellId: SIDE_WORKER, fromCellId: LEAD, title: 'Work', prompt: 'Work',
      status: 'queued', delivery: 'pending', createdAt: 1, updatedAt: 1 }] },
    sidebarCollapsed: false, snippetsOpen: false, sidebarWidth: 228, snippetsWidth: 210,
  }));
  const port = await freePort();
  const home = scratchHome(root);
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const env = { ...scrubAppEnv({ ...process.env }), MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), ...home.env,
    [pathKey]: `${agents}${win ? ';' : ':'}${process.env[pathKey] ?? ''}` };
  const child = spawnApp({ env });
  const target = await waitForMainPage(port, { child, ms: 45000 });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
  const cdp = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  let info;
  for (let i = 0; i < 150 && !info?.running; i++) {
    info = await evaluate('window.mc?.getMcpInfo ? window.mc.getMcpInfo() : null').catch(() => null);
    if (!info?.running) await sleep(200);
  }
  if (!info?.running) throw new Error(`the check build's MCP server did not start: ${JSON.stringify(info)}`);
  return {
    url: info.url, coordinator: LEAD, worker: WORKER, reviewer: REVIEWER, sideGridId: SIDE,
    issueToken: async (cell) => (await bridgeCall(evaluate, 'mcp-token', { cell })).token,
    revokeCell: (cell) => bridgeCall(evaluate, 'mcp-token', { cell, revoke: true }),
    info: () => evaluate('window.mc.getMcpInfo()'),
    sessions: async () => 'n/a',
    tabs: async () => (await bridgeCall(evaluate, 'mcp-automation')).state.projects[0].tabs,
    stop: async () => {
      await quitApp({ child, evaluate, cdp, ms: 10000 }).catch(() => undefined);
      try { socket.close(); } catch { /* closed */ }
      await killAppTreeAndWait(child);
    },
  };
}

const listen = async (server) => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; };
const run = (file, args, options) => new Promise((resolveRun) => {
  const child = execFile(file, args, { timeout: 120000, windowsHide: true, maxBuffer: 16 << 20, ...options }, (error, stdout, stderr) => resolveRun({ code: error?.code ?? 0, stdout, stderr }));
  child.stdin?.end(); // `codex exec` reads extra input from an open stdin
});
const installed = async (file) => (await run(file, ['--version'], { env: process.env })).code === 0;

/** Claude's tool calls, one assistant turn after another (ToolSearch first: Claude Code 2.1.x defers MCP tools). */
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
      // The first turn whose calls have no results yet; none left: the final answer.
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
const resultText = (r) => (Array.isArray(r?.content) ? r.content.map((c) => c.text ?? '').join('') : String(r?.content ?? ''));

const report = [];
/** MCP_CLI_WAIT=<seconds> adds the long wait_for checks (Claude up to 600 s, Codex up to 170 s); off by default (they take minutes). */
const waitSec = Number(process.env.MCP_CLI_WAIT) || 0;
const h = isTauri ? await tauriHarness() : await electronHarness();
report.push(`server: ${isTauri ? 'the Tauri check build' : 'the 1.1.4 TS reference'} at ${h.url}`);
const servers = [];
try {
  if (await installed('claude')) {
    const configDir = join(root, 'claude-config'), project = join(root, 'claude-project');
    mkdirSync(configDir); mkdirSync(project);
    const mock = claudeMock([
      [{ id: 'toolu_search', name: 'ToolSearch', input: { query: 'select:mcp__unimux__get_context,mcp__unimux__list_agents,mcp__unimux__update_task,mcp__unimux__close_grid', max_results: 5 } }],
      [{ id: 'toolu_ctx', name: 'mcp__unimux__get_context', input: { profiles: true } }, { id: 'toolu_agents', name: 'mcp__unimux__list_agents', input: {} },
        { id: 'toolu_bad', name: 'mcp__unimux__update_task', input: { taskId: 'nope', status: 'completed' } }],
      [{ id: 'toolu_close', name: 'mcp__unimux__close_grid', input: { gridId: h.sideGridId } }],
    ]);
    servers.push(mock.server);
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)/.test(k))),
      CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: await listen(mock.server), ANTHROPIC_API_KEY: 'sk-ant-mock-0000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    };
    const claude = (args) => run('claude', args, { cwd: project, env });
    report.push(`claude ${(await claude(['--version'])).stdout.trim()}`);

    const token = await h.issueToken(h.coordinator);
    assert.equal((await claude(['mcp', 'add-json', '-s', 'user', 'unimux', JSON.stringify({ type: 'http', url: h.url, headers: { Authorization: `Bearer ${token}` } })])).code, 0);
    const list = await claude(['mcp', 'list']);
    const line = list.stdout.split(/\r?\n/).find((l) => l.includes('unimux'))?.trim();
    report.push(`claude mcp list: ${line}`);
    assert.match(line ?? '', /Connected/i, list.stdout + list.stderr);
    assert.ok((await h.info()).connectedCellIds.includes(h.coordinator), 'the health check listed the tools');
    await claude(['mcp', 'remove', '-s', 'user', 'unimux']);

    const stale = await h.issueToken(h.reviewer);
    await h.revokeCell(h.reviewer);
    await claude(['mcp', 'add-json', '-s', 'user', 'stale', JSON.stringify({ type: 'http', url: h.url, headers: { Authorization: `Bearer ${stale}` } })]);
    const staleLine = (await claude(['mcp', 'list'])).stdout.split(/\r?\n/).find((l) => l.includes('stale'))?.trim();
    report.push(`claude mcp list, revoked token: ${staleLine}`);
    assert.match(staleLine ?? '', /401|Failed/i);
    await claude(['mcp', 'remove', '-s', 'user', 'stale']);

    const cellConfig = writeClaudeMcpConfig(join(root, 'mcp'), h.coordinator, h.url, await h.issueToken(h.coordinator));
    const result = await claude(['-p', 'Use the unimux tools.', '--mcp-config', cellConfig, '--strict-mcp-config', '--output-format', 'json',
      '--allowedTools', 'mcp__unimux__get_context,mcp__unimux__list_agents,mcp__unimux__update_task,mcp__unimux__close_grid', '--model', 'claude-sonnet-4-5']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const byId = Object.fromEntries(mock.seen.results.map((r) => [r.tool_use_id, r]));
    report.push(`claude -p: ${JSON.parse(result.stdout).result}; unimux tools announced to the model: ${mock.seen.offered.length}`);
    assert.ok(mock.seen.offered.includes('mcp__unimux__create_grid'), 'the coordinator sees create_grid');
    const ctx = JSON.parse(resultText(byId.toolu_ctx));
    assert.equal(ctx.cellId, h.coordinator);
    assert.equal(ctx.role, 'coordinator');
    assert.equal(JSON.parse(resultText(byId.toolu_agents)).agents.length, 4);
    assert.equal(byId.toolu_bad.is_error, true);
    report.push(`claude invalid update_task: ${resultText(byId.toolu_bad).split('\n')[0]}`);
    assert.equal(byId.toolu_close.is_error, true);
    assert.match(resultText(byId.toolu_close), /did not confirm/);
    assert.ok((await h.tabs()).some((t) => t.id === h.sideGridId), 'an unconfirmed close_grid closes nothing');
    report.push(`claude close_grid elicitation (-p answers cancel): ${resultText(byId.toolu_close).split('\n')[0].slice(0, 90)}`);

    // MCP_CLI_WAIT=<seconds>: a wait_for that long, as a Claude cell runs it (the per-cell config with its `timeout`): it must
    // end with the server's own "timeout" answer, not with a client-side abort (60 s first-byte timer, 5 minute idle timer).
    if (waitSec) {
      const waitMock = claudeMock([
        [{ id: 'toolu_search2', name: 'ToolSearch', input: { query: 'select:mcp__unimux__wait_for', max_results: 1 } }],
        [{ id: 'toolu_wait', name: 'mcp__unimux__wait_for', input: { timeoutSec: Math.min(waitSec, 600) } }],
      ]);
      servers.push(waitMock.server);
      const waitEnv = { ...env, ANTHROPIC_BASE_URL: await listen(waitMock.server) };
      const started = Date.now();
      const waited = await run('claude', ['-p', 'Wait.', '--mcp-config', writeClaudeMcpConfig(join(root, 'mcp'), h.coordinator, h.url, await h.issueToken(h.coordinator)), '--strict-mcp-config',
        '--output-format', 'json', '--allowedTools', 'mcp__unimux__wait_for', '--model', 'claude-sonnet-4-5'], { cwd: project, env: waitEnv, timeout: (waitSec + 120) * 1000 });
      const answer = waitMock.seen.results.find((r) => r.tool_use_id === 'toolu_wait');
      report.push(`claude wait_for ${Math.min(waitSec, 600)} s: ${resultText(answer).slice(0, 80)} after ${Math.round((Date.now() - started) / 1000)} s`);
      assert.equal(waited.code, 0, waited.stdout + waited.stderr);
      assert.ok(answer && !answer.is_error, `wait_for ended with an error: ${resultText(answer)}`);
      assert.match(resultText(answer), /"event":"timeout"/);
    }
  } else report.push('claude: not installed, skipped');

  if (await installed('codex')) {
    const home = join(root, 'codex-home'), project = join(root, 'codex-project');
    mkdirSync(home); mkdirSync(project);
    let output;
    const mock = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const request = JSON.parse(body || '{}');
        const ns = (request.tools ?? []).find((t) => t.name === 'mcp__unimux');
        const done = (request.input ?? []).find((i) => i.type === 'function_call_output' && i.call_id === 'call_ctx');
        if (done) output = done.output;
        debug('codex', ns ? ns.tools.map((t) => t.name).join(',') : 'no unimux namespace');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send('response.created', { response: { id: 'resp_mock' } });
        const item = ns && !done
          ? { type: 'function_call', id: 'fc_mock', call_id: 'call_ctx', name: 'get_context', namespace: 'mcp__unimux', arguments: '{}' }
          : { type: 'message', id: 'msg_mock', role: 'assistant', content: [{ type: 'output_text', text: done ? 'DONE' : 'NO_UNIMUX_TOOLS' }] };
        send('response.output_item.done', { output_index: 0, item });
        send('response.completed', { response: { id: 'resp_mock', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        res.end();
      });
    });
    servers.push(mock);
    const base = await listen(mock);
    const version = (await run('codex', ['--version'], { env: process.env })).stdout.trim();
    report.push(version);
    const token = await h.issueToken(h.worker);
    // The same overrides buildCliCommand gives a Codex cell (src/shared/profiles.ts).
    const args = ['exec', '--skip-git-repo-check', '-c', 'model_provider="mock"', '-c', `model_providers.mock={name="mock",base_url="${base}/v1",wire_api="responses",env_key="MOCK_KEY"}`,
      '-c', `mcp_servers.unimux.url="${h.url}"`, '-c', 'mcp_servers.unimux.bearer_token_env_var="UNIMUX_MCP_TOKEN"', '-c', 'mcp_servers.unimux.tool_timeout_sec=180', '-m', 'gpt-5', 'Use unimux get_context.'];
    const result = await run('codex', args, { cwd: project, env: { ...process.env, CODEX_HOME: home, MOCK_KEY: 'mock', UNIMUX_MCP_TOKEN: token, NO_PROXY: '127.0.0.1' } });
    assert.match(result.stdout, /DONE/, result.stdout + result.stderr);
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    assert.ok(text.includes(h.worker), `codex got get_context: ${text}`);
    report.push(`codex exec: get_context answered for the worker cell; sessions open: ${await h.sessions()}`);

    // MCP_CLI_WAIT: the longest wait_for of a Codex caller (170 s) within its tool_timeout_sec of 180.
    if (waitSec) {
      let waitOutput;
      const waitMock = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const request = JSON.parse(body || '{}');
          const ns = (request.tools ?? []).find((t) => t.name === 'mcp__unimux');
          const done = (request.input ?? []).find((i) => i.type === 'function_call_output' && i.call_id === 'call_wait');
          if (done) waitOutput = done.output;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
          send('response.created', { response: { id: 'resp_wait' } });
          const item = ns && !done
            ? { type: 'function_call', id: 'fc_wait', call_id: 'call_wait', name: 'wait_for', namespace: 'mcp__unimux', arguments: JSON.stringify({ timeoutSec: Math.min(waitSec, 170) }) }
            : { type: 'message', id: 'msg_wait', role: 'assistant', content: [{ type: 'output_text', text: 'DONE' }] };
          send('response.output_item.done', { output_index: 0, item });
          send('response.completed', { response: { id: 'resp_wait', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
          res.end();
        });
      });
      servers.push(waitMock);
      const waitBase = await listen(waitMock);
      const waitArgs = args.map((arg) => arg.replace(base, waitBase)).slice(0, -1).concat('Wait with unimux wait_for.');
      const started = Date.now();
      const waited = await run('codex', waitArgs, { cwd: project, timeout: (waitSec + 120) * 1000, env: { ...process.env, CODEX_HOME: home, MOCK_KEY: 'mock', UNIMUX_MCP_TOKEN: await h.issueToken(h.worker), NO_PROXY: '127.0.0.1' } });
      const text = typeof waitOutput === 'string' ? waitOutput : JSON.stringify(waitOutput);
      report.push(`codex wait_for ${Math.min(waitSec, 170)} s: ${String(text).slice(0, 80)} after ${Math.round((Date.now() - started) / 1000)} s`);
      assert.match(waited.stdout, /DONE/, waited.stdout + waited.stderr);
      assert.match(String(text), /timeout/);
      assert.doesNotMatch(String(text), /timed out|deadline|error/i);
    }
  } else report.push('codex: not installed, skipped');
  console.log(report.join('\n'));
  console.log('MCP CLI end-to-end check passed.');
} catch (error) {
  console.log(report.join('\n'));
  console.error(error);
  process.exitCode = 1;
} finally {
  await h.stop();
  for (const server of servers) server.close();
  removeScratch(root);
}
