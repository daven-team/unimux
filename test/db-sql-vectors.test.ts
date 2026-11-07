// The D3 vectors (1.2.0): test/golden/db-sql.jsonl and db-redis.jsonl hold what the SQL and Redis helpers of src/shared answer
// for a fixed set of inputs; the Rust ports answer the same rows (src-tauri/crates/unimux-db/tests/sql_golden.rs). Here every
// row runs through the TS code again, so a change of the TS helpers without new vectors (npm run gen:goldens) fails.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as db from '../src/shared/db';
import * as mysql from '../src/shared/dbMysql';
import * as redis from '../src/shared/dbRedis';
import * as sql from '../src/shared/dbSql';
import * as sqlite from '../src/shared/dbSqlite';
import * as tabs from '../src/shared/dbTabs';
// @ts-expect-error plain ESM script without type declarations
import { callDb } from '../scripts/goldens-db.mjs';

const modules = { sql, sqlite, mysql, redis, db, tabs };

interface Row { fn: string; args: unknown[]; out: unknown }

const rows = (file: string): Row[] =>
  readFileSync(resolve(__dirname, 'golden', file), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);

describe('DB helper vectors', () => {
  for (const [file, min] of [['db-sql.jsonl', 50_000], ['db-redis.jsonl', 5_000]] as const) {
    it(`${file}: the TS helpers still answer every row`, () => {
      const list = rows(file);
      expect(list.length).toBeGreaterThanOrEqual(min);
      const failures: string[] = [];
      for (const [i, row] of list.entries()) {
        const got = JSON.stringify(callDb(modules, row.fn, row.args));
        if (got !== JSON.stringify(row.out)) failures.push(`row ${i} ${row.fn}: ${got.slice(0, 200)} != ${JSON.stringify(row.out).slice(0, 200)}`);
      }
      expect(failures.slice(0, 20)).toEqual([]);
    }, 120_000);
  }

  it('covers every helper the Rust port has', () => {
    const fns = new Set([...rows('db-sql.jsonl'), ...rows('db-redis.jsonl')].map((r) => r.fn));
    for (const fn of ['splitSql', 'statementAt', 'readOnlyAllows', 'sqliteReadOnlyAllows', 'mysqlReadOnlyAllows', 'buildEditStatements', 'sqliteEditStatements', 'mysqlEditStatements',
      'pageSql', 'sqlitePageSql', 'mysqlPageSql', 'cellSql', 'sqliteCellSql', 'mysqlCellSql', 'redactSql', 'parseRedisCommandLine', 'classifyRedisCommand', 'parseRedisInfo',
      'parseRedisKeyspace', 'parseRedisClientList', 'streamIdStep']) expect(fns.has(fn), fn).toBe(true);
  });
});
