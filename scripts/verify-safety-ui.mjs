// Real-app check of worktree removal safety and editor tabs whose file changed on disk (npm run build first), on a scratch
// git repository and a scratch data dir:
// - closing a worktree cell whose worktree has an uncommitted file and an unmerged commit shows both counts and asks twice;
//   "Remove anyway" then removes the folder and the branch;
// - an open clean file reloads after an external write;
// - a file with unsaved edits changed on disk shows a notice, and saving offers Reload, Show diff and Overwrite.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, sshState, writeState } from './ssh-ui-lib.mjs';

const root = scratchRoot('safety');
const project = join(root, 'project');
const worktree = join(root, 'project-wt-agent');
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' };
writeFileSync(join(root, 'gitconfig'), '');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
git(project, 'init', '-q', '-b', 'main');
writeFileSync(join(project, 'clean.txt'), 'first version\n');
writeFileSync(join(project, 'draft.txt'), 'disk line\n');
git(project, 'add', '.');
git(project, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first');
git(project, 'worktree', 'add', '-q', '-b', 'mc/agent', worktree, 'HEAD');
writeFileSync(join(worktree, 'agent.txt'), 'agent work\n');
git(worktree, 'add', 'agent.txt');
git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'agent commit');
writeFileSync(join(worktree, 'scratch.txt'), 'uncommitted\n');

const state = sshState({ projectPath: project });
const tab = { id: randomUUID(), name: 'Grid 1', layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] },
  cells: [{ id: randomUUID(), profileId: 'shell', worktree: { path: worktree, branch: 'mc/agent' } }, { id: randomUUID(), profileId: 'shell' }] };
state.projects[0].tabs = [tab];
state.projects[0].activeTabId = tab.id;

