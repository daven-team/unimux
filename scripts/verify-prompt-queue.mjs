// Real-app check of the 1.0.9 prompt queue (npm run build first). A scratch data dir and home, MC_OFFSCREEN=1 and
// MC_DEBUG_PORT (default 9407). One Claude cell (the installed CLI, talking to a local mock of the Messages API, never the
// network) starts with four queued prompts saved in its state: the queue must come up paused after the launch, send its
// prompts one per finished turn (a multi-line one intact), pause on a permission dialog, take a prompt added, edited and
// reordered in its panel, and pause when the user types into the terminal. Screenshots go to SHOTS (default a temp dir).
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electron from 'electron';
import { removeScratch, scrubAppEnv } from './app-env.mjs';
import { killTree, sleep } from './ssh-ui-lib.mjs';

const port = Number(process.env.MC_DEBUG_PORT ?? 9407);
const shots = process.env.SHOTS ?? join(tmpdir(), 'unimux-queue-shots');
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join('D:\\Projekty', '_tmp-queue-ui-'));
const home = join(root, 'home');
const project = join(root, 'project');
const configDir = join(root, 'claude-config');
for (const dir of [join(root, 'data'), project, configDir, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true });

// ── mock Messages API: SCENARIO_TOOL asks for Bash, anything else answers with text; the QUEUE_ markers are logged in order ──
const received = [];
const prompts = new Map();
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
    for (const m of messages) {
      if (m.role !== 'user') continue;
      const text = textOf(m.content);
      for (const [marker] of text.matchAll(/QUEUE_[A-Z]+/g)) if (!prompts.has(marker)) { prompts.set(marker, text); received.push(marker); }
    }
    const last = messages.at(-1);
    const hasResult = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');
    const asked = /SCENARIO_TOOL/.test(textOf(last?.content));
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
const apiKey = 'sk-ant-api03-mock-0000000000000000000000000000000000000000';
writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, lastOnboardingVersion: version, theme: 'dark', numStartups: 5,
  customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
  projects: { [project.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
}));

const cellId = randomUUID();
const projectId = randomUUID();
const tabId = randomUUID();
const MULTI = 'QUEUE_TWO line one of the second prompt\nline two of the second prompt';
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, settings: { language: 'pl', shell: 'pwsh' }, activeProjectId: projectId,
  profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '--permission-mode default --model claude-sonnet-4-5', color: '#d97757' }, { id: 'shell', name: 'PowerShell', cli: 'shell', args: '', color: '#7a7a7a' }],
  projects: [{ id: projectId, name: 'Queue', path: project, color: '#3b82f6', archive: [], activeTabId: tabId, tabs: [
    { id: tabId, name: 'Main', layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] },
      cells: [{ id: cellId, profileId: 'claude', name: 'Claude', promptQueue: { items: [
        { id: 'q1', text: 'QUEUE_ONE say done' },
        { id: 'q2', text: MULTI },
        { id: 'q3', text: 'SCENARIO_TOOL QUEUE_THREE remove it' },
        { id: 'q4', text: 'QUEUE_FOUR after the permission' },
      ] } }] },
  ] }],
}));

