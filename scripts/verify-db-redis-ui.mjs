// Real-app check of the Redis UI (1.0.0): the built app with a scratch data dir and home, the local Redis-like server
// (scripts/redis-test-server.mjs: password, seeded keys of every type) and the local SSH test server for a read-only tunnel
// connection. Everything is driven through the UI over CDP (palette, key browser, value panel, dialogs, console, Pub/Sub,
// server views); a separate session of the same connection reads back what the UI wrote. Screenshots go to
// D:\Projekty\_shots\100-redis-*.png. Run `npm run build` first. Never touches real hosts or the user's data dir; kills only the
// PIDs it started.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { killTree, launchApp, scratchRoot, sleep, sshState, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

async function startRedis() {
  const child = spawn(process.execPath, ['scripts/redis-test-server.mjs', '--password', 'redis-ui-pw', '--seed', '1200'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('redis test server did not start')), 30000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`redis test server exited (${code})`)); });
    child.stdout.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, nl))); } });
  });
  return { ...info, stop: () => killTree(child.pid) };
}

let passed = 0;
const check = (cond, label) => { if (!cond) throw new Error(`FAILED: ${label}`); passed++; console.log(`ok - ${label}`); };
const j = JSON.stringify;

const root = scratchRoot('redis-ui');
const redis = await startRedis();
const ssh = await startTestServer();
let app;
try {
  const host = testHost(ssh.port);
  writeKnownHost(root, ssh);
  writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host] }));
  app = await launchApp(root);
  const { evaluate, until, click, setValue, screenshot } = app;
  const shot = async (name) => { await sleep(250); await screenshot(`100-redis-${name}.png`); };

  // ── setup: two saved connections (the connections panel is another task; saving goes through the same API) ──
  const a = await evaluate(`window.mc.db.saveConnection({ kind: 'redis', name: 'local redis', color: '#dc382d', host: '127.0.0.1', port: ${redis.port}, user: '', dbIndex: 0, tls: 'disable', ssh: null, readOnly: false }, { set: 'redis-ui-pw' })`);
  const b = await evaluate(`window.mc.db.saveConnection({ kind: 'redis', name: 'vps redis', color: '#a78bfa', host: 'localhost', port: 6379, user: '', dbIndex: 0, tls: 'disable', ssh: { hostId: ${j(host.id)}, dbHost: '127.0.0.1', dbPort: ${redis.port} }, readOnly: true }, { set: 'redis-ui-pw' })`);
  check(a.ok && b.ok, 'two Redis connections are saved (direct, and read-only through SSH)');
  // A separate session that reads back what the UI wrote.
  const probe = await evaluate(`(async () => {
    const c = await window.mc.db.connect(${j(a.connection.id)});
    for (let i = 0; i < 100; i++) { const s = (await window.mc.db.sessions()).sessions.find((x) => x.id === c.sessionId); if (s?.state === 'connected') return c.sessionId; await new Promise((r) => setTimeout(r, 100)); }
    return null; })()`);
  check(!!probe, 'a probe session connects');
  const cmd = (...argv) => evaluate(`window.mc.db.redis.command(${j(probe)}, { argv: ${j(argv)} }).then((r) => r.ok ? r.value.reply : r)`);

  // Helpers on the page: React inputs, form submits, Select options, rows by title.
  const submit = (selector) => evaluate(`(() => { const f = document.querySelector(${j(selector)}); if (!f) throw new Error('no form ' + ${j(selector)}); f.requestSubmit(); return true; })()`);
  const choose = async (trigger, label) => {
    await click(trigger);
    await until(`!!document.querySelector('.select-popup [role=option]')`, 'select popup');
    await evaluate(`(() => { const o = [...document.querySelectorAll('.select-popup [role=option]')].find((e) => e.textContent.trim().startsWith(${j(label)})); if (!o) throw new Error('no option ' + ${j(label)}); o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); o.click(); return true; })()`);
  };
  const textOf = (selector) => evaluate(`document.querySelector(${j(selector)})?.textContent ?? ''`);
  const count = (selector) => evaluate(`document.querySelectorAll(${j(selector)}).length`);
  const openPalette = async (query, item) => {
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true })), true`);
    await until(`!!document.querySelector('.palette input')`, 'palette');
    await setValue('.palette input', query);
    await until(`[...document.querySelectorAll('.palette-item')].some((e) => e.textContent.includes(${j(item)}))`, `palette item ${item}`);
    await click('.palette-item', item);
  };
  const keyRow = (name) => `[...document.querySelectorAll('.redis-key-row')].find((e) => e.title === ${j(name)})`;
  const search = async (pattern) => {
    await setValue('.redis-search input[aria-label="Wzorzec kluczy"]', pattern);
    await submit('.redis-keys-pane .redis-search');
  };
  const openKey = async (name) => {
    await click('.redis-keys-pane .redis-seg button', 'Lista');
    await search(name);
    await until(`!!${keyRow(name)}`, `key row ${name}`);
    await evaluate(`${keyRow(name)}.click(), true`);
    await until(`(document.querySelector('.redis-value-key')?.textContent ?? '').endsWith(${j(name)})`, `value panel of ${name}`);
  };
  const confirmDialog = async (button) => {
    await until(`!!document.querySelector('.modal-foot')`, 'confirm dialog');
    await click('.modal-foot button', button);
  };

  // ── key browser ──
  await openPalette('Redis', 'Otwórz przeglądarkę Redis: local redis');
  await until(`!!document.querySelector('.redis-browser .redis-key-row')`, 'key browser connected with keys', 30000);
  check((await textOf('.workspace-tabs .redis-strip-tab')).includes('local redis'), 'the key browser opens as a tab of the top strip with the connection name');
  await until(`(document.querySelector('.redis-db-select')?.textContent ?? '').includes('DB 0')`, 'db switcher');
  check((await textOf('.redis-db-select')).includes('DB 0'), 'the DB switcher shows DB 0');
  check(await evaluate(`[...document.querySelectorAll('.redis-key-row.folder')].some((r) => r.textContent.includes('item') && /\\d{3}/.test(r.textContent))`), 'keys group into a ":"-tree: folder "item" with its count');
  check(!!(await evaluate(`!!document.querySelector('.redis-load-more')`)), 'a first page of keys is loaded with "Wczytaj więcej"');
  await click('.redis-load-more');
  await until(`(document.querySelector('.redis-loaded')?.textContent ?? '').match(/1[\\s ,.]?0\\d\\d/)`, 'second page');
  check(true, '"Wczytaj więcej" loads the next SCAN page');
  await shot('browser');
  await click('.redis-seg button', 'Lista');
  await search('user:*');
  await until(`document.querySelectorAll('.redis-key-row').length === 1 && !!${keyRow('user:1')}`, 'pattern user:*');
  check(true, 'pattern search (SCAN MATCH) finds user:1 in the flat list');
  await search('');
  await choose('.redis-type-select', 'list');
  await until(`document.querySelectorAll('.redis-key-row').length === 1 && !!${keyRow('queue')}`, 'type filter');
  check(true, 'the type filter shows only the list key');
  await choose('.redis-type-select', 'Wszystkie');

  // ── string: a new JSON key, JSON view, edit ──
  await click('.redis-new-key');
  await setValue('.redis-new-name', 'json:1');
  await setValue('.redis-new-value', '{"a":1,"big":12345678901234567890,"list":[1,2]}');
  await click('.redis-create');
  await until(`(document.querySelector('.redis-value-key')?.textContent ?? '').endsWith('json:1')`, 'new key shown');
  await until(`(document.querySelector('.redis-string-text')?.value ?? '').includes('"big": 12345678901234567890')`, 'json pretty view');
  check(await evaluate(`!!document.querySelector('.redis-ok-text')`), 'a new string key is created and shown in the JSON pretty view (big integer kept, valid)');
  await shot('string-json');
  await setValue('.redis-string-text', '{\n  "a": 2,\n  "big": 12345678901234567890,\n  "list": [1, 2]\n}');
  await click('.redis-save');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['GET', 'json:1'] }); return r.ok && r.value.reply.v === '{"a":2,"big":12345678901234567890,"list":[1,2]}'; })()`, 'json saved');
  check(true, 'editing in the JSON view saves compact JSON with every digit');

  // ── TTL set and persist ──
  await click('.redis-ttl-btn');
  await setValue('.redis-ttl-input', '2h');
  await click('.redis-ttl-save');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['TTL', 'json:1'] }); return r.ok && Number(r.value.reply.v) > 7000; })()`, 'ttl set');
  await until(`(document.querySelector('.redis-ttl-btn')?.textContent ?? '').includes('h')`, 'ttl shown');
  check(true, 'TTL is set (2h) and shown');
  await click('.redis-ttl-btn');
  await click('.redis-persist');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['TTL', 'json:1'] }); return r.ok && r.value.reply.v === '-1'; })()`, 'persist');
  check(true, 'TTL is removed (persist)');

  // ── hash ──
  await openKey('user:1');
  await until(`[...document.querySelectorAll('.redis-item')].some((e) => e.textContent.includes('Kraków'))`, 'hash fields');
  await evaluate(`[...document.querySelectorAll('.redis-item')].find((e) => e.textContent.includes('name')).click(), true`);
  await until(`!!document.querySelector('.redis-editor .redis-value-text')`, 'hash editor');
  await setValue('.redis-editor .redis-value-text', 'Alicja');
  await click('.redis-editor .redis-save');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['HGET', 'user:1', 'name'] }); return r.ok && r.value.reply.v === 'Alicja'; })()`, 'hset');
  check(true, 'a hash field is edited');
  await shot('hash');

  // ── list ──
  await openKey('queue');
  await until(`document.querySelectorAll('.redis-item').length === 2`, 'list items');
  await setValue('.redis-push-input', 'third');
  await click('.redis-rpush');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['LINDEX', 'queue', '-1'] }); return r.ok && r.value.reply.v === 'third'; })()`, 'rpush');
  await until(`document.querySelectorAll('.redis-item').length === 3`, 'list reloaded');
  check(true, 'a list element is pushed to the right and the list shows it');

  // ── set ──
  await openKey('tags');
  await until(`document.querySelectorAll('.redis-item').length === 2`, 'set members');
  await setValue('.redis-add-member', 'c');
  await click('.redis-add');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['SISMEMBER', 'tags', 'c'] }); return r.ok && r.value.reply.v === '1'; })()`, 'sadd');
  check(true, 'a set member is added');

  // ── sorted set ──
  await openKey('scores');
  await until(`document.querySelectorAll('.redis-item.zset').length === 2`, 'zset entries');
  check(await evaluate(`document.querySelector('.redis-item.zset .redis-item-value').textContent === 'ola'`), 'sorted set shows members by score (lowest first)');
  await click('.redis-sort');
  await until(`document.querySelector('.redis-item.zset .redis-item-value')?.textContent === 'ala'`, 'sorted desc');
  check(true, 'sorting by score flips the order');
  await evaluate(`[...document.querySelectorAll('.redis-item.zset')].find((e) => e.textContent.includes('ola')).click(), true`);
  await setValue('.redis-score-input', '99');
  await click('.redis-editor .redis-save');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['ZSCORE', 'scores', 'ola'] }); return r.ok && r.value.reply.v === '99'; })()`, 'zscore');
  check(true, 'a sorted set score is edited');
  await shot('zset');

  // ── stream ──
  await openKey('events');
  await until(`document.querySelectorAll('.redis-item').length === 1`, 'stream entries');
  await click('.redis-items .redis-add');
  await setValue('.redis-xadd-field', 'type');
  await setValue('.redis-xadd-value', 'logout');
  await click('.redis-xadd');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['XLEN', 'events'] }); return r.ok && r.value.reply.v === '2'; })()`, 'xadd');
  await until(`document.querySelectorAll('.redis-item').length === 2 && document.querySelector('.redis-item').textContent.includes('logout')`, 'stream reloaded newest first');
  check(true, 'a stream entry is added and shows first (newest first)');
  await shot('stream');

  // ── fix round 1: sorted set NX, CRLF round-trip, mixed line endings, JSON save style ──
  await openKey('scores');
  await click('.redis-items .redis-add');
  await setValue('.redis-add-first', 'ala');
  await setValue('.redis-add-second', '5');
  await click('.redis-add-save');
  await until(`(document.querySelector('.toast')?.textContent ?? '').includes('już istnieje')`, 'zset nx refusal');
  check((await cmd('ZSCORE', 'scores', 'ala')).v === '10', 'adding a sorted-set member that exists does not overwrite its score (NX)');
  await cmd('SET', 'crlf:1', 'line one\r\nline two\r\n');
  await openKey('crlf:1');
  await until(`(document.querySelector('.redis-string-text')?.value ?? '') === 'line one\\nline two\\n'`, 'crlf shown with lf');
  check(await evaluate(`[...document.querySelectorAll('.redis-chip')].some((c) => c.textContent === 'CRLF')`), 'a CRLF value is marked CRLF');
  await setValue('.redis-string-text', 'line one\nline two\nline three\n');
  await click('.redis-save');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['GET', 'crlf:1'] }); return r.ok && r.value.reply.v === 'line one\\r\\nline two\\r\\nline three\\r\\n'; })()`, 'crlf kept');
  check(true, 'editing a CRLF value keeps its CRLF line endings');
  await cmd('SET', 'mixed:1', 'a\r\nb\nc');
  await openKey('mixed:1');
  await until(`!!document.querySelector('.redis-string-text')?.readOnly && [...document.querySelectorAll('.redis-note button')].some((b) => b.textContent.includes('Hex'))`, 'mixed read-only');
  check(true, 'a value with mixed line endings is read-only as text, with "edit as hex"');
  await cmd('SET', 'json:spaced', '{"a": 1}');
  await openKey('json:spaced');
  await until(`(document.querySelector('.redis-string-text')?.value ?? '').includes('"a": 1')`, 'json view');
  await setValue('.redis-string-text', '{\n  "a": 5\n}');
  await click('.redis-save');
  await until(`(document.querySelector('.modal-head')?.textContent ?? '').includes('JSON')`, 'json style question');
  check(true, 'saving JSON that has its own formatting asks: formatted or compact');
  await confirmDialog('Kompaktowy');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['GET', 'json:spaced'] }); return r.ok && r.value.reply.v === '{"a":5}'; })()`, 'json compact saved');
  check(true, 'the chosen JSON style is saved');

  // ── binary string ──
  await search('bin*');
  await until(`[...document.querySelectorAll('.redis-key-row')].some((e) => e.title.startsWith('bin'))`, 'binary key');
  await evaluate(`[...document.querySelectorAll('.redis-key-row')].find((e) => e.title.startsWith('bin')).click(), true`);
  await until(`(document.querySelector('.redis-string-text')?.value ?? '') === 'de ad be ef'`, 'hex view');
  check(await evaluate(`!!document.querySelector('.redis-value-head .redis-bin') && document.querySelector('.redis-string .redis-seg button.on')?.textContent === 'Hex'`), 'a binary key and value show with a binary marker in the hex view');
  await shot('binary');

  // ── rename with overwrite confirmation ──
  await openKey('json:1');
  await click('.redis-rename');
  await setValue('.redis-rename-input', 'tags');
  await click('.redis-rename-save');
  await until(`!!document.querySelector('.modal-foot') && document.querySelector('.modal-head').textContent.includes('tags')`, 'overwrite question');
  check(true, 'renaming onto an existing key asks before overwriting');
  await confirmDialog('Nadpisz');
  await until(`(async () => { const r = await window.mc.db.redis.command(${j(probe)}, { argv: ['TYPE', 'tags'] }); const g = await window.mc.db.redis.command(${j(probe)}, { argv: ['EXISTS', 'json:1'] }); return r.ok && r.value.reply.v === 'string' && g.value.reply.v === '0'; })()`, 'renamed');
  check(true, 'the rename overwrites after the confirmation');

  // ── delete by pattern with the count ──
  await search('');
  await click('.redis-keys-pane .redis-toolbar.sub .btn', 'Usuń wg wzorca');
  await setValue('.redis-pattern-input', 'item:1*');
  await click('.redis-pattern-run');
  await until(`(document.querySelector('.redis-pattern-run')?.textContent ?? '').includes('311')`, 'pattern count');
  check(true, 'delete by pattern counts first (311 keys for item:1*)');
  await shot('pattern-delete');
  await click('.redis-pattern-run');
  await until(`!document.querySelector('.redis-pattern-run')`, 'pattern delete finished').catch(async (e) => { console.log('dialog:', await textOf('.redis-dialog')); throw e; });
  await until(`(async () => { const r = await window.mc.db.redis.countPattern(${j(probe)}, 'item:1*'); return r.ok && r.value.count === 0; })()`, 'pattern deleted')
    .catch(async (e) => { console.log('probe:', j(await evaluate(`window.mc.db.redis.countPattern(${j(probe)}, 'item:1*')`)), 'toast:', await textOf('.toast')); throw e; });
  check(true, 'the confirmed delete removes exactly the counted keys');

  // ── multi-select delete ──
  await search('item:2*');
  await until(`document.querySelectorAll('.redis-key-row').length > 3`, 'item:2 keys');
  await click('.redis-seg button', 'Lista');
  await evaluate(`[...document.querySelectorAll('.redis-key-row .redis-key-check')].slice(0, 3).forEach((c) => c.click()), true`);
  await until(`(document.querySelector('.redis-foot')?.textContent ?? '').includes('3')`, 'selected 3');
  await click('.redis-delete-selected');
  await until(`(document.querySelector('.modal-body')?.textContent ?? '').includes('3')`, 'delete selected confirmation with count');
  check(true, 'deleting the selection asks with the count');
  await confirmDialog('Usuń (3)');
  await until(`(async () => { const r = await window.mc.db.redis.countPattern(${j(probe)}, 'item:2*'); return r.ok && r.value.count === 108; })()`, 'deleted 3');
  check(true, 'the selected keys are deleted');

  // ── fix round 1: a folder with glob characters deletes only its own keys; keyboard navigation ──
  await cmd('SET', 'a[1]:x', '1');
  await cmd('SET', 'a1:x', '2');
  await search('a*');
  await click('.redis-seg button', 'Drzewo');
  const folderRow = "[...document.querySelectorAll('.redis-key-row.folder')].find((r) => r.querySelector('.redis-key-name')?.textContent === 'a[1]')";
  await until(`!!${folderRow}`, 'folder a[1]');
  await evaluate(`(() => { const r = ${folderRow}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 20, clientY: b.top + 8 })); return true; })()`);
  await until(`[...document.querySelectorAll('[role=menuitem]')].some((b) => b.textContent.includes('a\\\\[1\\\\]:*'))`, 'escaped folder pattern in the menu');
  await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.includes('a\\\\[1\\\\]:*')).click(), true`);
  await until(`document.querySelector('.redis-pattern-input')?.value === 'a\\\\[1\\\\]:*'`, 'escaped pattern prefilled');
  await click('.redis-pattern-run');
  await until(`(document.querySelector('.redis-pattern-run')?.textContent ?? '').includes(' 1 ')`, 'folder count 1');
  check(await evaluate(`(document.querySelector('.redis-where')?.textContent ?? '').includes('local redis · DB 0')`), 'the pattern delete names the connection and DB');
  await click('.redis-pattern-run');
  await until(`(async () => { const a = await window.mc.db.redis.command(${j(probe)}, { argv: ['EXISTS', 'a[1]:x'] }); const b = await window.mc.db.redis.command(${j(probe)}, { argv: ['EXISTS', 'a1:x'] }); return a.ok && b.ok && a.value.reply.v === '0' && b.value.reply.v === '1'; })()`, 'folder delete');
  check(true, 'deleting folder a[1]: removes only its key, not a1:x (glob characters escaped)');
  await search('user:*');
  await click('.redis-seg button', 'Lista');
  await until(`!!${keyRow('user:1')}`, 'user:1 row');
  await evaluate(`(() => { const l = document.querySelector('.redis-key-list'); l.focus(); l.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return true; })()`);
  await until(`(document.querySelector('.redis-value-key')?.textContent ?? '').endsWith('user:1')`, 'keyboard open');
  check(await evaluate(`!!document.querySelector('.redis-key-list[aria-activedescendant]')`), 'the key list is a keyboard listbox: the arrow key opens the key');

  // ── console ──
  await click('.redis-view-btn', 'Konsola');
  await until(`!!document.querySelector('.redis-console-line') && !document.querySelector('.redis-console-line').readOnly`, 'console', 30000);
  const run = async (line) => {
    await until(`!document.querySelector('.redis-console-line').readOnly`, 'console ready');
    await setValue('.redis-console-line', line);
    await evaluate(`document.querySelector('.redis-console-line').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true`);
  };
  await setValue('.redis-console-line', 'hge');
  await until(`[...document.querySelectorAll('.redis-suggest li')].map((e) => e.textContent).join() === 'HGET,HGETALL'`, 'completion');
  check(true, 'the console completes command names');
  await run('SET greeting hello');
  await until(`[...document.querySelectorAll('.rr.simple')].some((e) => e.textContent === 'OK')`, 'OK reply');
  await run('HGETALL user:1');
  await until(`!!document.querySelector('.rr.map')`, 'map reply').catch(async (e) => { console.log('console:', await textOf('.redis-console-log'), 'modal:', await textOf('.modal')); throw e; });
  await run('LRANGE queue 0 -1');
  await until(`!!document.querySelector('.rr.array')`, 'array reply');
  await run('LLEN queue');
  await until(`!!document.querySelector('.rr.integer')`, 'integer reply').catch(async (e) => { console.log('console:', await textOf('.redis-console-log'), 'input:', await evaluate("document.querySelector('.redis-console-line').value")); throw e; });
  await run('GET nothing-here');
  await until(`!!document.querySelector('.rr.nil')`, 'nil reply');
  check(true, 'console replies render by type (simple, map, array, integer, nil)');
  await run('FLUSHDB');
  await until(`!!document.querySelector('.modal-foot') && (document.querySelector('.modal-body')?.textContent ?? '').includes('FLUSHDB')`, 'dangerous confirm');
  check(true, 'a dangerous command asks first and shows the command');
  await click('.modal-foot button', 'Anuluj');
  await until(`[...document.querySelectorAll('.redis-console-note.info')].some((e) => e.textContent.includes('Anulowano'))`, 'cancelled');
  check((await cmd('DBSIZE')).v !== '0', 'cancelling keeps the data');
  await run('SUBSCRIBE news');
  await until(`[...document.querySelectorAll('.redis-console-note.error')].some((e) => e.textContent.includes('Pub/Sub'))`, 'subscribe refusal');
  check(true, 'SUBSCRIBE is refused in the console with a hint to Pub/Sub');
  await evaluate(`document.querySelector('.redis-console-line').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })), true`);
  await until(`document.querySelector('.redis-console-line').value === 'SUBSCRIBE news'`, 'history');
  check(true, 'the up arrow brings back the last command');
  await run('AUTH secret-pw-xyz');
  await run('CONFIG SET requirepass hunter2-xyz');
  await until(`!!document.querySelector('.modal-foot')`, 'config set asks');
  check(await evaluate(`(document.querySelector('.modal-body')?.textContent ?? '').includes('local redis · DB 0')`), 'a dangerous command names the connection and DB');
  await click('.modal-foot button', 'Anuluj');
  await until(`[...document.querySelectorAll('.redis-console-cmd')].some((e) => e.textContent.includes('requirepass ***'))`, 'masked line');
  const stored = await evaluate(`Object.keys(localStorage).filter((k) => k.startsWith('mc-redis-history')).map((k) => localStorage.getItem(k)).join('\\n')`);
  check(!stored.includes('secret-pw-xyz') && !stored.includes('hunter2-xyz') && !stored.includes('AUTH') && stored.includes('requirepass ***'), 'the console history never stores passwords (AUTH left out, CONFIG SET requirepass masked)');
  await setValue('.redis-console-line', '');
  await shot('console');

  // ── Pub/Sub ──
  await click('.redis-view-btn', 'Pub/Sub');
  await until(`!!document.querySelector('.redis-sub-input')`, 'pubsub', 30000);
  await setValue('.redis-sub-input', 'news');
  await click('.redis-sub-channel');
  await until(`document.querySelectorAll('.redis-sub-chip').length === 1`, 'first chip');
  await setValue('.redis-sub-input', 'ev:*');
  await click('.redis-sub-pattern');
  await until(`document.querySelectorAll('.redis-sub-chip').length === 2`, 'chips').catch(async (e) => { console.log('pubsub:', await textOf('.redis-pubsub'), 'toast:', await textOf('.toast')); throw e; });
  check(true, 'subscriptions to a channel and a pattern show as chips');
  await setValue('.redis-pub-channel', 'news');
  await setValue('.redis-pub-message', '{"title":"hello","n":1}');
  await click('.redis-publish-btn');
  await setValue('.redis-pub-channel', 'ev:login');
  await setValue('.redis-pub-message', 'user 1');
  await click('.redis-publish-btn');
  await cmd('PUBLISH', 'news', 'from the probe');
  await until(`document.querySelectorAll('.redis-msg-row').length === 3`, 'messages', 15000);
  check(await evaluate(`[...document.querySelectorAll('.redis-msg-row')].some((r) => r.textContent.includes('ev:login') && r.textContent.includes('ev:*'))`), 'published messages arrive live, with the matching pattern');
  await evaluate(`[...document.querySelectorAll('.redis-msg-row')].find((r) => r.textContent.includes('title')).click(), true`);
  await until(`(document.querySelector('.redis-msg-body')?.textContent ?? '').includes('"title": "hello"')`, 'json pretty');
  check(true, 'a JSON payload shows pretty in the detail');
  await shot('pubsub');
  await click('.redis-pause');
  await cmd('PUBLISH', 'news', 'while paused');
  await until(`(document.querySelector('.redis-pause')?.textContent ?? '').includes('1')`, 'held while paused');
  check(await count('.redis-msg-row') === 3, 'pause holds new messages back and counts them');
  await click('.redis-pause');
  await until(`document.querySelectorAll('.redis-msg-row').length === 4`, 'resume');
  await setValue('.redis-msg-filter', 'paused');
  await until(`document.querySelectorAll('.redis-msg-row').length === 1`, 'filter');
  check(true, 'resume shows them and the filter narrows the list');

  // ── server info ──
  await click('.redis-view-btn', 'Serwer');
  await until(`[...document.querySelectorAll('.redis-stat')].some((e) => e.textContent.includes('7.2.4'))`, 'info', 30000);
  check(await evaluate(`[...document.querySelectorAll('.redis-info-card h3')].map((h) => h.textContent).includes('Pamięć')`), 'INFO shows the summary and readable groups');
  await shot('info');
  await click('.redis-server .redis-seg button', 'Wolne polecenia');
  await until(`[...document.querySelectorAll('.redis-table td')].some((e) => e.textContent === 'KEYS *')`, 'slowlog');
  await click('.redis-server .redis-seg button', 'Klienci');
  await until(`document.querySelectorAll('.redis-table tbody tr').length >= 2`, 'clients');
  check(true, 'SLOWLOG and CLIENT LIST tables');

  const sessionsOfA = await evaluate(`(async () => (await window.mc.db.sessions()).sessions.filter((s) => s.connectionId === ${j(a.connection.id)}).length)()`);
  check(sessionsOfA === 3, `keys, Pub/Sub and server views of one DB share one session (sessions of the connection: ${sessionsOfA}, expected 3 = shared + console + probe)`);

  // ── read-only connection through the SSH tunnel ──
  // Through the connections panel this time: a click on a Redis connection opens its key browser.
  await click('#db-view');
  const vpsRow = "[...document.querySelectorAll('.db-row')].find((r) => r.querySelector('.db-name')?.textContent === 'vps redis')";
  await until(`!!${vpsRow}`, 'Redis connection in the panel');
  await evaluate(`(() => { const r = ${vpsRow}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 20, clientY: b.top + 8 })); return true; })()`);
  await until(`[...document.querySelectorAll('[role=menuitem]')].some((b) => b.textContent.includes('Konsola'))`, 'Redis entries in the connection menu');
  check(true, 'the connections panel offers the Redis views in the connection menu');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await evaluate(`${vpsRow}.click(), true`);
  await until(`!!document.querySelector('.redis-card input[type=password]')`, 'SSH password prompt in the tab', 30000);
  await shot('login');
  await setValue('.redis-card input[type=password]', ssh.password);
  await submit('.redis-card form');
  await until(`!!document.querySelector('.redis-browser .redis-key-row')`, 'tunnel connected', 30000);
  check(await evaluate(`[...document.querySelectorAll('.redis-chip')].some((e) => e.textContent.includes('tylko do odczytu'))`), 'the tunnel connection shows read-only');
  check(await count('.redis-new-key') === 0 && await count('.redis-delete-selected') === 0 && await count('.redis-key-check') === 0, 'no "new key", selection or delete controls on a read-only connection');
  await openKey('user:1');
  await until(`[...document.querySelectorAll('.redis-item')].some((e) => e.textContent.includes('city'))`, 'ro hash fields');
  await evaluate(`[...document.querySelectorAll('.redis-item')].find((e) => e.textContent.includes('city')).click(), true`);
  await until(`!!document.querySelector('.redis-editor .redis-value-text')`, 'ro editor');
  check(await count('.redis-delete-key') === 0 && await count('.redis-rename') === 0 && await count('.redis-editor .redis-save') === 0 && await count('.redis-items .redis-add') === 0, 'the value panel has no edit controls on a read-only connection');
  await shot('readonly');
  await click('.redis-view-btn', 'Konsola');
  await until(`!!document.querySelector('.redis-console-line') && !document.querySelector('.redis-console-line').readOnly`, 'ro console', 30000);
  await run('SET x 1');
  await until(`[...document.querySelectorAll('.redis-console-note.error')].some((e) => e.textContent.includes('tylko do odczytu'))`, 'ro refusal');
  check((await cmd('EXISTS', 'x')).v === '0', 'a write in the console of a read-only connection is refused with a clear message');

  // ── fix round 1: a disconnect from the panel reads "Rozłączono" ──
  if (!(await evaluate(`!!document.querySelector('.db-panel')`))) await click('#db-view');
  await until(`!!${vpsRow}`, 'vps row');
  await evaluate(`(() => { const r = ${vpsRow}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 20, clientY: b.top + 8 })); return true; })()`);
  await until(`[...document.querySelectorAll('[role=menuitem]')].some((b) => b.textContent.trim() === 'Rozłącz')`, 'disconnect entry');
  await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.trim() === 'Rozłącz').click(), true`);
  await until(`(document.querySelector('.redis-card-title')?.textContent ?? '') === 'Rozłączono'`, 'disconnected card', 20000);
  check(true, 'after "Rozłącz" the Redis tab says "Rozłączono" (not a failure) and offers to connect again');

  // ── tabs close their sessions ──
  await evaluate(`(() => { for (const b of [...document.querySelectorAll('.workspace-tabs .redis-strip-tab .x')]) b.click(); return true; })()`);
  await until(`(async () => (await window.mc.db.sessions()).sessions.filter((s) => s.id !== ${j(probe)}).length === 0)()`, 'sessions closed with their tabs', 20000);
  check(true, 'closing the Redis tabs ends their sessions');
  await evaluate(`window.mc.db.disconnect(${j(probe)})`);
  console.log(`Redis UI real-app check passed (${passed} checks)`);
} finally {
  await app?.close();
  redis.stop();
  ssh.stop();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a locked file stays until the next run */ }
}
