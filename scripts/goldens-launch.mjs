// The launch line part of the golden corpus (1.2.0, PLAN P4), used by scripts/dump-goldens.mjs:
//
//   test/golden/launch.jsonl  {fn, args, out} of src/shared/profiles.ts (buildCliCommand, buildLaunchCommand; `{error}` where
//                             they throw), src/shared/termReset.ts (withResetTail), src/shared/delegation.ts (shellSafeText,
//                             coordinatorSystemRules over normalizeDelegation), src/shared/teamPrompts.ts (startupTaskPrompt,
//                             resumeTaskPrompt, readyStartupTasks as ids), src/shared/shellIntegration.ts
//                             (withShellIntegration, encodePowerShell), src/main/mcpCellConfig.ts (claudeMcpConfig) and the
//                             top-level developer_instructions check of index.ts `userCodexInstructions` (its two regexes,
//                             copied here because index.ts does not export it).
//
// Checked by src-tauri/crates/unimux-agents/src/launch/tests.rs and src-tauri/crates/unimux-pty/tests/launch_goldens.rs.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rng } from './goldens-normalize.mjs';

export const LAUNCH_MODULES = {
  profiles: 'src/shared/profiles.ts',
  termReset: 'src/shared/termReset.ts',
  delegation: 'src/shared/delegation.ts',
  teamPrompts: 'src/shared/teamPrompts.ts',
  shellIntegration: 'src/shared/shellIntegration.ts',
  mcpCellConfig: 'src/main/mcpCellConfig.ts',
};

const SHELLS = [undefined, 'pwsh', 'powershell', 'cmd', 'bash', 'zsh'];
const ARGS = ['', '--model opus --verbose', "-m 'gpt 5' --x", '--model="a b" -y', ' --model=x', '--modelx y', '\u00a0-m  z', '--model "unclosed x', '-mfoo --model\tsonnet', '  --dangerously-skip-permissions  '];
const MODELS = [undefined, '', 'opus', 'gpt-5.1-codex', 'claude-opus-4-5[1m]', 'a b', '-bad', 'x'.repeat(128), 'x'.repeat(129), 'org/model:tag_1.2'];
const PATHS = ['C:\\Users\\me\\AppData\\Roaming\\unimux\\hooks\\claude-c1.json', "/Users/O'Brien/Library/unimux/hooks/claude-c1.json", 'D:\\a b\\"q".json'];
const NOTIFY = [undefined, '', 'http://127.0.0.1:51234/h/0123456789abcdef0123456789abcdef/cell-1/codex/89abcdef01234567', 'http://127.0.0.1:1/h/0123/x/codex/89abcdef'];
const EXIT = [undefined, '', 'http://127.0.0.1:51234/x/cell-1/0123456789abcdef', 'http://127.0.0.1:51234/x/cell 1/0123456789abcdef', 'http://127.0.0.1:51234/x/c/0123456789ABCDEF', 'http://127.0.0.1:123456/x/c/0123456789abcdef'];
const PROMPTS = [
  undefined,
  { file: 'C:\\data\\prompts\\c1-1.txt', text: 'Fix the "bug"\nin\tmain.ts  now' },
  { file: "/tmp/it's/c1-2.txt", text: '   ' },
  { file: '/tmp/p.txt', text: 'zadanie: popraw błąd & sprawdź 100% testów | <ok> \u00a0 koniec' },
];
const SYSTEMS = [undefined, '', 'Use at most 4 agents. Don\'t "wait" & do 100% | $HOME `x` \\ ok!', 'plain words only'];
const MCPS = [undefined, { url: 'http://127.0.0.1:43210/mcp', claudeConfigPath: 'C:\\data\\mcp\\c1.json' }, { url: 'http://127.0.0.1:43210/mcp', tokenEnv: 'UNIMUX_MCP_TOKEN' }];
const SESSIONS = [undefined, '', '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f'];

