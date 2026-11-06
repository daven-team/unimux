// The normalize part of the golden corpus (1.2.0, PLAN F8), used by scripts/dump-goldens.mjs:
//
//   test/golden/normalize-state.jsonl   {platform, now, input} -> normalizeState (src/shared/state.ts) as JSON text, or null
//   test/golden/state-after-edit.jsonl  {prev, next} -> normalizeEditedState (src/main/stateController.ts), or the error
//
// Inputs: the seed states the TS test suite itself hands to normalizeState (test/golden/normalize-seeds.jsonl, recorded by
// scripts/capture-normalize-seeds.mjs), a hand-made 1.1.4 state that uses every domain, older formats, hand-picked edge cases
// (names Object.prototype has, index keys, UTF-16 cuts, JS white space) and seeded random damage of all of them. A grid id
// used twice gets uid() = 00000000-0000-4000-8000-<n, 12 digits> (n from 1 per row); Date.now() is the row's `now`.
import { readFileSync } from 'node:fs';

// ── a small seeded PRNG (mulberry32), the same as dump-goldens.mjs ───────────
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = 1_762_430_400_000;
const DAY = 86_400_000;
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HOST = 'aaaaaaaa-1111-4111-8111-000000000001';
const HOST2 = 'aaaaaaaa-1111-4111-8111-000000000002';
const KEY = 'bbbbbbbb-2222-4222-8222-000000000001';
const IDENT = 'cccccccc-3333-4333-8333-000000000001';
const DB = (n) => `dddddddd-4444-4444-8444-00000000000${n}`;

const cell = (id, extra = {}) => ({ id, profileId: 'claude', ...extra });
const layout = (n) => {
  const steps = [[1, 1], [2, 2], [2, 4], [3, 6], [3, 9], [4, 12], [5, 20]];
  const [cols] = steps.find(([, cap]) => cap >= n);
  const areas = Array.from({ length: n }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1 }));
  areas[n - 1].colSpan = cols - areas[n - 1].col;
  return { cols, rows: Math.ceil(n / cols), areas };
};

