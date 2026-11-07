// The D1 vectors (1.2.0): test/golden/db-ipc.jsonl holds what the zod schemas of src/main/db/ipc.ts, strictConnection and the
// connection and query history helpers answer for a fixed set of inputs; the Rust port answers the same rows
// (src-tauri/crates/unimux-db/tests/db_ipc.rs). Here every row runs through the TS code again, so a change of the TS side
// without new vectors (npm run gen:goldens) fails.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ipc from '../src/main/db/ipc';
import * as service from '../src/main/db/service';
import * as db from '../src/shared/db';
import * as history from '../src/shared/dbHistory';
import * as redis from '../src/shared/dbRedis';
// @ts-expect-error plain ESM script without type declarations
import { callDbIpc } from '../scripts/goldens-db-ipc.mjs';

const modules = { ipc, service, db, history, redis };

interface Row { fn: string; args: unknown[]; out: unknown }

const rows = (): Row[] =>
  readFileSync(resolve(__dirname, 'golden', 'db-ipc.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);

describe('DB main-side vectors', () => {
  it('db-ipc.jsonl: the TS reference still answers every row', () => {
    const list = rows();
    expect(list.length).toBeGreaterThanOrEqual(20_000);
    const failures: string[] = [];
    for (const [i, row] of list.entries()) {
      const got = JSON.stringify(callDbIpc(modules, row.fn, row.args));
      if (got !== JSON.stringify(row.out)) failures.push(`row ${i} ${row.fn}: ${got.slice(0, 200)} != ${JSON.stringify(row.out).slice(0, 200)}`);
    }
    expect(failures.slice(0, 20)).toEqual([]);
  }, 120_000);

  it('covers every schema and helper the Rust port has', () => {
    const list = rows();
    const fns = new Set(list.map((r) => r.fn));
    for (const fn of ['schema', 'redisOp', 'strictConnection', 'dbEndpoint', 'dbDefaultDatabase', 'duplicateDbConnection', 'validDbFilePath', 'historyRecord',
      'normalizeHistoryItem', 'normalizeHistoryFile', 'addHistory', 'starHistory', 'clearHistoryEntries']) expect(fns.has(fn), fn).toBe(true);
    const schemas = new Set(list.filter((r) => r.fn === 'schema').map((r) => r.args[0]));
    for (const name of Object.keys(ipc.DB_IPC_SCHEMAS)) if (name !== 'redisOp') expect(schemas.has(name), name).toBe(true);
  });
});
