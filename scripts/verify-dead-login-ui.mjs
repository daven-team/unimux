// Real-app check (1.0.10) of the AI limits panel when Claude Code cleared the main login as dead ("Login expired"):
// the main card says "Sign-in expired" with "Sign in again", another saved account can still be made main, the dead
// account then keeps "Sign-in expired" on its card, and an outside switch shows no banner. Fake home, fake tokens, a local
// fake usage/token endpoint; never the real ~/.claude, cswap data or the app data folder.
// Run: npm run build && node scripts/verify-dead-login-ui.mjs [shots dir]   (default: <tmp>/unimux-dead-login-shots)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { launchApp, scratchRoot, sshState, writeState } from './ssh-ui-lib.mjs';

const shots = process.argv[2] ?? join(tmpdir(), 'unimux-dead-login-shots');
mkdirSync(shots, { recursive: true });
/** The whole limits panel (no scrolling inside it), from a tall viewport. */
const shoot = async (app, name, page = false) => {
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1800, deviceScaleFactor: 1, mobile: false });
  await app.evaluate(`(() => { if (!document.getElementById('shot-style')) { const s = document.createElement('style'); s.id = 'shot-style'; s.textContent = '.side-panel > .usage-panel, .usage-panel { max-height: none !important; }'; document.head.appendChild(s); } return true; })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const r = await app.evaluate(`(() => { const b = document.querySelector('.usage-panel').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const { data } = await app.cdp('Page.captureScreenshot', { format: 'png', ...(page ? {} : { clip: { ...r, scale: 1 } }) });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
};
/** The expired row of a card without its tooltip: every expired card must render it identically. */
const expiredRow = (card) => `(() => { const row = ${card}?.querySelector('.usage-expired')?.cloneNode(true); if (!row) return null; row.removeAttribute('title'); return row.outerHTML; })()`;
const usageBody = (five, seven) => JSON.stringify({ five_hour: { utilization: five, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: seven, resets_at: new Date(Date.now() + 86_400_000).toISOString() } });
const who = (name, org = 'Rossmann') => ({ emailAddress: `${name}@example.com`, organizationName: org, accountUuid: `fake-uuid-${name}`, organizationUuid: `fake-org-${org}` });
const login = (n, expiresAt, plan = 'team') => ({ claudeAiOauth: { accessToken: `fake-access-${n}`, refreshToken: `fake-refresh-${n}`, expiresAt, scopes: ['user:inference'], subscriptionType: plan, rateLimitTier: 'default_claude_max_5x' } });
/** What Claude Code writes after the token endpoint rejected the refresh token (invalid_grant). */
const cleared = (plan = 'team') => ({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, scopes: ['user:inference'], subscriptionType: plan, rateLimitTier: 'default_claude_max_5x' }, mcpOAuth: { fake: 1 } });
const ids = { daniel: '66666666-6666-4666-8666-666666666666', app: '77777777-7777-4777-8777-777777777777', support: '88888888-8888-4888-8888-888888888888' };

const root = scratchRoot('dead-login');
const seen = [];
const server = createServer((req, res) => {
  const entry = { path: req.url, auth: String(req.headers.authorization ?? ''), body: '' };
  seen.push(entry);
  if (req.url === '/token') {
    // The app account's copy is renewed by the app and the server calls it dead (like APP_ChatGPT in the report).
    req.on('data', (chunk) => { entry.body += chunk; });
    req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant' })); });
    return;
  }
  if (req.url !== '/usage') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(usageBody(String(req.headers.authorization).includes('support') ? 12 : 30, 84));
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = join(root, 'home');
  const data = join(root, 'data');
  mkdirSync(join(home, '.claude'), { recursive: true });
  // Daniel is main and Claude Code has just cleared his login as dead.
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(cleared()));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: who('daniel'), projects: {} }));
  const records = [
    { id: ids.daniel, addedAt: 1, email: 'daniel@example.com', org: 'Rossmann', accountUuid: 'fake-uuid-daniel', organizationUuid: 'fake-org-Rossmann', custody: 'live', family: 'live' },
    { id: ids.app, addedAt: 2, email: 'app@example.com', org: 'Rossmann', accountUuid: 'fake-uuid-app', organizationUuid: 'fake-org-Rossmann', custody: 'app', family: 'own' },
    { id: ids.support, addedAt: 3, email: 'support@example.com', org: 'support', accountUuid: 'fake-uuid-support', organizationUuid: 'fake-org-support', custody: 'app', family: 'own' },
  ];
  mkdirSync(join(data, 'accounts'), { recursive: true });
  writeFileSync(join(data, 'accounts', 'accounts.json'), JSON.stringify({ version: 2, claude: records, live: { email: 'daniel@example.com', org: 'Rossmann', accountUuid: 'fake-uuid-daniel', organizationUuid: 'fake-org-Rossmann', recordId: ids.daniel } }));
  const copies = { daniel: login('daniel', Date.now() - 24 * 3_600_000), app: login('app', Date.now() - 60_000), support: login('support', Date.now() + 8 * 3_600_000, 'max') };
  for (const [name, id] of Object.entries(ids)) {
    const dir = join(data, 'accounts', 'claude', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(copies[name]));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: who(name, name === 'support' ? 'support' : 'Rossmann') }));
  }
  const state = sshState({ projectPath: join(root, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false };
  writeState(root, state);
  const port = server.address().port;
  const app = await launchApp(root, {
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${port}/token`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
  });
  const card = (name) => `[...document.querySelectorAll('.usage-card')].find((c) => c.textContent.includes('${name}@example.com'))`;
  try {
    // Bug 1: the dead main login is an expired sign-in with "Sign in again", like a saved account whose renewal was rejected.
    await app.until(`!!${card('daniel')} && ${card('daniel')}.textContent.includes('Logowanie wygasło') && [...${card('daniel')}.querySelectorAll('button')].some((b) => b.textContent === 'Zaloguj ponownie') && !!${card('daniel')}.querySelector('.usage-chip.main')`, 'dead main card says sign-in expired');
    await app.until(`!!${card('app')} && ${card('app')}.textContent.includes('Logowanie wygasło') && !!${card('support')} && ${card('support')}.textContent.includes('12%')`, 'other cards');
    if (await app.evaluate(`document.body.textContent.includes('odświeży go przy najbliższym użyciu')`)) throw new Error('dormant text shown for a dead login');
    // Daniel (dead main login) and the app account (renewal rejected) render the very same row.
    const [danielRow, appRow] = [await app.evaluate(expiredRow(card('daniel'))), await app.evaluate(expiredRow(card('app')))];
    if (!danielRow || danielRow !== appRow) throw new Error(`expired rows differ: ${danielRow} vs ${appRow}`);
    if (await app.evaluate(`${card('daniel')}.textContent.includes('dane sprzed')`)) throw new Error('old numbers shown on an expired card');
    await shoot(app, '1-dead-main-card.png');
    // Bug 2: support can be made main although the main login is dead.
    await app.evaluate(`${card('support')}.querySelector('.usage-kebab').click()`);
    await app.until(`[...document.querySelectorAll('.menu button')].some((b) => b.textContent.includes('Ustaw jako główne'))`, 'make main offered');
    await app.evaluate(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Ustaw jako główne')).click()`);
    await app.until(`document.querySelector('.modal')?.textContent.includes('nie ma ważnego logowania')`, 'confirmation for a dead main login');
    await shoot(app, '2-make-main-confirm.png', true);
    await app.evaluate(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Ustaw jako główne').click()`);
    await app.until(`document.body.textContent.includes('Konto główne: support@example.com')`, 'support made main');
    await app.until(`!!${card('support')}?.querySelector('.usage-chip.main') && ${card('daniel')}.textContent.includes('Logowanie wygasło') && !${card('daniel')}.querySelector('.usage-chip.main')`, 'roles moved, daniel stays expired');
    if (await app.evaluate(`document.body.textContent.includes('Brak głównego logowania')`)) throw new Error('noMain refusal shown');
    await shoot(app, '3-after-make-main.png');
    // Bug 3: an outside switch (cswap) to the app account: no banner. support's login was valid: its card has one short line.
    const live = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8'));
    if (live.claudeAiOauth.refreshToken !== 'fake-refresh-support' || live.mcpOAuth?.fake !== 1) throw new Error('live login after the swap');
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ ...live, claudeAiOauth: login('cswapped', Date.now() + 8 * 3_600_000).claudeAiOauth }));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: who('app'), projects: {} }));
    await app.evaluate(`window.mc.refreshUsage().then(() => true)`);
    // The live file watch (20 s) or the refresh picks the switch up.
    try {
      await app.until(`!!${card('app')}?.querySelector('.usage-chip.main') && ${card('support')}?.textContent.includes('Przełączone poza aplikacją')`, 'outside switch picked up', 60_000);
    } catch (error) {
      console.log(await app.evaluate(`[...document.querySelectorAll('.usage-card')].map((c) => c.textContent).join(' | ')`));
      throw error;
    }
    await app.until(`${card('daniel')}.textContent.includes('Logowanie wygasło')`, 'daniel still expired');
    if (await app.evaluate(`document.querySelectorAll('.usage-notices .usage-warning').length`)) throw new Error('a banner is shown');
    await app.evaluate(`document.querySelector('.usage-panel').scrollIntoView({ block: 'end' })`);
    await shoot(app, '4-after-outside-switch.png');
  } finally { await app.close(); }
  const stored = readFileSync(join(data, 'accounts', 'accounts.json'), 'utf8');
  if (/fake-access|fake-refresh/.test(stored)) throw new Error('accounts.json contains a token');
  if (!JSON.parse(stored).claude.find((r) => r.id === ids.daniel)?.deadTokens) throw new Error('daniel not marked dead');
  if (seen.some((r) => r.auth.includes('daniel') || r.body.includes('daniel'))) throw new Error('the dead login was sent somewhere');
  if (seen.some((r) => r.path === '/token' && !r.body.includes('fake-refresh-app'))) throw new Error('unexpected token request');
  console.log(`OK dead login; screenshots in ${shots}`);
} finally {
  server.close();
  removeScratch(root);
}

