// Records real status timelines: the installed Claude Code CLI (and plain shells) run in node-pty, Claude talks to a local
// mock of the Anthropic Messages API (nothing reaches the network or the real ~/.claude), its hooks post to the app's own
// HookServer, and every raw hook event is logged next to the status the app's StatusTracker derives from the same signals.
// Usage: ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/status-timeline.mjs [claude|shell|all] [scenario...]
// (Electron as Node: node-pty in node_modules is built for Electron's ABI.)
// Windows: the shells are PowerShell / cmd, and the "killed CLI" scenario uses Get-CimInstance.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const pty = require(resolve('node_modules/node-pty'));
const root = mkdtempSync(join(tmpdir(), 'unimux-status-'));
const out = join(root, 'harness.mjs');
await build({
  stdin: {
    contents: [
      "export { StatusTracker, isUserInput } from './src/shared/status';",
      "export { HookServer } from './src/main/hooks';",
      "export * as shellMarks from './src/shared/shellIntegration';",
    ].join('\n'),
    resolveDir: resolve('.'), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out, external: ['electron', 'node-pty'], logLevel: 'silent',
}).catch(async () => {
  // Before shell integration existed: build without it.
  await build({
    stdin: { contents: "export { StatusTracker, isUserInput } from './src/shared/status';\nexport { HookServer } from './src/main/hooks';", resolveDir: resolve('.'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: out, external: ['electron', 'node-pty'], logLevel: 'silent',
  });
});
const lib = await import(pathToFileURL(out).href);
const { StatusTracker, HookServer } = lib;
const marks = lib.shellMarks ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = process.argv[2] ?? 'all';
const only = new Set(process.argv.slice(3));

// ── mock Messages API ───────────────────────────────────────────────────────
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => b.text ?? '').join(' ') : '');
let agentSpawned = false;
function respond(request) {
  const messages = request.messages ?? [];
  const last = messages.at(-1);
  const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
  const firstUser = textOf(messages[0]?.content);
  const lastText = [...messages].reverse().map((m) => (m.role === 'user' ? textOf(m.content) : '')).find((t) => /SCENARIO_/.test(t)) ?? '';
  const tools = (request.tools ?? []).map((t) => t.name);
  if (!tools.length) return { blocks: [{ type: 'text', text: 'ok' }] };
  if (/SUBTASK_ONLY/.test(firstUser)) return { blocks: [{ type: 'text', text: 'subagent result' }], delayMs: 2500 };
  const scenario = /SCENARIO_(\w+)/.exec(lastText)?.[1] ?? 'HI';
  if (results.length) return { blocks: [{ type: 'text', text: `finished ${scenario}` }] };
  switch (scenario) {
    case 'TOOL': return { blocks: [{ type: 'tool_use', id: 'toolu_rm1', name: 'Bash', input: { command: 'rm -f nothing-here.txt', description: 'Remove a file' } }] };
    case 'READ': return { blocks: [{ type: 'tool_use', id: 'toolu_read1', name: 'Read', input: { file_path: join(root, 'project', 'a.txt') } }] };
    case 'ASK': return { blocks: [{ type: 'tool_use', id: 'toolu_ask1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }] }] } }] };
    case 'AGENT':
      // Once per scenario: the background subagent's result comes back as a new message with the same scenario text.
      if (agentSpawned) return { blocks: [{ type: 'text', text: 'agent result received' }] };
      agentSpawned = true;
      return { blocks: [{ type: 'tool_use', id: 'toolu_agent1', name: tools.includes('Agent') ? 'Agent' : 'Task', input: { description: 'sub', prompt: 'SUBTASK_ONLY reply', subagent_type: 'general-purpose' } }] };
    case 'FAIL': return { status: 400 };
    case 'SLOW': return { blocks: [{ type: 'text', text: 'slow '.repeat(40) }], chunkMs: 400 };
    case 'SILENT': return { blocks: [{ type: 'text', text: 'after a long silent wait' }], delayMs: 40_000 };
    default: return { blocks: [{ type: 'text', text: `hello ${scenario}` }] };
  }
}
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    let request = {};
    try { request = JSON.parse(body || '{}'); } catch { /* empty */ }
    const r = respond(request);
    if (r.status) {
      res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock: invalid request' } }));
      return;
    }
    if (r.delayMs) await sleep(r.delayMs);
    const blocks = r.blocks;
    const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const message = { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: request.model ?? 'mock', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!request.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...message, content: blocks, stop_reason: stop }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { ...message, content: [], stop_reason: null } });
    for (const [index, b] of blocks.entries()) {
      if (b.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        const words = r.chunkMs ? b.text.split(' ') : [b.text];
        for (const w of words) {
          if (res.destroyed) return;
          send('content_block_delta', { index, delta: { type: 'text_delta', text: r.chunkMs ? `${w} ` : w } });
          if (r.chunkMs) await sleep(r.chunkMs);
        }
      } else {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      send('content_block_stop', { index });
    }
    send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    send('message_stop', {});
    res.end();
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

// ── raw hook logger (every documented event) ─────────────────────────────────
const RAW_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure',
  'PostToolBatch', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'SessionEnd', 'Elicitation', 'ElicitationResult'];
let timeline = [];
let t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const logger = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(204).end();
    let p = {};
    try { p = JSON.parse(body); } catch { /* empty */ }
    const extra = [p.notification_type, p.tool_name, p.error, p.source, p.trigger, p.reason, p.agent_type, p.agent_id ? 'in-subagent' : '', p.is_interrupt ? 'interrupt' : ''].filter(Boolean).join(' ');
    timeline.push(`${stamp()}  hook  ${p.hook_event_name ?? req.url}${extra ? ` (${extra})` : ''}`);
  });
});
await new Promise((r) => logger.listen(0, '127.0.0.1', r));
const loggerUrl = `http://127.0.0.1:${logger.address().port}/raw`;