/** A 1.1.4 state that uses every domain the normalizer touches. */
export function richState() {
  return {
    version: 1,
    automation: {
      paused: false,
      tasks: [
        { id: 't1', projectId: 'p1', cellId: 'c1', title: 'Open', prompt: 'x', status: 'in_progress', dependsOn: ['t2'], delivery: 'native', createdAt: NOW - 9 * DAY, updatedAt: NOW - 9 * DAY },
        { id: 't2', projectId: 'p1', cellId: 'c2', title: 'Old but needed', prompt: 'x', status: 'completed', delivery: 'native', createdAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY },
        { id: 't3', projectId: 'p1', cellId: 'c2', title: 'Old', prompt: 'x', status: 'cancelled', delivery: 'pasted', createdAt: NOW - 20 * DAY, updatedAt: NOW - 8 * DAY },
        { id: 't4', projectId: 'p1', cellId: 'c2', title: 'Fresh', prompt: 'x', status: 'completed', delivery: 'pasted', createdAt: NOW - DAY, updatedAt: NOW - DAY },
        { id: 't5', projectId: 'gone', cellId: 'c9', title: 'Removed project', prompt: 'x', status: 'queued', delivery: 'pending', createdAt: NOW, updatedAt: NOW },
      ],
      messages: [
        { id: 'm1', projectId: 'p1', toCellId: 'c1', text: 'read long ago', readAt: NOW - 30 * DAY, delivery: 'native', createdAt: NOW - 31 * DAY },
        { id: 'm2', projectId: 'p1', toCellId: 'c1', text: 'unread', delivery: 'pending', createdAt: NOW - 40 * DAY },
        { id: 'm3', projectId: 'p2', toCellId: 'c5', text: 'read now', readAt: NOW - 1000, delivery: 'pasted', createdAt: NOW - 2000 },
      ],
      events: [
        { id: 'e1', projectId: 'p1', action: 'create_task', detail: 'x', createdAt: NOW - 5000 },
        { id: 'e2', projectId: 'gone', action: 'send_message', detail: 'y', createdAt: NOW - 4000 },
      ],
    },
    projects: [
      {
        id: 'p1', name: 'Projekt ąę', path: 'C:\\work\\one', color: '#3b82f6', activeTabId: 'g2',
        tabs: [
          { id: 'g1', name: 'Grid 1', layout: layout(3), cells: [
            cell('c1', { role: 'coordinator', color: '#60a5fa', session: { id: 's1', cli: 'claude' }, worktree: { path: 'C:\\work\\one-wt', branch: 'x' }, promptQueue: { items: [{ id: 'q1', text: 'next' }, { id: 'q2', text: 'auto notice', auto: true }] }, pathMode: 'codex', shell: 'pwsh' }),
            cell('c2', { profileId: 'claude-opus', name: 'Opus', model: 'opus', dir: 'C:\\work\\one\\sub\\\\', muted: true }),
            cell('c3', { profileId: 'shell', ssh: { hostId: HOST, cwd: '/srv/app', resume: true }, pathMode: 'weird' }),
          ] },
          { id: 'g2', name: 'Grid 2', layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }], rowColSizes: [[2, 1]], mode: 'cols', colRowSizes: [null] }, cells: [cell('c4', { profileId: 'codex-high' }), cell('c5', { profileId: 'codex' })] },
        ],
        archive: [{ id: 'g3', name: 'Closed', closedAt: NOW - DAY, layout: layout(1), cells: [cell('c6')] }],
      },
      {
        id: 'p2', name: 'Two', path: '/Users/me/two', activeTabId: 'g4',
        tabs: [{ id: 'g4', name: 'Mac', layout: layout(2), cells: [cell('c7'), cell('c8', { dir: 'relative/x' })] }],
        archive: [],
      },
    ],
    activeProjectId: 'p1',
    profiles: [
      { id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' },
      { id: 'claude-opus', name: 'Opus', cli: 'claude', args: '--model opus', color: '#d97757' },
      { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' },
      { id: 'shell', name: 'PowerShell', cli: 'shell', args: '', color: '#7a7a7a' },
      { id: 'mine', name: 'Mine', cli: 'claude', args: '--verbose', color: '#123456' },
    ],
    presets: [
      { id: 'tp1', name: '  Team  ', layout: layout(2), cells: [{ profileId: 'claude-opus', worktree: true, role: 'coordinator', name: ' Lead ', prompt: 'go', dir: './a/../b' }, { profileId: 'codex', sshHostId: HOST, dir: 'C:\\abs\\', muted: true, extra: 1 }], projectId: 'p1', junk: true },
      { id: 'tp2', name: 'No cells', cells: [] },
      { id: 'tp1', name: 'Duplicate', cells: [{ profileId: 'claude' }] },
    ],
    snippets: [{ id: 'sn1', name: 'Build', text: 'npm run build', autoSend: true }],
    notes: [
      { id: 'n1', name: 'Note', text: 'Hello', projectId: 'p1', color: '#AABBCC', language: 'typescript', pinned: true, updatedAt: NOW - 1.4 },
      { id: 'n1', name: 'dup', text: 'x' },
      { id: 'n2', text: 'only text', color: 'red', language: 'klingon', updatedAt: -5 },
    ],
    notesOpen: true,
    sshHosts: [
      { id: HOST, label: ' Prod ', address: ' [FE80::1%eth0] ', port: 2222, username: ' root ', group: ' Servers ', tags: [' Web  App ', 'web-app', 'DB', 7], keyId: KEY, identityId: IDENT, startupCommand: 'cd /srv\n', color: '#00ff00', reconnectOnStart: true, sftpSudo: true, sftpCommand: ' sudo /usr/lib/sftp-server ', theme: 'unimux-fjord', createdAt: NOW - DAY, updatedAt: NOW, agent: 'reserved' },
      { id: HOST2, label: '', address: 'example.com', port: 70000, username: 'me', createdAt: -1, updatedAt: 'x', theme: 'nope' },
      { id: 'not-a-uuid', label: 'x', address: 'a.b', username: 'u' },
    ],
    sshIdentities: [{ id: IDENT, label: '', username: ' deploy ', keyId: KEY, createdAt: NOW, updatedAt: NOW }],
    sftp: { localPath: 'C:\\Users\\me', remotePaths: JSON.parse(`{"${HOST}": "/srv/./app/../www/", "123": "/x", "__proto__": "/p", "bad key": "/y", "${HOST2}": "relative"}`) },
    dbConnections: [
      { id: DB(1), kind: 'postgres', name: ' PG ', host: 'db.local', port: 5433, user: 'postgres', database: 'app', tls: 'verify-full', caPath: 'C:\\ca.pem', ssh: { hostId: HOST, dbHost: '127.0.0.1', dbPort: 5432 }, readOnly: true, statementTimeoutMs: 30000, color: '#ff0000', group: 'Prod', createdAt: NOW, updatedAt: NOW },
      { id: DB(2), kind: 'mysql', name: '', host: 'my.local', user: 'root', flavor: 'mariadb', tls: 'require', group: 'Prod', color: '#00ff00', createdAt: NOW, updatedAt: NOW },
      { id: DB(3), kind: 'redis', host: 'cache', user: '', dbIndex: 3, group: 'Cache', createdAt: NOW, updatedAt: NOW },
      { id: DB(4), kind: 'sqlite', path: 'C:\\data\\app.db', readOnly: true, group: 'Local', createdAt: NOW, updatedAt: NOW },
      { id: DB(5), kind: 'postgres', host: 'x', user: 'u', tls: 'verify-full' },
    ],
    dbGroupColors: { Prod: '#123456', Gone: '#654321', Cache: 'blue' },
    settings: {
      language: 'pl', fontSize: 14, shell: 'cmd', lastProfileId: 'codex-high', updateMode: 'auto', showAiUsage: false, usageIntervalMinutes: 15,
      usageCollapsed: true, confirmCloseWorking: false, backgroundLoad: 'all', scrollbackLines: 10000, sshTheme: 'unimux-lagoon',
      sshStatusBarItems: { cpu: false, mem: true, junk: false }, stripScope: 'project', sidePanels: { monitor: true, waiting: false },
      shortcuts: { 'palette.open': 'ctrl+shift+k', 'agent.add': 'Ctrl+Shift+K', 'tab.right': null, 'terminal.copy': 'Ctrl+Q', 'tree.rename': 'F3', 'sidebar.toggle': 'Ctrl+E', 'nope': 'Ctrl+J' },
      alerts: { enabled: true, volume: 0.333, quietHours: { enabled: true, start: '23:00', end: '25:00' }, events: { done: { notify: false, sound: { kind: 'file', path: 'C:\\s.wav' } }, error: { sound: { kind: 'preset', id: 'nope' } } }, limits: { fiveHour: { enabled: false, percent: 50.5 } } },
      accountSwitch: { enabled: true, codex: true, fiveHour: { percent: 90 }, mode: 'switch', cooldownMinutes: 30, target: { claude: 'ME@X.COM', codex: '' }, primary: { claude: 'a'.repeat(161) } },
      delegation: { mode: 'ask', maxAgents: '7' },
      sshRestoreSessions: false, unknownSetting: { kept: true },
    },
    sidebarCollapsed: false, snippetsOpen: false, sidebarWidth: 1000, snippetsWidth: 250.6,
    workspaceOrder: ['settings', 'grid:g1', 'grid:g1', 'grid:gone', 'file:doc1', 'file:', 'ssh', 7, 'grid:g4'],
    detachedWindows: [
      { id: 'w1', target: { kind: 'grid', projectId: 'p2', tabId: 'g1' }, bounds: { x: 10.4, y: -20.6, width: 800, height: 600 }, displayId: 3, maximized: true },
      { id: 'w2', target: { kind: 'grid', projectId: 'p1', tabId: 'g1' } },
      { id: 'w3', target: { kind: 'file', fileId: 'f1', projectId: '', name: 'a.ts', reopen: { kind: 'local', path: 'C:\\a.ts' } }, bounds: { x: 0, y: 0, width: 0, height: 10 } },
      { id: 'w4', target: { kind: 'file', fileId: 'f2', projectId: 'p1', name: 'diff', reopen: { kind: 'diff', projectId: 'p1', diff: { source: 'staged', path: 'x.ts', hash: '', oldPath: 'y.ts' } } } },
      { id: 'w5', target: { kind: 'file', fileId: 'f3', projectId: 'p1', name: 'db', reopen: { kind: 'db', ref: { kind: 'table', connectionId: DB(1), database: 'app', schema: 'public', table: 't', objectKind: 'view' }, path: 'app.public.t' } } },
      { id: 'w6', target: { kind: 'file', fileId: 'f4', projectId: 'p1', name: 'redis', reopen: { kind: 'redis', ref: { kind: 'redis', view: 'keys', connectionId: DB(3), db: 3, uid: u(99) }, path: 'cache' } } },
      { id: 'w7', target: { kind: 'file', fileId: 'f5', projectId: 'p1', name: 'remote', reopen: { kind: 'remote', hostId: HOST, path: '/etc/hosts' } } },
      { id: 'w8', target: { kind: 'grid', projectId: 'p1', tabId: 'g9' } },
    ],
  };
}

