// window.mc.pathsForFiles in the Tauri build (1.2.0, PLAN W3): the OS paths of dropped Files come from the host on the side
// (WebView2 ICoreWebView2File on Windows, the recorded drop on macOS), and every caller gets one entry per File, in order.
import { describe, expect, it, vi } from 'vitest';
import { createDropRecordFilePaths, createWebView2FilePaths, type WebView2Host } from '../src/renderer/src/bridge/filePaths';
import { createTauriTransport, type TauriDeps } from '../src/renderer/src/bridge/transport';

const file = (name: string) => new File(['x'], name);

/** A WebView2 host whose answers the test controls. */
function fakeHost() {
  let listener: ((event: { data: unknown }) => void) | null = null;
  const posted: Array<{ message: unknown; objects: unknown[] }> = [];
  const host: WebView2Host = {
    postMessageWithAdditionalObjects: (message, objects) => { posted.push({ message, objects: Array.from(objects) }); },
    addEventListener: (_type, cb) => { listener = cb; },
  };
  return { host, posted, answer: (data: unknown) => listener?.({ data }) };
}

describe('pathsForFiles over WebView2 (Windows)', () => {
  it('hands the Files to the host and resolves with its paths in order', async () => {
    const { host, posted, answer } = fakeHost();
    let n = 0;
    const paths = createWebView2FilePaths(host, () => `id${++n}`);
    const files = [file('a.txt'), file('dir')];
    const pending = paths(files);
    expect(posted).toEqual([{ message: '{"mcPaths":"id1"}', objects: files }]);
    answer({ mcPaths: 'id1', paths: ['C:\\a.txt', 'C:\\dir'] });
    await expect(pending).resolves.toEqual(['C:\\a.txt', 'C:\\dir']);
  });

  it('keeps concurrent requests apart and ignores foreign messages', async () => {
    const { host, answer } = fakeHost();
    let n = 0;
    const paths = createWebView2FilePaths(host, () => `id${++n}`);
    const first = paths([file('a')]);
    const second = paths([file('b'), file('c')]);
    answer('a string (Tauri IPC)');
    answer({ other: 1 });
    answer({ mcPaths: 'nope', paths: ['x'] });
    answer({ mcPaths: 'id2', paths: ['/b', 7] });
    answer({ mcPaths: 'id1', paths: ['/a'] });
    await expect(first).resolves.toEqual(['/a']);
    await expect(second).resolves.toEqual(['/b', '']);
  });

  it('answers empty paths after the timeout or when posting throws, and nothing for no Files', async () => {
    vi.useFakeTimers();
    try {
      const { host } = fakeHost();
      const paths = createWebView2FilePaths(host, () => 'id', 3000);
      const pending = paths([file('a'), file('b')]);
      vi.advanceTimersByTime(3000);
      await expect(pending).resolves.toEqual(['', '']);
      const throwing: WebView2Host = { ...host, postMessageWithAdditionalObjects: () => { throw new Error('old runtime'); } };
      await expect(createWebView2FilePaths(throwing, () => 'id')([file('a')])).resolves.toEqual(['']);
      await expect(paths([])).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pathsForFiles from the recorded drop (macOS)', () => {
  it('matches the Files to the recorded paths by name, each path once', async () => {
    const paths = createDropRecordFilePaths(async () => ['/Users/u/a.txt', '/Users/u/x/a.txt', '/Users/u/folder']);
    await expect(paths([file('a.txt'), file('folder'), file('a.txt'), file('a.txt'), file('missing')]))
      .resolves.toEqual(['/Users/u/a.txt', '/Users/u/folder', '/Users/u/x/a.txt', '', '']);
  });

  it('answers empty paths when the host has no record or fails', async () => {
    await expect(createDropRecordFilePaths(async () => [])([file('a')])).resolves.toEqual(['']);
    await expect(createDropRecordFilePaths(async () => { throw new Error('gone'); })([file('a')])).resolves.toEqual(['']);
    const asked = vi.fn(async () => ['/a']);
    await expect(createDropRecordFilePaths(asked)([])).resolves.toEqual([]);
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('the transport', () => {
  const deps = (extra: Partial<TauriDeps> = {}): TauriDeps => ({
    invoke: async () => null,
    listen: async () => () => {},
    log: () => {},
    storage: null,
    newSession: () => 's',
    ...extra,
  });
  const boot = { platform: 'win32' as const, windowsBuild: 26200, label: 'main' };

  it('uses the path source it was given', async () => {
    const t = createTauriTransport(boot, deps({ pathsForFiles: async (files) => files.map((f) => `C:\\${f.name}`) }));
    await expect(t.pathsForFiles([file('a'), file('b')])).resolves.toEqual(['C:\\a', 'C:\\b']);
  });

  it('answers one empty path per File without a source', async () => {
    const t = createTauriTransport(boot, deps());
    await expect(t.pathsForFiles([file('a'), file('b')])).resolves.toEqual(['', '']);
  });
});
