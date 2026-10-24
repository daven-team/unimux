// Capture the README screenshots from the real built Electron renderer. Never uses an installed app's data or AI models.
// Run: npm run build && node scripts/capture-readme.mjs [output dir] [--only name,name] [--hold] [--verify]
// Demo data (all in a temporary folder): an "Atlas storefront" project that is a scratch git repository, scripted stand-ins
// for the claude and codex commands (they print a fixed demo session, post status hooks and never contact a model), demo
// transcripts for the context meter, SSH hosts on the local test server scripts/ssh-test-server.mjs (status bar, SFTP and
// a fake shell), a second test server whose host key is not trusted yet (the connect card), a SQLite file, a local
// Postgres (scripts/pg-test-server.mjs) and Redis (scripts/redis-test-server.mjs), notes and snippets.
// --only captures the named images only (the rest of the run is skipped); --hold keeps the app running after the setup and
// prints its debug port (for trying steps by hand), --verify runs scripts/verify-workspace-ui.mjs at the end.
// Requires Node >=22, installed dependencies, and an Electron desktop environment.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import electron from 'electron';
import { Redis } from 'ioredis';
import { verifyWorkspaceUI } from './verify-workspace-ui.mjs';
import { scrubAppEnv } from './app-env.mjs';
import { killTree, startTestServer, writeKnownHost } from './ssh-ui-lib.mjs';

