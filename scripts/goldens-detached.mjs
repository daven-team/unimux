// The detached-window part of the golden corpus (1.2.0, PLAN W5), used by scripts/dump-goldens.mjs:
//
//   test/golden/detached.jsonl       {fn, args, out}: what a function of src/shared/detached.ts (and normalizeWaitMark of
//                                    src/shared/waiting.ts) answers; checked by src-tauri/crates/unimux-state/tests/golden.rs
//   test/golden/route-message.jsonl  {channel, args, owners, out}: routeMessage, shared by vitest
//                                    (test/route-message-fixtures.test.ts) and cargo (unimux-ipc route::tests)
//
// Inputs come from a seeded PRNG (mulberry32 of goldens-normalize.mjs), so the files are reproducible. Display layouts mix
// side-by-side, stacked and gapped monitors with negative coordinates and odd sizes; registries mix grids and file tabs,
// windows of closed grids, the limit and saved places.
import { rng } from './goldens-normalize.mjs';

const pickFrom = (r) => (xs) => xs[Math.floor(r() * xs.length)];

const BROADCAST = ['state:changed', 'cli:changed', 'mcp:info', 'ptyhost:crashed', 'app:before-quit', 'db:session', 'sftp:prompt'];
const CELL = ['cell:hook', 'cell:session', 'cell:context', 'cell:restarted', 'cell:spawnError', 'focus-cell', 'ssh:session', 'ssh:prompt', 'notify:answer'];
const OTHER = ['auth:state', 'app:notice', 'app:confirm-quit', 'usage:state', 'detach:returned', 'waiting:step', 'db:other', 'automation:statuses'];

export function routeMessageRows({ routeMessage }) {
  const r = rng(1301);
  const pick = pickFrom(r);
  const cells = ['c1', 'c2', 'c3', 'c4', 'c5', 'install:x', ''];
  const windows = ['w1', 'w2', 'f2b8a1c4-0000-4000-8000-000000000001'];
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const owners = [];
    for (const c of cells) if (r() < 0.4) owners.push([c, pick(windows)]);
    const roll = r();
    let channel;
    let args;
    if (roll < 0.2) {
      channel = pick(BROADCAST);
      args = [{ revision: i }, ...(r() < 0.3 ? [i] : [])];
    } else if (roll < 0.6) {
      channel = pick(CELL);
      const first = pick(['id', 'obj', 'objNum', 'none', 'num', 'arr']);
      const id = pick(cells);
      args = first === 'id' ? [id, pick(['stop', 'notification', null])] : first === 'obj' ? [{ cellId: id, phase: 'ready' }]
        : first === 'objNum' ? [{ cellId: 3 }] : first === 'num' ? [7] : first === 'arr' ? [[id]] : [];
    } else if (roll < 0.8) {
      channel = 'automation:start-cells';
      const shape = r();
      args = shape < 0.8 ? [Array.from({ length: Math.floor(r() * 6) }, () => (r() < 0.1 ? 5 : pick(cells)))] : shape < 0.9 ? ['c1'] : [];
    } else {
      channel = pick(OTHER);
      args = r() < 0.5 ? [] : [{ x: i }, 'c1'];
    }
    rows.push({ channel, args, owners, out: routeMessage(channel, args, new Map(owners)) });
  }
  return rows;
}

const PID = 'p1';
const UUIDS = ['00000000-0000-4000-8000-0000000000c1', 'AAAAAAAA-0000-4000-8000-0000000000C2', 'not-a-uuid'];

function displaysOf(r) {
  const pick = pickFrom(r);
  const n = Math.floor(r() * 4);
  const list = [];
  let x = pick([0, -1920, 0, 100]);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const width = pick([1920, 2560, 1280, 1366, 3840, 1707]);
    const height = pick([1040, 1400, 984, 2120, 1067]);
    list.push({ id: pick([1, 2, 3, 2779098405, 21528, 7]) + i * 10, workArea: { x, y, width, height } });
    const step = r();
    if (step < 0.5) x += width + (r() < 0.2 ? 300 : 0);
    else if (step < 0.8) { y += height; }
    else { x -= pick([1920, 2560]); y = pick([0, -400, 200]); }
  }
  return list;
}

function rectOf(r) {
  const pick = pickFrom(r);
  return { x: pick([0, 10, 1900, 2100, -1800, -6000, 4000, 333.5]), y: pick([0, -50, 100, 1030, 2500, -300]), width: pick([1, 100, 480, 600, 1000, 1200, 4000]), height: pick([1, 50, 320, 700, 800, 3000]) };
}

