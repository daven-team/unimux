// Real-app check (npm run build:check first): the Accounts & limits panel at the bottom of the sidebar stays where it is, frame by
// frame, when a side panel that loads on demand (Git, Databases) is opened for the first time. It used to jump up for a few
// frames while the panel's code loaded, because nothing filled the column above it. Runs on a scratch repo and data dir.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, sshState, writeState } from './ssh-ui-lib.mjs';

const root = scratchRoot('sideanchor');
const project = join(root, 'project');
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' };
writeFileSync(join(root, 'gitconfig'), '');
execFileSync('git', ['init', '-q', '-b', 'main', project], { env, windowsHide: true, stdio: 'ignore' });
for (let i = 0; i < 5; i++) {
  writeFileSync(join(project, 'f.txt'), `v${i}\n`);
  execFileSync('git', ['add', '.'], { cwd: project, env, windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `change ${i}`], { cwd: project, env, windowsHide: true, stdio: 'ignore' });
}
let app;
let failed = false;
try {
  writeState(root, sshState({ projectPath: project }));
  app = await launchApp(root);
  await app.until(`!!document.querySelector('.usage-head') && !!document.querySelector('#git-view')`, 'sidebar with the limits panel');
  await sleep(1500);
  for (const tile of ['#git-view', '#db-view']) {
    // Every frame from the click on: the top of the limits panel's header.
    await app.evaluate(`(() => { const tops = window.__anchorTops = []; let n = 0;
      const step = () => { const h = document.querySelector('.usage-head'); tops.push(h ? Math.round(h.getBoundingClientRect().top) : -1); if (++n < 90) requestAnimationFrame(step); };
      requestAnimationFrame(step); document.querySelector('${tile}').click(); return true; })()`);
    await sleep(2500);
    const tops = await app.evaluate('window.__anchorTops');
    const moved = new Set(tops.slice(1)).size > 1 || tops.slice(1).some((t) => t !== tops[0]);
    const summary = `${tile}: ${tops.length} frames, top ${Math.min(...tops)}..${Math.max(...tops)} px`;
    if (moved) { failed = true; console.log(`FAIL ${summary}: the limits panel moved (${[...new Set(tops)].join(' -> ')})`); }
    else console.log(`OK ${summary}: the limits panel stayed in place`);
  }
} finally {
  await app?.close?.();
}
if (failed) process.exit(1);