const checkout = process.cwd();
if (!existsSync(join(checkout, 'out/main/index.js'))) throw new Error('Build first: npm run build');
const argv = process.argv.slice(2);
const flagValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const only = flagValue('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const hold = argv.includes('--hold');
const output = resolve(argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--only') ?? 'docs/screenshots');
mkdirSync(output, { recursive: true });
const isMac = process.platform === 'darwin';
// Set MC_CAPTURE_ROOT to a generic path if your OS temp path contains a personal name.
const temporaryBase = resolve(process.env.MC_CAPTURE_ROOT ?? tmpdir());
mkdirSync(temporaryBase, { recursive: true });
const root = mkdtempSync(join(temporaryBase, 'unimux-readme-'));
const data = join(root, 'data'), project = join(root, 'atlas');
// The app gets a scratch home as well, so it never reads the real profile (~/.claude, ~/.codex, ~/.ssh, its appData).
const home = join(root, 'home');
for (const dir of [data, project, join(project, 'src'), join(project, 'test'), join(project, 'data'), join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true });

// ── the demo project ─────────────────────────────────────────────────────────
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'atlas-demo', private: true, type: 'module', scripts: { test: 'node --test', check: 'node --check src/catalog.mjs' } }, null, 2));
writeFileSync(join(project, 'README.md'), [
  '# Atlas storefront',
  '',
  'A small product catalog shared by the storefront and API. **Six focused tests** cover filtering and price formatting.',
  '',
  '[Project checks](#project-checks) · [Browse the catalog source](src/catalog.mjs)',
  '',
  '## Catalog',
  '',
  '| Product | Category | Price |',
  '| --- | --- | ---: |',
  '| Orbit desk lamp | Lighting | $79 |',
  '| Folio notebook | Stationery | $12 |',
  '| Arc bookend | Workspace | $24 |',
  '',
  '> Keep the catalog API small. Review behavior beside the terminal before changing the implementation.',
  '',
  '## Quick start',
  '',
  '```javascript',
  "import { findProducts, formatPrice } from './src/catalog.mjs';",
  "console.log(findProducts('orbit'));",
  'console.log(formatPrice(79));',
  '```',
  '',
  '## Project checks',
  '',
  '- [x] Filter names and categories',
  '- [x] Format prices in USD',
  '- [ ] Review the next feature',
  '',
  'Run `npm test` to check filtering and price formatting.',
  '',
  '<details><summary>Preview sanitization fixture</summary>',
  '<p onclick="window.__markdownInjected=true">This text remains readable.</p>',
  '<script>window.__markdownInjected=true</script>',
  '<a href="javascript:window.__markdownInjected=true">Unsafe URL fixture</a>',
  '</details>',
  '',
].join('\n'));
writeFileSync(join(project, 'src/catalog.mjs'), `/** A tiny catalog shared by the storefront and API. */
export const products = [
  { id: 'orbit', name: 'Orbit desk lamp', category: 'lighting', price: 79 },
  { id: 'folio', name: 'Folio notebook', category: 'stationery', price: 12 },
  { id: 'arc', name: 'Arc bookend', category: 'workspace', price: 24 },
];

export function findProducts(query, catalog = products) {
  const search = query.trim().toLowerCase();
  return catalog.filter(product =>
    product.name.toLowerCase().includes(search) ||
    product.category.toLowerCase().includes(search)
  );
}

export function formatPrice(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
  }).format(amount);
}
`);
writeFileSync(join(project, 'test/catalog.test.mjs'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProducts, formatPrice } from '../src/catalog.mjs';
test('search finds a product by name', () => assert.equal(findProducts('orbit')[0].id, 'orbit'));
test('search is case insensitive', () => assert.equal(findProducts('FOLIO').length, 1));
test('search trims whitespace', () => assert.equal(findProducts(' arc ')[0].id, 'arc'));
test('search matches categories', () => assert.equal(findProducts('workspace').length, 1));
test('empty search returns the catalog', () => assert.equal(findProducts('').length, 3));
test('prices use US dollars', () => assert.equal(formatPrice(79), '$79.00'));
`);
writeFileSync(join(project, 'inspect.mjs'), `import { products, formatPrice } from './src/catalog.mjs';
console.log('ATLAS / PRODUCT CATALOG\\n');
for (const p of products) console.log(p.name.padEnd(24) + formatPrice(p.price).padStart(8));
console.log('\\n3 products · 3 categories · USD');
`);
writeFileSync(join(project, 'review.mjs'), `import { readFileSync } from 'node:fs';
const source = readFileSync('src/catalog.mjs', 'utf8');
console.log('ATLAS / SOURCE CHECK\\n');
console.log('Module:        src/catalog.mjs');
console.log('Exports:       ' + [...source.matchAll(/export (?:const|function) (\\w+)/g)].map(m => m[1]).join(', '));
console.log('Lines:         ' + source.trimEnd().split('\\n').length);
console.log('Dependencies:  JavaScript standard library');
console.log('\\nReady to review beside the terminal.');
`);
// The demo project is a scratch git repository: a few commits (one merged branch) now, working-tree changes just before the git capture.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Alex Demo', GIT_AUTHOR_EMAIL: 'alex@example.com', GIT_COMMITTER_NAME: 'Alex Demo', GIT_COMMITTER_EMAIL: 'alex@example.com' };
writeFileSync(join(root, 'gitconfig'), '');
function git(...args) { return execFileSync('git', args, { cwd: project, env: gitEnv, windowsHide: true, stdio: 'ignore' }); }
let commitHours = 52;
function commit(message, ...files) {
  git('add', ...files);
  const date = new Date(Date.now() - commitHours * 3600e3).toISOString(); commitHours -= 9;
  git('-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '-m', message, '--date', date);
}
git('init', '-q', '-b', 'main');
commit('Add the product catalog module', 'package.json', 'src/catalog.mjs');
commit('Cover catalog search and prices with tests', 'test/catalog.test.mjs');
git('switch', '-q', '-c', 'feature/inspect');
commit('Add a script that prints the catalog', 'inspect.mjs');
git('switch', '-q', 'main');
commit('Document the catalog in the README', 'README.md');
git('merge', '-q', '--no-ff', '--no-edit', 'feature/inspect');
commit('Add a source review script', 'review.mjs');
// A CSV beside the code (not committed): the CSV table view.
writeFileSync(join(project, 'data', 'orders.csv'), ['order_id,customer,product,quantity,total,status',
  ...Array.from({ length: 40 }, (_, i) => {
    const product = ['Orbit desk lamp', 'Folio notebook', 'Arc bookend'][i % 3];
    const price = [79, 12, 24][i % 3]; const quantity = 1 + (i * 7) % 4;
    return `${1001 + i},${['Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Wingtip'][i % 5]},${product},${quantity},${(price * quantity).toFixed(2)},${['shipped', 'paid', 'shipped', 'returned', 'shipped'][i % 5]}`;
  })].join('\n') + '\n');

// ── scripted stand-ins for the claude and codex commands ─────────────────────
// They are found first (in ~/.local/bin of the scratch home), print a fixed demo session picked by the session id the app
// resumes, post the status hooks a real Claude Code would (from the --settings file the app hands it) and stay open.
const bin = join(home, '.local', 'bin');
mkdirSync(bin, { recursive: true });
const sessions = {
  coordinator: { cli: 'claude', id: '5d0c1f6e-2b7a-4c11-9a3e-0f6d2c1b7a01' },
  review: { cli: 'codex', id: '019a2f4c-7d1e-7b20-8c55-3e9f1a6b2c02' },
  frontend: { cli: 'claude', id: '8b3e9a72-5c4d-4f0e-b1a6-7d2c9e0f3a03' },
};
const ESC = '\u001b';
const c = (code, text) => `${ESC}[${code}m${text}${ESC}[0m`;
// Lines stay within 36 columns: on Windows the scripted CLIs do not learn about a resize of their pseudo console, so they
// never depend on the width of the cell.
const demoScreens = {
  [sessions.coordinator.id]: {
    lines: [
      ` ${c('38;5;209', '✻')} ${c('1', 'Claude Code')}  ${c('2', 'demo session')}`,
      '',
      `${c('2', '>')} Add a category filter to the`,
      '  catalog and cover it with tests',
      '',
      `${c('38;5;209', '●')} I will add ${c('1', 'categories()')} to the`,
      '  catalog and two focused tests.',
      '',
      `${c('32', '●')} ${c('1', 'Read')}(src/catalog.mjs)`,
      `  ${c('2', '⎿  Read 20 lines')}`,
      '',
      `${c('32', '●')} ${c('1', 'Update')}(src/catalog.mjs)`,
      `  ${c('2', '⎿  Updated with 3 additions')}`,
      `     ${c('32', '+ export function categories() {')}`,
      `     ${c('32', '+   return [...set].sort();')}`,
      `     ${c('32', '+ }')}`,
      '',
    ],
    spin: { frames: ['✶', '✻', '✽', '✻'], line: `${c('38;5;209', '{s} Editing catalog.test.mjs…')} ${c('2', '(esc)')}` },
    hooks: [['prompt', {}], ['pre', { tool_name: 'Edit', tool_input: { file_path: 'test/catalog.test.mjs' } }]],
  },
  [sessions.frontend.id]: {
    lines: [
      ` ${c('38;5;209', '✻')} ${c('1', 'Claude Code')}  ${c('2', 'demo session')}`,
      '',
      `${c('2', '>')} Check the storefront build`,
      '  before the review',
      '',
      `${c('38;5;209', '●')} The catalog changed, so I will`,
      '  run the test suite first.',
      '',
      `${c('33', '●')} ${c('1', 'Bash')}(node --test)`,
      '',
      ` ${c('1', 'Do you want to run this command?')}`,
      '   node --test',
      '',
      ` ${c('36', '❯ 1. Yes')}`,
      '   2. Yes, and do not ask again',
      '   3. No, tell Claude what to do',
    ],
    hooks: [['prompt', {}], ['permission', { tool_name: 'Bash', tool_input: { command: 'node --test' } }]],
  },
  [sessions.review.id]: {
    lines: [
      `${c('1', '>_ Codex')}  ${c('2', 'demo session')}`,
      '',
      `${c('36', '›')} Review the catalog module for`,
      '  edge cases',
      '',
      `${c('1', '• Reviewed')} src/catalog.mjs and its`,
      '  tests',
      '',
      `  1. ${c('1', 'formatPrice')} accepts negative`,
      '     amounts without a check.',
      `  2. A ${c('1', 'price: 24.5')} test would pin`,
      '     the rounding.',
      `  3. ${c('32', 'No blocking issues.')}`,
      '',
      `${c('2', '─ Worked for 1m 12s ─────────────')}`,
      '',
      `${c('36', '›')} ${c('2', 'Ask Codex to do anything')}`,
    ],
    hooks: [],
  },
};
writeFileSync(join(bin, 'demo-sessions.json'), JSON.stringify(demoScreens));
writeFileSync(join(bin, 'demo-agent.mjs'), `// Scripted stand-in for "${'claude'}" / "codex" in README screenshots: prints a fixed demo session, never calls a model.
import { readFileSync } from 'node:fs';
const [cli, ...args] = process.argv.slice(2);
if (args.includes('--version')) { console.log(cli === 'claude' ? '2.1.120 (Claude Code)' : 'codex-cli 0.60.0'); process.exit(0); }
const screens = JSON.parse(readFileSync(new URL('./demo-sessions.json', import.meta.url), 'utf8'));
const after = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const id = cli === 'claude' ? after('--resume') ?? after('--session-id') : after('resume');
const screen = screens[id] ?? { lines: [cli + ' (demo)'], hooks: [] };
// The whole screen at once; a working session animates its spinner line like the real CLI.
let frame = 0;
const spinLine = () => screen.spin.line.replace('{s}', screen.spin.frames[frame % screen.spin.frames.length]);
const draw = () => process.stdout.write('\\u001b[2J\\u001b[3J\\u001b[H' + [...screen.lines, ...(screen.spin ? [spinLine()] : [])].join('\\r\\n'));
draw();
process.stdout.on('resize', draw);
if (screen.spin) setInterval(() => { frame++; draw(); }, 700);
// The status hooks of the app's --settings file: the same requests a real Claude Code posts.
const settingsAt = args.indexOf('--settings');
if (settingsAt >= 0 && screen.hooks.length) {
  const file = args[settingsAt + 1].replace(/^["']|["']$/g, '');
  const hooks = JSON.parse(readFileSync(file, 'utf8')).hooks ?? {};
  const names = { prompt: 'UserPromptSubmit', pre: 'PreToolUse', permission: 'PermissionRequest', stop: 'Stop' };
  for (const [event, body] of screen.hooks) {
    const hook = hooks[names[event]]?.[0]?.hooks?.[0];
    const url = hook?.url ?? hook?.args?.find((a) => /^http/.test(a));
    if (!url) continue;
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(hook.headers ?? {}) }, body: JSON.stringify({ hook_event_name: names[event], session_id: id, ...body }) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
  }
}
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`);
for (const cli of ['claude', 'codex']) {
  if (process.platform === 'win32') writeFileSync(join(bin, `${cli}.cmd`), `@"${process.execPath}" "%~dp0demo-agent.mjs" ${cli} %*\r\n`);
  else { writeFileSync(join(bin, cli), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/demo-agent.mjs" ${cli} "$@"\n`); chmodSync(join(bin, cli), 0o755); }
}
// Demo transcripts: only token counts and the model, which is all the context meter reads.
const claudeTranscript = (tokens, model) => [
  { type: 'user', sessionId: 'x', message: { role: 'user', content: 'demo' } },
  { type: 'assistant', message: { model, usage: { input_tokens: 12, cache_creation_input_tokens: 2048, cache_read_input_tokens: tokens - 2560, output_tokens: 500 } } },
].map((l) => JSON.stringify(l)).join('\n') + '\n';
const claudeDir = join(home, '.claude', 'projects', 'atlas-demo');
mkdirSync(claudeDir, { recursive: true });
writeFileSync(join(claudeDir, `${sessions.coordinator.id}.jsonl`), claudeTranscript(64_400, 'claude-opus-4-5'));
writeFileSync(join(claudeDir, `${sessions.frontend.id}.jsonl`), claudeTranscript(151_000, 'claude-sonnet-4-5'));
const today = new Date();
const codexDir = join(home, '.codex', 'sessions', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0'));
mkdirSync(codexDir, { recursive: true });
writeFileSync(join(codexDir, `rollout-${today.toISOString().slice(0, 19).replace(/:/g, '-')}-${sessions.review.id}.jsonl`), [
  { type: 'turn_context', payload: { model: 'gpt-5-codex' } },
  { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 150_000, output_tokens: 7_800, total_tokens: 157_800 }, model_context_window: 272_000 } } },
].map((l) => JSON.stringify(l)).join('\n') + '\n');

