// Files opened from Explorer / Finder reach the editor (src/renderer/src/openFromOs.ts; the host half is
// src-tauri/crates/unimux-app/src/open_files.rs): subscribe first, take what waited, then each signalled batch once, in order.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/src/files', () => ({ openExternalFile: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/errorReport', () => ({ reportError: vi.fn() }));

// The renderer is not part of the node tsconfig: loaded through a variable, so tsc does not follow the import.
const modulePath = '../src/renderer/src/openFromOs';
type Host = { take(): Promise<string[]>; onNew(cb: () => void): () => void };
const { startOpenFromOs } = (await import(/* @vite-ignore */ modulePath)) as {
  startOpenFromOs: (host: Host, open: (path: string) => Promise<void>) => () => void;
};

function host(batches: string[][]) {
  let signal: (() => void) | undefined;
  return {
    take: vi.fn(async () => batches.shift() ?? []),
    onNew: vi.fn((cb: () => void) => { signal = cb; return () => { signal = undefined; }; }),
    fire: () => signal?.(),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('open from the OS', () => {
  it('subscribes before the first take and opens what waited, then each later batch once and in order', async () => {
    const h = host([['C:\\a.txt', 'C:\\b.md'], ['C:\\c.json']]);
    const opened: string[] = [];
    startOpenFromOs(h, async (p) => { opened.push(p); });
    await settle();
    expect(h.onNew.mock.invocationCallOrder[0]).toBeLessThan(h.take.mock.invocationCallOrder[0]!);
    expect(opened).toEqual(['C:\\a.txt', 'C:\\b.md']);
    h.fire();
    h.fire();
    await settle();
    expect(opened).toEqual(['C:\\a.txt', 'C:\\b.md', 'C:\\c.json']);
    expect(h.take).toHaveBeenCalledTimes(3);
  });

  it('keeps going after a file that fails to open or a take that fails', async () => {
    const h = host([['bad', 'good']]);
    h.take.mockRejectedValueOnce(new Error('gone'));
    const opened: string[] = [];
    startOpenFromOs(h, async (p) => { if (p === 'bad') throw new Error('no'); opened.push(p); });
    h.fire();
    await settle();
    expect(opened).toEqual(['good']);
  });
});