/** Older formats: 0.9.x settings (legacy alert keys, autoInstallUpdates), no lists of later versions, retired profiles. */
function olderStates() {
  return [
    { version: 1, projects: [{ id: 'p', name: 'P', path: 'C:\\p', tabs: [{ id: 't', name: 'T', layout: layout(1), cells: [{ id: 'c', profileId: 'claude-opus' }] }], activeTabId: 't' }], activeProjectId: 'p', profiles: [{ id: 'claude-opus', name: 'Opus', cli: 'claude', args: '', color: '#000000' }], settings: { fontSize: 12, shell: 'pwsh', notifications: false, waitingSound: 'custom', waitingSoundFile: 'C:\\x.wav', waitingSoundVolume: 35, autoInstallUpdates: true, lastProfileId: 'claude-opus' } },
    { version: 1, projects: [], settings: { waitingSound: 'custom', waitingSoundFile: '\\\\unc\\x.wav', notifyWhenFocused: true } },
    { version: 1, projects: [], settings: { waitingSound: 'system', waitingSoundVolume: 'loud', autoInstallUpdates: false } },
    { version: 1, projects: [], settings: { updateMode: 'ask', notifications: true } },
    { version: 1, projects: [], settings: null },
    { version: 1, projects: [], settings: [] },
    { version: 1, projects: [], settings: ['a', 'b'] },
    { version: 1, projects: [], settings: 'pl' },
    { version: 1, projects: [], settings: 5 },
    { version: 1, projects: [], settings: true },
    { version: 1, projects: [] },
    { version: 2, projects: [] },
    { version: '1', projects: [] },
    { version: 1, projects: {} },
    { version: 1 },
    [],
    null,
    'state',
    { version: 1, projects: [null, 5, 'x', { id: 'p' }, { id: 1, path: 'x' }, { id: 'ok', path: '/ok', tabs: 'no', archive: null }] },
  ];
}

const UNICODE = ['ąęśćżźół', '\u{1F600}', 'K'.replace('K', '\u212A'), '\u{FEFF}', '\u0085', '\u3000', '\u2028', 'İ', 'ß', 'Σ'];

