// Real-app check of the 1.0.7 status tracking (npm run build first). A scratch data dir and home, MC_OFFSCREEN=1 and
// MC_DEBUG_PORT (default 9406). One grid with a shell cell and a Claude cell: the shell runs a silent long command, a quick
// failing one and a Ctrl-C'd one; Claude (the installed CLI, talking to a local mock of the Messages API, never the network)
// asks for a Bash permission and then ends with /exit. The status pill of each cell is sampled from the DOM and printed as a
// timeline; the checks fail the run when a state is wrong. Nothing reaches the real ~/.claude.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import electron from 'electron';
import { removeScratch, scrubAppEnv } from './app-env.mjs';
import { killTree, sleep } from './ssh-ui-lib.mjs';

const port = Number(process.env.MC_DEBUG_PORT ?? 9406);
const root = mkdtempSync(join('D:\\Projekty', '_tmp-status-ui-'));
const home = join(root, 'home');
const project = join(root, 'project');
const configDir = join(root, 'claude-config');
for (const dir of [join(root, 'data'), project, configDir, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true });

// ── mock Messages API: SCENARIO_TOOL asks for Bash, anything else answers with text ──
let toolAsked = false;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join(' ') : '');
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":1}');
    let r = {};
    try { r = JSON.parse(body || '{}'); } catch { /* empty */ }
    const messages = r.messages ?? [];
    const last = messages.at(-1);
    const hasResult = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');
    const asked = messages.some((m) => m.role === 'user' && /SCENARIO_TOOL/.test(textOf(m.content)));
    const askTool = (r.tools ?? []).length > 5 && asked && !hasResult && !toolAsked;
    if (askTool) toolAsked = true;
    const blocks = askTool
      ? [{ type: 'tool_use', id: 'toolu_rm1', name: 'Bash', input: { command: 'rm -f nothing-here.txt', description: 'Remove a file' } }]
      : [{ type: 'text', text: 'done' }];
    const stop = blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
    const message = { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: r.model ?? 'mock', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!r.stream) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...message, content: blocks, stop_reason: stop }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { ...message, content: [], stop_reason: null } });
    blocks.forEach((b, index) => {
      send('content_block_start', { index, content_block: b.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      send('content_block_delta', { index, delta: b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      send('content_block_stop', { index });
    });
    send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    send('message_stop', {});
    res.end();
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

const version = execFileSync('claude', ['--version'], { encoding: 'utf8', shell: true }).trim().split(' ')[0];
const key = 'sk-ant-api03-mock-0000000000000000000000000000000000000000';
writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, lastOnboardingVersion: version, theme: 'dark', numStartups: 5,
  customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
  projects: { [project.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
}));

const ids = { shell: randomUUID(), claude: randomUUID() };
const projectId = randomUUID();
const tabId = randomUUID();
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, settings: { language: 'pl', shell: 'pwsh' }, activeProjectId: projectId,
  // The default permission mode (the account default may be auto mode, which never shows the dialog).
  profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '--permission-mode default --model claude-sonnet-4-5', color: '#d97757' }, { id: 'shell', name: 'PowerShell', cli: 'shell', args: '', color: '#7a7a7a' }],
  projects: [{ id: projectId, name: 'Status', path: project, color: '#3b82f6', archive: [], activeTabId: tabId, tabs: [
    { id: tabId, name: 'Main', layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] },
      cells: [{ id: ids.shell, profileId: 'shell', name: 'Shell' }, { id: ids.claude, profileId: 'claude', name: 'Claude' }] },
  ] }],
}));

