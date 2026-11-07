// Real-app check of the context meter, the session listing and codex:bind (1.2.0, PLAN H4) on the `check` build. A scratch
// home holds Claude transcripts and Codex rollouts of a project, its worktree folders and unrelated folders:
//   - window.mc.listSessions answers exactly what 1.1.4's listSessionsAsync answers on the same home and the same state
//     (worktree hints from the cells, labels, removed folders, a non-BMP project name), and refuses a non-string path;
//   - window.mc.contextUsage answers what 1.1.4's ContextTracker reads (Claude and Codex), and a Stop hook posted to the
//     app's hook server after the transcript grew pushes `cell:context` with the new count (throttled read + settle read);
//   - window.mc.bindCodexSession binds the fresh rollout of the only live Codex cell in its folder once (`cell:session`
//     unconfirmed), never twice, and never for a cell that is not alive.
// Scratch data dir and home only (USERPROFILE / HOME point into the scratch dir); ends only the processes it started.
//
//   npm run build:check && node scripts/verify-tauri-sessions.mjs
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
const [{ addProject, addTab, defaultState }, { layoutForCount }, sessions, { ContextTracker }] = await Promise.all([
  load('src/shared/state.ts'), load('src/shared/layout.ts'), load('src/main/sessions.ts'), load('src/main/contextUsage.ts'),
]);
const { claudeProjectDirName, listSessionsAsync, clearClaudeCache, clearCodexCache } = sessions;

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SESSION = '3f2b9c1e-7a4d-4e21-9b0a-5c6d7e8f9a01';
const CODEX_CTX = '01a13797-c84e-7c32-bc48-1da925af91e6';
const CODEX_NEW = '0199aaaa-bbbb-7ccc-8ddd-0000000000aa';

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-sessions-'));
const dataDir = join(scratch, 'data');
const home = join(scratch, 'home');
const work = join(scratch, 'work');
const project = join(work, 'app');
const emojiProject = join(work, 'proj😀ż');
for (const dir of [dataDir, project, join(work, 'app-wt-grid-1'), join(work, 'app-wt-left'), emojiProject, join(work, 'proj😀ż-wt-a')]) mkdirSync(dir, { recursive: true });
console.log(`scratch: ${scratch}`);

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const at = (file, ms) => utimesSync(file, ms / 1000, ms / 1000);
const BASE = 1_700_000_000_000;
let tick = 0;
const claude = (cwd, id, rows) => {
  const dir = join(home, '.claude', 'projects', claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, jsonl(rows));
  at(file, BASE + ++tick * 1000);
  return file;
};
const user = (cwd, id, text) => ({ type: 'user', message: { content: text }, sessionId: id, cwd, timestamp: '2025-10-01T10:00:00Z' });
const assistant = (n, model = 'claude-sonnet-4-5-20250929') => ({ type: 'assistant', message: { model, usage: { input_tokens: 4, cache_read_input_tokens: n, output_tokens: 6 } } });
const codexDay = join(home, '.codex', 'sessions', '2025', '10', '06');
mkdirSync(codexDay, { recursive: true });
const codex = (id, cwd, rows, ms) => {
  const file = join(codexDay, `rollout-2025-10-06T10-00-${String(++tick).padStart(2, '0')}-${id}.jsonl`);
  writeFileSync(file, jsonl([{ type: 'session_meta', payload: { id, cwd, timestamp: '2025-10-06T10:00:00Z' } }, ...rows]));
  at(file, ms ?? BASE + tick * 1000);
  return file;
};
const codexUser = (text) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });

// Conversations: the project, a known and a removed worktree, a loose one, another project, a non-BMP project and its worktree.
const transcript = claude(project, SESSION, [user(project, SESSION, 'napraw   logowanie\nw bocie'), assistant(30_000)]);
claude(project, 'b2', [user(project, 'b2', 'pierwszy'), { type: 'ai-title', aiTitle: 'Refaktor sidebaru', sessionId: 'b2' }]);
claude(join(work, 'app-wt-grid-1'), 'live', [user(join(work, 'app-wt-grid-1'), 'live', 'in the live worktree')]);
claude(join(work, 'app-wt-old'), 'gone', [user(join(work, 'app-wt-old'), 'gone', 'in a removed worktree')]);
claude(join(work, 'apple-wt-1'), 'apple', [user(join(work, 'apple-wt-1'), 'apple', 'other project')]);
claude(emojiProject, 'emoji', [user(emojiProject, 'emoji', 'projekt z emoji')]);
claude(join(work, 'proj😀ż-wt-a'), 'emoji-wt', [user(join(work, 'proj😀ż-wt-a'), 'emoji-wt', 'worktree z emoji')]);
codex('cx-loose', join(work, 'app-wt-left'), [codexUser('codex in the loose worktree')]);
codex('cx-main', `${project}\\`, [codexUser('# AGENTS.md'), codexUser('codex in the project')]);
const rollout = codex(CODEX_CTX, project, [codexUser('kontekst'), { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
  { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 47_500 }, model_context_window: 475_000 } } }]);