/** Hand-picked cases: JavaScript corners the port must reproduce. */
function edgeStates() {
  const base = () => ({ version: 1, projects: [] });
  const proj = (tabs, extra = {}) => ({ id: 'p', name: 'P', path: '/p', tabs, archive: [], ...extra });
  const tab = (id, cells, extra = {}) => ({ id, name: id, layout: layout(Math.max(1, Math.min(20, cells.length))), cells, ...extra });
  const out = [];
  // Prototype names as profile ids, cell profiles, the last profile and group / host keys.
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
    out.push({ ...base(), profiles: [{ id: name, name, cli: 'claude', args: '' }, { id: 'keep', name: 'k', cli: 'shell', args: '' }], settings: { lastProfileId: name }, projects: [proj([tab('g', [cell('c', { profileId: name })])])], presets: [{ id: 'x', name: 'x', cells: [{ profileId: name }] }] });
    out.push({ ...base(), dbConnections: [{ id: DB(1), kind: 'redis', host: 'h', group: name, color: '#111111' }], ...(name === '__proto__' ? {} : { dbGroupColors: JSON.parse(`{"${name}": "#222222"}`) }) });
    out.push({ ...base(), automation: { tasks: Array.from({ length: name === 'constructor' || name === '__proto__' ? 502 : 3 }, (_, i) => ({ id: `t${i}`, projectId: name, status: 'completed', updatedAt: NOW - i })), messages: [], events: [] }, projects: [proj([], { id: name })] });
  }
  out.push({ ...base(), dbConnections: [{ id: DB(1), kind: 'redis', host: 'h', group: '__proto__', color: '#111111' }], dbGroupColors: JSON.parse('{"__proto__": "#222222", "1": "#333333"}') });
  out.push({ ...base(), profiles: [{ id: ['claude-opus'] }, { id: 7 }, { id: null }, 'str', 9, { name: 'no id' }] });
  out.push({ ...base(), profiles: [null] });
  out.push({ ...base(), profiles: [{ id: 'claude-opus' }, { id: 'codex-high' }] });
  out.push({ ...base(), settings: { lastProfileId: ['codex-high'] } });
  out.push({ ...base(), settings: { lastProfileId: null, language: 'xx', shell: 'zsh' } });
  // Index-like keys come first in a JS object.
  out.push({ ...base(), settings: JSON.parse('{"9": 1, "language": "en", "10": 2, "01": 3}'), extra: JSON.parse('{"b": 1, "3": 2}') });
  out.push(JSON.parse('{"version": 1, "projects": [], "5": "five", "sftp": {"remotePaths": {"z9": "/a", "12": "/b", "3": "/c"}}}'));
  out.push({ ...base(), dbConnections: [{ id: DB(1), kind: 'redis', host: 'h', group: '20', color: '#111111' }, { id: DB(2), kind: 'redis', host: 'h', group: '3', color: '#222222' }, { id: DB(3), kind: 'redis', host: 'h', group: 'b', color: '#333333' }] });
  // UTF-16 cuts and JS white space.
  const emojiAt = (n) => `${'a'.repeat(n - 1)}\u{1F600}tail`;
  out.push({ ...base(), sshHosts: [{ id: HOST, label: emojiAt(80), address: '\u212A.com', username: '\uFEFFroot\uFEFF', group: emojiAt(60), createdAt: 1, updatedAt: 2 }], sshIdentities: [{ id: IDENT, label: emojiAt(80), username: 'u\u0085' }] });
  out.push({ ...base(), notes: [{ id: 'n', name: emojiAt(120), text: 'x' }], projects: [proj([tab('g', [cell('c', { promptQueue: { items: [{ id: 'q', text: emojiAt(20000) }], paused: 'user' } })])])] });
  out.push({ ...base(), notes: [{ id: 'n', name: 'big', text: `${'x'.repeat(200_005)}` }] });
  for (const s of UNICODE) {
    out.push({ ...base(), sshHosts: [{ id: HOST, label: ` ${s} `, address: `${s}host`, username: `${s}`, tags: [`${s} tag`] }], dbConnections: [{ id: DB(1), kind: 'mysql', host: s, user: ` ${s}` }], settings: { accountSwitch: { target: { claude: s.toUpperCase() } }, delegation: { maxAgents: ` ${s}3${s} ` } } });
  }
  for (const v of ['0x10', '1e1', ' 12 ', '', '   ', 'Infinity', '-Infinity', '3.5', '2.5', '-1', '0b11', '+5', 'abc', 0, 21, 2.5, -0.5, null, true, [3], {}]) {
    out.push({ ...base(), settings: { delegation: { maxAgents: v, mode: 'auto' } } });
  }
  // Layouts on the edge of usable, repeated grid ids, damaged tabs.
  out.push({ ...base(), activeProjectId: 'none', projects: [
    proj([tab('dup', [cell('a')]), tab('dup', [cell('b')]), { id: 'bad' }, { id: 'nocells', cells: [{ id: 1, profileId: 'x' }] }], { activeTabId: 'dup' }),
    { ...proj([tab('dup', [cell('c')])], { id: 'p2', activeTabId: 'dup' }), archive: [tab('dup', [cell('d')]), tab('g', [cell('e')])] },
    proj([tab('x', Array.from({ length: 25 }, (_, i) => cell(`m${i}`)))], { id: 'p3', activeTabId: 'missing' }),
  ] });
  out.push({ ...base(), activeProjectId: '', projects: [proj([tab('t1', [cell('a')], { layout: { cols: 61, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] } }), tab('t2', [cell('b')], { layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }], mode: null } }), tab('t3', [cell('c')], { layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1.5, rowSpan: 1 }], rowSizes: [1, 'x'] } }), tab('t4', [cell('d'), cell('e')], { layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }], rowColSizes: [null, [1, 2]], rowCounts: [2], extra: 'kept' }, name: 5 })], { activeTabId: 0 })] });
  // Prompt queues, SSH refs, path modes, folders.
  out.push({ ...base(), projects: [proj([tab('g', [
    cell('a', { promptQueue: { items: [{ id: 'q', text: '  ' }, { id: '', text: 'x' }, { id: 'q2', text: 'y', auto: true }] } }),
    cell('b', { promptQueue: { items: Array.from({ length: 60 }, (_, i) => ({ id: `q${i % 55}`, text: `t${i}` })), paused: 'bogus' } }),
    cell('c', { ssh: ['x'], dir: 'C:', pathMode: 'shell' }),
    cell('d', { ssh: { hostId: 5 }, dir: '\\\\server\\share\\\\' }),
    cell('e', { ssh: { hostId: 'h', cwd: '/a\\b', resume: 'yes' }, dir: '/a\u2028//' }),
    cell('f', { ssh: { hostId: 'h', cwd: `/${'x'.repeat(1024)}` }, dir: 'C:\\' }),
  ])])] });
  // Automation corners: retention boundary, NaN-ish timestamps, dependsOn as a string, a null item, non-arrays.
  out.push({ ...base(), projects: [proj([])], automation: { paused: 'yes', tasks: [
    { id: 'a', projectId: 'p', status: 'completed', updatedAt: NOW - 7 * DAY }, { id: 'b', projectId: 'p', status: 'completed', updatedAt: NOW - 7 * DAY - 1 },
    { id: 'c', projectId: 'p', status: 'completed', updatedAt: '5' }, { id: 'd', projectId: 'p', status: 'completed', updatedAt: null },
    { id: 'e', projectId: 'p', status: 'queued', dependsOn: 'bd' }, 7, 'str', { projectId: 'p' },
  ], messages: [{ id: 'm', projectId: 'p', readAt: null, createdAt: 0 }, { id: 'n', projectId: 'p', readAt: [NOW] }], events: Array.from({ length: 205 }, (_, i) => ({ id: `e${i}`, projectId: i % 3 ? 'p' : 'x' })) } });
  out.push({ ...base(), automation: { tasks: [null] } });
  out.push({ ...base(), automation: { tasks: [{ status: 'queued', dependsOn: 5 }] } });
  out.push({ ...base(), automation: { tasks: [{ status: 'completed', dependsOn: 5 }] } });
  out.push({ ...base(), automation: { messages: [null] } });
  out.push({ ...base(), automation: { events: [null, ...Array.from({ length: 200 }, (_, i) => ({ id: `e${i}` }))] } });
  out.push({ ...base(), automation: { events: [{ projectId: 'x' }, null] } });
  out.push({ ...base(), automation: 'x' });
  out.push({ ...base(), automation: [] });
  // Big inbox over the per-project limit.
  out.push({ ...base(), projects: [proj([]), proj([], { id: 'q' })], automation: { tasks: [
    ...Array.from({ length: 300 }, (_, i) => ({ id: `q${i}`, projectId: 'q', status: i % 2 ? 'completed' : 'queued', updatedAt: NOW - i * 1000 })),
    ...Array.from({ length: 520 }, (_, i) => ({ id: `p${i}`, projectId: 'p', status: i % 4 ? 'completed' : 'in_progress', updatedAt: NOW - (i % 37) * 1000 })),
  ], messages: Array.from({ length: 510 }, (_, i) => ({ id: `m${i}`, projectId: 'p', readAt: i % 2 ? NOW - i : undefined, createdAt: NOW - 2 * i })), events: [] } });
  // Shortcut corners.
  const keys = { 'palette.open': 'Meta+K', 'agent.add': 'Alt+Shift+F4', 'tab.right': 'Ctrl+Alt+K', 'tab.left': 'Alt+Tab', 'grid.new': 'F5', 'history.open': 'Shift+F5', 'tree.rename': 'Insert', 'tree.delete': 'Shift+Delete', 'tree.copy': 'Ctrl+Shift+C', 'tree.cut': 'Left', 'editor.save': 'Ctrl+D', 'modal.save': 'Ctrl+Shift+Z', 'git.commit': 'Meta+Enter', 'cell.queue': 'Ctrl+2', 'cell.maximize': 'Ctrl+9', 'notes.toggle': 'constructor+Ctrl+Shift+Q', 'notes.capture': '__proto__+ctrl+alt+shift+Q', 'snippets.toggle': 'Ctrl+Shift+bac\u212Aspace', 'sidebar.toggle': 'Ctrl+Shift+ESC', 'waiting.next': 'Meta+Q', 'waiting.prev': 'Meta+Alt+H', 'terminal.find': 'Ctrl+Shift+Space', 'terminal.new': 5, 'conversations.search': '', 'tab.close': 'Ctrl+Shift+W', 'tab.next': 'Ctrl+Shift+N' };
  out.push({ ...base(), settings: { shortcuts: keys } });
  out.push({ ...base(), settings: { shortcuts: ['Ctrl+K'] } });
  // SSH / DB / SFTP / detached corners.
  out.push({ ...base(), sshHosts: [{ id: HOST.toUpperCase(), address: 'host:22', username: 'u' }, { id: HOST, address: '-x', username: 'u' }, { id: HOST2, address: '1::2', username: 'u', port: 22.5 }, { id: u(3), address: 'a:b:c', username: 'u' }, { id: u(4), address: '[x]', username: 'a b' }, { id: u(5), address: 'ok', username: 'u', startupCommand: 'a\u001bb', sftpCommand: 'x'.repeat(513) }], sftp: { localPath: '\\\\srv\\share', remotePaths: [] } });
  out.push({ ...base(), dbConnections: [{ id: DB(1), kind: 'sqlite', path: 'C:\\a\\', name: '' }, { id: DB(2), kind: 'sqlite', path: '\\\\srv\\db.sqlite', name: '  ' }, { id: DB(3), kind: 'sqlite', path: '/x/y.db' }, { id: DB(4), kind: 'postgres', host: 'h', user: ' u ', ssh: [] }, { id: DB(5), kind: 'mysql', host: 'h', user: 'u', ssh: { hostId: HOST, dbHost: 'H', dbPort: 1 }, statementTimeoutMs: 86_400_001, database: '' }, { id: DB(6), kind: 'redis', host: 'h', dbIndex: 10_001, tls: 'verify-full', caPath: '/ca' }] });
  out.push({ ...base(), sftp: { localPath: 'C:/forward', remotePaths: Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`h${i}`, `/p/${i}/..`])) } });
  out.push({ ...base(), projects: [proj([tab('g', [cell('a')])])], detachedWindows: [{ id: 'w', target: { kind: 'grid', projectId: 'p', tabId: 'g' } }, { id: 'w', target: { kind: 'grid', projectId: 'p', tabId: 'g' } }, { id: 'v', target: { kind: 'grid', projectId: 'p', tabId: 'g' } }, ...Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, target: { kind: 'file', fileId: `f${i}`, projectId: 'p', name: 'n', reopen: { kind: 'project', projectId: 'p', relativePath: 'a' } } })), { id: 'z', target: { kind: 'file', fileId: 'x', projectId: 'p', name: 'n', reopen: { kind: 'db', ref: { kind: 'ddl', connectionId: DB(1), database: '', schema: 's', name: 'n', objectKind: 'index', args: null }, path: 'p' } } }] });
  out.push({ ...base(), workspaceOrder: null, detachedWindows: {} });
  out.push({ ...base(), workspaceOrder: 'grid:x' });
  return out;
}

