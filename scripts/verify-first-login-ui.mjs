// Real-app check (1.1.2) of the first Claude login on a machine that had only Claude Desktop (Windows):
// A) Claude Desktop left an identity in ~/.claude.json without any Claude login, and 1.1.1 had adopted it as a hidden card.
//    "Add a Claude account" from the empty limits panel signs in with a fake `claude` CLI (it prints the paste prompt, waits
//    for the pasted code and writes fake credentials into CLAUDE_CONFIG_DIR): the account is added (no "already added"),
//    offered as main, made main, and its limits show.
// B) No `claude` anywhere: the login offers the install, the install (a fake command copying the fake CLI into
//    ~/.local/bin) succeeds and the login starts by itself.
// Fake home, fake tokens, a local fake usage endpoint, cmd as the shell, PATH without the real CLI, MC_CLI_NO_REGISTRY=1.
// Run: npm run build && node scripts/verify-first-login-ui.mjs [shots dir]   (default: <tmp>/unimux-first-login-shots)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { launchApp, scratchRoot, sleep, sshState, writeState } from './ssh-ui-lib.mjs';

if (process.platform !== 'win32') throw new Error('Windows only (cmd fake CLI)');
if (!existsSync('out/main/index.js')) throw new Error('Build first: npm run build');
const shots = process.argv[2] ?? join(tmpdir(), 'unimux-first-login-shots');
mkdirSync(shots, { recursive: true });
const EMAIL = 'maksy@example.com';
const shoot = async (app, name) => {
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const { data } = await app.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
};
/** A stand-in for `claude`: version, auth status and an `auth login` that waits for a pasted code like the real one. */
const FAKE_CLAUDE = [
  '@echo off',
  'if "%1"=="--version" ( echo 2.1.99 ^(Claude Code^) & exit /b 0 )',
  'if not "%1"=="auth" exit /b 1',
  'if "%2"=="status" (',
  '  if exist "%CLAUDE_CONFIG_DIR%\\.credentials.json" ( echo {"loggedIn":true,"email":"maksy@example.com","orgName":"Org"} ) else ( echo {"loggedIn":false} )',
  '  exit /b 0',
  ')',
  'if not "%2"=="login" exit /b 1',
  'echo Opening browser to sign in...',
  'set CODE=',
  'set /p CODE=Paste code here if prompted ^> ',
  'if not "%CODE%"=="fake-code#fake-state" ( echo Invalid code & exit /b 1 )',
  'echo {"claudeAiOauth":{"accessToken":"fake-access-maksy","refreshToken":"fake-refresh-maksy","expiresAt":9999999999999,"scopes":["user:inference"],"subscriptionType":"pro"}}> "%CLAUDE_CONFIG_DIR%\\.credentials.json"',
  'echo {"oauthAccount":{"emailAddress":"maksy@example.com","accountUuid":"fake-uuid-maksy","organizationUuid":"fake-org-1","organizationName":"Org"}}> "%CLAUDE_CONFIG_DIR%\\.claude.json"',
  'echo Login successful.',
  'echo Your organization may apply global configuration to Claude Code.',
  'exit /b 0',
].join('\r\n');

