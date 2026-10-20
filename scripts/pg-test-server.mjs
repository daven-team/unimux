// node scripts/pg-test-server.mjs [--sql <statements run once at start>]
// A local Postgres for real-app checks (1.0.0): PGlite (WASM, in memory) behind its wire-protocol socket server on 127.0.0.1.
// Trust auth (any user, any password), no TLS. Prints one JSON line {"port","pid"} and runs until its PID is killed.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const db = await PGlite.create();
if (arg('--sql')) await db.exec(arg('--sql'));
const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 16 });
await server.start();
const port = Number(server.getServerConn().split(':').pop());
process.stdout.write(`${JSON.stringify({ port, pid: process.pid })}\n`);
