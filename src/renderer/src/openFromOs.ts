// Files the OS asks unimux to open (Explorer's "Open with" / context menu / default app, Finder's Open With) open in the
// editor of the main window. The host keeps them in a queue (src-tauri/crates/unimux-app/src/open_files.rs) and says
// 'app:open-files' when new ones wait; the window takes them once after subscribing and again on every signal, so files that
// came before the page loaded and files that come later are each opened exactly once.
import { openExternalFile } from './files';
import { reportError } from './errorReport';

/** The host side: take the waiting paths (each returned once) and hear when new ones wait. */
export interface OpenFromOsHost {
  take(): Promise<string[]>;
  onNew(cb: () => void): () => void;
}

/**
 * Subscribes, then takes what already waits. Takes run one after another and open their files in order, so a signal during a
 * take never opens a file twice or out of order. Returns the unsubscribe.
 */
export function startOpenFromOs(host: OpenFromOsHost, open: (absPath: string) => Promise<void>): () => void {
  let chain: Promise<void> = Promise.resolve();
  const drain = (): void => {
    chain = chain.then(async () => {
      const paths = await host.take().catch((error: unknown) => { reportError('open-file', error); return [] as string[]; });
      for (const path of paths) await open(path).catch((error: unknown) => reportError('open-file', error));
    });
  };
  const off = host.onNew(drain);
  drain();
  return off;
}

let started = false;

/** The main window only (detached windows never take the files); once per page. */
export function initOpenFromOs(): void {
  if (started) return;
  started = true;
  startOpenFromOs({ take: () => window.mc.takeOpenFiles(), onNew: (cb) => window.mc.on('app:open-files', cb) }, openExternalFile);
}