function stateOf(r, i) {
  const pick = pickFrom(r);
  const tabs = ['ta', 'tb', 'tc'].filter(() => r() < 0.8).map((id, k) => ({ id, name: pick(['Grid 1', 'Grid 5', '', 'Ąę']), cells: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, c) => ({ id: `${id}-c${c}` })) }));
  const projects = [{ id: PID, name: pick(['P', 'Proj']), tabs }];
  if (r() < 0.3) projects.push({ id: 'p2', name: 'Two', tabs: [{ id: 'tz', name: 'Z', cells: [{ id: 'tz-c0' }, { id: 'ta-c0' }] }] });
  const s = { version: 1, projects, ...(r() < 0.5 ? { activeProjectId: PID } : {}) };
  const list = [];
  const count = Math.floor(r() * 10);
  for (let k = 0; k < count; k++) {
    const grid = r() < 0.6;
    const w = grid
      ? { id: `w${k}`, target: { kind: 'grid', projectId: pick([PID, 'p2']), tabId: pick(['ta', 'tb', 'tc', 'tz', 'gone']) } }
      : { id: `w${k}`, target: { kind: 'file', fileId: pick(['f1', 'f2', 'f3']), projectId: PID, name: pick(['a.ts', 'b.md']), reopen: { kind: 'local', path: 'C:\\x' } } };
    if (r() < 0.4) w.bounds = { x: 10 * k, y: 20, width: 800, height: 600 };
    if (r() < 0.3) w.displayId = k;
    if (r() < 0.2) w.maximized = true;
    list.push(w);
  }
  if (list.length || r() < 0.2) s.detachedWindows = list;
  if (r() < 0.3) s.after = i;
  return s;
}

