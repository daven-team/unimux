// The routeMessage fixtures shared with the Rust port (1.2.0, PLAN W5): test/golden/route-message.jsonl is written from this
// TS function by scripts/goldens-detached.mjs and read by cargo (unimux-ipc route::tests). Here the TS side reads it back, so
// a change of routeMessage that is not regenerated fails in vitest too (and `npm run gen:check` fails in CI).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROADCAST_CHANNELS, CELL_CHANNELS, routeMessage } from '../src/shared/detached';

interface Row { channel: string; args: unknown[]; owners: Array<[string, string]>; out: Array<{ window: string | null; args: unknown[] }> }

const rows: Row[] = readFileSync(resolve(__dirname, 'golden/route-message.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

describe('routeMessage fixtures shared with Rust', () => {
  it('answers every row of the fixture file', () => {
    expect(rows.length).toBeGreaterThanOrEqual(200);
    for (const row of rows) expect(routeMessage(row.channel, row.args, new Map(row.owners))).toEqual(row.out);
  });

  it('covers broadcast, cell, split and main-only channels', () => {
    expect(rows.some((r) => BROADCAST_CHANNELS.has(r.channel))).toBe(true);
    expect(rows.some((r) => CELL_CHANNELS.has(r.channel) && r.out[0].window !== null)).toBe(true);
    expect(rows.some((r) => r.channel === 'automation:start-cells' && r.out.length > 1)).toBe(true);
    expect(rows.some((r) => !BROADCAST_CHANNELS.has(r.channel) && !CELL_CHANNELS.has(r.channel) && r.channel !== 'automation:start-cells')).toBe(true);
  });

  it('lists the same channel groups as the Rust port', () => {
    const rust = readFileSync(resolve(__dirname, '../src-tauri/crates/unimux-ipc/src/route.rs'), 'utf8');
    const group = (name: string): string[] => {
      const body = rust.slice(rust.indexOf(`pub const ${name}`), rust.indexOf('];', rust.indexOf(`pub const ${name}`)));
      return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };
    expect(group('BROADCAST_CHANNELS')).toEqual([...BROADCAST_CHANNELS]);
    expect(group('CELL_CHANNELS')).toEqual([...CELL_CHANNELS]);
  });
});