// ── random damage ────────────────────────────────────────────────────────────

const GARBAGE = () => [
  null, true, false, 0, -1, 1, 1.5, 22, 5000, 13, 1e21, -0.5, 65536, 200, 480, 0.25, 'x', '', ' pl ', 'en', 'pl', 'claude-opus',
  'constructor', '__proto__', 'toString', 'cols', 'auto', 'ask', 'manual', 'C:\\x', 'C:', '/srv/x', '\\\\srv\\share', '#abcdef', '#ABCDEF',
  HOST, KEY, IDENT, DB(1), 'grid:g1', 'file:x', 'settings', 'completed', 'queued', 'a'.repeat(130), ' \u{1F600} ', '\u212A', '\uFEFF',
  [], {}, [null], [1, 2], ['x'], { id: 'x' }, { id: HOST, address: 'a', username: 'u' }, { kind: 'off' }, { enabled: 'yes' },
];
const KEYS = [
  'id', 'name', 'path', 'tabs', 'archive', 'cells', 'layout', 'profileId', 'activeTabId', 'activeProjectId', 'settings', 'alerts', 'events',
  'sound', 'kind', 'language', 'shell', 'shortcuts', 'dir', 'ssh', 'promptQueue', 'items', 'paused', 'workspaceOrder', 'detachedWindows',
  'dbGroupColors', 'group', 'color', 'mode', 'rowSizes', 'areas', 'cols', 'rows', 'version', 'projects', 'profiles', 'automation', 'tasks',
  'messages', 'dependsOn', 'status', 'updatedAt', 'readAt', 'target', 'bounds', 'remotePaths', 'localPath', 'sshStatusBarItems', 'sidePanels',
  'delegation', 'maxAgents', 'notifications', 'waitingSound', 'autoInstallUpdates', 'constructor', '__proto__', '0', '7', '10',
];