const hooks = new HookServer();
await hooks.start();

/** One terminal + tracker, wired like TerminalManager does it. */
function runTerminal({ cellId, file, args, env, cwd, agent, codex = false, command }) {
  const tracker = new StatusTracker();
  if (tracker.setCodex) tracker.setCodex(codex);
  if (tracker.setAgent) tracker.setAgent(agent);
  // As TerminalManager: in an agent cell a command after the CLI ended is judged by its output.
  if ('interactiveGuard' in tracker) tracker.interactiveGuard = () => agent;
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 32, cwd, env, useConpty: true, useConptyDll: true });
  let last = tracker.status;
  let lastDetail = '';
  let screen = '';
  const show = (why) => {
    const detail = tracker.detail ? JSON.stringify(tracker.detail) : '';
    if (tracker.status === last && detail === lastDetail) return;
    const reason = tracker.status === 'waiting' ? ` reason=${tracker.lastReason}${tracker.lastError ? `:${tracker.lastError}` : ''} cause=${tracker.lastCause}` : '';
    timeline.push(`${stamp()}  STATUS ${last} -> ${tracker.status}${reason}${detail ? ` detail=${detail}` : ''}  [${why}]`);
    last = tracker.status;
    lastDetail = detail;
  };
  let pending = command;
  const shellMarkRe = /\x1b\](?:133|633);([ABCD])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;
  p.onData((d) => {
    screen = (screen + d).slice(-20000);
    const now = performance.now();
    if (tracker.shellMark) {
      for (const m of d.matchAll(shellMarkRe)) {
        const mark = marks.parseShellMark(m[2] === undefined ? m[1] : `${m[1]};${m[2]}`);
        if (mark) tracker.shellMark(mark.kind, now, mark.code);
        timeline.push(`${stamp()}  osc   133;${m[1]}${m[2] ? `;${m[2]}` : ''}`);
        show(`osc133 ${m[1]}`);
      }
    }
    tracker.output(now);
    show('output');
    if (pending) {
      const c = pending;
      pending = undefined;
      setTimeout(() => p.write(`${c}\r`), 150);
    }
  });
  const onHook = (id, event, info) => {
    if (id !== cellId) return;
    tracker.hook(event, performance.now(), info);
    show(`hook ${event}${info?.tool ? `:${info.tool}` : ''}`);
  };
  const onSession = (id, source) => {
    if (id !== cellId) return;
    tracker.hook('session', performance.now(), { source });
    show('hook session');
  };
  hooks.on('hook', onHook);
  hooks.on('sessionstart', onSession);
  const timer = setInterval(() => { tracker.tick(performance.now()); show('tick'); }, 400);
  let exited = false;
  p.onExit(() => { exited = true; tracker.exited(); show('exit'); });
  return {
    tracker,
    screen: () => screen,
    /** Kills the agent CLI the shell started (a crash, as far as the cell can tell). */
    killCli() {
      timeline.push(`${stamp()}  ----  the CLI process is killed`);
      require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${p.pid}' | Where-Object Name -like 'claude*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
    },
    async type(text, label = text) {
      timeline.push(`${stamp()}  user  types ${JSON.stringify(label)}`);
      for (const ch of text) {
        tracker.input(performance.now(), false);
        p.write(ch);
        await sleep(15);
      }
      await sleep(250);
    },
    async key(data, label) {
      timeline.push(`${stamp()}  user  ${label}`);
      const now = performance.now();
      tracker.input(now, data.includes('\r'));
      if (data === '\x1b' || data === '\x03') tracker.interrupt(now);
      p.write(data);
      show(`input ${label}`);
    },
    async stop() {
      clearInterval(timer);
      hooks.off('hook', onHook);
      hooks.off('sessionstart', onSession);
      if (!exited) try { p.kill(); } catch { /* gone */ }
      for (let i = 0; i < 30 && !exited; i++) await sleep(100);
      p.removeAllListeners?.();
      await sleep(300);
    },
  };
}

