// Colours of the database connection folders (1.0.3): a connection shows its folder's colour, not its own.
import { describe, expect, it } from 'vitest';
import { dbConnectionColor, normalizeDbGroupColors, setDbGroupColor, type DbConnection } from '../src/shared/db';
import { defaultState, normalizeState } from '../src/shared/state';

const conn = (id: string, group?: string, color?: string) => ({
  id, kind: 'postgres', name: id, host: 'h', port: 5432, user: 'u', tls: 'prefer', ssh: null, readOnly: false, createdAt: 1, updatedAt: 1,
  ...(group ? { group } : {}), ...(color ? { color } : {}),
}) as DbConnection;

describe('database folder colours', () => {
  it('a state from before 1.0.3 starts with the first coloured connection of each folder', () => {
    const list = [conn('a', 'Prod'), conn('b', 'Prod', '#ef4444'), conn('c', 'Prod', '#22c55e'), conn('d', undefined, '#3b82f6')];
    expect(normalizeDbGroupColors(undefined, list)).toEqual({ Prod: '#ef4444' });
  });

  it('keeps only valid colours of folders that still hold a connection', () => {
    const list = [conn('a', 'Prod'), conn('b', 'Dev')];
    expect(normalizeDbGroupColors({ Prod: '#ef4444', Dev: 'red', Gone: '#22c55e' }, list)).toEqual({ Prod: '#ef4444' });
    expect(normalizeDbGroupColors(null, list)).toEqual({});
    expect(normalizeDbGroupColors(['#ef4444'], list)).toEqual({});
  });

  it('a connection shows its folder colour, none outside a folder (its own colour is not used)', () => {
    const colors = { Prod: '#ef4444' };
    expect(dbConnectionColor(colors, conn('a', 'Prod', '#22c55e'))).toBe('#ef4444');
    expect(dbConnectionColor(colors, conn('b', undefined, '#22c55e'))).toBeUndefined();
    expect(dbConnectionColor(colors, conn('c', 'Dev'))).toBeUndefined();
  });

  it('sets and removes a folder colour', () => {
    const s = setDbGroupColor({ dbGroupColors: { Dev: '#22c55e' } }, 'Prod', '#ef4444');
    expect(s.dbGroupColors).toEqual({ Dev: '#22c55e', Prod: '#ef4444' });
    expect(setDbGroupColor(s, 'Prod', undefined).dbGroupColors).toEqual({ Dev: '#22c55e' });
    expect(setDbGroupColor(s, 'Prod', 'nope').dbGroupColors).toEqual({ Dev: '#22c55e' });
  });

  it('survives a save and load of the state', () => {
    const raw = JSON.parse(JSON.stringify({ ...defaultState(), dbConnections: [conn('00000000-0000-4000-8000-000000000001', 'Prod')], dbGroupColors: { Prod: '#ef4444' } }));
    expect(normalizeState(raw)!.dbGroupColors).toEqual({ Prod: '#ef4444' });
  });
});
