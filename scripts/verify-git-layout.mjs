// Real-app check of the Git panel layout (npm run build first): a saved history height taller than the panel must not push
// the history over the commit box, a long list of changes scrolls instead of pushing the history out, and in a tall panel the
// history keeps its saved height. Runs on a scratch git repository and a scratch data dir.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, sshState, writeState } from './ssh-ui-lib.mjs';

const SAVED_HISTORY = 520;
const CASES = [
  { name: 'short panel, one change', height: 560, files: 0 },
  { name: 'short panel, 40 changes', height: 560, files: 40 },
  { name: 'tall panel, 40 changes', height: 1000, files: 40, keepsHeight: true },
];

async function check({ name, height, files, keepsHeight }) {
  const root = scratchRoot('gitlayout');
  const project = join(root, 'project');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' };
  writeFileSync(join(root, 'gitconfig'), '');
  const git = (...args) => execFileSync('git', args, { cwd: project, env, windowsHide: true, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(project, 'f.txt'), `v${i}\n`);
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `feat: change number ${i} with a fairly long subject line`);
  }
  writeFileSync(join(project, 'f.txt'), 'dirty\n');
  for (let i = 0; i < files; i++) writeFileSync(join(project, `new-${i}.txt`), 'x');
  let app;
  try {
    writeState(root, sshState({ projectPath: project }));
    app = await launchApp(root);
    await app.evaluate(`localStorage.setItem('mc-git-history-v1', JSON.stringify({ collapsed: false, height: ${SAVED_HISTORY} })), true`);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: 900, height, deviceScaleFactor: 1, mobile: false });
    await app.evaluate('location.reload(), true');
    await sleep(2000);
    await app.until(`!!document.querySelector('#git-view')`, 'git button');
    await app.click('#git-view');
    await app.until(`document.querySelectorAll('.git-commit').length >= 5 && !!document.querySelector('.git-commit-box')`, 'git panel');
    await sleep(400);
    const r = await app.evaluate(`(() => {
      const box = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
      return { panel: box('.git-panel'), commitBox: box('.git-commit-box'), list: box('.git-changes-body'), history: box('.git-history') };
    })()`);
    const problems = [];
    if (r.commitBox.bottom > r.history.top + 1) problems.push('the commit box runs under the history');
    if (r.list.bottom > r.history.top + 1) problems.push('the list of changes runs under the history');
    if (r.history.bottom > r.panel.bottom + 1) problems.push('the history is cut at the bottom of the panel');
    if (r.list.h < 40) problems.push(`the list of changes has no room (${r.list.h} px)`);
    if (keepsHeight && Math.abs(r.history.h - SAVED_HISTORY) > 1) problems.push(`the history lost its saved height (${r.history.h} px)`);
    if (problems.length) throw new Error(`${name}: ${problems.join('; ')} ${JSON.stringify(r)}`);
    console.log(`OK ${name}`);
  } finally {
    if (app) await app.close();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

for (const c of CASES) await check(c);