// The state: a Claude cell on SESSION, a Codex cell on CODEX_CTX, a Codex cell without a session in the project folder (bind),
// a cell in the known worktree; a second project with the non-BMP name.
let input = addProject(defaultState('win32'), { name: 'app', path: project });
input = addTab(input, input.projects[0].id, { layout: layoutForCount(4), cells: [{ profileId: 'claude' }, { profileId: 'codex' }, { profileId: 'codex' }, { profileId: 'claude' }] });
const [claudeCell, codexCtxCell, codexBindCell, wtCell] = input.projects[0].tabs[0].cells;
claudeCell.session = { cli: 'claude', id: SESSION, confirmed: true };
codexCtxCell.session = { cli: 'codex', id: CODEX_CTX, confirmed: true };
codexCtxCell.dir = join(work, 'elsewhere');
wtCell.worktree = { path: join(work, 'app-wt-grid-1'), branch: 'mc/grid-1' };
input = addProject(input, { name: 'emoji', path: emojiProject });
writeFileSync(join(dataDir, 'state.json'), JSON.stringify(input));

// 1.1.4's answers on the same home.
const tsList = async (path, worktrees) => {
  clearClaudeCache();
  clearCodexCache();
  return listSessionsAsync(home, path, worktrees, async () => undefined);
};
const tsContext = async (cellId) => {
  const targets = {
    [claudeCell.id]: { cli: 'claude', sessionId: SESSION, cwd: project },
    [codexCtxCell.id]: { cli: 'codex', sessionId: CODEX_CTX, cwd: join(work, 'elsewhere') },
  };
  const tracker = new ContextTracker({ target: (id) => targets[id] ?? null, emit: () => {}, claudeDir: () => join(home, '.claude'), codexHome: () => join(home, '.codex') });
  return tracker.get(cellId);
};

function post(url, body = '{}') {
  return new Promise((res, rej) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => {
      r.resume();
      r.on('end', () => res(r.statusCode));
    });
    req.on('error', rej);
    req.end(body);
  });
}

