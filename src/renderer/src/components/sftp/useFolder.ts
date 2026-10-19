// The folder a pane shows: listing, back/forward history and "up". A newer navigation wins over a slower older listing.
import { useCallback, useRef, useState } from 'react';
import { EMPTY_HISTORY, goBack, goForward, pushHistory, type NavHistory, type PaneEntry } from '../../../../shared/sftpView';
import type { PaneFolder } from './FilePane';

export type Listing = { ok: true; path: string; entries: PaneEntry[]; truncated: boolean } | { ok: false; error: string };

export interface FolderNav {
  folder: PaneFolder;
  /** Goes to `path`; resolves true when it was listed. A failed listing keeps the current folder and shows the error. */
  go(path: string, opts?: { history?: boolean }): Promise<boolean>;
  refresh(): Promise<boolean>;
  back(): void;
  forward(): void;
  up(): void;
  reset(): void;
}

export function useFolder(list: (path: string) => Promise<Listing>, parent: (path: string) => string | null, onListed?: (path: string) => void): FolderNav {
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<PaneEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<NavHistory>(EMPTY_HISTORY);
  const seq = useRef(0);
  const current = useRef<string | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const listedRef = useRef(onListed);
  listedRef.current = onListed;

  const load = useCallback(async (to: string, apply: (from: string | null, listed: string) => void): Promise<boolean> => {
    const n = ++seq.current;
    setLoading(true);
    const r = await listRef.current(to).catch((): Listing => ({ ok: false, error: '' }));
    if (n !== seq.current) return false;
    setLoading(false);
    if (!r.ok) { setError(r.error || null); return false; }
    const from = current.current;
    current.current = r.path;
    apply(from, r.path);
    setPath(r.path);
    setEntries(r.entries);
    setTruncated(r.truncated);
    setError(null);
    listedRef.current?.(r.path);
    return true;
  }, []);

  const go = useCallback((to: string, opts: { history?: boolean } = {}) =>
    load(to, (from, listed) => { if (opts.history !== false) setHistory((h) => pushHistory(h, from, listed)); }), [load]);
  const refresh = useCallback(() => (current.current === null ? Promise.resolve(false) : load(current.current, () => undefined)), [load]);
  const back = () => {
    if (current.current === null) return;
    const step = goBack(history, current.current);
    if (step) void load(step.path, () => setHistory(step.history));
  };
  const forward = () => {
    if (current.current === null) return;
    const step = goForward(history, current.current);
    if (step) void load(step.path, () => setHistory(step.history));
  };
  const up = () => {
    const to = path === null ? null : parent(path);
    if (to !== null) void go(to);
  };
  const reset = useCallback(() => {
    seq.current++;
    current.current = null;
    setPath(null); setEntries([]); setTruncated(false); setLoading(false); setError(null); setHistory(EMPTY_HISTORY);
  }, []);

  return {
    folder: { path, entries, loading, error, truncated, canBack: history.back.length > 0, canForward: history.forward.length > 0, canUp: path !== null && parent(path) !== null, parentPath: path === null ? null : parent(path) },
    go, refresh, back, forward, up, reset,
  };
}
