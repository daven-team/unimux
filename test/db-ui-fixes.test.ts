// Database UI fix round 1 (1.0.0): what a save leaves staged, the cell editor's commit, the transaction toggle, the row a
// failed save names, and the query history's masking and size.
import { describe, expect, it } from 'vitest';
import {
  addInsert, cellCommit, conflictRowIndex, EMPTY_STAGED, failedTarget, pruneHistory, pushHistory, redactSql, setInsertValue, stageCell, stagedCount,
  stagedEdits, toggleDeletes, txToggle, withoutSent,
} from '../src/shared/dbTabs';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';

describe('save', () => {
  it('removes exactly the sent edits and keeps what was staged meanwhile', () => {
    let sent = stageCell(EMPTY_STAGED, { id: '1' }, 'name', 'b', 'a');
    sent = toggleDeletes(sent, [{ key: { id: '2' } }]);
    sent = setInsertValue(addInsert(sent, 'n1'), 'n1', 'id', '9');
    // While the save ran: id 1 got another column and its name changed again, a new delete and a new insert.
    let now = stageCell(sent, { id: '1' }, 'note', 'x', 'old');
    now = stageCell(now, { id: '1' }, 'name', 'c', 'a');
    now = toggleDeletes(now, [{ key: { id: '3' } }]);
    now = addInsert(now, 'n2');
    const left = withoutSent(now, sent);
    expect(left.updates).toEqual([{ key: { id: '1' }, set: { name: 'c', note: 'x' }, original: { name: 'b', note: 'old' } }]);
    expect(left.deletes.map((d) => d.key)).toEqual([{ id: '3' }]);
    expect(left.inserts.map((i) => i.id)).toEqual(['n2']);
    // Nothing staged meanwhile: nothing is left (no edit is sent twice).
    expect(stagedCount(withoutSent(sent, sent))).toBe(0);
  });

  it('maps a failed save index to its row and finds it on the page', () => {
    let s = stageCell(EMPTY_STAGED, { id: '1' }, 'name', 'b', 'a');
    s = stageCell(s, { id: '5' }, 'name', 'z', 'y');
    s = toggleDeletes(s, [{ key: { id: '5' } }, { key: { id: '7' } }]);
    s = addInsert(s, 'n1');
    // stagedEdits: update id 1 (id 5's update is dropped: deleted), delete 5, delete 7, insert n1.
    expect(stagedEdits(s).map((e) => e.op)).toEqual(['update', 'delete', 'delete', 'insert']);
    expect(failedTarget(s, 2)).toEqual({ kind: 'row', key: { id: '7' } });
    expect(failedTarget(s, 3)).toEqual({ kind: 'insert', id: 'n1' });
    expect(failedTarget(s, undefined)).toBeNull();
    const keys = [{ id: '1' }, null, { id: '7' }];
    expect(conflictRowIndex(failedTarget(s, 2), keys, s, 3)).toBe(2);
    expect(conflictRowIndex(failedTarget(s, 3), keys, s, 3)).toBe(3);
    expect(conflictRowIndex({ kind: 'row', key: { id: '99' } }, keys, s, 3)).toBeNull();
  });
});

describe('cell editor', () => {
  it('stages nothing when the user typed nothing (NULL and DEFAULT stay)', () => {
    expect(cellCommit({ touched: false, asNull: false, text: '', kind: 'text' })).toEqual({ kind: 'none' });
    expect(cellCommit({ touched: true, asNull: false, text: '', kind: 'text' })).toEqual({ kind: 'value', value: '' });
    expect(cellCommit({ touched: false, asNull: true, text: 'x', kind: 'int' })).toEqual({ kind: 'value', value: null });
    expect(cellCommit({ touched: true, asNull: false, text: 'abc', kind: 'int' })).toMatchObject({ kind: 'error' });
    expect(cellCommit({ touched: true, asNull: false, text: ' 42 ', kind: 'int' })).toEqual({ kind: 'value', value: '42' });
  });
});

describe('transaction toggle', () => {
  it('follows the session state only', () => {
    expect(txToggle('idle', true)).toBe('begin');
    expect(txToggle(undefined, true)).toBe('begin');
    expect(txToggle('transaction', true)).toBeNull();
    expect(txToggle('transaction', false)).toBe('ask');
    expect(txToggle('failed', false)).toBe('rollback');
    expect(txToggle('idle', false)).toBeNull();
  });
});

describe('query history', () => {
  it('masks passwords', () => {
    expect(redactSql("ALTER ROLE app WITH PASSWORD 'se''cret' LOGIN")).toBe("ALTER ROLE app WITH PASSWORD '***' LOGIN");
    expect(redactSql("CREATE USER x ENCRYPTED PASSWORD E'abc'")).toBe("CREATE USER x ENCRYPTED PASSWORD '***'");
    expect(redactSql('CREATE USER x PASSWORD $$p$$')).toBe("CREATE USER x PASSWORD '***'");
    expect(redactSql("CREATE USER MAPPING FOR u SERVER s OPTIONS (user 'a', password 'b')")).toBe("CREATE USER MAPPING FOR u SERVER s OPTIONS (user 'a', password '***')");
    expect(redactSql("SELECT dblink_connect('host=h password=topsecret dbname=d')")).toBe("SELECT dblink_connect('host=h password=*** dbname=d')");
    expect(redactSql("x IDENTIFIED BY 'pw'")).toBe("x IDENTIFIED BY '***'");
    expect(pushHistory([], { sql: "ALTER USER a PASSWORD 'p'", at: 1, ok: true, timeMs: 0 })[0].sql).toBe("ALTER USER a PASSWORD '***'");
  });

  it('keeps the history within its size, for live connections only', () => {
    const entry = (sql: string, at: number) => ({ sql, at, ok: true, timeMs: 0 });
    const all = { [C1]: [entry('a'.repeat(400), 5), entry('b'.repeat(400), 1)], [C2]: [entry('c'.repeat(400), 3)], gone: [entry('x', 9)] };
    const pruned = pruneHistory(all, new Set([C1, C2]), 1000);
    expect(Object.keys(pruned).sort()).toEqual([C1, C2].sort());
    expect(pruned[C1].map((e) => e.at)).toEqual([5]);
    expect(pruned[C2].map((e) => e.at)).toEqual([3]);
    expect(pushHistory([], entry('y'.repeat(9000), 1))).toEqual([]);
  });
});