const results = [];
const ok = (label) => { results.push(label); console.log(`OK ${label}`); };
const ctrl = process.platform === 'darwin' ? 4 : 2;
let app;
try {
  writeState(root, state);
  app = await launchApp(root);
  const { evaluate, until, click, cdp } = app;
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);

  // ── worktree removal ──
  await until(`document.querySelectorAll('button[aria-label="Zamknij komórkę"]').length === 2`, 'two cells');
  await click('button[aria-label="Zamknij komórkę"]');
  await until(`!!document.querySelector('.modal .modal-body') && document.querySelector('.modal').textContent.includes('Niezatwierdzone pliki: 1')`, 'first removal dialog with counts');
  const first = await text('.modal');
  if (!first.includes('Commity, których nie ma w main: 1')) throw new Error(`first dialog lacks the commit count: ${first}`);
  ok('the removal dialog shows 1 uncommitted file and 1 unmerged commit');
  await click('.modal-foot button', 'Usuń worktree i branch');
  await until(`[...document.querySelectorAll('.modal-foot button.danger')].some((b) => b.textContent.includes('Usuń mimo to'))`, 'second confirmation');
  const second = await evaluate(`[...document.querySelectorAll('.modal-foot button.danger')].map((b) => b.textContent).join(' | ')`);
  if (!second.includes('pliki (1)') || !second.includes('commity (1)')) throw new Error(`second confirmation lacks the counts: ${second}`);
  if (!existsSync(join(worktree, 'scratch.txt'))) throw new Error('the worktree was touched before the second confirmation');
  ok(`a second, red confirmation asks: "${second}"`);
  await click('.modal-foot button.danger', 'Usuń mimo to');
  await until(`document.querySelectorAll('button[aria-label="Zamknij komórkę"]').length === 1`, 'cell closed');
  const t0 = Date.now();
  // The folder goes first, the branch right after it.
  while ((existsSync(worktree) || git(project, 'branch', '--list', 'mc/agent').trim()) && Date.now() - t0 < 20000) await sleep(200);
  const toast = await text('.toast');
  if (toast && !toast.includes('Usunięto worktree')) throw new Error(`unexpected toast: ${toast}`);
  if (existsSync(worktree)) throw new Error('the worktree folder is still there');
  if (git(project, 'branch', '--list', 'mc/agent').trim()) throw new Error('the branch is still there');
  ok('"Remove anyway" removed the worktree folder and its unmerged branch');

  // ── a clean tab reloads ──
  await click('#files-view');
  await until(`!!document.querySelector('.file-entry[title="clean.txt"]')`, 'file tree');
  await click('.file-entry[title="clean.txt"]');
  await until(`document.querySelector('.file-editor .cm-content')?.textContent.includes('first version')`, 'clean file open');
  writeFileSync(join(project, 'clean.txt'), 'second version from an agent\n');
  await until(`document.querySelector('.file-editor .cm-content')?.textContent.includes('second version from an agent')`, 'clean tab reloaded', 15000);
  ok('an open clean file reloaded after an external write');

  // ── a dirty tab: notice, then the three conflict choices ──
  const setText = async (value) => {
    await evaluate('document.querySelector(".cm-content").focus()');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: ctrl });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: ctrl });
    await cdp('Input.insertText', { text: value });
  };
  const save = async () => {
    await evaluate('document.querySelector(".cm-content").focus()');
    for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: ctrl });
  };
  await click('.file-entry[title="draft.txt"]');
  await until(`document.querySelector('.file-editor .cm-content')?.textContent.includes('disk line')`, 'draft file open');
  await setText('my edit\n');
  await until(`document.querySelector('.file-editor .cm-content')?.textContent.includes('my edit')`, 'edited');
  writeFileSync(join(project, 'draft.txt'), 'external line\n');
  await until(`!!document.querySelector('.file-disk-conflict') && !document.querySelector('.file-disk-conflict.error')`, 'dirty tab notice', 15000);
  if (!(await text('.file-editor .cm-content')).includes('my edit')) throw new Error('the dirty tab lost its edits');
  ok(`a dirty tab keeps its edits and shows: "${await text('.file-disk-conflict > span')}"`);
  await save();
  await until(`!!document.querySelector('.file-disk-conflict.error')`, 'save conflict');
  const choices = await evaluate(`[...document.querySelectorAll('.file-disk-conflict-actions button')].map((b) => b.textContent)`);
  if (choices.length !== 3) throw new Error(`expected three choices, got ${JSON.stringify(choices)}`);
  if (readFileSync(join(project, 'draft.txt'), 'utf8') !== 'external line\n') throw new Error('the conflicting save wrote the file');
  ok(`saving offers ${JSON.stringify(choices)} and writes nothing`);
  await click('.file-disk-conflict-actions button', 'Pokaż różnice');
  await until(`!!document.querySelector('.file-conflict-diff .git-diff-line.add') && !!document.querySelector('.file-conflict-diff .git-diff-line.del')`, 'diff view');
  const diff = await text('.file-conflict-diff .git-diff');
  if (!diff.includes('external line') || !diff.includes('my edit')) throw new Error(`diff lacks the lines: ${diff}`);
  ok('Show diff shows the disk line removed and the editor line added');
  await click('.file-disk-conflict-actions button', 'Nadpisz');
  const t1 = Date.now();
  while (readFileSync(join(project, 'draft.txt'), 'utf8') !== 'my edit\n' && Date.now() - t1 < 10000) await sleep(150);
  if (readFileSync(join(project, 'draft.txt'), 'utf8') !== 'my edit\n') throw new Error('Overwrite did not write the editor text');
  await until(`!document.querySelector('.file-disk-conflict') && !!document.querySelector('.file-editor .cm-content')`, 'conflict gone after overwrite');
  ok('Overwrite (keep mine) wrote the editor text');

  // Reload (discard my edits)
  await setText('another edit\n');
  await until(`document.querySelector('.file-editor .cm-content')?.textContent.includes('another edit')`, 'edited again');
  writeFileSync(join(project, 'draft.txt'), 'agent rewrote it\n');
  await save();
  await until(`!!document.querySelector('.file-disk-conflict.error')`, 'second save conflict', 15000);
  await click('.file-disk-conflict-actions button', 'Wczytaj z dysku');
  await until(`document.querySelector('.file-editor .cm-content')?.textContent.includes('agent rewrote it') && !document.querySelector('.file-disk-conflict')`, 'reloaded from disk');
  ok('Reload (discard my edits) shows the disk text');
  console.log(`\nall ${results.length} checks passed`);
} finally {
  if (app) await app.close();
  try { execFileSync('git', ['worktree', 'prune'], { cwd: project, env, windowsHide: true, stdio: 'ignore' }); } catch { /* the repository may be gone */ }
  for (const dir of [worktree, root]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
