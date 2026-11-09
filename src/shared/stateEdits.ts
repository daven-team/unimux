import type { AppState } from './types';

export interface StateEdit { id: string; base: AppState; next: AppState }
export interface StateSnapshot { state: AppState; revision: number; editId?: string }
/**
 * Whether two values serialize to the same JSON (undefined-valued keys are left out, keys in the same order): what
 * `JSON.stringify(a) === JSON.stringify(b)` says, without serializing every subtree at every level of the merge (60 cells: a
 * state edit took 22-175 ms in `merge` when a grid opened and its cells started). Stops at the first difference.
 */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return JSON.stringify(a) === JSON.stringify(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i] ?? null, b[i] ?? null)) return false;
    return true;
  }
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i] || !equal((a as Record<string, unknown>)[ka[i]], (b as Record<string, unknown>)[kb[i]])) return false;
  }
  return true;
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const keyed = (x: unknown[]): x is Array<Record<string, unknown> & { id: string }> =>
  x.every((v) => object(v) && typeof v.id === 'string');

/** Apply only the user's changed fields to the latest main-process state. Collections merge by ID. */
function merge(current: unknown, base: unknown, next: unknown): unknown {
  if (equal(base, next)) return current;
  if (Array.isArray(current) && Array.isArray(base) && Array.isArray(next) && keyed(current) && keyed(base) && keyed(next)) {
    const before = new Map(base.map((v) => [v.id, v]));
    const after = new Map(next.map((v) => [v.id, v]));
    let result = current.filter((v) => !before.has(v.id) || after.has(v.id)).map((v) =>
      after.has(v.id) && before.has(v.id) ? merge(v, before.get(v.id), after.get(v.id)) as typeof v : v);
    for (let i = 0; i < next.length; i++) {
      const item = next[i];
      // A concurrently deleted entity must not be resurrected by a stale UI edit.
      if (before.has(item.id) || result.some((v) => v.id === item.id)) continue;
      const preceding = next.slice(0, i).reverse().find((v) => result.some((r) => r.id === v.id));
      const at = preceding ? result.findIndex((v) => v.id === preceding.id) + 1 : 0;
      result.splice(at, 0, item);
    }
    const oldOrder = base.filter((v) => after.has(v.id)).map((v) => v.id);
    const newOrder = next.filter((v) => before.has(v.id)).map((v) => v.id);
    if (!equal(oldOrder, newOrder)) {
      const byId = new Map(result.map((v) => [v.id, v]));
      result = [...next.flatMap((v) => byId.has(v.id) ? [byId.get(v.id)!] : []), ...result.filter((v) => !after.has(v.id))];
    }
    return result;
  }
  if (object(base) && object(next)) {
    if (!object(current)) return current; // deleted parent
    const result = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || equal(base[key], next[key])) continue;
      if (!Object.hasOwn(next, key) || next[key] === undefined) delete result[key];
      else result[key] = Object.hasOwn(base, key) ? merge(current[key], base[key], next[key]) : next[key];
    }
    return result;
  }
  return next;
}
export const jsonEqual = equal;
export const mergeStateEdit = (current: AppState, edit: Pick<StateEdit, 'base' | 'next'>): AppState =>
  merge(current, edit.base, edit.next) as AppState;
