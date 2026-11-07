// The startup baseline of the Tauri check build (PLAN X1): the not-yet commands a bare launch calls (one project, no tab,
// no cell, UI in Polish) from the start until it quits. real-app.mjs keeps a failed script "blocked" only by not-yet
// commands outside this set (or of a package the script tests, SCRIPT_PACKAGES), so the boot-time calls of the UI
// (cli:status, usage:get, update:get ...) no longer hide a real regression as "blocked".
//
// Cached in artifacts/real-app/baseline-tauri.json per binary (path, size, mtime): real-app-run.mjs takes it once before its
// sweep, real-app.mjs takes it on demand (only when a script failed with not-yet calls). Scratch data dir and home only;
// ends only the process tree it started.
//
//   node scripts/real-app-baseline.mjs           prints the baseline (from the cache when it is current)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBinary, connectPage, freePort, killTree, launchApp, sleep, waitExit, waitFor } from './tauri-app.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_FILE = join(ROOT, 'artifacts', 'real-app', 'baseline-tauri.json');

/** What the cache is valid for: the binary under test as it is on disk now. */
function binaryKey() {
  const binary = appBinary();
  const s = statSync(binary);
  return { binary: resolve(binary), size: s.size, mtimeMs: s.mtimeMs };
}

/** The cached baseline of the current binary, or null. */
export function cachedBaseline() {
  try {
    const cached = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    const key = binaryKey();
    return cached.binary === key.binary && cached.size === key.size && cached.mtimeMs === key.mtimeMs ? cached.commands : null;
  } catch {
    return null;
  }
}

async function measure() {
  const key = binaryKey();
  const scratch = mkdtempSync(join(tmpdir(), 'unimux-x1-baseline-'));
  const dataDir = join(scratch, 'data');
  const project = join(scratch, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const projectId = 'baseline-project';
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, settings: { language: 'pl' }, sshHosts: [], activeProjectId: projectId,
    projects: [{ id: projectId, name: 'baseline', path: project, color: '#3b82f6', tabs: [], archive: [], activeTabId: null }] }));
  const log = join(scratch, 'not-yet.log');
  const port = await freePort();
  const child = launchApp({ dataDir, scratch, port, extraEnv: { MC_NOT_YET_LOG: log } });
  try {
    const page = await connectPage(port, { timeoutMs: 45000 });
    await waitFor(page, `!!document.querySelector('.app .workspace-tabs')`, 45000, 'app ready');
    // The calls the UI makes right after it is up (first polls, deferred checks).
    await sleep(5000);
    await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
    page.close?.();
    if ((await waitExit(child, 10000)) === null) killTree(child);
  } finally {
    killTree(child);
    await waitExit(child, 10000);
  }
  const commands = existsSync(log) ? [...new Set(readFileSync(log, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))] : [];
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a webview still holds a file */ }
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(BASELINE_FILE, JSON.stringify({ ...key, at: new Date().toISOString(), commands }, null, 1));
  return commands;
}

/** The baseline of the current binary: the cache, or a fresh bare launch. */
export async function startupBaseline() {
  return cachedBaseline() ?? measure();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commands = await startupBaseline();
  console.log(JSON.stringify(commands));
}
