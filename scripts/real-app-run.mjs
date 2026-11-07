// Runs every real-app script (PLAN X1) against one target and sorts each into pass / blocked by <package> / fail / skip.
// Each script runs in its own Node process with MC_REAL_APP_REPORT (scripts/real-app.mjs writes its result there); a script
// that hangs is stopped after its timeout with a tree kill of that Node process (its app goes with it).
//
//   npm run build:check && node scripts/real-app-run.mjs [--only=a,b] [--skip=a,b] [--write-progress] [--target=electron]
//
// --write-progress  replaces the "Real-app scripts" table of docs/tauri/PROGRESS.md (between the X1 markers) with this run.
// Results: artifacts/real-app/<target>.json. Exit code 1 when a script failed (blocked ones do not fail the run: their
// package has not landed; the list shrinks as packages land). A script is blocked only by what it exercised itself, not by
// the boot-time not-yet calls of every launch (real-app.mjs, classifyRun): the runner takes that startup baseline once first.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_TARGET, ROOT, isTauri, requireBuild, startupBaselineSync } from './real-app.mjs';
import { SCRIPT_PACKAGES, classifyRun, formatBlocked } from './real-app-owners.mjs';

const W = process.platform === 'win32';
/**
 * Every script X1 moved to the harness. `args`: what a quick full run uses (scratch outputs, short benchmarks); `only`: the
 * target it applies to; `ci`: runs only in a CI release step; `missing()`: why it cannot run here (skip); `timeout` in minutes
 * (default 10).
 */
export const SCRIPTS = [
  // the release gates (scripts/release.mjs runs these two)
  { file: 'verify-cli-contract.mjs', gate: true },
  { file: 'verify-team-start.mjs', gate: true },
  // verify-*.mjs (verify-workspace-ui.mjs is a module: capture-readme.mjs --verify runs it)
  ...['accounts-ui', 'agent-close', 'agent-prompt', 'auto-switch-ui', 'conv-export', 'conv-search', 'db-core', 'db-mysql-ui', 'db-pg-ui',
    'db-redis-ui', 'db-redis', 'db-sqlite-ui', 'dead-login-ui', 'detach-db', 'first-login-ui', 'git-layout', 'grid-tabs', 'grid-templates',
    'layout-ui', 'limits-ui', 'mcp-app', 'mcp-cli', 'mcp-team', 'notify-actions', 'prompt-queue', 'safety-ui', 'sftp-edit', 'sftp-path',
    'sftp-ui', 'sidebar-anchor', 'ssh-bar', 'ssh-paths', 'ssh-ui', 'start-screen', 'status-ui', 'team-panel', 'team-stuck', 'tree-ui',
    'update-wait', 'waiting-ui'].map((name) => ({ file: `verify-${name}.mjs` })),
  { file: 'verify-tauri-normalize.mjs', only: 'tauri' },
  // the acceptance checks of the wave 1 packages (Tauri only: most compare with 1.1.4 or the TS reference themselves)
  ...['tauri-convsearch', 'tauri-detached', 'tauri-files', 'tauri-hooks', 'tauri-lifecycle', 'tauri-os', 'tauri-search', 'tauri-w3'].map((name) => ({ file: `verify-${name}.mjs`, only: 'tauri' })),
  { file: 'verify-cli-detect.mjs', only: 'tauri', missing: () => (existsSync(join(ROOT, 'out', 'main', 'index.js')) ? null : 'the Electron build (npm run build) is its 1.1.4 reference') },
  { file: 'verify-safestorage.mjs', only: 'tauri', windowsOnly: true },
  // W1: the caption buttons against 1.1.4's references (OS capture and hit tests through the wincap example).
  { file: 'verify-caption.mjs', only: 'tauri', windowsOnly: true, timeout: 20, missing: () => (existsSync(join(ROOT, 'src-tauri', 'target', 'release', 'examples', 'wincap.exe')) ? null : 'the wincap tool (cd src-tauri && node ../scripts/msvc-run.mjs cargo build -p unimux-platform --example wincap --release)') },
  { file: 'verify-update-window.mjs', only: 'tauri', windowsOnly: true, timeout: 20 },
  { file: 'verify-release-build.mjs', ci: 'release.yml checks the CI run of a tag (RELEASE_TAG, BUILD_RUN_ID)' },
  // the other real-app scripts
  { file: 'smoke-tauri.mjs', only: 'tauri' },
  // Electron: the packaged app of `npm run dist:win` (a local check build only, never published); skipped without it.
  { file: 'smoke-start.mjs', windowsOnly: true, missing: () => (!isTauri && !existsSync(join(ROOT, 'release', 'win-unpacked', 'unimux.exe')) ? 'no packaged Electron app (npm run dist:win)' : null) },
  { file: 'smoke-automation.mjs' },
  { file: 'capture-readme.mjs', args: (scratch) => [join(scratch, 'shots'), '--verify'], timeout: 15 },
  { file: 'measure-startup.mjs', args: () => ['1'] },
  { file: 'perf-latency.mjs', args: () => ['20'] },
  { file: 'bench-jank.mjs', args: () => ['--reps=1'], timeout: 20, windowsOnly: true },
  { file: 'perf-grid.mjs', args: () => ['x1', '8'], windowsOnly: true },
  { file: 'perf-hidden.mjs', args: () => ['x1'], timeout: 15, windowsOnly: true },
  { file: 'perf-profile.mjs', args: () => ['x1'] },
];