function launchRows(m, next) {
  const rows = [];
  const pick = (list) => list[Math.floor(next() * list.length)];
  const call = (fn, args) => {
    try {
      return m.profiles[fn](...args);
    } catch (error) {
      return { error: error.message };
    }
  };
  for (let i = 0; i < 1400; i++) {
    const cli = pick(['claude', 'claude', 'codex', 'codex', 'shell']);
    const profile = { id: cli, name: cli, cli, args: pick(ARGS), color: '#000' };
    const opts = { mode: pick(['new', 'resume']) };
    const set = (key, value) => { if (value !== undefined) opts[key] = value; };
    set('shell', pick(SHELLS));
    set('sessionId', pick(SESSIONS));
    if (next() < 0.5) set('model', pick(MODELS));
    if (next() < 0.5) set('claudeSettingsPath', pick(PATHS));
    if (next() < 0.4) set('codexNotifyUrl', pick(NOTIFY));
    if (next() < 0.5) set('mcp', pick(MCPS));
    if (next() < 0.5) set('initialPrompt', pick(PROMPTS));
    if (next() < 0.4) set('resumePrompt', pick(PROMPTS));
    if (next() < 0.4) set('systemPrompt', pick(SYSTEMS));
    if (next() < 0.5) set('exitUrl', pick(EXIT));
    const fn = i % 2 ? 'buildLaunchCommand' : 'buildCliCommand';
    rows.push({ fn, args: [profile, opts], out: call(fn, [profile, opts]) });
  }
  for (const shell of SHELLS)
    for (const exit of EXIT)
      for (const cli of ['claude --resume x', "codex -c 'a=b'", 'cmd /c "x"'])
        rows.push({ fn: 'withResetTail', args: [cli, shell ?? null, exit ?? null], out: m.termReset.withResetTail(cli, shell, exit) });
  return rows;
}

function teamRows(m) {
  const t = (id, cellId, status, extra = {}) => ({ id, projectId: 'p', cellId, title: `Title ${id}`, prompt: `Prompt of ${id}\nline 2`, status, delivery: 'pending', createdAt: 1, updatedAt: 1, ...extra });
  const sets = [
    [],
    [t('t1', 'c1', 'queued')],
    [t('t1', 'c1', 'queued'), t('t2', 'c1', 'queued', { dependsOn: ['t9'] }), t('t9', 'c2', 'completed')],
    [t('t1', 'c1', 'queued', { dependsOn: ['t3'] }), t('t3', 'c2', 'in_progress')],
    [t('t1', 'c1', 'in_progress'), t('t2', 'c1', 'queued', { delivery: 'native' }), t('t3', 'c1', 'blocked')],
    [t('t1', 'c1', 'in_progress')],
    [t('t1', 'c2', 'queued', { fromCellId: 'c1' }), t('t2', 'c3', 'completed', { fromCellId: 'c1' }), t('t3', 'c1', 'queued', { fromCellId: 'c1' }), t('t4', 'c4', 'blocked', { fromCellId: 'c1' })],
    [t('t1', 'c1', 'queued'), t('t2', 'c1', 'queued'), t('t3', 'c1', 'cancelled')],
  ];
  const fallbacks = [undefined, '', '   ', 'Build the login page.', '  [Unimux task t1] copy', '\n Plain with spaces \n'];
  const rows = [];
  for (const tasks of sets)
    for (const role of ['coordinator', 'worker']) {
      for (const fallback of fallbacks)
        rows.push({ fn: 'startupTaskPrompt', args: [tasks, 'c1', role, fallback ?? null], out: m.teamPrompts.startupTaskPrompt(tasks, 'c1', role, fallback) ?? null });
      rows.push({ fn: 'resumeTaskPrompt', args: [tasks, 'c1', role], out: m.teamPrompts.resumeTaskPrompt(tasks, 'c1', role) ?? null });
      if (role === 'worker') rows.push({ fn: 'readyStartupTasks', args: [tasks, 'c1'], out: m.teamPrompts.readyStartupTasks(tasks, 'c1').map((x) => x.id) });
    }
  return rows;
}

