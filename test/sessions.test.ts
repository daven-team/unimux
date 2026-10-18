import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCacheStats, claudeProjectDirName, clearClaudeCache, clearCodexCache, codexCacheStats, findRecentCodexSession, listClaudeSessions, listClaudeSessionsAsync, listCodexSessionsAsync, listSessionsAsync } from '../src/main/sessions';

const PROJECT = 'D:\\Projekty\\bot-discord';
const jsonl = (rows: unknown[]) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'mc-home-'));
  const cdir = join(home, '.claude', 'projects', claudeProjectDirName(PROJECT));
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'aaa.jsonl'), jsonl([
    { type: 'mode', sessionId: 'aaa' },
    'this is not json',
    { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'meta stuff' }] }, sessionId: 'aaa', cwd: PROJECT, timestamp: '2026-10-01T10:00:00Z' },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' }, sessionId: 'aaa' },
    { type: 'user', message: { content: 'napraw   logowanie\nw bocie' }, sessionId: 'aaa' },
  ]));
  writeFileSync(join(cdir, 'bbb.jsonl'), jsonl([
    { type: 'user', message: { content: 'pierwszy prompt' }, sessionId: 'bbb', cwd: PROJECT, timestamp: '2026-10-02T10:00:00Z' },
    { type: 'ai-title', aiTitle: 'Refaktor sidebaru', sessionId: 'bbb' },
  ]));
  writeFileSync(join(cdir, 'empty.jsonl'), jsonl([{ type: 'mode', sessionId: 'empty' }]));

  const xdir = join(home, '.codex', 'sessions', '2026', '10', '06');
  mkdirSync(xdir, { recursive: true });
  const meta = (id: string, cwd: string) => ({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-06T10:00:00Z', base_instructions: { text: 'x'.repeat(90000) } } });
  const user = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  writeFileSync(join(xdir, 'rollout-2026-10-06T10-00-00-c1.jsonl'), jsonl([
    meta('c1', PROJECT), user('# AGENTS.md instructions'), user('<environment_context>'), user('dodaj testy'),
  ]));
  writeFileSync(join(xdir, 'rollout-2026-10-06T11-00-00-c2.jsonl'), jsonl([meta('c2', 'D:\\Other'), user('inny projekt')]));
  return home;
}

describe('sessions', () => {
  it('encodes claude project dir names', () => {
    expect(claudeProjectDirName('C:\\Users\\x\\a.b c')).toBe('C--Users-x-a-b-c');
  });

  it('lists claude sessions with titles, skipping meta/command lines, junk and empty sessions', () => {
    const list = listClaudeSessions(fakeHome(), PROJECT);
    expect(list.map((s) => s.id).sort()).toEqual(['aaa', 'bbb']);
    expect(list.find((s) => s.id === 'aaa')!.title).toBe('napraw logowanie w bocie');
    expect(list.find((s) => s.id === 'bbb')!.title).toBe('Refaktor sidebaru');
  });

  it('encodes worktree paths like the project dir', () => {
    expect(claudeProjectDirName('D:\\Projekty\\bot\\.claude\\worktrees\\x_1')).toBe('D--Projekty-bot--claude-worktrees-x-1');
    expect(claudeProjectDirName('/Users/a/proj/.worktrees/feat')).toBe('-Users-a-proj--worktrees-feat');
  });

  it('caches claude sessions by mtime+size, re-parses changes and prunes deleted files', async () => {
    clearClaudeCache();
    const home = fakeHome();
    const cdir = join(home, '.claude', 'projects', claudeProjectDirName(PROJECT));
    const first = listClaudeSessions(home, PROJECT);
    const parsed = claudeCacheStats().parses;
    expect(parsed).toBe(3);
    expect(listClaudeSessions(home, PROJECT)).toEqual(first);
    expect(await listClaudeSessionsAsync(home, PROJECT)).toEqual(first);
    expect(claudeCacheStats().parses).toBe(parsed); // cache hits: no rereads

    const file = join(cdir, 'bbb.jsonl');
    writeFileSync(file, jsonl([{ type: 'user', message: { content: 'nowy' }, sessionId: 'bbb', cwd: PROJECT }]));
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);
    const after = listClaudeSessions(home, PROJECT);
    expect(claudeCacheStats().parses).toBe(parsed + 1);
    expect(after.find((s) => s.id === 'bbb')!.title).toBe('nowy');

    rmSync(join(cdir, 'aaa.jsonl'));
    expect(listClaudeSessions(home, PROJECT).map((s) => s.id)).toEqual(['bbb']);
    expect(claudeCacheStats().cached).toBe(2); // bbb + empty
    rmSync(cdir, { recursive: true });
    expect(await listClaudeSessionsAsync(home, PROJECT)).toEqual([]);
    expect(claudeCacheStats().cached).toBe(0);
  });

  it('async listing equals the sync listing on a cold cache', async () => {
    const home = fakeHome();
    clearClaudeCache();
    const sync = listClaudeSessions(home, PROJECT);
    clearClaudeCache();
    expect(await listClaudeSessionsAsync(home, PROJECT)).toEqual(sync);
  });

  it('lists codex sessions for the project only, skipping injected context', async () => {
    const list = await listCodexSessionsAsync(fakeHome(), PROJECT.toLowerCase() + '\\');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ cli: 'codex', id: 'c1', title: 'dodaj testy' });
  });

  it('finds a recently written codex session not bound elsewhere', async () => {
    const home = fakeHome();
    expect(await findRecentCodexSession(home, PROJECT, 60000, new Set())).toBe('c1');
    expect(await findRecentCodexSession(home, PROJECT, 60000, new Set(['c1']))).toBeNull();
    expect(await findRecentCodexSession(home, 'D:\Nowhere', 60000, new Set())).toBeNull();
  });
});

