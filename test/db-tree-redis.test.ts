// The Redis part of the "Bazy danych" tree (1.0.3): DBs under the connection, the loaded keys of a DB as a ":"-tree.
import { describe, expect, it } from 'vitest';
import type { DbConnection } from '../src/shared/db';
import { buildDbTree, loadKey, nodeKey, type DbLoad } from '../src/shared/dbTree';

const ID = '00000000-0000-4000-8000-000000000001';
const redis = { id: ID, kind: 'redis', name: 'cache', host: 'h', port: 6379, user: '', dbIndex: 0, tls: 'disable', ssh: null, readOnly: false, createdAt: 1, updatedAt: 1 } as DbConnection;
const key = (name: string) => ({ key: name });
const tree = (open: string[], loads: Record<string, DbLoad>, filter = '') =>
  buildDbTree({ connections: [redis], open: new Set([nodeKey.connection(ID), ...open]), loads, filter, live: () => true });

describe('Redis in the database tree', () => {
  it('asks for the DB list first', () => {
    const { needed } = tree([], {});
    expect(needed).toEqual([{ kind: 'redisDbs', key: loadKey.redisDbs(ID), connectionId: ID }]);
  });

  it('lists every DB with its key count; the connection DB starts open and loads its keys', () => {
    const { rows, needed } = tree([], { [loadKey.redisDbs(ID)]: { status: 'ready', value: { count: 4, current: 0, dbs: [{ index: 2, keys: 7, expires: 0, avgTtlMs: 0 }] } } });
    const dbs = rows.filter((r) => r.type === 'redisDb');
    expect(dbs.map((r) => r.type === 'redisDb' && [r.db, r.keys, r.expanded])).toEqual([[0, 0, true], [1, 0, false], [2, 7, false], [3, 0, false]]);
    expect(needed).toEqual([{ kind: 'redisKeys', key: loadKey.redisKeys(ID, 0), connectionId: ID, db: 0 }]);
  });

  it('shows the keys as a ":"-tree, open folders, and a load-more row while the scan goes on', () => {
    const loads: Record<string, DbLoad> = {
      [loadKey.redisDbs(ID)]: { status: 'ready', value: { count: 1, current: 0, dbs: [] } },
      [loadKey.redisKeys(ID, 0)]: { status: 'ready', value: { keys: [key('user:1'), key('user:2'), key('cfg')], cursor: '42' } },
    };
    const closed = tree([], loads).rows.filter((r) => r.type === 'redisFolder' || r.type === 'redisKey' || r.type === 'redisMore');
    expect(closed.map((r) => r.type)).toEqual(['redisFolder', 'redisKey', 'redisMore']);
    const opened = tree([nodeKey.redisFolder(ID, 0, 'user:')], loads).rows.filter((r) => r.type === 'redisKey');
    expect(opened.map((r) => r.type === 'redisKey' && r.name)).toEqual(['1', '2', 'cfg']);
  });

  it('a filter shows matching keys flat; an empty DB says it has no keys', () => {
    const loads: Record<string, DbLoad> = {
      [loadKey.redisDbs(ID)]: { status: 'ready', value: { count: 1, current: 0, dbs: [] } },
      [loadKey.redisKeys(ID, 0)]: { status: 'ready', value: { keys: [key('user:1'), key('cfg')], cursor: '0' } },
    };
    expect(tree([], loads, 'user').rows.filter((r) => r.type === 'redisKey').map((r) => r.type === 'redisKey' && r.name)).toEqual(['user:1']);
    const empty = tree([], { ...loads, [loadKey.redisKeys(ID, 0)]: { status: 'ready', value: { keys: [], cursor: '0' } } }).rows;
    expect(empty.some((r) => r.type === 'status' && r.status === 'empty' && r.keys)).toBe(true);
  });
});
