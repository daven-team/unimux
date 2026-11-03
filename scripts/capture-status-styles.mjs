// TEMPORARY (1.1.2 review of the status indicators): starts the built app once per design (MC_STATUS_STYLE=a|b|c) with
// scripted claude stand-ins (no model, no network) in every status - working, a permission, a question, a failed turn, a
// finished turn, a clean exit, a failed exit, idle - and writes one comparison image per design: the whole window at 100 %,
// the tab strip, the project row, the icon corners and the header statuses scaled up 3x (nearest neighbour) at 100 % and
// 150 %, and three frames of the working marks. Usage: node scripts/capture-status-styles.mjs <out dir> [a,b,c]
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import electron from 'electron';
import { removeScratch, scrubAppEnv } from './app-env.mjs';
import { killTree, sleep } from './ssh-ui-lib.mjs';

const checkout = process.cwd();
if (!existsSync(join(checkout, 'out/main/index.js'))) throw new Error('Build first: npm run build');
const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'status-styles'));
mkdirSync(outDir, { recursive: true });
const styles = (process.argv[3] ?? 'a,b,c').split(',');
const names = { a: 'SVG marks', b: 'plain dots', c: 'squares, activity bars, outlined chip' };
const port = Number(process.env.MC_DEBUG_PORT ?? 9431);