describe('incremental session reading', () => {
  const homes: string[] = [];
  const home = () => { const h = mkdtempSync(join(tmpdir(), 'mc-inc-')); homes.push(h); return h; };
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

  it('keeps the head of a growing Claude transcript and re-reads only its tail', async () => {
    clearClaudeCache();
    const h = home();
    const cdir = join(h, '.claude', 'projects', claudeProjectDirName(PROJECT));
    mkdirSync(cdir, { recursive: true });
    const file = join(cdir, 'big.jsonl');
    const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'assistant', sessionId: 'big', message: { content: 'x'.repeat(900) + i } }));
    writeFileSync(file, jsonl([
      { type: 'user', message: { content: 'pierwszy prompt' }, sessionId: 'big', cwd: PROJECT, timestamp: '2026-10-03T10:00:00Z' },
      { type: 'ai-title', aiTitle: 'Tytul z glowy', sessionId: 'big' },
      ...filler(400), // well over the 256 KB head
    ]));
    const first = await listClaudeSessionsAsync(h, PROJECT);
    expect(first[0]).toMatchObject({ id: 'big', title: 'Tytul z glowy', cwd: PROJECT, startedAt: Date.parse('2026-10-03T10:00:00Z') });
    expect(claudeCacheStats()).toMatchObject({ parses: 1, tailReads: 0 });

    appendFileSync(file, jsonl([...filler(5), { type: 'ai-title', aiTitle: 'Nowy tytul', sessionId: 'big' }]));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect((await listClaudeSessionsAsync(h, PROJECT))[0]).toMatchObject({ id: 'big', title: 'Nowy tytul', cwd: PROJECT });
    expect(claudeCacheStats()).toMatchObject({ parses: 1, tailReads: 1 });

    appendFileSync(file, jsonl([{ type: 'custom-title', customTitle: 'Moja nazwa', sessionId: 'big' }]));
    const latest = new Date(Date.now() + 10000);
    utimesSync(file, latest, latest);
    expect(listClaudeSessions(h, PROJECT)[0].title).toBe('Moja nazwa'); // the sync reader shares the cache
    expect(claudeCacheStats()).toMatchObject({ parses: 1, tailReads: 2 });

    // A cold read gives the same answer as the incremental one.
    const warm = await listClaudeSessionsAsync(h, PROJECT);
    clearClaudeCache();
    expect(await listClaudeSessionsAsync(h, PROJECT)).toEqual(warm);

    // A rewritten (shorter) file is parsed in full again.
    writeFileSync(file, jsonl([{ type: 'user', message: { content: 'od nowa' }, sessionId: 'big', cwd: PROJECT }]));
    expect((await listClaudeSessionsAsync(h, PROJECT))[0].title).toBe('od nowa');
    expect(claudeCacheStats().parses).toBe(2);
  });

  it('reads the head again when a large transcript was replaced by a new file that is not shorter', async () => {
    clearClaudeCache();
    const h = home();
    const cdir = join(h, '.claude', 'projects', claudeProjectDirName(PROJECT));
    mkdirSync(cdir, { recursive: true });
    const file = join(cdir, 'swap.jsonl');
    const big = (prompt: string, extra: number) => jsonl([
      { type: 'user', message: { content: prompt }, sessionId: 'swap', cwd: PROJECT },
      ...Array.from({ length: 400 + extra }, (_, i) => ({ type: 'assistant', sessionId: 'swap', message: { content: 'y'.repeat(900) + i } })),
    ]);
    writeFileSync(file, big('stary prompt', 0));
    expect((await listClaudeSessionsAsync(h, PROJECT))[0].title).toBe('stary prompt');
    rmSync(file);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, big('nowy prompt', 10));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect((await listClaudeSessionsAsync(h, PROJECT))[0].title).toBe('nowy prompt');
    expect(claudeCacheStats()).toMatchObject({ parses: 2, tailReads: 0 });
  });

  it('walks Codex day folders newest first, stops early and lists an unchanged folder only once', async () => {
    clearCodexCache();
    const h = home();
    const meta = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: PROJECT, timestamp: '2026-10-06T10:00:00Z' } });
    const user = (text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } });
    const write = (day: string, count: number, prefix: string) => {
      const dir = join(h, '.codex', 'sessions', ...day.split('/'));
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < count; i++) {
        const id = `${prefix}${String(i).padStart(2, '0')}`;
        writeFileSync(join(dir, `rollout-${day.replace(/\//g, '-')}T10-00-${String(i).padStart(2, '0')}-${id}.jsonl`), `${meta(id)}\n${user(`zadanie ${id}`)}\n`);
      }
    };
    write('2025/12/31', 2, 'old');
    write('2026/09/30', 3, 'sep');
    write('2026/10/02', 3, 'oct');
    const list = await listCodexSessionsAsync(h, PROJECT);
    expect(list.map((s) => s.id).sort()).toEqual(['oct00', 'oct01', 'oct02', 'old00', 'old01', 'sep00', 'sep01', 'sep02']);
    const reads = codexCacheStats().dirReads;
    expect(reads).toBe(1 + 2 + 3 + 3); // sessions, two years, three months, three days

    // Within the shared window every worktree path reuses the same index (no folder is listed again).
    await listSessionsAsync(h, join(PROJECT, 'wt'));
    expect(codexCacheStats().dirReads).toBe(reads);

    // The bind lookup needs only the 80 newest files: once the newest day has them, older folders are never listed.
    clearCodexCache();
    write('2026/10/02', 80, 'new');
    expect(await findRecentCodexSession(h, PROJECT, 60000, new Set())).toMatch(/^new|^oct/);
    expect(codexCacheStats().dirReads).toBe(4); // sessions, 2026, 10, 02
  });
});