function paths(value, prefix = [], out = []) {
  out.push(prefix);
  if (Array.isArray(value)) value.forEach((v, i) => paths(v, [...prefix, i], out));
  else if (value && typeof value === 'object') for (const k of Object.keys(value)) paths(value[k], [...prefix, k], out);
  return out;
}

const at = (root, path) => path.reduce((v, k) => v?.[k], root);

/** A deep copy through JSON (own "__proto__" keys stay own keys). */
const jclone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Sets an own property (also "__proto__", which a plain assignment would treat as the prototype). */
const define = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });

export function damage(state, r, count) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const root = { v: jclone(state) };
  for (let n = 0; n < count; n++) {
    const all = paths(root.v).filter((p) => p.length > 0);
    if (!all.length) break;
    const path = pick(all);
    const parent = path.length === 1 ? root.v : at(root.v, path.slice(0, -1));
    const key = path[path.length - 1];
    if (!parent || typeof parent !== 'object') continue;
    const current = parent[key];
    const roll = r();
    if (roll < 0.35) define(parent, key, jclone(pick(GARBAGE())));
    else if (roll < 0.5) {
      if (Array.isArray(parent)) parent.splice(key, 1);
      else delete parent[key];
    } else if (roll < 0.65 && current && typeof current === 'object' && !Array.isArray(current)) {
      define(current, pick(KEYS), jclone(pick(GARBAGE())));
    } else if (roll < 0.75 && Array.isArray(current) && current.length) {
      current.splice(Math.floor(r() * (current.length + 1)), 0, jclone(pick(r() < 0.6 ? current : GARBAGE())));
    } else if (roll < 0.9 && typeof current === 'string') {
      const variants = [` ${current} `, current.toUpperCase(), current.slice(1), `${current}${current}`, `${current}\u{1F600}`, `${'z'.repeat(60)}${current}`, `${current}/`, `${current}\\..`];
      define(parent, key, pick(variants));
    } else if (typeof current === 'number') {
      define(parent, key, pick([current + 0.5, -current, current * 1000, 0, current + 1, Math.round(current / 3)]));
    } else define(parent, key, jclone(pick(GARBAGE())));
  }
  return JSON.parse(JSON.stringify(root.v));
}