const env = {
  ...scrubAppEnv({ ...process.env }), MC_DATA_DIR: join(root, 'data'), MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port),
  USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`, ANTHROPIC_API_KEY: key,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
};
const child = spawn(electron, ['.'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

const timeline = [];
const failures = [];
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const note = (line) => { timeline.push(`${stamp()}  ${line}`); };
let ws;
try {
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch { /* starting */ }
  }
  if (!target) throw new Error(`the app window did not appear\n${stderr}`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, label, ms = 30000) => {
    const start = Date.now();
    while (Date.now() - start < ms) { if (await evaluate(expression).catch(() => false)) return; await sleep(150); }
    throw new Error(`timeout: ${label}`);
  };
  const pill = (id) => `(document.querySelector('[data-cell-id="${id}"] .status-text')?.textContent ?? '')`;
  const screen = (id) => `(() => { const rows = document.querySelectorAll('[data-cell-id="${id}"] .xterm-rows > div'); return [...rows].map((r) => r.textContent).join('\\n'); })()`;
  // Samples both pills every 250 ms and records every change.
  const last = {};
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      for (const [name, id] of Object.entries(ids)) {
        const text = await evaluate(pill(id)).catch(() => '?');
        if (text !== last[name]) { note(`${name.padEnd(6)} pill: ${JSON.stringify(text)}`); last[name] = text; }
      }
      await sleep(250);
    }
  })();
  const typeInto = async (id, text) => {
    await evaluate(`document.querySelector('[data-cell-id="${id}"] .xterm-helper-textarea').focus(), true`);
    await cdp('Input.insertText', { text });
  };
  const key = async (id, data, label) => {
    note(`user   ${label}`);
    await evaluate(`document.querySelector('[data-cell-id="${id}"] .xterm-helper-textarea').focus(), true`);
    const map = { '\r': ['Enter', 13], '\x03': ['c', 67] };
    const [k, code] = map[data];
    const modifiers = data === '\x03' ? 2 : 0;
    for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code: data === '\x03' ? 'KeyC' : k, windowsVirtualKeyCode: code, modifiers, ...(type === 'keyDown' && data === '\r' ? { text: '\r' } : {}) });
  };
  const expectPill = async (name, pattern, label, ms = 15000) => {
    try { await until(`/${pattern}/.test(${pill(ids[name])})`, label, ms); note(`OK     ${label}`); }
    catch { failures.push(`${label}: pill was ${JSON.stringify(await evaluate(pill(ids[name])))}`); note(`FAIL   ${label}`); }
  };

  await until(`!!document.querySelector('[data-cell-id="${ids.shell}"] .xterm-helper-textarea') && !!document.querySelector('[data-cell-id="${ids.claude}"] .xterm-helper-textarea')`, 'both terminals');
  await sleep(8000); // the WebGL renderer has no DOM rows to read the prompt from: the shell gets time to start
  note('----   shell ready');

  // Shell: a silent 7 s command is "polecenie działa" all the way, then waiting.
  await typeInto(ids.shell, 'Start-Sleep 7');
  await key(ids.shell, '\r', 'Enter: Start-Sleep 7');
  await expectPill('shell', 'polecenie', 'shell: a silent command shows "polecenie działa"', 3000);
  await sleep(5000);
  await expectPill('shell', 'polecenie', 'shell: still running after 5 s of silence', 500);
  await expectPill('shell', 'czeka', 'shell: done after the prompt is back', 6000);
  // A quick failing command: idle with its exit code.
  await typeInto(ids.shell, 'cmd /c exit 3');
  await key(ids.shell, '\r', 'Enter: cmd /c exit 3');
  await expectPill('shell', 'kod wyjścia 3', 'shell: exit code 3 shown', 5000);
  // Ctrl-C: back to the prompt, no failure.
  await typeInto(ids.shell, 'Start-Sleep 30');
  await key(ids.shell, '\r', 'Enter: Start-Sleep 30');
  await expectPill('shell', 'polecenie', 'shell: long command running', 3000);
  await sleep(1500);
  await key(ids.shell, '\x03', 'Ctrl+C');
  await until(`${pill(ids.shell)} === ''`, 'shell idle after Ctrl+C', 5000).then(() => note('OK     shell: idle after Ctrl+C'), () => failures.push('shell: not idle after Ctrl+C'));

  // Claude: a permission dialog is "needs you" at once, with the tool.
  await sleep(4000); // Claude started with the grid; by now it sits at its prompt
  note('----   claude ready');
  await sleep(1500);
  await typeInto(ids.claude, 'SCENARIO_TOOL remove it');
  await sleep(300);
  await key(ids.claude, '\r', 'Enter: SCENARIO_TOOL');
  await expectPill('claude', 'czeka na zgodę: Bash', 'claude: permission dialog shows "czeka na zgodę: Bash" within 2 s', 2000);
  await sleep(1000);
  await key(ids.claude, '\r', 'Enter (allow)');
  await expectPill('claude', 'czeka na Ciebie', 'claude: turn done after the tool ran', 15000);
  await sleep(1000);
  await typeInto(ids.claude, '/exit');
  await sleep(300);
  await key(ids.claude, '\r', 'Enter: /exit');
  await expectPill('claude', 'CLI zakończył', 'claude: /exit shows "CLI zakończył działanie"', 10000);
  await sleep(500);
  sampling = false;
  await sampler;
} catch (error) {
  failures.push(String(error?.stack ?? error));
} finally {
  try { ws?.close(); } catch { /* closed */ }
  killTree(child.pid);
  api.close();
  await sleep(1500);
  if (process.env.KEEP_SCRATCH) console.log(`scratch kept: ${root}`); else removeScratch(root);
}
console.log(timeline.join('\n'));
if (failures.length) {
  console.log(`\nFAILED:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else console.log('\nAll status checks passed.');