function miscRows(m) {
  const rows = [];
  for (const text of ['', '  a  b  ', 'a"b\'c`d%e^f!g&h|i<j>k\r\nl\tm$n\\o', '"""x"""', 'ok words', ' \u00a0x\u00a0 ']) rows.push({ fn: 'shellSafeText', args: [text], out: m.delegation.shellSafeText(text) });
  for (const d of [undefined, null, {}, { mode: 'ask' }, { mode: 'auto', maxAgents: 7 }, { maxAgents: '12' }, { maxAgents: 99 }, { maxAgents: 0.4 }, { mode: 'x', maxAgents: 'abc' }, []])
    rows.push({ fn: 'coordinatorSystemRules', args: [d ?? null], out: m.delegation.coordinatorSystemRules(m.delegation.normalizeDelegation(d)) });
  for (const s of ['', 'a', 'Ab', 'abc', 'zażółć', '\u{1F600}', m.shellIntegration.POWERSHELL_SCRIPT]) rows.push({ fn: 'encodePowerShell', args: [s], out: m.shellIntegration.encodePowerShell(s) });
  const launches = [
    ['pwsh', { file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'], env: { A: '1' } }],
    ['powershell', { file: 'powershell.exe', args: ['-NoLogo'], env: { UNIMUX_SHELL_INTEGRATION: '0' } }],
    ['cmd', { file: 'cmd.exe', args: [], env: { PROMPT: '$T$G', B: '2' } }],
    ['cmd', { file: 'cmd.exe', args: [], env: { PROMPT: '  ' } }],
    ['cmd', { file: 'cmd.exe', args: [], env: { Z: 'z' } }],
    ['bash', { file: '/bin/bash', args: ['-il'], env: {} }],
    ['bash', { file: '/usr/local/bin/fish', args: ['-il'], env: {} }],
    ['zsh', { file: '/bin/zsh', args: ['-il'], env: {} }],
  ];
  for (const [kind, launch] of launches)
    for (const platform of ['win32', 'darwin', 'linux'])
      for (const dir of ['/tmp/unimux-shell-501', '/tmp/x//', 'C:\\Temp\\unimux-shell-user\\'])
        rows.push({ fn: 'withShellIntegration', args: [kind, launch, { dir, platform }], out: m.shellIntegration.withShellIntegration(kind, launch, { dir, platform }) });
  for (const [url, token] of [['http://127.0.0.1:43210/mcp', 'ab'.repeat(32)], ['http://127.0.0.1:1/mcp', 'x"y']]) rows.push({ fn: 'claudeMcpConfig', args: [url, token], out: m.mcpCellConfig.claudeMcpConfig(url, token) });
  // index.ts userCodexInstructions, the part after the file read.
  const codexTop = (text) => /^\s*developer_instructions\s*=/m.test(text.split(/^\s*\[/m)[0]);
  for (const text of ['', 'developer_instructions = "x"', 'model = "o3"\n  developer_instructions="x"', '[profile]\ndeveloper_instructions = "x"', 'a=1\n\n  [t]\ndeveloper_instructions=1',
    'developer_instructions_x = 1', '# developer_instructions = 1', 'x = 1\r\ndeveloper_instructions\t=\t"y"\r\n[t]', '\n\n[t]\n', 'a = [1]\ndeveloper_instructions = 2', 'developer_instructions'])
    rows.push({ fn: 'userCodexInstructions', args: [text], out: codexTop(text) });
  return rows;
}

export function launchGoldens(modules) {
  const next = rng(0x9e4);
  return [...launchRows(modules, next), ...teamRows(modules), ...miscRows(modules)];
}

// `node scripts/goldens-launch.mjs`: writes only test/golden/launch.jsonl (dump-goldens writes it with the rest).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { runnerImport } = await import('vite');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
  const modules = Object.fromEntries(await Promise.all(Object.entries(LAUNCH_MODULES).map(async ([name, file]) => [name, await load(file)])));
  const rows = launchGoldens(modules);
  writeFileSync(resolve(root, 'test/golden/launch.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  console.log(`wrote ${rows.length} rows to test/golden/launch.jsonl`);
}