// ── rows ─────────────────────────────────────────────────────────────────────

/** Runs `fn` with Date.now() = now and crypto.randomUUID() counting from 1. */
function withWorld(now, fn) {
  const realNow = Date.now;
  const crypto = globalThis.crypto;
  const realUuid = crypto.randomUUID;
  let n = 0;
  Date.now = () => now;
  Object.defineProperty(crypto, 'randomUUID', { value: () => u(++n), configurable: true, writable: true });
  try { return fn(); } finally {
    Date.now = realNow;
    Object.defineProperty(crypto, 'randomUUID', { value: realUuid, configurable: true, writable: true });
  }
}

/** JSON.stringify as it reaches the disk and is read back by 1.2.0 (a lone surrogate becomes U+FFFD). */
function diskText(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  const wellFormed = (v) => {
    if (typeof v === 'string') return v.toWellFormed();
    if (Array.isArray(v)) return v.map(wellFormed);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) define(o, k.toWellFormed(), wellFormed(x));
      return o;
    }
    return v;
  };
  return JSON.stringify(wellFormed(JSON.parse(text)));
}

/** States with more than PROJECT_ITEM_LIMIT finished items in one project, some with a readAt / updatedAt that is missing,
 * a string or an object (NaN in the retention sort). */
function retentionStates() {
  const r = rng(1210);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const damaged = () => pick([undefined, '2026-11-05T10:00:00Z', { at: 1 }, 'x', [1, 2], null, '17']);
  const states = [];
  for (let i = 0; i < 24; i++) {
    const unread = 400 + Math.floor(r() * 100);
    const read = 30 + Math.floor(r() * 120);
    const nanShare = [0.05, 0.33, 0.6, 0.95][i % 4];
    const messages = [];
    for (let k = 0; k < unread + read; k++) {
      const m = { id: `m${k}`, projectId: k % 7 === 6 && i % 3 === 0 ? 'q' : 'p', from: 'a', to: 'b', text: `t${k}`, createdAt: NOW - Math.floor(r() * 5_000_000) };
      if (k >= unread || r() < 0.1) m.readAt = r() < nanShare ? damaged() : NOW - Math.floor(r() * 1000);
      messages.push(m);
    }
    // Interleave read and unread so the runs TimSort finds are short and the merges gallop.
    if (i % 2) messages.reverse();
    for (let k = messages.length - 1; k > 0 && i % 4 >= 2; k--) { const j = Math.floor(r() * (k + 1)); [messages[k], messages[j]] = [messages[j], messages[k]]; }
    const tasks = [];
    if (i % 3 === 1) {
      for (let k = 0; k < 520 + Math.floor(r() * 60); k++) {
        const done = r() < 0.7;
        const t = { id: `t${k}`, projectId: 'p', title: `t${k}`, prompt: 'x', status: done ? pick(['completed', 'failed', 'cancelled']) : 'pending', createdAt: NOW - 10_000, updatedAt: r() < nanShare ? damaged() : NOW - Math.floor(r() * 100_000) };
        if (k % 50 === 7) t.dependsOn = [`t${k - 3}`];
        tasks.push(t);
      }
    }
    states.push({ version: 1, projects: [{ id: 'p', name: 'p', path: '/p', tabs: [] }, { id: 'q', name: 'q', path: '/q', tabs: [] }], automation: { paused: false, tasks, messages, events: [] } });
  }
  return states;
}