let child;
try {
  const port = await freePort();
  child = launchApp({ dataDir, scratch, port });
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 30000, 'Tauri IPC');
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  const call = (expr) => page.evaluate(expr);
  const bridge = (op, args) => call(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
  await call(`(() => {
    window.__seen = [];
    window.mc.on('cell:context', (cell, usage) => window.__seen.push(['cell:context', cell, usage]));
    window.mc.on('cell:session', (cell, session) => window.__seen.push(['cell:session', cell, session]));
    return true;
  })()`);
  const seen = async (settle = 300) => { await sleep(settle); return call(`window.__seen.splice(0)`); };

  // sessions:list
  const rust = await call(`window.mc.listSessions(${JSON.stringify(project)})`);
  const want = await tsList(project, [wtCell.worktree]);
  check(`sessions:list of the project equals 1.1.4 (${rust.length} conversations)`, same(rust, want), same(rust, want) ? '' : `${JSON.stringify(rust).slice(0, 600)}\n vs ${JSON.stringify(want).slice(0, 600)}`);
  check('worktree conversations are labelled (known branch, folder name, removed folder)',
    rust.some((s) => s.id === 'live' && s.worktree?.branch === 'mc/grid-1') && rust.some((s) => s.id === 'gone' && s.worktree?.exists === false && s.worktree.label === 'app-wt-old')
    && rust.some((s) => s.id === 'cx-loose' && s.worktree?.label === 'app-wt-left') && !rust.some((s) => s.id === 'apple'));
  const spelled = await call(`window.mc.listSessions(${JSON.stringify(`${project}\\`)})`);
  check('a trailing separator is another Claude folder name (as in 1.1.4)', same(spelled, await tsList(`${project}\\`, [wtCell.worktree])));
  const emoji = await call(`window.mc.listSessions(${JSON.stringify(emojiProject)})`);
  check('a non-BMP project name lists its own and its worktree conversations like 1.1.4', same(emoji, await tsList(emojiProject, [])) && emoji.length === 2, JSON.stringify(emoji).slice(0, 300));
  const refused = await call(`window.mc.listSessions(5).then(() => 'answered', () => 'rejected')`);
  check('a non-string path is rejected', refused === 'rejected');

  // context:get
  const claudeUsage = await call(`window.mc.contextUsage(${JSON.stringify(claudeCell.id)})`);
  check('context of the Claude cell equals 1.1.4', same(claudeUsage, await tsContext(claudeCell.id)) && claudeUsage?.tokens === 30_010, JSON.stringify(claudeUsage));
  const codexUsage = await call(`window.mc.contextUsage(${JSON.stringify(codexCtxCell.id)})`);
  check('context of the Codex cell equals 1.1.4', same(codexUsage, await tsContext(codexCtxCell.id)) && codexUsage?.percent === 10, JSON.stringify(codexUsage));
  check('a cell without a conversation and an unknown cell answer null',
    (await call(`window.mc.contextUsage(${JSON.stringify(codexBindCell.id)})`)) === null && (await call(`window.mc.contextUsage('nope')`)) === null);

  // A Stop hook after the transcript grew: the throttled read and the settle read push the new count.
  const info = await bridge('hooks', { cell: claudeCell.id, alive: [codexBindCell.id] });
  await seen(0);
  appendFileSync(transcript, jsonl([assistant(150_000)]));
  const status = await post(info.cell.url.replace('EVENT', 'stop'), JSON.stringify({ session_id: SESSION }));
  check('the hook server takes the Stop hook', status === 204, String(status));
  await waitFor(page, `window.__seen.some((e) => e[0] === 'cell:context' && e[2]?.tokens === 150010)`, 6000, 'cell:context after the Stop hook');
  const pushed = (await seen(3000)).filter((e) => e[0] === 'cell:context');
  check('cell:context carries the new usage once (the settle read finds nothing new)', pushed.length === 1 && same(pushed[0], ['cell:context', claudeCell.id, { cli: 'claude', tokens: 150_010, window: 200_000, percent: 75, model: 'claude-sonnet-4-5-20250929' }]), JSON.stringify(pushed));

  // codex:bind
  const fresh = codex(CODEX_NEW, project, [codexUser('nowa rozmowa')], Date.now());
  const bound = await call(`window.mc.bindCodexSession(${JSON.stringify(codexBindCell.id)}, ${JSON.stringify(project)})`);
  check('codex:bind binds the fresh rollout of the only live Codex cell in the folder', bound === CODEX_NEW, JSON.stringify(bound));
  const events = (await seen(300)).filter((e) => e[0] === 'cell:session');
  check('codex:bind sends cell:session unconfirmed', same(events, [['cell:session', codexBindCell.id, { cli: 'codex', id: CODEX_NEW, confirmed: false }]]), JSON.stringify(events));
  check('the same rollout is never bound twice', (await call(`window.mc.bindCodexSession(${JSON.stringify(codexBindCell.id)}, ${JSON.stringify(project)})`)) === null);
  at(fresh, Date.now());
  check('a cell that is not alive is never bound', (await call(`window.mc.bindCodexSession(${JSON.stringify(codexCtxCell.id)}, ${JSON.stringify(join(work, 'elsewhere'))})`)) === null);
  check('a wrong folder is never bound', (await call(`window.mc.bindCodexSession(${JSON.stringify(codexBindCell.id)}, ${JSON.stringify(join(work, 'other'))})`)) === null);

  await call(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
  check('the app quits', (await waitExit(child, 15000)) !== null);
  page.close?.();
} catch (error) {
  failed = true;
  console.log(`FAIL ${error?.stack ?? error}`);
} finally {
  killTree(child);
  check('real profile untouched', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
  await sleep(500);
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* a webview may still hold a file */ }
}
console.log(failed ? 'verify-tauri-sessions: FAILED' : 'verify-tauri-sessions: all checks passed');
process.exit(failed ? 1 : 0);