const results = [];
function section(title) {
  timeline = [];
  agentSpawned = false;
  t0 = Date.now();
  return () => results.push(`### ${title}\n${timeline.join('\n')}\n`);
}

// ── Claude scenarios ────────────────────────────────────────────────────────
async function claudeScenarios() {
  const version = require('node:child_process').execFileSync('claude', ['--version'], { encoding: 'utf8', shell: true }).trim().split(' ')[0];
  const configDir = join(root, 'claude-config');
  const project = join(root, 'project');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'hello\n');
  const key = 'sk-ant-api03-mock-0000000000000000000000000000000000000000';
  const projectKey = project.replace(/\\/g, '/');
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: version, theme: 'dark', numStartups: 5,
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    projects: { [projectKey]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
  }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|ELECTRON_RUN_AS_NODE)/.test(k))),
    CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: apiUrl, ANTHROPIC_API_KEY: key, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', TERM: 'xterm-256color',
  };
  const scenarios = [
    { name: 'plain turn', steps: async (t) => { await t.type('SCENARIO_HI say hi', 'SCENARIO_HI'); await t.key('\r', 'Enter'); await sleep(8000); } },
    { name: 'read-only tool (no permission prompt)', steps: async (t) => { await t.type('SCENARIO_READ read a.txt', 'SCENARIO_READ'); await t.key('\r', 'Enter'); await sleep(9000); } },
    { name: 'permission prompt answered after 9 s', steps: async (t) => { await t.type('SCENARIO_TOOL remove it', 'SCENARIO_TOOL'); await t.key('\r', 'Enter'); await sleep(12000); await t.key('\r', 'Enter (allow)'); await sleep(8000); } },
    { name: 'permission prompt answered after 2 s', steps: async (t) => { await t.type('SCENARIO_TOOL remove it', 'SCENARIO_TOOL'); await t.key('\r', 'Enter'); await sleep(4000); await t.key('\r', 'Enter (allow)'); await sleep(8000); } },
    { name: 'permission prompt denied with Esc', steps: async (t) => { await t.type('SCENARIO_TOOL remove it', 'SCENARIO_TOOL'); await t.key('\r', 'Enter'); await sleep(5000); await t.key('\x1b', 'Esc (deny)'); await sleep(9000); } },
    { name: 'AskUserQuestion', steps: async (t) => { await t.type('SCENARIO_ASK pick', 'SCENARIO_ASK'); await t.key('\r', 'Enter'); await sleep(9000); await t.key('\r', 'Enter (option 1)'); await sleep(1500); await t.key('\r', 'Enter (submit)'); await sleep(8000); } },
    { name: 'subagent', steps: async (t) => { await t.type('SCENARIO_AGENT delegate', 'SCENARIO_AGENT'); await t.key('\r', 'Enter'); await sleep(16000); } },
    { name: 'API error (400)', steps: async (t) => { await t.type('SCENARIO_FAIL go', 'SCENARIO_FAIL'); await t.key('\r', 'Enter'); await sleep(10000); } },
    { name: 'Esc during a streaming answer', steps: async (t) => { await t.type('SCENARIO_SLOW talk', 'SCENARIO_SLOW'); await t.key('\r', 'Enter'); await sleep(4000); await t.key('\x1b', 'Esc'); await sleep(9000); } },
    { name: 'long silent model wait (40 s, spinner only)', steps: async (t) => { await t.type('SCENARIO_SILENT wait', 'SCENARIO_SILENT'); await t.key('\r', 'Enter'); await sleep(50000); } },
    { name: '/compact', steps: async (t) => { await t.type('SCENARIO_HI first', 'SCENARIO_HI'); await t.key('\r', 'Enter'); await sleep(7000); await t.type('/compact', '/compact'); await t.key('\r', 'Enter'); await sleep(15000); } },
    { name: 'killed CLI during a turn', steps: async (t) => { await t.type('SCENARIO_SILENT wait', 'SCENARIO_SILENT'); await t.key('\r', 'Enter'); await sleep(8000); t.killCli(); await sleep(6000); } },
    { name: 'Ctrl+C twice during a turn', steps: async (t) => { await t.type('SCENARIO_SLOW talk', 'SCENARIO_SLOW'); await t.key('\r', 'Enter'); await sleep(3000); await t.key('\x03', 'Ctrl+C'); await sleep(300); await t.key('\x03', 'Ctrl+C'); await sleep(8000); } },
    { name: '/exit (the CLI ends, the shell stays)', steps: async (t) => { await t.type('/exit', '/exit'); await t.key('\r', 'Enter'); await sleep(7000); } },
  ];
  for (const s of scenarios) {
    if (only.size && !only.has(s.name.split(' ')[0])) continue;
    const cellId = `c${results.length}`;
    const settingsPath = hooks.writeClaudeSettings(join(root, 'hooks'), cellId, version);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const ev of RAW_EVENTS) (settings.hooks[ev] ??= []).push({ hooks: [{ type: 'http', url: `${loggerUrl}/${ev}`, timeout: 5 }] });
    writeFileSync(settingsPath, JSON.stringify(settings));
    const done = section(`claude ${version}: ${s.name}`);
    const shell = shellSpawn('pwsh', env);
    const t = runTerminal({ cellId, ...shell, env: shell.env, cwd: project, agent: true, command: `claude --settings '${settingsPath}' --model claude-sonnet-4-5` });
    await sleep(9000); // shell, then Claude starting up
    timeline.push(`${stamp()}  ----  Claude ready`);
    await s.steps(t);
    if (process.env.SHOW_SCREEN) timeline.push(t.screen().replace(/\x1b\[[\d;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '').slice(-1500));
    await t.stop();
    done();
  }
}

