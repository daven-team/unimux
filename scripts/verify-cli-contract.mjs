// Release check of the command-line contract unimux relies on (run before a release, next to verify-mcp-cli.mjs). It reads
// `claude --help` and `codex --help` of the installed CLIs and fails when a flag unimux passes disappeared or changed its
// arity: a flag that became variadic swallows the prompt after it (1.1.3: `--mcp-config <configs...>` took the task for a
// config file). Then it asks Codex how it understands the very -c overrides a Codex cell gets (`codex mcp get unimux --json`).
// Scratch CLAUDE_CONFIG_DIR and CODEX_HOME: nothing reads or writes the user's ~/.claude or ~/.codex, no model is called.
// The line comes from the app under test: the Tauri check build (`unimux --launch-line`, P4; npm run build:check), or with
// MC_APP_TARGET=electron the TS reference (src/shared/profiles.ts). A release gate (scripts/release.mjs).
// Usage: node scripts/verify-cli-contract.mjs   (a CLI that is not installed is skipped with a note)
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { APP_TARGET, BlockedError, appBinary, isTauri } from './real-app.mjs';

const root = mkdtempSync(join(tmpdir(), 'unimux-cli-contract-'));
const run = (file, args, env) => new Promise((done) => {
  const child = execFile(file, args, { timeout: 60000, windowsHide: true, maxBuffer: 8 << 20, shell: process.platform === 'win32', env: { ...process.env, ...env } },
    (error, stdout, stderr) => done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  child.stdin?.end();
});
const failures = [];
const warnings = [];
const report = [];

/**
 * The arity a help text gives a flag: 'none' (a switch), 'one' (<value> or [value]) or 'many' (<values...>); null when absent.
 * Matches the option column of commander (claude) and clap (codex) help output, with or without a short alias.
 */
function arity(help, flag) {
  const line = help.split(/\r?\n/).find((l) => new RegExp(`^\\s{0,6}(?:-\\w,\\s*)?${flag.replace(/[-]/g, '\\-')}(?:[\\s,=]|$)`).test(l));
  if (!line) return null;
  const rest = line.slice(line.indexOf(flag) + flag.length).trim().split(/\s{2,}/)[0];
  if (/^[<[][^>\]]*\.\.\.[>\]]/.test(rest)) return 'many';
  if (/^[<[]/.test(rest)) return 'one';
  return 'none';
}
function expectFlags(cli, help, expected) {
  for (const [flag, want] of Object.entries(expected)) {
    const got = arity(help, flag);
    if (got === null) failures.push(`${cli}: ${flag} is gone from --help (unimux passes it)`);
    else if (got !== want) failures.push(`${cli}: ${flag} takes ${got} value(s) now, unimux expects ${want}`);
    else report.push(`${cli} ${flag}: ${got}`);
  }
}

/**
 * The launch line of a cell as the app under test builds it: the Tauri check build answers `--launch-line` (P4 ports the
 * builder; until then it says MC_NOT_YET and this check is blocked by P4), the Electron target uses the TS reference.
 */
function launchLine(profile, opts, reference) {
  if (!isTauri) return reference(profile, opts);
  let out;
  try {
    out = execFileSync(appBinary(), ['--launch-line', JSON.stringify({ profile, opts })], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { out = String(error.stdout ?? ''); }
  let answer;
  try { answer = JSON.parse(out.trim().split(/\r?\n/).at(-1)); } catch { failures.push(`--launch-line did not answer JSON: ${out.slice(0, 300)}`); return null; }
  if (answer.error === 'MC_NOT_YET') {
    new BlockedError(answer.owner ?? 'P4', 'launch-line');
    failures.push(`codex: the launch line of the ${APP_TARGET} build is not available yet (${answer.owner ?? 'P4'})`);
    return null;
  }
  if (typeof answer.line !== 'string') { failures.push(`--launch-line: ${out.slice(0, 300)}`); return null; }
  return answer.line;
}

try {
  const out = join(root, 'profiles.mjs');
  await build({ stdin: { contents: "export { buildCliCommand, MCP_TOOL_TIMEOUT_SEC } from './src/shared/profiles';", resolveDir: resolve('.'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  const { buildCliCommand, MCP_TOOL_TIMEOUT_SEC } = await import(pathToFileURL(out).href);

  const claudeEnv = { CLAUDE_CONFIG_DIR: join(root, 'claude'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const claude = await run('claude', ['--help'], claudeEnv);
  if (claude.code !== 0) report.push('claude: not installed, skipped');
  else {
    report.push(`claude ${(await run('claude', ['--version'], claudeEnv)).stdout.trim()}`);
    // --mcp-config is variadic since 2.1.3xx; unimux puts the prompt first because of it (profiles.ts).
    expectFlags('claude', claude.stdout, { '--session-id': 'one', '--resume': 'one', '--settings': 'one', '--mcp-config': 'many', '--append-system-prompt': 'one', '--model': 'one' });
  }

  const codexHome = join(root, 'codex');
  mkdirSync(codexHome);
  const codexEnv = { CODEX_HOME: codexHome, UNIMUX_MCP_TOKEN: 'contract-check' };
  const codex = await run('codex', ['--help'], codexEnv);
  if (codex.code !== 0) report.push('codex: not installed, skipped');
  else {
    report.push((await run('codex', ['--version'], codexEnv)).stdout.trim());
    expectFlags('codex', codex.stdout, { '--config': 'one', '--model': 'one' });
    if (!/^\s*-c, --config/m.test(codex.stdout)) failures.push('codex: -c is no longer the short form of --config');
    const resumeHelp = await run('codex', ['resume', '--help'], codexEnv);
    if (resumeHelp.code !== 0 || !/\[SESSION_ID\]/.test(resumeHelp.stdout)) failures.push('codex: `codex resume [SESSION_ID]` changed or is gone');
    else report.push('codex resume [SESSION_ID]: ok');
    if (resumeHelp.code === 0 && !/^\s*-c, --config/m.test(resumeHelp.stdout)) failures.push('codex resume: no -c, --config any more');

    // The overrides exactly as a Codex cell gets them (bash quoting, split back into arguments).
    const url = 'http://127.0.0.1:65000/mcp';
    const line = launchLine({ id: 'codex', name: 'Codex', cli: 'codex', args: '' }, { mode: 'new', shell: 'bash', mcp: { url, tokenEnv: 'UNIMUX_MCP_TOKEN' } }, buildCliCommand);
    const words = line === null ? [] : [...line.matchAll(/'((?:[^']|'"'"')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/'"'"'/g, "'") : m[2])).slice(1);
    const overrides = [];
    for (let i = 0; i < words.length; i++) if (words[i] === '-c' && words[i + 1]?.startsWith('mcp_servers.')) overrides.push('-c', words[++i]);
    const get = line === null ? null : await run('codex', [...overrides, 'mcp', 'get', 'unimux', '--json'], codexEnv);
    let server;
    if (get) try { server = JSON.parse(get.stdout.slice(get.stdout.indexOf('{'))); } catch { failures.push(`codex mcp get unimux --json did not answer JSON: ${(get.stdout + get.stderr).trim().slice(0, 300)}`); }
    if (server) {
      const text = JSON.stringify(server);
      if (!text.includes(url)) failures.push(`codex mcp get: url not taken from -c (${text.slice(0, 300)})`);
      if (!text.includes('UNIMUX_MCP_TOKEN')) failures.push(`codex mcp get: bearer_token_env_var not taken from -c (${text.slice(0, 300)})`);
      if (!new RegExp(`"tool_timeout_sec":\\s*${MCP_TOOL_TIMEOUT_SEC}(\\.0)?\\b`).test(text)) warnings.push(`codex mcp get: tool_timeout_sec ${MCP_TOOL_TIMEOUT_SEC} not shown (${text.slice(0, 300)})`);
      report.push(`codex mcp get unimux --json: ${text.slice(0, 200)}`);
    }
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(report.join('\n'));
for (const warning of warnings) console.warn(`WARNING: ${warning}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else console.log('CLI contract check passed.');
