// window.mc.pathsForFiles in the Tauri build (1.2.0, PLAN W3). A File from an OS drop has no path in WebView2 or WKWebView
// (1.1.4 read it with webUtils.getPathForFile), so the host tells it on the side; src-tauri/crates/unimux-app/src/file_drop.rs
// is the other half. Free of the Tauri packages so test/tauri-file-paths.test.ts drives it with fakes.

/** The part of `window.chrome.webview` (WebView2) used here. */
export interface WebView2Host {
  postMessageWithAdditionalObjects(message: unknown, additionalObjects: ArrayLike<unknown>): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** How long a path answer may take before the Files count as having no path (the host is local, it answers in a few ms). */
export const PATHS_TIMEOUT_MS = 3000;

/**
 * Windows: the Files go to the host with `postMessageWithAdditionalObjects`, which WebView2 turns into ICoreWebView2File
 * objects carrying the path; the host answers `{mcPaths: id, paths}` on the same channel. Answers for other ids (another
 * request, another page's) are ignored.
 */
export function createWebView2FilePaths(host: WebView2Host, newId: () => string, timeoutMs = PATHS_TIMEOUT_MS): (files: File[]) => Promise<string[]> {
  const waiting = new Map<string, (paths: string[]) => void>();
  host.addEventListener('message', (event) => {
    const data = event.data as { mcPaths?: unknown; paths?: unknown } | null;
    if (!data || typeof data !== 'object' || typeof data.mcPaths !== 'string') return;
    const done = waiting.get(data.mcPaths);
    if (!done) return;
    done(Array.isArray(data.paths) ? data.paths.map((p) => (typeof p === 'string' ? p : '')) : []);
  });
  return (files) => {
    if (!files.length) return Promise.resolve([]);
    const id = newId();
    return new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => finish([]), timeoutMs);
      function finish(paths: string[]) {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(files.map((_, i) => paths[i] ?? ''));
      }
      waiting.set(id, finish);
      try {
        // A string, not an object: wry's handler fails on object messages and WebView2 then skips the host's (file_drop.rs).
        host.postMessageWithAdditionalObjects(JSON.stringify({ mcPaths: id }), files);
      } catch {
        finish([]);
      }
    });
  };
}

/** The last segment of a path ('/' and, for safety, '\\'). */
const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

/**
 * macOS: the host recorded the file URLs of the last OS drop (it wraps WryWebView's performDragOperation:, which runs before
 * WebKit dispatches the drop event); the Files are matched to them by name, in order, each path used once.
 */
export function createDropRecordFilePaths(recentDropPaths: () => Promise<string[]>): (files: File[]) => Promise<string[]> {
  return async (files) => {
    if (!files.length) return [];
    let recorded: string[] = [];
    try { recorded = await recentDropPaths(); } catch { /* no record: no paths */ }
    const left = [...recorded];
    return files.map((file) => {
      const at = left.findIndex((path) => baseName(path) === file.name);
      if (at < 0) return '';
      const [path] = left.splice(at, 1);
      return path ?? '';
    });
  };
}
