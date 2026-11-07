// Startup timing of the built app (0.9.4): launches the Tauri check build (MC_APP_TARGET=electron: `out/`) several times with a scratch data dir and home (2 projects, a 2x2
// grid of plain shells) and prints the marks of startup.log (ms since process start) with their medians.
// Usage: npm run build:check && node scripts/measure-startup.mjs [runs=5]
// Never touches the user's data dir or home; kills only the PIDs it started; deletes its scratch dirs.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { killTree, sleep } from './ssh-ui-lib.mjs';
import { spawnApp } from './real-app.mjs';

const runs = Number(process.argv[2]) || 5;
// Electron and Tauri marks (startup.log of either build); a mark one of them does not write is left out.
const SHOWN = ['modules-loaded', 'instance-lock', 'state-loaded', 'app-ready', 'window-created', 'ready-to-show', 'renderer-boot', 'first-spawn', 'first-output'];

function writeScratchState(root) {
  const projects = [0, 1].map((n) => {
    const path = join(root, `project-${n}`);
    mkdirSync(path, { recursive: true });
    const cells = [0, 1, 2, 3].map(() => ({ id: randomUUID(), profileId: 'shell' }));
    const tab = { id: randomUUID(), name: 'Grid', color: '#60a5fa', layout: { cols: 2, rows: 2, areas: [0, 1, 2, 3].map((i) => ({ col: i % 2, row: Math.floor(i / 2), colSpan: 1, rowSpan: 1 })) }, cells };
    return { id: randomUUID(), name: `startup-${n}`, path, color: '#3b82f6', tabs: [tab], archive: [], activeTabId: tab.id };
  });
  mkdirSync(join(root, 'data'), { recursive: true });
  const shell = process.platform === 'win32' ? 'cmd' : 'bash';
  writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({ version: 1, settings: { language: 'en', shell }, activeProjectId: projects[0].id, projects }));
}

async function launchOnce() {
  const root = mkdtempSync(join('D:\\Projekty', '_tmp-094start-'));
  writeScratchState(root);
  const { env: homeEnv } = scratchHome(root);
  const env = { ...scrubAppEnv({ ...process.env }), ...homeEnv, MC_DATA_DIR: join(root, 'data'), MC_OFFSCREEN: '1', MC_DEBUG_PORT: '0' };
  const child = spawnApp({ cwd: process.cwd(), env, stdio: 'ignore' });
  const log = join(root, 'data', 'startup.log');
  let line = '';
  try {
    for (let i = 0; i < 200 && !/first-output=/.test(line); i++) {
      await sleep(100);
      if (existsSync(log)) line = readFileSync(log, 'utf8').trim().split('\n').at(-1) ?? '';
    }
  } finally {
    killTree(child.pid);
    await sleep(1000);
    removeScratch(root);
  }
  if (!/first-output=/.test(line)) throw new Error(`no first output in startup.log: ${line}`);
  return Object.fromEntries([...line.matchAll(/([a-z-]+)=(\d+)/g)].map((m) => [m[1], Number(m[2])]));
}

const median = (values) => { const v = [...values].sort((a, b) => a - b); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
const results = [];
await launchOnce(); // warm-up (disk cache), not counted
for (let i = 0; i < runs; i++) {
  const marks = await launchOnce();
  results.push(marks);
  console.log(`run ${i + 1}: ${Object.entries(marks).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
console.log('\nmedian (ms since process start):');
for (const name of SHOWN) {
  const values = results.map((r) => r[name]).filter((v) => v !== undefined);
  if (values.length) console.log(`  ${name.padEnd(16)} ${median(values)}`);
}