describe('sessions of worktree folders', () => {
  it('lists conversations of known and removed `<repo>-wt-*` worktrees, labelled, and never of unrelated folders', async () => {
    clearClaudeCache();
    clearCodexCache();
    const home = mkdtempSync(join(tmpdir(), 'mc-home-wt-'));
    const parent = mkdtempSync(join(tmpdir(), 'mc-parent-'));
    const project = join(parent, 'app');
    const live = join(parent, 'app-wt-grid-1'); // open cell, branch known from state
    const loose = join(parent, 'app-wt-left'); // still on disk, no cell knows it: branch asked from git
    const removed = join(parent, 'app-wt-old'); // folder gone
    const unrelated = join(parent, 'app-wt-x', 'nested'); // deeper than a worktree folder
    const other = join(parent, 'apple-wt-1'); // another project's worktree
    for (const dir of [project, live, loose]) mkdirSync(dir, { recursive: true });
    const claude = (cwd: string, id: string, text: string) => {
      const dir = join(home, '.claude', 'projects', claudeProjectDirName(cwd));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.jsonl`), jsonl([{ type: 'user', message: { content: text }, sessionId: id, cwd, timestamp: '2026-10-01T10:00:00Z' }]));
    };
    claude(project, 'main', 'main project');
    claude(live, 'live', 'in the live worktree');
    claude(removed, 'gone', 'in a removed worktree');
    claude(unrelated, 'nested', 'nested folder');
    claude(other, 'apple', 'other project');
    const xdir = join(home, '.codex', 'sessions', '2026', '10', '06');
    mkdirSync(xdir, { recursive: true });
    const codex = (id: string, cwd: string, text: string) => writeFileSync(join(xdir, `rollout-2026-10-06T10-00-00-${id}.jsonl`), jsonl([
      { type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-06T10:00:00Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    ]));
    codex('cx-loose', loose, 'codex in the loose worktree');
    codex('cx-other', other, 'codex elsewhere');

    const branchOf = async (path: string) => (path === loose ? 'mc/left' : undefined);
    const list = await listSessionsAsync(home, project, [{ path: live, branch: 'mc/grid-1' }], branchOf);
    const byId = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual(['cx-loose', 'gone', 'live', 'main']);
    expect(byId.main.worktree).toBeUndefined();
    expect(byId.live.worktree).toEqual({ path: live, label: 'mc/grid-1', branch: 'mc/grid-1', exists: true });
    expect(byId['cx-loose'].worktree).toEqual({ path: loose, label: 'mc/left', branch: 'mc/left', exists: true });
    expect(byId.gone.worktree).toEqual({ path: removed, label: 'app-wt-old', exists: false });

    // Without worktree hints the pattern still finds them; the project's own listing is unchanged.
    expect((await listSessionsAsync(home, project)).map((s) => s.id).sort()).toEqual(['cx-loose', 'gone', 'live', 'main']);
    expect((await listClaudeSessionsAsync(home, project)).map((s) => s.id)).toEqual(['main']);
    rmSync(home, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  });
});
