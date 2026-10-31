// Real-app check (1.1.1) of the AI limits panel after a restart and of the limit warnings. Fake home, fake tokens, a local
// fake usage/token endpoint (slow on purpose, so the state before the first read can be seen); never the real ~/.claude,
// cswap data or the app data folder. The OS notification is not shown: Notification.show is replaced in the main process.
// Checks: a restart with a 1.1.0 usage cache shows the expired and switched-out cards as "Sign-in expired" at once (never
// their old numbers) and reads every account right away although the last reads were a minute ago; the refresh button reads
// at once and spins until the reads are back; crossing the 5-hour threshold gives exactly one notification (not again on the
// next read nor after a restart); a click on it opens the limits panel. Screenshots of the settings group and the panel.
// Run: npm run build && node scripts/verify-limits-ui.mjs [shots dir]   (default: <tmp>/unimux-limits-shots)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { launchApp, mainInspector, scratchRoot, sleep, sshState, writeState } from './ssh-ui-lib.mjs';

const shots = process.argv[2] ?? join(tmpdir(), 'unimux-limits-shots');
mkdirSync(shots, { recursive: true });
const shoot = async (app, name, selector = '.usage-panel') => {
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
  await app.evaluate(`(() => { if (!document.getElementById('shot-style')) { const s = document.createElement('style'); s.id = 'shot-style'; s.textContent = '.side-panel > .usage-panel, .usage-panel { max-height: none !important; }'; document.head.appendChild(s); } return true; })()`);
  await sleep(300);
  const r = selector ? await app.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`) : null;
  const { data } = await app.cdp('Page.captureScreenshot', { format: 'png', ...(r ? { clip: { ...r, scale: 1 } } : {}) });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
};
const who = (name, org = 'Rossmann') => ({ emailAddress: `${name}@example.com`, organizationName: org, accountUuid: `fake-uuid-${name}`, organizationUuid: `fake-org-${org}` });
const login = (n, expiresAt, plan = 'team') => ({ claudeAiOauth: { accessToken: `fake-access-${n}`, refreshToken: `fake-refresh-${n}`, expiresAt, scopes: ['user:inference'], subscriptionType: plan, rateLimitTier: 'default_claude_max_5x' } });
const ids = { support: '11111111-1111-4111-8111-111111111111', daniel: '22222222-2222-4222-8222-222222222222', app: '33333333-3333-4333-8333-333333333333' };
const key = (name, org = 'Rossmann') => `uuid:fake-uuid-${name}:fake-org-${org}`;

let fivePercent = 12;
let delayMs = 3000;
const seen = [];
const server = createServer((req, res) => {
  const entry = { path: req.url, auth: String(req.headers.authorization ?? ''), at: Date.now(), body: '' };
  seen.push(entry);
  setTimeout(() => {
    if (req.url === '/token') {
      // The app account's renewal is rejected (like APP_ChatGPT-MGMT in the report).
      req.on('data', (chunk) => { entry.body += chunk; });
      req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant' })); });
      req.resume();
      return;
    }
    if (req.url !== '/usage') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ five_hour: { utilization: fivePercent, resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString() }, seven_day: { utilization: 40, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() } }));
  }, delayMs);
});

const root = scratchRoot('limits');
const results = [];
let lastRead = 0;
const ok = (text) => { results.push(text); console.log(`OK ${text}`); };
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const home = join(root, 'home');
  const data = join(root, 'data');
  mkdirSync(join(home, '.claude'), { recursive: true });
  // support is main with a valid login; daniel's saved copy was switched out elsewhere and ran out; app's renewal is rejected.
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(login('support', Date.now() + 8 * 3_600_000, 'max')));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: who('support', 'support'), projects: {} }));
  const records = [
    { id: ids.support, addedAt: 1, email: 'support@example.com', org: 'support', accountUuid: 'fake-uuid-support', organizationUuid: 'fake-org-support', custody: 'live', family: 'live' },
    { id: ids.daniel, addedAt: 2, email: 'daniel@example.com', org: 'Rossmann', accountUuid: 'fake-uuid-daniel', organizationUuid: 'fake-org-Rossmann', custody: 'foreign', family: 'live' },
    { id: ids.app, addedAt: 3, email: 'app@example.com', org: 'Rossmann', accountUuid: 'fake-uuid-app', organizationUuid: 'fake-org-Rossmann', custody: 'app', family: 'own' },
  ];
  mkdirSync(join(data, 'accounts'), { recursive: true });
  writeFileSync(join(data, 'accounts', 'accounts.json'), JSON.stringify({ version: 2, claude: records, live: { email: 'support@example.com', org: 'support', accountUuid: 'fake-uuid-support', organizationUuid: 'fake-org-support', recordId: ids.support } }));
  const copies = { support: login('support', Date.now() + 8 * 3_600_000, 'max'), daniel: login('daniel', Date.now() - 3_600_000), app: login('app', Date.now() - 60_000) };
  for (const [name, id] of Object.entries(ids)) {
    const dir = join(data, 'accounts', 'claude', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(copies[name]));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: who(name, name === 'support' ? 'support' : 'Rossmann') }));
  }
  // What 1.1.0 left behind a minute before the restart: the expired cards with their status and their last numbers.
  const readAt = Date.now() - 60_000;
  const windows = (five, seven) => [{ id: '5h', usedPercent: five, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, { id: '7d', usedPercent: seven, resetsAt: Math.floor(Date.now() / 1000) + 86_400 }];
  const entry = (name, org, id, usage) => ({ key: key(name, org), usage: { accountId: `claude:${id}`, provider: 'claude', plan: 'Team', email: `${name}@example.com`, fetchedAt: readAt - 600_000, source: 'live', windows: windows(33, 61), ...usage } });
  writeFileSync(join(data, 'usage-cache.json'), JSON.stringify({
    version: 2,
    entries: [
      entry('support', 'support', ids.support, { status: 'ok', windows: windows(5, 20) }),
      entry('daniel', 'Rossmann', ids.daniel, { status: 'elsewhere', source: 'cache', heldBy: 'switched-out', windows: windows(77, 88) }),
      entry('app', 'Rossmann', ids.app, { status: 'expired', source: 'cache', error: 'refresh-dead', windows: windows(55, 66) }),
    ],
    backoff: {},
    reads: { [key('support', 'support')]: readAt, [key('daniel')]: readAt, [key('app')]: readAt },
  }));
  const state = sshState({ projectPath: join(root, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false, usageIntervalMinutes: 15 };
  writeState(root, state);
  const env = {
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${port}/token`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
  };
  const card = (name) => `[...document.querySelectorAll('.usage-card')].find((c) => c.textContent.includes('${name}@example.com'))`;
  const usageReads = () => seen.filter((r) => r.path === '/usage' && r.auth.includes('support')).length;
  const stubNotifications = (main) => main.evaluate(`(() => { globalThis.__shown = []; __el.Notification.prototype.show = function () { __shown.push(this); }; return true; })()`);
  const shown = (main) => main.evaluate(`__shown.map((n) => ({ title: n.title, body: n.body }))`);

  // 1. Restart with the cache: the expired cards say so before any read is back; every account is read at once.
  const inspectPort = 9300 + Math.floor(Math.random() * 500);
  const started = Date.now();
  let app = await launchApp(root, env, [`--inspect=${inspectPort}`]);
  let main = await mainInspector(inspectPort);
  await stubNotifications(main);
  try {
    await app.until(`!!${card('daniel')} && !!${card('app')} && !!${card('support')}`, 'cards from the cache');
    const early = await app.evaluate(`({ daniel: ${card('daniel')}.textContent, app: ${card('app')}.textContent, support: ${card('support')}.textContent })`);
    if (!early.daniel.includes('Logowanie wygasło') || !early.app.includes('Logowanie wygasło')) throw new Error(`expired cards right after the start: ${JSON.stringify(early)}`);
    if (/\d+%/.test(early.daniel) || /\d+%/.test(early.app)) throw new Error(`old numbers on an expired card: ${JSON.stringify(early)}`);
    if (!early.support.includes('5%') || !early.support.includes('dane sprzed')) throw new Error(`support card before its read: ${early.support}`);
    ok(`expired and switched-out cards show "Sign-in expired" from the cache ${Date.now() - started} ms after the launch (no read back yet)`);
    await shoot(app, '1-restart-before-first-read.png');
    try {
      await app.until(`${card('support')}.textContent.includes('12%') && !${card('support')}.textContent.includes('dane sprzed')`, 'support read at once', 30_000);
    } catch (error) {
      console.log(await app.evaluate(`[...document.querySelectorAll('.usage-card')].map((c) => c.textContent).join(' | ')`), JSON.stringify(seen.map((r) => [r.path, r.auth.slice(-12), r.at - started])));
      throw error;
    }
    const firstRead = seen.find((r) => r.path === '/usage' && r.auth.includes('support'));
    if (!firstRead || firstRead.at - started > 15_000) throw new Error('support was not read right away');
    ok(`every account read right away at start (support's usage asked ${firstRead.at - started} ms after the launch, last read was 60 s before)`);
    await app.until(`${card('daniel')}.textContent.includes('Logowanie wygasło') && ${card('app')}.textContent.includes('Logowanie wygasło')`, 'still expired after the read');
    await shoot(app, '2-restart-after-first-read.png');
    if ((await shown(main)).length) throw new Error('a notification below the threshold');

    // 2. The refresh button reads at once (past the 30 s guard), spins until the read is back. Crossing 80 %: one warning.
    await sleep(Math.max(0, firstRead.at + 31_000 - Date.now()));
    fivePercent = 85;
    const before = usageReads();
    const pressed = Date.now();
    await app.click('.usage-head button[aria-label="Odśwież limity"]');
    await app.until(`!!document.querySelector('.usage-head .refresh-icon.spinning')`, 'spinner', 3000);
    await sleep(delayMs - 1500);
    if (!(await app.evaluate(`!!document.querySelector('.usage-head .refresh-icon.spinning')`))) throw new Error('the spinner stopped before the read was back');
    await app.until(`${card('support')}.textContent.includes('85%')`, 'refreshed numbers', 20_000);
    await app.until(`!document.querySelector('.usage-head .refresh-icon.spinning')`, 'spinner stops');
    if (usageReads() !== before + 1) throw new Error(`refresh reads: ${usageReads() - before}`);
    ok(`the refresh button read support at once (${Date.now() - pressed} ms with a ${delayMs} ms slow server) and spun until the read was back`);
    await sleep(500);
    let notes = await shown(main);
    if (notes.length !== 1 || notes[0].body !== `Konto support@example.com: limit 5 h wykorzystany w 85%, reset o ${new Date(Date.now() + 2 * 3_600_000).toLocaleTimeString('pl', { hour: '2-digit', minute: '2-digit' })}` || notes[0].title !== 'Limity kont AI') throw new Error(`notifications: ${JSON.stringify(notes)}`);
    ok(`one notification: "${notes[0].title}: ${notes[0].body}"`);
    await shoot(app, '3-after-refresh-85.png');

    // 3. The next read (still above, higher): no second notification.
    delayMs = 500;
    await sleep(31_000);
    fivePercent = 92;
    lastRead = Date.now();
    await app.click('.usage-head button[aria-label="Odśwież limity"]');
    await app.until(`${card('support')}.textContent.includes('92%')`, 'refreshed 92', 20_000);
    await sleep(500);
    notes = await shown(main);
    if (notes.length !== 1) throw new Error(`a repeated notification: ${JSON.stringify(notes)}`);
    ok('no second notification in the same reset period');

    // 4. A click on the notification brings the limits panel (the side panel was folded away, the limits collapsed).
    await app.evaluate(`document.querySelector('.rail-tile.on')?.click(), true`);
    await app.until(`!!document.querySelector('.sidebar.collapsed')`, 'sidebar folded');
    await main.evaluate(`(() => { __shown[0].emit('click'); return true; })()`);
    await app.until(`!document.querySelector('.sidebar.collapsed') && !!document.querySelector('.side-panel .usage-panel .usage-card')`, 'limits panel opened by the click');
    ok('a click on the notification unfolds the side panel with the limits');

    // 5. Settings: the new group, screenshot.
    await app.click('.tb-btn[aria-label="Ustawienia"]');
    await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent.includes('Powiadomienia'))`, 'settings');
    await app.click('.settings-nav [role=tab]', 'Powiadomienia');
    await app.until(`!!document.querySelector('#settings-limits-enabled')`, 'limit settings');
    const group = `[...document.querySelectorAll('.settings-group')].find((g) => g.querySelector('#settings-limits-enabled'))`;
    const values = await app.evaluate(`({ on: document.querySelector('#settings-limits-enabled').checked, five: document.querySelector('#settings-limit-fiveHour-percent').textContent.trim(), seven: document.querySelector('#settings-limit-sevenDay-percent').textContent.trim(), resets: document.querySelector('#settings-limits-resets').checked })`);
    if (JSON.stringify(values) !== JSON.stringify({ on: true, five: 'od 80%', seven: 'od 90%', resets: false })) throw new Error(`defaults: ${JSON.stringify(values)}`);
    await app.evaluate(`(() => { const g = ${group}; g.id = 'limits-group'; g.scrollIntoView(); return true; })()`);
    await shoot(app, '4-settings-limit-warnings.png', '#limits-group');
    await app.evaluate(`[...${group}.querySelectorAll('button')].find((b) => b.textContent === 'Test').click(), true`);
    await sleep(500);
    notes = await shown(main);
    if (notes.length !== 2 || !notes[1].body.startsWith('Konto support@example.com: limit 5 h wykorzystany w 80%')) throw new Error(`test notification: ${JSON.stringify(notes)}`);
    ok(`the Test button shows a sample: "${notes[1].body}"`);
    await shoot(app, '5-settings-page.png', null);
  } finally { main.close(); await app.close(); }

  // 6. Another restart: the warning is remembered (no repeat), the expired cards are expired at once again.
  delayMs = 3000;
  // Past the 30 s start guard, so the restart really reads the account again (still at 92 %).
  await sleep(Math.max(0, lastRead + 31_000 - Date.now()));
  app = await launchApp(root, env, [`--inspect=${inspectPort + 1}`]);
  main = await mainInspector(inspectPort + 1);
  await stubNotifications(main);
  try {
    await app.until(`!!${card('daniel')} && ${card('daniel')}.textContent.includes('Logowanie wygasło') && ${card('app')}.textContent.includes('Logowanie wygasło')`, 'expired after the second restart', 5000);
    await app.until(`${card('support')}.textContent.includes('92%') && !${card('support')}.textContent.includes('dane sprzed')`, 'support read at the restart', 30_000);
    await sleep(500);
    const notes = await shown(main);
    if (notes.length) throw new Error(`a warning repeated after a restart: ${JSON.stringify(notes)}`);
    ok('after another restart: expired at once, the warning not repeated');
  } finally { main.close(); await app.close(); }
  const stored = readFileSync(join(data, 'limit-alerts.json'), 'utf8');
  if (/fake-access|fake-refresh/.test(stored)) throw new Error('limit-alerts.json contains a token');
  if (seen.some((r) => r.auth.includes('daniel'))) throw new Error('the switched-out copy was sent somewhere');
  console.log(`OK limits (${results.length} checks); screenshots in ${shots}`);
} finally {
  server.close();
  removeScratch(root);
}
