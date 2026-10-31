// Real-app check of the AI limits panel with a fake home: a fake live Claude login, a local fake usage endpoint and a
// 0.9.0 accounts.json with two records of the live account. Never the real ~/.claude, cswap data or the app data folder.
// Run: npm run build && node scripts/verify-accounts-ui.mjs   Screenshot: D:\Projekty\_shots\091-accounts-panel.png
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { launchApp, SCRATCH, scratchRoot, sshState, writeState } from './ssh-ui-lib.mjs';

if (!existsSync('out/main/index.js')) throw new Error('Build first: npm run build');
const root = scratchRoot('accounts');
const home = join(root, 'home');
const seen = [];
// The fake usage endpoint: any other path (a token renewal) is an error, the app must never renew the live login.
const server = createServer((req, res) => {
  seen.push({ path: req.url, ua: String(req.headers['user-agent'] ?? '') });
  if (req.url !== '/usage') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: 7, resets_at: new Date(Date.now() + 86_400_000).toISOString() } }));
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const identity = { emailAddress: 'main@example.com', accountUuid: 'fake-uuid-main', organizationUuid: 'fake-org' };
  const fake = (n) => ({ claudeAiOauth: { accessToken: `fake-access-${n}`, refreshToken: `fake-refresh-${n}`, expiresAt: Date.now() + 3_600_000, subscriptionType: 'max' } });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(fake('live')));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: identity }));
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  mkdirSync(join(root, 'data', 'accounts'), { recursive: true });
  writeFileSync(join(root, 'data', 'accounts', 'accounts.json'), JSON.stringify({ claude: ids.map((id, i) => ({ id, email: 'main@example.com', addedAt: i + 1 })) }));
  for (const [i, id] of ids.entries()) {
    const dir = join(root, 'data', 'accounts', 'claude', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(fake(`saved-${i}`)));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: identity }));
  }
  const state = sshState({ projectPath: join(root, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false };
  writeState(root, state);
  const app = await launchApp(root, {
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${server.address().port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${server.address().port}/token`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
  });
  try {
    // One card for the account (the duplicate record is set aside), with the numbers from the fake endpoint.
    await app.until(`[...document.querySelectorAll('.usage-card')].filter((c) => c.textContent.includes('main@example.com')).length === 1 && document.body.textContent.includes('42%')`, 'one card with limits');
    await app.until(`[...document.querySelectorAll('.usage-warning button')].some((b) => b.textContent === 'Usuń kopię')`, 'set-aside copy notice');
    await app.screenshot('091-accounts-panel.png');
    // "Ukryj" hides a notice for good: the migration notice goes, the set-aside notice stays.
    const notices = () => app.evaluate(`document.querySelectorAll('.usage-notices .usage-warning').length`);
    const before = await notices();
    await app.evaluate(`(() => { const box = [...document.querySelectorAll('.usage-notices .usage-warning')].find((w) => !w.textContent.includes('Usuń kopię')); [...box.querySelectorAll('button')].find((b) => b.textContent === 'Ukryj').click(); return true; })()`);
    await app.until(`document.querySelectorAll('.usage-notices .usage-warning').length === ${before - 1}`, 'notice dismissed');
    await app.until(`[...document.querySelectorAll('.usage-warning button')].some((b) => b.textContent === 'Usuń kopię')`, 'set-aside notice kept');
    if (!seen.length || !seen.every((r) => r.ua.startsWith('unimux/'))) throw new Error(`usage User-Agent: ${seen.map((r) => r.ua).join(', ')}`);
    if (seen.some((r) => r.path !== '/usage')) throw new Error(`unexpected request: ${seen.map((r) => r.path).join(', ')}`);
  } finally { await app.close(); }
  const stored = readFileSync(join(root, 'data', 'accounts', 'accounts.json'), 'utf8');
  if (/fake-access|fake-refresh/.test(stored)) throw new Error('accounts.json contains a token');
  if (JSON.parse(stored).notices?.some((n) => n.kind === 'migrated')) throw new Error('the dismissed notice is still stored');
  for (const id of ids) if (!existsSync(join(root, 'data', 'accounts', 'claude', id))) throw new Error('a profile dir was deleted');
  console.log('OK accounts');
} finally {
  server.close();
  removeScratch(root);
}

// A saved card that a (fake) cswap roster lists: "Make main account" swaps a fresh copy in without any token request and
// refuses a copy that would need renewing, with the text that says what to do (final review I3).
const cswapRoot = scratchRoot('accounts-cswap');
const cswapSeen = [];
const cswapServer = createServer((req, res) => {
  cswapSeen.push(req.url);
  if (req.url !== '/usage') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ five_hour: { utilization: 11, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: 3, resets_at: new Date(Date.now() + 86_400_000).toISOString() } }));
});
try {
  await new Promise((resolve) => cswapServer.listen(0, '127.0.0.1', resolve));
  const home = join(cswapRoot, 'home');
  const who = (name) => ({ emailAddress: `${name}@example.com`, accountUuid: `fake-uuid-${name}`, organizationUuid: `fake-org-${name}` });
  const fake = (n, expiresAt) => ({ claudeAiOauth: { accessToken: `fake-access-${n}`, refreshToken: `fake-refresh-${n}`, expiresAt, subscriptionType: 'max' } });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(fake('live', Date.now() + 3_600_000)));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: who('main') }));
  mkdirSync(join(home, '.claude-swap-backup'), { recursive: true });
  writeFileSync(join(home, '.claude-swap-backup', 'sequence.json'), JSON.stringify({ accounts: { 1: { email: 'fresh@example.com', uuid: 'fake-uuid-fresh' }, 2: { email: 'stale@example.com', uuid: 'fake-uuid-stale' } } }));
  // 0.9.0 records (no family: a copy of the live family cswap may hold).
  const saved = [['33333333-3333-4333-8333-333333333333', 'fresh', Date.now() + 3_600_000], ['44444444-4444-4444-8444-444444444444', 'stale', Date.now() + 2 * 60_000]];
  mkdirSync(join(cswapRoot, 'data', 'accounts'), { recursive: true });
  writeFileSync(join(cswapRoot, 'data', 'accounts', 'accounts.json'), JSON.stringify({ claude: saved.map(([id, name], i) => ({ id, email: `${name}@example.com`, addedAt: i + 1 })) }));
  for (const [id, name, expiresAt] of saved) {
    const dir = join(cswapRoot, 'data', 'accounts', 'claude', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(fake(name, expiresAt)));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: who(name) }));
  }
  const state = sshState({ projectPath: join(cswapRoot, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false };
  writeState(cswapRoot, state);
  const app = await launchApp(cswapRoot, {
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${cswapServer.address().port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${cswapServer.address().port}/token`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
  });
  const card = (name) => `[...document.querySelectorAll('.usage-card')].find((c) => c.textContent.includes('${name}@example.com'))`;
  const makeMain = async (name) => {
    await app.evaluate(`${card(name)}.querySelector('.usage-kebab').click()`);
    await app.until(`[...document.querySelectorAll('.menu button')].some((b) => b.textContent.includes('Ustaw jako główne'))`, `make main offered for ${name}`);
    await app.evaluate(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Ustaw jako główne')).click()`);
    await app.until(`[...document.querySelectorAll('.modal-foot button')].some((b) => b.textContent === 'Ustaw jako główne')`, 'confirmation');
    await app.evaluate(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Ustaw jako główne').click()`);
  };
  try {
    await app.until(`!!${card('fresh')} && !!${card('stale')} && !!${card('fresh')}.querySelector('[title*="cswap"], [data-mc-title*="cswap"]') && !${card('fresh')}.textContent.includes('ma też cswap')`, 'cswap cards with the short hint');
    await app.screenshot('091-accounts-cswap-hint.png');
    await makeMain('stale');
    await app.until(`document.body.textContent.includes('Konto stale@example.com jest zarządzane poza aplikacją')`, 'stale copy refused with the foreign text');
    await app.screenshot('091-accounts-cswap-stale.png');
    if (JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken !== 'fake-access-live') throw new Error('a refused swap changed the live login');
    await makeMain('fresh');
    await app.until(`document.body.textContent.includes('Konto główne: fresh@example.com')`, 'fresh copy swapped in');
    await app.until(`${card('fresh')}?.querySelector('.usage-chip.main') !== null`, 'fresh card is main');
    await app.screenshot('091-accounts-cswap-fresh.png');
  } finally { await app.close(); }
  const live = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken;
  if (live !== 'fake-access-fresh') throw new Error(`live login after the swap: ${live}`);
  if (cswapSeen.some((path) => path !== '/usage')) throw new Error(`token request: ${cswapSeen.join(', ')}`);
  console.log('OK accounts cswap make main');
} finally {
  cswapServer.close();
  removeScratch(cswapRoot);
}

// A saved 0.9.0 card that the (fake) cswap roster lists and whose access token ran out: "Renew this copy in unimux"
// (0.9.2) asks first, then the app renews the copy itself (one /token request to the fake server) and the card leaves
// held-by-cswap. Scratch dir D:\Projekty\_tmp-092-<rand>; fake home, fake tokens, never a real endpoint.
const adoptRoot = mkdtempSync(join(SCRATCH, '_tmp-092-'));
for (const dir of [['data'], ['project'], ['home', 'AppData', 'Roaming'], ['home', 'AppData', 'Local']]) mkdirSync(join(adoptRoot, ...dir), { recursive: true });
const adoptSeen = [];
const adoptServer = createServer((req, res) => {
  adoptSeen.push({ path: req.url, auth: String(req.headers.authorization ?? '') });
  if (req.url === '/token' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'fake-access-renewed', refresh_token: 'fake-refresh-renewed', expires_in: 3600 }));
    return;
  }
  if (req.url !== '/usage') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ five_hour: { utilization: 23, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: 5, resets_at: new Date(Date.now() + 86_400_000).toISOString() } }));
});
try {
  await new Promise((resolve) => adoptServer.listen(0, '127.0.0.1', resolve));
  const home = join(adoptRoot, 'home');
  const who = (name) => ({ emailAddress: `${name}@example.com`, accountUuid: `fake-uuid-${name}`, organizationUuid: `fake-org-${name}` });
  const fake = (n, expiresAt) => ({ claudeAiOauth: { accessToken: `fake-access-${n}`, refreshToken: `fake-refresh-${n}`, expiresAt, subscriptionType: 'max' } });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(fake('live', Date.now() + 3_600_000)));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: who('main') }));
  mkdirSync(join(home, '.claude-swap-backup'), { recursive: true });
  writeFileSync(join(home, '.claude-swap-backup', 'sequence.json'), JSON.stringify({ accounts: { 1: { email: 'kept@example.com', uuid: 'fake-uuid-kept' } } }));
  const id = '55555555-5555-4555-8555-555555555555';
  const dir = join(adoptRoot, 'data', 'accounts', 'claude', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(adoptRoot, 'data', 'accounts', 'accounts.json'), JSON.stringify({ claude: [{ id, email: 'kept@example.com', addedAt: 1 }] }));
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify(fake('kept', Date.now() - 60_000)));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: who('kept') }));
  const state = sshState({ projectPath: join(adoptRoot, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false };
  writeState(adoptRoot, state);
  const app = await launchApp(adoptRoot, {
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${adoptServer.address().port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${adoptServer.address().port}/token`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
  });
  const card = `[...document.querySelectorAll('.usage-card')].find((c) => c.textContent.includes('kept@example.com'))`;
  const label = 'Odświeżaj tę kopię w unimuxie';
  try {
    // Held by cswap with an access token that already ran out (1.0.10): the same "Sign-in expired" row as every expired
    // sign-in, the explanation as a tooltip, "Renew this copy" in the card's menu; no renewal happens on its own.
    await app.until(`!!${card} && ${card}.textContent.includes('Logowanie wygasło') && ${card}.querySelector('.usage-expired')?.title.includes('token dostępu tej kopii wygasł') && ${card}.querySelector('.usage-expired button.primary')?.textContent === 'Zaloguj ponownie'`, 'expired held card');
    // The notices are hidden and the card is scrolled into view for the screenshots.
    for (let i = 0; i < 5 && await app.evaluate(`document.querySelectorAll('.usage-notices .usage-warning').length`); i++) {
      await app.evaluate(`[...document.querySelectorAll('.usage-notices button')].find((b) => b.textContent === 'Ukryj')?.click() ?? true`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await app.evaluate(`${card}.scrollIntoView({ block: 'end' })`);
    await app.screenshot('092-adopt-copy-before.png');
    if (adoptSeen.some((r) => r.path === '/token')) throw new Error('a held copy was renewed before the user asked');
    await app.evaluate(`${card}.querySelector('.usage-kebab').click()`);
    await app.until(`[...document.querySelectorAll('.menu button')].some((b) => b.textContent.includes('${label}'))`, 'adopt action in the card menu');
    await app.evaluate(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('${label}')).click()`);
    await app.until(`[...document.querySelectorAll('.modal-foot button')].some((b) => b.textContent === '${label}') && document.querySelector('.modal').textContent.includes('cswap może stracić swój token')`, 'confirmation');
    await app.screenshot('092-adopt-copy-confirm.png');
    await app.evaluate(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === '${label}').click()`);
    // Renewed by the app: one /token request, then the limits read with the renewed token; the card is no longer held.
    await app.until(`!!${card} && ${card}.textContent.includes('23%') && ![...${card}.querySelectorAll('button')].some((b) => b.textContent === '${label}') && !${card}.textContent.includes('cswap')`, 'card renewed');
    await app.evaluate(`${card}.scrollIntoView({ block: 'end' })`);
    await app.screenshot('092-adopt-copy.png');
  } finally { await app.close(); }
  const tokens = adoptSeen.filter((r) => r.path === '/token');
  if (tokens.length !== 1) throw new Error(`token requests: ${tokens.length}`);
  if (!adoptSeen.some((r) => r.path === '/usage' && r.auth === 'Bearer fake-access-renewed')) throw new Error('limits not read with the renewed token');
  const saved = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')).claudeAiOauth;
  if (saved.accessToken !== 'fake-access-renewed' || saved.refreshToken !== 'fake-refresh-renewed') throw new Error('the renewed tokens were not stored');
  if (JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken !== 'fake-access-live') throw new Error('the live login changed');
  const stored = readFileSync(join(adoptRoot, 'data', 'accounts', 'accounts.json'), 'utf8');
  if (/fake-access|fake-refresh/.test(stored)) throw new Error('accounts.json contains a token');
  if (JSON.parse(stored).claude.find((r) => r.id === id)?.family !== 'own') throw new Error('the record is not app-owned');
  console.log('OK accounts adopt copy');
} finally {
  adoptServer.close();
  removeScratch(adoptRoot);
}

// An accounts.json of the wrong shape: read-only, explained in the panel, never written over.
const roRoot = scratchRoot('accounts-ro');
try {
  mkdirSync(join(roRoot, 'data', 'accounts'), { recursive: true });
  const file = join(roRoot, 'data', 'accounts', 'accounts.json');
  const body = JSON.stringify({ claude: { broken: true } });
  writeFileSync(file, body);
  const state = sshState({ projectPath: join(roRoot, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false };
  writeState(roRoot, state);
  const app = await launchApp(roRoot, { MC_USAGE_CLAUDE_URL: 'http://127.0.0.1:9/usage', MC_USAGE_CLAUDE_TOKEN_URL: 'http://127.0.0.1:9/token' });
  try {
    await app.until(`[...document.querySelectorAll('.usage-warning')].some((w) => w.textContent.includes('nie da się bezpiecznie odczytać') && w.textContent.includes('accounts.json'))`, 'read-only explanation');
    // No Claude login can be saved meanwhile: the empty-state button and the "+" entry are disabled, with the reason.
    if (!(await app.evaluate(`[...document.querySelectorAll('.usage-empty-buttons button')].find((b) => b.textContent.includes('Claude'))?.disabled === true`))) throw new Error('Claude button not disabled');
    await app.click('.usage-head button[aria-label="Dodaj konto"]');
    await app.until(`[...document.querySelectorAll('.menu button')].some((b) => b.textContent.includes('Dodaj konto Claude') && b.getAttribute('aria-disabled') === 'true') && document.querySelector('.menu').textContent.includes('Niedostępne')`, 'add menu disabled with the reason');
    await app.screenshot('091-accounts-readonly.png');
  } finally { await app.close(); }
  if (readFileSync(file, 'utf8') !== body) throw new Error('a read-only accounts.json was written');
  console.log('OK accounts read-only');
} finally {
  removeScratch(roRoot);
}