const sid = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const ids = { work: 's-work', perm: 's-perm', ask: 's-ask', fail: 's-fail', done: 's-done', clean: 's-clean', bad: 's-bad', idle: 's-idle', bg: 's-bg' };
const sessions = { work: sid(1), perm: sid(2), ask: sid(3), fail: sid(4), done: sid(5), bg: sid(6) };
const screens = {
  [sessions.work]: { title: 'Editing src/catalog/filter.ts', hooks: [['prompt', {}], ['pre', { tool_name: 'Edit', tool_use_id: 'toolu_e1', tool_input: { file_path: 'src/catalog/filter.ts' } }]] },
  [sessions.perm]: { title: 'Bash(rm -rf build)  Do you want to run this command?', hooks: [['prompt', {}], ['permission', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }]] },
  [sessions.ask]: { title: 'Which database should the tests use?', hooks: [['prompt', {}], ['pre', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_ask1', tool_input: {} }]] },
  [sessions.fail]: { title: 'API Error: rate limit', hooks: [['prompt', {}], ['fail', { error: 'rate_limit' }]] },
  [sessions.done]: { title: 'Done: the catalog filter is in place.', hooks: [['prompt', {}], ['stop', {}]] },
  [sessions.bg]: { title: 'Thinking...', hooks: [['prompt', {}]] },
};

function setup(root) {
  const home = join(root, 'home'), data = join(root, 'data'), project = join(root, 'atlas'), bin = join(home, '.local', 'bin');
  for (const dir of [data, project, bin, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, 'demo-sessions.json'), JSON.stringify(screens));
  writeFileSync(join(bin, 'demo-agent.mjs'), `import { readFileSync } from 'node:fs';
const [cli, ...args] = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.120 (Claude Code)'); process.exit(0); }
const screens = JSON.parse(readFileSync(new URL('./demo-sessions.json', import.meta.url), 'utf8'));
const after = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const id = after('--resume') ?? after('--session-id');
const screen = screens[id] ?? { title: 'claude (demo)', hooks: [] };
process.stdout.write('\\u001b[2J\\u001b[H' + screen.title + '\\r\\n');
const settingsAt = args.indexOf('--settings');
const hooks = settingsAt >= 0 ? JSON.parse(readFileSync(args[settingsAt + 1].replace(/^["']|["']$/g, ''), 'utf8')).hooks ?? {} : {};
const names = { prompt: 'UserPromptSubmit', pre: 'PreToolUse', permission: 'PermissionRequest', stop: 'Stop', fail: 'StopFailure' };
const post = async (list) => {
  for (const [event, body] of list) {
    const hook = hooks[names[event]]?.[0]?.hooks?.[0];
    const url = hook?.url ?? hook?.args?.find((a) => /^http/.test(a));
    if (url) await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(hook.headers ?? {}) }, body: JSON.stringify({ hook_event_name: names[event], session_id: id, ...body }) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
  }
};
setTimeout(() => void post(screen.hooks), 1500);
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`);
  if (process.platform === 'win32') writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0demo-agent.mjs" claude %*\r\n`);
  else { writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/demo-agent.mjs" claude "$@"\n`); chmodSync(join(bin, 'claude'), 0o755); }
  const area = (col, row) => ({ col, row, colSpan: 1, rowSpan: 1 });
  const grid4 = { cols: 2, rows: 2, areas: [area(0, 0), area(1, 0), area(0, 1), area(1, 1)] };
  const claude = (key, name) => ({ id: ids[key], profileId: 'claude', name, session: { cli: 'claude', id: sessions[key], confirmed: true } });
  const shell = (key, name) => ({ id: ids[key], profileId: 'shell', name });
  writeFileSync(join(data, 'state.json'), JSON.stringify({
    version: 1, activeProjectId: 'p-atlas',
    profiles: [{ id: 'claude', name: 'Claude Code', cli: 'claude', args: '', color: '#d97757' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
    projects: [
      { id: 'p-atlas', name: 'Atlas', path: project, color: '#3b82f6', archive: [], activeTabId: 't-a', tabs: [
        { id: 't-a', name: 'Agenci', layout: grid4, cells: [claude('work', 'Filtr katalogu'), claude('perm', 'Porządki'), claude('ask', 'Testy'), claude('fail', 'Recenzent')] },
        { id: 't-b', name: 'Wyniki', layout: grid4, cells: [claude('done', 'Katalog'), shell('clean', 'Build'), shell('bad', 'Migracja'), shell('idle', 'Konsola')] },
        { id: 't-c', name: 'Tło', layout: { cols: 1, rows: 1, areas: [area(0, 0)] }, cells: [claude('bg', 'Dokumentacja')] },
      ] },
      { id: 'p-north', name: 'Northwind', path: project, color: '#a855f7', archive: [], activeTabId: 't-n', tabs: [{ id: 't-n', name: 'Main', layout: { cols: 1, rows: 1, areas: [area(0, 0)] }, cells: [] }] },
    ],
    settings: { language: 'pl', shell: process.platform === 'win32' ? 'cmd' : 'bash', backgroundLoad: 'all', lastProfileId: 'claude', alerts: { enabled: false } },
  }));
  return { home, data, bin };
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const cdp = (method, params = {}) => new Promise((r, j) => { const id = ++next; pending.set(id, (m) => (m.error ? j(new Error(m.error.message)) : r(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, label, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evaluate(expression).catch(() => false)) return; await sleep(150); }
    throw new Error(`timeout: ${label}`);
  };
  return { ws, cdp, evaluate, until };
}

const store = 'window.__mc.useStore.getState()';
const W = 1400, H = 860;

async function runStyle(style) {
  const root = mkdtempSync(join(tmpdir(), `unimux-status-${style}-`));
  const { home, data, bin } = setup(root);
  const env = { ...process.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), MC_CLI_NO_REGISTRY: '1', MC_STATUS_STYLE: style, USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') };
  scrubAppEnv(env);
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`;
  const child = spawn(electron, ['.'], { cwd: checkout, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log = (log + d).slice(-6000); });
  child.stderr.on('data', (d) => { log = (log + d).slice(-6000); });
  let app;
  try {
    let target;
    for (let i = 0; i < 200 && !target; i++) {
      await sleep(200);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch { /* starting */ }
    }
    if (!target) throw new Error(`page did not appear\n${log}`);
    app = await connect(target);
    await app.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    const metrics = (dpr) => app.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: dpr, mobile: false });
    await metrics(1);
    await app.until(`!!window.__mc && document.querySelectorAll('.cell').length === 4`, 'the grid');
    const seen = await app.evaluate(`document.documentElement.dataset.statusStyle`);
    if (seen !== style) throw new Error(`data-status-style is ${seen}, expected ${style}`);
    const tab = (i) => app.evaluate(`(() => { const p = ${store}.s.projects[0]; window.__mc.actions.selectTab(p.id, p.tabs[${i}]); })()`);
    // The second grid: one shell exits cleanly, one with code 3.
    await tab(1);
    await app.until(`window.__mc.terminals.has('${ids.clean}') && window.__mc.terminals.has('${ids.bad}')`, 'the shells', 30000);
    await sleep(2500);
    await app.evaluate(`window.__mc.terminals.paste('${ids.clean}', 'exit 0', true); window.__mc.terminals.paste('${ids.bad}', 'exit 3', true)`);
    await app.until(`(() => { const s = ${store}.ui.statuses; return s['${ids.clean}'] === 'exited' && s['${ids.bad}'] === 'exited' && s['${ids.done}'] === 'waiting'; })()`, 'the exits and the finished turn', 30000);
    await tab(0);
    await app.until(`(() => { const s = ${store}.ui.statuses, d = ${store}.ui.statusDetails; return s['${ids.work}'] === 'working' && d['${ids.perm}']?.kind === 'permission' && d['${ids.ask}']?.kind === 'question' && !!${store}.ui.failures['${ids.fail}'] && s['${ids.bg}'] === 'working'; })()`, 'the states of the first grid', 40000);
    await app.evaluate(`window.__mc.actions.focusCell?.('${ids.fail}')`).catch(() => undefined);
    await app.evaluate(`document.activeElement?.blur?.()`);
    // Past the first smooth turn of a working mark: the stepped pulse.
    await sleep(4000);

    const shot = async (clip) => (await app.cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })).data;
    const rect = (sel, pad = 0, all = false) => app.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})]${all ? '' : '.slice(0, 1)'}.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${pad * 2}, height: r.height + ${pad * 2} }; })`);
    const cellRect = async (id, part) => {
      const sel = `.cell[data-cell-id="${id}"] ${part}`;
      return (await rect(sel, part === '.cell-icon' ? 5 : 4))[0];
    };
    const headCrops = async (list) => {
      const out = [];
      for (const id of list) {
        const icon = await cellRect(id, '.cell-icon');
        const status = await cellRect(id, '.status-text');
        const name = await app.evaluate(`document.querySelector('.cell[data-cell-id="${id}"] .cell-name')?.textContent ?? ''`);
        out.push({ label: name, icon: icon && await shot(icon), status: status && await shot(status) });
      }
      return out;
    };
    const capture = async (dpr) => {
      await metrics(dpr);
      await sleep(900);
      const result = { dpr };
      await tab(0);
      await sleep(700);
      if (dpr === 1) result.full = await shot();
      const tabs = (await rect('.titlebar .tabs', 3))[0] ?? (await rect('.grid-tabs', 3))[0];
      const grids = await rect('.grid-tab', 2, true);
      const strip = grids.length ? { x: grids[0].x, y: grids[0].y, width: grids.at(-1).x + grids.at(-1).width - grids[0].x, height: Math.max(...grids.map((g) => g.height)) } : tabs;
      result.strip = strip && await shot(strip);
      const projects = await rect('.project', 2, true);
      result.projects = projects.length ? await shot({ x: projects[0].x, y: projects[0].y, width: projects[0].width, height: projects.at(-1).y + projects.at(-1).height - projects[0].y }) : null;
      result.headsA = await headCrops([ids.work, ids.perm, ids.ask, ids.fail]);
      // Three frames of the working marks: the pulse steps 1, 2 and 3 (each crop taken right after the step it shows).
      result.frames = [];
      const atPhase = (p) => app.until(`document.documentElement.dataset.pulse === '${p}'`, `pulse ${p}`, 5000);
      for (const p of [1, 2, 3]) {
        const icon = await cellRect(ids.work, '.cell-icon'), status = await cellRect(ids.work, '.status-text');
        await atPhase(p); const iconShot = await shot(icon);
        await atPhase(p); const statusShot = await shot(status);
        result.frames.push([{ label: `step ${p}`, icon: iconShot, status: statusShot }]);
      }
      await tab(1);
      await sleep(900);
      if (dpr === 1) result.fullB = await shot();
      result.headsB = await headCrops([ids.done, ids.clean, ids.bad, ids.idle]);
      await tab(0);
      return result;
    };
    const at100 = await capture(1);
    const at150 = await capture(1.5);
    await metrics(1);
    await sleep(500);

    // The composite, drawn by the app's own renderer on a canvas (nearest neighbour for the zoomed crops).
    const png = await app.evaluate(`(async () => {
      const data = ${JSON.stringify({ style, name: names[style], at100, at150 })};
      const load = (b64) => new Promise((r) => { if (!b64) return r(null); const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b64; });
      const ops = [];
      let y = 20, maxW = 0;
      const text = (t, size = 16, color = '#d4d4d4') => { ops.push({ t, size, color, y: y + size }); y += size + 12; };
      const img = async (b64, x, zoom) => { const i = await load(b64); if (!i) return { w: 0, h: 0 }; ops.push({ i, x, y, w: i.width * zoom, h: i.height * zoom }); return { w: i.width * zoom, h: i.height * zoom }; };
      text('Variant ' + data.style.toUpperCase() + ' - ' + data.name, 22, '#ffffff');
      text('Grid "Agenci" at 100 %: working, needs permission, asks a question, failed turn (rate limit)', 14, '#a3a3a3');
      let s = await img(data.at100.full, 20, 1); y += s.h + 16; maxW = Math.max(maxW, s.w + 40);
      text('Grid "Wyniki" at 100 %: finished turn, clean exit, exit code 3, idle', 14, '#a3a3a3');
      s = await img(data.at100.fullB, 20, 1); y += s.h + 24; maxW = Math.max(maxW, s.w + 40);
      for (const set of [data.at100, data.at150]) {
        const pct = set.dpr === 1 ? '100 %' : '150 %';
        text('Zoomed 3x (nearest neighbour, device pixels) at ' + pct, 18, '#ffffff');
        text('Grid tabs with their counts', 13, '#a3a3a3');
        s = await img(set.strip, 20, 3); y += s.h + 14;
        if (set.projects) { text('Project rows with their counts', 13, '#a3a3a3'); s = await img(set.projects, 20, 3); y += s.h + 14; }
        text('Icon corner and header status per state', 13, '#a3a3a3');
        for (const row of [...set.headsA, ...set.headsB]) {
          const rowY = y;
          ops.push({ t: row.label, size: 13, color: '#8a8a8a', y: rowY + 30, x: 20 });
          const a = await img(row.icon, 170, 3);
          y = rowY; const b = row.status ? await img(row.status, 170 + a.w + 30, 3) : { w: 0, h: 0 };
          if (!row.status) ops.push({ t: '(no status text)', size: 13, color: '#6e6e6e', y: rowY + 30, x: 170 + a.w + 30 });
          maxW = Math.max(maxW, 170 + a.w + 30 + b.w + 20);
          y = rowY + Math.max(a.h, b.h) + 10;
        }
        text('Working: the pulse steps 1, 2, 3 (320 ms each; the 4th is a rest)', 13, '#a3a3a3');
        const rowY = y; let x = 20, h = 0;
        for (const f of set.frames) {
          y = rowY; const a = await img(f[0].icon, x, 3); y = rowY; const b = await img(f[0].status, x, 3);
          ops.at(-1).y = rowY + a.h + 6; h = Math.max(h, a.h + 6 + b.h);
          x += Math.max(a.w, b.w) + 40;
        }
        maxW = Math.max(maxW, x);
        y = rowY + h + 30;
      }
      const c = document.createElement('canvas');
      c.width = Math.ceil(maxW); c.height = Math.ceil(y + 10);
      const g = c.getContext('2d');
      g.fillStyle = '#121212'; g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = false;
      for (const o of ops) {
        if (o.i) g.drawImage(o.i, o.x, o.y, o.w, o.h);
        else { g.fillStyle = o.color; g.font = (o.size >= 18 ? '600 ' : '') + o.size + 'px Segoe UI, sans-serif'; g.fillText(o.t, o.x ?? 20, o.y); }
      }
      return c.toDataURL('image/png').split(',')[1];
    })()`);
    const file = join(outDir, `variant-${style}.png`);
    writeFileSync(file, Buffer.from(png, 'base64'));
    console.log(`variant ${style}: ${file}`);
    // The crops on their own, too.
    const crops = join(outDir, `crops-${style}`);
    mkdirSync(crops, { recursive: true });
    for (const set of [at100, at150]) {
      const pct = set.dpr === 1 ? '100' : '150';
      if (set.strip) writeFileSync(join(crops, `${pct}-tabs.png`), Buffer.from(set.strip, 'base64'));
      if (set.projects) writeFileSync(join(crops, `${pct}-projects.png`), Buffer.from(set.projects, 'base64'));
      set.frames.forEach((f, i) => {
        if (f[0].icon) writeFileSync(join(crops, `${pct}-working-frame${i + 1}-icon.png`), Buffer.from(f[0].icon, 'base64'));
        if (f[0].status) writeFileSync(join(crops, `${pct}-working-frame${i + 1}-status.png`), Buffer.from(f[0].status, 'base64'));
      });
      [...set.headsA, ...set.headsB].forEach((row, i) => {
        if (row.icon) writeFileSync(join(crops, `${pct}-${i}-icon.png`), Buffer.from(row.icon, 'base64'));
        if (row.status) writeFileSync(join(crops, `${pct}-${i}-status.png`), Buffer.from(row.status, 'base64'));
      });
    }
  } finally {
    try { app?.ws.close(); } catch { /* closed */ }
    killTree(child.pid);
    await sleep(1500);
    removeScratch(root);
  }
}

for (const style of styles) await runStyle(style);