const opt = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = opt('only')?.split(',');
const skip = opt('skip')?.split(',') ?? [];
const pick = (s) => { const n = s.file.replace(/\.mjs$/, ''); return (!only || only.some((o) => n === o || n === `verify-${o}`)) && !skip.some((o) => n === o || n === `verify-${o}`); };

function killTree(pid) {
  try { if (W) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
}

/** Runs one script; resolves to {result, code, ms, blocked, tail}. */
function runOne(script) {
  return new Promise((resolve) => {
    const scratch = mkdtempSync(join(tmpdir(), 'unimux-x1-run-'));
    const report = join(scratch, 'report.json');
    const logs = join(scratch, 'not-yet');
    const args = [join('scripts', script.file), ...(script.args?.(scratch) ?? [])];
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, MC_APP_TARGET: APP_TARGET, MC_REAL_APP_REPORT: report, MC_REAL_APP_LOG_DIR: logs }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !W });
    let out = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
    child.stderr.on('data', (d) => { out = (out + d).slice(-20000); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; out += `\n[runner] timeout after ${script.timeout ?? 10} min`; killTree(child.pid); }, (script.timeout ?? 10) * 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let r = null;
      try { r = JSON.parse(readFileSync(report, 'utf8')); } catch { /* the script ended before writing it */ }
      // Stopped at the timeout: its own exit report never came, its not-yet logs are still here (sorted like the script would).
      if (!r && timedOut) {
        const seen = new Set();
        try { for (const f of readdirSync(logs)) for (const l of readFileSync(join(logs, f), 'utf8').split('\n')) if (l.trim()) seen.add(l.trim()); } catch { /* none */ }
        if (seen.size) r = classifyRun({ code: null, notYet: [...seen], baseline: startupBaselineSync(), packages: SCRIPT_PACKAGES[script.file] ?? [] });
      }
      try { rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* still held */ }
      const skipped = /^SKIP/m.test(out) || /\bskip(ped)?: Windows only/i.test(out);
      const result = code === 0 ? (skipped ? 'skip' : 'pass') : (code === 2 || timedOut) && r?.result === 'blocked' ? 'blocked' : 'fail';
      const tail = out.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-6).join('\n');
      resolve({ result, code, ms: Date.now() - started, blocked: r?.blocked ?? [], seen: r?.seen ?? [], tail });
    });
  });
}

