// DB Host entry (Electron utilityProcess "unimux DB Host", 1.0.0). Control messages come from main via parentPort; result rows
// go straight to the renderer over a transferred MessagePort. Database connections and SSH tunnels never leave this process.
import type { MessagePortMain } from 'electron';
import type { DbPortMessage } from '../shared/db';
import type { DbHostPortControl, DbHostToMain, MainToDbHost } from '../shared/dbHostIpc';
import { DbPortRoutes, MAIN_DB_WINDOW, pickPort } from '../shared/dbPortRoutes';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { DbHost } from './host';

// pg reads PGHOST, PGUSER, PGPASSWORD, PGSSLMODE ... as defaults: the app's own settings are the only ones that count.
for (const key of Object.keys(process.env)) if (/^PG[A-Z_]+$/.test(key)) delete process.env[key];

const parentPort = process.parentPort;
/** The DB port of each window (1.0.8): 'main', and detached windows by id. */
const rendererPorts = new Map<string, MessagePortMain>();
/** Which window gets which result (the window that asked; a moved tab's Pub/Sub follows it). */
const routes = new DbPortRoutes();

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
  toRenderer: (m: DbPortMessage) => { try { pickPort(rendererPorts, routes.target(m))?.postMessage(m); } catch { /* the renderer is reloading */ } },
}, {}, undefined, { spawn: sqliteWorker });

function attachRenderer(port: MessagePortMain, window: string): void {
  rendererPorts.get(window)?.close();
  rendererPorts.set(window, port);
  port.on('close', () => { if (rendererPorts.get(window) === port) rendererPorts.delete(window); });
  port.start();
}

// Never log the messages themselves: dbOpen and sshConnect carry secrets.
parentPort.on('message', (e: { data: unknown; ports: MessagePortMain[] }) => {
  const m = e.data as MainToDbHost | DbHostPortControl;
  if (m.t === 'port') { if (e.ports[0]) attachRenderer(e.ports[0], typeof m.window === 'string' && m.window ? m.window : MAIN_DB_WINDOW); return; }
  if (m.t === 'dbRoute') { if (Array.isArray(m.sessions)) routes.moveSessions(m.sessions.filter((x) => typeof x === 'string'), m.window); return; }
  if (m.t === 'dbOp') routes.noteOp(m.id, m.op, m.window);
  else if (m.t === 'dbClose') routes.forgetSession(m.id);
  void host.handle(m).catch((error) => logToMain('error', `db host message failed: ${describeError(error)}`));
});
