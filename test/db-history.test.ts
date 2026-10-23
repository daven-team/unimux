// The SQL query history (1.0.6): records (masked passwords, capped text and errors), the cap per connection that keeps
// favourites, stars, clearing, search, the stored file (newer and broken files are never written over) and the store in main
// (deleted connections dropped, the "keep a history" switch, batched writes).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addHistory, clearHistoryEntries, historyRecord, normalizeHistoryFile, searchHistory, starHistory, type DbHistoryItem } from '../src/shared/dbHistory';
import { DbHistoryStore } from '../src/main/db/history';

const C1 = '00000000-0000-4000-8000-000000000001';
const C2 = '00000000-0000-4000-8000-000000000002';
const dir = mkdtempSync(join(tmpdir(), 'unimux-history-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const nextId = () => `id${++seq}`;
const rec = (sql: string, at = 1, ok = true) => ({ sql, at, timeMs: 3, rows: 1, ok });

describe('history entries', () => {
  it('a record keeps the statement with passwords masked, one line of its error, and no overlong text', () => {
    expect(historyRecord({ sql: "  CREATE USER u IDENTIFIED BY 'secret'  ", at: 5, timeMs: 2.6, rows: 0, ok: true })).toEqual({ sql: "CREATE USER u IDENTIFIED BY '***'", at: 5, timeMs: 3, rows: 0, ok: true });
    expect(historyRecord({ sql: 'SELECT x', at: 5, timeMs: 1, rows: null, ok: false, error: 'line one\nline two' })).toMatchObject({ ok: false, error: 'line one', rows: null });
    expect(historyRecord({ sql: 'x'.repeat(20_000), at: 1, timeMs: 1, rows: 1, ok: true })).toBeNull();
    expect(historyRecord({ sql: '   ', at: 1, timeMs: 1, ok: true })).toBeNull();
    expect(historyRecord({ sql: 'SELECT 1', at: 'now', timeMs: 1, ok: true })).toBeNull();
  });

  it('newest first, capped per connection; favourites stay over the cap and when cleared', () => {
    let list: DbHistoryItem[] = [];
    list = addHistory(list, [rec('a', 1), rec('b', 2)], nextId, 3);
    expect(list.map((e) => e.sql)).toEqual(['b', 'a']);
    list = starHistory(list, list[1].id, true)!;
    list = addHistory(list, [rec('c', 3), rec('d', 4), rec('e', 5)], nextId, 3);
    expect(list.map((e) => `${e.sql}${e.star ? '*' : ''}`)).toEqual(['e', 'd', 'c', 'a*']);
    expect(searchHistory(list, 'A')).toHaveLength(1);
    expect(searchHistory(list, '', { starred: true }).map((e) => e.sql)).toEqual(['a']);
    expect(clearHistoryEntries(list).map((e) => e.sql)).toEqual(['a']);
    expect(clearHistoryEntries(list, true)).toEqual([]);
    expect(starHistory(list, 'nope', true)).toBeNull();
    const unstarred = starHistory(list, list[3].id, false)!;
    expect(unstarred[3].star).toBeUndefined();
  });

  it('a stored file is read with its switch; a newer or broken one is left alone', () => {
    const entry = { id: 'x1', sql: 'SELECT 1', at: 1, timeMs: 1, rows: 1, ok: true };
    expect(normalizeHistoryFile({ version: 1, enabled: false, connections: { [C1]: [entry, { ...entry }, { id: 'bad id!', sql: 'x' }], nope: [entry] } }))
      .toEqual({ enabled: false, connections: new Map([[C1, [entry]]]), newer: false, invalid: false });
    expect(normalizeHistoryFile({ version: 2 }).newer).toBe(true);
    expect(normalizeHistoryFile([]).invalid).toBe(true);
  });
});

describe('the history store in main', () => {
  it('records, stars, clears and writes atomically; deleted connections are dropped; the switch stops recording', () => {
    const file = join(dir, 'h1.json');
    const live = new Set([C1, C2]);
    const store = new DbHistoryStore(file, { connectionExists: (id) => live.has(id), writeDelayMs: 1_000_000 });
    expect(store.list(C1)).toEqual({ enabled: true, entries: [] });
    expect(store.record(C1, [rec('SELECT 1'), rec("ALTER USER x PASSWORD 'p'")])).toBe(true);
    expect(store.record('00000000-0000-4000-8000-000000000009', [rec('x')])).toBe(false);
    expect(store.record(C1, 'nope')).toBe(false);
    store.record(C2, [rec('SELECT 2')]);
    const entries = store.list(C1).entries;
    expect(entries.map((e) => e.sql)).toEqual(["ALTER USER x PASSWORD '***'", 'SELECT 1']);
    expect(store.star(C1, entries[1].id, true)).toBe(true);
    store.flush();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.connections[C1][1]).toMatchObject({ sql: 'SELECT 1', star: true });
    // A deleted connection's history goes with the next write.
    live.delete(C2);
    store.clear(C1, false);
    expect(store.list(C1).entries.map((e) => e.sql)).toEqual(['SELECT 1']);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).connections)).toEqual([C1]);
    expect(store.setEnabled(false)).toBe(true);
    expect(store.record(C1, [rec('SELECT 3')])).toBe(false);
    const again = new DbHistoryStore(file, { connectionExists: (id) => live.has(id) });
    expect(again.list(C1)).toMatchObject({ enabled: false, entries: [{ sql: 'SELECT 1', star: true }] });
  });

  it('never writes over a file of a newer version or one that is not a history file', () => {
    const file = join(dir, 'h2.json');
    writeFileSync(file, JSON.stringify({ version: 9, future: true }));
    const store = new DbHistoryStore(file, { connectionExists: () => true });
    expect(store.record(C1, [rec('SELECT 1')])).toBe(false);
    expect(store.setEnabled(false)).toBe(false);
    store.flush();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 9, future: true });
  });
});
