// The in-process RESP server of the TS suites (test/helpers/respServer.ts, loaded with Node's type stripping) for the Rust
// Redis tests (tests/redis_safety.rs): node resp-control.mjs <respServer.ts> <options JSON>. Prints {"port"} once, then
// answers one JSON control request per stdin line ({id, cmd, args} -> {id, result, error}) and closes the server when
// stdin ends. Test use only; 127.0.0.1 only.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const [, , helper, optionsJson] = process.argv;
const { startRespServer } = await import(pathToFileURL(helper).href);
const server = await startRespServer(JSON.parse(optionsJson ?? '{}'));
const db = (n) => server.dbs[n ?? 0];
const handlers = {
  setString: ([key, value, n]) => server.setString(key, value, n),
  setStrings: ([prefix, from, to, value]) => { for (let i = from; i < to; i++) server.setString(`${prefix}${i}`, value); },
  count: ([prefix, n]) => [...db(n).keys()].filter((k) => k.startsWith(prefix)).length,
  size: ([n]) => db(n).size,
  has: ([key, n]) => db(n).has(key),
  type: ([key, n]) => db(n).get(key)?.value.type ?? null,
  ops: ([name]) => server.log.filter((l) => l.argv[0].toLowerCase() === name).length,
  names: () => server.log.map((l) => l.argv[0].toLowerCase()).join(' '),
  delay: ([name, ms]) => { if (ms === null || ms === undefined) delete server.commandDelays[name]; else server.commandDelays[name] = ms; },
  dropSubscribers: () => server.dropSubscribers(),
};
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const { id, cmd, args } = JSON.parse(line);
  let result = null;
  let error = null;
  try { result = handlers[cmd](args ?? []) ?? null; } catch (e) { error = String(e); }
  process.stdout.write(`${JSON.stringify({ id, result, error })}\n`);
});
lines.on('close', () => { void server.close().finally(() => process.exit(0)); });