// ── servers: SSH (status bar, SFTP, a fake shell), a second SSH server with an untrusted key, Postgres, Redis ──────────
const remote = join(root, 'remote');
const remoteHome = join(remote, 'home', 'alice');
for (const dir of ['site/assets/img', 'site/assets/css', 'site/include', 'logs', 'backups', '.config']) mkdirSync(join(remoteHome, dir), { recursive: true });
mkdirSync(join(remote, 'etc', 'nginx', 'sites-enabled'), { recursive: true });
const remoteFiles = {
  'site/index.html': '<!doctype html>\n<title>Atlas storefront</title>\n<link rel="stylesheet" href="assets/css/site.css">\n<h1>Atlas</h1>\n',
  'site/assets/css/site.css': 'body { font: 16px/1.5 system-ui; margin: 0 auto; max-width: 72rem; }\n',
  'site/robots.txt': 'User-agent: *\nAllow: /\n',
  'site/catalog.json': JSON.stringify({ products: 3, updated: '2026-10-20' }, null, 2) + '\n',
  'logs/access.log': Array.from({ length: 400 }, (_, i) => `127.0.0.1 - - [20/Oct/2026:10:${String(i % 60).padStart(2, '0')}:00 +0000] "GET /catalog HTTP/1.1" 200 ${512 + i}`).join('\n') + '\n',
  'logs/error.log': '[warn] upstream response buffered to a temporary file\n',
  'backups/atlas-2026-10-19.sql.gz': 'x'.repeat(48_000),
  'backups/atlas-2026-10-20.sql.gz': 'x'.repeat(51_000),
  'deploy.sh': '#!/bin/sh\nset -e\nrsync -a site/ /var/www/atlas/\n',
  '.bashrc': 'export EDITOR=vim\n',
  'notes.md': '# Server notes\n\n- nginx reloads on deploy\n',
};
for (const [file, text] of Object.entries(remoteFiles)) writeFileSync(join(remoteHome, file), text);
writeFileSync(join(remote, 'etc', 'nginx', 'nginx.conf'), 'events {}\nhttp { include sites-enabled/*; }\n');
const sshServer = await startTestServer(['--no-auth', '--bar', 'debian', '--sftp-root', remote, '--sftp-home', '/home/alice', '--shell-root', remote, '--shell-home', '/home/alice']);
const newServer = await startTestServer(['--no-auth']);
const servers = [sshServer, newServer];
const startJsonServer = (script, args) => new Promise((resolveServer, reject) => {
  const server = spawn(process.execPath, [script, ...args], { cwd: checkout, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let buf = '';
  const timer = setTimeout(() => reject(new Error(`${script} did not start`)), 30000);
  server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${script} exited (${code})`)); });
  server.stdout.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); resolveServer({ ...JSON.parse(buf.slice(0, nl)), stop: () => killTree(server.pid) }); } });
});
const pgSeed = `
CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL, country text NOT NULL, created_at date NOT NULL DEFAULT current_date);
CREATE TABLE products (id serial PRIMARY KEY, sku text UNIQUE NOT NULL, name text NOT NULL, category text NOT NULL, price numeric(8,2) NOT NULL, stock int NOT NULL);
CREATE TABLE orders (id serial PRIMARY KEY, customer_id int REFERENCES customers(id), product_id int REFERENCES products(id), quantity int NOT NULL, status text NOT NULL, ordered_at timestamp NOT NULL);
CREATE INDEX orders_by_customer ON orders(customer_id);
CREATE VIEW order_totals AS SELECT o.id, c.name AS customer, p.name AS product, o.quantity * p.price AS total FROM orders o JOIN customers c ON c.id = o.customer_id JOIN products p ON p.id = o.product_id;
INSERT INTO customers (name, country, created_at) VALUES ('Northwind', 'US', '2026-01-12'), ('Contoso', 'DE', '2026-02-03'), ('Fabrikam', 'PL', '2026-03-21'), ('Tailspin', 'FR', '2026-04-08'), ('Wingtip', 'ES', '2026-05-30'), ('Litware', 'PT', '2026-06-14');
INSERT INTO products (sku, name, category, price, stock) VALUES ('ORB-01', 'Orbit desk lamp', 'lighting', 79.00, 42), ('FOL-02', 'Folio notebook', 'stationery', 12.00, 310), ('ARC-03', 'Arc bookend', 'workspace', 24.00, 88), ('LUM-04', 'Lumen strip', 'lighting', 35.50, 64), ('DOT-05', 'Dot grid pad', 'stationery', 6.90, 520), ('RIM-06', 'Rim cable tray', 'workspace', 18.00, 0), ('NOD-07', 'Node desk shelf', 'workspace', 129.00, 12), ('GLO-08', 'Glow night light', 'lighting', 22.00, 140), ('INK-09', 'Inkwell pen set', 'stationery', 15.50, 75), ('PAD-10', 'Felt desk pad', 'workspace', 32.00, 58), ('BEA-11', 'Beam floor lamp', 'lighting', 149.00, 9), ('TAB-12', 'Tab dividers', 'stationery', 4.20, 800);
INSERT INTO orders (customer_id, product_id, quantity, status, ordered_at) SELECT 1 + ((n * n + n / 4) % 6), 1 + ((n * 7) % 12), 1 + (n % 4), (ARRAY['paid','shipped','shipped','returned','paid'])[1 + (n % 5)], timestamp '2026-10-01 09:00' + n * interval '7 hours' FROM generate_series(1, 120) AS n;
`;
const pg = await startJsonServer('scripts/pg-test-server.mjs', ['--sql', pgSeed]);
servers.push(pg);
const redis = await startJsonServer('scripts/redis-test-server.mjs', []);
servers.push(redis);
{
  const client = new Redis({ host: '127.0.0.1', port: redis.port, lazyConnect: true, maxRetriesPerRequest: 1 });
  await client.connect();
  const products = [['orb-01', 'Orbit desk lamp', '79.00', '42'], ['fol-02', 'Folio notebook', '12.00', '310'], ['arc-03', 'Arc bookend', '24.00', '88'], ['lum-04', 'Lumen strip', '35.50', '64'], ['bea-11', 'Beam floor lamp', '149.00', '9']];
  for (const [sku, name, price, stock] of products) await client.hset(`catalog:product:${sku}`, { name, price, stock, currency: 'USD' });
  await client.zadd('catalog:bestsellers', 412, 'fol-02', 318, 'orb-01', 177, 'arc-03', 96, 'lum-04', 41, 'bea-11');
  await client.rpush('queue:emails', 'order-1001-confirmation', 'order-1002-confirmation', 'order-1003-shipped');
  await client.sadd('catalog:categories', 'lighting', 'stationery', 'workspace');
  for (let i = 0; i < 6; i++) await client.set(`session:${(0x7f3a10 + i * 4099).toString(16)}`, JSON.stringify({ user: 1001 + i, cart: i % 3, locale: 'en-US' }), 'EX', 1800 + i * 300);
  await client.set('stats:visits:2026-10-24', '18342');
  await client.xadd('events:orders', '*', 'type', 'created', 'order', '1001');
  await client.xadd('events:orders', '*', 'type', 'paid', 'order', '1001');
  client.disconnect();
}
const stopServers = () => { for (const server of servers) server.stop(); };
process.on('exit', stopServers);
writeKnownHost(root, sshServer);
// A SQLite file for the database panel.
const shopFile = join(root, 'shop.sqlite');
{
  const db = new DatabaseSync(shopFile);
  db.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE reviews (id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id), rating INTEGER, body TEXT);
    CREATE INDEX reviews_by_product ON reviews(product_id);
    CREATE VIEW low_stock AS SELECT sku, name, stock FROM products WHERE stock < 50;
    INSERT INTO products (sku, name, category, price, stock) VALUES ('ORB-01', 'Orbit desk lamp', 'lighting', 79, 42), ('FOL-02', 'Folio notebook', 'stationery', 12, 310), ('ARC-03', 'Arc bookend', 'workspace', 24, 88), ('LUM-04', 'Lumen strip', 'lighting', 35.5, 64), ('DOT-05', 'Dot grid pad', 'stationery', 6.9, 520), ('RIM-06', 'Rim cable tray', 'workspace', 18, 0);
    INSERT INTO reviews (product_id, rating, body) VALUES (1, 5, 'Warm light, sturdy base'), (1, 4, 'Great lamp, short cable'), (2, 5, 'Paper takes ink well'), (3, 3, 'Heavier than expected'), (5, 4, NULL);
  `);
  db.close();
}

// ── state.json ───────────────────────────────────────────────────────────────
const now = Date.now();
const sshHost = (label, address, port, group, tags, color, extra = {}) => ({ id: randomUUID(), label, address, port, username: 'alice', ...(group ? { group } : {}), ...(tags ? { tags } : {}), ...(color ? { color } : {}), createdAt: now, updatedAt: now, ...extra });
const hosts = {
  web1: sshHost('web-1', '127.0.0.1', sshServer.port, 'production', ['web', 'nginx'], '#60a5fa'),
  web2: sshHost('web-2', '127.0.0.1', sshServer.port, 'production', ['web', 'nginx'], '#60a5fa'),
  db1: sshHost('db-1', '127.0.0.1', sshServer.port, 'production', ['postgres'], '#f59e0b'),
  stagingWeb: sshHost('staging-web', 'stg-web.example.com', 22, 'staging', ['web'], '#a78bfa'),
  stagingDb: sshHost('staging-db', 'stg-db.example.com', 22, 'staging', ['postgres'], '#a78bfa'),
  build: sshHost('build-box', 'build.example.com', 22, null, ['ci'], '#10b981', { theme: 'fjord' }),
  backup: sshHost('backup-1', '127.0.0.1', newServer.port, 'production', ['backups'], '#f472b6'),
};
const grid = (cols, rows, areas) => ({ cols, rows, areas: areas.map(([col, row, colSpan = 1, rowSpan = 1]) => ({ col, row, colSpan, rowSpan })) });
const layout2x2 = grid(2, 2, [[0, 0], [1, 0], [0, 1], [1, 1]]);
// The agents grid: three agents on top, a shell and an SSH session below.
const agentCells = [
  { id: 'readme-claude-coordinator', name: 'Coordinator', profileId: 'claude', session: { cli: 'claude', id: sessions.coordinator.id, confirmed: true } },
  { id: 'readme-codex-review', name: 'API review', profileId: 'codex', session: { cli: 'codex', id: sessions.review.id, confirmed: true } },
  { id: 'readme-claude-frontend', name: 'Storefront', profileId: 'claude', color: '#f59e0b', session: { cli: 'claude', id: sessions.frontend.id, confirmed: true } },
  { id: 'readme-agents-tests', name: 'Tests', profileId: 'shell' },
  { id: randomUUID(), profileId: 'shell', ssh: { hostId: hosts.web1.id } },
];
const agentsLayout = grid(6, 2, [[0, 0, 2], [2, 0, 2], [4, 0, 2], [0, 1, 2], [2, 1, 4]]);
const cells = ['Tests', 'Catalog', 'Syntax check', 'Source review'].map((name, i) => ({ id: `readme-shell-${i}`, name, profileId: 'shell', color: ['#10b981', '#60a5fa', '#c084fc', '#fbbf24'][i] }));
const demoProject = { id: 'atlas', name: 'Atlas storefront', path: project, color: '#60a5fa', icon: { kind: 'emoji', value: '🌐' }, archive: [], activeTabId: 'agents', tabs: [
  { id: 'agents', name: 'Agents', layout: agentsLayout, cells: agentCells },
  { id: 'development', name: 'Development', layout: layout2x2, cells },
  // SSH sessions: one connected with its status bar, one on a server whose host key is not trusted yet (the connect card).
  { id: 'servers', name: 'Servers', layout: grid(2, 1, [[0, 0], [1, 0]]), cells: [
    { id: randomUUID(), profileId: 'shell', ssh: { hostId: hosts.web2.id } },
    { id: randomUUID(), profileId: 'shell', ssh: { hostId: hosts.backup.id } },
  ] },
] };
const notes = [
  { id: 'note-release', name: 'Release checklist', projectId: 'atlas', pinned: true, updatedAt: now - 3600e3, text: '# Release checklist #release\n\n- [x] Tests pass on Windows and macOS\n- [x] Update the changelog\n- [ ] Tag the release\n- [ ] Announce in #storefront\n\n```sh\nnpm test && npm run build\n```\n' },
  { id: 'note-api', name: 'Catalog API ideas', projectId: 'atlas', updatedAt: now - 86400e3, text: '# Catalog API ideas #api #backlog\n\n- Filter by **category** and price range\n- Cursor paging for large catalogs\n- Cache `formatPrice` per locale\n' },
  { id: 'note-standup', name: 'Standup 2026-10-24', updatedAt: now - 7200e3, text: '# Standup #daily\n\n- Coordinator finished the category filter\n- Review the API notes from Codex\n- [ ] Pair on the storefront build\n' },
  { id: 'note-servers', name: 'Server access', updatedAt: now - 3 * 86400e3, text: '# Server access #ops\n\nweb-1 and web-2 serve the storefront, db-1 runs Postgres.\n' },
];
const snippets = [
  { id: 'review', name: 'Review changes', icon: '🔎', color: '#60a5fa', text: 'Review the diff on {{branch}}. Focus on {{focus:correctness and missing tests}}.', autoSend: false },
  { id: 'test', name: 'Add focused tests', icon: '🧪', color: '#10b981', text: 'Add focused tests for {{area}} in {{project}}.', autoSend: false },
  { id: 'plan', name: 'Plan the next step', icon: '📋', color: '#c084fc', text: 'Explain the next implementation step before editing.', autoSend: false },
];
const dbConnection = (patch) => ({ id: randomUUID(), host: '127.0.0.1', port: 0, user: '', tls: 'disable', ssh: null, readOnly: false, createdAt: now, updatedAt: now, ...patch });
const dbConnections = [
  dbConnection({ kind: 'postgres', name: 'atlas (local)', port: pg.port, user: 'postgres', database: 'postgres', group: 'Local' }),
  dbConnection({ kind: 'redis', name: 'cache (local)', port: redis.port, group: 'Local' }),
  dbConnection({ kind: 'sqlite', name: 'shop.sqlite', path: shopFile, host: '', group: 'Files' }),
  // Listed only (never opened): a tunnel through db-1 and a MariaDB server.
  dbConnection({ kind: 'postgres', name: 'atlas (production)', port: 5432, user: 'atlas', database: 'atlas', tls: 'require', readOnly: true, ssh: { hostId: hosts.db1.id, dbHost: '127.0.0.1', dbPort: 5432 }, group: 'Production' }),
  dbConnection({ kind: 'mysql', name: 'legacy shop', host: 'shop-db.example.com', port: 3306, user: 'shop', database: 'shop', flavor: 'mariadb', tls: 'prefer', readOnly: true, group: 'Production' }),
];
const appState = {
  version: 1, activeProjectId: 'atlas', sshHosts: Object.values(hosts), notes, dbConnections, dbGroupColors: { Production: '#ef4444', Local: '#10b981' },
  sftp: { localPath: project, remotePaths: { [hosts.web1.id]: '/home/alice' } },
  projects: [demoProject,
    { id: 'design', name: 'Design system', path: project, color: '#c084fc', icon: { kind: 'emoji', value: '🎨' }, tabs: [], archive: [], activeTabId: null },
    { id: 'api', name: 'Catalog API', path: project, color: '#10b981', icon: { kind: 'emoji', value: '⚡' }, tabs: [], archive: [], activeTabId: null }],
  profiles: [{ id: 'claude', name: 'Claude Code', cli: 'claude', args: '', color: '#d97757' }, { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  snippets,
  presets: [{ id: 'review-team', name: 'Review team', layout: layout2x2, cells: ['Coordinator', 'Frontend', 'Backend', 'Tests'].map((name, i) => ({ name, profileId: i % 2 ? 'codex' : 'claude', role: i ? 'worker' : 'coordinator', worktree: false, prompt: ['Plan and coordinate the review.', 'Review the storefront accessibility.', 'Review catalog validation.', 'Check edge cases and tests.'][i] })) }],
  settings: { language: 'en', fontSize: 13, notifications: false, showAiUsage: false, shell: process.platform === 'win32' ? 'cmd' : 'bash', lastProfileId: 'claude' },
  sidebarCollapsed: false, snippetsOpen: false, notesOpen: false, sidebarWidth: 230, snippetsWidth: 260,
};
writeFileSync(join(data, 'state.json'), JSON.stringify(appState));

// ── the app ──────────────────────────────────────────────────────────────────
const port = await new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
});
const env = { ...process.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') };
scrubAppEnv(env); // never the real login folders or tokens
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`;
const child = spawn(electron, ['.'], { cwd: checkout, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', exited = false, socket, requestId = 0;
child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
child.on('error', e => { log += e.message; exited = true; }); child.on('exit', () => { exited = true; });
const pending = new Map(), exceptions = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (hold) {
  console.log(JSON.stringify({ port, pid: process.pid, root, ssh: sshServer.port, pg: pg.port, redis: redis.port }));
  await new Promise(() => {});
}
const WIDTH = 1600, HEIGHT = 1000;
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  const check = typeof fn === 'string' ? () => evaluate(fn).catch(() => false) : fn;
  while (Date.now() < end) { const value = await check(); if (value) return value; if (exited) throw new Error(`App exited: ${log}`); await sleep(100); }
  throw new Error(`Timeout: ${label}\n${log.slice(-3000)}`);
}
function cdp(method, params = {}, ws = socket) {
  const id = ++requestId;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolveRequest(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, ws = socket) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ws);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
/** Clicks the first element of `selector` whose text is `text` (exactly, or containing it with `{ partial: true }`). */
async function click(selector, text, { partial = false } = {}) {
  const match = text === undefined ? 'true' : partial ? `el.textContent.includes(${JSON.stringify(text)})` : `el.textContent.trim() === ${JSON.stringify(text)}`;
  await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${match}); if (!el) throw new Error('Missing control: ' + ${JSON.stringify(`${selector} ${text ?? ''}`)}); el.click(); })()`);
}
/** An app shortcut as a synthetic keydown on the focused element (what the app's own handlers listen to). */
async function key(key, code, modifiers = {}) {
  await evaluate(`(document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, code, bubbles: true, cancelable: true, ...modifiers })}))`);
}
const mod = isMac ? { metaKey: true } : { ctrlKey: true };
/** A real key press through CDP (modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift). */
async function press(keyName, modifiers = 0, vk = 0) {
  const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Backspace: 8 };
  const code = keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName;
  for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: vk || codes[keyName] || (keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0), modifiers, ...(keyName === 'Enter' && type === 'keyDown' && !modifiers ? { text: '\r' } : {}) });
}
const CTRL = isMac ? 4 : 2;
const insertText = (text) => cdp('Input.insertText', { text });
async function setValue(selector, value) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing field: ' + ${JSON.stringify(selector)}); el.focus(); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
const center = (selector, text) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('Missing: ' + ${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
async function hover(selector, text) { const p = await center(selector, text); await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); return p; }
async function contextMenu(selector, text) {
  const p = await center(selector, text);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1 });
  await until('!!document.querySelector(".menu")', `context menu of ${selector}`);
}
const menuItem = (label) => click('.menu .menu-item, .menu button', label, { partial: true });
const parkMouse = () => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: WIDTH - 2, y: HEIGHT - 2 });
const store = 'window.__mc.useStore.getState()';
async function screenshot(name, { ws = socket, settle = 600 } = {}) {
  await evaluate('document.fonts.ready', ws); await sleep(settle);
  const { data: png } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, ws);
  writeFileSync(join(output, `${name}.png`), Buffer.from(png, 'base64'));
  console.log(`Captured ${name}.png`);
}
// Every step starts from the Agents grid with the project list, no menu, dialog, palette or Settings in front.
async function resetView() {
  for (let i = 0; i < 3; i++) await press('Escape');
  await evaluate(`${store}.setUi({ palette: false, modal: null, dialog: null, settingsActive: false, settingsTabOpen: false })`);
  await evaluate(`(() => { const s = ${store}; if (s.s.snippetsOpen || s.s.notesOpen) s.update((st) => ({ ...st, snippetsOpen: false, notesOpen: false })); })()`);
  await selectTab('Agents');
  await openPanel('projects-view');
  await parkMouse();
}
async function selectTab(name) {
  await evaluate(`(() => { const tab = [...document.querySelectorAll('.workspace-tabs .tab')].find(el => el.textContent.includes(${JSON.stringify(name)})); if (!tab) throw new Error('Missing tab ' + ${JSON.stringify(name)}); tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
  await until(`[...document.querySelectorAll('.workspace-tabs .tab.active, .workspace-tabs .tab[aria-selected=true]')].some(el => el.textContent.includes(${JSON.stringify(name)})) || ${JSON.stringify(name)} === 'x'`, `tab ${name}`, 5000).catch(() => undefined);
}
/** Closes the file and diff tabs of the top strip (none of them has unsaved changes here). */
async function closeFileTabs() {
  await evaluate(`[...document.querySelectorAll('.workspace-tabs .file-tab .x')].forEach((x) => x.click())`);
  await until(`!document.querySelector('.workspace-tabs .file-tab')`, 'file tabs closed', 5000);
}
/** Shows a panel of the left rail (a click on the tile of the panel already shown would fold it). */
async function openPanel(id) {
  if (!(await evaluate(`document.querySelector('#${id}')?.getAttribute('aria-selected') === 'true' && !${store}.s.sidebarCollapsed`))) await click(`#${id}`);
  await until(`document.querySelector('#${id}')?.getAttribute('aria-selected') === 'true'`, `panel ${id}`, 5000);
}
const visibleSshCells = `[...document.querySelectorAll('.cell')].filter(c => c.querySelector('.cell-head .ssh-host') && c.offsetParent)`;

const steps = [];
const step = (name, run) => steps.push({ name, run });

step('main', async () => {
  // The shell cell runs the tests; the SSH cell connects (the status bar fills in) and lists the site folder.
  await evaluate(`window.__mc.terminals.paste('readme-agents-tests', ${JSON.stringify(isMac ? 'clear; node --test --test-reporter=spec' : 'cls & node --test --test-reporter=spec')}, true)`);
  await until(`${visibleSshCells}.some(c => [...c.querySelectorAll('.ssh-card button')].some(b => b.textContent === 'Connect'))`, 'SSH connect button');
  await evaluate(`${visibleSshCells}.forEach(c => [...c.querySelectorAll('.ssh-card button')].find(b => b.textContent === 'Connect')?.click())`);
  await until(`${visibleSshCells}.every(c => !c.querySelector('.ssh-card')) && !!document.querySelector('.ssh-bar .ssh-bar-mem')`, 'SSH session and its status bar');
  const sshCell = agentCells[4].id;
  await evaluate(`window.__mc.terminals.paste(${JSON.stringify(sshCell)}, 'cd site', true)`); await sleep(300);
  await evaluate(`window.__mc.terminals.paste(${JSON.stringify(sshCell)}, 'ls', true)`);
  await until(`!!document.querySelector('.ssh-bar-spark polyline') && !!document.querySelector('.ssh-bar .ssh-bar-net')`, 'status bar graph and network', 20000);
  await until(`${store}.ui.statusDetails['readme-claude-frontend'] && ${store}.ui.statuses['readme-claude-coordinator'] === 'working'`, 'agent statuses');
  await evaluate(`window.__mc.actions.focusCell?.('readme-claude-coordinator')`);
  await sleep(2500);
  await screenshot('main');
});

step('grid-dialog', async () => {
  await key('G', 'KeyG', { ...mod, shiftKey: true });
  await until('!!document.querySelector(".cell-table")', 'grid dialog');
  await click('.presets span.btn', 'Review team');
  await screenshot('grid-dialog');
});

step('palette', async () => {
  await key('k', 'KeyK', mod);
  await until('!!document.querySelector(".palette")', 'command palette');
  await evaluate(`(() => { const input = document.querySelector('.palette input'); input.focus(); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, 'new'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`document.querySelectorAll('.palette-item').length > 3 && [...document.querySelectorAll('.palette-item')].some(item => /SSH: new host/.test(item.textContent))`, 'palette search results');
  await screenshot('palette');
});

/** Shows the SSH view (its rail tile) and one of its sections: hosts, keys, known or sftp. */
async function openSsh(section) {
  if (!(await evaluate('!!document.querySelector(".ssh-nav-item")'))) await click('#terminal-view');
  await until(`!!document.querySelector('.ssh-nav-item[data-section="${section}"]') && !document.querySelector('.ssh-nav-item[data-section="${section}"]').disabled`, 'SSH view');
  await click(`.ssh-nav-item[data-section="${section}"]`);
}

step('ssh', async () => {
  // A generated key, used by the staging hosts.
  const key = await evaluate(`window.mc.ssh.generateKey({ label: 'deploy key', type: 'ed25519', savePassphrase: false })`);
  if (!key.ok) throw new Error(`key generation failed: ${JSON.stringify(key)}`);
  await evaluate(`${store}.update((st) => ({ ...st, sshHosts: st.sshHosts.map((h) => h.group === 'staging' ? { ...h, keyId: ${JSON.stringify(key.key.id)} } : h) }))`);
  await openSsh('hosts');
  await until('!!document.querySelector(".ssh-host-card")', 'host cards');
  await evaluate(`(() => { const card = [...document.querySelectorAll('.ssh-host-card')].find(c => c.textContent.includes('web-1')); card.querySelector('.ssh-host-edit').click(); })()`);
  await until(`document.querySelector('.ssh-view-detail h2')?.textContent === 'web-1'`, 'web-1 details');
  await parkMouse();
  await screenshot('ssh');
});

step('ssh-session', async () => {
  await selectTab('Servers');
  await until(`${visibleSshCells}.length === 2 && ${visibleSshCells}.every(c => !!c.querySelector('.ssh-card'))`, 'two SSH cells');
  await evaluate(`${visibleSshCells}.forEach(c => [...c.querySelectorAll('.ssh-card button')].find(b => b.textContent === 'Connect')?.click())`);
  // web-2 connects (its key is trusted); backup-1 is a new server: the card asks to trust its host key.
  await until(`${visibleSshCells}.some(c => !c.querySelector('.ssh-card')) && !!document.querySelector('.ssh-bar .ssh-bar-mem')`, 'web-2 connected');
  await until(`${visibleSshCells}.some(c => /SHA256/.test(c.querySelector('.ssh-card')?.textContent ?? ''))`, 'host key question');
  const web2 = appState.projects[0].tabs.find(t => t.id === 'servers').cells[0].id;
  for (const command of ['cd site', 'ls', 'cd ..', 'ls']) { await evaluate(`window.__mc.terminals.paste(${JSON.stringify(web2)}, ${JSON.stringify(command)}, true)`); await sleep(250); }
  await until(`!!document.querySelector('.ssh-bar-spark polyline') && !!document.querySelector('.ssh-bar .ssh-bar-net')`, 'status bar graph', 20000);
  await sleep(3500);
  await hover('.ssh-bar-disk');
  await until('!!document.querySelector(".ssh-bar-card")', 'disk card', 5000);
  await screenshot('ssh-session');
  // An unanswered host key question would come back as a toast in later images (and Cancel as an error badge): trust it once.
  await evaluate(`${visibleSshCells}.forEach(c => [...c.querySelectorAll('.ssh-card button')].find(b => b.textContent === 'Only this time')?.click())`);
  await until(`${visibleSshCells}.every(c => !c.querySelector('.ssh-card'))`, 'backup-1 connected');
});

step('sftp', async () => {
  await openSsh('sftp');
  if (!(await evaluate('!!document.querySelector(".sftp-pane-remote .sftp-list")'))) {
    await click('.sftp-connect .btn', undefined);
    await until('document.querySelectorAll(".sftp-host-option").length > 0', 'host picker');
    await click('.sftp-host-option', 'web-1', { partial: true });
  }
  const rows = (side) => `[...document.querySelectorAll('.sftp-pane-${side} .sftp-list .sftp-row')].map((r) => r.dataset.name)`;
  await until(`${rows('remote')}.includes('site') && ${rows('local')}.includes('README.md')`, 'both panes listed');
  // Two uploads finished in the transfer panel.
  for (const name of ['README.md', 'package.json']) {
    await click(`.sftp-pane-local .sftp-row[data-name="${name}"]`);
    await contextMenu(`.sftp-pane-local .sftp-row[data-name="${name}"]`);
    await menuItem('Upload to the server');
    await until(`${rows('remote')}.includes(${JSON.stringify(name)})`, `${name} uploaded`);
  }
  // A marquee over the local files (the mouse stays down), then a typed remote path with its folder suggestions.
  const from = await center('.sftp-pane-local .sftp-row[data-name="review.mjs"]');
  const to = await center('.sftp-pane-local .sftp-row[data-name="inspect.mjs"]');
  const x1 = from.right - 40, y1 = from.bottom + 30, x2 = to.left + 120, y2 = to.top + 6;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + (x2 - x1) * i / 10, y: y1 + (y2 - y1) * i / 10, button: 'left', buttons: 1 });
  await until('document.querySelectorAll(".sftp-pane-local .sftp-row.on").length >= 3', 'marquee selection');
  await evaluate(`(() => { const r = document.querySelector('.sftp-pane-remote .sftp-crumbs-rest'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: b.left + 4, clientY: b.top + 4 })); })()`);
  await until(`!!document.querySelector('.sftp-pane-remote .sftp-path-input')`, 'remote path field');
  await evaluate(`(() => { const i = document.querySelector('.sftp-pane-remote .sftp-path-input'); i.focus(); i.select(); })()`);
  await insertText('/home/alice/site/');
  await until(`document.querySelectorAll('.sftp-pane-remote .sftp-path-suggestions li').length >= 2`, 'path suggestions');
  await screenshot('sftp');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
  await press('Escape');
});

step('notes', async () => {
  await evaluate(`${store}.update((st) => ({ ...st, snippetsOpen: true, notesOpen: true, snippetsWidth: 340 }))`);
  await until(`[...document.querySelectorAll('.s-name')].some(e => e.textContent === 'Release checklist')`, 'notes list');
  await click('.s-name', 'Release checklist');
  await until('!!document.querySelector(".note-editor")', 'note editor');
  await click('.note-modes button', 'Preview');
  await until('!!document.querySelector(".note-preview input[type=checkbox]")', 'note preview');
  await screenshot('notes');
});

step('snippets', async () => {
  await evaluate(`${store}.update((st) => ({ ...st, snippetsOpen: true, notesOpen: false, snippetsWidth: 340 }))`);
  await evaluate(`window.__mc.actions.focusCell('readme-claude-coordinator')`);
  await until('document.querySelectorAll(".snippet").length === 3', 'snippets');
  await click('.snippet', 'Review changes', { partial: true });
  await until(`[...document.querySelectorAll('.modal, [role=dialog]')].some(d => d.textContent.includes('Review changes'))`, 'snippet variables');
  await screenshot('snippets');
  await press('Escape');
});

step('git', async () => {
  // Working-tree changes on top of the committed history, one of them staged.
  const catalogSource = join(project, 'src/catalog.mjs');
  if (!readFileSync(catalogSource, 'utf8').includes('categories(')) {
    writeFileSync(catalogSource, readFileSync(catalogSource, 'utf8').replace('price: 24 }', 'price: 26 }') + `\nexport function categories(catalog = products) {\n  return [...new Set(catalog.map(product => product.category))].sort();\n}\n\nexport function byCategory(category, catalog = products) {\n  return catalog.filter(product => product.category === category);\n}\n`);
    appendFileSync(join(project, 'README.md'), '\nSee `inspect.mjs` for a printed overview of the catalog.\n');
    writeFileSync(join(project, 'CHANGELOG.md'), '# Changelog\n\n- Add a category list\n');
    git('add', 'README.md');
  }
  await openPanel('git-view');
  await until('document.querySelectorAll(".git-file").length >= 3 && document.querySelectorAll(".git-commit").length >= 6', 'git changes and history');
  await click('.git-file[title="src/catalog.mjs"]');
  await until('document.querySelectorAll(".git-diff-line.add").length > 0', 'working-tree diff');
  await parkMouse();
  await screenshot('git');
  await closeFileTabs();
});

step('git-clone', async () => {
  await openPanel('git-view');
  await until(`document.querySelectorAll('.git-commit').length >= 6 && !!document.querySelector('.git-panel button.btn.icon.small[aria-haspopup="menu"]')`, 'git panel');
  await evaluate(`[...document.querySelectorAll('.git-panel button.btn.icon.small[aria-haspopup="menu"]')].pop().click()`);
  await until('!!document.querySelector(".menu")', 'git menu');
  await menuItem('Clone repository');
  await until('!!document.querySelector(".git-clone #git-clone-url")', 'clone dialog');
  await setValue('#git-clone-url', 'https://github.com/example/atlas-api.git');
  await screenshot('git-clone');
  await press('Escape');
});

const dbRow = (name) => `[...document.querySelectorAll('.db-row')].find((r) => r.querySelector('.db-name')?.textContent === ${JSON.stringify(name)})`;
const dbCell = (row, col) => `document.querySelector('.db-tab:not([hidden]) .db-grid [aria-rowindex="${row + 2}"] .db-gcell[data-col="${col}"]')`;
async function openConnection(name, child) {
  await openPanel('db-view');
  await until(`!!${dbRow(name)}`, `connection ${name}`);
  if (!(await evaluate(`!!${dbRow(child)}`))) await evaluate(`${dbRow(name)}.click()`);
  await until(`!!${dbRow(child)}`, `${child} under ${name}`);
}

step('database', async () => {
  await openConnection('atlas (local)', 'products');
  await evaluate(`${dbRow('products')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await until(`${dbCell(0, 2)}?.textContent === 'Orbit desk lamp'`, 'products rows');
  if (!(await evaluate(`!!${dbRow('price')}`))) await evaluate(`${dbRow('products')}.querySelector('.db-chev-hit').click()`);
  await until(`!!${dbRow('price')}`, 'columns of products');
  // Two staged edits (not saved): the changed cells stay highlighted until Save.
  for (const [row, col, value] of [[5, 5, '24'], [10, 4, '139.00']]) {
    await evaluate(`${dbCell(row, col)}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await until('!!document.querySelector(".db-cell-editor input")', 'cell editor');
    await setValue('.db-cell-editor input', value);
    await press('Enter');
    await until(`${dbCell(row, col)}?.classList.contains('changed')`, 'staged cell');
  }
  await parkMouse();
  await screenshot('database');
});

step('sql', async () => {
  await openConnection('atlas (local)', 'products');
  await contextMenu('.db-row .db-name', 'atlas (local)');
  await menuItem('New SQL editor');
  await until(`!!document.querySelector('.db-tab:not([hidden]) .db-sql-editor .cm-content')`, 'SQL editor');
  const run = async (sql) => {
    await evaluate(`document.querySelector('.db-tab:not([hidden]) .db-sql-editor .cm-content').focus()`);
    await press('a', CTRL);
    await insertText(sql);
    await press('Enter', CTRL);
    await until(`!!document.querySelector('.db-tab:not([hidden]) .db-result-tab') && !document.querySelector('.db-tab:not([hidden]) [data-action=cancel]:not([disabled])')`, 'query result');
    await sleep(400);
  };
  await run('SELECT count(*) FROM orders;');
  await run("SELECT sku, name, stock FROM products WHERE stock < 50 ORDER BY stock;");
  await run([
    'SELECT c.name AS customer,',
    '       count(*) AS orders,',
    '       sum(o.quantity * p.price) AS revenue',
    'FROM orders o',
    'JOIN customers c ON c.id = o.customer_id',
    'JOIN products p ON p.id = o.product_id',
    "WHERE o.status <> 'returned'",
    'GROUP BY c.name',
    'ORDER BY revenue DESC;',
  ].join('\n'));
  await until(`${dbCell(0, 0)}?.textContent.length > 0`, 'revenue rows');
  await click('.db-tab:not([hidden]) [data-action=history]');
  await until(`document.querySelectorAll('.db-tab:not([hidden]) .db-history-item').length >= 3`, 'query history');
  await evaluate(`document.querySelectorAll('.db-tab:not([hidden]) .db-history-item .db-history-star')[1]?.click()`);
  await parkMouse();
  await screenshot('sql');
});

step('redis', async () => {
  await openConnection('cache (local)', 'catalog');
  // The Postgres tree of the previous steps folds away, so the Redis tree has the room.
  if (await evaluate(`${dbRow('atlas (local)')}.getAttribute('aria-expanded') === 'true'`)) await evaluate(`${dbRow('atlas (local)')}.click()`);
  const row = (cls, text) => `[...document.querySelectorAll('.db-row.${cls}')].find((r) => r.textContent.startsWith(${JSON.stringify(text)}))`;
  if (!(await evaluate(`!!${row('db-redisFolder', 'product')}`))) await evaluate(`${row('db-redisFolder', 'catalog')}.click()`);
  await until(`!!${row('db-redisFolder', 'product')}`, 'catalog keys');
  if (!(await evaluate(`!!${row('db-redisKey', 'orb-01')}`))) await evaluate(`${row('db-redisFolder', 'product')}.click()`);
  await until(`!!${row('db-redisKey', 'orb-01')}`, 'product keys');
  await evaluate(`${row('db-redisKey', 'orb-01')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await until("document.body.innerText.includes('Orbit desk lamp')", 'the hash in the key browser');
  await parkMouse();
  await screenshot('redis');
});

step('db-connection', async () => {
  // The read-only production connection (never opened): its tunnel through db-1 and TLS in the connection form.
  await openPanel('db-view');
  await until(`!!${dbRow('atlas (production)')}`, 'production connection');
  await contextMenu('.db-row .db-name', 'atlas (production)');
  await menuItem('Edit');
  await until('!!document.querySelector(".db-editor")', 'connection form');
  await click('.db-editor .db-tab-btn', 'SSH and TLS');
  await parkMouse();
  await screenshot('db-connection');
  await press('Escape');
});

step('monitor', async () => {
  await evaluate(`${store}.update((st) => ({ ...st, sidebarWidth: 340 }))`);
  await openPanel('monitor-view');
  await sleep(3000);
  await screenshot('monitor');
  await evaluate(`${store}.update((st) => ({ ...st, sidebarWidth: 230 }))`);
});

step('settings', async () => {
  await click('button[aria-label="Settings"]');
  await until('!!document.querySelector(".settings-nav [role=tab]")', 'settings page');
  await click('.settings-nav [role=tab]', 'SSH');
  await until('!!document.querySelector("#settings-ssh-bar")', 'SSH settings');
  await screenshot('settings');
});

step('find', async () => {
  await openPanel('files-view');
  await until('!!document.querySelector(".file-entry[title=src]")', 'file tree');
  if (!(await evaluate(`!!document.querySelector('.file-entry[title="src/catalog.mjs"]')`))) await click('.file-entry[title=src]');
  await until(`!!document.querySelector('.file-entry[title="src/catalog.mjs"]')`, 'source file');
  await click('.file-entry[title="src/catalog.mjs"]');
  await until('!!document.querySelector(".cm-editor .cm-content")', 'editor');
  await evaluate('document.querySelector(".cm-editor .cm-content").focus()');
  await press('f', CTRL);
  await until('!!document.querySelector(".find-widget input, .find-box input")', 'find widget');
  await insertText('product');
  await sleep(500);
  await screenshot('find');
  await closeFileTabs();
  await press('Escape');
});

/** The text of a terminal (its xterm buffer: the WebGL renderer draws on a canvas). */
const termText = (id) => `(() => { const t = window.__mc.terminals.xterm(${JSON.stringify(id)}); if (!t) return ''; const b = t.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`;
let developmentDemo = false;
/** The Development grid in front with the demo output of its four shells (tests, the catalog, a syntax check, a source review). */
async function runDevelopmentDemo() {
  await selectTab('Development');
  await until("document.querySelectorAll('.cell').length === 4", 'Development cells');
  if (!developmentDemo) {
    await until(cells.map((c) => `/>|\\$ ?$/m.test(${termText(c.id)}.trim())`).join(' && '), 'Development shells ready');
    const commands = ['node --test --test-reporter=spec', 'node inspect.mjs', 'node --check src/catalog.mjs && echo JavaScript syntax checks passed.', 'node review.mjs'];
    for (let i = 0; i < cells.length; i++) await evaluate(`window.__mc.terminals.paste(${JSON.stringify(cells[i].id)}, ${JSON.stringify(`${isMac ? 'clear;' : 'cls &'} ${commands[i]}`)}, true)`);
    developmentDemo = true;
  }
  await until(`${termText(cells[0].id)}.includes('pass 6') && ${termText(cells[3].id)}.includes('Ready to review')`, 'Development demo output');
}

step('split', async () => {
  await runDevelopmentDemo();
  await openPanel('files-view');
  await until('!!document.querySelector(".file-entry[title=\\"README.md\\"]")', 'README in the tree');
  await click('.file-entry[title="README.md"]');
  await until('!!document.querySelector("[data-action=split-view]")', 'file header');
  await click('[data-action=split-view]');
  await evaluate(`${store}.update((st) => ({ ...st, sidebarCollapsed: true }))`);
  await sleep(1500);
  await parkMouse();
  await screenshot('split');
  await click('[data-action=split-view]');
  await closeFileTabs();
  await evaluate(`${store}.update((st) => ({ ...st, sidebarCollapsed: false }))`);
});

step('detached', async () => {
  await runDevelopmentDemo();
  await contextMenu('.workspace-tabs .tab', 'Development');
  await menuItem('Move to new window');
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.includes('detached=')); } catch { return null; } }, 'detached window');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  ws.addEventListener('message', e => { const message = JSON.parse(e.data); const p = pending.get(message.id); if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); } });
  try {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false }, ws);
    await until(() => evaluate(`document.querySelectorAll('.cell').length === 4 && ${termText(cells[3].id)}.includes('Ready to review')`, ws).catch(() => false), 'detached grid output');
    await sleep(1500);
    await screenshot('detached', { ws });
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Attach back'))?.click()`, ws).catch(() => undefined);
  } finally { ws.close(); }
  await until(`[...document.querySelectorAll('.workspace-tabs .tab')].some(el => el.textContent.includes('Development'))`, 'grid back in the main window');
});