/** The shell command line of a cell: with the app's shell integration when this build has it. */
function shellSpawn(kind, env) {
  const exe = kind === 'cmd' ? 'cmd.exe' : kind === 'powershell' ? 'powershell.exe' : 'pwsh.exe';
  const where = (name) => {
    try {
      return require('node:child_process').execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim();
    } catch {
      return '';
    }
  };
  const found = where(exe) || where('powershell.exe');
  const base = { file: found, args: kind === 'cmd' ? [] : ['-NoLogo'], env: { ...env } };
  if (!marks?.withShellIntegration) return base;
  const spec = marks.withShellIntegration(kind, base, { dir: join(root, 'shell-integration'), platform: process.platform });
  return { file: spec.file, args: spec.args, env: spec.env };
}

// ── shell scenarios ─────────────────────────────────────────────────────────
async function shellScenarios() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const cases = [
    ['pwsh', 'quick command', [['Get-Date', 3000]]],
    ['pwsh', 'silent 8 s command', [['Start-Sleep 8', 11000]]],
    ['pwsh', 'chatty 6 s command', [['1..6 | % { "tick $_"; Start-Sleep 1 }', 9000]]],
    ['pwsh', 'Ctrl+C during a long command', [['Start-Sleep 30', 3000], ['\x03', 4000]]],
    ['pwsh', 'failing native command after 4 s', [['Start-Sleep 4; cmd /c exit 3', 7000]]],
    ['cmd', 'cmd: silent 6 s command', [['ping -n 7 127.0.0.1 >nul', 9000]]],
    ['powershell', 'Windows PowerShell 5: silent 6 s command', [['Start-Sleep 6', 9000]]],
  ];
  for (const [kind, name, steps] of cases) {
    if (only.size && !only.has(name.split(' ')[0])) continue;
    const done = section(`${kind}: ${name}`);
    const shell = shellSpawn(kind, env);
    const t = runTerminal({ cellId: `s${results.length}`, ...shell, cwd: root, agent: false });
    await sleep(5000);
    timeline.push(`${stamp()}  ----  shell ready`);
    for (const [cmd, wait] of steps) {
      if (cmd === '\x03') await t.key('\x03', 'Ctrl+C');
      else { await t.type(cmd); await t.key('\r', 'Enter'); }
      await sleep(wait);
    }
    await t.stop();
    done();
  }
}

try {
  if (mode === 'claude' || mode === 'all') await claudeScenarios();
  if (mode === 'shell' || mode === 'all') await shellScenarios();
  // Electron as Node may lose piped stdout at process.exit: TIMELINE_OUT writes the result to a file instead.
  if (process.env.TIMELINE_OUT) writeFileSync(process.env.TIMELINE_OUT, results.join('\n'));
  else console.log(results.join('\n'));
} catch (error) {
  writeFileSync(process.env.TIMELINE_OUT ?? join(tmpdir(), 'status-timeline-error.txt'), String(error?.stack ?? error));
} finally {
  hooks.stop();
  api.close();
  logger.close();
  await sleep(300);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exit(0);
}
