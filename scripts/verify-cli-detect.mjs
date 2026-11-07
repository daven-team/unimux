// H3 acceptance (PLAN.md): the Rust CLI detector finds the same Claude Code / Codex binaries, versions and sources as the
// 1.1.4 TypeScript detector on this machine, and the Tauri app answers `cli:status` / `cli:recheck` like the Electron app.
//
//   npm run build && npm run build:check && node scripts/verify-cli-detect.mjs [--machine-only]
//
// 1. machine: the TS CliDetector (src/main/cliDetect.ts + cliSystem.ts, run here under Node) and the Rust one
//    (crates/unimux-agents/examples/cli_detect.rs) with the real home and PATH: read-only lookups plus `<cli> --version`, with a
//    scratch CLAUDE_CONFIG_DIR / CODEX_HOME and an empty PowerShell probe profile (the user's profile is never run).
//    On Windows also a noisy probe profile (over 256 KB on stderr before it puts the Claude Code directory on PATH) with a
//    scratch home, a system-only PATH and no registry: both detectors must find Claude Code through the shell probe.
// 2. apps: the Electron build of this tree (1.1.4 code) and the Tauri check build, each offscreen on a scratch data dir and a
//    scratch home with the same environment; the startup scan, `cli:status` and a timed `cli:recheck` are compared.
//    No window is shown (MC_OFFSCREEN), only processes this script started are ended.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const machineOnly = process.argv.includes('--machine-only');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const CLIS = ['claude', 'codex'];
const ROUNDS = 5;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pick = (s) => (s ? { state: s.state, path: s.path, version: s.version, source: s.source, reason: s.reason } : null);
const same = (a, b) => JSON.stringify(pick(a)) === JSON.stringify(pick(b));
const show = (s) => (s ? `${s.state}${s.source ? `/${s.source}` : ''} ${s.path ?? ''} ${s.version ?? ''}${s.reason ? ` (${s.reason})` : ''}`.trim() : 'none');