// The SSH view comes after the sessions, so its host cards show which hosts are connected.
const ORDER = ['main', 'ssh-session', 'ssh', 'sftp', 'git', 'git-clone', 'notes', 'snippets', 'monitor', 'settings', 'find', 'split', 'grid-dialog', 'palette', 'database', 'sql', 'redis', 'db-connection', 'detached'];
steps.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
const runSteps = steps.filter(s => !only || only.includes(s.name));
if (only && runSteps.length !== only.length) throw new Error(`Unknown step in --only: ${only.filter(n => !steps.some(s => s.name === n)).join(', ')} (steps: ${steps.map(s => s.name).join(', ')})`);
try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && !t.url.includes('detached=')); } catch { return null; } }, 'debugger');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  socket.addEventListener('message', e => {
    const message = JSON.parse(e.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    const p = pending.get(message.id); if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // Electron does not expose Chrome's Browser window-management CDP methods.
  await cdp('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await until('!!window.mc && !!window.__mc && document.querySelectorAll(".cell").length === 5', 'the Agents grid');
  // The README shows the version the screenshots were taken with (the release bumps package.json later).
  const version = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version;
  await until(`document.querySelector('.sb-version')?.textContent.includes(${JSON.stringify(`v${version}`)})`, `status bar shows v${version}`);
  console.log(`Capturing with version ${version}`);
  if (await evaluate('document.title !== "unimux" || document.querySelector(".bn-base")?.textContent !== "unimux"')) throw new Error('Expected Unimux branding');
  for (const { name, run } of runSteps) {
    await resetView();
    try { await run(); } catch (error) { throw new Error(`Step ${name}: ${error.message}`); }
  }
  if (argv.includes('--verify')) {
    await resetView();
    await selectTab('Development');
    await evaluate(`${store}.update((st) => ({ ...st, snippetsOpen: true, snippetsWidth: 260 }))`);
    await verifyWorkspaceUI({ cdp, evaluate, click, key, until, project, cells, screenshot });
  }
  if (exceptions.length) throw new Error(`Renderer exceptions: ${exceptions.join('; ')}`);
  console.log(`Screenshots: ${output}\nIsolated demo data: ${root}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (socket?.readyState === WebSocket.OPEN) await screenshot('failure').catch(() => undefined);
} finally {
  stopServers();
  if (socket?.readyState === WebSocket.OPEN) { await cdp('Browser.close').catch(() => {}); socket.close(); }
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  if (!exited) killTree(child.pid);
}