const seen = [];
const server = createServer((req, res) => {
  seen.push({ path: req.url, auth: String(req.headers.authorization ?? '') });
  if (req.url !== '/usage') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ five_hour: { utilization: 23, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: 41, resets_at: new Date(Date.now() + 86_400_000).toISOString() } }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'];

async function launch(root, binDirs) {
  const state = sshState({ projectPath: join(root, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false, shell: 'cmd' };
  writeState(root, state);
  const probe = join(root, 'probe.ps1');
  writeFileSync(probe, '# empty profile for the CLI probe\r\n');
  return launchApp(root, {
    PATH: [...binDirs, ...PATH].join(';'), Path: null,
    MC_CLI_NO_REGISTRY: '1', MC_CLI_PROBE_PROFILE: probe,
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${port}/token`,
    MC_INSTALL_COMMAND_OVERRIDE: `copy /y "${join(root, 'fakesrc', 'claude.cmd')}" "${join(root, 'home', '.local', 'bin', 'claude.cmd')}"`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
  });
}

/** Pastes the code the browser "showed" into the login terminal and waits for the result line. */
async function pasteCode(app, viaKeys = false) {
  await app.until(`!!document.querySelector('.modal.auth .auth-paste')`, 'paste button');
  await app.until(`document.querySelector('.modal.auth .auth-paste-note')?.textContent.includes('Jeśli przeglądarka pokazała kod, wklej go tutaj (Ctrl+V) i naciśnij Enter')`, 'paste hint');
  // The fake CLI needs the shell to type the command and print its prompt.
  await sleep(3500);
  if (viaKeys) {
    // Ctrl+V and Enter as typed keys: the login terminal must hold the keyboard focus on its own.
    await app.evaluate(`window.mc.clipboardWrite('fake-code#fake-state'), true`);
    for (const type of ['keyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await sleep(500);
    await app.press('Enter');
    return;
  }
  // The button trims what the browser copy put around the code and presses Enter itself.
  await app.evaluate(`window.mc.clipboardWrite('  fake-code#fake-state\\n'), true`);
  await app.click('.modal.auth .auth-paste');
}

const card = (name) => `[...document.querySelectorAll('.usage-card')].find((c) => c.textContent.includes('${name}'))`;
let failed = false;
// ── A: the Claude Desktop leftover ──
const rootA = scratchRoot('first-login');
try {
  const home = join(rootA, 'home');
  const data = join(rootA, 'data');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(rootA, 'fakebin'), { recursive: true });
  writeFileSync(join(rootA, 'fakebin', 'claude.cmd'), FAKE_CLAUDE);
  // What Claude Desktop leaves: an identity in ~/.claude.json, no Claude login in ~/.claude/.credentials.json.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 2, oauthAccount: { emailAddress: EMAIL, accountUuid: 'fake-uuid-maksy', organizationUuid: 'fake-org-1', organizationName: 'Org' } }));
  // What 1.1.1 made of it: an adopted record (custody live) with an empty profile, never shown (signed out).
  const adopted = '12121212-1212-4121-8121-121212121212';
  mkdirSync(join(data, 'accounts', 'claude', adopted), { recursive: true });
  writeFileSync(join(data, 'accounts', 'accounts.json'), JSON.stringify({ version: 2, claude: [{ id: adopted, addedAt: 1, email: EMAIL, org: 'Org', accountUuid: 'fake-uuid-maksy', organizationUuid: 'fake-org-1', custody: 'live', family: 'live' }], live: { email: EMAIL, org: 'Org', accountUuid: 'fake-uuid-maksy', organizationUuid: 'fake-org-1', recordId: adopted } }));
  const app = await launch(rootA, [join(rootA, 'fakebin')]);
  try {
    await app.until(`document.querySelector('.usage-empty')?.textContent.includes('Brak podłączonych kont')`, 'empty limits panel');
    await shoot(app, 'A1-empty-panel.png');
    await app.click('.usage-empty-buttons button', 'Claude');
    await app.until(`document.querySelector('.modal.auth h3')?.textContent === 'Dodaj konto Claude'`, 'add account dialog');
    await pasteCode(app);
    await shoot(app, 'A2-code-pasted.png');
    // The adopted empty record had no saved login: no "signed out, the app kept its copy" notice for it.
    if (await app.evaluate(`document.body.textContent.includes('wylogowano z Claude Code')`)) throw new Error('a signed-out notice for a record without a login');
    try {
      await app.until(`!!document.querySelector('.modal.auth .auth-make-main')`, 'offered as main', 30_000);
    } catch (error) {
      console.log(await app.evaluate(`document.querySelector('.modal.auth')?.textContent`));
      throw error;
    }
    if (await app.evaluate(`document.body.textContent.includes('już dodane')`)) throw new Error('"already added" shown');
    await shoot(app, 'A3-added-offer-main.png');
    await app.click('.modal.auth .auth-make-main');
    await app.until(`document.body.textContent.includes('Konto główne: ${EMAIL}')`, 'made main', 30_000);
    await app.until(`!!${card(EMAIL)}?.textContent.includes('23%')`, 'limits of the new main account', 30_000);
    await shoot(app, 'A4-main-with-limits.png');
  } finally { await app.close(); }
  const stored = readFileSync(join(data, 'accounts', 'accounts.json'), 'utf8');
  if (/fake-access|fake-refresh/.test(stored)) throw new Error('accounts.json contains a token');
  const records = JSON.parse(stored).claude;
  if (records.length !== 1 || records[0].id === adopted || records[0].email !== EMAIL) throw new Error(`records: ${stored}`);
  const live = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8'));
  if (live.claudeAiOauth?.refreshToken !== 'fake-refresh-maksy') throw new Error('the new account is not the live login');
  console.log('OK A: first login over a Claude Desktop leftover');
} catch (error) { failed = true; console.error('FAIL A:', error.message); } finally { removeScratch(rootA); }

// ── B: no Claude Code installed ──
const rootB = scratchRoot('first-login-install');
try {
  const home = join(rootB, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(join(rootB, 'fakesrc'), { recursive: true });
  writeFileSync(join(rootB, 'fakesrc', 'claude.cmd'), FAKE_CLAUDE);
  const app = await launch(rootB, []);
  try {
    await app.until(`document.querySelector('.usage-empty')?.textContent.includes('Brak podłączonych kont')`, 'empty limits panel');
    await app.click('.usage-empty-buttons button', 'Claude');
    await app.until(`!!document.querySelector('.modal.auth .auth-install')`, 'install offered', 30_000);
    if (await app.evaluate(`!!document.querySelector('.modal.auth .auth-terminal')`)) throw new Error('a login terminal was opened');
    await shoot(app, 'B1-install-offered.png');
    await app.click('.modal.auth .auth-install');
    await app.until(`!!document.querySelector('.modal.install .install-go') && !document.querySelector('.modal.install .install-go').disabled`, 'install window');
    await shoot(app, 'B2-install-window.png');
    await app.click('.modal.install .install-go');
    await app.until(`document.querySelector('.modal.install')?.textContent.includes('Za chwilę uruchomi się logowanie')`, 'install succeeded, login follows', 60_000);
    await shoot(app, 'B3-installed-login-follows.png');
    await app.until(`document.querySelector('.modal.auth h3')?.textContent === 'Dodaj konto Claude' && !document.querySelector('.modal.install')`, 'login started by itself', 15_000);
    await pasteCode(app, true);
    await app.until(`!!document.querySelector('.modal.auth .auth-make-main')`, 'added and offered as main', 30_000);
    await shoot(app, 'B4-added-after-install.png');
  } finally { await app.close(); }
  console.log('OK B: install offered and the login continued');
} catch (error) { failed = true; console.error('FAIL B:', error.message); } finally { removeScratch(rootB); server.close(); }

if (seen.some((r) => r.path !== '/usage')) { failed = true; console.error(`unexpected request: ${seen.map((r) => r.path).join(', ')}`); }
console.log(failed ? 'FAILED' : `OK; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
