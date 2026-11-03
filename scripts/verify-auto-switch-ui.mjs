// Real-app check (1.1.2) of the automatic account switch, several Codex accounts and the resizable limits panel. Fake home,
// fake tokens, a local fake usage endpoint for Claude and Codex and a fake `codex` stand-in for `codex login`; never the real
// ~/.claude, ~/.codex, cswap data or the app data folder. OS notifications are not shown (Notification.show is replaced).
// Checks: the main Claude account at 96 % (threshold 95 %) is switched at once to the saved account with room, with one
// notification naming both; the panel shows the switch state and the Switcher card (a popover: contents, keys, Esc, outside click, narrow panel, zoom); the panel's top edge resizes it
// (remembered, double-click resets); "Dodaj konto Codex" signs in a second Codex account into its own profile; "make main"
// of a Codex card copies its auth.json into ~/.codex and saves the outgoing login into its own card; the header says
// "Konta i limity" on one line next to the "Switcher" switch; the card's "Wszystkie ustawienia…" opens the
// settings section "Konta i limity" at the switcher; the thresholds are sliders (keys, and a drag saved once on release);
// the settings search finds the moved rows.
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
    if (line !== 'pilnuje limitów: 5 h 95%, 7 d 98% · największy zapas · wraca na daniel@example.com') throw new Error(`state line: ${line}`);
    if (!(await app.evaluate(`document.querySelector('.usage-auto-switch').checked`))) throw new Error('the Switcher switch in the header is not on');
    ok(`the panel shows "${line}"`);
    await sleep(1500);
    notes = await shown();
    if (notes.filter((n) => n.body.startsWith('Przełączono')).length !== 1) throw new Error(`repeated switch notices: ${JSON.stringify(notes)}`);
    await shoot(app, '1-after-auto-switch.png');

    // 2. The Switcher card opens from the state line under the header (a styled popover, not a context menu).
    const keyPress = async (key, code) => {
      await app.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code });
      await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
    };
    const mouseAt = async (x, y, button = 'left') => {
      for (const type of ['mousePressed', 'mouseReleased']) await app.cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: 1 });
    };
    const centerOf = (selector) => app.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    const popRect = () => app.evaluate(`(() => { const p = document.querySelector('.switcher-pop.on'); if (!p) return null; const b = p.getBoundingClientRect(); const s = document.querySelector('.side-panel').getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, sideLeft: s.left, sideRight: s.right, vw: innerWidth, vh: innerHeight, scroll: p.scrollHeight > p.clientHeight }; })()`);
    const shootPop = async (name) => {
      const b = await popRect();
      const x = Math.max(0, Math.min(b.left, b.sideLeft) - 8);
      const y = Math.max(0, b.top - 40);
      const { data } = await app.cdp('Page.captureScreenshot', { format: 'png', clip: { x, y, width: Math.min(b.vw - x, Math.max(b.right, b.sideRight) - x + 8), height: Math.min(b.vh - y, b.bottom - y + 60), scale: 1 } });
      writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
    };
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const line0 = await centerOf('.usage-auto-line');
    await mouseAt(line0.x, line0.y);
    await app.until(`!!document.querySelector('.switcher-pop.on')`, 'switcher card');
    if (await app.evaluate(`!!document.querySelector('.menu')`)) throw new Error('a context menu opened instead of the card');
    await app.until(`document.activeElement?.id === 'switcher-pop-enabled'`, 'focus in the card');
    const pop = await app.evaluate(`(() => { const p = document.querySelector('.switcher-pop'); return {
      role: p.getAttribute('role'), title: p.querySelector('.switcher-pop-title').textContent, on: p.querySelector('#switcher-pop-enabled').checked,
      modes: [...p.querySelectorAll('[role=radio]')].map((b) => b.textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : '')),
      selects: [...p.querySelectorAll('.switcher-pop-field > label')].map((l) => l.textContent),
      sliders: [...p.querySelectorAll('input[type=range]')].map((r) => r.id + '=' + r.value),
      switches: [...p.querySelectorAll('.switcher-pop-switch span')].map((s) => s.textContent),
      link: p.querySelector('.switcher-pop-link').textContent }; })()`);
    if (pop.role !== 'dialog' || pop.title !== 'Switcher' || !pop.on || pop.modes.join('|') !== 'Zapytaj|Przełącz od razu*'
      || pop.selects.join('|') !== 'Przełączaj na|Konto podstawowe' || pop.sliders.join('|') !== 'switcher-pop-fiveHour=95|switcher-pop-sevenDay=98'
      || pop.switches.join('|') !== 'Wracaj na konto podstawowe po resecie|Także konta Codex' || pop.link !== 'Wszystkie ustawienia…') throw new Error(`card: ${JSON.stringify(pop)}`);
    ok(`the Switcher card: ${JSON.stringify(pop)}`);
    let b = await popRect();
    if (b.left < b.sideLeft - 1 || b.right > b.sideRight + 1) ok(`the card sits next to the side panel (${Math.round(b.left)}..${Math.round(b.right)}, side panel ${Math.round(b.sideLeft)}..${Math.round(b.sideRight)})`);
    else ok(`the card sits over the side panel (${Math.round(b.left)}..${Math.round(b.right)})`);
    if (b.left < 0 || b.right > b.vw || b.top < 0 || b.bottom > b.vh) throw new Error(`the card leaves the window: ${JSON.stringify(b)}`);
    await shootPop('2-switcher-card.png');
    // The target select lists the accounts with their plan and current use.
    await app.click('#switcher-pop-target-claude');
    await app.until(`!!document.querySelector('.select-popup')`, 'target list');
    const targets = await app.evaluate(`[...document.querySelectorAll('.select-popup .select-option-label')].map((o) => o.textContent)`);
    if (targets[0] !== 'Największy zapas' || !targets.some((t) => /^support@example\.com · max · 5 h 10% · 7 d 30%$/i.test(t))) throw new Error(`target list: ${JSON.stringify(targets)}`);
    ok(`"Przełączaj na": ${targets.join(' | ')}`);
    await shootPop('2b-switcher-target-list.png');
    // Esc closes the list first, the card stays.
    await keyPress('Escape', 27);
    await app.until(`!document.querySelector('.select-popup')`, 'list closed');
    if (!(await app.evaluate(`!!document.querySelector('.switcher-pop.on')`))) throw new Error('Esc in the list closed the card');
    // The mode: arrow keys in the segmented control, applied at once.
    await app.evaluate(`document.querySelector('.switcher-pop [role=radio][aria-checked=true]').focus()`);
    await keyPress('ArrowLeft', 37);
    await app.until(`window.mc.loadSnapshot().then((snap) => snap.state.settings.accountSwitch.mode === 'ask')`, 'mode ask saved', 3000);
    if ((await app.evaluate(`document.activeElement?.dataset.mode`)) !== 'ask') throw new Error('focus did not follow the segment');
    await keyPress('ArrowRight', 39);
    await app.until(`window.mc.loadSnapshot().then((snap) => snap.state.settings.accountSwitch.mode === 'switch')`, 'mode switch saved', 3000);
    ok('the segmented control: arrows move between "Zapytaj" and "Przełącz od razu", saved at once');
    // A threshold in the card: PageUp +10 is capped at 100, saved after the pause.
    await app.evaluate(`document.querySelector('#switcher-pop-fiveHour').focus()`);
    await keyPress('ArrowLeft', 37);
    await keyPress('ArrowLeft', 37);
    if ((await app.evaluate(`window.mc.loadSnapshot().then((snap) => snap.state.settings.accountSwitch.fiveHour.percent)`)) !== 95) throw new Error('the slider saved at once');
    await app.until(`window.mc.loadSnapshot().then((snap) => snap.state.settings.accountSwitch.fiveHour.percent === 93)`, 'card slider saved', 3000);
    await keyPress('ArrowRight', 39);
    await keyPress('ArrowRight', 39);
    await app.until(`window.mc.loadSnapshot().then((snap) => snap.state.settings.accountSwitch.fiveHour.percent === 95)`, 'card slider back to 95', 3000);
    ok('the card\'s 5 h slider: two arrows -> 93 % saved after the pause (not at once), back to 95 %');
    // Tab walks through the card's controls.
    await app.evaluate(`document.querySelector('#switcher-pop-enabled').focus()`);
    const order = [];
    for (let i = 0; i < 10; i++) {
      await app.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      order.push(await app.evaluate(`document.activeElement?.closest('.switcher-pop') ? (document.activeElement.id || document.activeElement.textContent) : 'OUT:' + document.activeElement?.className`));
      if (order.at(-1) === 'Wszystkie ustawienia…') break;
    }
    if (order.at(-1) !== 'Wszystkie ustawienia…') throw new Error(`Tab order: ${order.join(' > ')}`);
    ok(`Tab order: ${order.join(' > ')}`);
    // Esc closes the card and gives the focus back to the row.
    await app.evaluate(`document.querySelector('#switcher-pop-enabled').focus()`);
    await keyPress('Escape', 27);
    await app.until(`!document.querySelector('.switcher-pop')`, 'card closed by Esc');
    await app.until(`document.activeElement?.classList.contains('usage-auto-line')`, 'focus back on the row');
    ok('Esc closes the card and the focus goes back to the state row');
    // A right click on the header switch opens it too; a click elsewhere closes it.
    const toggle = await centerOf('.usage-auto');
    await mouseAt(toggle.x, toggle.y, 'right');
    await app.until(`!!document.querySelector('.switcher-pop.on')`, 'card from the header switch');
    if (!(await app.evaluate(`document.querySelector('.usage-auto-switch').checked`))) throw new Error('the right click toggled the switch');
    await mouseAt(700, 500);
    await app.until(`!document.querySelector('.switcher-pop')`, 'card closed by a click outside');
    ok('a right click on the header switch opens the card (the switch stays on); a click elsewhere closes it');
    // A narrow side panel: the card opens to its right. Zoom 125 % and 150 % (smaller CSS viewport): it stays in the window.
    for (const [zoom, width] of [[1, 200], [1.25, 0], [1.5, 0]]) {
      await app.cdp('Emulation.setDeviceMetricsOverride', { width: Math.round(1280 / zoom), height: Math.round(1000 / zoom), deviceScaleFactor: zoom, mobile: false });
      await app.evaluate(`(() => { document.querySelector('.side-panel').style.width = ${width ? `'${width}px'` : `''`}; return true; })()`);
      await sleep(300);
      await app.evaluate(`document.querySelector('.usage-auto-line').click(), true`);
      await app.until(`!!document.querySelector('.switcher-pop.on')`, `card at ${zoom * 100} %`);
      await sleep(200);
      b = await popRect();
      if (b.left < 0 || b.right > b.vw + 0.5 || b.top < 0 || b.bottom > b.vh + 0.5) throw new Error(`zoom ${zoom}: the card leaves the window ${JSON.stringify(b)}`);
      if (width && b.left < b.sideRight) throw new Error(`narrow side panel: the card is not to its right ${JSON.stringify(b)}`);
      ok(`${zoom * 100} %${width ? `, side panel ${width} px` : ''}: the card fits (${Math.round(b.left)},${Math.round(b.top)}..${Math.round(b.right)},${Math.round(b.bottom)} of ${b.vw}x${b.vh}${b.scroll ? ', scrolls inside' : ''})`);
      const { data } = await app.cdp('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(shots, `2c-switcher-card-${width ? 'narrow' : `zoom${zoom * 100}`}.png`), Buffer.from(data, 'base64'));
      await keyPress('Escape', 27);
      await app.until(`!document.querySelector('.switcher-pop')`, 'closed');
    }
    await app.evaluate(`(() => { document.querySelector('.side-panel').style.width = ''; return true; })()`);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

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

    // 6. The header: the title on one line, the "Switcher" switch; then the settings section through the menu's link.
    const head = await app.evaluate(`(() => { const t = document.querySelector('.usage-title-text'); return { title: t.textContent, oneLine: getComputedStyle(t).whiteSpace === 'nowrap' && t.getBoundingClientRect().height < 20, label: document.querySelector('.usage-auto-label').textContent, aria: document.querySelector('.usage-panel').getAttribute('aria-label') }; })()`);
    if (head.title !== 'Konta i limity' || head.aria !== 'Konta i limity' || !head.oneLine) throw new Error(`panel title: ${JSON.stringify(head)}`);
    if (head.label !== 'Switcher') throw new Error(`header switch label: ${head.label}`);
    ok(`the header says "${head.title}" on one line with the "${head.label}" switch`);
    await app.evaluate(`(() => { document.querySelector('.usage-head').id = 'usage-head-shot'; return true; })()`);
    await shoot(app, '6-panel-header.png', '#usage-head-shot');
    // A narrow side panel ellipsizes the title instead of wrapping it.
    const narrow = await app.evaluate(`(() => { const p = document.querySelector('.side-panel'); const old = p.style.width; p.style.width = '190px'; const t = document.querySelector('.usage-title-text'); const r = { truncated: t.scrollWidth > t.clientWidth, height: t.getBoundingClientRect().height, auto: document.querySelector('.usage-auto').getBoundingClientRect().width }; p.style.width = old; return r; })()`);
    if (narrow.height > 20 || narrow.auto < 40) throw new Error(`narrow header: ${JSON.stringify(narrow)}`);
    ok(`narrow side panel: the title stays on one line (${narrow.truncated ? 'ellipsized' : 'fits'}), the Switcher keeps its label`);
    await app.click('.usage-auto-line');
    await app.until(`!!document.querySelector('.switcher-pop.on .switcher-pop-link')`, 'Switcher card (settings link)');
    await app.click('.switcher-pop-link');
    await app.until(`!document.querySelector('.switcher-pop')`, 'card closed by its link');
    await app.until(`document.querySelector('.settings-content h2')?.textContent === 'Konta i limity' && !!document.querySelector('#settings-switch-enabled')`, 'settings section Konta i limity');
    await app.until(`document.activeElement?.id === 'settings-switch-enabled'`, 'switcher row focused');
    const nav = await app.evaluate(`[...document.querySelectorAll('.settings-nav [role=tab]')].map((t) => t.textContent + (t.getAttribute('aria-selected') === 'true' ? '*' : ''))`);
    if (!nav.includes('Konta i limity*')) throw new Error(`settings navigation: ${nav.join(', ')}`);
    ok(`the card link opens Settings > Konta i limity at the switcher (${nav.join(' | ')})`);
    const titles = await app.evaluate(`[...document.querySelectorAll('.settings-content .settings-group-title')].map((t) => t.textContent)`);
    if (titles.join('|') !== 'Panel boczny|Switcher kont|Ostrzeżenia o limitach') throw new Error(`groups: ${titles.join('|')}`);
    ok(`section groups: ${titles.join(' | ')}`);
    const sliders = await app.evaluate(`[...document.querySelectorAll('.settings-content input[type=range]')].map((r) => r.id + '=' + r.value + ' [' + r.min + '-' + r.max + '/' + r.step + ']')`);
    const expectSliders = ['settings-switch-fiveHour-percent=95 [1-100/1]', 'settings-switch-sevenDay-percent=98 [1-100/1]', 'settings-limit-fiveHour-percent=80 [1-100/1]', 'settings-limit-sevenDay-percent=90 [1-100/1]'];
    if (JSON.stringify(sliders) !== JSON.stringify(expectSliders)) throw new Error(`sliders: ${JSON.stringify(sliders)}`);
    if (await app.evaluate(`document.querySelectorAll('.settings-content .alert-limit-percent').length`)) throw new Error('a threshold select is still there');
    ok(`four threshold sliders: ${sliders.join(', ')}`);
    const savedPercent = (path) => app.evaluate(`window.mc.loadSnapshot().then((snap) => snap.state.settings.${path}.percent)`);
    const key = async (key, code) => {
      await app.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code });
      await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
    };
    // Keyboard: PageDown steps by 10, an arrow by 1; saved once after the short pause.
    await app.evaluate(`document.querySelector('#settings-switch-fiveHour-percent').focus()`);
    await key('PageDown', 34);
    await key('ArrowLeft', 37);
    const shownValue = await app.evaluate(`document.querySelector('#settings-switch-fiveHour-percent').value + '|' + document.querySelector('#settings-switch-fiveHour-percent').closest('.threshold-slider').textContent`);
    if (shownValue !== '84|84%') throw new Error(`after PageDown and ArrowLeft: ${shownValue}`);
    const beforePause = await savedPercent('accountSwitch.fiveHour');
    await app.until(`window.mc.loadSnapshot().then((snap) => snap.state.settings.accountSwitch.fiveHour.percent === 84)`, 'switcher 5 h saved at 84', 5000);
    ok(`keyboard: PageDown -10, ArrowLeft -1 -> 84 % (saved after the pause; right after the keys the state still had ${beforePause} %)`);
    // Mouse: a drag across the slider in many small moves; nothing is saved until the button is released, then once.
    const r = await app.evaluate(`(() => { const el = document.querySelector('#settings-limit-fiveHour-percent'); el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y + b.height / 2, w: b.width }; })()`);
    const xAt = (percent) => r.x + 7 + (r.w - 14) * (percent - 1) / 99;
    const mouse = (type, x, buttons) => app.cdp('Input.dispatchMouseEvent', { type, x, y: r.y, button: 'left', buttons, clickCount: 1 });
    await mouse('mousePressed', xAt(80), 1);
    for (let i = 0; i <= 30; i++) { await mouse('mouseMoved', xAt(80 - i), 1); await sleep(8); }
    const midDrag = await savedPercent('alerts.limits.fiveHour');
    const draggedTo = Number(await app.evaluate(`document.querySelector('#settings-limit-fiveHour-percent').value`));
    if (midDrag !== 80) throw new Error(`the drag already saved ${midDrag}`);
    await mouse('mouseReleased', xAt(50), 0);
    await app.until(`window.mc.loadSnapshot().then((snap) => snap.state.settings.alerts.limits.fiveHour.percent === ${draggedTo})`, `limit warning 5 h saved at ${draggedTo}`, 3000);
    if (Math.abs(draggedTo - 50) > 1) throw new Error(`dragged to ${draggedTo}, expected about 50`);
    ok(`mouse drag 80 -> ${draggedTo} %: the state kept 80 % during the drag and was saved on release`);
    const group = (id) => `[...document.querySelectorAll('.settings-group')].find((g) => g.querySelector('#${id}'))`;
    await app.evaluate(`(() => { const g = ${group('settings-switch-enabled')}; g.id = 'switch-group'; g.scrollIntoView(); return true; })()`);
    await shoot(app, '7-settings-switcher.png', '#switch-group');
    await app.evaluate(`(() => { const g = ${group('settings-limits-enabled')}; g.id = 'limits-group'; g.scrollIntoView(); return true; })()`);
    await shoot(app, '8-settings-limit-warnings.png', '#limits-group');
    await app.evaluate(`(() => { document.querySelector('#settings-limit-fiveHour-percent').focus(); document.querySelector('#limits-group').scrollIntoView(); return true; })()`);
    await key('ArrowRight', 39);
    await shoot(app, '9-slider-focused.png', '#limits-group');
    await app.evaluate(`(() => { document.querySelector('.settings-content').scrollTo({ top: 0 }); return true; })()`);
    await shoot(app, '10-settings-section.png', null);
    // The settings search finds the moved rows and keeps the keyboard navigation of the sections.
    await app.setValue('.settings-search input', 'switcher');
    await app.until(`[...document.querySelectorAll('.settings-section:not([data-search-hidden])')].some((sec) => sec.querySelector('h2').textContent === 'Konta i limity' && !!sec.querySelector('#settings-switch-enabled') && !sec.querySelector('#settings-switch-enabled').closest('[data-search-hidden]'))`, 'search: switcher');
    await app.setValue('.settings-search input', 'ostrzeżenia o limitach');
    await app.until(`(() => { const sec = [...document.querySelectorAll('.settings-section:not([data-search-hidden])')].find((x) => x.querySelector('h2').textContent === 'Konta i limity'); return !!sec && !!sec.querySelector('#settings-limits-enabled') && !sec.querySelector('#settings-limits-enabled').closest('[data-search-hidden]'); })()`, 'search: limit warnings');
    const counts = await app.evaluate(`[...document.querySelectorAll('.settings-nav [role=tab]')].map((t) => t.textContent)`);
    ok(`settings search finds the switcher and the limit warnings (${counts.join(' | ')})`);
    await shoot(app, '11-settings-search.png', null);
    await app.setValue('.settings-search input', '');
    await app.evaluate(`document.querySelector('.settings-nav [role=tab][aria-selected=true]').focus()`);
    await key('ArrowDown', 40);
    const afterDown = await app.evaluate(`document.querySelector('.settings-content h2').textContent`);
    if (afterDown !== 'Agenci') throw new Error(`ArrowDown from Konta i limity opened ${afterDown}`);
    ok('the section navigation: ArrowDown from Konta i limity opens Agenci');
  } finally { main.close(); await app.close(); }
  console.log(`screenshots: ${shots}`);
} finally {
  server.close();
  removeScratch(root);
}
