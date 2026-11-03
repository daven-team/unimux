// Real-app check (1.1.2) of the automatic account switch, several Codex accounts and the resizable limits panel. Fake home,
// fake tokens, a local fake usage endpoint for Claude and Codex and a fake `codex` stand-in for `codex login`; never the real
// ~/.claude, ~/.codex, cswap data or the app data folder. OS notifications are not shown (Notification.show is replaced).
// Checks: the main Claude account at 96 % (threshold 95 %) is switched at once to the saved account with room, with one
// notification naming both; the panel shows the switch state and the auto-switch menu; the panel's top edge resizes it
// (remembered, double-click resets); "Dodaj konto Codex" signs in a second Codex account into its own profile; "make main"
// of a Codex card copies its auth.json into ~/.codex and saves the outgoing login into its own card; the settings group.
// Run: npm run build && node scripts/verify-auto-switch-ui.mjs [shots dir]   (default: <tmp>/unimux-auto-switch-shots)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { launchApp, mainInspector, scratchRoot, sleep, sshState, writeState } from './ssh-ui-lib.mjs';

if (!existsSync('out/main/index.js')) throw new Error('Build first: npm run build');
const shots = process.argv[2] ?? join(tmpdir(), 'unimux-auto-switch-shots');
mkdirSync(shots, { recursive: true });
const shoot = async (app, name, selector = '.usage-panel') => {
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const r = selector ? await app.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`) : null;
  const { data } = await app.cdp('Page.captureScreenshot', { format: 'png', ...(r ? { clip: { ...r, scale: 1 } } : {}) });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
};

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims) => `h.${b64(claims)}.s`;
const codexAuth = (name) => {
  const claim = { 'https://api.openai.com/auth': { chatgpt_user_id: `user-${name}`, chatgpt_account_id: `ws-${name}`, chatgpt_plan_type: 'plus' } };
  return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: jwt({ email: `${name}@example.com`, ...claim }), access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 86_400, name, ...claim }), refresh_token: `fake-refresh-${name}`, account_id: `ws-${name}` }, last_refresh: new Date().toISOString() });
};
const who = (name) => ({ emailAddress: `${name}@example.com`, organizationName: 'Rossmann', accountUuid: `fake-uuid-${name}`, organizationUuid: 'fake-org' });
const login = (name) => ({ claudeAiOauth: { accessToken: `fake-access-${name}`, refreshToken: `fake-refresh-${name}`, expiresAt: Date.now() + 8 * 3_600_000, scopes: ['user:inference'], subscriptionType: 'max' } });
const ids = { daniel: '11111111-1111-4111-8111-111111111111', support: '22222222-2222-4222-8222-222222222222' };
const codexId = '33333333-3333-4333-8333-333333333333';

// Per account (from the bearer token): Claude daniel 96 %, support 10 %; Codex alice 40 %, bob 5 %, carol 20 %.
const percents = { daniel: 96, support: 10, alice: 40, bob: 5, carol: 20 };
const seen = [];
let delayMs = 300;
const server = createServer((req, res) => {
  const auth = String(req.headers.authorization ?? '');
  seen.push({ path: req.url, auth: auth.slice(-24) });
  setTimeout(() => {
    if (req.url === '/usage') {
      const name = Object.keys(percents).find((n) => auth.includes(`fake-access-${n}`)) ?? 'daniel';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ five_hour: { utilization: percents[name], resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString() }, seven_day: { utilization: 30, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() } }));
      return;
    }
    if (req.url === '/codex') {
      const token = auth.replace(/^Bearer /, '');
      let name = 'alice';
      try { name = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).name; } catch { /* default */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: percents[name] ?? 1, limit_window_seconds: 18_000, reset_after_seconds: 3600 }, secondary_window: { used_percent: 12, limit_window_seconds: 604_800, reset_after_seconds: 86_400 } } }));
      return;
    }
    res.writeHead(404); res.end();
  }, req.url === '/usage' ? delayMs : 100);
});

const root = scratchRoot('auto-switch');
const ok = (text) => console.log(`OK ${text}`);
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const home = join(root, 'home');
  const data = join(root, 'data');
  // Claude: daniel is main (the live login), support is a saved account the app signed in itself.
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(login('daniel')));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: who('daniel'), projects: {} }));
  mkdirSync(join(data, 'accounts'), { recursive: true });
  writeFileSync(join(data, 'accounts', 'accounts.json'), JSON.stringify({ version: 2, claude: [
    { id: ids.daniel, addedAt: 1, email: 'daniel@example.com', org: 'Rossmann', accountUuid: 'fake-uuid-daniel', organizationUuid: 'fake-org', custody: 'live', family: 'live' },
    { id: ids.support, addedAt: 2, email: 'support@example.com', org: 'Rossmann', accountUuid: 'fake-uuid-support', organizationUuid: 'fake-org', custody: 'app', family: 'own' },
  ], live: { email: 'daniel@example.com', org: 'Rossmann', accountUuid: 'fake-uuid-daniel', organizationUuid: 'fake-org', recordId: ids.daniel } }));
  for (const [name, id] of Object.entries(ids)) {
    const dir = join(data, 'accounts', 'claude', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(login(name)));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: who(name) }));
  }
  // Codex: alice in ~/.codex (with config and a session that must stay), bob saved in its own profile.
  mkdirSync(join(home, '.codex', 'sessions', '2026', '11', '03'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), codexAuth('alice'));
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
  writeFileSync(join(home, '.codex', 'sessions', '2026', '11', '03', 'rollout-x.jsonl'), '{}\n');
  mkdirSync(join(data, 'codex-accounts', 'profiles', codexId), { recursive: true });
  writeFileSync(join(data, 'codex-accounts', 'profiles', codexId, 'auth.json'), codexAuth('bob'));
  writeFileSync(join(data, 'codex-accounts', 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: codexId, addedAt: 1, email: 'bob@example.com', userId: 'user-bob', accountId: 'ws-bob' }] }));
  // The fake `codex` for `codex login`: writes a login for carol into $CODEX_HOME/auth.json after a moment.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'fake-codex.cjs'), `const fs = require('fs'); const path = require('path');
console.log('fake codex ' + process.argv.slice(2).join(' '));
console.log('CODEX_HOME=' + process.env.CODEX_HOME);
setTimeout(() => { fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), ${JSON.stringify(codexAuth('carol'))}); console.log('Successfully logged in'); }, 1500);
`);
  writeFileSync(join(bin, 'codex.cmd'), `@echo off\r\nnode "%~dp0fake-codex.cjs" %*\r\n`);
  const state = sshState({ projectPath: join(root, 'project') });
  state.settings = {
    ...state.settings, showAiUsage: true, usageCollapsed: false, usageIntervalMinutes: 15,
    accountSwitch: { enabled: true, codex: false, fiveHour: { enabled: true, percent: 95 }, sevenDay: { enabled: true, percent: 98 }, mode: 'switch', cooldownMinutes: 15, target: {}, primary: { claude: 'daniel@example.com' }, returnHome: true },
  };
  writeState(root, state);
  const env = {
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${port}/token`, MC_USAGE_CODEX_URL: `http://127.0.0.1:${port}/codex`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
  };
  const card = (name) => `[...document.querySelectorAll('.usage-card')].find((c) => c.textContent.includes('${name}@example.com'))`;
  const inspectPort = 9300 + Math.floor(Math.random() * 500);
  const app = await launchApp(root, env, [`--inspect=${inspectPort}`]);
  const main = await mainInspector(inspectPort);
  await main.evaluate(`(() => { globalThis.__shown = []; __el.Notification.prototype.show = function () { __shown.push(this); }; return true; })()`);
  const shown = () => main.evaluate(`__shown.map((n) => ({ title: n.title, body: n.body }))`);
  try {
    // 1. The automatic switch: daniel at 96 % -> support.
    await app.until(`!!${card('support')} && !!${card('daniel')}`, 'cards', 30_000);
    const switched = async () => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).oauthAccount?.emailAddress === 'support@example.com';
    for (let i = 0; i < 60 && !(await switched()); i++) await sleep(500);
    if (!(await switched())) throw new Error(`no automatic switch: ${JSON.stringify(await shown())} ${JSON.stringify(await app.evaluate('window.mc.getUsage().then((s) => s.providers.map((p) => [p.accountId, p.email, p.status, p.source, p.active, p.managed, p.heldBy, p.error, p.windows.map((w) => w.usedPercent).join("/")]))'))}`);
    const creds = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8'));
    if (creds.claudeAiOauth.accessToken !== 'fake-access-support') throw new Error('the live credentials are not support\'s');
    ok('daniel at 96 % (threshold 95 %): Claude Code\'s live login is now support (credentials and .claude.json)');
    await sleep(1000);
    let notes = await shown();
    const expected = 'Przełączono na support@example.com: limit 5 h konta daniel@example.com wykorzystany w 96%';
    if (!notes.some((n) => n.body === expected)) throw new Error(`notification: ${JSON.stringify(notes)}`);
    ok(`one notification: "${expected}"`);
    // Its backup of daniel's login: the record holds the live copy that left.
    const danielCopy = JSON.parse(readFileSync(join(data, 'accounts', 'claude', ids.daniel, '.credentials.json'), 'utf8'));
    if (danielCopy.claudeAiOauth.accessToken !== 'fake-access-daniel') throw new Error('daniel\'s login was not kept on its card');
    ok('daniel\'s login is kept on its card');
    await app.until(`${card('support')}?.textContent.includes('główne')`, 'support marked main', 30_000);
    await app.until(`!!document.querySelector('.usage-auto-line')`, 'state line');
    const line = await app.evaluate(`document.querySelector('.usage-auto-line').textContent`);
    if (line !== 'Auto: wł. · największy zapas · wraca na daniel@example.com') throw new Error(`state line: ${line}`);
    ok(`the panel shows "${line}"`);
    await sleep(1500);
    notes = await shown();
    if (notes.filter((n) => n.body.startsWith('Przełączono')).length !== 1) throw new Error(`repeated switch notices: ${JSON.stringify(notes)}`);
    await shoot(app, '1-after-auto-switch.png');

    // 2. The auto-switch menu in the panel header.
    await app.click('.usage-auto-btn');
    await app.until(`[...document.querySelectorAll('.menu button')].some((b) => b.textContent.includes('Konto z największym zapasem'))`, 'auto menu');
    const items = await app.evaluate(`[...document.querySelectorAll('.menu button, .menu [role=presentation], .menu .menu-header')].map((b) => b.textContent.trim()).filter(Boolean)`);
    ok(`header menu: ${items.join(' | ')}`);
    const { data: menuShot } = await app.cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, '2-auto-switch-menu.png'), Buffer.from(menuShot, 'base64'));
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

    // 3. Resizing the panel by its top edge (remembered; double-click resets).
    const before = await app.evaluate(`document.querySelector('.side-panel > .usage-panel').offsetHeight`);
    const handle = await app.evaluate(`(() => { const b = document.querySelector('.usage-resize').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + 2 }; })()`);
    await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y - i * 30, button: 'left', buttons: 1 });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x, y: handle.y - 180, button: 'left', clickCount: 1 });
    await sleep(300);
    const after = await app.evaluate(`document.querySelector('.side-panel > .usage-panel').offsetHeight`);
    const saved = await app.evaluate(`localStorage.getItem('mc-usage-height-v1')`);
    if (!(after > before + 100) || !saved) throw new Error(`resize: ${before} -> ${after}, saved ${saved}`);
    ok(`dragging the top edge 180 px up: ${before} px -> ${after} px (saved ${saved} px)`);
    await shoot(app, '3-panel-taller.png', '.side-panel');
    await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y - 180, button: 'left', clickCount: 1 });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x, y: handle.y - 180, button: 'left', clickCount: 1 });
    await app.evaluate(`document.querySelector('.usage-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true`);
    await sleep(300);
    const reset = await app.evaluate(`({ h: document.querySelector('.side-panel > .usage-panel').offsetHeight, saved: localStorage.getItem('mc-usage-height-v1') })`);
    if (reset.saved !== null || reset.h > before + 5) throw new Error(`double-click reset: ${JSON.stringify(reset)}`);
    ok(`double-click resets the height (${reset.h} px, nothing saved)`);

    // 4. A second Codex account: "Dodaj konto Codex" runs `codex login` with CODEX_HOME at a new profile.
    await app.until(`!!${card('bob')} && !!${card('alice')}`, 'codex cards', 30_000);
    await app.click('.usage-head button[aria-label="Dodaj konto"]');
    await app.until(`[...document.querySelectorAll('.menu button')].some((b) => b.textContent.includes('Dodaj konto Codex'))`, 'add codex entry');
    await app.evaluate(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Dodaj konto Codex')).click(), true`);
    await app.until(`document.querySelector('.modal.auth h3')?.textContent === 'Dodaj konto Codex'`, 'auth modal');
    await app.until(`document.querySelector('.auth-status')?.textContent.includes('Zalogowano jako carol@example.com')`, 'codex login success', 40_000);
    await shoot(app, '4-codex-login.png', '.modal.auth');
    ok('"Dodaj konto Codex": the fake codex wrote the login into the new profile, the dialog says "Zalogowano jako carol@example.com"');
    await app.until(`!!${card('carol')}`, 'carol card', 30_000);
    const codexFile = JSON.parse(readFileSync(join(data, 'codex-accounts', 'accounts.json'), 'utf8'));
    if (codexFile.accounts.length !== 2 || JSON.stringify(codexFile).includes('fake-refresh')) throw new Error(`codex accounts.json: ${JSON.stringify(codexFile)}`);
    if (JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')).tokens.refresh_token !== 'fake-refresh-alice') throw new Error('the live ~/.codex login changed during a profile login');
    ok('carol saved in its own profile; ~/.codex/auth.json untouched; accounts.json holds no token');

    // 5. Make bob the main Codex account.
    const result = await app.evaluate(`window.mc.makeMainCodexAccount(${JSON.stringify(codexId)})`);
    if (!result.ok) throw new Error(`codex make main: ${JSON.stringify(result)}`);
    const liveCodex = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'));
    if (liveCodex.tokens.refresh_token !== 'fake-refresh-bob') throw new Error('~/.codex/auth.json is not bob\'s');
    if (readFileSync(join(home, '.codex', 'config.toml'), 'utf8') !== 'model = "gpt-5"\n' || !existsSync(join(home, '.codex', 'sessions', '2026', '11', '03', 'rollout-x.jsonl'))) throw new Error('config or sessions changed');
    const after5 = JSON.parse(readFileSync(join(data, 'codex-accounts', 'accounts.json'), 'utf8'));
    const alice = after5.accounts.find((a) => a.email === 'alice@example.com');
    if (!alice || JSON.parse(readFileSync(join(data, 'codex-accounts', 'profiles', alice.id, 'auth.json'), 'utf8')).tokens.refresh_token !== 'fake-refresh-alice') throw new Error('alice was not saved into a card of her own');
    ok('Codex "make main": bob in ~/.codex/auth.json, config.toml and sessions unchanged, alice saved on her own card');
    await app.until(`!!${card('alice')} && ${card('bob')}?.textContent.includes('główne')`, 'codex cards after the swap', 30_000);
    await shoot(app, '5-codex-after-make-main.png');

    // 6. The settings group.
    await app.click('.tb-btn[aria-label="Ustawienia"]');
    await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent.includes('Powiadomienia'))`, 'settings');
    await app.click('.settings-nav [role=tab]', 'Powiadomienia');
    await app.until(`!!document.querySelector('#settings-switch-enabled')`, 'switch settings');
    const group = `[...document.querySelectorAll('.settings-group')].find((g) => g.querySelector('#settings-switch-enabled'))`;
    await app.evaluate(`(() => { const g = ${group}; g.id = 'switch-group'; g.scrollIntoView(); return true; })()`);
    await shoot(app, '6-settings-auto-switch.png', '#switch-group');
    ok('settings group screenshot');
  } finally { main.close(); await app.close(); }
  console.log(`screenshots: ${shots}`);
} finally {
  server.close();
  removeScratch(root);
}