export function detachedRows(m) {
  const r = rng(1302);
  const pick = pickFrom(r);
  const rows = [];
  const add = (fn, args, out) => rows.push({ fn, args, out: out === undefined ? null : out });
  for (let i = 0; i < 150; i++) {
    const displays = displaysOf(r);
    const primaryId = displays.length && r() < 0.8 ? displays[Math.floor(r() * displays.length)].id : pick([1, 99]);
    const saved = r() < 0.85 ? rectOf(r) : undefined;
    add('restoreBounds', [saved ?? null, displays, primaryId], m.restoreBounds(saved, displays, primaryId));
    const point = { x: pick([0, 500, 1910, 2500, -100, 9000, -2500, 3000]), y: pick([0, 300, 1030, -40, 2000]) };
    const size = r() < 0.8 ? { width: 1000, height: 700 } : { width: pick([480, 3000]), height: pick([320, 2000]) };
    add('boundsAtPoint', [point, size, displays, primaryId], m.boundsAtPoint(point, size, displays, primaryId));
    const main = r() < 0.85 ? rectOf(r) : null;
    add('boundsBeside', [main, size, displays, primaryId], m.boundsBeside(main, size, displays, primaryId));
    if (displays.length) {
      const rect = rectOf(r);
      add('clampRect', [rect, displays[0].workArea], m.clampRect(rect, displays[0].workArea));
    }
    add('displayAt', [displays, point, primaryId], m.displayAt(displays, point, primaryId)?.id ?? null);
  }
  for (let i = 0; i < 120; i++) {
    const s = stateOf(r, i);
    const prev = stateOf(r, i + 1000);
    // The registry as main holds it (normalized against the open grids).
    const list = m.normalizeDetachedWindows(s.detachedWindows, m.openGrids(s.projects));
    const state = { ...s };
    if (list) state.detachedWindows = list; else delete state.detachedWindows;
    add('cellOwners', [state], [...m.cellOwners(state)]);
    const prevList = m.normalizeDetachedWindows(prev.detachedWindows, m.openGrids(prev.projects));
    const prevState = { ...prev, ...(prevList ? { detachedWindows: prevList } : {}) };
    if (!prevList) delete prevState.detachedWindows;
    add('routeChanges', [[...m.cellOwners(prevState)], [...m.cellOwners(state)]], m.routeChanges(m.cellOwners(prevState), m.cellOwners(state)));
    const w = r() < 0.5
      ? { id: `n${i}`, target: { kind: 'grid', projectId: PID, tabId: pick(['ta', 'tb', 'tc']) } }
      : { id: `n${i}`, target: { kind: 'file', fileId: pick(['f1', 'f9']), projectId: PID, name: 'x.ts', reopen: { kind: 'local', path: 'C:\\x' } } };
    const added = m.addDetached(state, w);
    add('addDetached', [state, w], added === null ? 'limit' : added.state === state ? { existing: added.window } : { state: added.state });
    const id = pick(['w0', 'w1', 'w2', 'nope']);
    const removed = m.removeDetached(state, id);
    add('removeDetached', [state, id], removed === state ? 'same' : removed);
    const place = { ...(r() < 0.8 ? { bounds: pick([{ x: 0, y: 20, width: 800, height: 600 }, { x: -1900, y: 5, width: 1000, height: 700 }]) } : {}), ...(r() < 0.6 ? { displayId: pick([0, 1, 2779098405]) } : {}), maximized: r() < 0.3 };
    const placed = m.setDetachedPlace(state, id, place);
    add('setDetachedPlace', [state, id, place], placed === state ? 'same' : placed);
    for (const entry of state.detachedWindows ?? []) add('detachedTitle', [state, entry.target], m.detachedTitle(state, entry.target));
  }
  // The limit: 8 windows (files f0..f7), a ninth tab is refused, a tab that has a window keeps it.
  const full = { version: 1, projects: [], detachedWindows: Array.from({ length: 8 }, (_, k) => ({ id: `l${k}`, target: { kind: 'file', fileId: `f${k}`, projectId: '', name: 'n', reopen: { kind: 'local', path: 'C:\\n' } } })) };
  for (const fileId of ['f8', 'f3']) {
    const w = { id: 'l9', target: { kind: 'file', fileId, projectId: '', name: 'n', reopen: { kind: 'local', path: 'C:\\n' } } };
    const added = m.addDetached(full, w);
    add('addDetached', [full, w], added === null ? 'limit' : added.state === full ? { existing: added.window } : { state: added.state });
  }
  const S1 = 'db:00000000-0000-4000-8000-0000000000e1';
  const items = [
    { id: 'f1', text: '' }, { id: 'f2' }, 'x', 3, null, [1], { id: 7 },
    { handoff: 'tab', fileId: 'f1', dbSessions: [S1, 'junk', S1, 42, 'DB:00000000-0000-4000-8000-0000000000E2'] },
    { handoff: 'tab', fileId: 'f2', dbSessions: Array.from({ length: 40 }, (_, k) => `db:00000000-0000-4000-8000-${String(k).padStart(12, '0')}`) },
    { handoff: 'tab', fileId: 'other', dbSessions: [S1] }, { handoff: 'tab', fileId: '', dbSessions: [] }, { handoff: 'tab', fileId: 'f1', dbSessions: 'x' },
  ];
  for (let i = 0; i < 60; i++) {
    const list = items.filter(() => r() < 0.4);
    const split = m.splitHandoffs(list);
    add('splitHandoffs', [list], split);
    add('handoffSessions', [split.handoffs], m.handoffSessions(split.handoffs));
  }
  const counts = [0, 1, 2, 1.5, -1, '3', 1e9, null, true, 100000, 100001];
  const works = [];
  for (let i = 0; i < 60; i++) {
    const raw = r() < 0.1 ? pick([null, 'x', [1]]) : Object.fromEntries(['tx', 'staged', 'redis', 'files', 'saving'].filter(() => r() < 0.7).map((k) => [k, pick(counts)]));
    const work = m.cleanWork(raw);
    add('cleanWork', [raw], work);
    if (work) works.push(work);
  }
  for (let i = 0; i + 3 <= works.length; i += 3) add('sumWork', [works.slice(i, i + 3 + (i % 2))], m.sumWork(works.slice(i, i + 3 + (i % 2))));
  add('sumWork', [[]], m.sumWork([]));
  for (let i = 0; i < 80; i++) {
    const kind = pick(['sql', 'sql', 'redis', 'redis', 'file', undefined]);
    const raw = r() < 0.05 ? null : {
      kind, connectionId: pick([...UUIDS, UUIDS[0]]),
      ...(r() < 0.95 ? { database: pick(['shop', '', 'x'.repeat(64), 'x'.repeat(65), 'ąę', 5]) } : {}),
      ...(r() < 0.95 ? { text: pick(['select 1', '', 'select 1', 7]) } : {}),
      ...(r() < 0.9 ? { view: pick(['keys', 'console', 'pubsub', 'info', 'shell']) } : {}),
      ...(r() < 0.9 ? { db: pick([0, 2, -1, 1.5, 10000, 10001, '1']) } : {}),
    };
    add('cleanOpenInMain', [raw], m.cleanOpenInMain(raw));
  }
  for (let i = 0; i < 80; i++) {
    const raw = r() < 0.05 ? pick([null, 'x']) : {
      ...(r() < 0.95 ? { kind: pick(['permission', 'question', 'elicitation', 'input', 'limit', 'error', 'failed', 'interrupted', 'done', 'nope', 3]) } : {}),
      ...(r() < 0.95 ? { since: pick([1, 0, -5, 1762430400000, 1.5, '5']) } : {}),
      ...(r() < 0.5 ? { tool: pick(['Bash', 'mcp__unimux__wait_for', 'a b', '', 'x'.repeat(80), 'x'.repeat(81), 'ą', 5]) } : {}),
      ...(r() < 0.3 ? { error: pick(['rate_limit', 'x/y:z@1.2-3', 'bad!']) } : {}),
      ...(r() < 0.4 ? { code: pick([1, -2, 1.5, 2 ** 53, 2 ** 53 - 1, '1']) } : {}),
      ...(r() < 0.4 ? { seenAt: pick([5, 0, -1, 1.25, 'x']) } : {}),
      ...(r() < 0.2 ? { extra: 1 } : {}),
    };
    add('normalizeWaitMark', [raw], m.normalizeWaitMark(raw));
  }
  return rows;
}
