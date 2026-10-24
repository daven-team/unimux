// End-to-end check of the unimux MCP server with the real, installed agent CLIs and no sign-in or model usage: the server
// runs in-process (fake automation, test/helpers/mcpHarness.ts) and the model is a local mock.
// Claude Code (skipped when not installed):
//   1. `claude mcp list` (scratch CLAUDE_CONFIG_DIR) health-checks the server with a cell's bearer token; a revoked token fails;
//   2. `claude -p --mcp-config <the per-cell file unimux writes>` against a mock Anthropic Messages API: the "model" loads the
//      deferred unimux tools with ToolSearch, calls get_context, list_agents, an invalid update_task and a close_grid that needs
//      the user's confirmation (an MCP elicitation; `-p` cannot ask, so Claude Code answers "cancel" and nothing is closed).
// Codex (skipped when not installed):
//   3. `codex exec` with the same -c overrides a Codex cell gets (url, bearer_token_env_var) against a mock Responses API: the
//      "model" calls get_context through the mcp__unimux namespace.
// Usage: node scripts/verify-mcp-cli.mjs   (nothing reaches the real ~/.claude, ~/.codex or any API).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = mkdtempSync(join(tmpdir(), 'unimux-mcp-cli-'));
const out = join(root, 'harness.mjs');
await build({ stdin: { contents: "export { startMcpHarness } from './test/helpers/mcpHarness';\nexport { writeClaudeMcpConfig } from './src/main/mcpCellConfig';", resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['electron', 'node-pty'], logLevel: 'silent', banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" } });
const { startMcpHarness, writeClaudeMcpConfig } = await import(pathToFileURL(out).href);
const debug = (...args) => { if (process.env.MOCK_DEBUG) console.error(...args); };

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
const h = await startMcpHarness(undefined, { rateLimit: false });
const servers = [];
try {
  if (await installed('claude')) {
    const configDir = join(root, 'claude-config'), project = join(root, 'claude-project');
    mkdirSync(configDir); mkdirSync(project);
    const side = await h.service.execute('create_grid', { name: 'Side', cells: [{ profileId: 'codex', role: 'worker', name: 'Side worker', prompt: 'Work' }] }, h.coordinator.id);
    const mock = claudeMock([
      [{ id: 'toolu_search', name: 'ToolSearch', input: { query: 'select:mcp__unimux__get_context,mcp__unimux__list_agents,mcp__unimux__update_task,mcp__unimux__close_grid', max_results: 5 } }],
      [{ id: 'toolu_ctx', name: 'mcp__unimux__get_context', input: { profiles: true } }, { id: 'toolu_agents', name: 'mcp__unimux__list_agents', input: {} },
        { id: 'toolu_bad', name: 'mcp__unimux__update_task', input: { taskId: 'nope', status: 'completed' } }],
      [{ id: 'toolu_close', name: 'mcp__unimux__close_grid', input: { gridId: side.gridId } }],
    ]);
    servers.push(mock.server);
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)/.test(k))),
      CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: await listen(mock.server), ANTHROPIC_API_KEY: 'sk-ant-mock-0000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    };
    const claude = (args) => run('claude', args, { cwd: project, env });
    report.push(`claude ${(await claude(['--version'])).stdout.trim()}`);

    const token = h.server.issueToken(h.coordinator.id);
    assert.equal((await claude(['mcp', 'add-json', '-s', 'user', 'unimux', JSON.stringify({ type: 'http', url: h.url, headers: { Authorization: `Bearer ${token}` } })])).code, 0);
    const list = await claude(['mcp', 'list']);
    const line = list.stdout.split(/\r?\n/).find((l) => l.includes('unimux'))?.trim();
    report.push(`claude mcp list: ${line}`);
    assert.match(line ?? '', /Connected/i, list.stdout + list.stderr);
    assert.ok(h.server.getInfo().connectedCellIds.includes(h.coordinator.id), 'the health check listed the tools');
    await claude(['mcp', 'remove', '-s', 'user', 'unimux']);

    const stale = h.server.issueToken(h.reviewer.id);
    h.server.revokeCell(h.reviewer.id);
    await claude(['mcp', 'add-json', '-s', 'user', 'stale', JSON.stringify({ type: 'http', url: h.url, headers: { Authorization: `Bearer ${stale}` } })]);
    const staleLine = (await claude(['mcp', 'list'])).stdout.split(/\r?\n/).find((l) => l.includes('stale'))?.trim();
    report.push(`claude mcp list, revoked token: ${staleLine}`);
    assert.match(staleLine ?? '', /401|Failed/i);
    await claude(['mcp', 'remove', '-s', 'user', 'stale']);

    const cellConfig = writeClaudeMcpConfig(join(root, 'mcp'), h.coordinator.id, h.url, h.server.issueToken(h.coordinator.id));
    const result = await claude(['-p', 'Use the unimux tools.', '--mcp-config', cellConfig, '--strict-mcp-config', '--output-format', 'json',
      '--allowedTools', 'mcp__unimux__get_context,mcp__unimux__list_agents,mcp__unimux__update_task,mcp__unimux__close_grid', '--model', 'claude-sonnet-4-5']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const byId = Object.fromEntries(mock.seen.results.map((r) => [r.tool_use_id, r]));
    report.push(`claude -p: ${JSON.parse(result.stdout).result}; unimux tools announced to the model: ${mock.seen.offered.length}`);
    assert.ok(mock.seen.offered.includes('mcp__unimux__create_grid'), 'the coordinator sees create_grid');
    const ctx = JSON.parse(resultText(byId.toolu_ctx));
    assert.equal(ctx.cellId, h.coordinator.id);
    assert.equal(ctx.role, 'coordinator');
    assert.equal(JSON.parse(resultText(byId.toolu_agents)).agents.length, 4);
    assert.equal(byId.toolu_bad.is_error, true);
    report.push(`claude invalid update_task: ${resultText(byId.toolu_bad).split('\n')[0]}`);
    assert.equal(byId.toolu_close.is_error, true);
    assert.match(resultText(byId.toolu_close), /did not confirm/);
    assert.ok(h.controller.get().projects[0].tabs.some((t) => t.id === side.gridId), 'an unconfirmed close_grid closes nothing');
    report.push(`claude close_grid elicitation (-p answers cancel): ${resultText(byId.toolu_close).split('\n')[0].slice(0, 90)}`);
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
    const token = h.server.issueToken(h.worker.id);
    // The same overrides buildCliCommand gives a Codex cell (src/shared/profiles.ts).
    const args = ['exec', '--skip-git-repo-check', '-c', 'model_provider="mock"', '-c', `model_providers.mock={name="mock",base_url="${base}/v1",wire_api="responses",env_key="MOCK_KEY"}`,
      '-c', `mcp_servers.unimux.url="${h.url}"`, '-c', 'mcp_servers.unimux.bearer_token_env_var="UNIMUX_MCP_TOKEN"', '-c', 'mcp_servers.unimux.tool_timeout_sec=180', '-m', 'gpt-5', 'Use unimux get_context.'];
    const result = await run('codex', args, { cwd: project, env: { ...process.env, CODEX_HOME: home, MOCK_KEY: 'mock', UNIMUX_MCP_TOKEN: token, NO_PROXY: '127.0.0.1' } });
    assert.match(result.stdout, /DONE/, result.stdout + result.stderr);
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    assert.ok(text.includes(h.worker.id), `codex got get_context: ${text}`);
    report.push(`codex exec: get_context answered for the worker cell; sessions open: ${h.server.sessionCount}`);
  } else report.push('codex: not installed, skipped');
  console.log(report.join('\n'));
  console.log('MCP CLI end-to-end check passed.');
} catch (error) {
  console.log(report.join('\n'));
  console.error(error);
  process.exitCode = 1;
} finally {
  await h.server.stop();
  for (const server of servers) server.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
