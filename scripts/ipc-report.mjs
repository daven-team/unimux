// `npm run ipc:report`: how much of the window.mc contract the Rust side implements, per domain (PLAN F3). Reads the routes
// from the built binary (`unimux --ipc-routes`, dev and check builds) and the contract (src-tauri/gen/ipc-contract.json).
// `--json` prints the raw numbers; the exit code is 1 when a registration does not match the contract.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBinary } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(resolve(root, 'src-tauri/gen/ipc-contract.json'), 'utf8'));
const { routes, errors } = JSON.parse(execFileSync(appBinary(), ['--ipc-routes'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true }));

const domains = {};
for (const [channel, info] of Object.entries(contract.channels)) {
  const d = (domains[info.domain] ??= { channels: 0, implemented: 0, fallback: 0, methods: 0, methodsImplemented: 0 });
  d.channels++;
  d.methods += info.methods.length;
  if (routes[channel] === 'implemented') { d.implemented++; d.methodsImplemented += info.methods.length; }
  if (routes[channel] === 'fallback') d.fallback++;
}
const total = Object.values(domains).reduce((a, d) => ({ channels: a.channels + d.channels, implemented: a.implemented + d.implemented, fallback: a.fallback + d.fallback, methods: a.methods + d.methods, methodsImplemented: a.methodsImplemented + d.methodsImplemented }), { channels: 0, implemented: 0, fallback: 0, methods: 0, methodsImplemented: 0 });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, domains, errors }, null, 1));
} else {
  console.log('domain      methods          channels         fallback');
  for (const [name, d] of Object.entries(domains).sort()) {
    console.log(`${name.padEnd(11)} ${`${d.methodsImplemented}/${d.methods}`.padEnd(16)} ${`${d.implemented}/${d.channels}`.padEnd(16)} ${d.fallback || ''}`);
  }
  console.log(`${'total'.padEnd(11)} ${`${total.methodsImplemented}/${total.methods}`.padEnd(16)} ${`${total.implemented}/${total.channels}`.padEnd(16)} ${total.fallback}`);
  console.log(`events in the contract: ${contract.events.length}`);
  for (const e of errors) console.error(`registration error: ${e}`);
}
process.exit(errors.length ? 1 : 0);
