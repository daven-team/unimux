// Small messages for the state IPC. The state is a few KB (tens with images and history), and every edit used to move it four
// times: {base, next} up, the answer, and the broadcast. Now an edit carries only what changed, the answer is an
// acknowledgement, and the broadcast is a patch against the previous revision.
import type { StateEdit, StateSnapshot } from './stateEdits';
import type { AppState } from './types';

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isKeyed = (x: unknown): x is Array<Record<string, unknown> & { id: string }> =>
  Array.isArray(x) && x.every((v) => isObject(v) && typeof v.id === 'string') && new Set(x.map((v) => (v as { id: string }).id)).size === x.length;
/** The same equality `mergeStateEdit` uses, so pruning cannot change what a merge decides. */
const equal = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

// ── renderer -> main: the edit without its unchanged parts ───────────────────

/**
 * Drops from base and next everything that is equal in both. `mergeStateEdit` skips equal keys and equal keyed entries
 * anyway, so the merge result is identical; entries that only carry their id stay so the order and the neighbours of
 * inserted entries are still known.
 */
export function pruneEdit(edit: StateEdit): StateEdit {
  const [base, next] = prune(edit.base, edit.next);
  return { id: edit.id, base: base as AppState, next: next as AppState };
}

function prune(base: unknown, next: unknown): [unknown, unknown] {
  if (base === next) return [base, next];
  if (isKeyed(base) && isKeyed(next)) {
    const nextById = new Map(next.map((v) => [v.id, v]));
    const baseById = new Map(base.map((v) => [v.id, v]));
    const prunedBase = base.map((b) => {
      const n = nextById.get(b.id);
      return n === undefined || equal(b, n) ? { id: b.id } : (prune(b, n)[0] as typeof b);
    });
    const prunedNext = next.map((n) => {
      const b = baseById.get(n.id);
      if (b === undefined) return n; // new entry: carried whole
      return equal(b, n) ? { id: n.id } : (prune(b, n)[1] as typeof n);
    });
    return [prunedBase, prunedNext];
  }
  if (isObject(base) && isObject(next)) {
    const b: Record<string, unknown> = {};
    const n: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      if (equal(base[key], next[key])) continue;
      const hasBase = Object.hasOwn(base, key);
      const hasNext = Object.hasOwn(next, key);
      if (hasBase && hasNext) {
        const [pb, pn] = prune(base[key], next[key]);
        b[key] = pb;
        n[key] = pn;
      } else {
        if (hasBase) b[key] = base[key];
        if (hasNext) n[key] = next[key];
      }
    }
    // The id of a keyed entry has to stay: it is how the merge pairs entries.
    if (typeof base.id === 'string' && typeof next.id === 'string' && base.id === next.id) { b.id = base.id; n.id = next.id; }
    return [b, n];
  }
  return [base, next];
}

// ── main -> renderer: patches against the previous revision ──────────────────

export type Patch =
  /** Replace the value. */
  | { v: unknown }
  /** Object: patched or added keys, deleted keys. */
  | { o: Record<string, Patch>; d?: string[] }
  /** Keyed array in its new order: an id = unchanged entry, `p` = patched entry, `v` = new entry. */
  | { a: Array<string | { id: string; p: Patch } | { v: unknown }> }
  /**
   * Keyed array that kept its order (1.1.2): `drop` entries left the front, `at` patches entries in place ([index in the new
   * array, id, patch]) and `add` entries were appended. The usual shape of the MCP lists (a task changed, a message or an
   * activity event appended, the oldest event dropped): it names only what changed, where `a` lists every id (500 tasks,
   * 200 events: about 20 KB per MCP event).
   */
  | { s: { drop?: number; at?: Array<[number, string, Patch]>; add?: unknown[] } };

/** What the renderer is told after every change: the new revision as a patch against `base` (revision - 1). */
export type StateChange =
  | { full: StateSnapshot }
  | { revision: number; base: number; editId?: string; patch: Patch | null };

/** The answer to `state:edit`; the new state itself arrives as a `StateChange`. */
export interface StateAck { revision: number; editId?: string }