export function normalizeRows({ normalizeState, root }) {
  const seeds = readFileSync(`${root}/test/golden/normalize-seeds.jsonl`, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const inputs = [];
  for (const s of seeds) for (const platform of ['win32', 'darwin']) inputs.push({ platform, input: s.input });
  for (const platform of ['win32', 'darwin']) {
    inputs.push({ platform, input: richState() });
    for (const s of olderStates()) inputs.push({ platform, input: s });
  }
  edgeStates().forEach((input, i) => inputs.push({ platform: i % 2 ? 'darwin' : 'win32', input }));
  const r = rng(1208);
  const bases = [richState(), ...edgeStates(), ...seeds.map((s) => s.input)].filter((s) => JSON.stringify(s).length < 20_000);
  for (let i = 0; i < 900; i++) {
    const base = i % 6 === 0 ? richState() : bases[Math.floor(r() * bases.length)];
    inputs.push({ platform: r() < 0.5 ? 'win32' : 'darwin', input: damage(base, r, 1 + Math.floor(r() * 5)) });
  }
  // Appended last so the rows above keep their `now`: projects over the 500-item cap with damaged timestamps, where the
  // retention comparator answers NaN and only V8's TimSort order gives the 1.1.4 result.
  retentionStates().forEach((input, i) => inputs.push({ platform: i % 2 ? 'darwin' : 'win32', input }));
  return inputs.map(({ platform, input }, i) => {
    const now = NOW + i * 1000;
    const text = JSON.stringify(input);
    let out = null;
    let threw = false;
    // `stable`: the next start of 1.1.4 reads the written state back unchanged (normalizeState of `out` is `out` again).
    let stable = false;
    withWorld(now, () => {
      try { const state = normalizeState(JSON.parse(text), platform); out = state === null ? null : diskText(state); } catch { threw = true; out = null; }
    });
    if (out !== null) withWorld(now, () => { try { stable = diskText(normalizeState(JSON.parse(out), platform)) === out; } catch { stable = false; } });
    return { platform, now, input: JSON.parse(text), out, ...(threw ? { threw } : {}), ...(out !== null ? { stable } : {}) };
  });
}

export function afterEditRows({ normalizeState, normalizeEditedState }) {
  const r = rng(1209);
  const rows = [];
  const bases = [richState(), ...edgeStates()].filter((s) => JSON.stringify(s).length < 20_000);
  for (let i = 0; i < 260; i++) {
    const raw = i % 2 === 0 ? richState() : damage(bases[Math.floor(r() * bases.length)], r, Math.floor(r() * 3));
    const prev = withWorld(NOW, () => { try { return normalizeState(JSON.parse(JSON.stringify(raw)), 'win32'); } catch { return null; } });
    if (!prev) continue;
    const prevJson = JSON.parse(JSON.stringify(prev));
    let next = damage(prevJson, r, 1 + Math.floor(r() * 4));
    const roll = r();
    // Targeted edits a renderer makes: a grid with too many / no cells, a layout that does not fit, a closed grid.
    if (roll < 0.15 && next.projects?.[0]?.tabs?.[0]?.cells) next.projects[0].tabs[0].cells = Array.from({ length: 21 }, (_, k) => cell(`x${k}`));
    else if (roll < 0.25 && next.projects?.[0]?.tabs?.[0]) next.projects[0].tabs[0].cells = [];
    else if (roll < 0.45 && Array.isArray(next.projects?.[0]?.tabs?.[0]?.layout?.areas)) next.projects[0].tabs[0].layout.areas = next.projects[0].tabs[0].layout.areas.slice(1);
    else if (roll < 0.55 && next.projects?.[0]?.tabs) next.projects[0].tabs = next.projects[0].tabs.slice(1);
    const nextText = JSON.stringify(next);
    let out = null;
    let error = null;
    try { out = diskText(normalizeEditedState(JSON.parse(nextText), JSON.parse(JSON.stringify(prevJson)))); } catch (e) { error = String(e?.message ?? e); }
    rows.push({ prev: prevJson, next: JSON.parse(nextText), ...(error === null ? { out } : { error }) });
  }
  // A hand-built edit whose cells / areas are objects with an own `length` (any JSON value): TS reads the property as is.
  const prev = JSON.parse(JSON.stringify(withWorld(NOW, () => normalizeState(richState(), 'win32'))));
  const lengths = [2, '2', 1, '1', ' 3 ', 2.5, 0, 21, '21', 'abc', null, true, [3], [], {}, '0x2', undefined];
  for (const target of ['cells', 'areas']) {
    for (const length of lengths) {
      const next = JSON.parse(JSON.stringify(prev));
      const tab = next.projects[0].tabs[0];
      const shape = length === undefined ? {} : { length };
      if (target === 'cells') tab.cells = shape;
      else tab.layout.areas = shape;
      const nextText = JSON.stringify(next);
      let out = null;
      let error = null;
      try { out = diskText(normalizeEditedState(JSON.parse(nextText), JSON.parse(JSON.stringify(prev)))); } catch (e) { error = String(e?.message ?? e); }
      rows.push({ prev, next: JSON.parse(nextText), ...(error === null ? { out } : { error }) });
    }
  }
  return rows;
}
