// The DB sessions this window keeps connected (1.0.0): `window.mc.db.pin` replaces the whole list, so the Postgres views and
// the Redis views each set their own part here and main gets the union.
const parts = new Map<string, readonly string[]>();
let last = '';

export function setDbPins(source: 'postgres' | 'redis', sessionIds: readonly string[]): void {
  parts.set(source, sessionIds);
  const all = [...new Set([...parts.values()].flat())].sort();
  const key = all.join();
  if (key === last) return;
  last = key;
  window.mc.db.pin(all);
}