const env = {
  ...scrubAppEnv({ ...process.env }), MC_DATA_DIR: join(root, 'data'), MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port),
  USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`, ANTHROPIC_API_KEY: apiKey,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
};
const child = spawn(electron, ['.'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

const log = [];
const failures = [];
const t0 = Date.now();
const note = (line) => log.push(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}  ${line}`);
const check = (ok, label, detail = '') => { note(`${ok ? 'OK  ' : 'FAIL'}   ${label}${ok || !detail ? '' : `: ${detail}`}`); if (!ok) failures.push(`${label} ${detail}`); };
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
  const until = async (expression, ms = 30000) => {
    const start = Date.now();
    while (Date.now() - start < ms) { if (await evaluate(expression).catch(() => false)) return true; await sleep(150); }
    return false;
  };
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 780, deviceScaleFactor: 1, mobile: false });
  const shot = async (name) => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    const file = join(shots, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    note(`shot   ${file}`);
  };
  const cell = `document.querySelector('[data-cell-id="${cellId}"]')`;
  const bar = `(${cell}?.querySelector('.queue-bar')?.textContent ?? '')`;
  const pill = `(${cell}?.querySelector('.status-text')?.textContent ?? '')`;
  const click = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
  const focusTerm = () => evaluate(`${cell}.querySelector('.xterm-helper-textarea').focus(), true`);
  const enter = async () => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); };
  const items = () => evaluate(`[...document.querySelectorAll('.queue-panel .queue-text')].map((el) => el.textContent)`);

  await until(`!!${cell}?.querySelector('.xterm-helper-textarea')`);
  check(await until(`/Kolejka 4/.test(${bar}) && /wstrzymana po ponownym uruchomieniu/.test(${bar})`, 10000), 'after the launch the saved queue is shown paused', await evaluate(bar));
  await sleep(10000); // Claude starts and sits at its prompt
  await shot('1-paused-after-restart');
  check(received.length === 0, 'nothing was sent while paused', received.join(','));

  // Resume: no turn has ended in this run yet, so nothing goes by itself; "send next now" starts the chain.
  await click(`[data-cell-id="${cellId}"] .queue-bar [aria-label="Wznów kolejkę"]`);
  check(await until(`/czeka na koniec tury/.test(${bar})`, 3000), 'resumed queue waits for a turn end', await evaluate(bar));
  await click(`[data-cell-id="${cellId}"] .queue-bar [aria-label="Wyślij następny teraz"]`);
  check(await until(`/Kolejka 3/.test(${bar})`, 3000), 'send now takes the first prompt off the queue', await evaluate(bar));
  const sawCountdown = await until(`/wysyłanie za/.test(${bar})`, 30000);
  check(sawCountdown, 'after the turn ends the next prompt counts down', await evaluate(bar));
  if (sawCountdown) await shot('2-countdown');
  check(await until(`/Kolejka 1/.test(${bar}) && /agent czeka na zgodę/.test(${bar})`, 45000), 'the permission prompt pauses the queue', `${await evaluate(bar)} | pill ${await evaluate(pill)}`);
  await shot('3-paused-permission');
  check(JSON.stringify(received) === JSON.stringify(['QUEUE_ONE', 'QUEUE_TWO', 'QUEUE_THREE']), 'prompts arrived one per turn, in order', received.join(','));
  check(prompts.get('QUEUE_TWO')?.includes(MULTI), 'the multi-line prompt arrived intact', JSON.stringify(prompts.get('QUEUE_TWO')?.slice(0, 200)));

  // Allow the tool; the queue stays paused after the turn ends.
  await focusTerm();
  await sleep(500);
  await enter();
  check(await until(`/czeka na Ciebie/.test(${pill})`, 20000), 'turn done after the permission', await evaluate(pill));
  await sleep(4000);
  check(!received.includes('QUEUE_FOUR'), 'a paused queue sends nothing after the turn end');

  // The shortcut opens the panel with the add field focused; add, edit, reorder.
  await focusTerm();
  for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'D', code: 'KeyD', windowsVirtualKeyCode: 68, modifiers: 2 | 8 });
  check(await until(`document.activeElement?.closest('.queue-compose') !== null && !!document.activeElement?.closest('.queue-compose')`, 3000), 'Ctrl+Shift+D opens the panel with the add field focused');
  await cdp('Input.insertText', { text: 'QUEUE_FIVE added in the panel' });
  await enter();
  check(await until(`document.querySelectorAll('.queue-panel .queue-item').length === 2`, 3000), 'Enter adds the prompt', JSON.stringify(await items()));
  // Edit the new one: click its text, replace it.
  await evaluate(`[...document.querySelectorAll('.queue-panel .queue-text')][1].click(), true`);
  await until(`!!document.querySelector('.queue-panel .queue-edit')`, 2000);
  await evaluate(`document.querySelector('.queue-panel .queue-edit').select(), true`);
  await cdp('Input.insertText', { text: 'QUEUE_FIVE edited in the panel' });
  await enter();
  check(await until(`[...document.querySelectorAll('.queue-panel .queue-text')].some((el) => el.textContent === 'QUEUE_FIVE edited in the panel')`, 2000), 'a prompt is edited in place', JSON.stringify(await items()));
  // Drag the second prompt above the first.
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.queue-panel .queue-item')];
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(rows[1], 'dragstart'); fire(rows[0], 'dragover'); fire(rows[0], 'drop'); fire(rows[1], 'dragend');
    return true;
  })()`);
  check(await until(`document.querySelector('.queue-panel .queue-text')?.textContent === 'QUEUE_FIVE edited in the panel'`, 2000), 'dragging reorders the queue', JSON.stringify(await items()));
  await shot('4-panel');

  // Resume from the panel: the agent is idle at its prompt, so the two prompts go out one per turn.
  await evaluate(`[...document.querySelectorAll('.queue-panel .queue-panel-foot button')].find((b) => b.textContent === 'Wznów kolejkę').click(), true`);
  check(await until(`${JSON.stringify(received)}.length >= 0 && document.querySelectorAll('.queue-panel .queue-item').length === 0`, 60000), 'the resumed queue empties');
  await until(`false`, 3000);
  check(JSON.stringify(received.slice(3)) === JSON.stringify(['QUEUE_FIVE', 'QUEUE_FOUR']), 'the reordered prompts arrived in the new order', received.join(','));
  check(prompts.get('QUEUE_FIVE')?.includes('QUEUE_FIVE edited in the panel'), 'the edited text was sent', JSON.stringify(prompts.get('QUEUE_FIVE')?.slice(0, 120)));
  check(await until(`/czeka na Ciebie/.test(${pill})`, 20000), 'the last turn ended', await evaluate(pill));

  // Typing into the prompt line after a turn end: a prompt added now must not be sent over the user's text.
  await focusTerm();
  await cdp('Input.insertText', { text: 'half typed' });
  await sleep(500);
  await evaluate(`document.querySelector('.queue-compose textarea')?.focus(), true`);
  if (!(await evaluate(`!!document.querySelector('.queue-compose textarea')`))) {
    await focusTerm();
    for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'D', code: 'KeyD', windowsVirtualKeyCode: 68, modifiers: 2 | 8 });
    await until(`!!document.querySelector('.queue-compose textarea')`, 2000);
    await evaluate(`document.querySelector('.queue-compose textarea').focus(), true`);
  }
  await cdp('Input.insertText', { text: 'QUEUE_SIX must wait' });
  await enter();
  check(await until(`/wpisujesz coś w terminalu/.test(${bar})`, 3000), 'typing in the terminal pauses the queue', await evaluate(bar));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await sleep(400);
  await shot('5-paused-typing');
  check(!received.includes('QUEUE_SIX'), 'nothing was sent over the typed text');
} catch (error) {
  failures.push(String(error?.stack ?? error));
} finally {
  try { ws?.close(); } catch { /* closed */ }
  killTree(child.pid);
  api.close();
  await sleep(1500);
  if (process.env.KEEP_SCRATCH) console.log(`scratch kept: ${root}`); else removeScratch(root);
}
console.log(log.join('\n'));
console.log(`received: ${received.join(', ')}`);
if (failures.length) {
  console.log(`\nFAILED:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else console.log('\nAll prompt queue checks passed.');
