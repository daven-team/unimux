// DB Host entry (Electron utilityProcess "unimux DB Host", 1.0.0). Control messages come from main via parentPort; result rows
// go straight to the renderer over a transferred MessagePort. Database connections and SSH tunnels never leave this process.
import type { MessagePortMain } from 'electron';
import type { DbPortMessage } from '../shared/db';
import type { DbHostToMain, MainToDbHost } from '../shared/dbHostIpc';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { DbHost } from './host';

// pg reads PGHOST, PGUSER, PGPASSWORD, PGSSLMODE ... as defaults: the app's own settings are the only ones that count.
for (const key of Object.keys(process.env)) if (/^PG[A-Z_]+$/.test(key)) delete process.env[key];

const parentPort = process.parentPort;
let rendererPort: MessagePortMain | null = null;

const toMain = (m: DbHostToMain) => parentPort.postMessage(m);
const describeError = (error: unknown): string => (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4000);
const logToMain = (level: 'error' | 'warn', message: string) => { try { toMain({ t: 'log', level, message }); } catch { /* main is gone */ } };
// One failing session must not end the host and every other session with it.
process.on('uncaughtException', (error) => logToMain('error', `db host uncaught exception: ${describeError(error)}`));
process.on('unhandledRejection', (reason) => logToMain('error', `db host unhandled rejection: ${describeError(reason)}`));

// The SQLite engine thread (1.0.6): its built file is read once (from the asar in a packaged app) and run as an eval'd worker,
// so loading it never depends on how worker threads resolve paths inside an archive. It uses built-in modules only.
let sqliteSource: string | null = null;
const sqliteWorker = (interrupt: SharedArrayBuffer): Worker => {
  sqliteSource ??= readFileSync(join(__dirname, 'sqliteworker.js'), 'utf8');
  return new Worker(sqliteSource, { eval: true, workerData: { sqliteEngine: true, interrupt } });
};

const host = new DbHost({
  toMain,
  toRenderer: (m: DbPortMessage) => { try { rendererPort?.postMessage(m); } catch { /* the renderer is reloading */ } },
}, {}, undefined, { spawn: sqliteWorker });

function attachRenderer(port: MessagePortMain): void {
  rendererPort?.close();
  rendererPort = port;
  port.on('close', () => { if (rendererPort === port) rendererPort = null; });
  port.start();
}

// Never log the messages themselves: dbOpen and sshConnect carry secrets.
parentPort.on('message', (e: { data: unknown; ports: MessagePortMain[] }) => {
  const m = e.data as MainToDbHost | { t: 'port' };
  if (m.t === 'port') { if (e.ports[0]) attachRenderer(e.ports[0]); return; }
  void host.handle(m).catch((error) => logToMain('error', `db host message failed: ${describeError(error)}`));
});
