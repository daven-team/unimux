// node scripts/pg-fake-server.mjs
// The small fake Postgres of the tests (test/helpers/pgFakeServer.ts) for real-app checks: trust auth, several backends and a
// pg_sleep that pg_cancel_backend really stops (PGlite cannot cancel). 127.0.0.1 only. Prints one JSON line {"port","pid"}.
const { startFakePg } = await import('../test/helpers/pgFakeServer.ts');
const server = await startFakePg();
process.stdout.write(`${JSON.stringify({ port: server.port, pid: process.pid })}\n`);