if (process.argv[1]?.endsWith('real-app-run.mjs')) {
  requireBuild();
  // Once, before the first script: no script pays for the bare launch, and every one is judged against the same set.
  if (isTauri) {
    const baseline = startupBaselineSync();
    console.log(baseline ? `startup baseline (not-yet calls of a bare launch): ${baseline.join(', ') || 'none'}` : 'startup baseline: not available (failures with not-yet calls stay failures)');
  }
  const outDir = join(ROOT, 'artifacts', 'real-app');
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const script of SCRIPTS.filter(pick)) {
    let r;
    if (script.only && script.only !== APP_TARGET) r = { result: 'skip', why: `${script.only} target only` };
    else if (script.ci && !process.env.RELEASE_TAG) r = { result: 'skip', why: `CI only: ${script.ci}` };
    else if (script.windowsOnly && !W) r = { result: 'skip', why: 'Windows only' };
    else if (script.missing?.()) r = { result: 'skip', why: script.missing() };
    else r = await runOne(script);
    results.push({ file: script.file, gate: !!script.gate, ...r });
    const owners = r.blocked?.map((g) => g.owner).join(', ');
    console.log(`${r.result.toUpperCase().padEnd(8)} ${script.file.padEnd(28)} ${r.ms ? `${Math.round(r.ms / 1000)} s` : ''} ${r.result === 'blocked' ? `by ${owners}` : r.why ?? ''}`);
    if (r.result === 'fail') {
      console.log(r.tail.replace(/^/gm, '         | '));
      if (r.seen?.length) console.log(`         not-yet seen (not the cause): ${formatBlocked(r.seen)}`);
    }
  }
  const at = new Date().toISOString();
  // --only / --skip re-runs part of the list: the other scripts keep their result of the last full run.
  if (only || skip.length) {
    let previous = [];
    try { previous = JSON.parse(readFileSync(join(outDir, `${APP_TARGET}.json`), 'utf8')).results; } catch { /* no earlier run */ }
    const fresh = new Map(results.map((r) => [r.file, r]));
    const merged = SCRIPTS.map((s) => fresh.get(s.file) ?? previous.find((p) => p.file === s.file)).filter(Boolean);
    results.splice(0, results.length, ...merged);
  }
  writeFileSync(join(outDir, `${APP_TARGET}.json`), JSON.stringify({ at, target: APP_TARGET, results }, null, 1));
  const count = (k) => results.filter((r) => r.result === k).length;
  console.log(`\n${APP_TARGET}: ${count('pass')} pass, ${count('blocked')} blocked, ${count('fail')} fail, ${count('skip')} skip`);
  // Which package unblocks how many scripts.
  const byOwner = new Map();
  for (const r of results.filter((x) => x.result === 'blocked')) for (const g of r.blocked) byOwner.set(g.owner, (byOwner.get(g.owner) ?? 0) + 1);
  if (byOwner.size) console.log(`blocking packages: ${[...byOwner.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} ${n}`).join(', ')}`);
  if (process.argv.includes('--write-progress')) writeProgress(results, at);
  process.exitCode = count('fail') ? 1 : 0;
}

/** The table between the X1 markers of PROGRESS.md: one row per script with its result on this run. */
function writeProgress(results, at) {
  const file = join(ROOT, 'docs', 'tauri', 'PROGRESS.md');
  const text = readFileSync(file, 'utf8');
  const start = `<!-- X1 real-app status (${APP_TARGET}) start -->`;
  const end = `<!-- X1 real-app status (${APP_TARGET}) end -->`;
  const rows = results.map((r) => {
    const detail = r.result === 'blocked' ? r.blocked.map((g) => `${g.owner} (${g.commands.join(', ')})`).join('; ')
      : r.result === 'fail' ? `${r.tail.split('\n').filter((l) => !/^(info:|BLOCKED)/.test(l)).at(-1)?.replace(/\|/g, '/').slice(0, 160) ?? ''}${r.seen?.length ? ` (not-yet seen: ${r.seen.map((g) => g.owner).join(', ')})` : ''}` : r.why ?? '';
    return `| ${r.file}${r.gate ? ' (release gate)' : ''} | ${r.result} | ${r.result === 'blocked' ? r.blocked.map((g) => g.owner).join(', ') : ''} | ${detail} |`;
  });
  const table = [start, `Run: ${at.slice(0, 16).replace('T', ' ')} UTC, target ${APP_TARGET}${isTauri ? ' (check build)' : ''}, \`node scripts/real-app-run.mjs --write-progress${isTauri ? '' : ' --target=electron'}\`.`, '',
    '| script | result | blocked by | detail |', '|---|---|---|---|', ...rows, end].join('\n');
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`PROGRESS.md has no ${start} ... ${end} markers`);
  writeFileSync(file, text.slice(0, a) + table + text.slice(b + end.length));
  console.log(`PROGRESS.md: ${results.length} rows written`);
}

export { runOne };