const scratch = mkdtempSync(join(tmpdir(), 'unimux-h3-'));
const profile = join(scratch, 'probe-profile.ps1');
writeFileSync(profile, '# empty test profile (H3)\n');
const loginEnv = { CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'), CODEX_HOME: join(scratch, 'codex-home') };
for (const dir of Object.values(loginEnv)) mkdirSync(dir, { recursive: true });

const children = [];
try {
  // ── 1. this machine: TS reference vs Rust ──────────────────────────────────
  const msvc = join(root, 'scripts', 'msvc-run.mjs');
  execFileSync(process.execPath, [msvc, 'cargo', 'build', '-q', '-p', 'unimux-agents', '--example', 'cli_detect'], { cwd: join(root, 'src-tauri'), stdio: 'inherit' });
  const example = join(root, 'src-tauri', 'target', 'debug', 'examples', process.platform === 'win32' ? 'cli_detect.exe' : 'cli_detect');
  const machineEnv = { ...process.env, ...loginEnv, MC_CLI_PROBE_PROFILE: profile };
  delete machineEnv.CLAUDE_CODE_OAUTH_TOKEN;
  delete machineEnv.ANTHROPIC_API_KEY;
  const shellKind = process.platform === 'win32' ? 'powershell' : process.platform === 'darwin' ? 'zsh' : 'bash';

  const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
  const [{ CliDetector }, { systemCliDeps }] = await Promise.all([load('src/main/cliDetect.ts'), load('src/main/cliSystem.ts')]);
  // systemCliDeps reads process.env: give it the same environment as the Rust run.
  const savedEnv = { ...process.env };
  Object.assign(process.env, loginEnv);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  const runTs = async () => {
    const detector = new CliDetector(systemCliDeps({ shell: () => shellKind, probeProfile: profile }));
    const t = performance.now();
    const map = await detector.refreshAll();
    return { ms: Math.round(performance.now() - t), map };
  };
  const runRust = () => JSON.parse(execFileSync(example, [shellKind], { env: machineEnv, encoding: 'utf8', windowsHide: true }));
  // Interleaved rounds (the machine may be busy; the first --version of a big binary is slower while it is not cached).
  const ts = [];
  const rust = [];
  for (let i = 0; i < ROUNDS; i++) {
    ts.push(await runTs());
    rust.push(runRust());
  }
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const cli of CLIS) {
    const a = ts.at(-1).map[cli];
    const b = rust.at(-1).map[cli];
    console.log(`  ${cli}: 1.1.4 ${show(a)} | 1.2.0 ${show(b)}`);
    check(`machine: ${cli} detected like 1.1.4 (state, path, version, source, reason)`, a && same(a, b));
    check(`machine: ${cli} found with a version`, b?.state === 'found' && !!b.version);
    check(`machine: ${cli} the same in every round`, rust.every((r) => same(r.map[cli], b)) && ts.every((r) => same(r.map[cli], a)));
  }
  // A noisy probe profile (H3 review): more than the 256 KB output limit on stderr before the profile puts the Claude Code
  // directory on PATH. 1.1.4 ignored the probe's stderr and found the CLI through the shell; the port must not end the probe.
  // Scratch home, a system-only PATH and no registry, so the shell probe is the only way to the CLI. Windows (probe profile).
  const claudeDir = ts.at(-1).map.claude?.path ? dirname(ts.at(-1).map.claude.path) : null;
  if (process.platform === 'win32' && claudeDir) {
    const noisyHome = join(scratch, 'noisy-home');
    const noisyEnv = { USERPROFILE: noisyHome, HOME: noisyHome, APPDATA: join(noisyHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(noisyHome, 'AppData', 'Local') };
    for (const dir of Object.values(noisyEnv)) mkdirSync(dir, { recursive: true });
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    noisyEnv.Path = [join(sysRoot, 'system32'), sysRoot, join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
    noisyEnv.MC_CLI_NO_REGISTRY = '1';
    const noisyProfile = join(scratch, 'noisy-profile.ps1');
    writeFileSync(noisyProfile, `[Console]::Error.Write(('x' * 300000))\n$env:Path = "${claudeDir};" + $env:Path\n`);
    const pathKeys = Object.keys(process.env).filter((k) => k.toUpperCase() === 'PATH');
    for (const k of pathKeys) delete process.env[k];
    Object.assign(process.env, loginEnv, noisyEnv);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    const tsNoisy = (await new CliDetector(systemCliDeps({ shell: () => shellKind, probeProfile: noisyProfile, disableRegistry: true })).refreshAll());
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    const rustEnv = { ...machineEnv, ...noisyEnv, MC_CLI_PROBE_PROFILE: noisyProfile };
    for (const k of Object.keys(rustEnv)) if (k.toUpperCase() === 'PATH' && k !== 'Path') delete rustEnv[k];
    const rustNoisy = JSON.parse(execFileSync(example, [shellKind], { env: rustEnv, encoding: 'utf8', windowsHide: true })).map;
    for (const cli of CLIS) {
      console.log(`  noisy profile ${cli}: 1.1.4 ${show(tsNoisy[cli])} | 1.2.0 ${show(rustNoisy[cli])}`);
      check(`machine: noisy probe profile, ${cli} detected like 1.1.4`, same(tsNoisy[cli], rustNoisy[cli]));
    }
    check('machine: noisy probe profile, claude found through the shell', rustNoisy.claude?.state === 'found' && rustNoisy.claude.source === 'shell', show(rustNoisy.claude));
  }
  const tsMs = median(ts.map((r) => r.ms));
  const rustMs = median(rust.map((r) => r.ms));
  console.log(`  detection of both CLIs: 1.1.4 ${ts.map((r) => r.ms).join(' ')} (median ${tsMs}) ms, 1.2.0 ${rust.map((r) => r.ms).join(' ')} (median ${rustMs}) ms`);
  check('machine: Rust detection of both CLIs within 2 s (median)', rustMs <= 2000, `${rustMs} ms`);

  if (!machineOnly) {
    // ── 2. the two apps on the same scratch environment ──────────────────────
    const appEnv = { ...loginEnv, MC_CLI_PROBE_PROFILE: profile };
    const state = JSON.stringify({ version: 1, projects: [], activeProjectId: null, settings: { language: 'pl', fontSize: 13, shell: shellKind } });
    const electronPath = createRequire(import.meta.url)('electron');

    const runApp = async (kind) => {
      const dir = join(scratch, kind);
      const dataDir = join(dir, 'data');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'state.json'), state);
      const port = await freePort();
      let child;
      if (kind === 'tauri') child = launchApp({ dataDir, scratch: dir, port, extraEnv: appEnv });
      else {
        const { env: homeEnv } = scratchHome(dir);
        const env = { ...scrubAppEnv({ ...process.env, ...homeEnv, MC_DATA_DIR: dataDir, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port) }), ...appEnv };
        child = spawn(electronPath, [root], { env, stdio: 'ignore', windowsHide: true });
      }
      children.push(child);
      const launched = performance.now();
      const page = kind === 'tauri' ? await connectPage(port, { timeoutMs: 60000 }) : await connectElectron(port);
      await waitFor(page, "typeof window.mc?.on === 'function'", 30000, 'window.mc');
      const reachable = Math.round(performance.now() - launched);
      // Listen for the startup scan's broadcast while it may still run.
      await page.evaluate(`(() => { window.__h3 = []; window.mc.on('cli:changed', (m) => window.__h3.push(m)); return true; })()`);
      let startup = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const map = await page.evaluate('window.mc.cliStatus()').catch(() => null);
        if (map && CLIS.every((c) => map[c])) { startup = { map, ms: Math.round(performance.now() - launched) }; break; }
        await sleep(50);
      }
      const rechecks = [];
      for (let i = 0; i < ROUNDS; i++) {
        rechecks.push(await page.evaluate(`(async () => { const t = performance.now(); const map = await window.mc.cliRecheck(); return { map, ms: Math.round(performance.now() - t) }; })()`));
      }
      const recheck = { map: rechecks.at(-1).map, ms: median(rechecks.map((r) => r.ms)), all: rechecks.map((r) => r.ms) };
      const single = await page.evaluate(`window.mc.cliRecheck('codex').then((m) => Object.keys(m))`);
      const refused = await page.evaluate(`window.mc.cliRecheck('shell').then(() => 'resolved', (e) => String(e && e.message || e))`);
      const events = await page.evaluate('window.__h3.length');
      page.close();
      killTree(child);
      await waitExit(child, 10000);
      return { reachable, startup, recheck, single, refused, events };
    };

    const electron = await runApp('electron');
    const tauri = await runApp('tauri');
    for (const cli of CLIS) {
      console.log(`  ${cli}: Electron ${show(electron.recheck.map[cli])} | Tauri ${show(tauri.recheck.map[cli])}`);
      check(`apps: ${cli} startup scan equal`, electron.startup && tauri.startup && same(electron.startup.map[cli], tauri.startup.map[cli]));
      check(`apps: ${cli} cli:recheck equal`, same(electron.recheck.map[cli], tauri.recheck.map[cli]));
    }
    console.log(`  page reachable: Electron ${electron.reachable} ms, Tauri ${tauri.reachable} ms; both CLIs in cli:status: Electron ${electron.startup?.ms} ms, Tauri ${tauri.startup?.ms} ms after launch`);
    console.log(`  cli:recheck: Electron ${electron.recheck.all.join(' ')} (median ${electron.recheck.ms}) ms, Tauri ${tauri.recheck.all.join(' ')} (median ${tauri.recheck.ms}) ms; cli:changed events seen: Electron ${electron.events}, Tauri ${tauri.events}`);
    check('apps: Tauri cli:recheck within 2 s (median)', tauri.recheck.ms <= 2000, `${tauri.recheck.ms} ms`);
    check('apps: a one-CLI recheck answers the whole map like 1.1.4', JSON.stringify(electron.single) === JSON.stringify(tauri.single), JSON.stringify(tauri.single));
    check('apps: an unknown CLI id is refused', /Unknown CLI/.test(tauri.refused) && /Unknown CLI/.test(electron.refused), tauri.refused);
    check('apps: cli:changed reached the page (startup scan) when it was still running', tauri.events >= 1 || tauri.startup.ms - tauri.reachable < 100, `${tauri.events} event(s)`);
  }
} finally {
  for (const c of children) killTree(c);
}

async function connectElectron(port) {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((t) => t.type === 'page' && t.url.startsWith('file:') && t.url.includes('index.html') && !t.url.includes('detached='));
      if (target) return await connectPage(port, { timeoutMs: 1000, match: target.id });
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('no Electron page');
    await sleep(100);
  }
}

const bad = results.filter((r) => !r.ok);
removeScratch(scratch);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