export function diffState(prev: unknown, next: unknown): Patch | null {
  if (prev === next) return null;
  if (isObject(prev) && isObject(next)) {
    const o: Record<string, Patch> = {};
    const d: string[] = [];
    for (const key of Object.keys(next)) {
      if (!Object.hasOwn(prev, key)) o[key] = { v: next[key] };
      else { const p = diffState(prev[key], next[key]); if (p) o[key] = p; }
    }
    for (const key of Object.keys(prev)) if (!Object.hasOwn(next, key)) d.push(key);
    return Object.keys(o).length || d.length ? { o, ...(d.length ? { d } : {}) } : null;
  }
  if (isKeyed(prev) && isKeyed(next)) {
    const before = new Map(prev.map((v) => [v.id, v]));
    const ordered = keptOrder(prev, next, before);
    if (ordered !== undefined) return ordered;
    const a = next.map((item): string | { id: string; p: Patch } | { v: unknown } => {
      const old = before.get(item.id);
      if (!old) return { v: item };
      const p = diffState(old, item);
      return p ? { id: item.id, p } : item.id;
    });
    return a.length === prev.length && a.every((op, i) => op === prev[i].id) ? null : { a };
  }
  return equal(prev, next) ? null : { v: next };
}

/**
 * The `s` patch of a keyed array whose surviving entries kept their order: a dropped front, in-place changes and appended new
 * entries. Null when the change has another shape (an entry removed from the middle or the end, a move, a reappearing id).
 */
function keptOrder(prev: Array<{ id: string }>, next: Array<{ id: string }>, before: Map<string, unknown>): Patch | null | undefined {
  const firstKept = next.length && before.has(next[0].id) ? prev.findIndex((v) => v.id === next[0].id) : prev.length;
  const kept = prev.length - firstKept;
  if (next.length < kept) return undefined;
  const at: Array<[number, string, Patch]> = [];
  for (let i = 0; i < kept; i++) {
    const old = prev[firstKept + i], item = next[i];
    if (item.id !== old.id) return undefined;
    const p = diffState(old, item);
    if (p) at.push([i, item.id, p]);
  }
  const add = next.slice(kept);
  if (add.some((item) => before.has(item.id))) return undefined;
  if (!firstKept && !at.length && !add.length) return null;
  return { s: { ...(firstKept ? { drop: firstKept } : {}), ...(at.length ? { at } : {}), ...(add.length ? { add } : {}) } };
}

export class PatchError extends Error {}

export function applyPatch(value: unknown, patch: Patch): unknown {
  if ('v' in patch) return patch.v;
  if ('o' in patch) {
    if (!isObject(value)) throw new PatchError('patch of an object does not fit the value');
    const result: Record<string, unknown> = { ...value };
    for (const [key, p] of Object.entries(patch.o)) {
      if (key === '__proto__') continue;
      if (!('v' in p) && !Object.hasOwn(value, key)) throw new PatchError(`missing key ${key}`);
      result[key] = applyPatch(value[key], p);
    }
    for (const key of patch.d ?? []) delete result[key];
    return result;
  }
  if (!isKeyed(value)) throw new PatchError('patch of a list does not fit the value');
  if ('s' in patch) {
    const { drop = 0, at = [], add = [] } = patch.s;
    if (drop > value.length) throw new PatchError('patch drops more entries than the list has');
    const result: unknown[] = value.slice(drop);
    for (const [index, id, p] of at) {
      const found = result[index] as { id?: unknown } | undefined;
      if (!found || found.id !== id) throw new PatchError(`missing entry ${id}`);
      result[index] = applyPatch(found, p);
    }
    return [...result, ...add];
  }
  const before = new Map(value.map((v) => [v.id, v]));
  return patch.a.map((op) => {
    if (typeof op === 'string') {
      const found = before.get(op);
      if (!found) throw new PatchError(`missing entry ${op}`);
      return found;
    }
    if ('v' in op) return op.v;
    const found = before.get(op.id);
    if (!found) throw new PatchError(`missing entry ${op.id}`);
    return applyPatch(found, op.p);
  });
}

/** The message main sends after `snapshot.state` replaced `prev` (the state of revision - 1). */
export function stateChange(prev: AppState, snapshot: StateSnapshot): StateChange {
  try {
    return { revision: snapshot.revision, base: snapshot.revision - 1, editId: snapshot.editId, patch: diffState(prev, snapshot.state) };
  } catch {
    return { full: snapshot };
  }
}

/** Applies a change on top of a confirmed snapshot; null when it does not follow it (the caller asks for a full snapshot). */
export function applyStateChange(current: StateSnapshot, change: StateChange): StateSnapshot | null {
  if ('full' in change) return change.full.revision >= current.revision ? change.full : current;
  // A change at or below what we have (a duplicate, or one a snapshot already included) changes nothing; its edit id still settles that edit.
  if (change.revision <= current.revision) return { state: current.state, revision: current.revision, editId: change.editId };
  if (change.base !== current.revision) return null;
  try {
    const state = change.patch ? (applyPatch(current.state, change.patch) as AppState) : current.state;
    return { state, revision: change.revision, editId: change.editId };
  } catch (error) {
    if (error instanceof PatchError) return null;
    throw error;
  }
}