// Every card state side by side (1.0.10 card states): current, stale, unavailable (server trouble, access denied, waiting
// for Claude Code), a copy cswap also holds, and the expired ones (a rejected renewal, a copy switched out elsewhere).
const allRoot = scratchRoot('card-states');
const allServer = createServer((req, res) => {
  const auth = String(req.headers.authorization ?? '');
  if (req.url === '/token') { req.resume(); req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant' })); }); return; }
  if (req.url !== '/usage') { res.writeHead(404); res.end(); return; }
  if (auth.includes('busy')) { res.writeHead(503); res.end(); return; }
  if (auth.includes('denied')) { res.writeHead(403); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(usageBody(auth.includes('cswapped') ? 55 : 20, 40));
});
try {
  await new Promise((resolve) => allServer.listen(0, '127.0.0.1', resolve));
  const home = join(allRoot, 'home');
  const data = join(allRoot, 'data');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude-swap-backup'), { recursive: true });
  writeFileSync(join(home, '.claude-swap-backup', 'sequence.json'), JSON.stringify({ accounts: { 1: { email: 'cswapped@example.com', uuid: 'fake-uuid-cswapped' } } }));
  // The main login: its access token ran out, Claude Code renews it on the next message (numbers from the last read).
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(login('main', Date.now() - 3_600_000, 'max')));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: who('main', 'main'), projects: {} }));
  const names = { main: ['live', 'live', Date.now() - 3_600_000], fresh: ['app', 'own', Date.now() + 3_600_000], busy: ['app', 'own', Date.now() + 3_600_000], denied: ['app', 'own', Date.now() + 3_600_000], cswapped: ['app', 'live', Date.now() + 3_600_000], rejected: ['app', 'own', Date.now() - 60_000], outdated: ['foreign', 'live', Date.now() - 60_000] };
  const recs = Object.entries(names).map(([name, [custody, family]], i) => ({ id: `9999999${i}-9999-4999-8999-99999999999${i}`, addedAt: i + 1, email: `${name}@example.com`, org: name, accountUuid: `fake-uuid-${name}`, organizationUuid: `fake-org-${name}`, custody, family }));
  mkdirSync(join(data, 'accounts'), { recursive: true });
  writeFileSync(join(data, 'accounts', 'accounts.json'), JSON.stringify({ version: 2, claude: recs, live: { email: 'main@example.com', org: 'main', accountUuid: 'fake-uuid-main', organizationUuid: 'fake-org-main', recordId: recs[0].id } }));
  for (const rec of recs) {
    const name = rec.email.split('@')[0];
    const dir = join(data, 'accounts', 'claude', rec.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(login(name, names[name][2])));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: who(name, name) }));
  }
  // The last numbers the app read for the main login and the outdated copy, 3 hours ago.
  const at = Date.now() - 3 * 3_600_000;
  const cached = (name) => ({ key: `uuid:fake-uuid-${name}:fake-org-${name}`, usage: { accountId: `claude:${recs.find((r) => r.email.startsWith(name)).id}`, provider: 'claude', status: 'ok', plan: 'Team', email: `${name}@example.com`, windows: [{ id: '5h', usedPercent: 33, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, { id: '7d', usedPercent: 61, resetsAt: Math.floor(Date.now() / 1000) + 86_400 }], fetchedAt: at, source: 'live' } });
  writeFileSync(join(data, 'usage-cache.json'), JSON.stringify({ version: 2, entries: [cached('main'), cached('outdated'), cached('rejected')], backoff: {}, reads: {} }));
  const state = sshState({ projectPath: join(allRoot, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false };
  writeState(allRoot, state);
  const port = allServer.address().port;
  const app = await launchApp(allRoot, {
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${port}/token`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
  });
  const card = (name) => `[...document.querySelectorAll('.usage-card')].find((c) => c.textContent.includes('${name}@example.com'))`;
  try {
    await app.until(`${card('fresh')}?.textContent.includes('20%') && ${card('rejected')}?.textContent.includes('Logowanie wygasło') && ${card('outdated')}?.textContent.includes('Logowanie wygasło') && ${card('denied')}?.textContent.includes('HTTP 403') && ${card('cswapped')}?.textContent.includes('ma też cswap') && ${card('main')}?.textContent.includes('dane sprzed')`, 'all card states', 40_000);
    const [rejectedRow, outdatedRow] = [await app.evaluate(expiredRow(card('rejected'))), await app.evaluate(expiredRow(card('outdated')))];
    if (!rejectedRow || rejectedRow !== outdatedRow) throw new Error('expired rows differ');
    if (await app.evaluate(`${card('outdated')}.textContent.includes('%') || ${card('rejected')}.textContent.includes('%')`)) throw new Error('old numbers on an expired card');
    // No card carries more than one short line of text besides its numbers.
    const longest = await app.evaluate(`Math.max(...[...document.querySelectorAll('.usage-card .usage-note')].map((n) => n.textContent.length))`);
    if (longest > 110) throw new Error(`a card note is ${longest} characters long`);
    await shoot(app, '5-all-card-states.png');
  } finally { await app.close(); }
  console.log(`OK card states; screenshots in ${shots}`);
} finally {
  allServer.close();
  removeScratch(allRoot);
}
