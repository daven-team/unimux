// The TS reference answers for the trust model on REAL repositories (PLAN G2): the cargo test unimux-git/tests/trust.rs builds
// hostile repositories, writes the steps to a JSON file and runs this script on it; 1.1.4's own Git class (src/main/git.ts,
// loaded through Vite like scripts/dump-goldens.mjs) scans, grants and reads the trust file, and Rust must give the same keys,
// the same fingerprint hash and a byte-identical git-trust.json.
//
//   node scripts/git-trust-golden.mjs <input.json>
//
// input: {"env": {...}, "steps": [{"name", "op": "scan" | "info" | "grant" | "revoke", "dir", "trustFile"?, "requestId"?, "scope"?}]}
// prints {"<name>": answer, ...}; a scan answers {root, keys, hash}.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { Git } = (await runnerImport(resolve(root, 'src/main/git.ts'), { configFile: false, logLevel: 'silent', root })).module;
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const out = {};
for (const step of input.steps) {
  // a new instance per step: nothing is shared through the caches, only through the trust file (like a restart)
  const git = new Git({ env: input.env, trustFile: step.trustFile });
  if (step.op === 'scan') {
    const repo = await git.root(step.dir);
    const scan = await git.scan(repo, true);
    out[step.name] = { root: repo, keys: scan.keys, hash: scan.hash };
  } else if (step.op === 'info') out[step.name] = await git.trustInfo(step.dir, step.scope);
  else if (step.op === 'grant') out[step.name] = await git.grantTrust(step.dir, step.requestId, step.scope);
  else if (step.op === 'revoke') out[step.name] = await git.revokeTrust(step.dir, step.requestId, step.scope);
  else throw new Error(`unknown op ${step.op}`);
}
process.stdout.write(JSON.stringify(out));
