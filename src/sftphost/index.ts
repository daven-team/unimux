// SFTP Host entry (Electron utilityProcess "unimux SFTP Host", 0.9.8). Control messages come from main via parentPort;
// transfer progress goes straight to the renderer over a transferred MessagePort. File bytes never leave this process.
import type { MessagePortMain } from 'electron';
import type { SftpPortMessage } from '../shared/sftp';
import type { MainToSftpHost, SftpHostToMain } from '../shared/sftpHostIpc';
import { SftpHost } from './host';

const parentPort = process.parentPort;
/**
 * The transfer port of each window (1.0.8): 'main', and detached windows by id. Every window hears the whole queue (an editor
 * tab in any window follows a move the queue finished); the items are small.
 */
const rendererPorts = new Map<string, MessagePortMain>();

const toMain = (m: SftpHostToMain) => parentPort.postMessage(m);
const describeError = (error: unknown): string => (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4000);
const logToMain = (level: 'error' | 'warn', message: string) => { try { toMain({ t: 'log', level, message }); } catch { /* main is gone */ } };
// One failing session or stream must not end the host and every other session with it.
process.on('uncaughtException', (error) => logToMain('error', `sftp host uncaught exception: ${describeError(error)}`));
process.on('unhandledRejection', (reason) => logToMain('error', `sftp host unhandled rejection: ${describeError(reason)}`));

const host = new SftpHost({
  toMain,
  toRenderer: (m: SftpPortMessage) => {
    for (const port of rendererPorts.values()) { try { port.postMessage(m); } catch { /* the renderer is reloading */ } }
  },
});

function attachRenderer(port: MessagePortMain, window: string): void {
  rendererPorts.get(window)?.close();
  rendererPorts.set(window, port);
  port.on('close', () => { if (rendererPorts.get(window) === port) rendererPorts.delete(window); });
  port.start();
  port.postMessage({ t: 'snapshot', items: host.items() } satisfies SftpPortMessage);
}

// Never log the messages themselves: sshConnect carries secrets.
parentPort.on('message', (e: { data: unknown; ports: MessagePortMain[] }) => {
  const m = e.data as MainToSftpHost | { t: 'port'; window?: string };
  if (m.t === 'port') { if (e.ports[0]) attachRenderer(e.ports[0], typeof m.window === 'string' && m.window ? m.window : 'main'); return; }
  void host.handle(m).catch((error) => logToMain('error', `sftp host message failed: ${describeError(error)}`));
});
